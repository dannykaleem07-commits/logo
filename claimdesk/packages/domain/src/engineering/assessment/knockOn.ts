/**
 * Knock-on parts: from the AI's damaged zones, the associated parts a repairer commonly needs (clips, brackets,
 * absorbers, sensors, calibrations, …) per the rule set in packages/kb/data/engineering/knock-on-parts.json.
 *
 * Suggestions are unverified estimates (`source: 'ai_estimate'`, `verified: false`) with a plain-English reason, the
 * rule(s) and zone(s) that triggered them and a fitment ('standard' / 'fitted' per the vehicle catalogue features /
 * 'if_fitted' when the features are not known or not catalogued). No part numbers, no prices.
 */
import { isZoneId } from '../panels.js';
import { buildContext, clamp01, featureFitment, fillTokens, itemZoneForBody, RULE_TOKENS, strongerFitment, weakerFitment, whenHolds, type RuleContext } from './conditions.js';
import { ADAS_SYSTEMS, DAMAGE_TYPES, IMPACT_DIRECTIONS, KNOCK_ON_CATEGORIES, POWERTRAINS, type AssessmentResult, type AssessmentVehicle, type AssessmentZone, type Fitment, type KnockOnExpansion, type KnockOnItemDef, type KnockOnOperation, type KnockOnRule, type KnockOnRuleSet, type KnockOnSuggestion, type NotApplicableItem, type ReportedImpact, type RuleWhen } from './types.js';

export interface KnockOnOptions {
  /** Reported impact (direction conditions); when absent the direction is inferred from the damage. */
  impact?: ReportedImpact;
}

const OP_RANK: Record<KnockOnOperation, number> = { replace: 4, repair: 3, r_and_i: 2, check: 1 };

/** Triggers for a rule: each damaged trigger zone, or the whole result once for a global rule. */
function triggerZones(rule: { zones?: string[] }, ctx: RuleContext): Array<AssessmentZone | null> {
  if (!rule.zones || rule.zones.length === 0) return [null];
  const out: AssessmentZone[] = [];
  for (const id of rule.zones) {
    const z = ctx.damaged.get(id);
    if (z) out.push(z);
  }
  return out;
}

