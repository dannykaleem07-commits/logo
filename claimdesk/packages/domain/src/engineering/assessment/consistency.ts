/**
 * Consistency of the reported impact (direction, primary / secondary area, speed, deployment) with the damage the AI
 * recorded, per packages/kb/data/engineering/consistency-rules.json.
 *
 * Findings are neutral points "for the engineer to consider" — never a conclusion about the claim or about anyone's
 * honesty. `NEUTRAL_LANGUAGE_BANNED` lists words no finding may contain; the rule-set validator enforces it.
 */
import { getZone, type DamageSeverity } from '../panels.js';
import { buildContext } from './conditions.js';
import { directionRegionsDefault, resolveReportedArea, viewRegions, zoneRegions } from './regions.js';
import { CONSISTENCY_RULE_KINDS, IMPACT_DIRECTION_LABELS, IMPACT_DIRECTIONS, PHOTO_QUALITY_LABELS, VEHICLE_REGIONS, type AssessmentResult, type AssessmentZone, type ConsistencyFinding, type ConsistencyRule, type ConsistencyRuleSet, type ImpactDirection, type ReportedImpact, type VehicleRegion } from './types.js';

/** Words that make a finding accusatory. None may appear in a consistency message. */
export const NEUTRAL_LANGUAGE_BANNED = [
  /\bfraud/i,
  /\bstaged?\b/i,
  /\bdishonest/i,
  /\blie[sd]?\b/i,
  /\blying\b/i,
  /\bfalse(ly)?\b/i,
  /\bfabricat/i,
  /\bexaggerat/i,
  /\bsuspicious/i,
  /\bdeliberate/i,
  /\bfake\b/i,
  /\binvent(ed)?\b/i,
  /\bcrash[- ]for[- ]cash\b/i,
  /\binflat(ed|ing)\b/i,
  /\bnot genuine\b/i,
  /\bimpossible\b/i,
  /\bcannot have\b/i
];

export function isNeutral(text: string): boolean {
  return !NEUTRAL_LANGUAGE_BANNED.some((re) => re.test(text));
}

function zoneList(zones: readonly AssessmentZone[]): string {
  const labels = zones.map((z) => getZone(z.zoneId)?.label ?? z.zoneId);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}

const LATERAL: Partial<Record<ImpactDirection, 'left' | 'right'>> = { left: 'left', front_left: 'left', rear_left: 'left', right: 'right', front_right: 'right', rear_right: 'right' };

const intersects = (a: readonly VehicleRegion[], b: readonly VehicleRegion[]) => a.some((r) => b.includes(r));

/** Regions shown by the photos: usable photo views plus the regions of zones that cite a photo. */
function coveredRegions(result: AssessmentResult): Set<VehicleRegion> {
  const out = new Set<VehicleRegion>();
  const usable = new Set(result.photos.filter((p) => p.usable).map((p) => p.ref));
  for (const p of result.photos) if (p.usable) for (const r of viewRegions(p.view)) out.add(r);
  for (const z of result.zones) if (z.photoRefs.some((ref) => usable.has(ref) || result.photos.length === 0)) for (const r of zoneRegions(z.zoneId)) out.add(r);
  return out;
}

