/**
 * The JSON Schema the engineer agent must return (structured outputs) and a pure normaliser that turns whatever came
 * back into a safe `AssessmentResult`.
 *
 * The schema follows the same strict structured-output rules as the agent result schemas (agents/results.ts):
 * `additionalProperties: false` on every object, every property required (optional values are nullable), no
 * minimum / maximum / pattern / length keywords. Ranges (confidence 0..1, severity 0..3) are enforced by
 * `normaliseAssessmentResult`, which also drops unknown zones, maps zones to the vehicle's body, fixes operations,
 * merges duplicates and strips anything that looks like a price or a part number (the model must never supply those).
 */
import { getZone, mapZoneToBody, suggestOperation, VEHICLE_ZONES, zoneAppliesToBody, type DamageSeverity, type VehicleBodyType, type ZoneOperation } from '../panels.js';
import { clamp01, round2 } from './conditions.js';
import { isImpactDirection } from './regions.js';
import { DAMAGE_TYPES, IMPACT_DIRECTIONS, PHOTO_QUALITY_ISSUES, PHOTO_VIEWS, type AssessmentResult, type AssessmentZone, type DamageType, type ImpactDirection, type PhotoAssessment, type PhotoQualityIssue, type PhotoView } from './types.js';

/** A JSON Schema document (plain JSON). Structurally the same as agents/results.ts JsonSchema. */
export interface AssessmentJsonSchema {
  [key: string]: unknown;
}

const str = (description?: string): AssessmentJsonSchema => ({ type: 'string', ...(description ? { description } : {}) });
const nstr = (description?: string): AssessmentJsonSchema => ({ type: ['string', 'null'], ...(description ? { description } : {}) });
const num = (description: string): AssessmentJsonSchema => ({ type: 'number', description });
const bool = (description: string): AssessmentJsonSchema => ({ type: 'boolean', description });
const strEnum = (values: readonly string[], description?: string): AssessmentJsonSchema => ({ type: 'string', enum: [...values], ...(description ? { description } : {}) });
const arr = (items: AssessmentJsonSchema, description?: string): AssessmentJsonSchema => ({ type: 'array', items, ...(description ? { description } : {}) });
const obj = (properties: Record<string, AssessmentJsonSchema>, description?: string): AssessmentJsonSchema => ({
  type: 'object',
  ...(description ? { description } : {}),
  properties,
  required: Object.keys(properties),
  additionalProperties: false
});

export const ASSESSMENT_ZONE_IDS: readonly string[] = VEHICLE_ZONES.map((z) => z.id);
const OPERATIONS: readonly ZoneOperation[] = ['repair', 'replace', 'paint', 'blend', 'r_and_i'];

/** Structured-output schema for `AssessmentResult`. */
export const ASSESSMENT_RESULT_SCHEMA: AssessmentJsonSchema = obj(
  {
    promptVersion: str('Echo the prompt version given in the instructions.'),
    zones: arr(
      obj({
        zoneId: strEnum(ASSESSMENT_ZONE_IDS, 'Zone id from the list. Left (_l) = nearside, right (_r) = offside, as seen from the driver’s seat.'),
        damageTypes: arr(strEnum(DAMAGE_TYPES), 'Visible damage types; empty only when severity is 0.'),
        severity: { type: 'integer', enum: [0, 1, 2, 3], description: '0 none visible, 1 light, 2 medium, 3 heavy.' },
        operation: { anyOf: [{ type: 'string', enum: [...OPERATIONS] }, { type: 'null' }], description: 'Suggested operation; null when severity is 0.' },
        confidence: num('0 to 1: how sure you are of this finding from the photos.'),
        photoRefs: arr(str(), 'Refs of the photos the damage is visible in.'),
        reasons: arr(str(), 'Short observations of what is visible. No part numbers, prices or labour times.'),
        preExistingSuspect: bool('true if the damage shows signs of predating the incident (corrosion, dirt, weathering).')
      }),
      'One entry per zone you can see; damaged zones first.'
    ),
    photos: arr(
      obj({
        ref: str('The photo ref as given.'),
        view: strEnum(PHOTO_VIEWS, 'Where the photo was taken from, relative to the vehicle.'),
        qualityIssues: arr(strEnum(PHOTO_QUALITY_ISSUES)),
        usable: bool('false if nothing can be relied on from this photo.'),
        note: nstr()
      }),
      'One entry per photo supplied.'
    ),
    deploymentVisible: bool('true only if a deployed airbag or fired pretensioner is visible.'),
    fluidLeakVisible: bool('true only if fluid is visible on the ground or under the vehicle.'),
    apparentImpactDirection: strEnum(IMPACT_DIRECTIONS, 'Direction suggested by the damage pattern, or unknown.'),
    overallConfidence: num('0 to 1 for the assessment as a whole.'),
    summary: str('Two or three neutral sentences describing the visible damage.'),
    limitations: arr(str(), 'What the photos do not show or cannot establish.')
  },
  'ClaimDesk AI visual damage assessment. Describe only visible damage.'
);

