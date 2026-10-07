/**
 * Zone → vehicle region mapping and impact-direction helpers.
 *
 * Regions are coarse (front / rear / left / right / top / under / interior); a corner zone belongs to two
 * (front_wing_r → front + right). Left = nearside (N/S), right = offside (O/S) in the UK.
 */
import { getZone, isZoneId, zoneForPanelName, type DamageSeverity } from '../panels.js';
import { IMPACT_DIRECTIONS, VEHICLE_REGIONS, type AssessmentResult, type ImpactDirection, type PhotoView, type VehicleRegion } from './types.js';

/** Explicit regions for zones whose area/side alone does not say enough. */
const REGION_OVERRIDES: Record<string, VehicleRegion[]> = {
  front_wing_l: ['front', 'left'],
  front_wing_r: ['front', 'right'],
  quarter_panel_l: ['rear', 'left'],
  quarter_panel_r: ['rear', 'right'],
  load_side_panel_l: ['rear', 'left'],
  load_side_panel_r: ['rear', 'right'],
  load_bed_side_l: ['rear', 'left'],
  load_bed_side_r: ['rear', 'right'],
  quarter_glass_l: ['rear', 'left'],
  quarter_glass_r: ['rear', 'right'],
  headlamp_l: ['front', 'left'],
  headlamp_r: ['front', 'right'],
  fog_lamp_l: ['front', 'left'],
  fog_lamp_r: ['front', 'right'],
  rear_lamp_l: ['rear', 'left'],
  rear_lamp_r: ['rear', 'right'],
  high_level_brake_lamp: ['rear', 'top'],
  chassis_leg_l: ['front', 'left'],
  chassis_leg_r: ['front', 'right'],
  rear_load_door_l: ['rear', 'left'],
  rear_load_door_r: ['rear', 'right'],
  windscreen: ['front', 'top'],
  rear_screen: ['rear', 'top'],
  sunroof: ['top'],
  roof: ['top'],
  soft_top: ['top'],
  roof_rail_l: ['top', 'left'],
  roof_rail_r: ['top', 'right'],
  spoiler: ['rear', 'top'],
  wheel_fl: ['front', 'left'],
  wheel_fr: ['front', 'right'],
  wheel_rl: ['rear', 'left'],
  wheel_rr: ['rear', 'right'],
  front_suspension_l: ['front', 'left'],
  front_suspension_r: ['front', 'right'],
  rear_suspension_l: ['rear', 'left'],
  rear_suspension_r: ['rear', 'right'],
  exhaust: ['under', 'rear'],
  floor_pan: ['under'],
  boot_floor: ['rear', 'under'],
  load_bed_floor: ['rear']
};

/** Regions a zone belongs to (empty for an unknown zone id). */
export function zoneRegions(zoneId: string): VehicleRegion[] {
  const o = REGION_OVERRIDES[zoneId];
  if (o) return [...o];
  const z = getZone(zoneId);
  if (!z) return [];
  const out: VehicleRegion[] = [];
  switch (z.area) {
    case 'front':
      out.push('front');
      break;
    case 'rear':
      out.push('rear');
      break;
    case 'roof':
      out.push('top');
      break;
    case 'underbody':
      out.push('under');
      break;
    case 'interior':
      out.push('interior');
      break;
    default:
      break;
  }
  if (z.side === 'L') out.push('left');
  if (z.side === 'R') out.push('right');
  return out;
}

/** Regions a photo view shows. */
export function viewRegions(view: PhotoView): VehicleRegion[] {
  switch (view) {
    case 'front':
      return ['front'];
    case 'rear':
      return ['rear'];
    case 'left':
      return ['left'];
    case 'right':
      return ['right'];
    case 'front_left':
      return ['front', 'left'];
    case 'front_right':
      return ['front', 'right'];
    case 'rear_left':
      return ['rear', 'left'];
    case 'rear_right':
      return ['rear', 'right'];
    case 'top':
      return ['top'];
    case 'underside':
      return ['under'];
    case 'interior':
      return ['interior'];
    default:
      return [];
  }
}

export function isImpactDirection(v: unknown): v is ImpactDirection {
  return typeof v === 'string' && (IMPACT_DIRECTIONS as readonly string[]).includes(v);
}

const REGION_ALIASES: Record<string, VehicleRegion> = {
  front: 'front',
  rear: 'rear',
  back: 'rear',
  left: 'left',
  nearside: 'left',
  'n/s': 'left',
  ns: 'left',
  passenger: 'left',
  right: 'right',
  offside: 'right',
  'o/s': 'right',
  os: 'right',
  driver: 'right',
  top: 'top',
  roof: 'top',
  under: 'under',
  underside: 'under',
  underbody: 'under',
  interior: 'interior',
  inside: 'interior'
};