/** Neutral consistency findings for the engineer. Empty when nothing stands out or nothing was reported. */
export function consistencyFindings(result: AssessmentResult, impact: ReportedImpact, rules: ConsistencyRuleSet): ConsistencyFinding[] {
  const ctx = buildContext(result, {}, impact);
  const out: ConsistencyFinding[] = [];
  const reportedDir: ImpactDirection | null = impact.direction && impact.direction !== 'unknown' ? impact.direction : null;
  const dirLabel = reportedDir ? IMPACT_DIRECTION_LABELS[reportedDir] : '';
  const speed = typeof impact.speedMph === 'number' && Number.isFinite(impact.speedMph) && impact.speedMph >= 0 ? impact.speedMph : null;
  const neutral = new Set(rules.neutralRegions);
  const covered = coveredRegions(result);
  const atLeast = (min: DamageSeverity | undefined) => result.zones.filter((z) => z.severity >= (min ?? 1));
  const reportedAreas = [impact.primaryArea ?? null, ...(impact.secondaryAreas ?? [])].filter((a): a is string => typeof a === 'string' && a.trim().length > 0);
  const resolvedAreas = reportedAreas.map((a) => ({ text: a.trim(), resolved: resolveReportedArea(a) }));
  const secondaryRegions = resolvedAreas.slice(impact.primaryArea ? 1 : 0).flatMap((a) => a.resolved?.regions ?? []);
  const flaggedOpposite = new Set<string>();

  const push = (rule: ConsistencyRule, values: Record<string, string>, zoneIds: string[]) =>
    out.push({ ruleId: rule.id, kind: rule.kind, level: 'consider', message: fill(rule.message, values), zoneIds });

  // opposite-side runs before the direction rule so the same zones are not reported twice.
  const ordered = [...rules.rules].sort((a, b) => (a.kind === 'opposite_side_damage' ? -1 : 0) - (b.kind === 'opposite_side_damage' ? -1 : 0));
  for (const rule of ordered) {
    switch (rule.kind) {
      case 'opposite_side_damage': {
        const side = reportedDir ? LATERAL[reportedDir] : undefined;
        if (!side) break;
        const other = side === 'left' ? 'right' : 'left';
        const damaged = atLeast(rule.minSeverity);
        const onSide = damaged.filter((z) => zoneRegions(z.zoneId).includes(side));
        const onOther = damaged.filter((z) => zoneRegions(z.zoneId).includes(other));
        if (onSide.length === 0 && onOther.length > 0) {
          onOther.forEach((z) => flaggedOpposite.add(z.zoneId));
          push(rule, { direction: dirLabel, zones: zoneList(onOther) }, onOther.map((z) => z.zoneId));
        }
        break;
      }
      case 'damage_outside_reported_direction': {
        if (!reportedDir || reportedDir === 'multiple') break;
        const expected = rules.directionRegions[reportedDir] ?? directionRegionsDefault(reportedDir);
        if (expected.length === 0) break;
        const outside = atLeast(rule.minSeverity).filter((z) => {
          if (flaggedOpposite.has(z.zoneId)) return false;
          const regions = zoneRegions(z.zoneId);
          if (regions.length === 0 || regions.some((r) => neutral.has(r))) return false;
          if (intersects(regions, expected) || intersects(regions, secondaryRegions)) return false;
          return true;
        });
        if (outside.length) push(rule, { direction: dirLabel, zones: zoneList(outside) }, outside.map((z) => z.zoneId));
        break;
      }
      case 'reported_area_undamaged': {
        for (const a of resolvedAreas) {
          if (!a.resolved || a.resolved.regions.length === 0) continue;
          // Not photographed → the coverage rule speaks instead.
          if (!intersects(a.resolved.regions, [...covered])) continue;
          const damaged = atLeast(rule.minSeverity);
          const hit = a.resolved.zoneId
            ? damaged.some((z) => z.zoneId === a.resolved!.zoneId)
            : damaged.some((z) => intersects(zoneRegions(z.zoneId), a.resolved!.regions));
          if (!hit) push(rule, { area: a.text }, a.resolved.zoneId ? [a.resolved.zoneId] : []);
        }
        break;
      }
      case 'reported_area_not_photographed': {
        if (result.photos.length === 0) break;
        for (const a of resolvedAreas) {
          if (!a.resolved || a.resolved.regions.length === 0) continue;
          if (a.resolved.regions.some((r) => covered.has(r))) continue;
          push(rule, { area: a.text }, a.resolved.zoneId ? [a.resolved.zoneId] : []);
        }
        break;
      }
      case 'low_speed_heavy_damage': {
        if (speed === null || speed > (rule.maxSpeedMph ?? 10)) break;
        const heavy = atLeast(rule.minSeverity ?? 3).filter((z) => !rule.zoneKinds || rule.zoneKinds.includes(getZone(z.zoneId)?.kind ?? ''));
        if (heavy.length) push(rule, { zones: zoneList(heavy), speed: String(speed) }, heavy.map((z) => z.zoneId));
        break;
      }
      case 'high_speed_light_damage': {
        if (speed === null || speed < (rule.minSpeedMph ?? 30)) break;
        if (ctx.damaged.size === 0 || ctx.maxSeverity > (rule.maxOverallSeverity ?? 1)) break;
        push(rule, { speed: String(speed) }, [...ctx.damaged.keys()]);
        break;
      }
      case 'deployment_with_light_damage': {
        if (!ctx.deploymentIndicated) break;
        const nonInterior = [...ctx.damaged.values()].filter((z) => !zoneRegions(z.zoneId).includes('interior'));
        const max = nonInterior.reduce((m, z) => Math.max(m, z.severity), 0);
        if (max > (rule.maxOverallSeverity ?? 1)) break;
        push(rule, {}, nonInterior.map((z) => z.zoneId));
        break;
      }
      case 'deployment_reported_not_seen': {
        const seen = result.deploymentVisible || result.zones.some((z) => z.damageTypes.includes('deployed') && z.severity > 0);
        if (impact.airbagsDeployed === true && !seen) push(rule, {}, []);
        break;
      }
      case 'deployment_seen_not_reported': {
        const seen = result.deploymentVisible || result.zones.some((z) => z.damageTypes.includes('deployed') && z.severity > 0);
        if (impact.airbagsDeployed === false && seen) push(rule, {}, result.zones.filter((z) => z.damageTypes.includes('deployed')).map((z) => z.zoneId));
        break;
      }
      case 'pre_existing_suspected': {
        const pre = atLeast(rule.minSeverity).filter((z) => z.preExistingSuspect);
        if (pre.length) push(rule, { zones: zoneList(pre) }, pre.map((z) => z.zoneId));
        break;
      }
      case 'unusable_photos': {
        const bad = result.photos.filter((p) => !p.usable || p.qualityIssues.length > 0);
        if (!bad.length) break;
        const photos = bad.map((p) => `${p.ref}: ${p.qualityIssues.length ? p.qualityIssues.map((q) => PHOTO_QUALITY_LABELS[q].toLowerCase()).join(', ') : 'not usable'}`).join('; ');
        push(rule, { count: String(bad.length), photos }, []);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

const PLACEHOLDERS = ['zones', 'direction', 'area', 'speed', 'count', 'photos'];

/** Problems with a consistency rule set (empty = valid), including any non-neutral wording. */
export function validateConsistencyRules(data: unknown): string[] {
  const out: string[] = [];
  if (!data || typeof data !== 'object') return ['rule set must be an object'];
  const d = data as Partial<ConsistencyRuleSet>;
  if (d.schemaVersion !== 1) out.push('schemaVersion must be 1');
  if (d.id !== 'engineering.consistency_rules') out.push('id must be engineering.consistency_rules');
  if (typeof d.version !== 'string' || !d.version) out.push('version required');
  if (!d.verification || !['unverified', 'verified'].includes(d.verification.status) || !d.verification.sourceNote) out.push('verification {status, sourceNote} required');
  if (!d.directionRegions || typeof d.directionRegions !== 'object') out.push('directionRegions required');
  else {
    for (const dir of IMPACT_DIRECTIONS) if (!Array.isArray(d.directionRegions[dir])) out.push(`directionRegions.${dir} missing`);
    for (const [k, v] of Object.entries(d.directionRegions)) {
      if (!(IMPACT_DIRECTIONS as readonly string[]).includes(k)) out.push(`directionRegions: unknown direction "${k}"`);
      if (Array.isArray(v)) for (const r of v) if (!(VEHICLE_REGIONS as readonly string[]).includes(r)) out.push(`directionRegions.${k}: unknown region "${r}"`);
    }
  }
  if (!Array.isArray(d.neutralRegions)) out.push('neutralRegions required');
  else for (const r of d.neutralRegions) if (!(VEHICLE_REGIONS as readonly string[]).includes(r)) out.push(`neutralRegions: unknown region "${r}"`);
  if (!Array.isArray(d.rules) || d.rules.length === 0) return [...out, 'rules must be a non-empty array'];
  const ids = new Set<string>();
  d.rules.forEach((r, i) => {
    const where = `rules[${i}]${r?.id ? ` (${r.id})` : ''}`;
    const allowed = ['id', 'kind', 'minSeverity', 'maxSpeedMph', 'minSpeedMph', 'maxOverallSeverity', 'zoneKinds', 'message'];
    for (const k of Object.keys(r)) if (!allowed.includes(k)) out.push(`${where}: unknown field "${k}"`);
    if (typeof r.id !== 'string' || !r.id) out.push(`${where}: id required`);
    else if (ids.has(r.id)) out.push(`${where}: duplicate id`);
    else ids.add(r.id);
    if (!(CONSISTENCY_RULE_KINDS as readonly string[]).includes(r.kind)) out.push(`${where}: unknown kind "${String(r.kind)}"`);
    for (const k of ['minSeverity', 'maxOverallSeverity'] as const) if (r[k] !== undefined && ![0, 1, 2, 3].includes(r[k] as number)) out.push(`${where}: ${k} must be 0–3`);
    if (typeof r.message !== 'string' || r.message.length < 30) out.push(`${where}: message required`);
    else {
      if (!isNeutral(r.message)) out.push(`${where}: message is not neutral`);
      for (const m of r.message.match(/\{(\w+)\}/g) ?? []) if (!PLACEHOLDERS.includes(m.slice(1, -1))) out.push(`${where}: unknown placeholder ${m}`);
    }
  });
  return out;
}
