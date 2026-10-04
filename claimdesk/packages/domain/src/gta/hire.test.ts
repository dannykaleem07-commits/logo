import { describe, it, expect } from 'vitest';
import { calculateHire, hireDays, offHireDeadline } from './hire.js';
import { mkHire } from './fixtures.js';

describe('hireDays (24-hour periods started)', () => {
  it('10:00 Mon 6 Jul → 10:00 Thu 16 Jul 2026 is exactly 10 days', () => {
    expect(hireDays('2026-07-06T10:00:00+01:00', '2026-07-16T10:00:00+01:00')).toBe(10);
  });
  it('one minute into the next period starts an 11th day', () => {
    expect(hireDays('2026-07-06T10:00:00+01:00', '2026-07-16T10:01:00+01:00')).toBe(11);
  });
  it('a two-hour hire is 1 day; a zero-length hire is 0 days', () => {
    expect(hireDays('2026-07-06T10:00:00+01:00', '2026-07-06T12:00:00+01:00')).toBe(1);
    expect(hireDays('2026-07-06T10:00:00+01:00', '2026-07-06T10:00:00+01:00')).toBe(0);
  });
  it('counts on the London wall clock: a clock change inside the hire neither adds nor removes a day', () => {
    // ADVERSARIAL (was 2): 24 Oct 10:00 BST → 25 Oct 10:00 GMT is 25 real hours but ONE day on the
    // agreement — nobody bills a customer two days for Saturday 10:00 to Sunday 10:00.
    expect(hireDays('2026-10-24T10:00:00+01:00', '2026-10-25T10:00:00+00:00')).toBe(1);
    expect(hireDays('2026-10-24T10:00:00+01:00', '2026-10-25T09:00:00+00:00')).toBe(1);
    expect(hireDays('2026-10-24T10:00:00+01:00', '2026-10-25T10:01:00+00:00')).toBe(2);
    // 20 Oct 10:00 BST → 30 Oct 10:00 GMT: 241 real hours, 10 days on the agreement (was billed as 11).
    expect(hireDays('2026-10-20T10:00:00+01:00', '2026-10-30T10:00:00+00:00')).toBe(10);
    // March: 27 Mar 10:00 GMT → 30 Mar 10:00 BST is 71 real hours, 3 days.
    expect(hireDays('2026-03-27T10:00:00+00:00', '2026-03-30T10:00:00+01:00')).toBe(3);
  });
  it('a 10-day hire spanning the October change at £49.80 bills £498.00 net, not £547.80', () => {
    const r = calculateHire(mkHire({ startAt: '2026-10-20T10:00:00+01:00' }), '2026-10-30T10:00:00+00:00');
    expect(r.days).toBe(10);
    expect(r.hirePence).toBe(49800);
    expect(r.grossPence).toBe(59760);
  });
});

