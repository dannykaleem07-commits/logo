import { describe, expect, it } from 'vitest';
import type { Evidence } from '@ccguk/domain';
import { bytesLabel, EVIDENCE_KIND_LABEL, exifSummary, filterEvidence, guessKind, sha256HexOf, shortHash, sortEvidence, uploadFieldsFrom } from './evidence';

const ev = (over: Partial<Evidence>): Evidence => ({
  id: 'e1',
  claimId: 'c1',
  kind: 'photo',
  filename: 'IMG_0001.jpg',
  mime: 'image/jpeg',
  bytes: 1024,
  sha256: 'a'.repeat(64),
  storagePath: 'x',
  uploadedAt: '2026-09-01T10:00:00Z',
  uploadedBy: 'u1',
  immutable: true,
  ...over
});

describe('evidence helpers', () => {
  it('labels every kind and shortens hashes', () => {
    expect(Object.keys(EVIDENCE_KIND_LABEL)).toContain('advert');
    expect(shortHash('abcdef0123456789')).toBe('abcdef0123…');
    expect(shortHash(undefined)).toBe('—');
    expect(bytesLabel(2_500_000)).toBe('2.4 MB');
  });
  it('summarises EXIF', () => {
    expect(exifSummary(undefined)).toBe('');
    expect(exifSummary({ make: 'Apple', model: 'iPhone 15', dateTimeOriginal: '2026-09-01T10:00:00Z', gps: { lat: 51.5, lon: -0.12 }, widthPx: 4032, heightPx: 3024 })).toBe('Apple iPhone 15 · taken 2026-09-01 10:00 · GPS 51.50000, -0.12000 · 4032×3024');
  });
  it('filters and sorts newest first', () => {
    const items = [ev({ id: 'a', uploadedAt: '2026-09-01T10:00:00Z' }), ev({ id: 'b', kind: 'advert', uploadedAt: '2026-09-02T10:00:00Z', captureShot: undefined, description: 'Auto Trader Golf' }), ev({ id: 'c', uploadedAt: '2026-09-03T10:00:00Z', captureShot: 'odometer' })];
    expect(sortEvidence(items).map((e) => e.id)).toEqual(['c', 'b', 'a']);
    expect(filterEvidence(items, { kind: 'advert' }).map((e) => e.id)).toEqual(['b']);
    expect(filterEvidence(items, { guidedOnly: true }).map((e) => e.id)).toEqual(['c']);
    expect(filterEvidence(items, { q: 'golf' }).map((e) => e.id)).toEqual(['b']);
  });
  it('builds upload fields and insists on a URL for a comparable advert', () => {
    const file = { type: 'application/pdf', name: 'advert.pdf' } as File;
    expect(guessKind(file)).toBe('pdf');
    expect(guessKind({ type: 'image/png', name: 'x.png' } as File)).toBe('photo');
    const missing = uploadFieldsFrom({ kind: 'advert', description: '', capturedAt: '', captureShot: '', sourceUrl: '' }, file);
    expect(missing).toMatchObject({ ok: false, errors: { sourceUrl: expect.any(String) } });
    const ok = uploadFieldsFrom({ kind: 'advert', description: ' Golf 1.5 TSI ', capturedAt: '2026-09-01T10:00:00Z', captureShot: '', sourceUrl: 'https://www.autotrader.co.uk/car-details/1' }, file, 'ab'.repeat(32));
    expect(ok).toEqual({ ok: true, body: { kind: 'advert', description: 'Golf 1.5 TSI', capturedAt: '2026-09-01T10:00:00Z', captureShot: undefined, sourceUrl: 'https://www.autotrader.co.uk/car-details/1', sha256: 'ab'.repeat(32) } });
    expect(uploadFieldsFrom({ kind: '', description: '', capturedAt: '', captureShot: '', sourceUrl: '' }, null).ok).toBe(false);
  });
  it('hashes with Web Crypto (SHA-256 of "abc")', async () => {
    const hex = await sha256HexOf(new TextEncoder().encode('abc').buffer as ArrayBuffer);
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