/** Expand the knock-on parts for an assessment. */
export function expandKnockOnParts(result: AssessmentResult, vehicle: AssessmentVehicle, rules: KnockOnRuleSet, opts: KnockOnOptions = {}): KnockOnExpansion {
  const ctx = buildContext(result, vehicle, opts.impact ?? {});
  const byKey = new Map<string, KnockOnSuggestion>();
  const notApplicable = new Map<string, NotApplicableItem>();

  for (const rule of rules.rules) {
    for (const zone of triggerZones(rule, ctx)) {
      if (!whenHolds(rule.when, ctx, zone)) continue;
      const ruleFit = featureFitment(vehicle.features, rule.when?.featuresAny);
      const zoneId = zone?.zoneId ?? null;
      for (const item of rule.items) {
        const key = fillTokens(item.key, zoneId);
        const label = fillTokens(item.label, zoneId);
        const itemFit = featureFitment(vehicle.features, item.featuresAny);
        if (ruleFit === null || itemFit === null) {
          if (!byKey.has(key) && !notApplicable.has(key)) {
            notApplicable.set(key, {
              key,
              label,
              ruleId: rule.id,
              reason: 'The vehicle’s recorded features do not include the equipment this part belongs to. Add it if the vehicle has it fitted.'
            });
          }
          continue;
        }
        let fitment: Fitment = weakerFitment(ruleFit, itemFit);
        if (item.ifFitted) fitment = weakerFitment(fitment, 'if_fitted');
        // An item that is itself a taxonomy zone: skip when the zone is already in the result (it has its own line)
        // or does not exist on this body.
        let itemZone: string | null = null;
        if (item.zoneId) {
          const filled = fillTokens(item.zoneId, zoneId);
          itemZone = itemZoneForBody(filled, ctx);
          if (!itemZone) continue;
          if (result.zones.some((z) => z.zoneId === itemZone && z.severity > 0)) continue;
        }
        const confidence = clamp01(zone ? zone.confidence : result.overallConfidence);
        notApplicable.delete(key);
        const prev = byKey.get(key);
        if (!prev) {
          byKey.set(key, {
            key,
            label,
            category: item.category,
            operation: item.operation,
            quantity: item.quantity ?? 1,
            zoneId: itemZone,
            fitment,
            adas: item.adas ?? null,
            genericHours: item.genericHours ?? null,
            triggers: [{ ruleId: rule.id, zoneId }],
            reasons: [rule.reason],
            confidence,
            source: 'ai_estimate',
            verified: false
          });
          continue;
        }
        // Merge: strongest operation (its label wins), strongest fitment, every trigger and distinct reason.
        if (OP_RANK[item.operation] > OP_RANK[prev.operation]) {
          prev.operation = item.operation;
          prev.label = label;
          prev.category = item.category;
          if (item.genericHours !== undefined) prev.genericHours = item.genericHours;
        }
        prev.fitment = strongerFitment(prev.fitment, fitment);
        prev.adas = prev.adas ?? item.adas ?? null;
        prev.quantity = Math.max(prev.quantity, item.quantity ?? 1);
        if (!prev.triggers.some((t) => t.ruleId === rule.id && t.zoneId === zoneId)) prev.triggers.push({ ruleId: rule.id, zoneId });
        if (!prev.reasons.includes(rule.reason)) prev.reasons.push(rule.reason);
        prev.confidence = Math.max(prev.confidence, confidence);
      }
    }
  }
  return { suggestions: [...byKey.values()], notApplicable: [...notApplicable.values()] };
}

// ---------------------------------------------------------------------------
// Rule-set validation (used by tests and by the kb loader)
// ---------------------------------------------------------------------------

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const SEVERITIES = [0, 1, 2, 3];
const ZONE_OPS = ['repair', 'replace', 'paint', 'blend', 'r_and_i'];

/** Validate a `when` block; returns problems prefixed with `where`. */
export function validateWhen(when: unknown, where: string, knownFeatures?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (when === undefined) return out;
  if (!when || typeof when !== 'object') return [`${where}: when must be an object`];
  const w = when as Record<string, unknown>;
  const allowed: Array<keyof RuleWhen> = ['minSeverity', 'maxSeverity', 'operationsAny', 'damageTypesAny', 'impactDirectionsAny', 'featuresAny', 'bodyTypesAny', 'powertrainsAny', 'deploymentIndicated', 'minSpeedMph', 'alsoDamagedAny', 'minDamagedZones', 'fluidLeakVisible'];
  for (const k of Object.keys(w)) if (!(allowed as string[]).includes(k)) out.push(`${where}: unknown condition "${k}"`);
  for (const k of ['minSeverity', 'maxSeverity'] as const) if (w[k] !== undefined && !SEVERITIES.includes(w[k] as number)) out.push(`${where}: ${k} must be 0–3`);
  const list = (k: string, values: readonly string[] | null, pred?: (s: string) => boolean) => {
    const v = w[k];
    if (v === undefined) return;
    if (!Array.isArray(v) || v.length === 0) return void out.push(`${where}: ${k} must be a non-empty array`);
    for (const x of v) {
      if (!isStr(x)) out.push(`${where}: ${k} has a non-string`);
      else if (values && !values.includes(x)) out.push(`${where}: ${k} has unknown value "${x}"`);
      else if (pred && !pred(x)) out.push(`${where}: ${k} has unknown value "${x}"`);
    }
  };
  list('operationsAny', ZONE_OPS);
  list('damageTypesAny', DAMAGE_TYPES);
  list('impactDirectionsAny', IMPACT_DIRECTIONS);
  list('featuresAny', null, knownFeatures ? (f) => knownFeatures.has(f) : undefined);
  list('bodyTypesAny', ['hatchback', 'saloon', 'estate', 'coupe', 'convertible', 'suv', 'mpv', 'panel-van', 'pickup']);
  list('powertrainsAny', POWERTRAINS);
  list('alsoDamagedAny', null, isZoneId);
  if (w.deploymentIndicated !== undefined && typeof w.deploymentIndicated !== 'boolean') out.push(`${where}: deploymentIndicated must be boolean`);
  if (w.fluidLeakVisible !== undefined && typeof w.fluidLeakVisible !== 'boolean') out.push(`${where}: fluidLeakVisible must be boolean`);
  if (w.minSpeedMph !== undefined && (typeof w.minSpeedMph !== 'number' || w.minSpeedMph < 0)) out.push(`${where}: minSpeedMph must be a number ≥ 0`);
  if (w.minDamagedZones !== undefined && (!Number.isInteger(w.minDamagedZones) || (w.minDamagedZones as number) < 1)) out.push(`${where}: minDamagedZones must be an integer ≥ 1`);
  if (typeof w.minSeverity === 'number' && typeof w.maxSeverity === 'number' && w.minSeverity > w.maxSeverity) out.push(`${where}: minSeverity > maxSeverity`);
  return out;
}

