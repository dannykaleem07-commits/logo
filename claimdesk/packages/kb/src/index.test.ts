import { describe, expect, it } from 'vitest';
import * as kb from './index.js';

describe('@ccguk/kb public API', () => {
  it('exports the loaders, search, advisor, directory and rates functions by name', () => {
    const fns = [
      'loadCases',
      'loadStatutes',
      'loadCpr',
      'loadGta',
      'loadFca',
      'loadFos',
      'loadGuidance',
      'loadAll',
      'loadGtaRates',
      'loadCourtFees',
      'loadDirectory',
      'loadPlaybookRules',
      'validateKbEntry',
      'validateDirectoryEntry',
      'search',
      'findByCitation',
      'verificationStatus',
      'advise',
      'getPaidFasterPlan',
      'directoryStatus',
      'searchDirectory',
      'isCopycat',
      'gtaRateFor',
      'listGroups',
    ] as const;
    for (const name of fns) expect(typeof kb[name], name).toBe('function');
  });

  it('has no default export', () => {
    expect((kb as Record<string, unknown>).default).toBeUndefined();
  });

  it('loads every data set end to end', () => {
    expect(kb.loadAll().length).toBeGreaterThanOrEqual(170);
    expect(kb.loadGtaRates().length).toBeGreaterThanOrEqual(14);
    expect(kb.loadCourtFees().length).toBeGreaterThanOrEqual(18);
    expect(kb.loadDirectory().length).toBeGreaterThanOrEqual(49);
    expect(kb.loadPlaybookRules()).toHaveLength(kb.PLAYBOOK_ACTION_CODES.length);
  });
});
