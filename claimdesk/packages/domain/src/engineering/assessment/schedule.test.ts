import { describe, expect, it } from 'vitest';
import { VEHICLE_ZONES } from '../panels.js';
import { GENERIC_HOURS_BY_CATEGORY, GENERIC_HOURS_BY_CHECK, GENERIC_LABOUR_BASIS, genericZoneHours, zoneIsPainted, zoneLabourCategory } from './labour.js';
import { toScheduleLines, type AiScheduleLine } from './schedule.js';
import { loadCheckRules, loadKnockOnRules, result, zone } from './testkit.js';
import { CHECK_KINDS, KNOCK_ON_CATEGORIES } from './types.js';

const knockOn = loadKnockOnRules();
const checks = loadCheckRules();

/** The validation rules of documents' computeSchedule (packages/documents/src/engineer/itemisedSchedule.ts). */
function assertScheduleCompatible(lines: AiScheduleLine[]) {
  for (const l of lines) {
    expect(l.description.trim().length, JSON.stringify(l)).toBeGreaterThan(0);
    expect(['repair', 'replace', 'paint', 'blend', 'R&I', 'check']).toContain(l.operation);
    expect(['body', 'mechanical', 'auxiliary', 'paint']).toContain(l.labourCategory);
    expect(['audatex_estimate', 'owner_library', 'ai_estimate', 'manual']).toContain(l.source);
    expect(Number.isFinite(l.labourHours) && l.labourHours >= 0 && l.labourHours <= 1000).toBe(true);
    expect(Math.round(l.labourHours * 100) / 100).toBe(l.labourHours);
    expect(Number.isInteger(l.partPricePence) && l.partPricePence >= 0).toBe(true);
    expect(Number.isInteger(l.paintMaterialsPence) && l.paintMaterialsPence >= 0).toBe(true);
  }
}

describe('generic labour table', () => {
  it('is clearly labelled as generic, not manufacturer time', () => {
    expect(GENERIC_LABOUR_BASIS).toBe('Generic estimate, not manufacturer time');
  });
  it('has hours for every zone and typical operation, every knock-on category and every check', () => {
    for (const z of VEHICLE_ZONES)
      for (const op of z.operations) {
        const h = genericZoneHours(z.id, op, 2);
        expect(h, `${z.id}/${op}`).not.toBeNull();
        expect(h!).toBeGreaterThanOrEqual(0);
      }
    for (const c of KNOCK_ON_CATEGORIES) expect(GENERIC_HOURS_BY_CATEGORY[c]).toBeDefined();
    for (const c of CHECK_KINDS) expect(GENERIC_HOURS_BY_CHECK[c]).toBeDefined();
  });
  it('repair hours rise with severity; zone overrides apply', () => {
    expect(genericZoneHours('front_door_l', 'repair', 1)).toBeLessThan(genericZoneHours('front_door_l', 'repair', 3)!);
    expect(genericZoneHours('roof', 'replace', 3)).toBe(12);
    expect(genericZoneHours('bonnet', 'replace', 3)).toBe(0.8);
    expect(genericZoneHours('nope', 'replace', 3)).toBeNull();
  });
  it('labour categories and paintable zones', () => {
    expect(zoneLabourCategory('front_wing_l')).toBe('body');
    expect(zoneLabourCategory('headlamp_l')).toBe('auxiliary');
    expect(zoneLabourCategory('front_suspension_r')).toBe('mechanical');
    expect(zoneIsPainted('front_bumper')).toBe(true);
    expect(zoneIsPainted('headlamp_l')).toBe(false);
  });
});