describe('calculateHire', () => {
  it('10 days at £49.80: £498.00 net, £99.60 VAT, £597.60 gross', () => {
    const r = calculateHire(mkHire(), '2026-07-16T10:00:00+01:00');
    expect(r.days).toBe(10);
    expect(r.dailyRatePence).toBe(4980);
    expect(r.hirePence).toBe(49800);
    expect(r.additionalDriverPence).toBe(0);
    expect(r.excessWaiverPence).toBe(0);
    expect(r.netPence).toBe(49800);
    expect(r.vatPence).toBe(9960);
    expect(r.grossPence).toBe(59760);
    expect(r.breakdown).toHaveLength(1);
    expect(r.breakdown[0]).toMatchObject({ code: 'hire', quantity: 10, unitPence: 4980, amountPence: 49800 });
    expect(r.warnings).toEqual([]);
  });
  it('adds the GTA benchmark line (group M 2026–27 £56.66) without asserting it as law', () => {
    const r = calculateHire(mkHire(), '2026-07-16T10:00:00+01:00');
    expect(r.benchmark).toMatchObject({ group: 'M', period: '2026-27', gtaDailyRatePence: 5666, hireAtGtaRatePence: 56660, differencePence: 49800 - 56660 });
    expect(r.benchmark?.note).toMatch(/not a GTA subscriber/);
    expect(r.benchmark?.note).toMatch(/2\.7\(j\)/);
  });
  it('one non-standard-risk additional driver on a 10-day hire: £55.00 (10 × £5.50)', () => {
    const r = calculateHire(mkHire({ additionalDrivers: [{ partyId: 'party_ad', nonStandardRisk: true, evidenceIds: ['evi_licence'] }] }), '2026-07-16T10:00:00+01:00');
    expect(r.additionalDriverPence).toBe(5500);
    expect(r.netPence).toBe(55300);
    expect(r.vatPence).toBe(11060);
    expect(r.grossPence).toBe(66360);
    expect(r.warnings).toEqual([]);
  });
  it('one non-standard-risk additional driver for 25 days is capped at £110 (GTA 5.4)', () => {
    // 25 × £5.50 = £137.50 → capped £110.00; hire 25 × £49.80 = £1,245.00
    const r = calculateHire(mkHire({ additionalDrivers: [{ partyId: 'party_ad', nonStandardRisk: true, evidenceIds: ['evi_licence'] }] }), '2026-07-31T10:00:00+01:00');
    expect(r.days).toBe(25);
    expect(r.hirePence).toBe(124500);
    expect(r.additionalDriverPence).toBe(11000);
    expect(r.netPence).toBe(135500);
    expect(r.vatPence).toBe(27100);
    expect(r.grossPence).toBe(162600);
    const line = r.breakdown.find((b) => b.code === 'additional_driver');
    expect(line).toMatchObject({ quantity: 25, unitPence: 550, amountPence: 11000, partyId: 'party_ad' });
    expect(line?.description).toMatch(/capped at £110\.00/);
  });
  it('the cap is per driver: two non-standard drivers for 25 days = £220', () => {
    const r = calculateHire(
      mkHire({
        additionalDrivers: [
          { partyId: 'ad1', nonStandardRisk: true, evidenceIds: ['e1'] },
          { partyId: 'ad2', nonStandardRisk: true, evidenceIds: ['e2'] },
        ],
      }),
      '2026-07-31T10:00:00+01:00',
    );
    expect(r.additionalDriverPence).toBe(22000);
  });
  it('standard-risk additional drivers are free; unevidenced non-standard drivers are charged with a warning', () => {
    const free = calculateHire(mkHire({ additionalDrivers: [{ partyId: 'ad1', nonStandardRisk: false, evidenceIds: [] }] }), '2026-07-16T10:00:00+01:00');
    expect(free.additionalDriverPence).toBe(0);
    expect(free.warnings).toEqual([]);
    const unevidenced = calculateHire(mkHire({ additionalDrivers: [{ partyId: 'ad1', nonStandardRisk: true, evidenceIds: [] }] }), '2026-07-16T10:00:00+01:00');
    expect(unevidenced.additionalDriverPence).toBe(5500);
    expect(unevidenced.warnings[0]).toMatch(/no supporting evidence/);
  });
  it('charges an excess waiver per day when the agreement has one', () => {
    const r = calculateHire(mkHire({ excessWaiverDailyPence: 500 }), '2026-07-16T10:00:00+01:00');
    expect(r.excessWaiverPence).toBe(5000);
    expect(r.netPence).toBe(54800);
    expect(r.vatPence).toBe(10960);
    expect(r.grossPence).toBe(65760);
  });
  it('uses the agreement end, then opts.asOf for a running hire, and throws with neither', () => {
    const ended = calculateHire(mkHire({ endAt: '2026-07-09T10:00:00+01:00' }));
    expect(ended.days).toBe(3);
    expect(ended.hirePence).toBe(14940);
    expect(ended.vatPence).toBe(2988);
    const running = calculateHire(mkHire(), undefined, { asOf: '2026-07-08T09:00:00+01:00' });
    expect(running.days).toBe(2);
    expect(() => calculateHire(mkHire())).toThrow(/no end/);
  });
  it('an end before the start charges 0 days and warns', () => {
    const r = calculateHire(mkHire(), '2026-07-05T10:00:00+01:00');
    expect(r.days).toBe(0);
    expect(r.grossPence).toBe(0);
    expect(r.warnings[0]).toMatch(/end is before start/);
  });
  it('suppresses the benchmark with an empty rate table or an unknown group, and warns on unverified rates', () => {
    expect(calculateHire(mkHire(), '2026-07-16T10:00:00+01:00', { rates: [] }).benchmark).toBeUndefined();
    expect(calculateHire(mkHire({ gtaGroup: 'ZZ' }), '2026-07-16T10:00:00+01:00').benchmark).toBeUndefined();
    const cp1 = calculateHire(mkHire({ gtaGroup: 'CP1', startAt: '2026-05-01T10:00:00+01:00' }), '2026-05-11T10:00:00+01:00');
    expect(cp1.benchmark?.gtaDailyRatePence).toBe(6464);
    expect(cp1.warnings.some((w) => /unverified/.test(w))).toBe(true);
  });
  it('normalises start/end to London ISO', () => {
    const r = calculateHire(mkHire({ startAt: '2026-07-06T09:00:00Z' }), '2026-07-16T09:00:00Z');
    expect(r.startAt).toBe('2026-07-06T10:00:00+01:00');
    expect(r.endAt).toBe('2026-07-16T10:00:00+01:00');
    expect(r.days).toBe(10);
  });
});

