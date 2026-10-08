import { describe, expect, it } from 'vitest';
import { buildCarMesh, type CarMesh } from './carMesh';
import { vehicleModel } from './geometry';
import { resolveSpec, type VehicleDims } from './spec';
import { VEHICLE_BODY_TYPES, zoneAppliesToBody, type VehicleBodyType } from './zones';

// Real-world figures in the shape of packages/kb/data/vehicle-dimensions records (doors as lists, data vocabulary).
const FIESTA: VehicleDims = { lengthMm: 4040, widthMm: 1735, heightMm: 1476, wheelbaseMm: 2493, groundClearanceMm: 140, wheelDiameterIn: 16, profile: 'hatch', bonnetRatio: 0.22, rearOverhangRatio: 0.17, frontOverhangRatio: 0.21, glasshouseHeightRatio: 0.34, roofTaper: 0.2, doors: [3, 5], lampStyle: 'wide-slim', grilleStyle: 'wide' };
const G20: VehicleDims = { lengthMm: 4710, widthMm: 1825, heightMm: 1440, wheelbaseMm: 2850, groundClearanceMm: 135, wheelDiameterIn: 18, profile: 'notchback', bonnetRatio: 0.27, rearOverhangRatio: 0.22, frontOverhangRatio: 0.17, glasshouseHeightRatio: 0.31, roofTaper: 0.3, doors: [4], lampStyle: 'wide-slim', grilleStyle: 'kidney' };
const TRANSIT: VehicleDims = { lengthMm: 4970, widthMm: 1985, heightMm: 2000, wheelbaseMm: 2935, groundClearanceMm: 165, wheelDiameterIn: 16, profile: 'van-low', bonnetRatio: 0.17, rearOverhangRatio: 0.21, frontOverhangRatio: 0.2, glasshouseHeightRatio: 0.3, roofTaper: 0.05, doors: [4, 5], slidingSideDoor: true, lampStyle: 'wide-slim', grilleStyle: 'wide' };
const HILUX: VehicleDims = { lengthMm: 5325, widthMm: 1855, heightMm: 1815, wheelbaseMm: 3085, groundClearanceMm: 215, wheelDiameterIn: 17, profile: 'pickup-double', doors: [2, 4], lampStyle: 'wide-slim', grilleStyle: 'large-upright' };
const QASHQAI: VehicleDims = { lengthMm: 4394, widthMm: 1806, heightMm: 1590, wheelbaseMm: 2646, groundClearanceMm: 185, wheelDiameterIn: 18, profile: 'suv-rounded', doors: [5], roofRails: true, lampStyle: 'wide-slim', grilleStyle: 'large-upright' };

function boundsOf(m: CarMesh, keep: (zone: string | null) => boolean) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const g of m.groups) {
    if (!keep(g.zone)) continue;
    for (let k = 0; k < g.positions.length; k += 3) {
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, g.positions[k + a]!);
        max[a] = Math.max(max[a]!, g.positions[k + a]!);
      }
    }
  }
  return { min, max };
}
const centroid = (m: CarMesh, zone: string) => {
  let x = 0;
  let y = 0;
  let z = 0;
  let n = 0;
  let top = -Infinity;
  for (const g of m.groups) {
    if (g.zone !== zone || g.tone !== 'tyre') continue;
    for (let k = 0; k < g.positions.length; k += 3) {
      x += g.positions[k]!;
      y += g.positions[k + 1]!;
      z += g.positions[k + 2]!;
      top = Math.max(top, g.positions[k + 1]!);
      n++;
    }
  }
  return { x: x / n, y: y / n, z: z / n, top };
};

