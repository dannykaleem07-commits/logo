/**
 * Make-and-model accuracy of the parametric body: brand faces, side glass per door count, arch haunches, plates and
 * the triangle budget, for real records from packages/kb/data/vehicle-dimensions (copied here: web cannot import kb).
 */
import { describe, expect, it } from 'vitest';
import { brandFace } from './brand';
import { buildCarMesh, type CarMesh } from './carMesh';
import { resolveSpec, type VehicleDims, type VehicleIdentity } from './spec';
import type { VehicleBodyType } from './zones';

// prettier-ignore
const R: Record<string, { body: VehicleBodyType; dims: VehicleDims; id: VehicleIdentity }> = {
  fiesta:  { body: 'hatchback', id: { make: 'Ford', model: 'Fiesta', doors: 5 }, dims: { lengthMm: 4040, widthMm: 1735, heightMm: 1476, wheelbaseMm: 2493, groundClearanceMm: 140, wheelDiameterIn: 16, profile: 'hatch', bonnetRatio: 0.22, rearOverhangRatio: 0.17, frontOverhangRatio: 0.21, glasshouseHeightRatio: 0.34, roofTaper: 0.2, doors: [3, 5], lampStyle: 'wide-slim', grilleStyle: 'wide' } },
  golf:    { body: 'hatchback', id: { make: 'Volkswagen', model: 'Golf', doors: 5 }, dims: { lengthMm: 4285, widthMm: 1790, heightMm: 1455, wheelbaseMm: 2635, groundClearanceMm: 140, wheelDiameterIn: 17, profile: 'hatch', bonnetRatio: 0.24, glasshouseHeightRatio: 0.35, roofTaper: 0.28, doors: [5], lampStyle: 'wide-slim', grilleStyle: 'wide' } },
  corsa:   { body: 'hatchback', id: { make: 'Vauxhall', model: 'Corsa', doors: 5 }, dims: { lengthMm: 4060, widthMm: 1765, heightMm: 1435, wheelbaseMm: 2540, wheelDiameterIn: 17, profile: 'hatch', glasshouseHeightRatio: 0.36, roofTaper: 0.3, doors: [5], lampStyle: 'wide-slim', grilleStyle: 'wide' } },
  g20:     { body: 'saloon', id: { make: 'BMW', model: '3 Series' }, dims: { lengthMm: 4710, widthMm: 1825, heightMm: 1440, wheelbaseMm: 2850, groundClearanceMm: 135, wheelDiameterIn: 18, profile: 'notchback', bonnetRatio: 0.27, glasshouseHeightRatio: 0.31, roofTaper: 0.3, doors: [4], lampStyle: 'wide-slim', grilleStyle: 'kidney' } },
  qashqai: { body: 'suv', id: { make: 'Nissan', model: 'Qashqai' }, dims: { lengthMm: 4395, widthMm: 1805, heightMm: 1590, wheelbaseMm: 2645, groundClearanceMm: 185, wheelDiameterIn: 18, profile: 'suv-rounded', glasshouseHeightRatio: 0.34, roofTaper: 0.3, doors: [5], roofRails: true, lampStyle: 'wide-slim', grilleStyle: 'large-upright' } },
  evoque:  { body: 'suv', id: { make: 'Land Rover', model: 'Range Rover Evoque' }, dims: { lengthMm: 4370, widthMm: 1905, heightMm: 1650, wheelbaseMm: 2680, wheelDiameterIn: 20, profile: 'suv-coupe', glasshouseHeightRatio: 0.28, roofTaper: 0.55, doors: [5], lampStyle: 'wide-slim', grilleStyle: 'wide' } },
  transit: { body: 'panel-van', id: { make: 'Ford', model: 'Transit Custom', body: 'panel van high roof' }, dims: { lengthMm: 4970, widthMm: 1985, heightMm: 2000, wheelbaseMm: 2935, groundClearanceMm: 165, wheelDiameterIn: 16, profile: 'van-low', glasshouseHeightRatio: 0.3, doors: [4, 5], slidingSideDoor: true, lampStyle: 'wide-slim', grilleStyle: 'wide' } },
  hilux:   { body: 'pickup', id: { make: 'Toyota', model: 'Hilux', doors: 4 }, dims: { lengthMm: 5325, widthMm: 1855, heightMm: 1815, wheelbaseMm: 3085, groundClearanceMm: 215, wheelDiameterIn: 18, profile: 'pickup-double', doors: [2, 4], lampStyle: 'wide-slim', grilleStyle: 'wide' } }
};