/** Token use: side tokens only when every trigger zone is sided; zone tokens only when the rule has trigger zones. */
export function validateTokens(text: string, zones: readonly string[] | undefined, where: string): string[] {
  const out: string[] = [];
  const tokens = text.match(/\{[a-zA-Z]+\}/g) ?? [];
  for (const t of tokens) if (!(RULE_TOKENS as readonly string[]).includes(t)) out.push(`${where}: unknown token ${t}`);
  const usesSide = tokens.some((t) => t === '{side}' || t === '{sideLabel}');
  const usesZone = tokens.some((t) => t === '{zone}' || t === '{zoneLabel}');
  if ((usesSide || usesZone) && (!zones || zones.length === 0)) out.push(`${where}: uses a zone token but the rule has no trigger zones`);
  if (usesSide && zones?.some((z) => !/_[lr]$/.test(z) && !/^wheel_[fr][lr]$/.test(z))) out.push(`${where}: uses a side token but a trigger zone is not sided`);
  return out;
}

const PLAIN_ENGLISH_MIN = 30;

function validateItem(item: unknown, rule: KnockOnRule, where: string, knownFeatures?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (!item || typeof item !== 'object') return [`${where}: item must be an object`];
  const it = item as KnockOnItemDef & Record<string, unknown>;
  const allowed = ['key', 'label', 'category', 'operation', 'quantity', 'zoneId', 'featuresAny', 'ifFitted', 'adas', 'genericHours'];
  for (const k of Object.keys(it)) if (!allowed.includes(k)) out.push(`${where}: unknown item field "${k}"`);
  if (!isStr(it.key) || !/^[a-z0-9_{}A-Z]+$/.test(it.key)) out.push(`${where}: key must be snake_case`);
  if (!isStr(it.label)) out.push(`${where}: label required`);
  if (!(KNOCK_ON_CATEGORIES as readonly string[]).includes(it.category)) out.push(`${where}: unknown category "${String(it.category)}"`);
  if (!['replace', 'r_and_i', 'repair', 'check'].includes(it.operation)) out.push(`${where}: unknown operation "${String(it.operation)}"`);
  if (it.quantity !== undefined && (!Number.isInteger(it.quantity) || it.quantity < 1)) out.push(`${where}: quantity must be an integer ≥ 1`);
  if (it.genericHours !== undefined && (typeof it.genericHours !== 'number' || it.genericHours < 0 || it.genericHours > 50)) out.push(`${where}: genericHours must be 0–50`);
  if (it.ifFitted !== undefined && typeof it.ifFitted !== 'boolean') out.push(`${where}: ifFitted must be boolean`);
  if (it.zoneId !== undefined) {
    if (!isStr(it.zoneId)) out.push(`${where}: zoneId must be a string`);
    else {
      out.push(...validateTokens(it.zoneId, rule.zones, `${where}.zoneId`));
      const probes = it.zoneId.includes('{side}') ? [it.zoneId.replace('{side}', 'l'), it.zoneId.replace('{side}', 'r')] : [it.zoneId];
      for (const p of probes) if (!isZoneId(p)) out.push(`${where}: zoneId "${p}" is not a taxonomy zone`);
    }
  }
  if (it.featuresAny !== undefined) out.push(...validateWhen({ featuresAny: it.featuresAny }, where, knownFeatures));
  if (it.adas !== undefined) {
    const a = it.adas as unknown as Record<string, unknown>;
    if (!a || !(ADAS_SYSTEMS as readonly string[]).includes(a.system as string)) out.push(`${where}: adas.system unknown`);
    if (!a || !['static', 'dynamic', 'static_or_dynamic', 'coding_or_initialisation', 'aim'].includes(a.method as string)) out.push(`${where}: adas.method unknown`);
  }
  if (isStr(it.key)) out.push(...validateTokens(it.key, rule.zones, `${where}.key`));
  if (isStr(it.label)) out.push(...validateTokens(it.label, rule.zones, `${where}.label`));
  if (/\b[A-Z0-9]{2,}\d{3,}[A-Z0-9]*\b/.test(it.label ?? '') || /£\s?\d/.test(it.label ?? '')) out.push(`${where}: labels must not carry part numbers or prices`);
  return out;
}

