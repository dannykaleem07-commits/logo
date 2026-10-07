/**
 * Hidden-damage checks to recommend (structural measurement, alignment, suspension, diagnostics, ADAS calibration,
 * SRS, cooling, high-voltage …) from the damaged zones, severity, impact and vehicle, per the rule set in
 * packages/kb/data/engineering/hidden-damage-checks.json. Recommendations only — the engineer decides.
 */
import { isZoneId } from '../panels.js';
import { buildContext, featureFitment, fillTokens, strongerFitment, whenHolds } from './conditions.js';
import { validateTokens, validateWhen } from './knockOn.js';
import { ADAS_SYSTEMS, CHECK_KINDS, CHECK_PRIORITY_RANK, type AssessmentResult, type AssessmentVehicle, type CheckRule, type CheckRuleSet, type RecommendedCheck, type ReportedImpact } from './types.js';

/** Recommend hidden-damage checks. Sorted by priority (required first), then by rule order. */
export function recommendChecks(result: AssessmentResult, impact: ReportedImpact, rules: CheckRuleSet, vehicle: AssessmentVehicle = {}): RecommendedCheck[] {
  const ctx = buildContext(result, vehicle, impact);
  const byKey = new Map<string, RecommendedCheck>();
  for (const rule of rules.rules) {
    const triggers = !rule.zones || rule.zones.length === 0 ? [null] : rule.zones.map((id) => ctx.damaged.get(id)).filter((z) => !!z);
    for (const zone of triggers) {
      if (!whenHolds(rule.when, ctx, zone ?? null)) continue;
      const fitment = featureFitment(vehicle.features, rule.when?.featuresAny);
      if (fitment === null) continue;
      const zoneId = zone?.zoneId ?? null;
      const key = fillTokens(rule.key ?? rule.check, zoneId);
      const label = fillTokens(rule.label, zoneId);
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, {
          key,
          check: rule.check,
          label,
          priority: rule.priority,
          adas: rule.adas ?? null,
          fitment,
          genericHours: rule.genericHours ?? null,
          triggers: [{ ruleId: rule.id, zoneId }],
          reasons: [rule.reason],
          source: 'ai_estimate',
          verified: false
        });
        continue;
      }
      if (CHECK_PRIORITY_RANK[rule.priority] > CHECK_PRIORITY_RANK[prev.priority]) {
        prev.priority = rule.priority;
        // The strongest reason leads.
        prev.reasons = [rule.reason, ...prev.reasons.filter((r) => r !== rule.reason)];
      } else if (!prev.reasons.includes(rule.reason)) prev.reasons.push(rule.reason);
      prev.fitment = strongerFitment(prev.fitment, fitment);
      prev.adas = prev.adas ?? rule.adas ?? null;
      if (!prev.triggers.some((t) => t.ruleId === rule.id && t.zoneId === zoneId)) prev.triggers.push({ ruleId: rule.id, zoneId });
    }
  }
  const order = [...byKey.values()];
  return order.map((c, i) => ({ c, i })).sort((a, b) => CHECK_PRIORITY_RANK[b.c.priority] - CHECK_PRIORITY_RANK[a.c.priority] || a.i - b.i).map((x) => x.c);
}

/** Problems with a hidden-damage check rule set (empty = valid). */
export function validateCheckRules(data: unknown, knownFeatures?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (!data || typeof data !== 'object') return ['rule set must be an object'];
  const d = data as Partial<CheckRuleSet>;
  if (d.schemaVersion !== 1) out.push('schemaVersion must be 1');
  if (d.id !== 'engineering.hidden_damage_checks') out.push('id must be engineering.hidden_damage_checks');
  if (typeof d.version !== 'string' || !d.version) out.push('version required');
  if (!d.verification || !['unverified', 'verified'].includes(d.verification.status) || !d.verification.sourceNote) out.push('verification {status, sourceNote} required');
  if (!Array.isArray(d.rules) || d.rules.length === 0) return [...out, 'rules must be a non-empty array'];
  const ids = new Set<string>();
  d.rules.forEach((r: CheckRule, i) => {
    const where = `rules[${i}]${r?.id ? ` (${r.id})` : ''}`;
    if (!r || typeof r !== 'object') return void out.push(`${where}: must be an object`);
    const allowed = ['id', 'check', 'label', 'key', 'zones', 'when', 'priority', 'adas', 'reason', 'genericHours'];
    for (const k of Object.keys(r)) if (!allowed.includes(k)) out.push(`${where}: unknown field "${k}"`);
    if (typeof r.id !== 'string' || !r.id) out.push(`${where}: id required`);
    else if (ids.has(r.id)) out.push(`${where}: duplicate id`);
    else ids.add(r.id);
    if (!(CHECK_KINDS as readonly string[]).includes(r.check)) out.push(`${where}: unknown check "${String(r.check)}"`);
    if (!['required', 'recommended', 'consider'].includes(r.priority)) out.push(`${where}: unknown priority`);
    if (typeof r.label !== 'string' || !r.label) out.push(`${where}: label required`);
    else out.push(...validateTokens(r.label, r.zones, `${where}.label`));
    if (r.key !== undefined) out.push(...validateTokens(r.key, r.zones, `${where}.key`));
    if (typeof r.reason !== 'string' || r.reason.length < 30) out.push(`${where}: reason must be a plain-English sentence`);
    if (r.zones !== undefined) {
      if (!Array.isArray(r.zones) || r.zones.length === 0) out.push(`${where}: zones must be a non-empty array when present`);
      else for (const z of r.zones) if (!isZoneId(z)) out.push(`${where}: unknown zone "${z}"`);
    }
    if (r.adas !== undefined && !(ADAS_SYSTEMS as readonly string[]).includes(r.adas.system)) out.push(`${where}: adas.system unknown`);
    if (r.genericHours !== undefined && (typeof r.genericHours !== 'number' || r.genericHours < 0 || r.genericHours > 50)) out.push(`${where}: genericHours must be 0–50`);
    out.push(...validateWhen(r.when, where, knownFeatures));
  });
  return out;
}
