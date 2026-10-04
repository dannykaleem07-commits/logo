import { describe, it, expect } from 'vitest';
import type { LedgerEntry } from '../types.js';
import { latePaymentUplift, validatePaymentPack, ledgerPaidInFull, paidInFullAt } from './payment.js';
import { compareIso } from '../calendar/index.js';
import { mkBundle, mkDoc, mkEvent, mkEvidence, mkHire, mkRecovery, mkStorage, CLAIM_ID } from './fixtures.js';

const PACK = '2026-07-10T12:00:00+01:00';
const HIRE = '2026-07-06T10:00:00+01:00';

describe('latePaymentUplift (GTA 6.8.6, benchmark only)', () => {
  it('day 30 → 0%, day 31 → 10%, day 60 → 10%, day 61 → 20%', () => {
    expect(latePaymentUplift(100000, PACK, '2026-08-09T12:00:00+01:00', HIRE)).toMatchObject({ pct: 0, upliftPence: 0, tier: 'none', daysSincePack: 30, applicable: true });
    expect(latePaymentUplift(100000, PACK, '2026-08-10T12:00:00+01:00', HIRE)).toMatchObject({ pct: 10, upliftPence: 10000, tier: '10pc_day31', daysSincePack: 31 });
    expect(latePaymentUplift(100000, PACK, '2026-09-08T12:00:00+01:00', HIRE)).toMatchObject({ pct: 10, upliftPence: 10000, daysSincePack: 60 });
    expect(latePaymentUplift(100000, PACK, '2026-09-09T12:00:00+01:00', HIRE)).toMatchObject({ pct: 20, upliftPence: 20000, tier: '20pc_day61', daysSincePack: 61 });
  });
  it('always says benchmark only and names 6.8.6', () => {
    const r = latePaymentUplift(100000, PACK, '2026-09-09T12:00:00+01:00', HIRE);
    expect(r.benchmarkOnly).toBe(true);
    expect(r.basis).toBe('GTA 6.8.6 — benchmark only, CCGUK is not a subscriber');
  });
  it('counts London calendar dates, so an earlier time of day on day 31 still counts as day 31', () => {
    expect(latePaymentUplift(100000, PACK, '2026-08-10T08:00:00+01:00', HIRE).pct).toBe(10);
  });
  it('does not apply to hires that commenced before 16 March 2026', () => {
    const r = latePaymentUplift(100000, PACK, '2026-09-09T12:00:00+01:00', '2026-03-15T10:00:00+00:00');
    expect(r).toMatchObject({ pct: 0, upliftPence: 0, applicable: false });
    expect(r.reason).toMatch(/before 2026-03-16/);
    expect(latePaymentUplift(100000, PACK, '2026-09-09T12:00:00+01:00', '2026-03-16T10:00:00+00:00').applicable).toBe(true);
  });
  it('reports the day-31 and day-61 instants (00:00 London on those days) and rounds the uplift to the penny', () => {
    const r = latePaymentUplift(12345, PACK, '2026-08-10T12:00:00+01:00', HIRE);
    expect(r.day31At).toBe('2026-08-10T00:00:00+01:00');
    expect(r.day61At).toBe('2026-09-09T00:00:00+01:00');
    expect(r.upliftPence).toBe(1235); // 1234.5 → 1235
  });
  it('ADVERSARIAL: pct and day31At can never disagree — 08:00 on day 31 is 10% and is after day31At; 23:00 on day 30 is 0% and before it', () => {
    const early = latePaymentUplift(100000, PACK, '2026-08-10T08:00:00+01:00', HIRE);
    expect(early.pct).toBe(10);
    expect(compareIso('2026-08-10T08:00:00+01:00', early.day31At)).toBeGreaterThanOrEqual(0);
    const late30 = latePaymentUplift(100000, PACK, '2026-08-09T23:00:00+01:00', HIRE);
    expect(late30.pct).toBe(0);
    expect(compareIso('2026-08-09T23:00:00+01:00', late30.day31At)).toBeLessThan(0);
    // Pack sent 23:30 UTC on 10 Jul = 00:30 BST on 11 Jul: the pack DAY is 11 Jul, so day 31 is 11 Aug.
    expect(latePaymentUplift(100000, '2026-07-10T23:30:00Z', '2026-08-10T12:00:00+01:00', HIRE).pct).toBe(0);
    expect(latePaymentUplift(100000, '2026-07-10T23:30:00Z', '2026-08-11T00:00:00+01:00', HIRE)).toMatchObject({ pct: 10, day31At: '2026-08-11T00:00:00+01:00' });
  });
});

