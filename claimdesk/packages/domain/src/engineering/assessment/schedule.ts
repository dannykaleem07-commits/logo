/**
 * Itemised-schedule lines from an AI assessment (the appendix the CarFlex engineer report lacks).
 *
 * Lines are shaped like `ScheduleLine` in packages/documents/src/engineer/itemisedSchedule.ts (structurally — the
 * domain package does not import documents), so the documents engine can compute and print them directly. Every
 * line here is:
 *   - `source: 'ai_estimate'`, `verified: false` (prints "Estimate — needs confirmation" until a person confirms);
 *   - priced at £0 with `pricePending: true` — the AI never supplies part prices or part numbers;
 *   - timed from the generic default table (`labourBasis: 'Generic estimate, not manufacturer time'`).
 *
 * Precedence (SUPREME-DESIGN §H.3): estimate → Audatex pack → library → AI. Pass the zones already covered by a
 * better source in `sources.covered` and no AI line is produced for them.
 */
import { getZone, type ZoneOperation } from '../panels.js';
import { round2 } from './conditions.js';
import { expandKnockOnParts } from './knockOn.js';
import { recommendChecks } from './checks.js';
import { GENERIC_HOURS_BY_CATEGORY, GENERIC_HOURS_BY_CHECK, GENERIC_LABOUR_BASIS, GENERIC_LABOUR_TABLE_VERSION, genericZoneHours, zoneIsPainted, zoneLabourCategory, type ScheduleLabourCategory } from './labour.js';
import { ADAS_SYSTEM_LABELS, type AssessmentResult, type AssessmentVehicle, type CheckPriority, type CheckRuleSet, type KnockOnOperation, type KnockOnRuleSet, type ReportedImpact } from './types.js';

/** Operations as the itemised schedule names them. */
export type ScheduleOperation = 'repair' | 'replace' | 'paint' | 'blend' | 'R&I' | 'check';

export type AiLineKind = 'damage' | 'paint' | 'knock_on' | 'check';

/** A schedule line drafted from the AI assessment. Assignable to documents' `ScheduleLine`. */
export interface AiScheduleLine {
  partNumber?: undefined;
  description: string;
  zoneId?: string;
  operation: ScheduleOperation;
  labourCategory: ScheduleLabourCategory;
  labourHours: number;
  /** Always 0: prices come from the estimate / manufacturer, never from the AI. */
  partPricePence: 0;
  paintMaterialsPence: 0;
  source: 'ai_estimate';
  verified: false;
  // ── provenance (extra fields, ignored by the schedule engine) ──
  kind: AiLineKind;
  /** True when the line is a part that still needs a price (replace operations and knock-on parts). */
  pricePending: boolean;
  labourBasis: typeof GENERIC_LABOUR_BASIS;
  labourTableVersion: string;
  /** 0..1 — the zone's AI confidence (knock-on: the triggering zone's; checks: the overall confidence). */
  confidence: number;
  reasons: string[];
  /** Rule ids behind knock-on and check lines. */
  ruleIds: string[];
  note: string;
}

export interface CoveredZone {
  zoneId: string;
  /** Covered operation; omitted = every AI line for the zone (including paint) is covered. */
  operation?: ZoneOperation | 'paint';
  /** Where the better figure came from ('estimate', 'audatex', 'library', 'manual'). */
  source: string;
}

export interface ScheduleSources {
  knockOn?: KnockOnRuleSet;
  checks?: CheckRuleSet;
  impact?: ReportedImpact;
  /** Zones / operations already priced from a better source. */
  covered?: readonly CoveredZone[];
  /** Include knock-on items suggested only "if fitted" (default true; they are marked in the note). */
  includeIfFitted?: boolean;
  /** Lowest check priority to turn into a line (default 'recommended'). */
  minCheckPriority?: CheckPriority;
  /** Leave out damage zones whose confidence is below this (default 0 = keep all; low ones are noted). */
  minConfidence?: number;
}

