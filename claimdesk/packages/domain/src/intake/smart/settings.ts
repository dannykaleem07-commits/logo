/**
 * Settings > Intake (docs/SMART-INTAKE.md §4.17, §14). Stored in `agent_settings.intake` and merged over these
 * defaults on every read; every number is clamped to a safe range so a bad stored value can never disable a limit.
 */
import { mergeDefaults } from '../../agents/settings.js';

export interface IntakeSettings {
  bundles: {
    /** Register a bundle automatically when nothing needs the owner (off by default). */
    autoRegister: boolean;
    autoRegisterMinConfidence: number;
    prepareMissingDocsRequest: boolean;
    /** Wait this long after the last file settles before reconciling (a drop settles first). */
    quietSeconds: number;
    /** Subfolders of inbox\intake\ become bundles. */
    folderBundles: boolean;
    /** AI reasoning runs per bundle per London day (the owner's "Think again" is exempt). */
    aiReasoningRunsPerBundlePerDay: number;
  };
  split: { enabled: boolean; minPages: number };
  duplicates: { nearPhotoMaxDistance: number; nearTextMinJaccard: number };
  photos: { beforeAccidentToleranceHours: number; gpsOutlierKm: number };
  archives: { maxEntries: number; maxTotalBytes: number; maxDepth: number; maxRatio: number };
}

export const DEFAULT_INTAKE_SETTINGS: IntakeSettings = {
  bundles: { autoRegister: false, autoRegisterMinConfidence: 0.9, prepareMissingDocsRequest: true, quietSeconds: 20, folderBundles: true, aiReasoningRunsPerBundlePerDay: 3 },
  split: { enabled: true, minPages: 2 },
  duplicates: { nearPhotoMaxDistance: 6, nearTextMinJaccard: 0.9 },
  photos: { beforeAccidentToleranceHours: 2, gpsOutlierKm: 2 },
  archives: { maxEntries: 200, maxTotalBytes: 2 * 1024 ** 3, maxDepth: 2, maxRatio: 200 },
};

const clamp = (v: unknown, lo: number, hi: number, dflt: number, integer = false): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  const c = Math.min(hi, Math.max(lo, n));
  return integer ? Math.round(c) : c;
};
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);

/** Stored JSON (any shape) → effective settings, merged over the defaults and clamped. */
export function mergeIntakeSettings(stored: unknown): IntakeSettings {
  const m = mergeDefaults(DEFAULT_INTAKE_SETTINGS, stored && typeof stored === 'object' ? stored : {});
  const d = DEFAULT_INTAKE_SETTINGS;
  return {
    bundles: {
      autoRegister: bool(m.bundles?.autoRegister, d.bundles.autoRegister),
      autoRegisterMinConfidence: clamp(m.bundles?.autoRegisterMinConfidence, 0.8, 1, d.bundles.autoRegisterMinConfidence),
      prepareMissingDocsRequest: bool(m.bundles?.prepareMissingDocsRequest, d.bundles.prepareMissingDocsRequest),
      quietSeconds: clamp(m.bundles?.quietSeconds, 0, 600, d.bundles.quietSeconds, true),
      folderBundles: bool(m.bundles?.folderBundles, d.bundles.folderBundles),
      aiReasoningRunsPerBundlePerDay: clamp(m.bundles?.aiReasoningRunsPerBundlePerDay, 0, 20, d.bundles.aiReasoningRunsPerBundlePerDay, true),
    },
    split: {
      enabled: bool(m.split?.enabled, d.split.enabled),
      minPages: clamp(m.split?.minPages, 2, 50, d.split.minPages, true),
    },
    duplicates: {
      nearPhotoMaxDistance: clamp(m.duplicates?.nearPhotoMaxDistance, 0, 16, d.duplicates.nearPhotoMaxDistance, true),
      nearTextMinJaccard: clamp(m.duplicates?.nearTextMinJaccard, 0.5, 1, d.duplicates.nearTextMinJaccard),
    },
    photos: {
      beforeAccidentToleranceHours: clamp(m.photos?.beforeAccidentToleranceHours, 0, 72, d.photos.beforeAccidentToleranceHours),
      gpsOutlierKm: clamp(m.photos?.gpsOutlierKm, 0.1, 100, d.photos.gpsOutlierKm),
    },
    archives: {
      maxEntries: clamp(m.archives?.maxEntries, 1, 1000, d.archives.maxEntries, true),
      maxTotalBytes: clamp(m.archives?.maxTotalBytes, 1024 * 1024, 4 * 1024 ** 3, d.archives.maxTotalBytes, true),
      maxDepth: clamp(m.archives?.maxDepth, 0, 3, d.archives.maxDepth, true),
      maxRatio: clamp(m.archives?.maxRatio, 10, 1000, d.archives.maxRatio, true),
    },
  };
}
