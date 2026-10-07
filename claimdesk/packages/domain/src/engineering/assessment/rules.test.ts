import { describe, expect, it } from 'vitest';
import { VEHICLE_ZONES } from '../panels.js';
import { validateCheckRules } from './checks.js';
import { isNeutral, validateConsistencyRules } from './consistency.js';
import { validateKnockOnRules } from './knockOn.js';
import { catalogueFeatureIds, loadCheckRules, loadConsistencyRules, loadKnockOnRules } from './testkit.js';
import { CHECK_KINDS, CONSISTENCY_RULE_KINDS, KNOCK_ON_CATEGORIES, type KnockOnRuleSet } from './types.js';

const knockOn = loadKnockOnRules();
const checks = loadCheckRules();
const consistency = loadConsistencyRules();
const features = catalogueFeatureIds();

describe('kb engineering rule sets validate', () => {
  it('knock-on-parts.json is valid against the zone taxonomy and the catalogue features', () => {
    expect(validateKnockOnRules(knockOn, features)).toEqual([]);
  });
  it('hidden-damage-checks.json is valid', () => {
    expect(validateCheckRules(checks, features)).toEqual([]);
  });
  it('consistency-rules.json is valid and neutral', () => {
    expect(validateConsistencyRules(consistency)).toEqual([]);
  });
  it('every rule set is marked unverified with a source note saying it is not manufacturer data', () => {
    for (const set of [knockOn, checks, consistency]) {
      expect(set.verification.status).toBe('unverified');
      expect(set.verification.sourceNote.length).toBeGreaterThan(60);
    }
    expect(knockOn.verification.sourceNote).toMatch(/not manufacturer data/i);
    expect(checks.verification.sourceNote).toMatch(/not a manufacturer repair method/i);
  });
});

describe('knock-on coverage', () => {
  const categories = new Set(knockOn.rules.flatMap((r) => r.items.map((i) => i.category)));
  it('covers every associated-part family the brief lists', () => {
    for (const c of [
      'clips',
      'bracket',
      'absorber',
      'reinforcement',
      'moulding',
      'emblem',
      'grille',
      'parking_sensor',
      'sensor_bracket',
      'radar',
      'camera',
      'adas_calibration',
      'headlamp_washer',
      'fog_lamp',
      'number_plate',
      'wheel_arch_liner',
      'splash_shield',
      'airbag',
      'seatbelt_pretensioner',
      'coolant',
      'air_conditioning',
      'cooling_component'
    ] as const) {
      expect(categories, c).toContain(c);
    }
    for (const c of categories) expect(KNOCK_ON_CATEGORIES).toContain(c);
  });
  it('has rules for every bumper, the bonnet, wings, doors, quarters, lamps, glass, wheels and deployment', () => {
    const triggered = new Set(knockOn.rules.flatMap((r) => r.zones ?? ['(global)']));
    for (const z of ['front_bumper', 'rear_bumper', 'bonnet', 'grille', 'front_panel', 'radiator', 'chassis_leg_l', 'headlamp_r', 'fog_lamp_l', 'front_wing_l', 'front_door_r', 'rear_door_l', 'quarter_panel_r', 'door_mirror_l', 'windscreen', 'rear_screen', 'tailgate', 'boot_lid', 'roof', 'wheel_fl', 'front_suspension_r', 'exhaust', 'airbags', '(global)']) {
      expect(triggered, z).toContain(z);
    }
  });
  it('ADAS items always carry a calibration requirement and are feature-gated', () => {
    for (const r of knockOn.rules)
      for (const i of r.items)
        if (i.category === 'adas_calibration') {
          expect(i.adas, `${r.id}/${i.key}`).toBeDefined();
          // gated on a catalogue feature, unless the rule fires on the sensor zone itself (then it is fitted)
          if (!r.zones?.every((z) => ['front_radar', 'reversing_camera'].includes(z))) expect(r.when?.featuresAny ?? i.featuresAny, `${r.id} must be feature-gated`).toBeDefined();
        }
  });
  it('airbag and pretensioner items only fire on deployment or a damaged airbag zone', () => {
    for (const r of knockOn.rules)
      if (r.items.some((i) => i.category === 'airbag' || (i.category === 'seatbelt_pretensioner' && i.operation === 'replace'))) {
        expect(r.when?.deploymentIndicated === true || r.zones?.includes('airbags'), r.id).toBe(true);
      }
  });
  it('reasons are plain English and no rule text carries a part number or a price', () => {
    for (const r of knockOn.rules) {
      expect(r.reason).toMatch(/^[A-Z].*\.$/);
      const text = [r.reason, ...r.items.map((i) => i.label)].join(' ');
      expect(text).not.toMatch(/£\s?\d|\b\d+(\.\d+)?\s?(hours?|hrs)\b/);
      expect(text).not.toMatch(/\b[A-Z0-9]{2,}\d{5,}\b/);
    }
  });
  it('every zone id mentioned exists in the taxonomy', () => {
    const ids = new Set(VEHICLE_ZONES.map((z) => z.id));
    for (const r of knockOn.rules) for (const z of r.zones ?? []) expect(ids.has(z), z).toBe(true);
    for (const r of checks.rules) for (const z of r.zones ?? []) expect(ids.has(z), z).toBe(true);
  });
});

