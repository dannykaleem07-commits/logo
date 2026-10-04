import { describe, it, expect } from 'vitest';
import {
  scheduleOfLoss,
  interest,
  courtFee,
  defaultCourtFees,
  allocateTrack,
  trackAllocation,
  settlementArithmetic,
  expectedValue,
  settlementDelayDiscount,
  part36,
  SCHEDULE_HEAD_ORDER,
  type FeeBand,
} from './index.js';
import { file1Bundle, ledger } from '../playbook/fixture.js';
import { formatGBP } from '../money.js';

describe('interest', () => {
  it('1 year on £10,000 at the 8% s.69 convention = £800.00 (365 days)', () => {
    const r = interest({ principalPence: 1_000_000, from: '2025-01-01', to: '2026-01-01', basis: 'cca_s69' });
    expect(r.days).toBe(365);
    expect(r.annualRatePct).toBe(8);
    expect(r.interestPence).toBe(80_000);
    expect(r.dailyPence).toBe(219); // 1,000,000 × 8% / 365 = 219.18p
    expect(r.citation).toBe('County Courts Act 1984 s.69');
    expect(r.note).toContain("court's discretion");
    expect(r.note).toContain('litigant in person');
  });

  it('an explicit rate overrides the 8% convention and says it must be justified', () => {
    const r = interest({ principalPence: 1_000_000, from: '2025-01-01', to: '2026-01-01', basis: 'sca_s35a', annualRatePct: 4 });
    expect(r.interestPence).toBe(40_000);
    expect(r.note).toContain('Senior Courts Act 1981 s.35A');
    expect(r.note).toContain('must be justified');
  });

  it('ICOBS 8.2: base 4% + 4% = 8%, with the scope caveat', () => {
    const r = interest({ principalPence: 1_000_000, from: '2025-01-01', to: '2026-01-01', basis: 'icobs_8_2', baseRatePct: 4 });
    expect(r.annualRatePct).toBe(8);
    expect(r.interestPence).toBe(80_000);
    expect(r.note).toContain('ICOBS 8.2.1R');
    expect(r.note).toContain('three-month period');
    expect(() => interest({ principalPence: 1, from: '2025-01-01', to: '2026-01-01', basis: 'icobs_8_2' })).toThrow(/baseRatePct/);
  });

  it('LPCDIA 1998: base 4% + 8% = 12%, B2B only; £5,000 for 30 days = £49.32', () => {
    // 500,000 × 12% × 30 / 365 = 4,931.5p → 4,932p
    const r = interest({ principalPence: 500_000, from: '2026-09-01', to: '2026-10-01', basis: 'lpcdia_1998', baseRatePct: 4 });
    expect(r.days).toBe(30);
    expect(r.annualRatePct).toBe(12);
    expect(r.interestPence).toBe(4_932);
    expect(r.note).toContain('Business-to-business debts only');
    expect(r.note).toContain('not available against an at-fault insurer');
  });

  it('to before from gives zero days and zero interest; works across a leap year by calendar days', () => {
    expect(interest({ principalPence: 100_000, from: '2026-02-01', to: '2026-01-01', basis: 'cca_s69' })).toMatchObject({ days: 0, interestPence: 0 });
    // 2028 is a leap year: 366 days at 8% on £10,000 = 80,219p
    expect(interest({ principalPence: 1_000_000, from: '2028-01-01', to: '2029-01-01', basis: 'cca_s69' })).toMatchObject({ days: 366, interestPence: 80_219 });
  });
});