/**
 * Resolve a reported area (zone id, region word, impact direction or free-text panel name) to regions and, when it
 * names a panel, the zone. Returns null when nothing is recognised.
 */
export function resolveReportedArea(area: string): { zoneId: string | null; regions: VehicleRegion[] } | null {
  const t = area.trim();
  if (!t) return null;
  if (isZoneId(t)) return { zoneId: t, regions: zoneRegions(t) };
  const lower = t.toLowerCase();
  if ((VEHICLE_REGIONS as readonly string[]).includes(lower)) return { zoneId: null, regions: [lower as VehicleRegion] };
  if (isImpactDirection(lower) && lower !== 'unknown' && lower !== 'multiple' && lower !== 'rollover') {
    return { zoneId: null, regions: directionRegionsDefault(lower) };
  }
  const zone = zoneForPanelName(t);
  if (zone) return { zoneId: zone, regions: zoneRegions(zone) };
  const words = lower.split(/[^a-z/]+/).filter(Boolean);
  const regions = [...new Set(words.map((w) => REGION_ALIASES[w]).filter((r): r is VehicleRegion => !!r))];
  return regions.length ? { zoneId: null, regions } : null;
}

/** Built-in direction → regions (the consistency rule set carries the editable copy). */
export function directionRegionsDefault(d: ImpactDirection): VehicleRegion[] {
  switch (d) {
    case 'front':
      return ['front'];
    case 'rear':
      return ['rear'];
    case 'left':
      return ['left'];
    case 'right':
      return ['right'];
    case 'front_left':
      return ['front', 'left'];
    case 'front_right':
      return ['front', 'right'];
    case 'rear_left':
      return ['rear', 'left'];
    case 'rear_right':
      return ['rear', 'right'];
    case 'top':
      return ['top'];
    case 'underside':
      return ['under'];
    case 'rollover':
      return ['front', 'rear', 'left', 'right', 'top'];
    case 'multiple':
      return ['front', 'rear', 'left', 'right', 'top', 'under'];
    default:
      return [];
  }
}

/** Damaged zones (severity ≥ min) of a result. */
export function damagedZones<T extends { severity: DamageSeverity }>(zones: readonly T[], min: DamageSeverity = 1): T[] {
  return zones.filter((z) => z.severity >= min);
}

/**
 * The impact direction suggested by the damage pattern: severity-weighted region totals; a corner when both the
 * longitudinal and lateral totals are substantial. 'unknown' when nothing is damaged.
 */
export function inferImpactDirection(result: Pick<AssessmentResult, 'zones'>): ImpactDirection {
  const w: Record<VehicleRegion, number> = { front: 0, rear: 0, left: 0, right: 0, top: 0, under: 0, interior: 0 };
  for (const z of damagedZones(result.zones)) for (const r of zoneRegions(z.zoneId)) w[r] += z.severity;
  const longi = Math.max(w.front, w.rear);
  const lat = Math.max(w.left, w.right);
  const longLabel = w.front >= w.rear ? 'front' : 'rear';
  const latLabel = w.left >= w.right ? 'left' : 'right';
  if (longi === 0 && lat === 0) {
    if (w.top > 0) return 'top';
    if (w.under > 0) return 'underside';
    return 'unknown';
  }
  // Damage at both ends, roughly balanced, is more than one impact (or a shunt into the vehicle in front).
  if (w.front > 0 && w.rear > 0 && Math.min(w.front, w.rear) >= 0.6 * Math.max(w.front, w.rear) && lat < longi) return 'multiple';
  if (lat === 0) return longLabel;
  if (longi === 0) return latLabel;
  if (lat >= 0.5 * longi && longi >= 0.5 * lat) return `${longLabel}_${latLabel}` as ImpactDirection;
  return longi > lat ? longLabel : latLabel;
}

/** The reported direction when given (and not 'unknown'), else the inferred one. */
export function effectiveDirection(result: Pick<AssessmentResult, 'zones'>, reported?: ImpactDirection | null): { direction: ImpactDirection; inferred: boolean } {
  if (reported && reported !== 'unknown') return { direction: reported, inferred: false };
  return { direction: inferImpactDirection(result), inferred: true };
}

/** UK side label for a zone id ('N/S' for _l, 'O/S' for _r, '' for centre). */
export function sideOf(zoneId: string): 'l' | 'r' | null {
  const z = getZone(zoneId);
  if (!z || z.side === 'centre') return null;
  return z.side === 'L' ? 'l' : 'r';
}
export const SIDE_LABEL: Record<'l' | 'r', string> = { l: 'N/S', r: 'O/S' };
