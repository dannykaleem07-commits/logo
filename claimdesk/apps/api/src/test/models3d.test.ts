/**
 * Exact (licensed) 3D models: upload validation with good and bad files generated here (GLB, .gltf with data URIs,
 * zipped .gltf + .bin + texture), limits, refusals (external URIs, scripts, compression, fake images, glTF 1.0,
 * truncated files), roles and licence confirmation, storage under DATA_DIR, the name → zone dictionary, the frame /
 * position fallback, tag persistence, thumbnails, matching a vehicle and delete. No real model file is used.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import {
  MODEL_ZONE_IDS,
  autoMapZones,
  classifyMaterials,
  detectFrame,
  isPaintMaterialName,
  models3dLimits,
  parseGlb,
  scanParts,
  tokenizePartName,
  zoneForPartName,
  type ModelBodyType,
} from '../services/models3d.js';

// ---------------------------------------------------------------------------
// Synthetic glTF builder: one box per part
// ---------------------------------------------------------------------------

interface BoxPart {
  name: string;
  /** Centre [x, y, z] in glTF axes (+Y up). */
  at: [number, number, number];
  size: [number, number, number];
  material?: string;
  meshName?: string;
  parent?: string;
}

interface BuildOpts {
  parts: BoxPart[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  extras?: unknown;
  version?: string;
  image?: { bytes: Uint8Array; mimeType: string };
}

const PNG_1PX = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9ngAAAABJRU5ErkJggg==', 'base64'));

/** JSON + one binary buffer (positions + indices for every box, then the optional image). */
function buildGltf(opts: BuildOpts): { json: Record<string, any>; bin: Uint8Array } {
  const chunks: Buffer[] = [];
  let offset = 0;
  const bufferViews: any[] = [];
  const accessors: any[] = [];
  const meshes: any[] = [];
  const nodes: any[] = [];
  const materials: any[] = [];
  const matIndex = new Map<string, number>();
  const push = (b: Buffer): number => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      offset += pad;
    }
    const at = offset;
    chunks.push(b);
    offset += b.length;
    return at;
  };
  const parentIdx = new Map<string, number>();
  const rootNodes: number[] = [];
  for (const p of opts.parts) {
    if (p.parent && !parentIdx.has(p.parent)) {
      parentIdx.set(p.parent, nodes.length);
      rootNodes.push(nodes.length);
      nodes.push({ name: p.parent, children: [] });
    }
  }
  for (const p of opts.parts) {
    const [hx, hy, hz] = p.size.map((s) => s / 2) as [number, number, number];
    const pos = new Float32Array([-hx, -hy, -hz, hx, -hy, -hz, hx, hy, -hz, -hx, hy, -hz, -hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz]);
    const idx = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
    const pAt = push(Buffer.from(pos.buffer));
    bufferViews.push({ buffer: 0, byteOffset: pAt, byteLength: pos.byteLength, target: 34962 });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: 8, type: 'VEC3', min: [-hx, -hy, -hz], max: [hx, hy, hz] });
    const posAcc = accessors.length - 1;
    const iAt = push(Buffer.from(idx.buffer));
    bufferViews.push({ buffer: 0, byteOffset: iAt, byteLength: idx.byteLength, target: 34963 });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5123, count: 36, type: 'SCALAR' });
    const prim: any = { attributes: { POSITION: posAcc }, indices: accessors.length - 1 };
    if (p.material) {
      if (!matIndex.has(p.material)) {
        matIndex.set(p.material, materials.length);
        materials.push({ name: p.material, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1] } });
      }
      prim.material = matIndex.get(p.material);
    }
    meshes.push({ name: p.meshName ?? `${p.name}_mesh`, primitives: [prim] });
    const node = { name: p.name, mesh: meshes.length - 1, translation: p.at };
    const ni = nodes.length;
    nodes.push(node);
    if (p.parent) nodes[parentIdx.get(p.parent)!].children.push(ni);
    else rootNodes.push(ni);
  }
  const json: Record<string, any> = {
    asset: { version: opts.version ?? '2.0', generator: 'claimdesk-test' },
    scene: 0,
    scenes: [{ nodes: rootNodes }],
    nodes,
    meshes,
    accessors,
    bufferViews,
  };
  if (materials.length) json.materials = materials;
  if (opts.image) {
    const at = push(Buffer.from(opts.image.bytes));
    bufferViews.push({ buffer: 0, byteOffset: at, byteLength: opts.image.bytes.length });
    json.images = [{ bufferView: bufferViews.length - 1, mimeType: opts.image.mimeType }];
    json.textures = [{ source: 0 }];
  }
  if (opts.extensionsUsed) json.extensionsUsed = opts.extensionsUsed;
  if (opts.extensionsRequired) json.extensionsRequired = opts.extensionsRequired;
  if (opts.extras !== undefined) json.extras = opts.extras;
  const bin = Buffer.concat(chunks);
  json.buffers = [{ byteLength: bin.length }];
  return { json, bin: new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength) };
}

