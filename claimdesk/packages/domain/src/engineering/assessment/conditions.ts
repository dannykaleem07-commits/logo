/**
 * Shared rule-condition evaluation for the knock-on parts and hidden-damage check rule sets.
 */
import { getZone, mapZoneToBody, zoneAppliesToBody, type DamageSeverity } from '../panels.js';
import { damagedZones, effectiveDirection, SIDE_LABEL, sideOf } from './regions.js';
import type { AssessmentResult, AssessmentVehicle, AssessmentZone, Fitment, ImpactDirection, ReportedImpact, RuleWhen } from './types.js';

export interface RuleContext {
  result: AssessmentResult;
  vehicle: AssessmentVehicle;
  impact: ReportedImpact;
  /** Damaged zones (severity ≥ 1) by id. */
  damaged: Map<string, AssessmentZone>;
  direction: ImpactDirection;
  directionInferred: boolean;
  deploymentIndicated: boolean;
  maxSeverity: DamageSeverity;
}

export function buildContext(result: AssessmentResult, vehicle: AssessmentVehicle = {}, impact: ReportedImpact = {}): RuleContext {
  const damaged = new Map<string, AssessmentZone>();
  for (const z of damagedZones(result.zones)) {
    const prev = damaged.get(z.zoneId);
    if (!prev || z.severity > prev.severity) damaged.set(z.zoneId, z);
  }
  const { direction, inferred } = effectiveDirection(result, impact.direction ?? null);
  const deploymentIndicated =
    result.deploymentVisible === true || impact.airbagsDeployed === true || result.zones.some((z) => z.damageTypes.includes('deployed') && z.severity > 0);
  let maxSeverity: DamageSeverity = 0;
  for (const z of damaged.values()) if (z.severity > maxSeverity) maxSeverity = z.severity;
  return { result, vehicle, impact, damaged, direction, directionInferred: inferred, deploymentIndicated, maxSeverity };
}

/** Fitment of a feature-dependent item: null = not applicable (features known and none listed). */
export function featureFitment(features: readonly string[] | undefined, any: readonly string[] | undefined): Fitment | null {
  if (!any || any.length === 0) return 'standard';
  if (!features) return 'if_fitted';
  return any.some((f) => features.includes(f)) ? 'fitted' : null;
}

/** Combine two fitments: the weaker wins (standard > fitted > if_fitted). */
export function weakerFitment(a: Fitment, b: Fitment): Fitment {
  const rank: Record<Fitment, number> = { standard: 3, fitted: 2, if_fitted: 1 };
  return rank[a] <= rank[b] ? a : b;
}
export function strongerFitment(a: Fitment, b: Fitment): Fitment {
  const rank: Record<Fitment, number> = { standard: 3, fitted: 2, if_fitted: 1 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Evaluate a `when` block for one triggering zone (or null for a global rule). Feature conditions are not evaluated
 * here (they decide fitment, see `featureFitment`).
 */
export function whenHolds(when: RuleWhen | undefined, ctx: RuleContext, zone: AssessmentZone | null): boolean {
  if (!when) return true;
  const sev = zone ? zone.severity : ctx.maxSeverity;
  if (when.minSeverity !== undefined && sev < when.minSeverity) return false;
  if (when.maxSeverity !== undefined && sev > when.maxSeverity) return false;
  if (when.operationsAny?.length) {
    if (zone) {
      if (!zone.operation || !when.operationsAny.includes(zone.operation)) return false;
    } else if (![...ctx.damaged.values()].some((z) => z.operation && when.operationsAny!.includes(z.operation))) return false;
  }
  if (when.damageTypesAny?.length) {
    const types = zone ? zone.damageTypes : [...ctx.damaged.values()].flatMap((z) => z.damageTypes);
    if (!when.damageTypesAny.some((t) => types.includes(t))) return false;
  }
  if (when.impactDirectionsAny?.length && !when.impactDirectionsAny.includes(ctx.direction)) return false;
  if (when.bodyTypesAny?.length && !when.bodyTypesAny.includes(ctx.vehicle.bodyType ?? 'hatchback')) return false;
  if (when.powertrainsAny?.length && (!ctx.vehicle.powertrain || !when.powertrainsAny.includes(ctx.vehicle.powertrain))) return false;
  if (when.deploymentIndicated !== undefined && when.deploymentIndicated !== ctx.deploymentIndicated) return false;
  if (when.minSpeedMph !== undefined) {
    const s = ctx.impact.speedMph;
    if (typeof s !== 'number' || !Number.isFinite(s) || s < when.minSpeedMph) return false;
  }
  if (when.alsoDamagedAny?.length && !when.alsoDamagedAny.some((id) => ctx.damaged.has(id) && id !== zone?.zoneId)) return false;
  if (when.minDamagedZones !== undefined && ctx.damaged.size < when.minDamagedZones) return false;
  if (when.fluidLeakVisible !== undefined && when.fluidLeakVisible !== (ctx.result.fluidLeakVisible === true)) return false;
  return true;
}

/**
 * Replace the rule-text tokens from the triggering zone: `{side}` (l / r), `{sideLabel}` (N/S / O/S), `{zone}` (zone id)
 * and `{zoneLabel}` (zone label). With no zone (global rule) or a centre zone, side tokens are dropped.
 */
export function fillTokens(text: string, zoneId: string | null): string {
  let t = text;
  const z = zoneId ? getZone(zoneId) : undefined;
  t = t.replace(/\{zone\}/g, z ? z.id : '').replace(/\{zoneLabel\}/g, z ? z.label : '');
  const s = zoneId ? sideOf(zoneId) : null;
  if (!s) t = t.replace(/\s*\{sideLabel\}/g, '').replace(/_?\{side\}/g, '');
  else t = t.replace(/\{side\}/g, s).replace(/\{sideLabel\}/g, SIDE_LABEL[s]);
  return t.replace(/\s+—\s*$/, '').replace(/_+$/, '').replace(/\s{2,}/g, ' ').trim();
}

/** Whether an item zone (after side filling) exists on the vehicle's body; returns the zone id to use, or null. */
export function itemZoneForBody(zoneId: string | undefined, ctx: RuleContext): string | null {
  if (!zoneId || !getZone(zoneId)) return null;
  const body = ctx.vehicle.bodyType;
  if (!body) return zoneId;
  return zoneAppliesToBody(zoneId, body) ? zoneId : mapZoneToBody(zoneId, body);
}

/** Placeholder tokens allowed in rule keys, labels and zone ids. */
export const RULE_TOKENS = ['{side}', '{sideLabel}', '{zone}', '{zoneLabel}'] as const;

export const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
export const round2 = (n: number): number => Math.round(n * 100) / 100;
