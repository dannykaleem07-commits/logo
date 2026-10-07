import { describe, expect, it } from 'vitest';
import { recommendChecks } from './checks.js';
import { loadCheckRules, result, zone } from './testkit.js';

const rules = loadCheckRules();
const byKey = (cs: ReturnType<typeof recommendChecks>) => Object.fromEntries(cs.map((c) => [c.key, c]));

describe('recommendChecks', () => {
  it('structural member damage requires structural measurement and a diagnostic scan', () => {
    const c = byKey(recommendChecks(result([zone('chassis_leg_r', 2, 'repair'), zone('front_bumper', 2, 'replace')]), { direction: 'front_right' }, rules));
    expect(c.structural_measurement!.priority).toBe('required');
    expect(c.diagnostics_scan!.priority).toBe('required');
    expect(c.wheel_alignment!.priority).toBe('recommended');
    expect(c.cooling_system_check).toBeDefined();
  });

  it('light cosmetic damage only recommends a scan', () => {
    const cs = recommendChecks(result([zone('front_door_l', 1, 'repair', { damageTypes: ['scratch'] })]), {}, rules);
    expect(cs.map((c) => c.key)).toEqual(['diagnostics_scan']);
    expect(cs[0]!.priority).toBe('recommended');
  });

  it('wheel damage requires alignment and a suspension inspection on that side', () => {
    const c = byKey(recommendChecks(result([zone('wheel_fl', 2, 'replace')]), {}, rules));
    expect(c.wheel_alignment!.priority).toBe('required');
    expect(c.suspension_inspection_l!.priority).toBe('required');
    expect(c.suspension_inspection_l!.label).toMatch(/N\/S/);
    expect(c.steering_inspection).toBeDefined();
  });

  it('merges triggers, keeps the highest priority and leads with its reason', () => {
    const c = byKey(recommendChecks(result([zone('front_bumper', 3, 'replace'), zone('front_panel', 2, 'replace')]), { direction: 'front' }, rules));
    const sm = c.structural_measurement!;
    expect(sm.priority).toBe('required');
    expect(sm.triggers.map((t) => t.ruleId)).toEqual(expect.arrayContaining(['structural.members_damaged', 'structural.heavy_outer']));
    expect(sm.reasons[0]).toMatch(/structural member/);
  });

  it('sorts required checks first', () => {
    const cs = recommendChecks(result([zone('front_bumper', 3, 'replace'), zone('sill_l', 2, 'repair')]), { speedMph: 25 }, rules);
    const ranks = cs.map((c) => ({ required: 3, recommended: 2, consider: 1 })[c.priority]);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
  });

  it('deployment requires SRS, seatbelt and structural checks; a frontal one adds glass', () => {
    const c = byKey(recommendChecks(result([zone('front_bumper', 2, 'replace')], { deploymentVisible: true }), { direction: 'front' }, rules));
    expect(c.airbag_srs_check!.priority).toBe('required');
    expect(c.seatbelt_inspection!.priority).toBe('required');
    expect(c.structural_measurement!.priority).toBe('required');
    expect(c.glass_inspection!.priority).toBe('recommended');
  });

  it('reported speed raises structural measurement and seatbelt checks; no speed means the speed rules stay quiet', () => {
    const r = result([zone('rear_bumper', 2, 'replace')]);
    const fast = byKey(recommendChecks(r, { speedMph: 30 }, rules));
    expect(fast.structural_measurement!.priority).toBe('recommended');
    expect(fast.seatbelt_inspection!.priority).toBe('consider');
    const none = byKey(recommendChecks(r, {}, rules));
    expect(none.structural_measurement).toBeUndefined();
    expect(none.seatbelt_inspection).toBeUndefined();
  });

  it('ADAS calibration depends on the fitted features', () => {
    const r = result([zone('windscreen', 2, 'replace')]);
    expect(byKey(recommendChecks(r, {}, rules, { features: ['lane_keep_assist'] })).adas_front_camera!.priority).toBe('required');
    expect(byKey(recommendChecks(r, {}, rules, { features: ['bluetooth'] })).adas_front_camera).toBeUndefined();
    expect(byKey(recommendChecks(r, {}, rules)).adas_front_camera!.fitment).toBe('if_fitted');
    const radar = byKey(recommendChecks(result([zone('front_bumper', 1, 'repair')]), {}, rules, { features: ['adaptive_cruise'] }));
    expect(radar.adas_front_radar!.adas).toEqual({ system: 'front_radar', method: 'static_or_dynamic' });
  });

  it('electrified vehicles get a high-voltage check; underbody damage makes it required', () => {
    const ev = { powertrain: 'electric' as const };
    expect(byKey(recommendChecks(result([zone('front_bumper', 2, 'replace')]), {}, rules, ev)).high_voltage_system_check!.priority).toBe('recommended');
    expect(byKey(recommendChecks(result([zone('sill_r', 1, 'repair')]), {}, rules, ev)).high_voltage_system_check!.priority).toBe('required');
    expect(byKey(recommendChecks(result([zone('sill_r', 2, 'repair')]), {}, rules, { powertrain: 'petrol' })).high_voltage_system_check).toBeUndefined();
  });

  it('visible fluid requires an underbody inspection and a cooling check', () => {
    const c = byKey(recommendChecks(result([zone('front_bumper', 1, 'repair')], { fluidLeakVisible: true }), {}, rules));
    expect(c.underbody_inspection!.priority).toBe('required');
    expect(c.cooling_system_check!.priority).toBe('required');
  });

  it('a replaced headlamp must be aimed; rollover needs structural measurement', () => {
    expect(byKey(recommendChecks(result([zone('headlamp_l', 2, 'replace')]), {}, rules)).headlamp_aim!.priority).toBe('required');
    expect(byKey(recommendChecks(result([zone('roof', 2, 'repair')]), { direction: 'rollover' }, rules)).structural_measurement!.priority).toBe('required');
  });

  it('every check is an unverified AI estimate with a reason; nothing damaged → no checks', () => {
    for (const c of recommendChecks(result([zone('front_bumper', 3, 'replace')], { deploymentVisible: true }), {}, rules)) {
      expect(c.source).toBe('ai_estimate');
      expect(c.verified).toBe(false);
      expect(c.reasons.length).toBeGreaterThan(0);
    }
    expect(recommendChecks(result([]), {}, rules)).toEqual([]);
  });
});