describe('courtFee', () => {
  it('blueprint issue fee bands: £4,500 → £205, £7,000 → £455, £15,000 → £750 (5%)', () => {
    expect(courtFee(450_000).feePence).toBe(20_500);
    expect(courtFee(700_000).feePence).toBe(45_500);
    expect(courtFee(1_500_000).feePence).toBe(75_000);
  });

  it('band edges: £300 → £35; £300.01 → £50; £10,000 → £455; £10,000.01 → £500.00 (5%); over £200,000 → £10,000 cap', () => {
    expect(courtFee(30_000).feePence).toBe(3_500);
    expect(courtFee(30_001).feePence).toBe(5_000);
    expect(courtFee(1_000_000).feePence).toBe(45_500);
    expect(courtFee(1_000_001).feePence).toBe(50_000);
    expect(courtFee(25_000_000).feePence).toBe(1_000_000);
    expect(courtFee(0).feePence).toBe(3_500);
  });

  it('small claims hearing fees: £250 → £27, £2,000 → £181, £3,500 → £346', () => {
    expect(courtFee(25_000, defaultCourtFees, { kind: 'hearing_small_claims' }).feePence).toBe(2_700);
    expect(courtFee(200_000, defaultCourtFees, { kind: 'hearing_small_claims' }).feePence).toBe(18_100);
    expect(courtFee(350_000, defaultCourtFees, { kind: 'hearing_small_claims' }).feePence).toBe(34_600);
  });

  it('every default band is unverified and says to confirm against EX50; the result carries it', () => {
    for (const b of defaultCourtFees) {
      expect(b.verification.status).toBe('unverified');
      expect(b.verification.sourceNote).toContain('EX50');
    }
    const r = courtFee(450_000);
    expect(r.verification.status).toBe('unverified');
    expect(r.note).toContain('Verification: unverified');
    expect(r.kind).toBe('issue');
  });

  it('an injected (verified) table wins over the default and percentage caps apply', () => {
    const table: FeeBand[] = [
      { kind: 'issue', fromPence: 0, toPence: 1_000_000, feePence: 9_999, verification: { status: 'verified', sourceUrl: 'https://www.gov.uk/government/publications/fees-in-the-civil-and-family-courts-main-fees-ex50' } },
      { kind: 'issue', fromPence: 1_000_001, toPence: Number.MAX_SAFE_INTEGER, pct: 5, capPence: 100_000, verification: { status: 'verified' } },
    ];
    expect(courtFee(450_000, table)).toMatchObject({ feePence: 9_999, verification: { status: 'verified' } });
    expect(courtFee(5_000_000, table).feePence).toBe(100_000);
    expect(() => courtFee(1, [])).toThrow(/no issue fee band/);
    expect(() => courtFee(-1)).toThrow();
  });
});

describe('allocateTrack', () => {
  it('£9,999 small claims, £10,000 small claims, £10,001 fast', () => {
    expect(allocateTrack(999_900)).toBe('small_claims');
    expect(allocateTrack(1_000_000)).toBe('small_claims');
    expect(allocateTrack(1_000_100)).toBe('fast');
  });

  it('fast to £25,000, intermediate to £100,000, otherwise multi', () => {
    expect(allocateTrack(2_500_000)).toBe('fast');
    expect(allocateTrack(2_500_001)).toBe('intermediate');
    expect(allocateTrack(10_000_000)).toBe('intermediate');
    expect(allocateTrack(10_000_001)).toBe('multi');
  });

  it('trackAllocation carries the limit, the lay-representative note and the PI refer-out note', () => {
    const small = trackAllocation(500_000, { personalInjury: true });
    expect(small.limitPence).toBe(1_000_000);
    expect(small.note).toContain('Lay Representatives');
    expect(small.note).toContain('LASPO 2012 ss.56–60');
    expect(trackAllocation(20_000_000).limitPence).toBeUndefined();
    expect(() => allocateTrack(-5)).toThrow();
  });
});

