import { describe, expect, it } from 'vitest';
import type { GtaRate } from '../types.js';
import { mergeGtaRates, type ManualGtaRateRow } from './merge.js';
import { gtaRate } from './rates.js';

const KB: GtaRate[] = [
  { group: 'S1', description: 'Small', dailyRatePence: 4232, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'unverified', sourceNote: 'kb' } },
  { group: 'M', description: 'Medium', dailyRatePence: 5666, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'unverified' } },
  { group: 'CP1', dailyRatePence: 6464, period: '2025-26', effectiveFrom: '2025-07-01', effectiveTo: '2026-06-30', verification: { status: 'unverified' } },
];

const manual = (over: Partial<ManualGtaRateRow>): ManualGtaRateRow => ({
  id: 'r1',
  group: 'S1',
  dailyRatePence: 4400,
  period: '2026-27',
  effectiveFrom: '2026-07-01',
  effectiveTo: '2027-06-30',
  verification: { status: 'verified', sourceUrl: 'https://example.test/rates', verifiedBy: 'u1', verifiedAt: '2026-10-01' },
  suppressed: false,
  ...over,
});

describe('mergeGtaRates', () => {
  it('passes KB rows through with origin kb when there are no manual rows', () => {
    const out = mergeGtaRates(KB, []);
    expect(out).toHaveLength(3);
    expect(out.every((r) => r.origin === 'kb')).toBe(true);
  });
  it('a manual row replaces the KB row for the same group and period, keeping its own verification', () => {
    const out = mergeGtaRates(KB, [manual({ group: 's1' })]);
    const s1 = out.filter((r) => r.group === 'S1');
    expect(s1).toHaveLength(1);
    expect(s1[0]).toMatchObject({ dailyRatePence: 4400, origin: 'manual', id: 'r1', overridesKb: true, description: 'Small', verification: { status: 'verified', verifiedBy: 'u1' } });
    expect(gtaRate('S1', '2026-10-04', out)?.dailyRatePence).toBe(4400);
  });
  it('a suppressed row hides the KB row', () => {
    const out = mergeGtaRates(KB, [manual({ group: 'CP1', period: '2025-26', dailyRatePence: undefined, suppressed: true })]);
    expect(out.find((r) => r.group === 'CP1')).toBeUndefined();
    expect(out).toHaveLength(2);
  });
  it('adds manual-only rows', () => {
    const out = mergeGtaRates(KB, [manual({ id: 'r2', group: 'PV2', dailyRatePence: 7900, verification: { status: 'unverified' } })]);
    expect(out.find((r) => r.group === 'PV2')).toMatchObject({ origin: 'manual', overridesKb: false, dailyRatePence: 7900, verification: { status: 'unverified' } });
    expect(out).toHaveLength(4);
  });
  it('a manual row for another period does not replace the KB row', () => {
    const out = mergeGtaRates(KB, [manual({ period: '2027-28', effectiveFrom: '2027-07-01', effectiveTo: '2028-06-30' })]);
    expect(out.filter((r) => r.group === 'S1').map((r) => r.origin)).toEqual(['kb', 'manual']);
  });
  it('a suppressed row with no KB counterpart adds nothing', () => {
    expect(mergeGtaRates(KB, [manual({ group: 'ZZ', suppressed: true })])).toHaveLength(3);
  });
});
