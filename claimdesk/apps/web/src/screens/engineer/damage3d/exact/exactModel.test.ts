/**
 * Exact-model helpers: the vehicle → match query, part keys read from a real GLTFLoader parse (they must equal the
 * API's `n<node>p<primitive>` keys, including multi-primitive and shared meshes), frame yaw, damage / tagging styles
 * and pending tag edits.
 */
import { describe, expect, it } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Mesh, Object3D } from 'three';
import { damagePartStyle, matchKey, matchQueryFor, partKeyOf, tagPartStyle, tagsBodyFor, yawFor, zonesWithPending, AREA_COLOURS, UNMAPPED_COLOUR, type Associations } from './exactModel';
import { SEVERITY_COLOURS, HOVER_COLOUR } from '../damageModel';

describe('matchQueryFor', () => {
  it('prefers catalogue slugs, then make/model text; carries generation, body and year', () => {
    expect(matchQueryFor({ make: 'FORD', model: 'FIESTA ZETEC', yearOfManufacture: 2014, bodyType: '5 DOOR HATCHBACK' })).toEqual({ make: 'FORD', model: 'FIESTA ZETEC', bodyType: '5 DOOR HATCHBACK', year: 2014 });
    expect(matchQueryFor({ make: 'Ford', model: 'Fiesta', spec: { catalogue: { makeSlug: 'ford', modelSlug: 'fiesta', generationId: 'ford-fiesta-mk7-2008-2017' } } })).toEqual({ makeSlug: 'ford', modelSlug: 'fiesta', generationId: 'ford-fiesta-mk7-2008-2017' });
    // a generation *name* is not an id
    expect(matchQueryFor({ make: 'Ford', model: 'Fiesta', generation: 'Mk7 (2008–2017)' })).toEqual({ make: 'Ford', model: 'Fiesta' });
    expect(matchQueryFor({ make: 'Ford', model: 'Fiesta', generation: 'ford-fiesta-mk7-2008-2017', body: 'hatchback' })).toMatchObject({ generationId: 'ford-fiesta-mk7-2008-2017', bodyType: 'hatchback' });
    expect(matchQueryFor({ model: 'Fiesta' })).toBeNull();
    expect(matchQueryFor(undefined)).toBeNull();
    expect(matchKey(matchQueryFor({ make: 'FORD', model: 'Fiesta' }))).toBe(matchKey(matchQueryFor({ make: 'ford', model: 'FIESTA' })));
  });
});

/** A GLB: node 0 "Door_FL" (1 primitive), node 1 "Bumper" (2 primitives), nodes 2+3 share mesh 0, node 4 is a group. */
function testGlb(): ArrayBuffer {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bin = new Uint8Array(pos.buffer);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1, 4] }],
    nodes: [
      { name: 'Door_FL', mesh: 0 },
      { name: 'Bumper', mesh: 1 },
      { name: 'Wheel_FL', mesh: 0, translation: [1, 0, 0] },
      { name: 'Wheel_FR', mesh: 0, translation: [2, 0, 0] },
      { name: 'Wheels', children: [2, 3] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }, { primitives: [{ attributes: { POSITION: 0 }, material: 0 }, { attributes: { POSITION: 0 }, material: 1 }] }],
    materials: [{ name: 'Paint' }, { name: 'Chrome' }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }],
  };
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jlen = Math.ceil(enc.length / 4) * 4;
  const blen = Math.ceil(bin.length / 4) * 4;
  const total = 12 + 8 + jlen + 8 + blen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jlen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jlen);
  out.set(enc, 20);
  dv.setUint32(20 + jlen, blen, true);
  dv.setUint32(24 + jlen, 0x004e4942, true);
  out.set(bin, 28 + jlen);
  return out.buffer;
}

