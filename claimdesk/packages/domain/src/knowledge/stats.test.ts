// owned by knowledge-learners
import { describe, expect, it } from 'vitest';
import { buildInsurerProfile, distOf, percentileNearestRank, profileFigures, stepEffectiveness, type ClaimOutcomeInput } from './stats.js';

const NOW = '2026-10-10T10:00:00.000Z';

const row = (i: number, over: Partial<ClaimOutcomeInput> = {}): ClaimOutcomeInput => ({
  claimId: `c${String(i).padStart(2, '0')}`,
  head: 'hire',
  insurerSlug: 'example-insurer',
  claimTypes: ['credit_hire'],
  gtaSubscriber: false,
  claimedPence: 100_000,
  firstOfferPence: 70_000,
  paidPence: 90_000,
  reducedPence: 10_000,
  packSentAt: '2026-06-01T09:00:00.000Z',
  firstPaidAt: '2026-07-01T09:00:00.000Z',
  fullyPaidAt: '2026-07-01T09:00:00.000Z',
  workingDaysToPay: 10 + i,
  chasersBeforePay: i % 3,
  objections: i % 2 ? ['reduction_or_part_payment'] : [],
  docsRequested: i % 4 === 0 ? ['Repair invoice'] : [],
  steps: [
    { step: 'event:payment_pack_sent', at: '2026-06-01T09:00:00.000Z' },
    { step: 'in:reply', at: '2026-06-02T09:00:00.000Z' },
  ],
  status: 'paid',
  ...over,
});

describe('percentiles', () => {
  it('nearest rank', () => {
    expect(percentileNearestRank([15, 20, 35, 40, 50], 30)).toBe(20);
    expect(percentileNearestRank([15, 20, 35, 40, 50], 50)).toBe(35);
    expect(percentileNearestRank([15, 20, 35, 40, 50], 100)).toBe(50);
    expect(percentileNearestRank([3, 1, 2], 0)).toBe(1);
    expect(() => percentileNearestRank([], 50)).toThrow();
  });
  it('distOf respects the minimum n', () => {
    expect(distOf([1, 2], 3)).toBeNull();
    expect(distOf([4, 1, 3, 2], 3)).toEqual({ median: 2, p25: 1, p75: 3, n: 4 });
  });
});

describe('buildInsurerProfile', () => {
  it('computes hand-checkable figures with n', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i + 1));
    const p = buildInsurerProfile('example-insurer', rows, { window: '12m', minN: 3, computedAt: NOW });
    expect(p.n).toEqual({ claims: 12, settled: 12 });
    // days 11..22: nearest-rank median = 6th value = 16, p90 = 11th = 21
    expect(p.daysToPay).toEqual({ medianWorkingDays: 16, p90WorkingDays: 21, n: 12 });
    expect(p.heads.hire).toEqual({ paidOfClaimedPct: { median: 90, p25: 90, p75: 90, n: 12 }, firstOfferOfClaimedPct: { median: 70, p25: 70, p75: 70, n: 12 }, reductionRatePct: 100, n: 12 });
    expect(p.objections).toEqual([{ intent: 'reduction_or_part_payment', claims: 6, pct: 50 }]);
    expect(p.docsRequested).toEqual([{ doc: 'repair invoice', claims: 3 }]);
    expect(p.responseHours).toEqual({ median: 24, n: 12 });
    expect(p.chasersBeforePay.n).toBe(12);
    expect(p.computedAt).toBe(NOW);
  });

  it('too few claims → every figure null', () => {
    const p = buildInsurerProfile('example-insurer', [row(1), row(2)], { window: 'all', minN: 3, computedAt: NOW });
    expect(p.n.claims).toBe(2);
    expect(p.daysToPay.medianWorkingDays).toBeNull();
    expect(p.heads.hire!.paidOfClaimedPct).toBeNull();
    expect(p.objections).toEqual([]);
    expect(p.responseHours.median).toBeNull();
  });

  it('the 12-month window drops old claims; figures exclude computedAt', () => {
    const old = row(1, { packSentAt: '2024-01-01T09:00:00.000Z', firstPaidAt: '2024-02-01T09:00:00.000Z', fullyPaidAt: '2024-02-01T09:00:00.000Z', steps: [] });
    const p12 = buildInsurerProfile('example-insurer', [old, row(2), row(3), row(4)], { window: '12m', minN: 3, computedAt: NOW });
    const pAll = buildInsurerProfile('example-insurer', [old, row(2), row(3), row(4)], { window: 'all', minN: 3, computedAt: NOW });
    expect(p12.n.claims).toBe(3);
    expect(pAll.n.claims).toBe(4);
    const later = buildInsurerProfile('example-insurer', [row(2), row(3), row(4)], { window: '12m', minN: 3, computedAt: '2026-10-11T10:00:00.000Z' });
    expect(profileFigures(later)).toEqual(profileFigures(p12));
  });

  it('GTA figures are benchmark counts', () => {
    const rows = [1, 2, 3].map((i) => row(i, { gtaSubscriber: true, paidPence: i === 1 ? 100_000 : 80_000, steps: i === 2 ? [{ step: 'in:first_notification_dispute', at: '2026-06-02T09:00:00.000Z' }] : [] }));
    const p = buildInsurerProfile('example-insurer', rows, { window: 'all', minN: 3, computedAt: NOW });
    expect(p.gta).toEqual({ subscriberClaims: 3, hirePaidAtGtaRatePct: 33.3, firstNotificationDisputePct: 33.3 });
  });
});

describe('stepEffectiveness', () => {
  it('per insurer when n ≥ minN, globally otherwise, with a baseline from other steps', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      row(i + 1, {
        steps: [
          { step: 'email:chaser', at: '2026-06-01T09:00:00.000Z' },
          ...(i < 4 ? [{ step: 'in:payment', at: '2026-06-03T09:00:00.000Z' }] : []),
          { step: 'tpl:letter.lbc', at: '2026-06-10T09:00:00.000Z' },
        ],
      }),
    );
    const stats = stepEffectiveness(rows, { withinWorkingDays: 5, minNPerInsurer: 5, window: 'all' });
    const chaserPay = stats.find((s) => s.step === 'email:chaser' && s.outcome === 'payment' && s.insurerSlug === 'example-insurer')!;
    expect(chaserPay).toMatchObject({ hits: 4, n: 6, baselinePct: 0, withinWorkingDays: 5 });
    expect(stats.some((s) => s.step === 'email:chaser' && s.insurerSlug === null)).toBe(true);
    const few = stepEffectiveness(rows.slice(0, 3), { withinWorkingDays: 5, minNPerInsurer: 5, window: 'all' });
    expect(few.every((s) => s.insurerSlug === null)).toBe(true);
  });
});