const build = (k: keyof typeof R, over: Partial<VehicleIdentity> = {}) => {
  const r = R[k]!;
  const spec = resolveSpec(r.body, r.dims, { ...r.id, ...over });
  return { spec, mesh: buildCarMesh(spec) };
};

function verts(m: CarMesh, keep: (zone: string | null, tone: string) => boolean): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const g of m.groups) {
    if (!keep(g.zone, g.tone)) continue;
    for (let k = 0; k < g.positions.length; k += 3) out.push([g.positions[k]!, g.positions[k + 1]!, g.positions[k + 2]!]);
  }
  return out;
}

describe('brand faces', () => {
  it('maps makes and model families to a design signature', () => {
    expect(brandFace('Ford', 'Fiesta').grille).toBe('trapezoid');
    expect(brandFace('FORD', 'TRANSIT CUSTOM 280').grille).toBe('bars');
    expect(brandFace('BMW', '320d M Sport').grille).toBe('kidney');
    expect(brandFace('Nissan', 'Qashqai').grille).toBe('vmotion');
    expect(brandFace('Vauxhall', 'Corsa').grille).toBe('vizor');
    expect(brandFace('Opel', 'Astra').grille).toBe('vizor');
    expect(brandFace('VW', 'Golf').grille).toBe('slim');
    expect(brandFace('Toyota', 'Hilux').grille).toBe('large');
    expect(brandFace('Fiat', '500').lamp).toBe('round');
    expect(brandFace('Unknown Motors', 'X')).toEqual({});
    expect(brandFace(undefined, undefined)).toEqual({});
  });

  it('the brand fills in only where the data is generic; specific data styles win', () => {
    expect(build('fiesta').spec.grilleStyle).toBe('trapezoid');
    expect(build('qashqai').spec.grilleStyle).toBe('vmotion'); // data "large-upright" is generic
    expect(build('transit').spec.grilleStyle).toBe('bars');
    expect(build('g20').spec.grilleStyle).toBe('kidney');
    const e46 = resolveSpec('saloon', { ...R.g20!.dims, lampStyle: 'round' }, { make: 'BMW', model: '3 Series' });
    expect(e46.lampStyle).toBe('round');
    const fordSlim = resolveSpec('hatchback', { ...R.fiesta!.dims, grilleStyle: 'hexagonal' }, R.fiesta!.id);
    expect(fordSlim.grilleStyle).toBe('hexagonal');
    // no make: the body-type defaults
    expect(resolveSpec('hatchback', R.fiesta!.dims).grilleStyle).toBe('wide');
  });

  it('the cache key changes with the face, so two makes with the same dimensions never share a mesh', () => {
    const a = resolveSpec('hatchback', R.fiesta!.dims, { make: 'Ford', model: 'Fiesta' });
    const b = resolveSpec('hatchback', R.fiesta!.dims, { make: 'Volkswagen', model: 'Polo' });
    expect(a.key).not.toBe(b.key);
  });

  it('draws the signature: chrome V, kidneys with bars, full-width visor', () => {
    const q = build('qashqai').mesh;
    expect(q.groups.some((g) => g.zone === 'grille' && g.tone === 'chrome')).toBe(true);
    const corsa = build('corsa');
    const hw = corsa.spec.W / 2;
    const visor = verts(corsa.mesh, (z, t) => z === 'grille' && t === 'black');
    // the visor runs out under both headlamps
    expect(Math.max(...visor.map((p) => p[2]))).toBeGreaterThan(hw * 0.7);
    expect(Math.min(...visor.map((p) => p[2]))).toBeLessThan(-hw * 0.7);
  });
});

