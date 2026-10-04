import { describe, it, expect } from 'vitest';
import { defaultRateCard, recoveryCharge, storageCharge, storageDays } from './ratecard.js';
import { mkRecovery, mkStorage } from './fixtures.js';

describe('recoveryCharge (£90 + £3/loaded mile + £25, plus VAT)', () => {
  it('12 loaded miles: £90 + £36 + £25 = £151.00 net, £30.20 VAT, £181.20 gross', () => {
    const r = recoveryCharge(mkRecovery({ loadedMiles: 12 }));
    expect(r).toMatchObject({ calloutPence: 9000, mileagePence: 3600, adminPence: 2500, netPence: 15100, vatPence: 3020, grossPence: 18120 });
    expect(r.breakdown.map((b) => b.amountPence)).toEqual([9000, 3600, 2500]);
  });
  it('zero miles is still call-out plus admin (£115.00)', () => {
    expect(recoveryCharge({ loadedMiles: 0 }).netPence).toBe(11500);
  });
  it('fills missing fields from the rate card and rounds fractional miles to the penny', () => {
    expect(defaultRateCard).toMatchObject({ recoveryCalloutPence: 9000, recoveryPerLoadedMilePence: 300, recoveryAdminPence: 2500, storageDailyPence: 4500 });
    expect(recoveryCharge({ loadedMiles: 12.5 }).mileagePence).toBe(3750);
    expect(recoveryCharge({ loadedMiles: 10, calloutPence: 12000, perLoadedMilePence: 350, adminPence: 0, vatRate: 0 })).toMatchObject({ netPence: 15500, vatPence: 0, grossPence: 15500 });
  });
});

describe('storageCharge (£45/day plus VAT)', () => {
  it('10 full days: £450.00 net, £90.00 VAT, £540.00 gross', () => {
    const s = storageCharge(mkStorage({ startAt: '2026-07-06T10:00:00+01:00' }), '2026-07-16T10:00:00+01:00');
    expect(s).toMatchObject({ days: 10, dailyRatePence: 4500, netPence: 45000, vatPence: 9000, grossPence: 54000, convention: 'periods_24h' });
  });
  it('any part of a 24-hour period counts as a day', () => {
    expect(storageCharge(mkStorage({ startAt: '2026-07-06T10:00:00+01:00' }), '2026-07-16T10:01:00+01:00').days).toBe(11);
  });
  it('the calendar_days convention counts every date touched, inclusive', () => {
    expect(storageDays('2026-07-06T10:00:00+01:00', '2026-07-16T10:00:00+01:00', 'calendar_days')).toBe(11);
    expect(storageCharge(mkStorage({ startAt: '2026-07-06T10:00:00+01:00' }), '2026-07-16T10:00:00+01:00', { convention: 'calendar_days' }).netPence).toBe(49500);
  });
  it('File 2 cap: storage from 1 Jul 09:00 to report + 48h (12 Jul 15:00) is 12 days = £540.00 net', () => {
    const s = storageCharge(mkStorage({ startAt: '2026-07-01T09:00:00+01:00' }), '2026-07-12T15:00:00+01:00');
    expect(s.days).toBe(12);
    expect(s.netPence).toBe(54000);
    expect(s.grossPence).toBe(64800);
  });
  it('uses the record end when no override is given and throws when there is none', () => {
    expect(storageCharge(mkStorage({ startAt: '2026-07-01T09:00:00+01:00', endAt: '2026-07-03T09:00:00+01:00' })).days).toBe(2);
    expect(() => storageCharge(mkStorage())).toThrow(/no end date/);
  });
});