describe('parametric car mesh: dimensions', () => {
  for (const [name, body, dims] of [
    ['Fiesta Mk8', 'hatchback', FIESTA],
    ['BMW G20', 'saloon', G20],
    ['Transit Custom', 'panel-van', TRANSIT],
    ['Hilux double cab', 'pickup', HILUX],
    ['Qashqai J11', 'suv', QASHQAI]
  ] as Array<[string, VehicleBodyType, VehicleDims]>) {
    it(`${name}: length, width, height, wheelbase and wheel size follow the record`, () => {
      const spec = resolveSpec(body, dims);
      const m = buildCarMesh(spec);
      const body3 = boundsOf(m, (z) => !z?.startsWith('door_mirror') && !z?.startsWith('roof_rail'));
      const L = dims.lengthMm! / 1000;
      const W = dims.widthMm! / 1000;
      const H = dims.heightMm! / 1000;
      expect(body3.max[0]! - body3.min[0]!).toBeGreaterThan(L * 0.985);
      expect(body3.max[0]! - body3.min[0]!).toBeLessThan(L * 1.012);
      expect(body3.max[2]! - body3.min[2]!).toBeGreaterThan(W * 0.97);
      expect(body3.max[2]! - body3.min[2]!).toBeLessThan(W * 1.01);
      const all = boundsOf(m, () => true);
      expect(all.max[1]!).toBeGreaterThan(H * 0.98);
      expect(all.max[1]!).toBeLessThan(H * 1.01);
      expect(all.min[1]!).toBeGreaterThanOrEqual(-1e-6);
      // wheels sit on the ground at the real wheelbase; tyre diameter = rim + two sidewalls
      const fl = centroid(m, 'wheel_fl');
      const rl = centroid(m, 'wheel_rl');
      const fr = centroid(m, 'wheel_fr');
      expect(fl.x - rl.x).toBeCloseTo(dims.wheelbaseMm! / 1000, 2);
      expect(fl.top).toBeCloseTo(2 * spec.wheelR, 2);
      expect(spec.rimR * 2).toBeCloseTo((dims.wheelDiameterIn! * 25.4) / 1000, 3);
      expect(fl.z).toBeLessThan(0);
      expect(fr.z).toBeGreaterThan(0);
      // front overhang
      expect(body3.max[0]! - fl.x).toBeCloseTo(spec.xF - spec.axleF, 1);
    });
  }

  it('stays under the triangle budget for every body type', () => {
    for (const body of VEHICLE_BODY_TYPES) {
      const m = buildCarMesh(resolveSpec(body));
      expect(m.triangles, body).toBeLessThan(60000);
      expect(m.triangles, body).toBeGreaterThan(8000);
    }
  });

  it('emits finite positions and unit normals', () => {
    const m = buildCarMesh(resolveSpec('suv', QASHQAI));
    for (const g of m.groups) {
      expect(g.positions.length % 9).toBe(0);
      expect(g.normals.length).toBe(g.positions.length);
      expect(g.positions.every(Number.isFinite)).toBe(true);
      for (let k = 0; k < g.normals.length; k += 3) {
        const l = Math.hypot(g.normals[k]!, g.normals[k + 1]!, g.normals[k + 2]!);
        expect(Math.abs(l - 1)).toBeLessThan(1e-3);
      }
    }
  });
});

