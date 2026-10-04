import { describe, expect, it } from 'vitest';
import type { GtaRate } from '@ccguk/domain';
import { compareGroups, gtaRateFor, listGroups, listPeriods, periodFor, ratesForPeriod } from './gtaRates.js';
import { loadGtaRates } from './load.js';

describe('gtaRateFor', () => {
  it("gtaRateFor('S1','2026-08-01') → 4232 pence (blueprint S1 £42.32)", () => {
    const r = gtaRateFor('S1', '2026-08-01');
    expect(r?.dailyRatePence).toBe(4232);
    expect(r?.period).toBe('2026-27');
    expect(r?.verification.status).toBe('unverified');
  });

  it('blueprint 2026–27 figures: M £56.66, M1 £65.49', () => {
    expect(gtaRateFor('M', '2026-07-01')?.dailyRatePence).toBe(5666);
    expect(gtaRateFor('M1', '2027-06-30')?.dailyRatePence).toBe(6549);
  });

  it('the 2026–27 table holds exactly one row per group, S1/M/M1 = 4232/5666/6549 pence, each with its gtacredithire.com source', () => {
    const rows = ratesForPeriod('2026-27');
    expect(new Set(rows.map((r) => r.group)).size).toBe(rows.length);
    const pence = Object.fromEntries(rows.map((r) => [r.group, r.dailyRatePence]));
    expect(pence).toMatchObject({ S1: 4232, M: 5666, M1: 6549, S2: 4799, S3: 5118, S6: 6186, M2: 7468, M3: 8777, F6: 22347 });
    for (const r of rows) {
      expect(r.effectiveFrom).toBe('2026-07-01');
      expect(r.effectiveTo).toBe('2027-06-30');
      expect(r.verification.sourceUrl).toMatch(/^https:\/\/www\.gtacredithire\.com\//);
      expect(r.verification.status).toBe('unverified'); // page blocked for the research agents; a human must open it
    }
    // the 2025–26 rows never leak into a 2026–27 lookup
    expect(gtaRateFor('M', '2026-07-01')?.period).toBe('2026-27');
    expect(gtaRateFor('M', '2026-06-30')?.period).toBe('2025-26');
  });

  it('picks the period by date and is case-insensitive', () => {
    expect(gtaRateFor('m', '2026-01-15')?.dailyRatePence).toBe(6159); // 2025–26 row
    expect(gtaRateFor(' m1 ', '2026-01-15T09:00:00Z')?.dailyRatePence).toBe(7118);
    expect(gtaRateFor('CP1', '2026-03-01')?.dailyRatePence).toBe(6464);
  });

  it('returns undefined rather than falling back to another period or group', () => {
    expect(gtaRateFor('S1', '2026-06-30')).toBeUndefined(); // no 2025–26 S1 row held
    expect(gtaRateFor('CP1', '2026-08-01')).toBeUndefined(); // no 2026–27 CP1 row held
    expect(gtaRateFor('ZZ', '2026-08-01')).toBeUndefined();
    expect(gtaRateFor('S1', '2030-01-01')).toBeUndefined();
  });

  it('prefers a verified row, then the latest effectiveFrom, when rows overlap', () => {
    const rows: GtaRate[] = [
      { group: 'S1', dailyRatePence: 1, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'unverified' } },
      { group: 'S1', dailyRatePence: 2, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'verified', sourceUrl: 'https://x', verifiedAt: '2026-10-04' } },
      { group: 'S1', dailyRatePence: 3, period: '2026-27', effectiveFrom: '2026-09-01', effectiveTo: '2027-06-30', verification: { status: 'unverified' } },
    ];
    expect(gtaRateFor('S1', '2026-10-01', rows)?.dailyRatePence).toBe(2);
    expect(gtaRateFor('S1', '2026-10-01', rows.filter((r) => r.dailyRatePence !== 2))?.dailyRatePence).toBe(3);
  });
});

describe('periods and groups', () => {
  it('lists periods latest first and groups per period', () => {
    expect(listPeriods()).toEqual(['2026-27', '2025-26']);
    expect(listGroups('2026-27')).toEqual(['S1', 'S2', 'S3', 'S6', 'M', 'M1', 'M2', 'M3', 'F6']);
    expect(listGroups('2025-26')).toEqual(['M', 'M1', 'CP1', 'CP2', 'PV2']);
    expect(listGroups()).toContain('CP1');
    expect(listGroups('2019-20')).toEqual([]);
  });

  it('ratesForPeriod and periodFor', () => {
    expect(ratesForPeriod('2026-27')).toHaveLength(9);
    expect(ratesForPeriod('2026-27')[0]!.group).toBe('S1');
    expect(periodFor('2026-08-01')).toBe('2026-27');
    expect(periodFor('2026-03-01')).toBe('2025-26');
    expect(periodFor('2024-01-01')).toBeUndefined();
  });

  it('compareGroups orders by GTA category then number', () => {
    expect(['CP1', 'M1', 'S6', 'S1', 'M', 'F6', 'PV2'].sort(compareGroups)).toEqual(['S1', 'S6', 'M', 'M1', 'F6', 'CP1', 'PV2']);
  });

  it('every shipped rate is integer pence with a window and a verification', () => {
    for (const r of loadGtaRates()) {
      expect(Number.isInteger(r.dailyRatePence)).toBe(true);
      expect(r.effectiveFrom <= r.effectiveTo).toBe(true);
      expect(['verified', 'unverified', 'failed', 'stale']).toContain(r.verification.status);
    }
  });
});