// ---------------------------------------------------------------------------
// Normaliser
// ---------------------------------------------------------------------------

export type AssessmentIssueCode =
  | 'invalid_shape'
  | 'unknown_zone'
  | 'zone_mapped_to_body'
  | 'zone_not_on_body'
  | 'duplicate_zone_merged'
  | 'severity_clamped'
  | 'confidence_clamped'
  | 'operation_adjusted'
  | 'operation_cleared'
  | 'damage_type_dropped'
  | 'unknown_photo_ref'
  | 'no_photo_reference'
  | 'price_or_part_number_removed'
  | 'unknown_photo_view'
  | 'quality_issue_dropped'
  | 'prompt_version_mismatch';

export interface AssessmentIssue {
  code: AssessmentIssueCode;
  message: string;
  zoneId?: string;
}

export interface NormaliseOptions {
  /** The vehicle's body: zones that do not exist on it are mapped across or dropped. */
  bodyType?: VehicleBodyType;
  /** Photo refs actually supplied; refs outside this list are dropped. */
  photoRefs?: readonly string[];
  /** Expected prompt version (a mismatch is reported, not fatal). */
  promptVersion?: string;
}

/** Money amounts (£12, 12.50 pounds, GBP 40, €30, $20). */
const PRICE_RE = /(?:£|\bGBP\s?|€|\bEUR\s?|\$)\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d{2})?\s?(?:pounds|quid)\b/gi;
/** Labour times (1.5 hours, 2 hrs, 10 units, 12 TUs). */
const LABOUR_TIME_RE = /\b\d+(?:\.\d+)?\s?(?:hours?|hrs?|units?|TUs?)\b/gi;
/** A token that looks like an OEM part number: ≥ 7 characters of letters / digits / hyphens with ≥ 5 digits. */
function looksLikePartNumber(token: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{6,}$/.test(token)) return false;
  return (token.match(/\d/g) ?? []).length >= 5;
}