describe('settlementArithmetic (money.md §4)', () => {
  it('worked example: accept £6,000 now beats fighting for £9,000 at 50%', () => {
    const r = settlementArithmetic({
      offerPence: 600_000,
      costsIncurredPence: 50_000,
      pBetter: 0.5,
      expectedBetterPence: 900_000,
      extraCostPence: 80_000,
      delayMonths: 6,
      pWorse: 0.2,
      worsePence: 150_000,
    });
    // accept now = 600,000 − 50,000 = 550,000
    expect(r.acceptNowPence).toBe(550_000);
    // fight gross = 0.5 × 900,000 = 450,000
    expect(r.fightGrossPence).toBe(450_000);
    // time value = 450,000 × (1 − 1.01^−6) = 450,000 × 0.0579548 = 26,079.7 → 26,080
    expect(r.timeValuePence).toBe(26_080);
    // downside = 0.2 × 150,000 = 30,000
    expect(r.downsidePence).toBe(30_000);
    // fight on = 450,000 − 80,000 − 26,080 − 30,000 − 50,000 = 263,920
    expect(r.fightOnPence).toBe(263_920);
    // walk-away = fight on + sunk costs = 313,920
    expect(r.walkAwayPence).toBe(313_920);
    expect(r.recommendation).toBe('accept');
    expect(r.note).toContain('Walk-away number £3,139.20');
  });

  it('a small gap recommends a counter with a 14-day cleared-funds discount; a large gap recommends fighting', () => {
    const base = { offerPence: 600_000, costsIncurredPence: 0, extraCostPence: 10_000, delayMonths: 0, pWorse: 0, worsePence: 0 };
    const counter = settlementArithmetic({ ...base, pBetter: 0.8, expectedBetterPence: 800_000 });
    // fight on = 640,000 − 10,000 = 630,000; gap 30,000 ≤ 10% of 600,000
    expect(counter.fightOnPence).toBe(630_000);
    expect(counter.recommendation).toBe('counter');
    expect(counter.note).toContain('14 days');
    const fight = settlementArithmetic({ ...base, pBetter: 0.9, expectedBetterPence: 1_000_000 });
    // fight on = 900,000 − 10,000 = 890,000; gap 290,000
    expect(fight.fightOnPence).toBe(890_000);
    expect(fight.recommendation).toBe('fight');
  });

  it('delay discount and probability validation', () => {
    expect(settlementDelayDiscount(0, 0.01)).toBe(0);
    expect(settlementDelayDiscount(12, 0.01)).toBeCloseTo(1 - 1 / Math.pow(1.01, 12), 10);
    expect(() => settlementArithmetic({ offerPence: 1, costsIncurredPence: 0, pBetter: 1.2, expectedBetterPence: 1, extraCostPence: 0, delayMonths: 0, pWorse: 0, worsePence: 0 })).toThrow(/pBetter/);
    expect(() => settlementArithmetic({ offerPence: 1, costsIncurredPence: 0, pBetter: 0.7, expectedBetterPence: 1, extraCostPence: 0, delayMonths: 0, pWorse: 0.5, worsePence: 0 })).toThrow(/cannot exceed 1/);
  });
});

describe('expectedValue (money.md §1)', () => {
  it('take: 70% × £4,000 × 25% + £150 − 6h × £60 − £20 − 10% × (£150 + 2h × £60) = £443.00', () => {
    const r = expectedValue({
      pWin: 0.7,
      recoveryPence: 400_000,
      ourRate: 0.25,
      fixedFeesPence: 15_000,
      hours: 6,
      loadedHourlyPence: 6_000,
      disbursementsPence: 2_000,
      pComplaint: 0.1,
      refundPence: 15_000,
      remedialHours: 2,
    });
    expect(r.components).toEqual({ successFeePence: 70_000, fixedFeesPence: 15_000, labourCostPence: 36_000, disbursementsPence: 2_000, complaintCostPence: 2_700 });
    expect(r.evPence).toBe(44_300);
    expect(r.recommendation).toBe('take');
  });

  it('decline when the file costs more than it earns; reprice on a thin margin', () => {
    const decline = expectedValue({ pWin: 0.3, recoveryPence: 100_000, ourRate: 0.25, fixedFeesPence: 0, hours: 14, loadedHourlyPence: 6_000, disbursementsPence: 0, pComplaint: 0, refundPence: 0 });
    expect(decline.evPence).toBe(7_500 - 84_000);
    expect(decline.recommendation).toBe('decline');
    // EV 2,000 on a cost base of 36,000 (5.6%) → reprice
    const thin = expectedValue({ pWin: 1, recoveryPence: 38_000, ourRate: 1, fixedFeesPence: 0, hours: 6, loadedHourlyPence: 6_000, disbursementsPence: 0, pComplaint: 0, refundPence: 0 });
    expect(thin.evPence).toBe(2_000);
    expect(thin.recommendation).toBe('reprice');
  });
});