/** Problems with a knock-on rule set (empty = valid). `knownFeatures` = catalogue feature ids, when available. */
export function validateKnockOnRules(data: unknown, knownFeatures?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (!data || typeof data !== 'object') return ['rule set must be an object'];
  const d = data as Partial<KnockOnRuleSet>;
  if (d.schemaVersion !== 1) out.push('schemaVersion must be 1');
  if (d.id !== 'engineering.knock_on_parts') out.push('id must be engineering.knock_on_parts');
  if (!isStr(d.version)) out.push('version required');
  if (!d.verification || !['unverified', 'verified'].includes(d.verification.status) || !isStr(d.verification.sourceNote)) out.push('verification {status, sourceNote} required');
  if (!Array.isArray(d.rules) || d.rules.length === 0) return [...out, 'rules must be a non-empty array'];
  const ids = new Set<string>();
  d.rules.forEach((r, i) => {
    const where = `rules[${i}]${r && isStr((r as KnockOnRule).id) ? ` (${(r as KnockOnRule).id})` : ''}`;
    if (!r || typeof r !== 'object') return void out.push(`${where}: must be an object`);
    const allowed = ['id', 'zones', 'when', 'items', 'reason'];
    for (const k of Object.keys(r)) if (!allowed.includes(k)) out.push(`${where}: unknown field "${k}"`);
    if (!isStr(r.id)) out.push(`${where}: id required`);
    else if (ids.has(r.id)) out.push(`${where}: duplicate id`);
    else ids.add(r.id);
    if (r.zones !== undefined) {
      if (!Array.isArray(r.zones) || r.zones.length === 0) out.push(`${where}: zones must be a non-empty array when present`);
      else for (const z of r.zones) if (!isZoneId(z)) out.push(`${where}: unknown zone "${z}"`);
    }
    out.push(...validateWhen(r.when, where, knownFeatures));
    if (!isStr(r.reason) || r.reason.length < PLAIN_ENGLISH_MIN) out.push(`${where}: reason must be a plain-English sentence`);
    if (!Array.isArray(r.items) || r.items.length === 0) out.push(`${where}: items must be a non-empty array`);
    else r.items.forEach((it, j) => out.push(...validateItem(it, r as KnockOnRule, `${where}.items[${j}]`, knownFeatures)));
  });
  return out;
}