describe('parametric car mesh: zones', () => {
  it('every zone exists on its body, left zones on the left, and the 2D views have the same panels', () => {
    for (const body of VEHICLE_BODY_TYPES) {
      const spec = resolveSpec(body);
      const m = buildCarMesh(spec);
      for (const z of m.zones) expect(zoneAppliesToBody(z, body), `${body}: ${z}`).toBe(true);
      for (const g of m.groups) {
        if (!g.zone || !/_l$/.test(g.zone)) continue;
        let zs = 0;
        for (let k = 2; k < g.positions.length; k += 3) zs += g.positions[k]!;
        expect(zs, `${body}: ${g.zone}`).toBeLessThan(0);
      }
      const flat = vehicleModel(body, spec);
      for (const z of flat.zones) {
        if (/^(a_pillar|b_pillar)/.test(z)) continue;
        expect(m.zones.has(z), `${body}: 2D zone ${z} missing in 3D`).toBe(true);
      }
      for (const id of ['front_bumper', 'rear_bumper', 'bonnet', 'windscreen', 'front_door_l', 'front_door_r', 'front_wing_l', 'sill_r', 'headlamp_l', 'headlamp_r', 'rear_lamp_l', 'grille', 'door_mirror_r', 'wheel_rr', 'a_pillar_l', 'front_door_glass_r']) {
        expect(m.zones.has(id), `${body} has ${id}`).toBe(true);
      }
    }
  });

  it('door shut lines follow the door count', () => {
    const five = buildCarMesh(resolveSpec('hatchback', { ...FIESTA, doors: [3, 5] }, { doors: 5 }));
    const three = buildCarMesh(resolveSpec('hatchback', { ...FIESTA, doors: [3, 5] }, { doors: 3 }));
    expect(five.zones.has('rear_door_l')).toBe(true);
    expect(five.zones.has('rear_door_glass_r')).toBe(true);
    expect(three.zones.has('rear_door_l')).toBe(false);
    expect(three.zones.has('quarter_glass_l')).toBe(true);
    expect(three.spec.doors[0]!.x1 - three.spec.doors[0]!.x0).toBeGreaterThan(five.spec.doors[0]!.x1 - five.spec.doors[0]!.x0);
    expect(five.lines.length).toBeGreaterThan(0);
  });

  it('body-specific panels: boot, tailgate, sliding door, load doors, bed, soft top, rails, arch trims', () => {
    const z = (body: VehicleBodyType, dims?: VehicleDims) => buildCarMesh(resolveSpec(body, dims)).zones;
    expect(z('saloon', G20).has('boot_lid')).toBe(true);
    expect(z('saloon', G20).has('rear_screen')).toBe(true);
    expect(z('hatchback', FIESTA).has('tailgate')).toBe(true);
    const van = z('panel-van', TRANSIT);
    for (const id of ['sliding_door_l', 'sliding_door_r', 'rear_load_door_l', 'rear_load_door_r', 'load_side_panel_r', 'high_level_brake_lamp']) expect(van.has(id), id).toBe(true);
    const pick = z('pickup', HILUX);
    for (const id of ['load_bed_floor', 'load_bed_tailgate', 'load_bed_side_l', 'rear_door_r', 'wheel_arch_trim_l']) expect(pick.has(id), id).toBe(true);
    expect(z('convertible').has('soft_top')).toBe(true);
    expect(z('convertible').has('roof')).toBe(false);
    expect(z('suv', QASHQAI).has('roof_rail_l')).toBe(true);
    expect(z('mpv').has('sliding_door_r')).toBe(true);
  });

  it('high-roof van is taller than the standard roof and keeps a standard cab', () => {
    const low = resolveSpec('panel-van', TRANSIT);
    const high = resolveSpec('panel-van', TRANSIT, { body: 'panel van high roof' });
    expect(high.profile).toBe('van-high-roof');
    expect(high.H).toBeCloseTo(2.29, 2);
    expect(high.highRoof!.lowY).toBeLessThan(high.roofY);
    expect(low.highRoof).toBeUndefined();
  });

  it('places the plates: front facing forward, rear facing back', () => {
    for (const [body, dims] of [['hatchback', FIESTA], ['panel-van', TRANSIT], ['pickup', HILUX]] as Array<[VehicleBodyType, VehicleDims]>) {
      const m = buildCarMesh(resolveSpec(body, dims));
      const front = m.plates.find((p) => p.kind === 'front')!;
      const rear = m.plates.find((p) => p.kind === 'rear')!;
      expect(front.normal[0]).toBeGreaterThan(0.8);
      expect(rear.normal[0]).toBeLessThan(-0.8);
      expect(front.center[0]).toBeGreaterThan(m.spec.xF - 0.25);
      expect(rear.center[0]).toBeLessThan(m.spec.xR + 0.25);
      expect(front.width).toBeCloseTo(0.52);
    }
  });
});