describe('partKeyOf with GLTFLoader', () => {
  it('names every primitive n<node>p<primitive>, like the API', async () => {
    const gltf = await new GLTFLoader().parseAsync(testGlb(), '');
    const assoc = gltf.parser.associations as unknown as Associations;
    const keys: Record<string, string> = {};
    gltf.scene.traverse((o: Object3D) => {
      if (!(o as Mesh).isMesh) return;
      const k = partKeyOf(o as unknown as Parameters<typeof partKeyOf>[0], assoc);
      const owner = o.userData.name ?? o.parent?.userData.name ?? o.name;
      keys[`${owner}:${k}`] = k ?? '';
    });
    expect(Object.values(keys).sort()).toEqual(['n0p0', 'n1p0', 'n1p1', 'n2p0', 'n3p0']);
    expect(keys['Door_FL:n0p0']).toBe('n0p0');
    expect(keys['Wheel_FR:n3p0']).toBe('n3p0');
  });
  it('returns null for objects that are not glTF primitives', () => {
    const assoc: Associations = new Map();
    expect(partKeyOf({ parent: null }, assoc)).toBeNull();
  });
});

describe('frame and styles', () => {
  it('turns each forward axis to +X', () => {
    expect(yawFor('+x')).toBe(0);
    expect(yawFor('+z')).toBeCloseTo(Math.PI / 2);
    expect(yawFor('-z')).toBeCloseTo(-Math.PI / 2);
    expect(yawFor('-x')).toBeCloseTo(Math.PI);
  });
  it('damage style: severity colour, accent on hover / selection, nothing for unzoned parts', () => {
    const damage = { front_bumper: { severity: 3 as const, source: 'user' as const } };
    expect(damagePartStyle('front_bumper', damage, null, null)).toMatchObject({ colour: SEVERITY_COLOURS[3] });
    expect(damagePartStyle('bonnet', damage, 'bonnet', null)).toMatchObject({ emissive: HOVER_COLOUR });
    expect(damagePartStyle('bonnet', damage, null, null)).toBeNull();
    expect(damagePartStyle(undefined, damage, null, null)).toBeNull();
  });
  it('tagging style: area colour, unmapped warning, selection accent', () => {
    expect(tagPartStyle('front_door_l', { selected: false, hovered: false, showUnmapped: true })).toMatchObject({ colour: AREA_COLOURS.side });
    expect(tagPartStyle(null, { selected: false, hovered: false, showUnmapped: true })).toMatchObject({ colour: UNMAPPED_COLOUR });
    expect(tagPartStyle(null, { selected: true, hovered: false, showUnmapped: false })).toMatchObject({ emissive: HOVER_COLOUR });
  });
});

describe('pending tag edits', () => {
  const view = {
    parts: [
      { key: 'n0p0', node: 0, primitive: 0, name: 'Door_FL', parents: [], triangles: 12 },
      { key: 'n1p0', node: 1, primitive: 0, name: 'Object_1', parents: [], triangles: 12 },
      { key: 'n2p0', node: 2, primitive: 0, name: 'Shell', parents: [], triangles: 12 },
    ],
    autoZones: { n0p0: { zone: 'front_door_l', source: 'name' as const, confidence: 0.95, rule: 'door' }, n1p0: { zone: 'sill_l', source: 'position' as const, confidence: 0.35, rule: 'position' } },
    tags: { n2p0: 'roof' } as Record<string, string | null>,
  };
  it('applies tags over automatic zones, null removes, auto restores', () => {
    expect(zonesWithPending(view, {})).toEqual({ n0p0: 'front_door_l', n1p0: 'sill_l', n2p0: 'roof' });
    expect(zonesWithPending(view, { n1p0: null, n0p0: 'rear_door_l', n2p0: 'auto' })).toEqual({ n0p0: 'rear_door_l' });
  });
  it('builds the PUT body', () => {
    expect(tagsBodyFor({ n1p0: null, n0p0: 'rear_door_l', n2p0: 'auto' })).toEqual({ tags: { n1p0: null, n0p0: 'rear_door_l' }, clear: ['n2p0'] });
  });
});
