/**
 * Generic labour-time defaults for AI-estimated schedule lines.
 *
 * GENERIC ESTIMATE, NOT MANUFACTURER TIME. These are ClaimDesk's own round-figure typical hours for a mainstream car,
 * used only so an AI-drafted line is not blank. They are not Audatex, Thatcham or manufacturer times and must never be
 * presented as such: every line using them carries `labourBasis: GENERIC_LABOUR_BASIS` and stays unverified until the
 * engineer replaces or confirms the figure (from the bodyshop / Audatex estimate or the owner's confirmed library).
 */
import { getZone, type DamageSeverity, type ZoneKind, type ZoneOperation } from '../panels.js';
import type { CheckKind, KnockOnCategory } from './types.js';

export const GENERIC_LABOUR_BASIS = 'Generic estimate, not manufacturer time';
export const GENERIC_LABOUR_TABLE_VERSION = '2026-10-07.1';

/** Labour category of the CarFlex repair costs summary (section 09). */
export type ScheduleLabourCategory = 'body' | 'mechanical' | 'auxiliary' | 'paint';

/** Repair hours by severity 1 / 2 / 3. */
type RepairHours = readonly [number, number, number];

interface KindHours {
  repair: RepairHours;
  replace: number;
  r_and_i: number;
  /** Full refinish of the zone (one side, outer). */
  paint: number;
  blend: number;
  category: ScheduleLabourCategory;
}

/** Defaults by zone kind (panels.ts ZoneKind). */
export const GENERIC_HOURS_BY_KIND: Record<ZoneKind, KindHours> = {
  panel: { repair: [1.0, 2.5, 5.0], replace: 2.0, r_and_i: 1.0, paint: 2.4, blend: 1.2, category: 'body' },
  bumper: { repair: [0.8, 1.5, 2.5], replace: 1.2, r_and_i: 1.0, paint: 2.2, blend: 1.1, category: 'body' },
  structural: { repair: [2.0, 4.0, 8.0], replace: 6.0, r_and_i: 2.0, paint: 1.5, blend: 0.8, category: 'body' },
  lamp: { repair: [0.5, 0.5, 0.5], replace: 0.5, r_and_i: 0.4, paint: 0, blend: 0, category: 'auxiliary' },
  glass: { repair: [0.5, 0.5, 0.5], replace: 1.2, r_and_i: 1.0, paint: 0, blend: 0, category: 'auxiliary' },
  trim: { repair: [0.5, 0.8, 1.0], replace: 0.5, r_and_i: 0.3, paint: 0.8, blend: 0.4, category: 'auxiliary' },
  mirror: { repair: [0.5, 0.6, 0.8], replace: 0.6, r_and_i: 0.4, paint: 0.8, blend: 0.4, category: 'auxiliary' },
  wheel: { repair: [0.5, 0.5, 0.5], replace: 0.4, r_and_i: 0.3, paint: 0, blend: 0, category: 'mechanical' },
  mechanical: { repair: [1.0, 1.5, 2.0], replace: 1.5, r_and_i: 1.0, paint: 0, blend: 0, category: 'mechanical' },
  sensor: { repair: [0.3, 0.3, 0.3], replace: 0.5, r_and_i: 0.3, paint: 0.5, blend: 0, category: 'auxiliary' }
};