function glb(json: Record<string, any>, bin?: Uint8Array): Uint8Array {
  const j = Buffer.from(JSON.stringify(json));
  const jp = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const bp = bin ? Buffer.concat([Buffer.from(bin), Buffer.alloc((4 - (bin.length % 4)) % 4)]) : undefined;
  const total = 12 + 8 + jp.length + (bp ? 8 + bp.length : 0);
  const h = Buffer.alloc(12);
  h.writeUInt32LE(0x46546c67, 0);
  h.writeUInt32LE(2, 4);
  h.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jp.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const parts = [h, jh, jp];
  if (bp) {
    const bh = Buffer.alloc(8);
    bh.writeUInt32LE(bp.length, 0);
    bh.writeUInt32LE(0x004e4942, 4);
    parts.push(bh, bp);
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** A small hatchback facing +Z (the glTF convention): +X is the car's left. */
const CAR: BoxPart[] = [
  { name: 'Body_Shell', at: [0, 0.75, 0], size: [1.7, 0.9, 4.0], material: 'CarPaint' },
  { name: 'Bumper_Front', at: [0, 0.4, 2.0], size: [1.7, 0.4, 0.2], material: 'CarPaint' },
  { name: 'bumper_rear', at: [0, 0.4, -2.0], size: [1.7, 0.4, 0.2], material: 'CarPaint' },
  { name: 'Door_FL', at: [0.85, 0.75, 0.4], size: [0.1, 0.8, 1.0], material: 'CarPaint' },
  { name: 'Door_FR', at: [-0.85, 0.75, 0.4], size: [0.1, 0.8, 1.0], material: 'CarPaint' },
  { name: 'Hood', at: [0, 0.95, 1.4], size: [1.5, 0.05, 1.0], material: 'CarPaint' },
  { name: 'Headlight_L', at: [0.6, 0.7, 1.95], size: [0.3, 0.15, 0.1], material: 'Lens' },
  { name: 'Headlight_R', at: [-0.6, 0.7, 1.95], size: [0.3, 0.15, 0.1], material: 'Lens' },
  { name: 'Wheel_FL', at: [0.75, 0.32, 1.3], size: [0.22, 0.64, 0.64], material: 'Tyre' },
  { name: 'Wheel_RR', at: [-0.75, 0.32, -1.3], size: [0.22, 0.64, 0.64], material: 'Tyre' },
  { name: 'Plate_Rear', at: [0, 0.5, -2.1], size: [0.52, 0.11, 0.01], material: 'LicensePlate' },
  { name: 'Object_17', at: [0.86, 0.35, 0], size: [0.05, 0.12, 2.0], material: 'CarPaint' },
];

function multipart(fields: Record<string, string>, file?: { name: string; bytes: Uint8Array; field?: string }): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----claimdesk${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'file'}"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(Buffer.from(file.bytes));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const FIESTA = { makeSlug: 'ford', modelSlug: 'fiesta', generationId: 'ford-fiesta-mk7-2008-2017', licenceConfirmed: 'true', licenceNote: 'Test licence ref 123' };
const BOSS = { 'x-user-id': 'boss' };
const CLERK = { 'x-user-id': 'clerk' };

type ErrorBody = { error: { code: string; message: string } };
type View = {
  id: string;
  title: string;
  bytes: number;
  sourceFormat: string;
  assignment: { make: string; model: string; generationId?: string; years?: { from: number; to: number | null }; bodyType?: string };
  stats: { triangles: number; parts: number };
  parts: Array<{ key: string; name: string }>;
  autoZones: Record<string, { zone: string | null; source: string; rule: string }>;
  tags: Record<string, string | null>;
  zones: Record<string, string>;
  paintMaterials: number[];
  plateParts: Array<{ key: string; position: string }>;
  materials: Array<{ index: number; name: string; role: string }>;
  frame: { forward: string; mirror: boolean };
  fileUrl: string;
  thumbnail: boolean;
  active: boolean;
};

let t: TestApp;
const savedEnv = { ...process.env };

/** A fresh app per test (only the describes that call the API use it). */
function withApp(): void {
  beforeEach(async () => {
    t = await createTestApp('2026-10-05T09:00:00.000Z');
    t.ctx.repos.createUser(t.ctx.db, { id: 'boss', name: 'Boss Admin', email: 'boss@ccguk.test', role: 'admin' });
    t.ctx.repos.createUser(t.ctx.db, { id: 'clerk', name: 'Clerk Handler', email: 'clerk@ccguk.test', role: 'handler' });
  });
  afterEach(async () => {
    for (const k of ['MODELS3D_MAX_TRIANGLES', 'MODELS3D_MAX_MB']) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await t.close();
  });
}

async function upload(file: { name: string; bytes: Uint8Array }, fields: Record<string, string> = FIESTA, headers: Record<string, string> = BOSS) {
  const mp = multipart(fields, file);
  const res = await t.app.inject({ method: 'POST', url: '/api/models3d', payload: mp.payload, headers: { ...mp.headers, ...headers } });
  return { status: res.statusCode, body: JSON.parse(res.body || 'null') as any };
}

const partKey = (v: View, name: string): string => v.parts.find((p) => p.name === name)!.key;

// ---------------------------------------------------------------------------

describe('upload validation', () => {
  withApp();

  it('stores a good .glb under DATA_DIR/models3d/<id>/model.glb, maps zones and audits the upload', async () => {
    const { json, bin } = buildGltf({ parts: CAR });
    const res = await upload({ name: 'fiesta-mk7.glb', bytes: glb(json, bin) });
    expect(res.status).toBe(201);
    const v = res.body as View;
    expect(v.sourceFormat).toBe('glb');
    expect(v.assignment).toMatchObject({ make: 'Ford', model: 'Fiesta', generationId: 'ford-fiesta-mk7-2008-2017', years: { from: 2008, to: 2017 }, bodyType: 'hatchback' });
    expect(v.stats).toMatchObject({ triangles: CAR.length * 12, parts: CAR.length });
    const file = path.join(t.ctx.config.dataDir, 'models3d', v.id, 'model.glb');
    expect(existsSync(file)).toBe(true);
    expect(existsSync(path.join(t.ctx.config.dataDir, 'models3d', v.id, 'record.json'))).toBe(true);
    // never inside the repository
    expect(file.startsWith(path.resolve(fileURLToPath(import.meta.url), '../../../../..'))).toBe(false);

    expect(v.zones[partKey(v, 'Bumper_Front')]).toBe('front_bumper');
    expect(v.zones[partKey(v, 'bumper_rear')]).toBe('rear_bumper');
    expect(v.zones[partKey(v, 'Door_FL')]).toBe('front_door_l');
    expect(v.zones[partKey(v, 'Door_FR')]).toBe('front_door_r');
    expect(v.zones[partKey(v, 'Hood')]).toBe('bonnet');
    expect(v.zones[partKey(v, 'Headlight_L')]).toBe('headlamp_l');
    expect(v.zones[partKey(v, 'Wheel_FL')]).toBe('wheel_fl');
    expect(v.zones[partKey(v, 'Wheel_RR')]).toBe('wheel_rr');
    expect(v.zones[partKey(v, 'Plate_Rear')]).toBe('rear_bumper');
    // the unnamed painted strip low on the left is placed by position (a suggestion)
    expect(v.autoZones[partKey(v, 'Object_17')]).toMatchObject({ zone: 'sill_l', source: 'position' });
    // the whole shell is not one zone
    expect(v.zones[partKey(v, 'Body_Shell')]).toBeUndefined();
    expect(v.frame).toMatchObject({ forward: '+z', mirror: false });
    expect(v.plateParts).toEqual([{ key: partKey(v, 'Plate_Rear'), position: 'rear' }]);
    expect(v.materials.find((m) => m.name === 'CarPaint')?.role).toBe('paint');
    expect(v.paintMaterials).toEqual([v.materials.find((m) => m.name === 'CarPaint')!.index]);

    const fileRes = await t.app.inject({ method: 'GET', url: `/api${v.fileUrl}` });
    expect(fileRes.statusCode).toBe(200);
    expect(fileRes.headers['content-type']).toBe('model/gltf-binary');
    expect(fileRes.rawPayload.subarray(0, 4).toString('latin1')).toBe('glTF');

    const audit = t.ctx.repos.listAudit(t.ctx.db, { entity: 'model3d' }).filter((a) => a.action === 'models3d.upload');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: 'boss', entityId: v.id });

    const list = await t.api<{ items: Array<{ id: string; mappedParts: number }>; notice: string }>('GET', '/models3d');
    expect(list.body.items.map((i) => i.id)).toEqual([v.id]);
    expect(list.body.items[0]!.mappedParts).toBeGreaterThanOrEqual(10);
    expect(list.body.notice).toBe('Use only models you have a licence for. Audatex/Qapter models cannot be imported.');
  });

  it('packs a .gltf with data: URIs into one GLB with no URIs left', async () => {
    const { json, bin } = buildGltf({ parts: CAR.slice(0, 3), image: { bytes: PNG_1PX, mimeType: 'image/png' } });
    json.buffers = [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}` }];
    const res = await upload({ name: 'model.gltf', bytes: strToU8(JSON.stringify(json)) });
    expect(res.status).toBe(201);
    expect(res.body.sourceFormat).toBe('gltf');
    const stored = parseGlb(new Uint8Array(readFileSync(path.join(t.ctx.config.dataDir, 'models3d', res.body.id, 'model.glb'))));
    expect(JSON.stringify(stored.json)).not.toContain('"uri"');
    expect(stored.json.images[0]).toMatchObject({ mimeType: 'image/png' });
  });

  it('accepts a zipped .gltf + .bin + texture and packs it', async () => {
    const { json, bin } = buildGltf({ parts: CAR.slice(0, 4) });
    json.buffers = [{ byteLength: bin.length, uri: 'scene.bin' }];
    json.images = [{ uri: 'textures/paint%20base.png' }];
    json.textures = [{ source: 0 }];
    const zip: Zippable = {
      'fiesta/scene.gltf': strToU8(JSON.stringify(json)),
      'fiesta/scene.bin': bin,
      'fiesta/textures/paint base.png': PNG_1PX,
      'fiesta/LICENSE.txt': strToU8('Licensed to Courtesy Cars Group UK Ltd'),
      '__MACOSX/._scene.gltf': strToU8('junk'),
    };
    const res = await upload({ name: 'fiesta.zip', bytes: zipSync(zip) });
    expect(res.status).toBe(201);
    expect(res.body.sourceFormat).toBe('zip');
    expect(res.body.stats.parts).toBe(4);
  });

  it.each([
    ['an http:// buffer', (j: any) => (j.buffers[0].uri = 'https://cdn.example.com/car.bin'), /outside the file/],
    ['a file: buffer', (j: any) => (j.buffers[0].uri = 'file:///C:/models/car.bin'), /outside the file/],
    ['an absolute path', (j: any) => (j.buffers[0].uri = '/etc/passwd'), /absolute path/],
    ['a path outside the upload', (j: any) => (j.buffers[0].uri = '../../secret.bin'), /outside the upload/],
    ['a remote image', (j: any) => (j.images = [{ uri: '//evil.example/x.png' }]), /outside the file/],
  ])('refuses %s', async (_label, mutate, message) => {
    const { json, bin } = buildGltf({ parts: CAR.slice(0, 2) });
    json.buffers = [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}` }];
    mutate(json);
    const res = await upload({ name: 'model.gltf', bytes: strToU8(JSON.stringify(json)) });
    expect(res.status).toBe(422);
    expect((res.body as ErrorBody).error.code).toBe('MODEL_INVALID');
    expect((res.body as ErrorBody).error.message).toMatch(message);
  });

  it.each([
    ['not glTF at all', () => strToU8('hello, this is a text file'), /\.glb, a \.gltf, or a \.zip/],
    ['a .glb without the header', () => strToU8('XXXXnot really a glb file at all'), /"glTF" header is missing/],
    ['glTF 1.0 JSON', () => strToU8(JSON.stringify({ ...buildGltf({ parts: CAR.slice(0, 1) }).json, asset: { version: '1.0' } })), /only glTF 2\.0/],
    ['a truncated .glb', () => {
      const { json, bin } = buildGltf({ parts: CAR.slice(0, 2) });
      return glb(json, bin).subarray(0, 200);
    }, /truncated or damaged/],
    ['a .glb whose JSON is broken', () => {
      const b = glb({ asset: { version: '2.0' } });
      b[21] = 0x2c; // '{,asset"…' is not JSON
      return b;
    }, /JSON cannot be read/],
  ])('refuses %s', async (label, make, message) => {
    const res = await upload({ name: label.includes('.glb') ? 'x.glb' : 'x.gltf', bytes: make() });
    expect(res.status).toBe(422);
    expect((res.body as ErrorBody).error.message).toMatch(message);
  });

  it.each([
    ['script-like text in extras', { extras: { note: '<script>alert(1)</script>' } }, /script-like/],
    ['a javascript: URL in extras', { extras: { link: 'javascript:alert(1)' } }, /script-like/],
    ['the KHR_interactivity behaviour graph', { extensionsUsed: ['KHR_interactivity'] }, /scripts cannot be imported/],
    ['Draco compression', { extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression'] }, /cannot decode/],
    ['required meshopt compression', { extensionsUsed: ['EXT_meshopt_compression'], extensionsRequired: ['EXT_meshopt_compression'] }, /cannot decode/],
    ['an unknown required extension', { extensionsUsed: ['VENDOR_magic'], extensionsRequired: ['VENDOR_magic'] }, /does not support/],
    ['an embedded "PNG" that is really SVG', { image: { bytes: strToU8('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), mimeType: 'image/png' } }, /not a PNG, JPEG or WebP/],
  ])('refuses %s', async (_label, extra, message) => {
    const { json, bin } = buildGltf({ parts: CAR.slice(0, 2), ...(extra as Partial<BuildOpts>) });
    const res = await upload({ name: 'x.glb', bytes: glb(json, bin) });
    expect(res.status).toBe(422);
    expect((res.body as ErrorBody).error.message).toMatch(message);
  });

  it('refuses zips with programs, missing files, unsafe paths or two models', async () => {
    const { json, bin } = buildGltf({ parts: CAR.slice(0, 2) });
    json.buffers = [{ byteLength: bin.length, uri: 'scene.bin' }];
    const gltf = strToU8(JSON.stringify(json));
    const withJs = await upload({ name: 'a.zip', bytes: zipSync({ 'scene.gltf': gltf, 'scene.bin': bin, 'viewer.js': strToU8('alert(1)') }) });
    expect(withJs.status).toBe(422);
    expect(withJs.body.error.message).toMatch(/no scripts/);
    const missing = await upload({ name: 'b.zip', bytes: zipSync({ 'scene.gltf': gltf }) });
    expect(missing.status).toBe(422);
    expect(missing.body.error.message).toMatch(/needs "scene\.bin"/);
    const two = await upload({ name: 'c.zip', bytes: zipSync({ 'a.gltf': gltf, 'b.gltf': gltf, 'scene.bin': bin }) });
    expect(two.status).toBe(422);
    expect(two.body.error.message).toMatch(/one model per upload/);
    const html = await upload({ name: 'd.zip', bytes: zipSync({ 'scene.gltf': gltf, 'scene.bin': bin, 'index.html': strToU8('<html>') }) });
    expect(html.status).toBe(422);
  });

  it('enforces the triangle and size limits', async () => {
    process.env.MODELS3D_MAX_TRIANGLES = '20';
    const { json, bin } = buildGltf({ parts: CAR.slice(0, 3) });
    const tri = await upload({ name: 'x.glb', bytes: glb(json, bin) });
    expect(tri.status).toBe(422);
    expect(tri.body.error.message).toMatch(/36 triangles; the limit is 20/);
    delete process.env.MODELS3D_MAX_TRIANGLES;

    process.env.MODELS3D_MAX_MB = '1';
    const big = glb({ ...json, extras: { padding: 'x'.repeat(1_200_000) } }, bin);
    const size = await upload({ name: 'big.glb', bytes: big });
    expect(size.status).toBe(413);
    expect(size.body.error.code).toBe('FILE_TOO_LARGE');
    expect(models3dLimits().maxBytes).toBe(1024 * 1024);
    delete process.env.MODELS3D_MAX_MB;
    expect(models3dLimits().maxBytes).toBe(200 * 1024 * 1024);
    // nothing was left behind in staging
    const staging = path.join(t.ctx.config.dataDir, 'models3d', '.staging');
    expect(existsSync(staging) ? (await import('node:fs')).readdirSync(staging) : []).toEqual([]);
  });

  it('is for admin / approver users only, needs the licence box and a catalogue vehicle', async () => {
    const { json, bin } = buildGltf({ parts: CAR.slice(0, 2) });
    const bytes = glb(json, bin);
    const clerk = await upload({ name: 'x.glb', bytes }, FIESTA, CLERK);
    expect(clerk.status).toBe(403);
    expect(clerk.body.error.code).toBe('FORBIDDEN');
    const { licenceConfirmed: _l, ...noLicence } = FIESTA;
    const unticked = await upload({ name: 'x.glb', bytes }, noLicence);
    expect(unticked.status).toBe(400);
    expect(JSON.stringify(unticked.body)).toMatch(/licence/);
    const unknown = await upload({ name: 'x.glb', bytes }, { ...FIESTA, modelSlug: 'not-a-car' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('UNKNOWN_VEHICLE');
    const badGen = await upload({ name: 'x.glb', bytes }, { ...FIESTA, generationId: 'ford-fiesta-mk99' });
    expect(badGen.status).toBe(422);
    expect((await t.api<{ items: unknown[] }>('GET', '/models3d')).body.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('zone mapping dictionary', () => {
  const cases: Array<[string, string | null, ModelBodyType?]> = [
    // English, snake / camel / dotted / glued
    ['bumper_front', 'front_bumper'],
    ['FrontBumper', 'front_bumper'],
    ['frontbumper', 'front_bumper'],
    ['Bumper.R', 'rear_bumper'],
    ['rear_bumper_cover', 'rear_bumper'],
    ['door_fl', 'front_door_l'],
    ['DoorFR', 'front_door_r'],
    ['door_rl', 'rear_door_l'],
    ['Door_RR_Outer', 'rear_door_r'],
    ['door.L.front', 'front_door_l'],
    ['LH_Rear_Door', 'rear_door_l'],
    ['wing_r', 'front_wing_r'],
    ['Fender_LF', 'front_wing_l'],
    ['quarter_panel_lh', 'quarter_panel_l'],
    ['rear_fender_right', 'quarter_panel_r'],
    ['hood', 'bonnet'],
    ['bonnet', 'bonnet'],
    ['trunk', 'boot_lid', 'saloon'],
    ['boot', 'tailgate', 'hatchback'],
    ['tailgate', 'tailgate'],
    ['tailgate', 'load_bed_tailgate', 'pickup'],
    ['decklid', 'boot_lid'],
    ['mirror_l', 'door_mirror_l'],
    ['SideMirror_Right', 'door_mirror_r'],
    ['wing_mirror_os', 'door_mirror_r'],
    ['headlight_r', 'headlamp_r'],
    ['HeadLamp_LH', 'headlamp_l'],
    ['headlightl', 'headlamp_l'],
    ['taillight_left', 'rear_lamp_l'],
    ['Tail_Lamp_RH', 'rear_lamp_r'],
    ['fog_light_fl', 'fog_lamp_l'],
    ['third_brake_light', 'high_level_brake_lamp'],
    ['windshield', 'windscreen'],
    ['rear_window', 'rear_screen'],
    ['door_fl_glass', 'front_door_glass_l'],
    ['Window_Door_RR', 'rear_door_glass_r'],
    ['sunroof_glass', 'sunroof'],
    ['quarter_glass_l', 'quarter_glass_l'],
    ['wheel_fl', 'wheel_fl'],
    ['Tire_RR', 'wheel_rr'],
    ['rim_rear_left', 'wheel_rl'],
    ['BrakeCaliper_FR', 'wheel_fr'],
    ['steering_wheel', 'dashboard'],
    ['grille', 'grille'],
    ['lower_grille', 'front_lower_grille'],
    ['side_skirt_l', 'sill_l'],
    ['rocker_panel_right', 'sill_r'],
    ['roof', 'roof'],
    ['roof_rail_l', 'roof_rail_l'],
    ['spoiler', 'spoiler'],
    ['exhaust_tip', 'exhaust'],
    ['license_plate_front', 'front_bumper'],
    ['A_Pillar_R', 'a_pillar_r'],
    ['seat_driver', 'seats'],
    ['dashboard', 'dashboard'],
    ['sliding_door_r', 'sliding_door_r', 'panel-van'],
    ['rear_door_l', 'rear_load_door_l', 'panel-van'],
    ['soft_top', 'soft_top', 'convertible'],
    // UK nearside / offside
    ['N/S front wing', 'front_wing_l'],
    ['O/S rear door', 'rear_door_r'],
    ['NS_Mirror', 'door_mirror_l'],
    // German / French / Italian / Spanish vendor names
    ['Tuer_VL', 'front_door_l'],
    ['Motorhaube', 'bonnet'],
    ['Stossstange_hinten', 'rear_bumper'],
    ['Stoßstange vorne', 'front_bumper'],
    ['Scheinwerfer_links', 'headlamp_l'],
    ['Kotfluegel_rechts', 'front_wing_r'],
    ['Aussenspiegel_rechts', 'door_mirror_r'],
    ['porte_avant_gauche', 'front_door_l'],
    ['capot', 'bonnet'],
    ['pare_choc_arriere', 'rear_bumper'],
    ['retroviseur_droit', 'door_mirror_r'],
    ['paraurti_anteriore', 'front_bumper'],
    ['portiera_posteriore_sx', 'rear_door_l'],
    ['puerta_delantera_derecha', 'front_door_r'],
    ['faro_izquierdo', 'headlamp_l'],
    // vendor prefixes and LOD noise
    ['SM_Car_Door_FL_LOD0', 'front_door_l'],
    ['geo_bumper_front_001', 'front_bumper'],
    ['polySurface12_hood', 'bonnet'],
    // not damage zones
    ['engine_block', null],
    ['shadow_plane', null],
    ['rearview_mirror', null],
  ];
  it.each(cases)('%s → %s', (name, zone, body) => {
    const hit = zoneForPartName(name, body);
    if (zone === null) expect(hit?.zone ?? null).toBeNull();
    else expect(hit?.zone).toBe(zone);
  });

  it('uses parents and materials for context, and position for a missing side or end', () => {
    expect(zoneForPartName({ own: ['Handle'], parents: ['Door_FL'] })?.zone).toBe('front_door_l');
    expect(zoneForPartName({ own: ['Mesh_004'], material: 'Glass', parents: ['Door_RR'] })?.zone).toBe('rear_door_glass_r');
    expect(zoneForPartName({ own: ['Object_3'], material: 'Headlight_Glass' }, undefined, { pos: 'front', side: 'r', u: 0.9, v: -0.6, h: 0.5, size: [0.1, 0.2, 0.1] })).toMatchObject({ zone: 'headlamp_r', source: 'name+position' });
    // "door" with no side or position: recognised, not guessed
    expect(zoneForPartName('door')).toMatchObject({ zone: null, rule: 'door:incomplete' });
    expect(zoneForPartName('door', undefined, { pos: 'rear', side: 'l', u: -0.3, v: 0.95, h: 0.5, size: [0.25, 0.05, 0.5] })).toMatchObject({ zone: 'rear_door_l', source: 'name+position' });
  });

  it('tokenises vendor names', () => {
    expect(tokenizePartName('SM_Car_Door_FL_LOD0')).toEqual(['door', 'fl']);
    expect(tokenizePartName('HeadLightR')).toEqual(['head', 'light', 'r']);
    expect(tokenizePartName('N/S Front')).toEqual(['n', 's', 'front']);
  });

  it('classifies body-paint materials', () => {
    for (const n of ['CarPaint', 'car_paint_red', 'Body', 'BodyColor', 'Paint_Metallic', 'Exterior_Paint']) expect(isPaintMaterialName(n), n).toBe(true);
    for (const n of ['Glass', 'Chrome', 'Tyre', 'Interior_Leather', 'Black_Plastic', 'Lens', 'LicensePlate', 'Rubber']) expect(isPaintMaterialName(n), n).toBe(false);
  });

  it('keeps MODEL_ZONE_IDS identical to the domain zone taxonomy', () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/domain/src/engineering/panels.ts'), 'utf8');
    const ids: string[] = [];
    for (const m of src.matchAll(/\.\.\.pair\('([a-z_]+)'/g)) ids.push(`${m[1]}_l`, `${m[1]}_r`);
    for (const m of src.matchAll(/one\(\{ id: '([a-z_]+)'/g)) ids.push(m[1]!);
    expect([...MODEL_ZONE_IDS].sort()).toEqual(ids.sort());
  });

  it('detects a car facing -X and maps unnamed panels by position in that frame', () => {
    // rotate the CAR 90°: glTF z → -x, x → z  (nose at -X, left side at -Z)
    const turned: BoxPart[] = CAR.map((p) => ({ ...p, at: [-p.at[2], p.at[1], p.at[0]] as [number, number, number], size: [p.size[2], p.size[1], p.size[0]] as [number, number, number] }));
    const { json } = buildGltf({ parts: turned });
    const limits = models3dLimits();
    const { parts } = scanParts(json, limits);
    const frame = detectFrame(parts, 'hatchback');
    expect(frame).toMatchObject({ forward: '-x', mirror: false });
    const zones = autoMapZones(parts, classifyMaterials(json, parts), 'hatchback', frame);
    const key = (n: string) => parts.find((p) => p.name === n)!.key;
    expect(zones[key('Object_17')]?.zone).toBe('sill_l');
    expect(zones[key('Door_FL')]?.zone).toBe('front_door_l');
  });
});

// ---------------------------------------------------------------------------

describe('tags, edits, thumbnails, matching and delete', () => {
  withApp();

  async function seeded(): Promise<View> {
    const { json, bin } = buildGltf({ parts: CAR });
    const res = await upload({ name: 'fiesta.glb', bytes: glb(json, bin) });
    expect(res.status).toBe(201);
    return res.body as View;
  }

  it('saves manual tags with the model, and they win over the automatic map', async () => {
    const v = await seeded();
    const shell = partKey(v, 'Body_Shell');
    const strip = partKey(v, 'Object_17');
    const hood = partKey(v, 'Hood');
    const put = await t.api<View>('PUT', `/models3d/${v.id}/tags`, { tags: { [shell]: 'roof', [strip]: null, [hood]: 'bonnet' } }, BOSS);
    expect(put.status).toBe(200);
    expect(put.body.zones[shell]).toBe('roof');
    expect(put.body.zones[strip]).toBeUndefined(); // tagged "not a damage part"
    expect(put.body.tags).toEqual({ [shell]: 'roof', [strip]: null, [hood]: 'bonnet' });

    // persisted on disk with the model
    const onDisk = JSON.parse(readFileSync(path.join(t.ctx.config.dataDir, 'models3d', v.id, 'record.json'), 'utf8'));
    expect(onDisk.tags).toEqual({ [shell]: 'roof', [strip]: null, [hood]: 'bonnet' });
    const again = await t.api<View>('GET', `/models3d/${v.id}`);
    expect(again.body.zones[shell]).toBe('roof');

    // clear one tag → back to the automatic zone
    const cleared = await t.api<View>('PUT', `/models3d/${v.id}/tags`, { tags: {}, clear: [strip] }, BOSS);
    expect(cleared.body.zones[strip]).toBe('sill_l');
    expect(cleared.body.tags[strip]).toBeUndefined();

    // refusals
    expect((await t.api<ErrorBody>('PUT', `/models3d/${v.id}/tags`, { tags: { [shell]: 'flux_capacitor' } }, BOSS)).status).toBe(400);
    expect((await t.api<ErrorBody>('PUT', `/models3d/${v.id}/tags`, { tags: { n999p0: 'roof' } }, BOSS)).status).toBe(400);
    expect((await t.api<ErrorBody>('PUT', `/models3d/${v.id}/tags`, { tags: { [shell]: 'roof' } }, CLERK)).status).toBe(403);

    // replace swaps the whole set
    const replaced = await t.api<View>('PUT', `/models3d/${v.id}/tags`, { tags: { [hood]: 'front_panel' }, replace: true }, BOSS);
    expect(replaced.body.tags).toEqual({ [hood]: 'front_panel' });

    const audit = t.ctx.repos.listAudit(t.ctx.db, {}).filter((a) => a.action === 'models3d.tags');
    expect(audit.length).toBe(3);
  });

  it('edits title, frame, paint materials and plates (manager only) and re-maps on a new frame', async () => {
    const v = await seeded();
    const res = await t.api<View>('PATCH', `/models3d/${v.id}`, { title: 'Fiesta Mk7 5dr (licensed)', frame: { forward: '+z', mirror: true }, paintMaterials: [], plateParts: [{ key: partKey(v, 'Plate_Rear'), position: 'rear' }] }, BOSS);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Fiesta Mk7 5dr (licensed)');
    expect(res.body.frame).toMatchObject({ forward: '+z', mirror: true, source: 'owner' });
    expect(res.body.paintMaterials).toEqual([]);
    // mirrored frame: the unnamed strip on +X is now on the right
    expect(res.body.autoZones[partKey(v, 'Object_17')]?.zone).toBe('sill_r');
    // named parts keep the side their name gives
    expect(res.body.zones[partKey(v, 'Door_FL')]).toBe('front_door_l');
    expect((await t.api('PATCH', `/models3d/${v.id}`, { title: 'x' }, CLERK)).status).toBe(403);
    expect((await t.api('PATCH', `/models3d/${v.id}`, { plateParts: [{ key: 'n999p0', position: 'rear' }] }, BOSS)).status).toBe(400);
  });

  it('stores a PNG thumbnail and refuses anything else', async () => {
    const v = await seeded();
    const ok = await t.api<{ thumbnailUrl: string }>('PUT', `/models3d/${v.id}/thumbnail`, { dataUrl: `data:image/png;base64,${Buffer.from(PNG_1PX).toString('base64')}` }, BOSS);
    expect(ok.status).toBe(200);
    const img = await t.app.inject({ method: 'GET', url: `/api${ok.body.thumbnailUrl}` });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    const fake = await t.api<ErrorBody>('PUT', `/models3d/${v.id}/thumbnail`, { dataUrl: `data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}` }, BOSS);
    expect(fake.status).toBe(400);
  });

  it('matches a vehicle by catalogue generation, by year, or by make/model text', async () => {
    const v = await seeded();
    const byGen = await t.api<{ model: View | null; matchedOn: string }>('GET', '/models3d/match?makeSlug=ford&modelSlug=fiesta&generationId=ford-fiesta-mk7-2008-2017&bodyType=hatchback');
    expect(byGen.body.model?.id).toBe(v.id);
    expect(byGen.body.matchedOn).toBe('generation+body');
    expect(byGen.body.model?.zones).toBeTruthy();
    const otherGen = await t.api<{ model: View | null }>('GET', '/models3d/match?makeSlug=ford&modelSlug=fiesta&generationId=ford-fiesta-mk8-2017-2023');
    expect(otherGen.body.model).toBeNull();
    const byYear = await t.api<{ model: View | null; matchedOn: string }>('GET', '/models3d/match?make=FORD&model=FIESTA%20ZETEC&year=2014');
    expect(byYear.body.model?.id).toBe(v.id);
    expect(byYear.body.matchedOn).toBe('year');
    const wrongYear = await t.api<{ model: View | null }>('GET', '/models3d/match?make=FORD&model=FIESTA&year=2020');
    expect(wrongYear.body.model).toBeNull();
    const otherCar = await t.api<{ model: View | null }>('GET', '/models3d/match?make=VOLKSWAGEN&model=GOLF');
    expect(otherCar.body.model).toBeNull();

    // switched off → not offered
    await t.api('PATCH', `/models3d/${v.id}`, { active: false }, BOSS);
    expect((await t.api<{ model: View | null }>('GET', '/models3d/match?makeSlug=ford&modelSlug=fiesta&generationId=ford-fiesta-mk7-2008-2017')).body.model).toBeNull();
  });

  it('deletes the model and its files (manager only, audited)', async () => {
    const v = await seeded();
    expect((await t.api('DELETE', `/models3d/${v.id}`, undefined, CLERK)).status).toBe(403);
    const del = await t.api('DELETE', `/models3d/${v.id}`, undefined, BOSS);
    expect(del.status).toBe(204);
    expect(existsSync(path.join(t.ctx.config.dataDir, 'models3d', v.id))).toBe(false);
    expect((await t.api('GET', `/models3d/${v.id}`)).status).toBe(404);
    expect((await t.api('GET', '/models3d/../../etc')).status).toBe(404);
    expect(t.ctx.repos.listAudit(t.ctx.db, {}).some((a) => a.action === 'models3d.delete' && a.entityId === v.id)).toBe(true);
  });
});
