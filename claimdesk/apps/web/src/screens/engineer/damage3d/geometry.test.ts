import { describe, expect, it } from 'vitest';
import { buildVehicle, clipXRange, insetConvex, outwardNormal, vehicleModel } from './geometry';
import { projectModel, type ViewName } from './project';
import { VEHICLE_BODY_TYPES, zoneAppliesToBody, zonesForBody } from './zones';

describe('procedural vehicle bodies', () => {
  for (const body of VEHICLE_BODY_TYPES) {
    it(`${body}: every part is finite and every zone exists on the body`, () => {
      const m = buildVehicle(body);
      expect(m.parts.length).toBeGreaterThan(60);
      for (const p of m.parts) {
        const nums = p.type === 'poly' ? p.pts.flat() : p.type === 'beam' ? [...p.a, ...p.b] : [...p.center];
        expect(nums.every(Number.isFinite)).toBe(true);
        if (p.type === 'poly') expect(p.pts.length).toBeGreaterThanOrEqual(3);
        if (p.zone) expect(zoneAppliesToBody(p.zone, body), `${body}: ${p.zone}`).toBe(true);
      }
      // the visible exterior is covered: at least 2/3 of the body's zones have a mesh
      expect(m.zones.size).toBeGreaterThan(zonesForBody(body).length * 0.6);
      for (const id of ['front_bumper', 'rear_bumper', 'bonnet', 'windscreen', 'front_door_l', 'front_door_r', 'wheel_fl', 'wheel_rr', 'headlamp_l', 'rear_lamp_r', 'door_mirror_l', 'sill_r', 'a_pillar_l']) {
        expect(m.zones.has(id), `${body} renders ${id}`).toBe(true);
      }
      // polygons stay inside the vehicle envelope (mirrors stick out a little)
      for (const p of m.parts) if (p.type === 'poly') for (const [x, y, z] of p.pts) {
        expect(Math.abs(x)).toBeLessThanOrEqual(m.length / 2 + 1e-6);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(m.height + 1e-6);
        expect(Math.abs(z)).toBeLessThanOrEqual(m.width / 2 + 1e-6);
      }
    });
  }

  it('builds the body-specific zones', () => {
    expect(buildVehicle('hatchback').zones.has('tailgate')).toBe(true);
    expect(buildVehicle('saloon').zones.has('boot_lid')).toBe(true);
    expect(buildVehicle('panel-van').zones.has('sliding_door_r')).toBe(true);
    expect(buildVehicle('panel-van').zones.has('rear_load_door_l')).toBe(true);
    expect(buildVehicle('pickup').zones.has('load_bed_floor')).toBe(true);
    expect(buildVehicle('convertible').zones.has('soft_top')).toBe(true);
    expect(buildVehicle('suv').zones.has('wheel_arch_trim_l')).toBe(true);
    expect(buildVehicle('estate').zones.has('roof_rail_r')).toBe(true);
    expect(buildVehicle('coupe').zones.has('rear_door_l')).toBe(false);
    expect(buildVehicle('hatchback').zones.has('floor_pan')).toBe(false); // list-only
  });

  it('left zones sit on the left (−z), right zones on the right', () => {
    const m = vehicleModel('hatchback');
    for (const p of m.parts) {
      if (!p.zone || p.type !== 'poly') continue;
      const zMean = p.pts.reduce((a, q) => a + q[2], 0) / p.pts.length;
      if (/_l$/.test(p.zone)) expect(zMean, p.zone).toBeLessThan(0);
      if (/_r$/.test(p.zone)) expect(zMean, p.zone).toBeGreaterThan(0);
    }
    expect(vehicleModel('hatchback')).toBe(m); // cached
  });

  it('orients outward normals', () => {
    const m = vehicleModel('saloon');
    const bonnet = m.parts.find((p) => p.type === 'poly' && p.zone === 'bonnet');
    const door = m.parts.find((p) => p.type === 'poly' && p.zone === 'front_door_r');
    expect(bonnet && bonnet.type === 'poly' && outwardNormal(bonnet)[1]).toBeGreaterThan(0.9);
    expect(door && door.type === 'poly' && outwardNormal(door)[2]).toBeGreaterThan(0.9);
  });

  it('clips and insets polygons', () => {
    const sq: Array<[number, number]> = [[0, 0], [2, 0], [2, 2], [0, 2]];
    const clipped = clipXRange(sq, 0.5, 1.5);
    expect(Math.min(...clipped.map((p) => p[0]))).toBeCloseTo(0.5);
    expect(Math.max(...clipped.map((p) => p[0]))).toBeCloseTo(1.5);
    const inset = insetConvex(sq, 0.25);
    expect(Math.min(...inset.map((p) => p[0]))).toBeCloseTo(0.25);
    expect(Math.max(...inset.map((p) => p[1]))).toBeCloseTo(1.75);
    expect(insetConvex(sq, 5)).toEqual([]);
  });
});

describe('2D projection', () => {
  const views: ViewName[] = ['left', 'right', 'top', 'front', 'rear'];
  for (const body of ['hatchback', 'suv', 'panel-van'] as const) {
    it(`${body}: every view has shapes and the side views show the matching side`, () => {
      const m = vehicleModel(body);
      for (const v of views) {
        const p = projectModel(m, v);
        expect(p.shapes.length).toBeGreaterThan(10);
        expect(p.width).toBeGreaterThan(50);
        expect(p.height).toBeGreaterThan(50);
        for (let i = 1; i < p.shapes.length; i++) expect(p.shapes[i]!.layer).toBeGreaterThanOrEqual(p.shapes[i - 1]!.layer);
      }
      const left = new Set(projectModel(m, 'left').shapes.map((s) => s.zone));
      const right = new Set(projectModel(m, 'right').shapes.map((s) => s.zone));
      expect(left.has('front_door_l') && !left.has('front_door_r')).toBe(true);
      expect(right.has('front_door_r') && !right.has('front_door_l')).toBe(true);
      expect(left.has('wheel_fl') && !left.has('wheel_fr')).toBe(true);
      const top = new Set(projectModel(m, 'top').shapes.map((s) => s.zone));
      expect(top.has('bonnet') && top.has('roof') && top.has('front_bumper')).toBe(true);
      const front = new Set(projectModel(m, 'front').shapes.map((s) => s.zone));
      expect(front.has('headlamp_l') && front.has('grille') && front.has('windscreen')).toBe(true);
      expect(new Set(projectModel(m, 'rear').shapes.map((s) => s.zone)).has('rear_bumper')).toBe(true);
    });
  }
  it('every rendered zone is reachable in at least one 2D view', () => {
    for (const body of VEHICLE_BODY_TYPES) {
      const m = vehicleModel(body);
      const seen = new Set<string>();
      for (const v of views) for (const s of projectModel(m, v).shapes) if (s.zone) seen.add(s.zone);
      for (const z of m.zones) expect(seen.has(z), `${body}: ${z}`).toBe(true);
    }
  });
});
