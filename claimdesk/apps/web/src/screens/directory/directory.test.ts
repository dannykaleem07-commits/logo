import { describe, expect, it } from 'vitest';
import type { InsurerDirectoryEntry } from '@ccguk/domain';
import { cardBanner, copyForCallText, directoryStatus, hasMoreDetails, sortDirectory, filterDirectory, hasCopycats, isHttpUrl, ivrPressLine, UNVERIFIED_WARNING } from './directory';

const today = '2026-10-04';

function entry(extra: Partial<InsurerDirectoryEntry> = {}): InsurerDirectoryEntry {
  return {
    id: 'esure',
    name: 'esure',
    brands: ['esure', "Sheilas' Wheels"],
    thirdPartyClaimsPhone: '0345 603 7872',
    thirdPartyIvrPath: 'Option 3 (third parties)',
    openingHours: 'Mon–Fri 8am–8pm',
    copycatDomains: [],
    copycatNumbers: [],
    verification: { status: 'unverified', sourceNote: 'forum only' },
    ...extra
  };
}

describe('directoryStatus', () => {
  it('unverified → amber with the mandatory warning', () => {
    const s = directoryStatus(entry(), today);
    expect(s.tone).toBe('amber');
    expect(s.warning).toBe(UNVERIFIED_WARNING);
  });
  it('verified: green within 90 days, amber to 180, red after', () => {
    expect(directoryStatus(entry({ verification: { status: 'verified', verifiedAt: '2026-09-01' } }), today).tone).toBe('green');
    expect(directoryStatus(entry({ verification: { status: 'verified', verifiedAt: '2026-06-01' } }), today).tone).toBe('amber');
    expect(directoryStatus(entry({ verification: { status: 'verified', verifiedAt: '2026-03-01' } }), today).tone).toBe('red');
    expect(directoryStatus(entry({ verification: { status: 'verified', verifiedAt: '2026-07-06' } }), today).tone).toBe('green'); // exactly 90 days
    expect(directoryStatus(entry({ verification: { status: 'verified', verifiedAt: '2026-07-05' } }), today).tone).toBe('amber'); // 91 days
  });
  it('failed → red with the failure line; stale → red', () => {
    expect(directoryStatus(entry({ verification: { status: 'failed', verifiedAt: '2026-10-01' }, lastFailed: '2026-10-03' }), today)).toMatchObject({ tone: 'red', label: 'Failed' });
    expect(directoryStatus(entry({ verification: { status: 'stale', verifiedAt: '2026-10-01' } }), today).tone).toBe('red');
  });
});

describe('ivrPressLine', () => {
  it('turns option paths into press instructions', () => {
    expect(ivrPressLine('Option 2 → Option 3 (third party)')).toBe('press 2, then press 3 (third party)');
    expect(ivrPressLine('Option 3 (third parties)')).toBe('press 3 (third parties)');
    expect(ivrPressLine(undefined)).toBeUndefined();
    expect(ivrPressLine('say "claims"')).toBe('say "claims"');
  });
});

describe('copyForCallText', () => {
  it('carries name, number, IVR, hours and the unverified warning', () => {
    const text = copyForCallText(entry());
    expect(text.split('\n')).toEqual(['esure', 'Third-party claims: 0345 603 7872', 'IVR: press 3 (third parties)', 'Hours: Mon–Fri 8am–8pm', UNVERIFIED_WARNING]);
  });
  it('omits the warning once verified and falls back to the policyholder line', () => {
    const text = copyForCallText(entry({ thirdPartyClaimsPhone: undefined, policyholderClaimsPhone: '0345 030 6925', thirdPartyIvrPath: undefined, verification: { status: 'verified', verifiedAt: '2026-10-01' } }));
    expect(text).toContain('policyholder line');
    expect(text).not.toContain('UNVERIFIED');
  });
});

describe('filters and helpers', () => {
  it('filters by name, brand or digits of a number', () => {
    const list = [entry(), entry({ id: 'admiral', name: 'Admiral', brands: ['Elephant', 'Diamond'], thirdPartyClaimsPhone: '0333 220 2047' })];
    expect(filterDirectory(list, 'elephant').map((e) => e.id)).toEqual(['admiral']);
    expect(filterDirectory(list, '2202047').map((e) => e.id)).toEqual(['admiral']);
    expect(filterDirectory(list, "sheilas").map((e) => e.id)).toEqual(['esure']);
    expect(filterDirectory(list, '')).toHaveLength(2);
  });
  it('detects copycats and validates urls', () => {
    expect(hasCopycats(entry())).toBe(false);
    expect(hasCopycats(entry({ copycatNumbers: ['0333 006 44xx'] }))).toBe(true);
    expect(isHttpUrl('https://www.admiral.com/claims')).toBe(true);
    expect(isHttpUrl('admiral.com')).toBe(false);
  });
});

describe('compact cards (0.3 §E3)', () => {
  it('puts cards with a third-party number first, then by name', () => {
    const list = [entry({ id: 'z', name: 'Zurich', thirdPartyClaimsPhone: undefined }), entry({ id: 'a', name: 'Aviva', thirdPartyClaimsPhone: undefined }), entry({ id: 'h', name: 'Hastings' }), entry({ id: 'e', name: 'esure' })];
    expect(sortDirectory(list).map((e) => e.name)).toEqual(['esure', 'Hastings', 'Aviva', 'Zurich']);
  });
  it('drops the duplicate UNVERIFIED banner (the badge stays) but keeps the red failed / stale warning', () => {
    const unverified = directoryStatus(entry(), today);
    expect(unverified.label).toBe('Unverified');
    expect(cardBanner(unverified)).toBeUndefined();
    const failed = directoryStatus(entry({ verification: { status: 'failed' }, lastFailed: '2026-10-01' }), today);
    expect(cardBanner(failed)).toMatch(/failed on a live call/);
  });
  it('knows when there is more to show', () => {
    expect(hasMoreDetails(entry())).toBe(true);
    expect(hasMoreDetails(entry({ brands: [], verification: { status: 'unverified' } }))).toBe(false);
  });
});