describe('toScheduleLines', () => {
  const vehicle = { bodyType: 'hatchback' as const, features: ['parking_sensors_front', 'adaptive_cruise'] };
  const r = result([zone('front_bumper', 2, 'replace'), zone('front_wing_r', 2, 'repair'), zone('headlamp_r', 2, 'replace'), zone('front_door_r', 1, 'blend')]);

  it('one line per damaged zone plus paint lines, all unverified AI estimates priced at £0', () => {
    const lines = toScheduleLines(r, vehicle);
    expect(lines.map((l) => [l.description, l.operation, l.labourCategory, l.labourHours])).toEqual([
      ['Front bumper — replace', 'replace', 'body', 1.2],
      ['Front bumper — refinish', 'paint', 'paint', 2.2],
      ['Front wing (O/S, right) — repair', 'repair', 'body', 2.5],
      ['Front wing (O/S, right) — refinish', 'paint', 'paint', 2.0],
      ['Headlamp (O/S, right) — replace', 'replace', 'auxiliary', 0.8],
      ['Front door (O/S, right) — blend', 'blend', 'paint', 1.2]
    ]);
    for (const l of lines) {
      expect(l.source).toBe('ai_estimate');
      expect(l.verified).toBe(false);
      expect(l.partPricePence).toBe(0);
      expect(l.paintMaterialsPence).toBe(0);
      expect(l.partNumber).toBeUndefined();
      expect(l.labourBasis).toBe(GENERIC_LABOUR_BASIS);
      expect(l.note).toMatch(/generic estimate, not manufacturer time/);
    }
    expect(lines.filter((l) => l.pricePending).map((l) => l.zoneId)).toEqual(['front_bumper', 'headlamp_r']);
    expect(lines[0]!.note).toMatch(/not priced by AI/);
    assertScheduleCompatible(lines);
  });

  it('adds knock-on parts and checks when the rule sets are supplied, without duplicate calibrations', () => {
    const lines = toScheduleLines(r, vehicle, { knockOn, checks, impact: { direction: 'front_right' } });
    const kinds = new Set(lines.map((l) => l.kind));
    expect(kinds).toEqual(new Set(['damage', 'paint', 'knock_on', 'check']));
    const cal = lines.filter((l) => /radar calibration/i.test(l.description));
    expect(cal).toHaveLength(1);
    expect(cal[0]!.kind).toBe('knock_on');
    expect(cal[0]!.note).toMatch(/manufacturer procedure/);
    const clips = lines.find((l) => l.description.startsWith('Front bumper clips'))!;
    expect(clips.labourHours).toBe(0);
    expect(clips.ruleIds).toEqual(['front_bumper.fixings']);
    const scan = lines.find((l) => l.description.startsWith('Pre- and post-repair diagnostic scan'))!;
    expect(scan.operation).toBe('check');
    expect(scan.note).toMatch(/Required check/);
    assertScheduleCompatible(lines);
  });

  it('respects better sources: covered zones get no AI line', () => {
    const lines = toScheduleLines(r, vehicle, {
      covered: [
        { zoneId: 'front_bumper', source: 'estimate' },
        { zoneId: 'front_wing_r', operation: 'repair', source: 'audatex' }
      ]
    });
    expect(lines.map((l) => l.description)).toEqual(['Front wing (O/S, right) — refinish', 'Headlamp (O/S, right) — replace', 'Front door (O/S, right) — blend']);
  });

  it('notes low confidence and possible earlier damage; can filter by confidence', () => {
    const low = result([zone('bonnet', 1, 'repair', { confidence: 0.3, preExistingSuspect: true })]);
    const [line] = toScheduleLines(low, vehicle);
    expect(line!.note).toMatch(/Low AI confidence \(30%\)/);
    expect(line!.note).toMatch(/Possible earlier damage/);
    expect(toScheduleLines(low, vehicle, { minConfidence: 0.5 })).toEqual([]);
  });

  it('can leave out "if fitted" items and lower-priority checks', () => {
    const unknown = { bodyType: 'hatchback' as const };
    const all = toScheduleLines(result([zone('front_bumper', 2, 'replace')]), unknown, { knockOn, checks });
    const strict = toScheduleLines(result([zone('front_bumper', 2, 'replace')]), unknown, { knockOn, checks, includeIfFitted: false });
    expect(all.some((l) => /Only if fitted/.test(l.note))).toBe(true);
    expect(strict.some((l) => /Only if fitted/.test(l.note))).toBe(false);
    const noAdas = { bodyType: 'hatchback' as const, features: [] };
    const requiredOnly = toScheduleLines(result([zone('front_bumper', 1, 'repair')]), noAdas, { checks, minCheckPriority: 'required' });
    expect(requiredOnly.filter((l) => l.kind === 'check')).toEqual([]);
    const withConsider = toScheduleLines(result([zone('front_bumper', 1, 'repair')]), noAdas, { checks, minCheckPriority: 'consider' });
    expect(withConsider.filter((l) => l.kind === 'check').length).toBeGreaterThan(0);
  });

  it('undamaged zones and an empty result give no lines', () => {
    expect(toScheduleLines(result([zone('front_bumper', 0)]), vehicle, { knockOn, checks })).toEqual([]);
  });

  it('a heavy multi-zone accident produces a full schedule that the documents engine accepts', () => {
    const heavy = result(
      [zone('front_bumper', 3, 'replace'), zone('bonnet', 3, 'replace'), zone('front_panel', 3, 'replace'), zone('chassis_leg_l', 2, 'repair'), zone('headlamp_l', 3, 'replace'), zone('wheel_fl', 2, 'replace'), zone('windscreen', 2, 'replace')],
      { deploymentVisible: true, fluidLeakVisible: true }
    );
    const lines = toScheduleLines(heavy, { bodyType: 'suv', powertrain: 'electric', features: ['lane_keep_assist', 'adaptive_cruise', 'parking_sensors_front', 'tyre_pressure_monitoring', 'matrix_led'] }, { knockOn, checks, impact: { direction: 'front_left', speedMph: 35 } });
    expect(lines.length).toBeGreaterThan(40);
    assertScheduleCompatible(lines);
    const descriptions = lines.map((l) => l.description).join('\n');
    expect(descriptions).toMatch(/Seatbelt pretensioners/);
    expect(descriptions).toMatch(/High-voltage system safety check/);
    expect(descriptions).toMatch(/Windscreen camera calibration/);
    expect(descriptions).toMatch(/Headlamp module coding/);
    // keys are unique, so each description appears once
    expect(new Set(lines.map((l) => `${l.kind}|${l.description}`)).size).toBe(lines.length);
  });
});
