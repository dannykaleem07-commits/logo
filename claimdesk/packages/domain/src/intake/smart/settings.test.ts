import { describe, expect, it } from 'vitest';
import { DEFAULT_INTAKE_SETTINGS, mergeIntakeSettings } from './settings.js';

describe('mergeIntakeSettings', () => {
  it('returns the defaults for nothing stored', () => {
    expect(mergeIntakeSettings(undefined)).toEqual(DEFAULT_INTAKE_SETTINGS);
    expect(mergeIntakeSettings({})).toEqual(DEFAULT_INTAKE_SETTINGS);
    expect(mergeIntakeSettings('junk')).toEqual(DEFAULT_INTAKE_SETTINGS);
  });

  it('auto-register is off by default and the request for missing documents is on', () => {
    expect(DEFAULT_INTAKE_SETTINGS.bundles.autoRegister).toBe(false);
    expect(DEFAULT_INTAKE_SETTINGS.bundles.prepareMissingDocsRequest).toBe(true);
    expect(DEFAULT_INTAKE_SETTINGS.bundles.folderBundles).toBe(true);
  });

  it('merges partial values key by key', () => {
    const s = mergeIntakeSettings({ bundles: { autoRegister: true }, photos: { gpsOutlierKm: 5 } });
    expect(s.bundles.autoRegister).toBe(true);
    expect(s.bundles.quietSeconds).toBe(20);
    expect(s.photos.gpsOutlierKm).toBe(5);
    expect(s.photos.beforeAccidentToleranceHours).toBe(2);
  });

  it('clamps out-of-range numbers', () => {
    const s = mergeIntakeSettings({
      bundles: { autoRegisterMinConfidence: 0.2, quietSeconds: 9999, aiReasoningRunsPerBundlePerDay: -3 },
      split: { minPages: 1 },
      duplicates: { nearPhotoMaxDistance: 99, nearTextMinJaccard: 0 },
      archives: { maxEntries: 1e9, maxDepth: 10, maxRatio: 1, maxTotalBytes: 1 },
    });
    expect(s.bundles.autoRegisterMinConfidence).toBe(0.8);
    expect(s.bundles.quietSeconds).toBe(600);
    expect(s.bundles.aiReasoningRunsPerBundlePerDay).toBe(0);
    expect(s.split.minPages).toBe(2);
    expect(s.duplicates.nearPhotoMaxDistance).toBe(16);
    expect(s.duplicates.nearTextMinJaccard).toBe(0.5);
    expect(s.archives.maxEntries).toBe(1000);
    expect(s.archives.maxDepth).toBe(3);
    expect(s.archives.maxRatio).toBe(10);
    expect(s.archives.maxTotalBytes).toBe(1024 * 1024);
  });

  it('ignores wrongly typed values', () => {
    const s = mergeIntakeSettings({ bundles: { autoRegister: 'yes', quietSeconds: 'ten' } });
    expect(s.bundles.autoRegister).toBe(false);
    expect(s.bundles.quietSeconds).toBe(20);
  });
});