/** Zone-specific overrides where the kind default would be badly off. */
export const GENERIC_HOURS_BY_ZONE: Record<string, Partial<Omit<KindHours, 'category' | 'repair'>> & { category?: ScheduleLabourCategory }> = {
  bonnet: { replace: 0.8, paint: 2.8 },
  front_wing_l: { replace: 1.5, paint: 2.0 },
  front_wing_r: { replace: 1.5, paint: 2.0 },
  front_door_l: { replace: 2.0, paint: 2.4 },
  front_door_r: { replace: 2.0, paint: 2.4 },
  rear_door_l: { replace: 2.0, paint: 2.4 },
  rear_door_r: { replace: 2.0, paint: 2.4 },
  sliding_door_l: { replace: 2.5, paint: 2.8 },
  sliding_door_r: { replace: 2.5, paint: 2.8 },
  quarter_panel_l: { replace: 9.0, paint: 2.6 },
  quarter_panel_r: { replace: 9.0, paint: 2.6 },
  load_side_panel_l: { replace: 8.0, paint: 3.2 },
  load_side_panel_r: { replace: 8.0, paint: 3.2 },
  load_bed_side_l: { replace: 6.0, paint: 2.8 },
  load_bed_side_r: { replace: 6.0, paint: 2.8 },
  sill_l: { replace: 6.0, paint: 1.5 },
  sill_r: { replace: 6.0, paint: 1.5 },
  roof: { replace: 12.0, paint: 3.5 },
  tailgate: { replace: 1.5, paint: 2.8 },
  boot_lid: { replace: 1.0, paint: 2.6 },
  rear_load_door_l: { replace: 1.5, paint: 2.4 },
  rear_load_door_r: { replace: 1.5, paint: 2.4 },
  load_bed_tailgate: { replace: 0.8, paint: 1.8 },
  front_bumper: { replace: 1.2, paint: 2.2 },
  rear_bumper: { replace: 1.0, paint: 2.2 },
  front_panel: { replace: 2.5 },
  chassis_leg_l: { replace: 8.0 },
  chassis_leg_r: { replace: 8.0 },
  a_pillar_l: { replace: 10.0 },
  a_pillar_r: { replace: 10.0 },
  b_pillar_l: { replace: 10.0 },
  b_pillar_r: { replace: 10.0 },
  rear_panel: { replace: 6.0, paint: 1.8 },
  boot_floor: { replace: 10.0 },
  floor_pan: { replace: 12.0 },
  load_bed_floor: { replace: 6.0 },
  headlamp_l: { replace: 0.8 },
  headlamp_r: { replace: 0.8 },
  windscreen: { replace: 1.5 },
  rear_screen: { replace: 1.5 },
  quarter_glass_l: { replace: 1.5 },
  quarter_glass_r: { replace: 1.5 },
  sunroof: { replace: 2.5 },
  dashboard: { replace: 8.0, r_and_i: 6.0 },
  seats: { replace: 1.0 },
  soft_top: { replace: 6.0 },
  roof_rail_l: { replace: 0.8 },
  roof_rail_r: { replace: 0.8 },
  spoiler: { replace: 0.8, paint: 1.2 },
  radiator: { replace: 2.0 },
  front_suspension_l: { replace: 2.0 },
  front_suspension_r: { replace: 2.0 },
  rear_suspension_l: { replace: 2.0 },
  rear_suspension_r: { replace: 2.0 },
  exhaust: { replace: 1.5 },
  airbags: { replace: 1.5 },
  grille: { replace: 0.5 },
  front_radar: { replace: 0.5, r_and_i: 0.5 }
};

