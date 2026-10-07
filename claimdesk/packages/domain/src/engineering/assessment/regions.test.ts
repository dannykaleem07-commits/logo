import { describe, expect, it } from 'vitest';
import { VEHICLE_ZONES } from '../panels.js';
import { fillTokens } from './conditions.js';
import { effectiveDirection, inferImpactDirection, resolveReportedArea, viewRegions, zoneRegions } from './regions.js';
import { result, zone } from './testkit.js';

describe('zoneRegions', () => {
  it('gives every taxonomy zone at least one region', () => {
    for (const z of VEHICLE_ZONES) expect(zoneRegions(z.id).length, z.id).toBeGreaterThan(0);
  });
  it('places corners in two regions and side panels on their side (left = nearside)', () => {
    expect(zoneRegions('front_wing_r')).toEqual(['front', 'right']);
    expect(zoneRegions('quarter_panel_l')).toEqual(['rear', 'left']);
    expect(zoneRegions('front_door_l')).toEqual(['left']);
    expect(zoneRegions('front_bumper')).toEqual(['front']);
    expect(zoneRegions('wheel_rr')).toEqual(['rear', 'right']);
    expect(zoneRegions('roof')).toEqual(['top']);
    expect(zoneRegions('airbags')).toEqual(['interior']);
    expect(zoneRegions('nope')).toEqual([]);
  });
  it('maps photo views', () => {
    expect(viewRegions('front_left')).toEqual(['front', 'left']);
    expect(viewRegions('close_up')).toEqual([]);
  });
});

describe('inferImpactDirection', () => {
  it('front only → front; rear only → rear', () => {
    expect(inferImpactDirection(result([zone('front_bumper', 2, 'repair'), zone('bonnet', 1, 'repair')]))).toBe('front');
    expect(inferImpactDirection(result([zone('rear_bumper', 3, 'replace')]))).toBe('rear');
  });
  it('a corner when the side damage is substantial', () => {
    expect(inferImpactDirection(result([zone('front_bumper', 2, 'repair'), zone('front_wing_r', 3, 'replace'), zone('headlamp_r', 2, 'replace')]))).toBe('front_right');
  });
  it('a side when only side zones are damaged', () => {
    expect(inferImpactDirection(result([zone('front_door_l', 2, 'repair'), zone('rear_door_l', 2, 'repair')]))).toBe('left');
  });
  it('balanced front and rear damage reads as multiple', () => {
    expect(inferImpactDirection(result([zone('front_bumper', 2, 'repair'), zone('rear_bumper', 2, 'repair')]))).toBe('multiple');
  });
  it('roof only → top; nothing damaged → unknown', () => {
    expect(inferImpactDirection(result([zone('roof', 2, 'repair')]))).toBe('top');
    expect(inferImpactDirection(result([zone('front_bumper', 0)]))).toBe('unknown');
  });
  it('the reported direction wins over the inferred one', () => {
    const r = result([zone('rear_bumper', 2, 'repair')]);
    expect(effectiveDirection(r, 'front')).toEqual({ direction: 'front', inferred: false });
    expect(effectiveDirection(r, 'unknown')).toEqual({ direction: 'rear', inferred: true });
    expect(effectiveDirection(r, null)).toEqual({ direction: 'rear', inferred: true });
  });
});

describe('resolveReportedArea', () => {
  it('accepts zone ids, regions, directions and UK free-text panel names', () => {
    expect(resolveReportedArea('front_wing_r')).toEqual({ zoneId: 'front_wing_r', regions: ['front', 'right'] });
    expect(resolveReportedArea('rear')).toEqual({ zoneId: null, regions: ['rear'] });
    expect(resolveReportedArea('front_left')).toEqual({ zoneId: null, regions: ['front', 'left'] });
    expect(resolveReportedArea('O/S/F wing')?.zoneId).toBe('front_wing_r');
    expect(resolveReportedArea('N/S rear door')?.zoneId).toBe('rear_door_l');
    expect(resolveReportedArea('offside')).toEqual({ zoneId: null, regions: ['right'] });
    expect(resolveReportedArea('   ')).toBeNull();
    expect(resolveReportedArea('somewhere')).toBeNull();
  });
});

describe('fillTokens', () => {
  it('fills side and zone tokens and drops them for centre / global triggers', () => {
    expect(fillTokens('Crash box {sideLabel}', 'chassis_leg_l')).toBe('Crash box N/S');
    expect(fillTokens('crash_box_{side}', 'chassis_leg_r')).toBe('crash_box_r');
    expect(fillTokens('Wheel {sideLabel}', 'wheel_fr')).toBe('Wheel O/S');
    expect(fillTokens('Clips — {zoneLabel}', 'front_door_l')).toBe('Clips — Front door (N/S, left)');
    expect(fillTokens('clips_{zone}', 'rear_door_r')).toBe('clips_rear_door_r');
    expect(fillTokens('Washer {sideLabel}', 'front_bumper')).toBe('Washer');
    expect(fillTokens('washer_{side}', null)).toBe('washer');
    expect(fillTokens('Clips — {zoneLabel}', null)).toBe('Clips');
  });
});