describe('check and consistency coverage', () => {
  it('covers structural measurement, alignment, suspension, diagnostics, ADAS and airbag checks', () => {
    const kinds = new Set(checks.rules.map((r) => r.check));
    for (const k of ['structural_measurement', 'wheel_alignment', 'suspension_inspection', 'diagnostics_scan', 'adas_calibration', 'airbag_srs_check'] as const) expect(kinds).toContain(k);
    for (const k of kinds) expect(CHECK_KINDS).toContain(k);
  });
  it('has a rule for every consistency kind and every message is neutral and points to the engineer', () => {
    expect(new Set(consistency.rules.map((r) => r.kind))).toEqual(new Set(CONSISTENCY_RULE_KINDS));
    for (const r of consistency.rules) {
      expect(isNeutral(r.message), r.id).toBe(true);
      expect(r.message).toMatch(/engineer/i);
    }
  });
  it('no rule set text uses accusatory language', () => {
    const all = JSON.stringify([knockOn, checks, consistency]);
    expect(isNeutral(all)).toBe(true);
  });
});

describe('validators reject bad data', () => {
  const base = (): KnockOnRuleSet => JSON.parse(JSON.stringify(knockOn)) as KnockOnRuleSet;
  it('knock-on: unknown zone, category, feature, condition, token misuse and duplicate ids', () => {
    const d = base();
    d.rules[0]!.zones = ['front_bumpr'];
    d.rules[1]!.items[0]!.category = 'gizmo' as never;
    d.rules[2]!.when = { featuresAny: ['flux_capacitor'] };
    (d.rules[3]!.when as Record<string, unknown>).colour = 'red';
    d.rules[4]!.items[0]!.label = 'Bracket {sideLabel}'; // front_bumper is not sided
    d.rules[5]!.id = d.rules[6]!.id;
    d.rules[7]!.items[0]!.label = 'Bracket 5Q0807221 at £45';
    const problems = validateKnockOnRules(d, features).join('\n');
    expect(problems).toMatch(/unknown zone "front_bumpr"/);
    expect(problems).toMatch(/unknown category "gizmo"/);
    expect(problems).toMatch(/featuresAny has unknown value "flux_capacitor"/);
    expect(problems).toMatch(/unknown condition "colour"/);
    expect(problems).toMatch(/side token but a trigger zone is not sided/);
    expect(problems).toMatch(/duplicate id/);
    expect(problems).toMatch(/part numbers or prices/);
  });
  it('knock-on: shape errors', () => {
    expect(validateKnockOnRules(null)).toEqual(['rule set must be an object']);
    expect(validateKnockOnRules({ schemaVersion: 2, rules: [] }).join('\n')).toMatch(/schemaVersion must be 1[\s\S]*rules must be a non-empty array/);
  });
  it('checks: unknown check kind and priority', () => {
    const d = JSON.parse(JSON.stringify(checks)) as typeof checks;
    d.rules[0]!.check = 'tea_break' as never;
    d.rules[1]!.priority = 'urgent' as never;
    const p = validateCheckRules(d).join('\n');
    expect(p).toMatch(/unknown check "tea_break"/);
    expect(p).toMatch(/unknown priority/);
  });
  it('consistency: accusatory wording, unknown placeholder and missing direction are rejected', () => {
    const d = JSON.parse(JSON.stringify(consistency)) as typeof consistency;
    d.rules[0]!.message = 'This looks like a staged accident, the driver has exaggerated the damage.';
    d.rules[1]!.message = 'Damage at {zones} near {postcode} for the engineer to consider.';
    delete (d.directionRegions as Partial<typeof d.directionRegions>).rear;
    const p = validateConsistencyRules(d).join('\n');
    expect(p).toMatch(/not neutral/);
    expect(p).toMatch(/unknown placeholder \{postcode\}/);
    expect(p).toMatch(/directionRegions.rear missing/);
  });
});