describe('part36', () => {
  it('21 days from service, expiring at the end of the last day (clock change on 25 Oct 2026 handled)', () => {
    const r = part36({ offerPence: 500_000, madeAt: '2026-10-05T10:00:00+01:00' });
    expect(r.relevantPeriodDays).toBe(21);
    expect(r.expiresAt).toBe('2026-10-26T23:59:59+00:00');
    expect(r.basis).toContain('CPR 36.5(1)(c)');
    expect(r.basis).toContain('CPR 36.17(4)');
    expect(r.note).toContain('litigant in person');
  });

  it('a period under 21 days is lifted to 21; a defendant offer cites CPR 36.17(3)', () => {
    const r = part36({ offerPence: 500_000, madeAt: '2026-07-01T09:00:00+01:00', relevantPeriodDays: 14, by: 'defendant' });
    expect(r.relevantPeriodDays).toBe(21);
    expect(r.expiresAt).toBe('2026-07-22T23:59:59+01:00');
    expect(r.note).toContain('lifted to the 21-day minimum');
    expect(r.basis).toContain('CPR 36.17(3)');
    expect(part36({ offerPence: 1, madeAt: '2026-07-01T09:00:00+01:00', relevantPeriodDays: 28 }).expiresAt).toBe('2026-07-29T23:59:59+01:00');
  });
});

