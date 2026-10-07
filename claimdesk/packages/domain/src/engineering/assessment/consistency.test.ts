import { describe, expect, it } from 'vitest';
import { consistencyFindings, isNeutral } from './consistency.js';
import { loadConsistencyRules, photo, result, zone } from './testkit.js';
import type { ConsistencyFinding } from './types.js';

const rules = loadConsistencyRules();
const kinds = (fs: ConsistencyFinding[]) => fs.map((f) => f.kind);

describe('consistencyFindings', () => {
  it('nothing reported, nothing unusual → no findings', () => {
    expect(consistencyFindings(result([zone('front_bumper', 2, 'replace')]), {}, rules)).toEqual([]);
  });

  it('damage matching the reported direction raises nothing', () => {
    const r = result([zone('front_bumper', 2, 'replace'), zone('front_wing_r', 2, 'repair'), zone('headlamp_r', 2, 'replace')]);
    expect(consistencyFindings(r, { direction: 'front_right', primaryArea: 'front bumper', speedMph: 20 }, rules)).toEqual([]);
  });

  it('flags medium damage away from the reported direction, neutrally', () => {
    const r = result([zone('rear_bumper', 2, 'replace'), zone('tailgate', 2, 'repair'), zone('front_bumper', 1, 'repair')]);
    const f = consistencyFindings(r, { direction: 'front' }, rules);
    expect(kinds(f)).toEqual(['damage_outside_reported_direction']);
    expect(f[0]!.zoneIds).toEqual(['rear_bumper', 'tailgate']);
    expect(f[0]!.message).toMatch(/Rear bumper and Tailgate, away from the reported front impact\. For the engineer to consider/);
    expect(f[0]!.level).toBe('consider');
  });

  it('light damage elsewhere and secondary areas reported are not flagged', () => {
    const r = result([zone('front_bumper', 2, 'replace'), zone('rear_bumper', 2, 'repair')]);
    expect(consistencyFindings(result([zone('front_bumper', 2, 'replace'), zone('rear_bumper', 1, 'repair')]), { direction: 'front' }, rules)).toEqual([]);
    expect(consistencyFindings(r, { direction: 'front', secondaryAreas: ['rear bumper'] }, rules)).toEqual([]);
  });

  it('opposite-side damage gets its own finding (N/S vs O/S confusion) and is not double-reported', () => {
    const r = result([zone('front_door_r', 2, 'repair'), zone('rear_door_r', 2, 'repair')]);
    const f = consistencyFindings(r, { direction: 'left' }, rules);
    expect(kinds(f)).toEqual(['opposite_side_damage']);
    expect(f[0]!.message).toMatch(/nearside \(left\) side.*other side of the vehicle.*nearside and offside are easily confused/);
  });

  it('reported area with no damage, when it was photographed', () => {
    const r = result([zone('front_bumper', 2, 'replace')], { photos: [photo('p1', 'front'), photo('p2', 'front_right'), photo('p3', 'right')] });
    const f = consistencyFindings(r, { primaryArea: 'O/S front door' }, rules);
    expect(kinds(f)).toEqual(['reported_area_undamaged']);
    expect(f[0]!.message).toMatch(/\(O\/S front door\)/);
    expect(f[0]!.zoneIds).toEqual(['front_door_r']);
  });

  it('reported area not photographed → ask for photos instead of saying it is undamaged', () => {
    const r = result([zone('front_bumper', 2, 'replace')], { photos: [photo('p1', 'front')] });
    const f = consistencyFindings(r, { primaryArea: 'rear' }, rules);
    expect(kinds(f)).toEqual(['reported_area_not_photographed']);
    expect(f[0]!.message).toMatch(/Further photos/);
  });

  it('speed against severity, both ways', () => {
    const heavy = result([zone('front_panel', 3, 'replace'), zone('front_bumper', 3, 'replace')]);
    const slow = consistencyFindings(heavy, { speedMph: 5, direction: 'front' }, rules);
    expect(kinds(slow)).toEqual(['low_speed_heavy_damage']);
    expect(slow[0]!.message).toMatch(/5 mph.*speeds are often hard for those involved to judge/);
    const light = result([zone('rear_bumper', 1, 'repair')]);
    const fast = consistencyFindings(light, { speedMph: 40, direction: 'rear' }, rules);
    expect(kinds(fast)).toEqual(['high_speed_light_damage']);
    expect(fast[0]!.message).toMatch(/40 mph.*hidden-damage checks/);
    expect(consistencyFindings(light, { speedMph: 25 }, rules)).toEqual([]);
  });

  it('deployment checks: light damage, reported but not seen, seen but not reported', () => {
    const light = result([zone('front_bumper', 1, 'repair')], { deploymentVisible: true });
    expect(kinds(consistencyFindings(light, {}, rules))).toEqual(['deployment_with_light_damage']);
    const notSeen = consistencyFindings(result([zone('front_bumper', 3, 'replace')]), { airbagsDeployed: true }, rules);
    expect(kinds(notSeen)).toEqual(['deployment_reported_not_seen']);
    const notReported = consistencyFindings(result([zone('front_bumper', 3, 'replace'), zone('airbags', 3, 'replace', { damageTypes: ['deployed'] })]), { airbagsDeployed: false }, rules);
    expect(kinds(notReported)).toEqual(['deployment_seen_not_reported']);
    expect(notReported[0]!.zoneIds).toEqual(['airbags']);
  });

  it('possible earlier damage and poor photos', () => {
    const r = result([zone('front_bumper', 2, 'replace'), zone('sill_l', 1, 'repair', { preExistingSuspect: true })], {
      photos: [photo('p1', 'front', { qualityIssues: ['blurred', 'too_dark'] }), photo('p2', 'left', { usable: false })]
    });
    const f = consistencyFindings(r, {}, rules);
    expect(kinds(f)).toEqual(['pre_existing_suspected', 'unusable_photos']);
    expect(f[0]!.message).toMatch(/Sill \(N\/S, left\).*not claimed/);
    expect(f[1]!.message).toMatch(/^2 photo\(s\).*p1: blurred \/ out of focus, too dark; p2: not usable/);
  });

  it('every message produced in a busy scenario is neutral and names the engineer or asks for photos', () => {
    const r = result([zone('rear_bumper', 3, 'replace'), zone('front_door_l', 2, 'repair', { preExistingSuspect: true }), zone('roof', 2, 'repair')], {
      deploymentVisible: true,
      photos: [photo('p1', 'rear', { qualityIssues: ['glare_or_reflection'] })]
    });
    const f = consistencyFindings(r, { direction: 'front_right', primaryArea: 'front', speedMph: 5, airbagsDeployed: false }, rules);
    expect(f.length).toBeGreaterThan(3);
    for (const x of f) {
      expect(isNeutral(x.message), x.message).toBe(true);
      expect(x.message).toMatch(/engineer|photos/i);
      expect(x.message).not.toMatch(/\{\w+\}/);
    }
  });
});
