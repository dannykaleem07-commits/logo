import { describe, expect, it } from 'vitest';
import { areaResize, dHash64, hamming, toGray } from './phash.js';
import { findDuplicates, type DupInput } from './duplicates.js';
import { headerKeyOf, pageOfTotal, splitPages, validateSegments, type PageSignal } from './split.js';
import { damageMapFromObservations, distanceKm, gpsOutliers, plateMatches, zonesFromEstimateText } from './photo.js';

/** A synthetic RGBA picture: gradient + rectangles (seeded). */
function picture(w: number, h: number, seed: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      let v = ((x * 255) / w + (y * 64) / h + seed * 37) % 256;
      if (seed % 2 ? x > w / 3 && x < w / 2 && y > h / 4 : y > h / 2 && x < w / 4) v = 255 - v;
      if (seed === 3 && (x + y) % 17 < 8) v = 30;
      px[i] = v;
      px[i + 1] = (v * 0.8) | 0;
      px[i + 2] = (v * 0.6) | 0;
      px[i + 3] = 255;
    }
  return px;
}

/** Nearest-neighbour downscale + coarse quantisation (a resized, re-compressed copy). */
function resizeRgba(px: Uint8Array, w: number, h: number, tw: number, th: number): Uint8Array {
  const out = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y += 1)
    for (let x = 0; x < tw; x += 1) {
      const sx = Math.floor((x * w) / tw);
      const sy = Math.floor((y * h) / th);
      for (let c = 0; c < 4; c += 1) out[(y * tw + x) * 4 + c] = c === 3 ? 255 : Math.min(255, Math.round(px[(sy * w + sx) * 4 + c]! / 8) * 8);
    }
  return out;
}

const hashOf = (px: Uint8Array, w: number, h: number) => dHash64(toGray(px, w, h), w, h);

describe('phash', () => {
  it('identical images → distance 0; resized/re-quantised ≤ 6; different > 20', () => {
    const a = picture(200, 150, 1);
    const ha = hashOf(a, 200, 150);
    expect(ha).toMatch(/^[0-9a-f]{16}$/);
    expect(hamming(ha, hashOf(a, 200, 150))).toBe(0);
    expect(hamming(ha, hashOf(resizeRgba(a, 200, 150, 100, 75), 100, 75))).toBeLessThanOrEqual(6);
    expect(hamming(ha, hashOf(picture(200, 150, 3), 200, 150))).toBeGreaterThan(20);
  });
  it('areaResize averages boxes; hamming refuses mismatched lengths', () => {
    expect([...areaResize(new Uint8Array([0, 100, 200, 100]), 2, 2, 1, 1)]).toEqual([100]);
    expect(hamming('ff', 'ffff')).toBe(Infinity);
    expect(hamming('0f', 'ff')).toBe(4);
  });
});

describe('findDuplicates', () => {
  const f = (fileId: string, position: number, over: Partial<DupInput['files'][number]> = {}): DupInput['files'][number] => ({ fileId, position, sha256: `sha-${fileId}`, textSha256: null, text: null, phash: null, pixels: null, role: 'document', parentFileId: null, ...over });
  const long = Array.from({ length: 120 }, (_, i) => `word${i} ${['alpha', 'beta', 'gamma', 'delta'][i % 4]}`).join(' ');
  it('finds the four link kinds with the right primaries', () => {
    const r = findDuplicates({
      nearMaxDistance: 6,
      shingleMin: 0.9,
      files: [
        f('photo', 1, { sha256: 'S1', phash: 'ffff0000ffff0000', pixels: 30000 }),
        f('zip-entry', 5, { sha256: 'S1', parentFileId: 'zip', phash: 'ffff0000ffff0000', pixels: 30000 }),
        f('small', 3, { phash: 'ffff0000ffff0001', pixels: 7500 }),
        f('letter', 2, { textSha256: 'T1', text: long }),
        f('letter-again', 6, { textSha256: 'T1', text: long }),
        f('letter-edit', 7, { text: `${long} Kind regards.` }),
        f('zip', 4, { role: 'archive', sha256: 'Z' }),
      ],
    });
    const by = Object.fromEntries(r.links.map((l) => [l.fileId, l]));
    expect(by['zip-entry']).toMatchObject({ of: 'photo', kind: 'same_file', similarity: 1 });
    expect(by.small).toMatchObject({ of: 'photo', kind: 'near_photo' });
    expect(by['letter-again']).toMatchObject({ of: 'letter', kind: 'same_text' });
    expect(by['letter-edit']).toMatchObject({ of: 'letter', kind: 'near_text' });
    expect(by.photo).toBeUndefined();
    expect(by.zip).toBeUndefined();
  });
  it('the photo with more pixels is the primary of a near pair', () => {
    const r = findDuplicates({ nearMaxDistance: 6, shingleMin: 0.9, files: [f('small', 1, { phash: '00000000000000ff', pixels: 100 }), f('big', 2, { phash: '00000000000000fe', pixels: 10000 })] });
    expect(r.links).toEqual([{ fileId: 'small', of: 'big', kind: 'near_photo', similarity: 0.98 }]);
  });
});