describe('scheduleOfLoss', () => {
  it('File 1: £1,344.60 claimed in four heads, £1,112.00 received, £232.60 outstanding on hire', () => {
    const s = scheduleOfLoss(file1Bundle(), '2026-10-20T12:00:00+01:00');
    expect(s.asOf).toBe('2026-10-20');
    expect(s.lines.map((l) => l.head)).toEqual(['recovery', 'storage', 'hire', 'engineer_fee']);
    const hire = s.lines.find((l) => l.head === 'hire')!;
    expect(hire).toMatchObject({ netPence: 49_800, vatPence: 9_960, claimedPence: 59_760, paidPence: 36_500, outstandingPence: 23_260, sourceDocumentId: 'doc-hire-invoice' });
    expect(hire.description).toBe('Hire 10 days @ £49.80');
    expect(s.totals).toEqual({ claimed: 134_460, offered: 0, paid: 111_200, outstanding: 23_260 });
    expect(s.notes.some((n) => n.includes('Interest is not yet on the schedule'))).toBe(true);
    expect(s.notes.some((n) => n.includes('benchmark only'))).toBe(true);
  });

  it('is the position at time T: payments dated after now are not counted', () => {
    const s = scheduleOfLoss(file1Bundle(), '2026-10-03T12:00:00+01:00'); // remittance dated 2026-10-05
    expect(s.totals.paid).toBe(0);
    expect(s.totals.outstanding).toBe(134_460);
  });

  it('salvage is a credit; superseded entries are excluded; offers and reductions are carried; interest is computed on the outstanding total', () => {
    const b = file1Bundle();
    b.ledger = ledger([
      { head: 'pav', kind: 'claimed', amountPence: 350_000, description: 'PAV £3,500', sourceEvidenceId: 'ev-pav-report' },
      { head: 'salvage', kind: 'claimed', amountPence: 50_000, description: 'Salvage retained £500' },
      { head: 'hire', kind: 'claimed', amountPence: 50_000, vatPence: 10_000, description: 'Hire (wrong days)' },
      { head: 'hire', kind: 'claimed', amountPence: 49_800, vatPence: 9_960, description: 'Hire 10 days @ £49.80', supersedesId: 'led-3' },
      { head: 'hire', kind: 'offered', amountPence: 20_370, description: 'esure offer at £20.37/day' },
      { head: 'hire', kind: 'reduced', amountPence: 39_390, description: 'Reduced to intervention rate' },
      { head: 'pav', kind: 'paid', amountPence: 300_000, description: 'PAV paid' },
      { head: 'engineer_fee', kind: 'invoiced', amountPence: 28_500, description: 'Engineer invoice (no claimed entry)' },
      { head: 'engineer_fee', kind: 'written_off', amountPence: 28_500, description: 'Fee refused and written off' },
    ]);
    const s = scheduleOfLoss(b, '2026-10-21T09:00:00+01:00', { interest: { basis: 'cca_s69', from: '2026-09-21' } });
    expect(s.lines.map((l) => l.head)).toEqual(['pav', 'salvage', 'hire', 'engineer_fee']);
    const salvage = s.lines.find((l) => l.head === 'salvage')!;
    expect(salvage.claimedPence).toBe(-50_000);
    expect(salvage.outstandingPence).toBe(-50_000);
    const hire = s.lines.find((l) => l.head === 'hire')!;
    expect(hire.claimedPence).toBe(59_760); // the superseded £600 line is gone
    expect(hire.offeredPence).toBe(20_370);
    expect(hire.reducedPence).toBe(39_390);
    expect(hire.entryIds).not.toContain('led-3'); // the superseded row is dropped
    expect(hire.entryIds).toContain('led-4'); // the correcting row remains
    const eng = s.lines.find((l) => l.head === 'engineer_fee')!;
    expect(eng).toMatchObject({ claimedPence: 28_500, writtenOffPence: 28_500, outstandingPence: 0 });
    const pav = s.lines.find((l) => l.head === 'pav')!;
    expect(pav).toMatchObject({ claimedPence: 350_000, paidPence: 300_000, outstandingPence: 50_000, sourceEvidenceId: 'ev-pav-report' });
    // totals: claimed 350,000 − 50,000 + 59,760 + 28,500 = 388,260; paid 300,000; outstanding 50,000 − 50,000 + 59,760 + 0 = 59,760
    expect(s.totals).toEqual({ claimed: 388_260, offered: 20_370, paid: 300_000, outstanding: 59_760 });
    // interest: 59,760 × 8% × 30 days / 365 = 392.94p → 393p
    expect(s.interest).toMatchObject({ days: 30, annualRatePct: 8, interestPence: 393 });
    expect(s.notes.some((n) => n.startsWith('Salvage is shown as a credit'))).toBe(true);
    expect(s.notes.some((n) => n.includes('No source document against: Salvage (credit), Credit hire charges, Engineer\'s fee'))).toBe(true);
  });

  it('an empty ledger gives an empty schedule and no interest', () => {
    const b = file1Bundle({ ledger: [] });
    const s = scheduleOfLoss(b, '2026-10-20T12:00:00+01:00', { interest: { basis: 'cca_s69', from: '2026-09-21' } });
    expect(s.lines).toEqual([]);
    expect(s.totals).toEqual({ claimed: 0, offered: 0, paid: 0, outstanding: 0 });
    expect(s.interest).toBeUndefined();
    expect(SCHEDULE_HEAD_ORDER).toHaveLength(17);
  });
});

