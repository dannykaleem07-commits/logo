import { describe, expect, it } from 'vitest';
import {
  VEHICLE_BODY_TYPES,
  VEHICLE_ZONES,
  getZone,
  mapZoneToBody,
  mirrorZoneId,
  normaliseBodyType,
  severityFromFinding,
  suggestOperation,
  zoneAppliesToBody,
  zoneForPanelName,
  zonesByArea,
  zonesForBody
} from './panels.js';

describe('vehicle zone taxonomy', () => {
  it('has ~70 unique zones with valid fields', () => {
    expect(VEHICLE_ZONES.length).toBeGreaterThanOrEqual(65);
    expect(VEHICLE_ZONES.length).toBeLessThanOrEqual(85);
    const ids = new Set(VEHICLE_ZONES.map((z) => z.id));
    expect(ids.size).toBe(VEHICLE_ZONES.length);
    for (const z of VEHICLE_ZONES) {
      expect(z.id).toMatch(/^[a-z0-9_]+$/);
      expect(z.label.length).toBeGreaterThan(2);
      expect(z.operations.length).toBeGreaterThan(0);
      if (z.side === 'L') expect(z.id).toMatch(/(_l|_fl|_rl)$/);
      if (z.side === 'R') expect(z.id).toMatch(/(_r|_fr|_rr)$/);
    }
  });

  it('every left zone has a right twin and vice versa', () => {
    for (const z of VEHICLE_ZONES.filter((x) => x.side !== 'centre')) {
      const twin = getZone(mirrorZoneId(z.id));
      expect(twin, z.id).toBeDefined();
      expect(twin!.side).not.toBe(z.side);
      expect(twin!.bodies).toEqual(z.bodies);
    }
    expect(mirrorZoneId('bonnet')).toBe('bonnet');
    expect(mirrorZoneId('wheel_fl')).toBe('wheel_fr');
    expect(mirrorZoneId('wheel_rr')).toBe('wheel_rl');
    expect(mirrorZoneId('front_door_l')).toBe('front_door_r');
  });

  it('filters zones by body', () => {
    const has = (body: (typeof VEHICLE_BODY_TYPES)[number], id: string) => zonesForBody(body).some((z) => z.id === id);
    expect(has('hatchback', 'tailgate')).toBe(true);
    expect(has('hatchback', 'boot_lid')).toBe(false);
    expect(has('saloon', 'boot_lid')).toBe(true);
    expect(has('saloon', 'tailgate')).toBe(false);
    expect(has('coupe', 'rear_door_l')).toBe(false);
    expect(has('panel-van', 'sliding_door_l')).toBe(true);
    expect(has('panel-van', 'rear_load_door_r')).toBe(true);
    expect(has('panel-van', 'quarter_panel_l')).toBe(false);
    expect(has('pickup', 'load_bed_floor')).toBe(true);
    expect(has('pickup', 'load_bed_side_r')).toBe(true);
    expect(has('convertible', 'soft_top')).toBe(true);
    expect(has('convertible', 'roof')).toBe(false);
    expect(has('suv', 'roof_rail_l')).toBe(true);
    for (const b of VEHICLE_BODY_TYPES) {
      expect(zonesForBody(b).length).toBeGreaterThan(45);
      expect(has(b, 'front_bumper') && has(b, 'bonnet') && has(b, 'windscreen') && has(b, 'wheel_rr')).toBe(true);
    }
    expect(zoneAppliesToBody('nope', 'hatchback')).toBe(false);
  });

  it('groups by area in display order', () => {
    const groups = zonesByArea('hatchback');
    expect(groups[0]!.area).toBe('front');
    expect(groups.flatMap((g) => g.zones).length).toBe(zonesForBody('hatchback').length);
  });

  it('maps zones across bodies', () => {
    expect(mapZoneToBody('tailgate', 'saloon')).toBe('boot_lid');
    expect(mapZoneToBody('boot_lid', 'estate')).toBe('tailgate');
    expect(mapZoneToBody('quarter_panel_r', 'panel-van')).toBe('load_side_panel_r');
    expect(mapZoneToBody('quarter_panel_l', 'pickup')).toBe('load_bed_side_l');
    expect(mapZoneToBody('rear_door_l', 'mpv')).toBe('sliding_door_l');
    expect(mapZoneToBody('rear_door_l', 'coupe')).toBeNull();
    expect(mapZoneToBody('roof', 'convertible')).toBe('soft_top');
    expect(mapZoneToBody('bonnet', 'pickup')).toBe('bonnet');
  });

  it('normalises body descriptions', () => {
    expect(normaliseBodyType('5 DOOR HATCHBACK')).toBe('hatchback');
    expect(normaliseBodyType('Saloon')).toBe('saloon');
    expect(normaliseBodyType('ESTATE')).toBe('estate');
    expect(normaliseBodyType('Sports Tourer')).toBe('estate');
    expect(normaliseBodyType('Coupe')).toBe('coupe');
    expect(normaliseBodyType('CONVERTIBLE')).toBe('convertible');
    expect(normaliseBodyType('Cabriolet')).toBe('convertible');
    expect(normaliseBodyType('SUV')).toBe('suv');
    expect(normaliseBodyType('Crossover')).toBe('suv');
    expect(normaliseBodyType('M.P.V.')).toBe('hatchback');
    expect(normaliseBodyType('MPV')).toBe('mpv');
    expect(normaliseBodyType('PANEL VAN')).toBe('panel-van');
    expect(normaliseBodyType('Pick-up')).toBe('pickup');
    expect(normaliseBodyType('Double Cab Pick Up')).toBe('pickup');
    expect(normaliseBodyType('')).toBe('hatchback');
    expect(normaliseBodyType(null)).toBe('hatchback');
  });

  it('matches free-text panel names, UK sides', () => {
    expect(zoneForPanelName('O/S/F wing')).toBe('front_wing_r');
    expect(zoneForPanelName('N/S front door')).toBe('front_door_l');
    expect(zoneForPanelName('NSR door')).toBe('rear_door_l');
    expect(zoneForPanelName('offside rear quarter panel')).toBe('quarter_panel_r');
    expect(zoneForPanelName('N/S rear wing')).toBe('quarter_panel_l');
    expect(zoneForPanelName('Rear bumper cover')).toBe('rear_bumper');
    expect(zoneForPanelName('LH headlamp')).toBe('headlamp_l');
    expect(zoneForPanelName('RH tail lamp')).toBe('rear_lamp_r');
    expect(zoneForPanelName('Windscreen')).toBe('windscreen');
    expect(zoneForPanelName('O/S door mirror glass')).toBe('door_mirror_r');
    expect(zoneForPanelName('N/S/R alloy wheel')).toBe('wheel_rl');
    expect(zoneForPanelName('OSF tyre')).toBe('wheel_fr');
    expect(zoneForPanelName('front parking sensor')).toBe('front_parking_sensors');
    expect(zoneForPanelName('N/S rear door glass')).toBe('rear_door_glass_l');
    expect(zoneForPanelName('tailgate', 'saloon')).toBe('boot_lid');
    expect(zoneForPanelName('O/S rear quarter', 'panel-van')).toBe('load_side_panel_r');
    expect(zoneForPanelName('flux capacitor')).toBeNull();
    expect(zoneForPanelName('')).toBeNull();
  });

  it('severity and operation helpers', () => {
    expect(severityFromFinding('light')).toBe(1);
    expect(severityFromFinding('medium')).toBe(2);
    expect(severityFromFinding('heavy')).toBe(3);
    expect(severityFromFinding('structural')).toBe(3);
    expect(severityFromFinding('??')).toBe(0);
    expect(suggestOperation('front_door_l', 1)).toBe('repair');
    expect(suggestOperation('front_door_l', 3)).toBe('replace');
    expect(suggestOperation('headlamp_r', 1)).toBe('replace');
    expect(suggestOperation('windscreen', 1)).toBe('repair');
    expect(suggestOperation('windscreen', 2)).toBe('replace');
    expect(suggestOperation('grille', 2)).toBe('replace');
    expect(suggestOperation('bonnet', 0)).toBeUndefined();
    for (const z of VEHICLE_ZONES) for (const s of [1, 2, 3] as const) expect(z.operations).toContain(suggestOperation(z, s));
  });
});