describe('side glass and doors follow the door count', () => {
  const zonesOf = (m: CarMesh) => [...m.zones];
  it('5-door hatch: front and rear door glass both sides; 3-door: no rear doors', () => {
    const five = build('fiesta').mesh;
    for (const z of ['front_door_l', 'front_door_r', 'rear_door_l', 'rear_door_r', 'front_door_glass_l', 'front_door_glass_r', 'rear_door_glass_l', 'rear_door_glass_r', 'tailgate'])
      expect(five.zones.has(z), z).toBe(true);
    const three = build('fiesta', { doors: 3 }).mesh;
    expect(zonesOf(three).filter((z) => z.startsWith('rear_door'))).toEqual([]);
    expect(three.zones.has('front_door_glass_l')).toBe(true);
  });

  it('saloon: four doors and a boot lid; van: sliding doors; double-cab pick-up: rear doors, single cab none', () => {
    const g20 = build('g20').mesh;
    expect(g20.zones.has('rear_door_glass_r') && g20.zones.has('boot_lid') && !g20.zones.has('tailgate')).toBe(true);
    const van = build('transit').mesh;
    expect(van.zones.has('sliding_door_l') && van.zones.has('sliding_door_r')).toBe(true);
    expect(van.zones.has('front_door_glass_l')).toBe(true);
    expect(build('hilux').mesh.zones.has('rear_door_l')).toBe(true);
    expect(build('hilux', { doors: 2 }).mesh.zones.has('rear_door_l')).toBe(false);
  });

  it('side glass sits between the belt and the roof, on its own side', () => {
    for (const k of Object.keys(R) as Array<keyof typeof R>) {
      const { spec, mesh } = build(k);
      const glass = verts(mesh, (z, t) => t === 'glass' && !!z && /_glass_[lr]$/.test(z));
      expect(glass.length, k).toBeGreaterThan(0);
      for (const p of glass) {
        expect(p[1], k).toBeGreaterThan(spec.belt - 0.02);
        expect(p[1], k).toBeLessThan(spec.H + 0.001);
      }
      for (const g of mesh.groups) {
        if (g.tone !== 'glass' || !g.zone || !/_glass_[lr]$/.test(g.zone)) continue;
        let zs = 0;
        for (let i = 2; i < g.positions.length; i += 3) zs += g.positions[i]!;
        expect(Math.sign(zs), `${k} ${g.zone}`).toBe(g.zone.endsWith('_l') ? -1 : 1);
      }
    }
  });

  it('the rearmost side window leans with the C/D-pillar on a hatch (top edge ends further forward)', () => {
    const { mesh } = build('golf');
    const wins = ['quarter_glass_r', 'rear_door_glass_r'].map((zone) => verts(mesh, (z, t) => t === 'glass' && z === zone)).filter((v) => v.length);
    const q = wins.reduce((a, b) => (Math.min(...b.map((p) => p[0])) < Math.min(...a.map((p) => p[0])) ? b : a));
    const maxY = Math.max(...q.map((p) => p[1]));
    const corner = q.reduce((a, b) => (b[0] < a[0] ? b : a)); // rear-bottom corner
    const top = q.filter((p) => p[1] > maxY - 0.03);
    expect(corner[1]).toBeLessThan(maxY - 0.15);
    expect(Math.min(...top.map((p) => p[0]))).toBeGreaterThan(corner[0] + 0.08);
  });
});

describe('body shape', () => {
  it('swells round the wheel arches and stays within the recorded width', () => {
    for (const k of ['fiesta', 'qashqai', 'hilux'] as const) {
      const { spec, mesh } = build(k);
      const y = spec.wheelR + spec.archR + 0.06;
      const side = verts(mesh, (z, t) => (t === 'body' || t === 'black') && !!z && z.endsWith('_r') && !/^(door_mirror|wheel|roof_rail)/.test(z)).filter((p) => Math.abs(p[1] - y) < 0.08);
      const widest = (x: number) => Math.max(...side.filter((p) => Math.abs(p[0] - x) < 0.12).map((p) => p[2]));
      const mid = (spec.axleF + spec.axleR) / 2;
      expect(widest(spec.axleF), k).toBeGreaterThan(widest(mid) + 0.008);
      expect(widest(spec.axleF), k).toBeLessThanOrEqual(spec.W / 2 + 0.003);
    }
  });

  it('plates stand in front of the bumper, never sunk into it', () => {
    for (const k of Object.keys(R) as Array<keyof typeof R>) {
      const { mesh } = build(k);
      for (const p of mesh.plates) {
        const dir = p.kind === 'front' ? 1 : -1;
        expect(p.normal[0] * dir, `${k} ${p.kind} faces outward`).toBeGreaterThan(0.9);
        const near = verts(mesh, (z, t) => t !== 'glass' && !!z && (z.includes('bumper') || z === 'grille' || z === 'tailgate' || z === 'boot_lid' || z.startsWith('rear_load_door')))
          .filter((v) => Math.abs(v[2]) < p.width / 2 && Math.abs(v[1] - p.center[1]) < p.height / 2 && v[0] * dir > 0);
        // signed distance to the plate plane (the plate may tilt a little with the bumper)
        for (const v of near) expect((v[0] - p.center[0]) * p.normal[0] + (v[1] - p.center[1]) * p.normal[1] + (v[2] - p.center[2]) * p.normal[2], `${k} ${p.kind}`).toBeLessThan(0.004);
      }
    }
  });

  it('every real vehicle builds inside the triangle budget', () => {
    for (const k of Object.keys(R) as Array<keyof typeof R>) {
      const { mesh } = build(k);
      expect(mesh.triangles, k).toBeLessThan(60000);
    }
  });
});