describe('offHireDeadline', () => {
  it('repair complete → 24 hours (GTA 4.8)', () => {
    const d = offHireDeadline('repair_complete_24h', '2026-07-06T15:30:00+01:00');
    expect(d.dueAt).toBe('2026-07-07T15:30:00+01:00');
    expect(d.basis).toMatch(/GTA 4\.8/);
    expect(d.gta).toBe(true);
  });
  it('total-loss payment → 5 working days (GTA 4.14), skipping the Summer bank holiday', () => {
    // Thu 27 Aug 2026 + 5 WD: Fri 28, [Mon 31 BH], Tue 1, Wed 2, Thu 3, Fri 4 Sep
    const d = offHireDeadline('tl_payment_5wd', '2026-08-27T12:00:00+01:00');
    expect(d.dueAt).toBe('2026-09-04T12:00:00+01:00');
    expect(d.basis).toMatch(/GTA 4\.14/);
  });
  it('insurer termination → 1 working day (GTA 4.9): Friday 16:00 → Monday 16:00', () => {
    const d = offHireDeadline('insurer_termination_1wd', '2026-07-03T16:00:00+01:00');
    expect(d.dueAt).toBe('2026-07-06T16:00:00+01:00');
    expect(d.basis).toMatch(/GTA 4\.9/);
  });
  it('cash in lieu stops hire on receipt (GTA 4.7); non-GTA triggers end at the event', () => {
    expect(offHireDeadline('cash_in_lieu', '2026-07-06T14:00:00Z')).toMatchObject({ dueAt: '2026-07-06T15:00:00+01:00', gta: true });
    expect(offHireDeadline('client_returned', '2026-07-06T14:00:00+01:00')).toMatchObject({ dueAt: '2026-07-06T14:00:00+01:00', gta: false });
    expect(offHireDeadline('replacement_purchased', '2026-07-06T14:00:00+01:00').gta).toBe(false);
    expect(offHireDeadline('manual', '2026-07-06T14:00:00+01:00').basis).toMatch(/reason must be recorded/);
  });
  it('every GTA basis carries the non-subscriber caveat', () => {
    for (const t of ['repair_complete_24h', 'tl_payment_5wd', 'insurer_termination_1wd', 'cash_in_lieu'] as const) {
      expect(offHireDeadline(t, '2026-07-06T14:00:00+01:00').basis).toMatch(/benchmark only/);
    }
  });
});
