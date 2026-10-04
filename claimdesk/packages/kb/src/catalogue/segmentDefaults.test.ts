import { describe, expect, it } from 'vitest';
import { DATA_FILES, KbValidationError, loadGtaSegmentDefaultsFile, readDataFile, validateGtaSegmentDefaults } from '../load.js';

describe('gta-segment-defaults.json', () => {
  it('is registered in DATA_FILES and validates', () => {
    expect(DATA_FILES.gtaSegmentDefaults).toBe('gta-segment-defaults.json');
    const f = loadGtaSegmentDefaultsFile();
    expect(f.verification.status).toBe('unverified');
    expect(f.defaults).toMatchObject({ city: 'S1', supermini: 'S2', 'small-family': 'S3', 'suv-luxury': 'F6', pickup: 'CP1', minibus: 'PV3' });
  });
  it('rejects a verified status, a missing segment or a bad group code', () => {
    const raw = structuredClone(readDataFile(DATA_FILES.gtaSegmentDefaults)) as { verification: { status: string }; defaults: Record<string, string> };
    expect(() => validateGtaSegmentDefaults({ ...raw, verification: { ...raw.verification, status: 'verified' } })).toThrow(KbValidationError);
    const { city: _c, ...missing } = raw.defaults;
    expect(() => validateGtaSegmentDefaults({ ...raw, defaults: missing })).toThrow(/city/);
    expect(() => validateGtaSegmentDefaults({ ...raw, defaults: { ...raw.defaults, city: 's1' } })).toThrow(/city/);
    expect(() => validateGtaSegmentDefaults({ ...raw, defaults: { ...raw.defaults, hovercraft: 'S1' } })).toThrow(/hovercraft/);
  });
});
