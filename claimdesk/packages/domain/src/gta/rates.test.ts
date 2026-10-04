import { describe, it, expect } from 'vitest';
import type { GtaRate } from '../types.js';
import { defaultGtaRates, gtaRate, gtaGroupsOn, GTA_WORDING_DATE } from './rates.js';

describe('defaultGtaRates', () => {
  it('ships the blueprint 2026–27 figures S1 £42.32, M £56.66, M1 £65.49 ex VAT as unverified fallbacks', () => {
    const byGroup = Object.fromEntries(defaultGtaRates.map((r) => [r.group, r]));
    expect(byGroup['S1']).toMatchObject({ dailyRatePence: 4232, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30' });
    expect(byGroup['M']).toMatchObject({ dailyRatePence: 5666, period: '2026-27' });
    expect(byGroup['M1']).toMatchObject({ dailyRatePence: 6549, period: '2026-27' });
    for (const g of ['S1', 'M', 'M1']) {
      // never 'verified' in code: a human records the source (ARCHITECTURE convention 6)
      expect(byGroup[g]!.verification).toMatchObject({ status: 'unverified', sourceUrl: 'https://www.gtacredithire.com/rates/' });
    }
  });
  it('ships CP1 £64.64 and CP2 £73.34 as unverified 2025–26 figures', () => {
    const byGroup = Object.fromEntries(defaultGtaRates.map((r) => [r.group, r]));
    expect(byGroup['CP1']).toMatchObject({ dailyRatePence: 6464, period: '2025-26' });
    expect(byGroup['CP2']).toMatchObject({ dailyRatePence: 7334, period: '2025-26' });
    expect(byGroup['CP1']!.verification.status).toBe('unverified');
    expect(byGroup['CP2']!.verification.status).toBe('unverified');
  });
  it('records the operative wording date 16 March 2026', () => {
    expect(GTA_WORDING_DATE).toBe('2026-03-16');
  });
});

describe('gtaRate', () => {
  it('S1 on 2026-08-01 → 4232 pence', () => {
    expect(gtaRate('S1', '2026-08-01')?.dailyRatePence).toBe(4232);
  });
  it('is inclusive at both ends of the period', () => {
    expect(gtaRate('M', '2026-07-01')?.dailyRatePence).toBe(5666);
    expect(gtaRate('M1', '2027-06-30')?.dailyRatePence).toBe(6549);
    expect(gtaRate('M', '2026-06-30')).toBeUndefined();
    expect(gtaRate('M', '2027-07-01')).toBeUndefined();
  });
  it('is case-insensitive and accepts a date-time (London date)', () => {
    expect(gtaRate('s1', '2026-08-01T12:00:00Z')?.group).toBe('S1');
    // 30 June 23:30 UTC is 1 July 00:30 BST → in period
    expect(gtaRate('S1', '2026-06-30T23:30:00Z')?.dailyRatePence).toBe(4232);
  });
  it('never falls back to a stale period: CP1 has no 2026–27 figure', () => {
    expect(gtaRate('CP1', '2026-05-01')?.dailyRatePence).toBe(6464);
    expect(gtaRate('CP1', '2026-08-01')).toBeUndefined();
  });
  it('returns undefined for unknown groups', () => {
    expect(gtaRate('ZZ9', '2026-08-01')).toBeUndefined();
  });
  it('accepts an injected rate table and prefers a verified row over an unverified overlap', () => {
    const rates: GtaRate[] = [
      { group: 'X', dailyRatePence: 1000, period: 'a', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', verification: { status: 'unverified' } },
      { group: 'X', dailyRatePence: 1100, period: 'b', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', verification: { status: 'verified' } },
    ];
    expect(gtaRate('X', '2026-06-01', rates)?.dailyRatePence).toBe(1100);
    expect(gtaRate('S1', '2026-08-01', rates)).toBeUndefined();
  });
});

describe('gtaGroupsOn', () => {
  it('lists the groups with a rate on a date', () => {
    expect(gtaGroupsOn('2026-08-01')).toEqual(['M', 'M1', 'S1']);
    expect(gtaGroupsOn('2026-05-01')).toEqual(['CP1', 'CP2']);
  });
});