// ---------------------------------------------------------------------------------------------
// Adversarial verification — hand-computed figures, BST/GMT edges, money formatting in notes.
// ---------------------------------------------------------------------------------------------
describe('adversarial: quantum', () => {
  it('interest counts London calendar days, not UTC days (00:30 BST on 1 Jul is 23:30 UTC on 30 Jun)', () => {
    // London: 1 Jul → 31 Jul = 30 days. UTC would make it 30 Jun → 31 Jul = 31 days.
    const r = interest({ principalPence: 100_000, from: '2026-07-01T00:30:00+01:00', to: '2026-07-31T12:00:00+01:00', basis: 'cca_s69' });
    expect(r.days).toBe(30);
    expect(r.interestPence).toBe(658); // 100,000 × 8% × 30 / 365 = 657.53p → 658p
    expect(r.dailyPence).toBe(22); // 100,000 × 8% / 365 = 21.92p
  });

  it('ICOBS interest from the three-month expiry: NCAF 21 Sep 2026 → expiry 21 Dec 2026 → 30 days to 20 Jan 2027 on £232.60 at 4% + 4% = £1.53', () => {
    // 23,260 × 8% × 30 / 365 = 152.94p → 153p (matches the playbook ICOBS_INTEREST_CLAIM estimate)
    const r = interest({ principalPence: 23_260, from: '2026-12-21T16:00:00+00:00', to: '2027-01-20T12:00:00+00:00', basis: 'icobs_8_2', baseRatePct: 4 });
    expect(r.days).toBe(30);
    expect(r.interestPence).toBe(153);
    expect(r.note).toContain('ICOBS 8.2.1R');
  });

  it('court fee notes format money with formatGBP (thousands separators), never bare floats', () => {
    const r = courtFee(450_000);
    expect(r.note).toContain('Issue fee for a claim of £4,500.00');
    expect(r.note).toContain('£3,000.01–£5,000.00');
    expect(r.note).not.toMatch(/£\d{4}/);
    expect(courtFee(1_500_000).note).toContain('£15,000.00');
    expect(courtFee(350_000, defaultCourtFees, { kind: 'hearing_small_claims' }).note).toContain('£3,000.01–no upper limit');
  });

  it('Part 36 across the March clock change: served 20 Mar 2026 (GMT) expires 10 Apr 2026 at 23:59:59 BST, and the additional amount is stated correctly', () => {
    const r = part36({ offerPence: 500_000, madeAt: '2026-03-20T10:00:00+00:00' });
    expect(r.expiresAt).toBe('2026-04-10T23:59:59+01:00'); // 20 Mar + 21 days = 10 Apr; BST from 29 Mar 2026
    expect(r.note).toContain('10% of the first £500,000');
    expect(r.note).toContain('capped at £75,000');
    expect(r.note).not.toContain('10% of the sum awarded');
  });

  it('File 1 schedule says £1,112.00 received — never £1,287 — and every figure is integer pence', () => {
    const s = scheduleOfLoss(file1Bundle(), '2026-10-20T12:00:00+01:00');
    expect(s.totals.paid).toBe(111_200);
    expect(s.totals.paid).not.toBe(128_700);
    expect(formatGBP(s.totals.paid)).toBe('£1,112.00');
    expect(formatGBP(s.totals.outstanding)).toBe('£232.60');
    expect(s.totals.claimed - s.totals.paid).toBe(s.totals.outstanding);
    for (const l of s.lines) {
      expect(Number.isInteger(l.claimedPence)).toBe(true);
      expect(Number.isInteger(l.outstandingPence)).toBe(true);
      expect(l.claimedPence).toBe(l.netPence + l.vatPence);
    }
    // the schedule as at the London date of a BST instant just after midnight still excludes the 5 Oct remittance
    expect(scheduleOfLoss(file1Bundle(), '2026-10-05T00:30:00+01:00').totals.paid).toBe(111_200); // 5 Oct London → remittance dated 5 Oct counts
    expect(scheduleOfLoss(file1Bundle(), '2026-10-04T23:30:00+01:00').totals.paid).toBe(0); // 4 Oct London → not yet
  });

  it('track boundaries in pence: £10,000.00 small claims, £10,000.01 fast; NaN is refused', () => {
    expect(allocateTrack(1_000_000)).toBe('small_claims');
    expect(allocateTrack(1_000_001)).toBe('fast');
    expect(allocateTrack(2_500_000)).toBe('fast');
    expect(allocateTrack(2_500_001)).toBe('intermediate');
    expect(() => allocateTrack(Number.NaN)).toThrow();
  });
});
