import { describe, expect, it } from 'vitest';
import type { InsurerDirectoryEntry } from '@ccguk/domain';
import { daysBetween, directoryAgeing, directoryStatus, findByPhone, isCopycat, normaliseDomain, normalisePhone, phoneMatchesPattern, searchDirectory } from './directory.js';
import { loadDirectory } from './load.js';

const base: InsurerDirectoryEntry = {
  id: 'test-insurer',
  name: 'Test Insurer',
  brands: ['Test Insurer', 'Testco Direct'],
  thirdPartyClaimsPhone: '0333 123 4567',
  copycatDomains: ['test-insurer-claims.co.uk'],
  copycatNumbers: ['0333 006 44xx', '0800 999 *'],
  verification: { status: 'verified', sourceUrl: 'https://test.example/claims', verifiedAt: '2026-10-04', verifiedBy: 'D. Kaleem' },
};

describe('directoryStatus ageing', () => {
  it('is green on the day of verification and up to 90 days', () => {
    expect(directoryStatus(base, '2026-10-04')).toBe('green');
    expect(directoryStatus(base, '2027-01-02')).toBe('green'); // day 90
  });

  it('turns amber after 90 days and red after 180', () => {
    expect(directoryStatus(base, '2027-01-03')).toBe('amber'); // day 91
    expect(directoryStatus(base, '2027-04-02')).toBe('amber'); // day 180
    expect(directoryStatus(base, '2027-04-03')).toBe('red'); // day 181
    expect(directoryAgeing(base, '2027-04-03').ageDays).toBe(181);
  });

  it('is red when the last live call failed after the last success, or status is failed', () => {
    expect(directoryStatus({ ...base, lastFailed: '2026-10-03' }, '2026-10-04')).toBe('red');
    expect(directoryStatus({ ...base, lastFailed: '2026-10-03', lastUsedOk: '2026-10-01' }, '2026-10-04')).toBe('red');
    expect(directoryStatus({ ...base, lastFailed: '2026-10-01', lastUsedOk: '2026-10-03' }, '2026-10-04')).toBe('green');
    expect(directoryStatus({ ...base, verification: { status: 'failed' } }, '2026-10-04')).toBe('red');
  });

  it('is red when never verified and amber when stale', () => {
    expect(directoryStatus({ ...base, verification: { status: 'unverified' } }, '2026-10-04')).toBe('red');
    expect(directoryStatus({ ...base, verification: { status: 'stale', verifiedAt: '2026-10-04' } }, '2026-10-04')).toBe('amber');
    expect(directoryAgeing({ ...base, verification: { status: 'stale', verifiedAt: '2026-10-04' } }, '2026-10-04').reasons).toHaveLength(1);
  });

  it("is never green for an 'unverified' record, even one checked today (convention 6)", () => {
    const checked = directoryAgeing({ ...base, verification: { status: 'unverified', sourceUrl: 'https://test.example/claims', verifiedAt: '2026-10-04' } }, '2026-10-04');
    expect(checked.status).toBe('amber');
    expect(checked.reasons.join(' ')).toMatch(/not yet verified/);
    // age still escalates
    expect(directoryStatus({ ...base, verification: { status: 'unverified', verifiedAt: '2026-01-01' } }, '2026-10-04')).toBe('red');
  });

  it('every shipped record is amber on 2026-10-04: checked by the research agents, verified by nobody', () => {
    for (const e of loadDirectory()) {
      expect(e.verification.status, e.id).toBe('unverified');
      expect(directoryStatus(e, '2026-10-04'), e.id).toBe('amber');
    }
  });

  it('daysBetween counts calendar days', () => {
    expect(daysBetween('2026-10-04', '2026-10-05')).toBe(1);
    expect(daysBetween('2026-10-04', '2026-10-04')).toBe(0);
    expect(daysBetween('2026-10-05', '2026-10-04')).toBe(-1);
  });
});