describe('validatePaymentPack (GTA 6.1–6.3)', () => {
  it('lists exactly the five universal items as missing on an empty file, and the accounts as not applicable', () => {
    const v = validatePaymentPack(mkBundle());
    expect(v.complete).toBe(false);
    expect(v.missing).toEqual(['covering_letter', 'mitigation_questionnaire', 'advice_form', 'hire_period_validation_form', 'engineer_report']);
    expect(v.present).toEqual([]);
    expect(v.notApplicable).toEqual(['storage_account', 'recovery_account', 'hire_invoice']);
    expect(v.basis).toMatch(/GTA 6\.1–6\.3/);
    expect(v.basis).toMatch(/benchmark only/);
  });
  it('requires the storage, recovery and hire accounts when the file has those records, and treats drafts as missing', () => {
    const bundle = mkBundle({
      hire: [mkHire()],
      storage: [mkStorage()],
      recovery: [mkRecovery()],
      documents: [
        mkDoc('pack.gta_payment', 'approved'),
        mkDoc('form.mitigation_questionnaire', 'sent'),
        mkDoc('letter.ncaf', 'sent'),
        mkDoc('report.engineer', 'approved'),
        mkDoc('invoice.hire', 'approved'),
        mkDoc('invoice.storage', 'draft'),
      ],
    });
    const v = validatePaymentPack(bundle);
    expect(v.complete).toBe(false);
    expect(v.missing).toEqual(['hire_period_validation_form', 'storage_account', 'recovery_account']);
    expect(v.draftOnly).toEqual(['storage_account']);
    expect(v.present).toEqual(['covering_letter', 'mitigation_questionnaire', 'advice_form', 'engineer_report', 'hire_invoice']);
    expect(v.notApplicable).toEqual([]);
    expect(v.details.find((d) => d.item === 'storage_account')).toMatchObject({ status: 'draft_only' });
  });
  it('is complete once every required item exists in a final status', () => {
    const bundle = mkBundle({
      hire: [mkHire()],
      storage: [mkStorage()],
      recovery: [mkRecovery()],
      documents: [
        mkDoc('pack.gta_payment', 'sent'),
        mkDoc('form.mitigation_questionnaire', 'signed'),
        mkDoc('letter.ncaf', 'sent'),
        mkDoc('form.hire_period_validation', 'approved'),
        mkDoc('report.engineer', 'approved'),
        mkDoc('invoice.hire', 'approved'),
        mkDoc('invoice.storage', 'approved'),
        mkDoc('invoice.recovery', 'sent'),
      ],
    });
    const v = validatePaymentPack(bundle);
    expect(v.complete).toBe(true);
    expect(v.missing).toEqual([]);
    expect(v.draftOnly).toEqual([]);
    expect(v.present).toHaveLength(8);
  });
  it('accepts hard evidence: an ncaf_sent event, an uploaded engineer report, a hire-period form upload', () => {
    const bundle = mkBundle({
      events: [mkEvent('ncaf_sent', '2026-07-02T09:00:00+01:00', { id: 'ev_ncaf' })],
      evidence: [mkEvidence('engineer_report', { id: 'evi_rep' }), mkEvidence('pdf', { id: 'evi_hpvf', description: 'Signed Hire Period Validation Form' })],
    });
    const v = validatePaymentPack(bundle);
    expect(v.present).toEqual(['advice_form', 'hire_period_validation_form', 'engineer_report']);
    expect(v.missing).toEqual(['covering_letter', 'mitigation_questionnaire']);
    expect(v.details.find((d) => d.item === 'advice_form')?.satisfiedBy).toEqual(['event:ev_ncaf']);
    expect(v.details.find((d) => d.item === 'engineer_report')?.satisfiedBy).toEqual(['evidence:evi_rep']);
  });
  it('ignores void and superseded documents', () => {
    const v = validatePaymentPack(mkBundle({ documents: [mkDoc('pack.gta_payment', 'void'), mkDoc('report.engineer', 'superseded')] }));
    expect(v.missing).toContain('covering_letter');
    expect(v.missing).toContain('engineer_report');
    expect(v.draftOnly).toEqual([]);
  });
});

describe('ledgerPaidInFull / paidInFullAt (File 1: £1,287 invoiced, £1,112 received)', () => {
  const entry = (kind: LedgerEntry['kind'], amountPence: number, date: string, id = `led_${kind}_${amountPence}`): LedgerEntry => ({
    id,
    claimId: CLAIM_ID,
    head: 'hire',
    kind,
    amountPence,
    date,
    description: kind,
    createdBy: 'system',
    createdAt: `${date}T10:00:00+01:00`,
  });
  it('£1,112 against £1,287 is not paid in full; £1,287 is', () => {
    expect(ledgerPaidInFull({ ledger: [entry('invoiced', 128700, '2026-07-10'), entry('paid', 111200, '2026-08-01')] }, '2026-08-02T00:00:00+01:00')).toBe(false);
    expect(ledgerPaidInFull({ ledger: [entry('invoiced', 128700, '2026-07-10'), entry('paid', 128700, '2026-08-01')] }, '2026-08-02T00:00:00+01:00')).toBe(true);
  });
  it('only counts payments dated on or before asOf, and nets off write-offs', () => {
    const ledger = [entry('invoiced', 128700, '2026-07-10'), entry('paid', 111200, '2026-08-01'), entry('written_off', 17500, '2026-08-05')];
    expect(ledgerPaidInFull({ ledger }, '2026-07-31T00:00:00+01:00')).toBe(false);
    expect(ledgerPaidInFull({ ledger }, '2026-08-06T00:00:00+01:00')).toBe(true);
    expect(ledgerPaidInFull({ ledger: [] }, '2026-08-06T00:00:00+01:00')).toBe(false);
  });
  it('paidInFullAt returns the instant of the first payment event that settles the account', () => {
    const ledger = [entry('invoiced', 128700, '2026-07-10'), entry('paid', 111200, '2026-08-01'), entry('paid', 17500, '2026-08-20')];
    const events = [mkEvent('payment_received', '2026-08-01T11:00:00+01:00'), mkEvent('payment_received', '2026-08-20T11:00:00+01:00', { id: 'ev_pay_final' })];
    expect(paidInFullAt({ ledger, events }, '2026-08-10T00:00:00+01:00')).toBeUndefined();
    expect(paidInFullAt({ ledger, events }, '2026-08-21T00:00:00+01:00')).toBe('2026-08-20T11:00:00+01:00');
    const flagged = [mkEvent('payment_received', '2026-08-01T11:00:00+01:00', { data: { inFull: true } })];
    expect(paidInFullAt({ ledger: [], events: flagged }, '2026-08-21T00:00:00+01:00')).toBe('2026-08-01T11:00:00+01:00');
  });
});