/** Knock-on item defaults by category (overridden per item by `genericHours` in the rule data). */
export const GENERIC_HOURS_BY_CATEGORY: Record<KnockOnCategory, { hours: number; category: ScheduleLabourCategory }> = {
  clips: { hours: 0, category: 'body' },
  bracket: { hours: 0.3, category: 'body' },
  absorber: { hours: 0.4, category: 'body' },
  reinforcement: { hours: 0.8, category: 'body' },
  moulding: { hours: 0.3, category: 'body' },
  emblem: { hours: 0.2, category: 'body' },
  grille: { hours: 0.4, category: 'body' },
  parking_sensor: { hours: 0.3, category: 'auxiliary' },
  sensor_bracket: { hours: 0.2, category: 'auxiliary' },
  radar: { hours: 0.5, category: 'auxiliary' },
  camera: { hours: 0.5, category: 'auxiliary' },
  adas_calibration: { hours: 1.0, category: 'auxiliary' },
  headlamp_washer: { hours: 0.5, category: 'auxiliary' },
  fog_lamp: { hours: 0.3, category: 'auxiliary' },
  lamp: { hours: 0.3, category: 'auxiliary' },
  number_plate: { hours: 0.2, category: 'auxiliary' },
  wheel_arch_liner: { hours: 0.4, category: 'body' },
  splash_shield: { hours: 0.4, category: 'body' },
  airbag: { hours: 1.0, category: 'auxiliary' },
  seatbelt_pretensioner: { hours: 1.0, category: 'auxiliary' },
  srs_module: { hours: 0.8, category: 'auxiliary' },
  coolant: { hours: 0.5, category: 'mechanical' },
  air_conditioning: { hours: 0.8, category: 'mechanical' },
  cooling_component: { hours: 0.5, category: 'mechanical' },
  glass: { hours: 0.8, category: 'auxiliary' },
  trim: { hours: 0.3, category: 'auxiliary' },
  mechanical: { hours: 0.5, category: 'mechanical' },
  consumable: { hours: 0, category: 'body' }
};

/** Hidden-damage check defaults. */
export const GENERIC_HOURS_BY_CHECK: Record<CheckKind, { hours: number; category: ScheduleLabourCategory }> = {
  structural_measurement: { hours: 1.5, category: 'body' },
  wheel_alignment: { hours: 1.0, category: 'mechanical' },
  suspension_inspection: { hours: 0.5, category: 'mechanical' },
  steering_inspection: { hours: 0.5, category: 'mechanical' },
  diagnostics_scan: { hours: 0.5, category: 'auxiliary' },
  adas_calibration: { hours: 1.0, category: 'auxiliary' },
  airbag_srs_check: { hours: 0.5, category: 'auxiliary' },
  seatbelt_inspection: { hours: 0.3, category: 'auxiliary' },
  cooling_system_check: { hours: 0.5, category: 'mechanical' },
  air_conditioning_check: { hours: 0.5, category: 'mechanical' },
  high_voltage_system_check: { hours: 1.0, category: 'mechanical' },
  panel_gap_check: { hours: 0.3, category: 'body' },
  underbody_inspection: { hours: 0.5, category: 'mechanical' },
  wheel_tyre_inspection: { hours: 0.3, category: 'mechanical' },
  headlamp_aim: { hours: 0.3, category: 'auxiliary' },
  glass_inspection: { hours: 0.2, category: 'auxiliary' }
};

/** Generic hours for an operation on a zone (null for an unknown zone). Repair hours scale with severity. */
export function genericZoneHours(zoneId: string, operation: ZoneOperation, severity: DamageSeverity): number | null {
  const z = getZone(zoneId);
  if (!z) return null;
  const kind = GENERIC_HOURS_BY_KIND[z.kind];
  const over = GENERIC_HOURS_BY_ZONE[zoneId] ?? {};
  if (operation === 'repair') {
    const i = Math.min(3, Math.max(1, severity)) - 1;
    return kind.repair[i] ?? kind.repair[0];
  }
  return over[operation] ?? kind[operation];
}

/** Labour category for work on a zone (body / mechanical / auxiliary). */
export function zoneLabourCategory(zoneId: string): ScheduleLabourCategory {
  const z = getZone(zoneId);
  if (!z) return 'body';
  return GENERIC_HOURS_BY_ZONE[zoneId]?.category ?? GENERIC_HOURS_BY_KIND[z.kind].category;
}

/** Zones refinished as a matter of course when repaired or replaced (body panels, bumpers, structural members). */
export function zoneIsPainted(zoneId: string): boolean {
  const z = getZone(zoneId);
  if (!z) return false;
  return z.kind === 'panel' || z.kind === 'bumper' || z.kind === 'structural';
}