const OP_TO_SCHEDULE: Record<ZoneOperation, ScheduleOperation> = { repair: 'repair', replace: 'replace', paint: 'paint', blend: 'blend', r_and_i: 'R&I' };
const KNOCK_OP: Record<KnockOnOperation, ScheduleOperation> = { replace: 'replace', repair: 'repair', r_and_i: 'R&I', check: 'check' };
const OP_WORD: Record<ScheduleOperation, string> = { repair: 'repair', replace: 'replace', paint: 'paint', blend: 'blend', 'R&I': 'remove and refit', check: 'check' };
const PRIORITY_RANK: Record<CheckPriority, number> = { required: 3, recommended: 2, consider: 1 };
const LOW_CONFIDENCE = 0.5;

const PRICE_NOTE = 'Part price to be confirmed from the manufacturer or the repair estimate — not priced by AI.';
const BASE_NOTE = `AI estimate — needs engineer confirmation. Labour: ${GENERIC_LABOUR_BASIS.toLowerCase()}.`;

function line(p: Omit<AiScheduleLine, 'partPricePence' | 'paintMaterialsPence' | 'source' | 'verified' | 'labourBasis' | 'labourTableVersion'>): AiScheduleLine {
  return { ...p, labourHours: round2(p.labourHours), partPricePence: 0, paintMaterialsPence: 0, source: 'ai_estimate', verified: false, labourBasis: GENERIC_LABOUR_BASIS, labourTableVersion: GENERIC_LABOUR_TABLE_VERSION };
}

function isCovered(covered: readonly CoveredZone[], zoneId: string, op: ZoneOperation | 'paint'): boolean {
  return covered.some((c) => c.zoneId === zoneId && (c.operation === undefined || c.operation === op));
}

/**
 * Turn an AI assessment into itemised-schedule lines: one line per damaged zone (plus a paint line for painted
 * panels), then the knock-on parts and the hidden-damage checks when their rule sets are supplied.
 */
