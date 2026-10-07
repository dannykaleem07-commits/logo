import { describe, expect, it } from 'vitest';
import { expandKnockOnParts } from './knockOn.js';
import { loadKnockOnRules, result, zone } from './testkit.js';
import type { AssessmentVehicle, KnockOnRuleSet } from './types.js';

const rules = loadKnockOnRules();
const keys = (s: { suggestions: Array<{ key: string }> }) => s.suggestions.map((x) => x.key);
const get = (s: { suggestions: Array<{ key: string }> }, key: string) => s.suggestions.find((x) => x.key === key) as ReturnType<typeof expandKnockOnParts>['suggestions'][number] | undefined;

const ADAS_CAR: AssessmentVehicle = { bodyType: 'hatchback', features: ['adaptive_cruise', 'lane_keep_assist', 'parking_sensors_front', 'parking_sensors_rear', 'xenon_headlights', 'blind_spot', 'rear_camera', 'tyre_pressure_monitoring'] };
const BASIC_CAR: AssessmentVehicle = { bodyType: 'hatchback', features: ['air_con_manual', 'bluetooth'] };
const UNKNOWN_CAR: AssessmentVehicle = { bodyType: 'hatchback' };

describe('front bumper replacement', () => {
  const r = result([zone('front_bumper', 2, 'replace')]);

  it('always suggests the standard fixings, absorber, brackets and number plate', () => {
    const s = expandKnockOnParts(r, BASIC_CAR, rules);
    expect(keys(s)).toEqual(expect.arrayContaining(['front_bumper_clips', 'front_bumper_side_brackets', 'front_bumper_absorber', 'front_number_plate', 'front_undertray', 'front_lower_grille_transfer']));
    expect(get(s, 'front_bumper_clips')!.fitment).toBe('standard');
    expect(get(s, 'front_number_plate')!.fitment).toBe('if_fitted');
  });

  it('with parking sensors, radar and xenon lamps fitted: sensors, brackets, washers and radar calibration', () => {
    const s = expandKnockOnParts(r, ADAS_CAR, rules);
    expect(keys(s)).toEqual(expect.arrayContaining(['front_pdc_brackets', 'front_pdc_transfer', 'headlamp_washer_jets', 'front_radar_transfer', 'front_radar_calibration', 'front_radar_bracket']));
    const cal = get(s, 'front_radar_calibration')!;
    expect(cal.adas).toEqual({ system: 'front_radar', method: 'static_or_dynamic' });
    expect(cal.fitment).toBe('fitted');
    expect(cal.reasons[0]).toMatch(/manufacturer procedure/);
  });

  it('features known but not fitted: feature-dependent parts are listed as not applicable, not suggested', () => {
    const s = expandKnockOnParts(r, BASIC_CAR, rules);
    expect(keys(s)).not.toContain('front_pdc_brackets');
    expect(keys(s)).not.toContain('front_radar_calibration');
    expect(s.notApplicable.map((n) => n.key)).toEqual(expect.arrayContaining(['front_pdc_brackets', 'front_radar_calibration', 'headlamp_washer_jets']));
    expect(s.notApplicable[0]!.reason).toMatch(/Add it if the vehicle has it fitted/);
  });

  it('features unknown: feature-dependent parts are suggested "if fitted"', () => {
    const s = expandKnockOnParts(r, UNKNOWN_CAR, rules);
    expect(get(s, 'front_radar_calibration')!.fitment).toBe('if_fitted');
    expect(get(s, 'front_pdc_brackets')!.fitment).toBe('if_fitted');
    expect(s.notApplicable).toEqual([]);
  });

  it('light repair on the bumper (no removal) adds little; heavy damage adds reinforcement and cooling items', () => {
    const light = expandKnockOnParts(result([zone('front_bumper', 1, 'repair')]), BASIC_CAR, rules);
    expect(keys(light)).toEqual(['front_number_plate']);
    const heavy = expandKnockOnParts(result([zone('front_bumper', 3, 'replace')]), BASIC_CAR, rules, { impact: { direction: 'front' } });
    expect(keys(heavy)).toEqual(expect.arrayContaining(['front_bumper_reinforcement', 'front_crash_boxes', 'ac_condenser', 'coolant_refill', 'ac_regas', 'radiator_check', 'engine_mounts']));
  });

  it('direction conditions use the reported direction, falling back to the damage pattern', () => {
    const r3 = result([zone('front_bumper', 3, 'replace')]);
    expect(keys(expandKnockOnParts(r3, BASIC_CAR, rules))).toContain('front_bumper_reinforcement'); // inferred front
    expect(keys(expandKnockOnParts(r3, BASIC_CAR, rules, { impact: { direction: 'rear' } }))).not.toContain('front_bumper_reinforcement');
  });

  it('merges the same item from several rules: strongest operation, every trigger and reason', () => {
    const s = expandKnockOnParts(result([zone('front_bumper', 3, 'replace')]), ADAS_CAR, rules, { impact: { direction: 'front' } });
    const pdc = get(s, 'front_pdc_transfer')!;
    expect(pdc.operation).toBe('replace');
    expect(pdc.label).toMatch(/replace those damaged/);
    expect(pdc.triggers.map((t) => t.ruleId)).toEqual(['front_bumper.parking_sensors', 'front_bumper.parking_sensors_heavy']);
    expect(pdc.reasons).toHaveLength(2);
    const coolant = get(s, 'coolant_refill')!;
    expect(new Set(coolant.triggers.map((t) => t.ruleId))).toEqual(new Set(['front.heavy_impact']));
  });

  it('every suggestion is an unverified AI estimate', () => {
    const s = expandKnockOnParts(result([zone('front_bumper', 3, 'replace')]), ADAS_CAR, rules);
    for (const x of s.suggestions) {
      expect(x.source).toBe('ai_estimate');
      expect(x.verified).toBe(false);
      expect(x.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe('items that are zones of their own', () => {
  it('are skipped when the AI already recorded that zone', () => {
    const r = result([zone('front_bumper', 2, 'replace'), zone('front_radar', 2, 'replace'), zone('fog_lamp_l', 2, 'replace')]);
    const s = expandKnockOnParts(r, ADAS_CAR, rules);
    expect(keys(s)).not.toContain('front_radar_transfer');
    expect(keys(s)).not.toContain('fog_lamp_l_transfer');
    expect(keys(s)).toContain('fog_lamp_r_transfer');
    expect(keys(s)).toContain('front_radar_calibration'); // from the radar zone itself
  });
  it('are skipped when the zone does not exist on the body', () => {
    const van: AssessmentVehicle = { bodyType: 'panel-van' };
    const s = expandKnockOnParts(result([zone('load_side_panel_r', 2, 'replace')]), van, rules);
    expect(keys(s)).not.toContain('quarter_glass_transfer_r');
    expect(keys(s)).toContain('rear_arch_liner_r');
    const car = expandKnockOnParts(result([zone('quarter_panel_r', 2, 'replace')]), { bodyType: 'saloon' }, rules);
    expect(get(car, 'quarter_glass_transfer_r')!.zoneId).toBe('quarter_glass_r');
  });
});

describe('sided zones', () => {
  it('fills the side from the triggering zone (UK nearside / offside)', () => {
    const s = expandKnockOnParts(result([zone('front_wing_r', 2, 'replace'), zone('chassis_leg_l', 2, 'repair')]), BASIC_CAR, rules);
    expect(get(s, 'front_arch_liner_r')!.label).toMatch(/O\/S/);
    expect(get(s, 'crash_box_l')!.label).toBe('Front crash box / crash can N/S');
    expect(keys(s)).toContain('seam_sealer_corrosion');
  });
  it('per-zone keys keep two doors apart', () => {
    const s = expandKnockOnParts(result([zone('front_door_l', 3, 'replace'), zone('rear_door_l', 3, 'replace')]), BASIC_CAR, rules);
    expect(keys(s)).toEqual(expect.arrayContaining(['door_membrane_clips_front_door_l', 'door_membrane_clips_rear_door_l', 'door_hinges_front_door_l']));
    expect(get(s, 'door_transfer_rear_door_l')!.label).toMatch(/Rear door \(N\/S, left\)$/);
  });
});

describe('deployment', () => {
  it('suggests airbags, pretensioners and SRS unit when deployment is seen', () => {
    const s = expandKnockOnParts(result([zone('front_bumper', 3, 'replace')], { deploymentVisible: true }), BASIC_CAR, rules, { impact: { direction: 'front' } });
    expect(keys(s)).toEqual(expect.arrayContaining(['deployed_airbags', 'seatbelt_pretensioners', 'srs_control_unit', 'crash_sensors', 'clock_spring', 'dashboard_airbag_check']));
  });
  it('also when deployment is only reported', () => {
    const s = expandKnockOnParts(result([zone('front_bumper', 2, 'replace')]), BASIC_CAR, rules, { impact: { airbagsDeployed: true } });
    expect(keys(s)).toContain('seatbelt_pretensioners');
  });
  it('never without deployment', () => {
    const s = expandKnockOnParts(result([zone('front_bumper', 3, 'replace'), zone('front_door_l', 3, 'replace')]), BASIC_CAR, rules);
    expect(s.suggestions.some((x) => x.category === 'airbag' || x.category === 'seatbelt_pretensioner' && x.operation === 'replace')).toBe(false);
  });
  it('a deployed airbags zone keeps its own line; pretensioners and SRS unit still follow', () => {
    const r = result([zone('airbags', 3, 'replace', { damageTypes: ['deployed'] })]);
    const s = expandKnockOnParts(r, BASIC_CAR, rules);
    expect(keys(s)).not.toContain('deployed_airbags');
    expect(keys(s)).toEqual(expect.arrayContaining(['seatbelt_pretensioners', 'srs_control_unit']));
  });
  it('side deployment adds side / curtain airbags on the impact side', () => {
    const s = expandKnockOnParts(result([zone('front_door_r', 3, 'replace')], { deploymentVisible: true }), BASIC_CAR, rules);
    expect(get(s, 'side_airbags_r')!.label).toMatch(/O\/S/);
  });
});

describe('other areas', () => {
  it('windscreen replacement with a camera system needs calibration and a gel pad', () => {
    const s = expandKnockOnParts(result([zone('windscreen', 2, 'replace')]), { features: ['lane_keep_assist', 'auto_lights_wipers', 'heated_windscreen'] }, rules);
    expect(keys(s)).toEqual(expect.arrayContaining(['windscreen_bonding_kit', 'windscreen_camera_calibration', 'rain_sensor_pad', 'windscreen_specification']));
  });
  it('a wheel replacement with TPMS transfers the sensor; a wheel strike adds suspension checks', () => {
    const s = expandKnockOnParts(result([zone('wheel_fr', 2, 'replace')]), ADAS_CAR, rules);
    expect(keys(s)).toEqual(expect.arrayContaining(['tpms_sensor_wheel_fr', 'wheel_fitting_wheel_fr', 'track_rod_end_r', 'front_hub_r', 'front_arch_liner_r']));
  });
  it('rear impact with blind-spot radar and a tow bar', () => {
    const s = expandKnockOnParts(result([zone('rear_bumper', 2, 'replace')]), { features: ['blind_spot', 'tow_bar'] }, rules);
    expect(keys(s)).toEqual(expect.arrayContaining(['rear_bumper_clips', 'rear_corner_radars', 'rear_radar_calibration', 'tow_bar_check', 'rear_number_plate', 'number_plate_lamps']));
  });
  it('tailgate replacement on a hatchback transfers the glass and camera', () => {
    const s = expandKnockOnParts(result([zone('tailgate', 3, 'replace')]), ADAS_CAR, rules);
    expect(keys(s)).toEqual(expect.arrayContaining(['rear_emblems', 'tailgate_transfer', 'rear_screen_transfer', 'reversing_camera_transfer']));
  });
  it('radiator damage adds coolant, mountings and (medium) AC', () => {
    expect(keys(expandKnockOnParts(result([zone('radiator', 1, 'replace')]), BASIC_CAR, rules))).toEqual(['coolant_refill', 'radiator_mountings']);
    expect(keys(expandKnockOnParts(result([zone('radiator', 2, 'replace')]), BASIC_CAR, rules))).toContain('ac_regas');
  });
  it('electrified / powertrain and body conditions are honoured', () => {
    const custom: KnockOnRuleSet = {
      ...rules,
      rules: [
        { id: 't.ev', zones: ['front_bumper'], when: { powertrainsAny: ['electric'] }, items: [{ key: 'ev_item', label: 'EV item', category: 'mechanical', operation: 'check' }], reason: 'Test reason that is long enough to read.' },
        { id: 't.van', zones: ['front_bumper'], when: { bodyTypesAny: ['panel-van'] }, items: [{ key: 'van_item', label: 'Van item', category: 'trim', operation: 'check' }], reason: 'Test reason that is long enough to read.' },
        { id: 't.also', zones: ['front_bumper'], when: { alsoDamagedAny: ['bonnet'], minDamagedZones: 2 }, items: [{ key: 'also_item', label: 'Also item', category: 'trim', operation: 'check' }], reason: 'Test reason that is long enough to read.' },
        { id: 't.max', zones: ['front_bumper'], when: { maxSeverity: 1, damageTypesAny: ['scratch'] }, items: [{ key: 'max_item', label: 'Max item', category: 'trim', operation: 'check' }], reason: 'Test reason that is long enough to read.' }
      ]
    };
    const r = result([zone('front_bumper', 2, 'repair'), zone('bonnet', 1, 'repair')]);
    expect(keys(expandKnockOnParts(r, { powertrain: 'electric', bodyType: 'panel-van' }, custom))).toEqual(['ev_item', 'van_item', 'also_item']);
    expect(keys(expandKnockOnParts(r, { powertrain: 'diesel' }, custom))).toEqual(['also_item']);
    expect(keys(expandKnockOnParts(result([zone('front_bumper', 1, 'repair', { damageTypes: ['scratch'] })]), {}, custom))).toEqual(['max_item']);
  });
  it('an empty result suggests nothing', () => {
    expect(expandKnockOnParts(result([]), ADAS_CAR, rules)).toEqual({ suggestions: [], notApplicable: [] });
    expect(expandKnockOnParts(result([zone('front_bumper', 0)]), ADAS_CAR, rules).suggestions).toEqual([]);
  });
});