/** Remove prices, part-number-like tokens and labour times from model text. Returns the clean text and whether anything was removed. */
export function scrubFigures(text: string): { text: string; removed: boolean } {
  let removed = false;
  const mark = () => {
    removed = true;
    return '[removed]';
  };
  let t = text.replace(PRICE_RE, mark).replace(LABOUR_TIME_RE, mark);
  t = t.replace(/[A-Za-z0-9][A-Za-z0-9-]*/g, (tok) => (looksLikePartNumber(tok) ? mark() : tok));
  return { text: t.replace(/\s{2,}/g, ' ').trim(), removed };
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

function toSeverity(v: unknown): { value: DamageSeverity; clamped: boolean } {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : 0;
  const r = Math.round(Math.min(3, Math.max(0, n))) as DamageSeverity;
  return { value: r, clamped: r !== n };
}

function toConfidence(v: unknown): { value: number; clamped: boolean } {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  const c = round2(clamp01(n));
  return { value: c, clamped: c !== round2(n) };
}

/**
 * Normalise a raw model result into a safe `AssessmentResult` and the list of corrections made. Never throws: a
 * malformed result becomes an empty assessment with an `invalid_shape` issue.
 */
export function normaliseAssessmentResult(raw: unknown, opts: NormaliseOptions = {}): { result: AssessmentResult; issues: AssessmentIssue[] } {
  const issues: AssessmentIssue[] = [];
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!r) issues.push({ code: 'invalid_shape', message: 'The assessment was not a JSON object; nothing could be used.' });
  const src = r ?? {};
  const promptVersion = asString(src.promptVersion);
  if (opts.promptVersion && promptVersion !== opts.promptVersion) {
    issues.push({ code: 'prompt_version_mismatch', message: `Result reports prompt version "${promptVersion || 'none'}", expected "${opts.promptVersion}".` });
  }

  // photos first (zone refs are checked against them)
  const supplied = opts.photoRefs ? new Set(opts.photoRefs) : null;
  const photos: PhotoAssessment[] = [];
  const seenPhotos = new Set<string>();
  for (const p of asArray(src.photos)) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    const ref = asString(o.ref).trim();
    if (!ref || seenPhotos.has(ref)) continue;
    if (supplied && !supplied.has(ref)) {
      issues.push({ code: 'unknown_photo_ref', message: `Photo "${ref}" was not supplied and is ignored.` });
      continue;
    }
    seenPhotos.add(ref);
    let view = asString(o.view) as PhotoView;
    if (!(PHOTO_VIEWS as readonly string[]).includes(view)) {
      issues.push({ code: 'unknown_photo_view', message: `Photo "${ref}" has an unknown view; treated as unknown.` });
      view = 'unknown';
    }
    const q: PhotoQualityIssue[] = [];
    for (const x of asArray(o.qualityIssues)) {
      if ((PHOTO_QUALITY_ISSUES as readonly string[]).includes(x as string)) {
        if (!q.includes(x as PhotoQualityIssue)) q.push(x as PhotoQualityIssue);
      } else issues.push({ code: 'quality_issue_dropped', message: `Photo "${ref}": unknown quality issue "${String(x)}" dropped.` });
    }
    const note = typeof o.note === 'string' && o.note.trim() ? scrubFigures(o.note.trim()).text : null;
    photos.push({ ref, view, qualityIssues: q, usable: o.usable !== false, note });
  }
  const knownRefs = supplied ?? (photos.length ? new Set(photos.map((p) => p.ref)) : null);

  // zones
  const byZone = new Map<string, AssessmentZone>();
  for (const z of asArray(src.zones)) {
    if (!z || typeof z !== 'object') continue;
    const o = z as Record<string, unknown>;
    let zoneId = asString(o.zoneId).trim();
    if (!getZone(zoneId)) {
      issues.push({ code: 'unknown_zone', message: `Unknown zone "${zoneId}" dropped.`, zoneId });
      continue;
    }
    if (opts.bodyType && !zoneAppliesToBody(zoneId, opts.bodyType)) {
      const mapped = mapZoneToBody(zoneId, opts.bodyType);
      if (!mapped) {
        issues.push({ code: 'zone_not_on_body', message: `${getZone(zoneId)!.label} does not exist on a ${opts.bodyType}; finding dropped.`, zoneId });
        continue;
      }
      issues.push({ code: 'zone_mapped_to_body', message: `${getZone(zoneId)!.label} recorded as ${getZone(mapped)!.label} for this body type.`, zoneId: mapped });
      zoneId = mapped;
    }
    const sev = toSeverity(o.severity);
    if (sev.clamped) issues.push({ code: 'severity_clamped', message: `Severity for ${zoneId} adjusted to ${sev.value}.`, zoneId });
    const conf = toConfidence(o.confidence);
    if (conf.clamped) issues.push({ code: 'confidence_clamped', message: `Confidence for ${zoneId} adjusted to ${conf.value}.`, zoneId });

    const damageTypes: DamageType[] = [];
    for (const t of asArray(o.damageTypes)) {
      if ((DAMAGE_TYPES as readonly string[]).includes(t as string)) {
        if (!damageTypes.includes(t as DamageType)) damageTypes.push(t as DamageType);
      } else issues.push({ code: 'damage_type_dropped', message: `Unknown damage type "${String(t)}" on ${zoneId} dropped.`, zoneId });
    }

    const zone = getZone(zoneId)!;
    let operation: ZoneOperation | null = (OPERATIONS as readonly string[]).includes(o.operation as string) ? (o.operation as ZoneOperation) : null;
    if (sev.value === 0) {
      if (operation) issues.push({ code: 'operation_cleared', message: `No damage on ${zoneId}; operation cleared.`, zoneId });
      operation = null;
    } else if (!operation || !zone.operations.includes(operation)) {
      const fallback = damageTypes.includes('deployed') && zone.operations.includes('replace') ? 'replace' : (suggestOperation(zone, sev.value) ?? zone.operations[0] ?? null);
      issues.push({ code: 'operation_adjusted', message: `Operation "${String(o.operation ?? 'none')}" is not typical for ${zone.label}; using "${fallback}".`, zoneId });
      operation = fallback;
    }

    const photoRefs: string[] = [];
    for (const ref of asArray(o.photoRefs)) {
      const s = asString(ref).trim();
      if (!s || photoRefs.includes(s)) continue;
      if (knownRefs && !knownRefs.has(s)) {
        issues.push({ code: 'unknown_photo_ref', message: `${zoneId} cites photo "${s}", which was not supplied; reference dropped.`, zoneId });
        continue;
      }
      photoRefs.push(s);
    }
    if (sev.value > 0 && photoRefs.length === 0) issues.push({ code: 'no_photo_reference', message: `${zone.label}: damage recorded without a photo reference.`, zoneId });

    const reasons: string[] = [];
    for (const x of asArray(o.reasons)) {
      const s = asString(x).trim();
      if (!s) continue;
      const clean = scrubFigures(s);
      if (clean.removed) issues.push({ code: 'price_or_part_number_removed', message: `A price, part number or labour time was removed from the reasons for ${zoneId}.`, zoneId });
      if (clean.text && !reasons.includes(clean.text)) reasons.push(clean.text);
    }

    const next: AssessmentZone = { zoneId, damageTypes, severity: sev.value, operation, confidence: conf.value, photoRefs, reasons, preExistingSuspect: o.preExistingSuspect === true };
    const prev = byZone.get(zoneId);
    if (!prev) {
      byZone.set(zoneId, next);
      continue;
    }
    issues.push({ code: 'duplicate_zone_merged', message: `${zone.label} was listed more than once; the entries were merged.`, zoneId });
    const keep = next.severity > prev.severity ? next : prev;
    byZone.set(zoneId, {
      ...keep,
      damageTypes: [...new Set([...prev.damageTypes, ...next.damageTypes])],
      confidence: Math.max(prev.confidence, next.confidence),
      photoRefs: [...new Set([...prev.photoRefs, ...next.photoRefs])],
      reasons: [...new Set([...prev.reasons, ...next.reasons])],
      preExistingSuspect: prev.preExistingSuspect || next.preExistingSuspect
    });
  }

  const zones = [...byZone.values()].sort((a, b) => b.severity - a.severity || b.confidence - a.confidence);
  const dir = asString(src.apparentImpactDirection);
  const overall = toConfidence(src.overallConfidence);
  const summary = scrubFigures(asString(src.summary).trim());
  if (summary.removed) issues.push({ code: 'price_or_part_number_removed', message: 'A price, part number or labour time was removed from the summary.' });
  const limitations = asArray(src.limitations)
    .map((x) => scrubFigures(asString(x).trim()).text)
    .filter(Boolean);

  return {
    result: {
      promptVersion,
      zones,
      photos,
      deploymentVisible: src.deploymentVisible === true,
      fluidLeakVisible: src.fluidLeakVisible === true,
      apparentImpactDirection: isImpactDirection(dir) ? (dir as ImpactDirection) : 'unknown',
      overallConfidence: overall.value,
      summary: summary.text,
      limitations
    },
    issues
  };
}
