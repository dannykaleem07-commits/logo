import { describe, expect, it } from 'vitest';
import type { GuidedShot } from '@ccguk/domain';
import { buildEvidenceFields, captureFileName, captureProgress, custodyState, describeDevice, nextShot, outlineKind, sha256HexOf, shotList, type CaptureItem } from './capture';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('sha256HexOf (Web Crypto)', () => {
  it('matches the known vector for "abc" from bytes and from a Blob', async () => {
    expect(await sha256HexOf(new TextEncoder().encode('abc'))).toBe(ABC_SHA256);
    expect(await sha256HexOf(new Blob(['abc']))).toBe(ABC_SHA256);
    expect(await sha256HexOf(new TextEncoder().encode('abc').buffer as ArrayBuffer)).toBe(ABC_SHA256);
  });
});

function item(shot: GuidedShot, status: CaptureItem['status'] = 'ready'): CaptureItem {
  return { shot, blob: new Blob(['x']), filename: 'x.jpg', previewUrl: '', sha256: ABC_SHA256, status, meta: { capturedAt: '2026-10-04T10:00:00.000Z', device: 'iPhone · Safari', source: 'camera', gps: { lat: 51.5, lon: -0.12, accuracyM: 8 }, widthPx: 1920, heightPx: 1440 } };
}

describe('shot list and progress', () => {
  it('uses the domain list: 12 shots, 9 required, corners first', () => {
    const shots = shotList();
    expect(shots).toHaveLength(12);
    expect(shots.filter((s) => s.required)).toHaveLength(9);
    expect(shots.slice(0, 4).map((s) => s.shot)).toEqual(['front_left', 'front_right', 'rear_left', 'rear_right']);
    expect(outlineKind('front_left')).toBe('car_front_left');
    expect(outlineKind('number_plate')).toBe('plate');
    expect(outlineKind('tyre_rr')).toBe('tyre');
    expect(outlineKind('damage_close_2')).toBe('damage');
  });
  it('counts captured / uploaded / required and finds the next gap', () => {
    const shots = shotList();
    const items = { front_left: item('front_left', 'uploaded'), front_right: item('front_right') };
    const p = captureProgress(shots, items);
    expect(p).toMatchObject({ total: 12, required: 9, captured: 2, uploaded: 1, requiredDone: 1 });
    expect(p.requiredMissing).toEqual(['rear_left', 'rear_right', 'number_plate', 'vin_plate', 'odometer', 'damage_close_1', 'damage_close_2']);
    expect(p.pct).toBe(8);
    expect(nextShot(shots, items, 'front_left')).toBe('rear_left');
    expect(nextShot(shots, items, 'interior')).toBe('rear_left');
    const all = Object.fromEntries(shots.map((s) => [s.shot, item(s.shot)])) as Record<GuidedShot, CaptureItem>;
    expect(nextShot(shots, all, 'front_left')).toBeUndefined();
  });
});

describe('metadata and custody', () => {
  it('builds the upload fields with kind photo, the shot, the capture time and the local hash', () => {
    const f = buildEvidenceFields(item('odometer'));
    expect(f).toMatchObject({ kind: 'photo', captureShot: 'odometer', capturedAt: '2026-10-04T10:00:00.000Z', sha256: ABC_SHA256 });
    expect(f.description).toContain('Odometer');
    expect(f.description).toContain('iPhone · Safari');
    expect(f.description).toContain('GPS: 51.50000, -0.12000 (±8 m)');
    expect(f.description).toContain('1920×1440px');
  });
  it('compares hashes case-insensitively', () => {
    expect(custodyState(ABC_SHA256, undefined)).toBe('pending');
    expect(custodyState(ABC_SHA256, ABC_SHA256.toUpperCase())).toBe('match');
    expect(custodyState(ABC_SHA256, 'deadbeef')).toBe('mismatch');
  });
  it('describes devices from the user agent and names files by shot and time', () => {
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari');
    expect(describeDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36')).toBe('Android · Pixel 8 · Chrome');
    expect(describeDevice(undefined)).toBe('unknown device');
    expect(captureFileName('vin_plate', '2026-10-04T10:00:00.000Z')).toBe('vin_plate-2026-10-04T10-00-00-000Z.jpg');
  });
});