describe('searchDirectory', () => {
  it('finds insurers by brand, name and id', () => {
    expect(searchDirectory('Churchill')[0]!.entry.id).toBe('direct-line-group');
    expect(searchDirectory("Sheilas' Wheels")[0]!.entry.id).toBe('esure');
    expect(searchDirectory('quote me happy')[0]!.entry.id).toBe('aviva');
    expect(searchDirectory('MIB')[0]!.entry.id).toBe('mib');
    expect(searchDirectory('covea')[0]!.entry.id).toBe('covea-insurance');
  });

  it('ranks exact matches first and returns all for an empty query', () => {
    const hits = searchDirectory('Admiral');
    expect(hits[0]!.entry.id).toBe('admiral');
    expect(hits.length).toBeGreaterThan(1); // Veygo lists "Veygo by Admiral"
    expect(searchDirectory('')).toHaveLength(loadDirectory().length);
    expect(searchDirectory('zzzz')).toEqual([]);
  });
});

describe('copycat detection', () => {
  it('normalises phones and domains', () => {
    expect(normalisePhone('+44 (0)333 220 2047')).toBe('03332202047');
    expect(normalisePhone('0333-220-2047')).toBe('03332202047');
    expect(normalisePhone('0044 333 220 2047')).toBe('03332202047');
    expect(normalisePhone('44 333 220 2047')).toBe('03332202047');
    expect(normalisePhone('+44333 220 2047')).toBe('03332202047');
    expect(normalisePhone('call us')).toBe('');
    expect(findByPhone('44 333 220 2047')?.id).toBe('admiral');
    expect(normaliseDomain('https://www.Admiral-Claims.co.uk/start?x=1')).toBe('admiral-claims.co.uk');
    expect(normaliseDomain('claims@hastings-direct-claims.com')).toBe('hastings-direct-claims.com');
  });

  it('matches wildcard number patterns digit by digit', () => {
    expect(phoneMatchesPattern('03330064412', '0333 006 44xx')).toBe(true);
    expect(phoneMatchesPattern('03330064512', '0333 006 44xx')).toBe(false);
    expect(phoneMatchesPattern('0333006441', '0333 006 44xx')).toBe(false);
    expect(phoneMatchesPattern('08009991234', '0800 999 *')).toBe(true);
  });

  it('flags the BLUEPRINT §8 Admiral copycat range from the shipped directory', () => {
    const m = isCopycat('0333 006 4412');
    expect(m).toMatchObject({ entryId: 'admiral', kind: 'number', pattern: '0333 006 44xx' });
    expect(isCopycat('+44 333 006 4499')?.entryId).toBe('admiral');
  });

  it('does not flag a genuine published number', () => {
    expect(isCopycat('0333 220 2047')).toBeUndefined();
    expect(findByPhone('0333 220 2047')?.id).toBe('admiral');
    expect(findByPhone('01908 830001')?.id).toBe('mib');
  });

  it('matches blacklisted domains and subdomains, not the genuine domain', () => {
    const dir = [base];
    expect(isCopycat('https://www.test-insurer-claims.co.uk/claim', dir)).toMatchObject({ entryId: 'test-insurer', kind: 'domain' });
    expect(isCopycat('portal.test-insurer-claims.co.uk', dir)?.kind).toBe('domain');
    expect(isCopycat('test-insurer.co.uk', dir)).toBeUndefined();
    expect(isCopycat('0800 999 0000', dir)?.pattern).toBe('0800 999 *');
    expect(isCopycat('', dir)).toBeUndefined();
    expect(isCopycat('123', dir)).toBeUndefined();
  });
});

describe('shipped directory content', () => {
  it('merges the three research parts with unique ids and the maintenance fields unset', () => {
    const dir = loadDirectory();
    expect(dir).toHaveLength(55);
    expect(new Set(dir.map((e) => e.id)).size).toBe(55);
    for (const e of dir) {
      expect(e.lastUsedOk).toBeUndefined();
      expect(e.lastFailed).toBeUndefined();
      expect(e.verification.status).not.toBe('verified');
    }
    expect(dir.map((e) => e.id)).toEqual(expect.arrayContaining(['admiral', 'aviva', 'direct-line-group', 'esure', 'hastings-direct', 'mib', 'met-police-collision-reports']));
  });
});