describe('split', () => {
  const p = (index: number, over: Partial<PageSignal>): PageSignal => ({ index, chars: 500, text: 'x', widthPt: 595, heightPt: 842, topType: null, topScore: 0, secondScore: 0, pageOfTotal: null, headerKey: '', ...over });
  it('page-of-total, type change, size change and blank separators', () => {
    const segs = splitPages(
      [
        p(1, { topType: 'police_report', topScore: 8, headerKey: 'police collision report' }),
        p(2, { topType: 'bodyshop_estimate', topScore: 7, secondScore: 1, headerKey: 'repair estimate', pageOfTotal: { n: 1, m: 2 } }),
        p(3, { topType: 'bodyshop_estimate', topScore: 3, headerKey: 'repair estimate', pageOfTotal: { n: 2, m: 2 } }),
        p(4, { topType: 'mot_certificate', topScore: 6, headerKey: 'mot test certificate' }),
        p(5, { chars: 0, text: '' }),
        p(6, { topType: 'driving_licence', topScore: 9, widthPt: 243, heightPt: 153, headerKey: 'driving licence' }),
      ],
      { minPages: 2, minMargin: 2 },
    );
    expect(segs.map((s) => [s.fromPage, s.toPage, s.docType])).toEqual([
      [1, 1, 'police_report'],
      [2, 3, 'bodyshop_estimate'],
      [4, 4, 'mot_certificate'],
      [6, 6, 'driving_licence'],
    ]);
    expect(segs[1]!.title).toBe('Bodyshop estimate (pages 2–3)');
    for (const s of segs) expect(s.confidence).toBeLessThanOrEqual(0.85);
  });
  it('a one-document PDF is not a pack; same-type pages merge', () => {
    expect(splitPages([p(1, { topType: 'insurer_letter', topScore: 6, headerKey: 'a' }), p(2, { topType: 'insurer_letter', topScore: 3, headerKey: 'b' })], { minPages: 2, minMargin: 2 })).toEqual([]);
    expect(splitPages([p(1, { topType: 'v5c', topScore: 6 })], { minPages: 2, minMargin: 2 })).toEqual([]);
  });
  it('validateSegments rejects gaps, overlaps and single segments', () => {
    const s = (fromPage: number, toPage: number) => ({ fromPage, toPage, docType: 'other' as const, confidence: 0.8, title: 't', why: '' });
    expect(validateSegments([s(1, 1), s(2, 3)], 3)).toHaveLength(2);
    expect(validateSegments([s(1, 1), s(3, 3)], 3)).toBeNull();
    expect(validateSegments([s(1, 2), s(2, 3)], 3)).toBeNull();
    expect(validateSegments([s(1, 3)], 3)).toBeNull();
    expect(validateSegments([s(1, 1), s(2, 2)], 3)).toBeNull();
  });
  it('helpers read page markers and headers', () => {
    expect(pageOfTotal('Repair estimate\nPage 2 of 3')).toEqual({ n: 2, m: 3 });
    expect(pageOfTotal('no marker')).toBeNull();
    expect(headerKeyOf('\n  Police Collision Report  \nbody')).toBe('police collision report');
  });
});

describe('photo helpers', () => {
  it('plate matching', () => {
    expect(plateMatches(['KX21ABC', 'lm19 xyz', 'AB12CDE', 'KX21 ABC'], { client: 'KX21 ABC', tp: 'LM19XYZ' })).toEqual([
      { text: 'KX21 ABC', normalised: 'KX21ABC', matches: 'client' },
      { text: 'LM19 XYZ', normalised: 'LM19XYZ', matches: 'third_party' },
      { text: 'AB12 CDE', normalised: 'AB12CDE', matches: null },
    ]);
  });
  it('haversine distance and outliers', () => {
    expect(distanceKm({ lat: 51.5074, lon: -0.1278 }, { lat: 51.4545, lon: -0.9781 })).toBeGreaterThan(58);
    expect(distanceKm({ lat: 51.5074, lon: -0.1278 }, { lat: 51.4545, lon: -0.9781 })).toBeLessThan(60);
    expect(gpsOutliers([{ fileId: 'a', lat: 51.45, lon: -0.97 }, { fileId: 'b', lat: 51.4501, lon: -0.9701 }, { fileId: 'c', lat: 51.45, lon: -0.9702 }, { fileId: 'd', lat: 51.6, lon: -0.97 }], 2)).toEqual(['d']);
  });
  it('estimate lines → damage zones with severity', () => {
    const z = zonesFromEstimateText(['Front bumper - replace', 'Bonnet repair and paint', 'O/S/F wing blend', 'Chassis leg O/S structural repair', 'Labour 4.0 hrs']);
    const by = Object.fromEntries(z.map((x) => [x.zoneId, x.severity]));
    expect(by.front_bumper).toBe(2);
    expect(by.bonnet).toBe(1);
    expect(by.front_wing_r).toBe(1);
    expect(by.chassis_leg_r).toBe(3);
  });
  it('damage map: owner rows win, else the highest severity; evidence ids collected', () => {
    const m = damageMapFromObservations([
      { zoneId: 'bonnet', severity: 1, confidence: 0.6, source: 'ai_photo', createdAt: '1', evidenceId: 'e1' },
      { zoneId: 'bonnet', severity: 2, confidence: 0.8, source: 'estimate_text', createdAt: '2', evidenceId: 'e2' },
      { zoneId: 'front_bumper', severity: 3, confidence: 0.9, source: 'ai_photo', createdAt: '1', evidenceId: 'e1' },
      { zoneId: 'front_bumper', severity: 1, confidence: 1, source: 'owner', createdAt: '3', evidenceId: null },
    ]);
    expect(m.bonnet).toEqual({ severity: 2, confidence: 0.8, source: 'ai', evidenceIds: ['e1', 'e2'] });
    expect(m.front_bumper!.severity).toBe(1);
  });
});