export function toScheduleLines(result: AssessmentResult, vehicle: AssessmentVehicle, sources: ScheduleSources = {}): AiScheduleLine[] {
  const covered = sources.covered ?? [];
  const minConf = sources.minConfidence ?? 0;
  const out: AiScheduleLine[] = [];

  // 1. damaged zones
  for (const z of result.zones) {
    if (z.severity === 0 || !z.operation) continue;
    if (z.confidence < minConf) continue;
    const zone = getZone(z.zoneId);
    if (!zone) continue;
    const notes = [BASE_NOTE];
    if (z.confidence < LOW_CONFIDENCE) notes.push(`Low AI confidence (${Math.round(z.confidence * 100)}%) — check against the photos.`);
    if (z.preExistingSuspect) notes.push('Possible earlier damage — confirm it relates to this incident before claiming.');
    const reasons = z.reasons.length ? z.reasons : [`${zone.label}: visible damage in the photos.`];

    const op = z.operation;
    if (op !== 'paint' && op !== 'blend' && !isCovered(covered, z.zoneId, op)) {
      const pending = op === 'replace';
      out.push(
        line({
          description: `${zone.label} — ${OP_WORD[OP_TO_SCHEDULE[op]]}`,
          zoneId: z.zoneId,
          operation: OP_TO_SCHEDULE[op],
          labourCategory: zoneLabourCategory(z.zoneId),
          labourHours: genericZoneHours(z.zoneId, op, z.severity) ?? 0,
          kind: 'damage',
          pricePending: pending,
          confidence: z.confidence,
          reasons,
          ruleIds: [],
          note: (pending ? [...notes, PRICE_NOTE] : notes).join(' ')
        })
      );
    }
    // paint: explicit paint / blend, or refinish after repair / replace of a painted zone
    const paintOp: 'paint' | 'blend' | null = op === 'paint' || op === 'blend' ? op : (op === 'repair' || op === 'replace') && zoneIsPainted(z.zoneId) ? 'paint' : null;
    if (paintOp && !isCovered(covered, z.zoneId, 'paint') && !isCovered(covered, z.zoneId, paintOp)) {
      const hours = genericZoneHours(z.zoneId, paintOp, z.severity) ?? 0;
      if (hours > 0) {
        out.push(
          line({
            description: `${zone.label} — ${paintOp === 'blend' ? 'blend' : 'refinish'}`,
            zoneId: z.zoneId,
            operation: paintOp,
            labourCategory: 'paint',
            labourHours: hours,
            kind: 'paint',
            pricePending: false,
            confidence: z.confidence,
            reasons,
            ruleIds: [],
            note: [...notes, 'Paint materials to be added from the paint system or the per-hour materials rate.'].join(' ')
          })
        );
      }
    }
  }

  // 2. knock-on parts
  const adasCovered = new Set<string>();
  if (sources.knockOn) {
    const { suggestions } = expandKnockOnParts(result, vehicle, sources.knockOn, { impact: sources.impact });
    for (const s of suggestions) {
      if (s.fitment === 'if_fitted' && sources.includeIfFitted === false) continue;
      if (s.zoneId && isCovered(covered, s.zoneId, 'replace')) continue;
      const cat = GENERIC_HOURS_BY_CATEGORY[s.category];
      const op = KNOCK_OP[s.operation];
      if (s.adas) adasCovered.add(s.adas.system);
      const notes = [BASE_NOTE];
      if (s.fitment === 'if_fitted') notes.push('Only if fitted to this vehicle.');
      if (s.operation === 'check') notes.push('Inspect; replace only if found damaged.');
      if (s.adas) notes.push(`Calibrate to the manufacturer procedure (${ADAS_SYSTEM_LABELS[s.adas.system]}).`);
      const pending = s.operation === 'replace' && s.category !== 'consumable' && s.category !== 'coolant';
      if (pending) notes.push(PRICE_NOTE);
      out.push(
        line({
          description: s.quantity > 1 ? `${s.label} × ${s.quantity}` : s.label,
          ...(s.zoneId ? { zoneId: s.zoneId } : {}),
          operation: op,
          labourCategory: cat.category,
          labourHours: s.genericHours ?? cat.hours,
          kind: 'knock_on',
          pricePending: pending,
          confidence: s.confidence,
          reasons: s.reasons,
          ruleIds: s.triggers.map((t) => t.ruleId).filter((id, i, a) => a.indexOf(id) === i),
          note: notes.join(' ')
        })
      );
    }
  }

  // 3. hidden-damage checks
  if (sources.checks) {
    const min = PRIORITY_RANK[sources.minCheckPriority ?? 'recommended'];
    for (const c of recommendChecks(result, sources.impact ?? {}, sources.checks, vehicle)) {
      if (PRIORITY_RANK[c.priority] < min) continue;
      if (c.adas && adasCovered.has(c.adas.system)) continue; // already a knock-on calibration line
      if (c.fitment === 'if_fitted' && sources.includeIfFitted === false) continue;
      const def = GENERIC_HOURS_BY_CHECK[c.check];
      const notes = [BASE_NOTE, `${c.priority === 'required' ? 'Required' : c.priority === 'recommended' ? 'Recommended' : 'For consideration'} check.`];
      if (c.fitment === 'if_fitted') notes.push('Only if the system is fitted.');
      out.push(
        line({
          description: c.label,
          operation: 'check',
          labourCategory: def.category,
          labourHours: c.genericHours ?? def.hours,
          kind: 'check',
          pricePending: false,
          confidence: result.overallConfidence,
          reasons: c.reasons,
          ruleIds: c.triggers.map((t) => t.ruleId).filter((id, i, a) => a.indexOf(id) === i),
          note: notes.join(' ')
        })
      );
    }
  }
  return out;
}
