/**
 * Settings → 3D models helpers: file checks, zone pickers per body, the parts table filters and summary, orientation
 * turns, and the upload form data.
 */
import { describe, expect, it } from 'vitest';
import { buildModelUploadForm, LICENCE_NOTICE } from '../../engineer/damage3d/exact/exactApi';
import { assignmentLabel, bodyFromCatalogue, checkModelFile, mappingSummary, partRows, reverseForward, turnForward, zoneOptionGroups } from './models3dSettings';

describe('checkModelFile', () => {
  it('accepts .glb, .gltf and .zip within the limit', () => {
    expect(checkModelFile({ name: 'fiesta.glb', size: 1000 })).toBeNull();
    expect(checkModelFile({ name: 'Fiesta.GLTF', size: 1000 })).toBeNull();
    expect(checkModelFile({ name: 'fiesta.zip', size: 1000 })).toBeNull();
  });
  it('refuses other types, empty and oversize files, and Audatex / Qapter exports', () => {
    expect(checkModelFile(null)).toMatch(/Choose/);
    expect(checkModelFile({ name: 'car.fbx', size: 10 })).toMatch(/\.glb or \.gltf/);
    expect(checkModelFile({ name: 'car.glb', size: 0 })).toMatch(/empty/);
    expect(checkModelFile({ name: 'car.glb', size: 300 * 1024 * 1024 })).toMatch(/limit is 200 MB/);
    expect(checkModelFile({ name: 'qapter-export.glb', size: 10 })).toMatch(/cannot be imported/);
  });
});

describe('zone pickers', () => {
  it('offers only zones that exist on the body', () => {
    const saloon = zoneOptionGroups('saloon').flatMap((g) => g.options.map((o) => o.value));
    expect(saloon).toContain('boot_lid');
    expect(saloon).not.toContain('tailgate');
    const van = zoneOptionGroups('panel-van').flatMap((g) => g.options.map((o) => o.value));
    expect(van).toContain('sliding_door_l');
    const all = zoneOptionGroups().flatMap((g) => g.options.map((o) => o.value));
    expect(all.length).toBe(79);
  });
  it('maps catalogue bodies', () => {
    expect(bodyFromCatalogue('crossover')).toBe('suv');
    expect(bodyFromCatalogue('crew-van')).toBe('panel-van');
    expect(bodyFromCatalogue(undefined)).toBeUndefined();
  });
});

describe('parts table', () => {
  const view = {
    parts: [
      { key: 'n0p0', node: 0, primitive: 0, name: 'Door_FL', materialName: 'Paint', parents: ['Body'], triangles: 12 },
      { key: 'n1p0', node: 1, primitive: 0, name: 'Object_1', parents: [], triangles: 12 },
      { key: 'n2p0', node: 2, primitive: 0, name: 'Shell', parents: [], triangles: 12 },
      { key: 'n3p0', node: 3, primitive: 0, name: 'Bolt', parents: [], triangles: 12 },
    ],
    autoZones: {
      n0p0: { zone: 'front_door_l', source: 'name' as const, confidence: 0.95, rule: 'door' },
      n1p0: { zone: 'sill_l', source: 'position' as const, confidence: 0.35, rule: 'position' },
    },
    tags: { n2p0: 'roof' } as Record<string, string | null>,
  };
  it('labels sources and filters', () => {
    const rows = partRows(view, {});
    expect(rows.map((r) => [r.key, r.source, r.zoneLabel])).toEqual([
      ['n0p0', 'name', 'Front door (N/S, left)'],
      ['n1p0', 'position', 'Sill (N/S, left)'],
      ['n2p0', 'tag', 'Roof panel'],
      ['n3p0', 'none', 'Not mapped'],
    ]);
    expect(rows[0]!.detail).toBe('material Paint · in Body');
    expect(partRows(view, {}, 'unmapped').map((r) => r.key)).toEqual(['n3p0']);
    expect(partRows(view, {}, 'check').map((r) => r.key)).toEqual(['n1p0']);
    expect(partRows(view, {}, 'tagged').map((r) => r.key)).toEqual(['n2p0']);
    expect(partRows(view, {}, 'all', 'door').map((r) => r.key)).toEqual(['n0p0']);
    // a pending "not a damage part" leaves the unmapped filter and shows as tagged
    expect(partRows(view, { n3p0: null }, 'unmapped')).toEqual([]);
    expect(partRows(view, { n3p0: null }).find((r) => r.key === 'n3p0')).toMatchObject({ source: 'not-a-part', pending: true });
  });
  it('summarises', () => {
    expect(mappingSummary(view, {})).toEqual({ parts: 4, mapped: 3, unmapped: 1, check: 1, tagged: 1 });
    expect(mappingSummary(view, { n3p0: 'exhaust', n1p0: 'auto' })).toMatchObject({ mapped: 4, unmapped: 0 });
  });
});

describe('orientation and labels', () => {
  it('turns the nose', () => {
    expect(reverseForward('+z')).toBe('-z');
    expect(reverseForward('-x')).toBe('+x');
    expect([turnForward('+z'), turnForward('-x'), turnForward('-z'), turnForward('+x')]).toEqual(['-x', '-z', '+x', '+z']);
  });
  it('describes an assignment', () => {
    expect(assignmentLabel({ makeSlug: 'ford', make: 'Ford', modelSlug: 'fiesta', model: 'Fiesta', generation: 'Mk7 (2008–2017)', bodyType: 'hatchback' })).toBe('Ford Fiesta · Mk7 (2008–2017) · Hatchback');
    expect(assignmentLabel({ makeSlug: 'ford', make: 'Ford', modelSlug: 'fiesta', model: 'Fiesta' })).toBe('Ford Fiesta · all generations');
  });
});

describe('upload form data', () => {
  it('sends the licence confirmation and puts the file last', () => {
    const fd = buildModelUploadForm({ file: new Blob(['glTF']), fileName: 'fiesta.glb', makeSlug: 'ford', modelSlug: 'fiesta', generationId: 'ford-fiesta-mk7-2008-2017', licenceConfirmed: true, licenceNote: ' ref 1 ' });
    const keys = [...fd.keys()];
    expect(keys).toEqual(['makeSlug', 'modelSlug', 'generationId', 'licenceConfirmed', 'licenceNote', 'file']);
    expect(fd.get('licenceConfirmed')).toBe('true');
    expect(fd.get('licenceNote')).toBe('ref 1');
    expect((fd.get('file') as File).name).toBe('fiesta.glb');
    const unticked = buildModelUploadForm({ file: new Blob(['x']), makeSlug: 'ford', modelSlug: 'fiesta', licenceConfirmed: false });
    expect(unticked.has('licenceConfirmed')).toBe(false);
  });
  it('shows the owner the licence rule word for word', () => {
    expect(LICENCE_NOTICE).toBe('Use only models you have a licence for. Audatex/Qapter models cannot be imported.');
  });
});
