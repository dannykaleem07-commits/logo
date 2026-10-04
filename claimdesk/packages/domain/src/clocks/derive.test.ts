import { describe, it, expect } from 'vitest';
import type { Clock, ClockKind, InterventionOffer } from '../types.js';
import { deriveClocks, clockStatus, dueClocks, FOS_NOT_OPEN_REASON } from './derive.js';
import { clockDefinitions, clockKinds } from './definitions.js';
import { latePaymentUplift } from '../gta/payment.js';
import { mkBundle, mkEvent, mkHire, mkStorage, CLAIM_ID } from '../gta/fixtures.js';

// Calendar anchors (2026): Wed 1 Jul, Thu 2, Fri 3, Mon 6, Tue 7, Wed 8, Thu 9, Fri 10, Mon 13 … Mon 27 Jul.
const T = {
  fnol: '2026-07-01T09:30:00+01:00',
  agreed: '2026-07-01T11:00:00+01:00',
  ncaf: '2026-07-02T10:00:00+01:00',
  offer: '2026-07-06T15:00:00+01:00',
  estimate: '2026-07-08T10:00:00+01:00',
  report: '2026-07-10T15:00:00+01:00',
  authorised: '2026-07-14T11:00:00+01:00',
  repairStart: '2026-07-15T09:00:00+01:00',
  repairDone: '2026-07-24T16:00:00+01:00',
  pack: '2026-07-27T12:00:00+01:00',
};

const one = (clocks: Clock[], kind: ClockKind): Clock => {
  const found = clocks.filter((c) => c.kind === kind);
  expect(found, `expected exactly one ${kind}`).toHaveLength(1);
  return found[0]!;
};
const none = (clocks: Clock[], kind: ClockKind): void => expect(clocks.filter((c) => c.kind === kind)).toHaveLength(0);

const mkOffer = (overrides: Partial<InterventionOffer> = {}): InterventionOffer => ({
  id: 'offer_1',
  claimId: CLAIM_ID,
  receivedAt: T.offer,
  channel: 'phone',
  offerorName: 'esure',
  dailyRatePence: 2037,
  terms: {},
  suitabilityReasons: [],
  clientDecision: 'declined',
  evidenceIds: [],
  ...overrides,
});

describe('clockStatus', () => {
  const now = '2026-07-10T12:00:00+01:00';
  const due = '2026-07-09T10:00:00+01:00';
  it('met in time, met late, breached, running, stopped', () => {
    expect(clockStatus(now, due, '2026-07-08T10:00:00+01:00')).toBe('met');
    expect(clockStatus(now, due, '2026-07-10T09:00:00+01:00')).toBe('breached');
    expect(clockStatus(now, due)).toBe('breached');
    expect(clockStatus('2026-07-08T12:00:00+01:00', due)).toBe('running');
    expect(clockStatus(now, due, undefined, '2026-07-07T10:00:00+01:00')).toBe('stopped');
    expect(clockStatus(now, due, '2026-07-08T10:00:00+01:00', '2026-07-07T10:00:00+01:00')).toBe('stopped'); // stop came first
    expect(clockStatus(now, due, '2026-07-06T10:00:00+01:00', '2026-07-07T10:00:00+01:00')).toBe('met'); // met came first
    expect(clockStatus(due, due)).toBe('running'); // now == due is not yet a breach
  });
});

describe('clockDefinitions', () => {
  it('covers every ClockKind with label, basis and description', () => {
    expect(clockKinds).toHaveLength(33);
    for (const k of clockKinds) {
      expect(clockDefinitions[k].label.length).toBeGreaterThan(0);
      expect(clockDefinitions[k].basis.length).toBeGreaterThan(0);
      expect(clockDefinitions[k].description.length).toBeGreaterThan(0);
    }
  });
  it('every GTA clock says it is a benchmark for a non-subscriber', () => {
    for (const k of clockKinds.filter((x) => clockDefinitions[x].gta)) {
      expect(clockDefinitions[k].basis, k).toMatch(/benchmark only, CCGUK is not a subscriber/);
    }
    expect(clockDefinitions.gta_6_8_late_payment_10pc_day31.basis).toBe('GTA 6.8.6 — benchmark only, CCGUK is not a subscriber');
    expect(clockDefinitions.storage_report_plus_48h.basis).toBe('insurer practice (live File 2)');
    expect(clockDefinitions.icobs_8_2_6_three_months.basis).toBe('ICOBS 8.2.6R; interest ICOBS 8.2.9R–8.2.11R base+4% — territorial scope 8.2.1R to be confirmed');
    expect(clockDefinitions.limitation_pi_3y.label).toBe('refer out — personal injury');
  });
});

describe('deriveClocks — GTA 4.1 NCAF within 1 WD', () => {
  it('runs from services_agreed and is met by ncaf_sent within the day', () => {
    const agreed = mkEvent('services_agreed', T.agreed, { id: 'ev_agreed' });
    const ncaf = mkEvent('ncaf_sent', T.ncaf, { id: 'ev_ncaf' });
    const c = one(deriveClocks(mkBundle({ events: [mkEvent('fnol', T.fnol), agreed, ncaf] }), '2026-07-03T12:00:00+01:00'), 'gta_4_1_ncaf_1wd');
    expect(c).toMatchObject({ startsAt: T.agreed, dueAt: '2026-07-02T11:00:00+01:00', status: 'met', metAt: T.ncaf, sourceEventId: 'ev_agreed', attributableTo: 'ccguk' });
    expect(c.basis).toMatch(/^GTA 4\.1 \(16 March 2026 wording\)/);
    expect(c.id).toBe(`clk:${CLAIM_ID}:gta_4_1_ncaf_1wd:ev_agreed`);
  });
  it('falls back to hire_started (Friday 16:00 → Monday 16:00) and breaches when no NCAF is sent', () => {
    const hire = mkEvent('hire_started', '2026-07-03T16:00:00+01:00', { id: 'ev_hire' });
    const c = one(deriveClocks(mkBundle({ events: [hire] }), '2026-07-07T09:00:00+01:00'), 'gta_4_1_ncaf_1wd');
    expect(c).toMatchObject({ dueAt: '2026-07-06T16:00:00+01:00', status: 'breached', sourceEventId: 'ev_hire' });
    expect(c.metAt).toBeUndefined();
  });
  it('falls back to fnol, then to the claim opening time with no source event', () => {
    const fnol = mkEvent('fnol', T.fnol, { id: 'ev_fnol' });
    expect(one(deriveClocks(mkBundle({ events: [fnol] }), '2026-07-01T12:00:00+01:00'), 'gta_4_1_ncaf_1wd')).toMatchObject({ startsAt: T.fnol, dueAt: '2026-07-02T09:30:00+01:00', status: 'running', sourceEventId: 'ev_fnol' });
    const bare = one(deriveClocks(mkBundle(), '2026-07-01T12:00:00+01:00'), 'gta_4_1_ncaf_1wd');
    expect(bare).toMatchObject({ startsAt: '2026-07-01T09:30:00+01:00', dueAt: '2026-07-02T09:30:00+01:00', status: 'running' });
    expect(bare.sourceEventId).toBeUndefined();
  });
  it('a late NCAF is breached but records when it was eventually sent', () => {
    const events = [mkEvent('services_agreed', T.agreed), mkEvent('ncaf_sent', '2026-07-03T09:00:00+01:00')];
    expect(one(deriveClocks(mkBundle({ events }), '2026-07-03T12:00:00+01:00'), 'gta_4_1_ncaf_1wd')).toMatchObject({ status: 'breached', metAt: '2026-07-03T09:00:00+01:00' });
  });
  it('ignores events after now', () => {
    const events = [mkEvent('services_agreed', T.agreed), mkEvent('ncaf_sent', T.ncaf)];
    expect(one(deriveClocks(mkBundle({ events }), '2026-07-01T12:00:00+01:00'), 'gta_4_1_ncaf_1wd').status).toBe('running');
  });
});

describe('deriveClocks — GTA 4.2 handling reference and 3.6 first-notification window', () => {
  const ncaf = mkEvent('ncaf_sent', T.ncaf, { id: 'ev_ncaf' });
  it('4.2: 5 WD from the NCAF (Thu 2 Jul → Thu 9 Jul); late reference = breached with metAt; insurer clock', () => {
    const late = one(deriveClocks(mkBundle({ events: [ncaf, mkEvent('handling_ref_received', '2026-07-10T09:00:00+01:00')] }), '2026-07-13T12:00:00+01:00'), 'gta_4_2_handling_ref_5wd');
    expect(late).toMatchObject({ dueAt: '2026-07-09T10:00:00+01:00', status: 'breached', metAt: '2026-07-10T09:00:00+01:00', attributableTo: 'insurer', sourceEventId: 'ev_ncaf' });
    const ok = one(deriveClocks(mkBundle({ events: [ncaf, mkEvent('handling_ref_received', '2026-07-08T09:00:00+01:00')] }), '2026-07-13T12:00:00+01:00'), 'gta_4_2_handling_ref_5wd');
    expect(ok.status).toBe('met');
    expect(one(deriveClocks(mkBundle({ events: [ncaf] }), '2026-07-06T12:00:00+01:00'), 'gta_4_2_handling_ref_5wd').status).toBe('running');
  });
  it('3.6: running inside the window, met (expired silently) after it with no dispute', () => {
    expect(one(deriveClocks(mkBundle({ events: [ncaf] }), '2026-07-06T12:00:00+01:00'), 'gta_3_6_first_notification_5wd')).toMatchObject({ status: 'running', attributableTo: 'insurer' });
    const expired = one(deriveClocks(mkBundle({ events: [ncaf] }), '2026-07-10T12:00:00+01:00'), 'gta_3_6_first_notification_5wd');
    expect(expired).toMatchObject({ status: 'met', metAt: '2026-07-09T10:00:00+01:00', dueAt: '2026-07-09T10:00:00+01:00' });
  });
  it('3.6: an in-time first-notification dispute stops the clock; a late one does not', () => {
    const inTime = one(deriveClocks(mkBundle({ events: [ncaf, mkEvent('first_notification_dispute', '2026-07-07T10:00:00+01:00')] }), '2026-07-10T12:00:00+01:00'), 'gta_3_6_first_notification_5wd');
    expect(inTime).toMatchObject({ status: 'stopped', stoppedAt: '2026-07-07T10:00:00+01:00' });
    expect(inTime.stoppedReason).toMatch(/GTA 3\.6/);
    const late = one(deriveClocks(mkBundle({ events: [ncaf, mkEvent('first_notification_dispute', '2026-07-13T10:00:00+01:00')] }), '2026-07-14T12:00:00+01:00'), 'gta_3_6_first_notification_5wd');
    expect(late.status).toBe('met');
  });
  it('neither clock exists before the NCAF is sent', () => {
    const clocks = deriveClocks(mkBundle({ events: [mkEvent('fnol', T.fnol)] }), '2026-07-06T12:00:00+01:00');
    none(clocks, 'gta_4_2_handling_ref_5wd');
    none(clocks, 'gta_3_6_first_notification_5wd');
    none(clocks, 'icobs_8_2_6_three_months');
  });
});

describe('deriveClocks — ICOBS 8.2.6 three months', () => {
  const ncaf = mkEvent('ncaf_sent', T.ncaf, { id: 'ev_ncaf' });
  it('is 3 calendar months from first notification with the exact basis wording', () => {
    const c = one(deriveClocks(mkBundle({ events: [ncaf] }), '2026-08-01T12:00:00+01:00'), 'icobs_8_2_6_three_months');
    expect(c).toMatchObject({ startsAt: T.ncaf, dueAt: '2026-10-02T10:00:00+01:00', status: 'running', attributableTo: 'insurer', sourceEventId: 'ev_ncaf' });
    expect(c.basis).toBe('ICOBS 8.2.6R; interest ICOBS 8.2.9R–8.2.11R base+4% — territorial scope 8.2.1R to be confirmed');
  });
  it('is met by a reasoned reply: reduction, PAV offer or payment', () => {
    for (const type of ['reduction_received', 'pav_offer_received', 'payment_received'] as const) {
      const c = one(deriveClocks(mkBundle({ events: [ncaf, mkEvent(type, '2026-09-01T10:00:00+01:00')] }), '2026-10-05T12:00:00+01:00'), 'icobs_8_2_6_three_months');
      expect(c, type).toMatchObject({ status: 'met', metAt: '2026-09-01T10:00:00+01:00' });
    }
    expect(one(deriveClocks(mkBundle({ events: [ncaf] }), '2026-10-05T12:00:00+01:00'), 'icobs_8_2_6_three_months').status).toBe('breached');
  });
});

describe('deriveClocks — intervention reply within 1 WD', () => {
  it('one clock per register entry, met by replySentAt, labelled with the offeror', () => {
    const offer = mkOffer({ replySentAt: '2026-07-07T12:00:00+01:00' });
    const c = one(deriveClocks(mkBundle({ offers: [offer] }), '2026-07-08T12:00:00+01:00'), 'intervention_reply_1wd');
    expect(c).toMatchObject({ startsAt: T.offer, dueAt: '2026-07-07T15:00:00+01:00', status: 'met', metAt: '2026-07-07T12:00:00+01:00', attributableTo: 'ccguk' });
    expect(c.label).toMatch(/esure/);
    expect(c.basis).toMatch(/1 working day/);
  });
  it('an unanswered offer breaches after 1 WD (Friday 16:00 → Monday 16:00)', () => {
    const offer = mkOffer({ receivedAt: '2026-07-03T16:00:00+01:00' });
    expect(one(deriveClocks(mkBundle({ offers: [offer] }), '2026-07-06T17:00:00+01:00'), 'intervention_reply_1wd')).toMatchObject({ dueAt: '2026-07-06T16:00:00+01:00', status: 'breached' });
    expect(one(deriveClocks(mkBundle({ offers: [offer] }), '2026-07-06T15:00:00+01:00'), 'intervention_reply_1wd').status).toBe('running');
  });
  it('links the register entry to its intervention_offer event and reply event, without duplicating', () => {
    const offerEv = mkEvent('intervention_offer', T.offer, { id: 'ev_offer', data: { offerId: 'offer_1' } });
    const replyEv = mkEvent('intervention_reply_sent', '2026-07-07T11:00:00+01:00', { id: 'ev_reply', data: { offerId: 'offer_1' } });
    const clocks = deriveClocks(mkBundle({ offers: [mkOffer()], events: [offerEv, replyEv] }), '2026-07-08T12:00:00+01:00');
    const c = one(clocks, 'intervention_reply_1wd');
    expect(c).toMatchObject({ sourceEventId: 'ev_offer', status: 'met', metAt: '2026-07-07T11:00:00+01:00' });
  });
  it('event-only offers (no register entry) get their own clock, matched positionally to replies', () => {
    const events = [
      mkEvent('intervention_offer', '2026-07-06T10:00:00+01:00', { id: 'ev_o1' }),
      mkEvent('intervention_offer', '2026-07-08T10:00:00+01:00', { id: 'ev_o2' }),
      mkEvent('intervention_reply_sent', '2026-07-06T16:00:00+01:00', { id: 'ev_r1' }),
    ];
    const clocks = deriveClocks(mkBundle({ events }), '2026-07-10T12:00:00+01:00').filter((c) => c.kind === 'intervention_reply_1wd');
    expect(clocks).toHaveLength(2);
    expect(clocks.find((c) => c.sourceEventId === 'ev_o1')).toMatchObject({ status: 'met', metAt: '2026-07-06T16:00:00+01:00' });
    expect(clocks.find((c) => c.sourceEventId === 'ev_o2')).toMatchObject({ status: 'breached', dueAt: '2026-07-09T10:00:00+01:00' });
  });
});

describe('deriveClocks — off-hire triggers (GTA 4.8 / 4.9 / 4.14)', () => {
  const done = mkEvent('repair_completed', T.repairDone, { id: 'ev_done' });
  it('4.8: hire must end within 24 hours of repair completion; met by the agreement end', () => {
    const c = one(deriveClocks(mkBundle({ events: [done], hire: [mkHire({ endAt: '2026-07-25T12:00:00+01:00' })] }), '2026-07-27T12:00:00+01:00'), 'gta_4_8_offhire_repair_24h');
    expect(c).toMatchObject({ startsAt: T.repairDone, dueAt: '2026-07-25T16:00:00+01:00', status: 'met', metAt: '2026-07-25T12:00:00+01:00', sourceEventId: 'ev_done', attributableTo: 'ccguk' });
    expect(c.basis).toMatch(/GTA 4\.8/);
  });
  it('4.8: hire that ran past the deadline is breached with the actual end recorded (lesson d)', () => {
    const c = one(deriveClocks(mkBundle({ events: [done], hire: [mkHire({ endAt: '2026-07-27T10:00:00+01:00' })] }), '2026-07-28T12:00:00+01:00'), 'gta_4_8_offhire_repair_24h');
    expect(c).toMatchObject({ status: 'breached', metAt: '2026-07-27T10:00:00+01:00' });
  });
  it('4.8: a still-running hire is running before the deadline and breached after it', () => {
    expect(one(deriveClocks(mkBundle({ events: [done], hire: [mkHire()] }), '2026-07-25T10:00:00+01:00'), 'gta_4_8_offhire_repair_24h').status).toBe('running');
    expect(one(deriveClocks(mkBundle({ events: [done], hire: [mkHire()] }), '2026-07-26T10:00:00+01:00'), 'gta_4_8_offhire_repair_24h').status).toBe('breached');
  });
  it('4.8: no clock when no hire was active at completion; falls back to hire events when there are no records', () => {
    none(deriveClocks(mkBundle({ events: [done], hire: [mkHire({ endAt: '2026-07-20T10:00:00+01:00' })] }), '2026-07-28T12:00:00+01:00'), 'gta_4_8_offhire_repair_24h');
    none(deriveClocks(mkBundle({ events: [done] }), '2026-07-28T12:00:00+01:00'), 'gta_4_8_offhire_repair_24h');
    const viaEvents = deriveClocks(mkBundle({ events: [mkEvent('hire_started', '2026-07-06T10:00:00+01:00'), done, mkEvent('hire_ended', '2026-07-25T09:00:00+01:00')] }), '2026-07-28T12:00:00+01:00');
    expect(one(viaEvents, 'gta_4_8_offhire_repair_24h')).toMatchObject({ status: 'met', metAt: '2026-07-25T09:00:00+01:00' });
  });
  it('4.9: 1 WD from the insurer termination notice', () => {
    const notice = mkEvent('insurer_termination_notice', '2026-07-07T16:00:00+01:00', { id: 'ev_term' });
    const c = one(deriveClocks(mkBundle({ events: [notice], hire: [mkHire({ endAt: '2026-07-08T12:00:00+01:00' })] }), '2026-07-09T12:00:00+01:00'), 'gta_4_9_termination_1wd');
    expect(c).toMatchObject({ dueAt: '2026-07-08T16:00:00+01:00', status: 'met', sourceEventId: 'ev_term' });
    expect(c.basis).toMatch(/GTA 4\.9/);
  });
  it('4.14: 5 WD from the total-loss payment, skipping the Summer bank holiday', () => {
    const tl = mkEvent('tl_payment_received', '2026-08-27T12:00:00+01:00', { id: 'ev_tl' });
    const c = one(deriveClocks(mkBundle({ events: [tl], hire: [mkHire()] }), '2026-09-07T12:00:00+01:00'), 'gta_4_14_offhire_tl_payment_5wd');
    expect(c).toMatchObject({ dueAt: '2026-09-04T12:00:00+01:00', status: 'breached', sourceEventId: 'ev_tl' });
    expect(c.basis).toMatch(/GTA 4\.14 table \(CHO dealing, unroadworthy\)/);
  });
});

describe('deriveClocks — GTA 4.10 authorisation check and 4.11 monitoring', () => {
  const estimate = mkEvent('estimate_received', T.estimate, { id: 'ev_est' });
  it('4.10: 3 WD from the estimate (Wed 8 Jul → Mon 13 Jul); late authorisation breached with metAt; insurer clock', () => {
    const c = one(deriveClocks(mkBundle({ events: [estimate, mkEvent('repair_authorised', T.authorised)] }), '2026-07-20T12:00:00+01:00'), 'gta_4_10_authorisation_check_3wd');
    expect(c).toMatchObject({ dueAt: '2026-07-13T10:00:00+01:00', status: 'breached', metAt: T.authorised, attributableTo: 'insurer', sourceEventId: 'ev_est' });
  });
  it('4.10: stopped when the vehicle is confirmed a total loss instead; falls back to report_issued', () => {
    const tl = one(deriveClocks(mkBundle({ events: [estimate, mkEvent('total_loss_confirmed', T.report)] }), '2026-07-20T12:00:00+01:00'), 'gta_4_10_authorisation_check_3wd');
    expect(tl).toMatchObject({ status: 'stopped', stoppedAt: T.report });
    const rep = one(deriveClocks(mkBundle({ events: [mkEvent('report_issued', T.report, { id: 'ev_rep' })] }), '2026-07-11T12:00:00+01:00'), 'gta_4_10_authorisation_check_3wd');
    expect(rep).toMatchObject({ dueAt: '2026-07-15T15:00:00+01:00', status: 'running', sourceEventId: 'ev_rep' });
  });
  const started = mkEvent('repair_started', T.repairStart, { id: 'ev_start' });
  it('4.11: emits only the next due check (#1 at +5 WD), running then breached when no touch is logged', () => {
    const running = deriveClocks(mkBundle({ events: [started] }), '2026-07-20T12:00:00+01:00');
    expect(one(running, 'gta_4_11_monitoring_5wd')).toMatchObject({ startsAt: T.repairStart, dueAt: '2026-07-22T09:00:00+01:00', status: 'running', sourceEventId: 'ev_start' });
    expect(one(running, 'gta_4_11_monitoring_5wd').label).toMatch(/#1$/);
    expect(one(deriveClocks(mkBundle({ events: [started] }), '2026-07-23T12:00:00+01:00'), 'gta_4_11_monitoring_5wd').status).toBe('breached');
  });
  it('4.11: a monitoring touch satisfies check #1 so check #2 is the one shown, due 5 WD after that contact', () => {
    // Fri 17 Jul 15:00 + 5 WD = Mon 20, Tue 21, Wed 22, Thu 23, Fri 24 → Fri 24 Jul 15:00
    const touch = mkEvent('call', '2026-07-17T15:00:00+01:00', { data: { kind: 'monitoring_check' } });
    const c = one(deriveClocks(mkBundle({ events: [started, touch] }), '2026-07-23T12:00:00+01:00'), 'gta_4_11_monitoring_5wd');
    expect(c).toMatchObject({ startsAt: '2026-07-17T15:00:00+01:00', dueAt: '2026-07-24T15:00:00+01:00', status: 'running' });
    expect(c.label).toMatch(/#2$/);
  });
  it('ADVERSARIAL 4.11: a missed check does not leave the clock stuck — a late touch moves it on to the next check', () => {
    // Start Wed 15 Jul 09:00 → #1 due Wed 22 Jul 09:00. Late touch Fri 24 Jul 15:00 → #2 due Fri 31 Jul 15:00.
    const late = mkEvent('call', '2026-07-24T15:00:00+01:00', { data: { kind: 'monitoring_check' } });
    const moved = one(deriveClocks(mkBundle({ events: [started, late] }), '2026-07-27T12:00:00+01:00'), 'gta_4_11_monitoring_5wd');
    expect(moved).toMatchObject({ startsAt: '2026-07-24T15:00:00+01:00', dueAt: '2026-07-31T15:00:00+01:00', status: 'running' });
    expect(moved.label).toMatch(/#2$/);
    // A month later with no further contact it is #2 that is breached (not a stale #1 from July).
    expect(one(deriveClocks(mkBundle({ events: [started, late] }), '2026-08-20T12:00:00+01:00'), 'gta_4_11_monitoring_5wd')).toMatchObject({ dueAt: '2026-07-31T15:00:00+01:00', status: 'breached' });
    // Another touch Wed 19 Aug 10:00 → #3 due Wed 26 Aug 10:00 (Thu 20, Fri 21, Mon 24, Tue 25, Wed 26), running.
    const again = mkEvent('parts_ordered', '2026-08-19T10:00:00+01:00');
    const c3 = one(deriveClocks(mkBundle({ events: [started, late, again] }), '2026-08-20T12:00:00+01:00'), 'gta_4_11_monitoring_5wd');
    expect(c3).toMatchObject({ startsAt: '2026-08-19T10:00:00+01:00', dueAt: '2026-08-26T10:00:00+01:00', status: 'running' });
    expect(c3.label).toMatch(/#3$/);
  });
  it('4.11: a check missed before completion is breached, not hidden as stopped', () => {
    // #1 due Wed 22 Jul 09:00; repair completed Fri 24 Jul 16:00 with no contact at all.
    const c = one(deriveClocks(mkBundle({ events: [started, mkEvent('repair_completed', T.repairDone)] }), '2026-07-29T12:00:00+01:00'), 'gta_4_11_monitoring_5wd');
    expect(c).toMatchObject({ dueAt: '2026-07-22T09:00:00+01:00', status: 'breached' });
  });
  it('4.11: stopped at repair completion', () => {
    const touch = mkEvent('parts_arrived', '2026-07-20T15:00:00+01:00');
    const c = one(deriveClocks(mkBundle({ events: [started, touch, mkEvent('repair_completed', T.repairDone)] }), '2026-07-29T12:00:00+01:00'), 'gta_4_11_monitoring_5wd');
    expect(c).toMatchObject({ status: 'stopped', stoppedAt: T.repairDone, stoppedReason: 'repair completed' });
  });
});

describe('deriveClocks — storage cap at report + 48h (insurer practice, live File 2)', () => {
  const report = mkEvent('report_issued', T.report, { id: 'ev_rep' });
  it('runs from the report while storage is open; met by the collect-or-pay notice', () => {
    const notice = mkEvent('collect_or_pay_notice_sent', '2026-07-10T16:00:00+01:00');
    const c = one(deriveClocks(mkBundle({ events: [report, notice], storage: [mkStorage({ id: 'sto_1' })] }), '2026-07-13T12:00:00+01:00'), 'storage_report_plus_48h');
    expect(c).toMatchObject({ startsAt: T.report, dueAt: '2026-07-12T15:00:00+01:00', status: 'met', metAt: '2026-07-10T16:00:00+01:00', basis: 'insurer practice (live File 2)', sourceEventId: 'ev_rep', attributableTo: 'ccguk' });
    expect(c.id).toContain('sto_1');
  });
  it('breached when no notice went out within 48h — further storage must be shown to be insurer-caused', () => {
    expect(one(deriveClocks(mkBundle({ events: [report], storage: [mkStorage()] }), '2026-07-13T12:00:00+01:00'), 'storage_report_plus_48h').status).toBe('breached');
    expect(one(deriveClocks(mkBundle({ events: [report], storage: [mkStorage()] }), '2026-07-11T12:00:00+01:00'), 'storage_report_plus_48h').status).toBe('running');
    expect(clockDefinitions.storage_report_plus_48h.description).toMatch(/insurer-caused/);
  });
  it('stopped when storage ended inside the 48 hours; absent when storage had already ended or never existed', () => {
    expect(one(deriveClocks(mkBundle({ events: [report], storage: [mkStorage({ endAt: '2026-07-11T10:00:00+01:00' })] }), '2026-07-13T12:00:00+01:00'), 'storage_report_plus_48h')).toMatchObject({ status: 'stopped', stoppedAt: '2026-07-11T10:00:00+01:00' });
    none(deriveClocks(mkBundle({ events: [report], storage: [mkStorage({ endAt: '2026-07-09T10:00:00+01:00' })] }), '2026-07-13T12:00:00+01:00'), 'storage_report_plus_48h');
    none(deriveClocks(mkBundle({ events: [report] }), '2026-07-13T12:00:00+01:00'), 'storage_report_plus_48h');
  });
  it('falls back to storage_started / storage_ended events when there are no storage records', () => {
    const events = [mkEvent('storage_started', '2026-07-01T09:00:00+01:00'), report];
    expect(one(deriveClocks(mkBundle({ events }), '2026-07-13T12:00:00+01:00'), 'storage_report_plus_48h').status).toBe('breached');
  });
});

describe('deriveClocks — payment pack: GTA 6.7, 6.8.6, chasers 7/14/21, complaint 28', () => {
  const pack = mkEvent('payment_pack_sent', T.pack, { id: 'ev_pack' });
  const hire = mkHire({ endAt: '2026-07-25T12:00:00+01:00' });
  const paid = mkEvent('payment_received', '2026-08-20T11:00:00+01:00', { id: 'ev_paid', data: { inFull: true } });

  it('6.7: one calendar month from the pack (27 Jul → 27 Aug), met by payment in full', () => {
    const running = one(deriveClocks(mkBundle({ events: [pack], hire: [hire] }), '2026-07-29T12:00:00+01:00'), 'gta_6_7_settlement_1_month');
    expect(running).toMatchObject({ startsAt: T.pack, dueAt: '2026-08-27T12:00:00+01:00', status: 'running', attributableTo: 'insurer', sourceEventId: 'ev_pack' });
    expect(running.basis).toMatch(/GTA 6\.7/);
    expect(one(deriveClocks(mkBundle({ events: [pack, paid], hire: [hire] }), '2026-09-01T12:00:00+01:00'), 'gta_6_7_settlement_1_month')).toMatchObject({ status: 'met', metAt: '2026-08-20T11:00:00+01:00' });
    expect(one(deriveClocks(mkBundle({ events: [pack], hire: [hire] }), '2026-09-01T12:00:00+01:00'), 'gta_6_7_settlement_1_month').status).toBe('breached');
  });
  it('6.8.6: day 31 and day 61 from the pack (00:00 London on those days), with the exact benchmark basis', () => {
    // Pack Mon 27 Jul (day 0) → day 31 = Thu 27 Aug, day 61 = Sat 26 Sep.
    const clocks = deriveClocks(mkBundle({ events: [pack], hire: [hire] }), '2026-08-28T12:00:00+01:00');
    const d31 = one(clocks, 'gta_6_8_late_payment_10pc_day31');
    const d61 = one(clocks, 'gta_6_8_late_payment_20pc_day61');
    expect(d31).toMatchObject({ dueAt: '2026-08-27T00:00:00+01:00', status: 'breached', basis: 'GTA 6.8.6 — benchmark only, CCGUK is not a subscriber' });
    expect(d61).toMatchObject({ dueAt: '2026-09-26T00:00:00+01:00', status: 'running', basis: 'GTA 6.8.6 — benchmark only, CCGUK is not a subscriber' });
    const settled = deriveClocks(mkBundle({ events: [pack, paid], hire: [hire] }), '2026-10-01T12:00:00+01:00');
    expect(one(settled, 'gta_6_8_late_payment_10pc_day31')).toMatchObject({ status: 'met', metAt: '2026-08-20T11:00:00+01:00' });
  });
  it('ADVERSARIAL 6.8.6: the clock and latePaymentUplift agree on the instant the 10% tier starts', () => {
    const u = latePaymentUplift(100000, T.pack, '2026-08-27T08:00:00+01:00', hire.startAt);
    const d31 = one(deriveClocks(mkBundle({ events: [pack], hire: [hire] }), '2026-08-27T08:00:00+01:00'), 'gta_6_8_late_payment_10pc_day31');
    expect(d31.dueAt).toBe(u.day31At);
    expect(u.pct).toBe(10);
    expect(d31.status).toBe('breached'); // 08:00 on day 31: tier reached, clock passed — same answer
    const before = one(deriveClocks(mkBundle({ events: [pack], hire: [hire] }), '2026-08-26T23:00:00+01:00'), 'gta_6_8_late_payment_10pc_day31');
    expect(before.status).toBe('running');
    expect(latePaymentUplift(100000, T.pack, '2026-08-26T23:00:00+01:00', hire.startAt).pct).toBe(0);
  });
  it('6.8.6: not applicable for hires before 16 March 2026 or where there is no hire', () => {
    const early = one(deriveClocks(mkBundle({ events: [pack], hire: [mkHire({ startAt: '2026-03-15T10:00:00+00:00', endAt: '2026-03-25T10:00:00+00:00' })] }), '2026-08-28T12:00:00+01:00'), 'gta_6_8_late_payment_10pc_day31');
    expect(early.status).toBe('not_applicable');
    expect(early.stoppedReason).toMatch(/before 16 March 2026/);
    expect(one(deriveClocks(mkBundle({ events: [mkEvent('payment_pack_sent', T.pack), mkEvent('hire_started', '2026-03-16T10:00:00+00:00')] }), '2026-08-28T12:00:00+01:00'), 'gta_6_8_late_payment_10pc_day31').status).toBe('breached');
    const noHire = one(deriveClocks(mkBundle({ events: [pack] }), '2026-08-28T12:00:00+01:00'), 'gta_6_8_late_payment_20pc_day61');
    expect(noHire.status).toBe('not_applicable');
    expect(noHire.stoppedReason).toMatch(/no hire/);
  });
  it('chasers are due at day 7/14/21 and the complaint at day 28, met by the nth chaser / the complaint', () => {
    const c1 = mkEvent('chaser_sent', '2026-08-03T10:00:00+01:00', { id: 'ev_c1' });
    const c2 = mkEvent('chaser_sent', '2026-08-12T10:00:00+01:00', { id: 'ev_c2' });
    const complaint = mkEvent('complaint_sent', '2026-08-24T11:00:00+01:00');
    const clocks = deriveClocks(mkBundle({ events: [pack, c1, c2, complaint], hire: [hire] }), '2026-08-25T12:00:00+01:00');
    expect(one(clocks, 'chaser_day_7')).toMatchObject({ startsAt: T.pack, dueAt: '2026-08-03T12:00:00+01:00', status: 'met', metAt: '2026-08-03T10:00:00+01:00', attributableTo: 'ccguk' });
    expect(one(clocks, 'chaser_day_14')).toMatchObject({ dueAt: '2026-08-10T12:00:00+01:00', status: 'breached', metAt: '2026-08-12T10:00:00+01:00' });
    expect(one(clocks, 'chaser_day_21')).toMatchObject({ dueAt: '2026-08-17T12:00:00+01:00', status: 'breached' });
    expect(one(clocks, 'chaser_day_21').metAt).toBeUndefined();
    expect(one(clocks, 'complaint_day_28')).toMatchObject({ dueAt: '2026-08-24T12:00:00+01:00', status: 'met', metAt: '2026-08-24T11:00:00+01:00' });
    expect(one(clocks, 'chaser_day_7').basis).toMatch(/day 7, 14, 21 → complaint at day 28/);
  });
  it('payment in full stops the remaining chasers and the complaint but leaves an earlier chaser met', () => {
    const c1 = mkEvent('chaser_sent', '2026-08-03T10:00:00+01:00');
    const early = mkEvent('payment_received', '2026-08-05T11:00:00+01:00', { data: { inFull: true } });
    const clocks = deriveClocks(mkBundle({ events: [pack, c1, early], hire: [hire] }), '2026-09-01T12:00:00+01:00');
    expect(one(clocks, 'chaser_day_7').status).toBe('met');
    for (const k of ['chaser_day_14', 'chaser_day_21', 'complaint_day_28'] as const) {
      expect(one(clocks, k), k).toMatchObject({ status: 'stopped', stoppedAt: '2026-08-05T11:00:00+01:00', stoppedReason: 'paid in full' });
    }
  });
  it('explicitly tagged chasers (data.chaser / data.day) win over positional matching', () => {
    const tagged = mkEvent('chaser_sent', '2026-08-09T10:00:00+01:00', { data: { chaser: 2 } });
    const clocks = deriveClocks(mkBundle({ events: [pack, tagged], hire: [hire] }), '2026-08-11T12:00:00+01:00');
    expect(one(clocks, 'chaser_day_7').status).toBe('breached');
    expect(one(clocks, 'chaser_day_14')).toMatchObject({ status: 'met', metAt: '2026-08-09T10:00:00+01:00' });
  });
  it('falls back to the last invoice letter when no payment pack was sent', () => {
    const invoice = mkEvent('letter_out', '2026-07-27T12:00:00+01:00', { id: 'ev_inv', data: { kind: 'invoice' } });
    const clocks = deriveClocks(mkBundle({ events: [invoice], hire: [hire] }), '2026-07-29T12:00:00+01:00');
    expect(one(clocks, 'chaser_day_7')).toMatchObject({ dueAt: '2026-08-03T12:00:00+01:00', sourceEventId: 'ev_inv' });
    none(deriveClocks(mkBundle({ hire: [hire] }), '2026-07-29T12:00:00+01:00'), 'chaser_day_7');
  });
});

describe('deriveClocks — DISP 8 weeks, FOS 6 months, DSAR 1 month', () => {
  const complaint = mkEvent('complaint_sent', '2026-08-24T11:00:00+01:00', { id: 'ev_comp' });
  const finalResponse = mkEvent('final_response_received', '2026-10-01T10:00:00+01:00', { id: 'ev_fr' });
  it('DISP: final response due 8 weeks after the complaint (24 Aug → 19 Oct)', () => {
    const c = one(deriveClocks(mkBundle({ events: [complaint] }), '2026-09-01T12:00:00+01:00'), 'disp_final_response_8_weeks');
    expect(c).toMatchObject({ dueAt: '2026-10-19T11:00:00+01:00', status: 'running', attributableTo: 'insurer', sourceEventId: 'ev_comp' });
    expect(c.basis).toMatch(/DISP 1\.6\.2R/);
    expect(one(deriveClocks(mkBundle({ events: [complaint, finalResponse] }), '2026-10-20T12:00:00+01:00'), 'disp_final_response_8_weeks')).toMatchObject({ status: 'met', metAt: '2026-10-01T10:00:00+01:00' });
  });
  it('FOS: not applicable against the at-fault insurer (DISP 2.7), with the exact reason', () => {
    const c = one(deriveClocks(mkBundle({ events: [complaint, finalResponse] }), '2026-10-20T12:00:00+01:00'), 'fos_referral_6_months');
    expect(c).toMatchObject({ startsAt: '2026-10-01T10:00:00+01:00', dueAt: '2027-04-01T10:00:00+01:00', status: 'not_applicable', stoppedReason: FOS_NOT_OPEN_REASON, sourceEventId: 'ev_fr' });
    expect(FOS_NOT_OPEN_REASON).toBe('third-party claimant is not an eligible complainant against the at-fault insurer (DISP 2.7)');
  });
  it('FOS: runs when the complaint is against the client’s own insurer', () => {
    const own = mkEvent('complaint_sent', '2026-08-24T11:00:00+01:00', { data: { againstOwnInsurer: true } });
    const c = one(deriveClocks(mkBundle({ events: [own, finalResponse] }), '2026-10-20T12:00:00+01:00'), 'fos_referral_6_months');
    expect(c).toMatchObject({ status: 'running', attributableTo: 'ccguk' });
    const referred = mkEvent('letter_out', '2026-11-01T10:00:00+00:00', { data: { kind: 'fos_referral' } });
    expect(one(deriveClocks(mkBundle({ events: [own, finalResponse, referred] }), '2027-05-01T12:00:00+01:00'), 'fos_referral_6_months')).toMatchObject({ status: 'met', metAt: '2026-11-01T10:00:00+00:00' });
    none(deriveClocks(mkBundle({ events: [complaint] }), '2026-09-01T12:00:00+01:00'), 'fos_referral_6_months');
  });
  it('DSAR: one calendar month per request; 31 Jul → 31 Aug is the Summer bank holiday so the ICO reading gives Tue 1 Sep', () => {
    const d1 = mkEvent('dsar_sent', '2026-07-31T10:00:00+01:00', { id: 'ev_d1', data: { recipient: 'esure' } });
    const d2 = mkEvent('dsar_sent', '2026-08-03T10:00:00+01:00', { id: 'ev_d2' });
    const r2 = mkEvent('dsar_response', '2026-08-20T10:00:00+01:00', { data: { dsarId: 'ev_d2' } });
    const clocks = deriveClocks(mkBundle({ events: [d1, d2, r2] }), '2026-09-05T12:00:00+01:00').filter((c) => c.kind === 'dsar_1_month');
    expect(clocks).toHaveLength(2);
    const c1 = clocks.find((c) => c.sourceEventId === 'ev_d1')!;
    expect(c1).toMatchObject({ dueAt: '2026-09-01T10:00:00+01:00', status: 'breached', attributableTo: 'insurer' });
    expect(c1.label).toMatch(/esure/);
    expect(c1.basis).toMatch(/next working day/);
    expect(clocks.find((c) => c.sourceEventId === 'ev_d2')).toMatchObject({ dueAt: '2026-09-03T10:00:00+01:00', status: 'met', metAt: '2026-08-20T10:00:00+01:00' });
  });
  it('ADVERSARIAL DSAR: a response on the rolled-forward day is in time; month-end clamp and weekend roll combine (30 Jan 2027 → Mon 1 Mar 2027)', () => {
    // Sent Fri 31 Jul; response Tue 1 Sep 09:00 (before 10:00) — the ICO complaint must NOT allege a breach on 31 Aug.
    const d1 = mkEvent('dsar_sent', '2026-07-31T10:00:00+01:00', { id: 'ev_d1' });
    const r1 = mkEvent('dsar_response', '2026-09-01T09:00:00+01:00');
    expect(one(deriveClocks(mkBundle({ events: [d1, r1] }), '2026-09-05T12:00:00+01:00'), 'dsar_1_month')).toMatchObject({ status: 'met', metAt: '2026-09-01T09:00:00+01:00' });
    // Sat 30 Jan 2027 + 1 month → 28 Feb 2027 (clamped) is a Sunday → Mon 1 Mar 2027.
    const d3 = mkEvent('dsar_sent', '2027-01-30T10:00:00+00:00', { id: 'ev_d3' });
    expect(one(deriveClocks(mkBundle({ events: [d3] }), '2027-02-01T12:00:00+00:00'), 'dsar_1_month')).toMatchObject({ dueAt: '2027-03-01T10:00:00+00:00', status: 'running' });
    // Thu 2 Jul 2026 → Sun 2 Aug → Mon 3 Aug.
    const d4 = mkEvent('dsar_sent', '2026-07-02T10:00:00+01:00', { id: 'ev_d4' });
    expect(one(deriveClocks(mkBundle({ events: [d4] }), '2026-07-03T12:00:00+01:00'), 'dsar_1_month').dueAt).toBe('2026-08-03T10:00:00+01:00');
  });
});

describe('deriveClocks — CCTV, limitation, Part 36, default judgment, custom', () => {
  it('CCTV preservation: 7 days from FNOL, met by the request; not applicable when no camera was identified', () => {
    const fnol = mkEvent('fnol', T.fnol, { id: 'ev_fnol' });
    expect(one(deriveClocks(mkBundle({ events: [fnol, mkEvent('cctv_request_sent', '2026-07-03T10:00:00+01:00')] }), '2026-07-10T12:00:00+01:00'), 'cctv_preservation')).toMatchObject({ dueAt: '2026-07-08T09:30:00+01:00', status: 'met', sourceEventId: 'ev_fnol', attributableTo: 'ccguk' });
    expect(one(deriveClocks(mkBundle({ events: [fnol] }), '2026-07-10T12:00:00+01:00'), 'cctv_preservation').status).toBe('breached');
    expect(one(deriveClocks(mkBundle({ events: [fnol] }, { cctvAvailable: false }), '2026-07-10T12:00:00+01:00'), 'cctv_preservation').status).toBe('not_applicable');
    expect(one(deriveClocks(mkBundle({ events: [fnol] }, { cctvAvailable: false, dashcamAvailable: true }), '2026-07-10T12:00:00+01:00'), 'cctv_preservation').status).toBe('breached');
    expect(one(deriveClocks(mkBundle(), '2026-07-02T12:00:00+01:00'), 'cctv_preservation')).toMatchObject({ startsAt: '2026-07-01T09:30:00+01:00', status: 'running' });
  });
  it('limitation: tort 6y from the accident; PI 3y only when injuries; contract 6y per hire agreement', () => {
    const clocks = deriveClocks(mkBundle({ hire: [mkHire({ agreementNumber: 'CCG-HA-0001' })] }), '2026-07-29T12:00:00+01:00');
    expect(one(clocks, 'limitation_tort_6y')).toMatchObject({ startsAt: '2026-07-01T07:45:00+01:00', dueAt: '2032-07-01T07:45:00+01:00', status: 'running', attributableTo: 'ccguk' });
    none(clocks, 'limitation_pi_3y');
    expect(one(clocks, 'limitation_contract_6y')).toMatchObject({ startsAt: '2026-07-06T10:00:00+01:00', dueAt: '2032-07-06T10:00:00+01:00' });
    expect(one(clocks, 'limitation_contract_6y').label).toMatch(/CCG-HA-0001/);
    const pi = one(deriveClocks(mkBundle({}, { injuries: true }), '2026-07-29T12:00:00+01:00'), 'limitation_pi_3y');
    expect(pi).toMatchObject({ label: 'refer out — personal injury', dueAt: '2029-07-01T07:45:00+01:00', attributableTo: 'other' });
    expect(pi.basis).toMatch(/Limitation Act 1980 s\.11/);
  });
  it('limitation stops when proceedings are issued', () => {
    const issued = mkEvent('proceedings_issued', '2026-09-01T10:00:00+01:00');
    expect(one(deriveClocks(mkBundle({ events: [issued] }), '2026-09-05T12:00:00+01:00'), 'limitation_tort_6y')).toMatchObject({ status: 'stopped', stoppedAt: '2026-09-01T10:00:00+01:00', stoppedReason: 'proceedings issued' });
  });
  it('Part 36: 21-day relevant period; received → our response (ccguk), sent → their acceptance (insurer)', () => {
    const received = mkEvent('part36_received', '2026-08-03T12:00:00+01:00', { id: 'ev_p36r' });
    const response = mkEvent('letter_out', '2026-08-20T10:00:00+01:00', { data: { kind: 'part36_response' } });
    const clocks = deriveClocks(mkBundle({ events: [received, response] }), '2026-08-25T12:00:00+01:00');
    expect(one(clocks, 'part36_relevant_period_21_days')).toMatchObject({ dueAt: '2026-08-24T12:00:00+01:00', status: 'met', metAt: '2026-08-20T10:00:00+01:00', attributableTo: 'ccguk', sourceEventId: 'ev_p36r' });
    const sent = mkEvent('part36_sent', '2026-08-03T12:00:00+01:00', { id: 'ev_p36s', data: { relevantPeriodDays: 28 } });
    const c = one(deriveClocks(mkBundle({ events: [sent] }), '2026-08-25T12:00:00+01:00'), 'part36_relevant_period_21_days');
    expect(c).toMatchObject({ dueAt: '2026-08-31T12:00:00+01:00', status: 'running', attributableTo: 'insurer' });
    expect(c.basis).toMatch(/CPR 36\.3\(g\), 36\.5\(1\)\(c\)/);
  });
  it('default judgment: 14 days from service of the particulars; 28 days for the defence once an AoS is filed', () => {
    const issued = mkEvent('proceedings_issued', '2026-09-01T10:00:00+01:00', { id: 'ev_issued', data: { servedAt: '2026-09-03T10:00:00+01:00' } });
    const c = one(deriveClocks(mkBundle({ events: [issued] }), '2026-09-05T12:00:00+01:00'), 'default_judgment_14_days');
    expect(c).toMatchObject({ startsAt: '2026-09-03T10:00:00+01:00', dueAt: '2026-09-17T10:00:00+01:00', status: 'running', attributableTo: 'insurer', sourceEventId: 'ev_issued' });
    expect(c.basis).toMatch(/CPR 10\.3, 15\.4 and 12\.3/);
    const aos = mkEvent('letter_in', '2026-09-10T10:00:00+01:00', { data: { kind: 'acknowledgment_of_service' } });
    const withAos = one(deriveClocks(mkBundle({ events: [issued, aos] }), '2026-09-20T12:00:00+01:00'), 'default_judgment_14_days');
    expect(withAos).toMatchObject({ dueAt: '2026-10-01T10:00:00+01:00', status: 'running' });
    expect(withAos.label).toMatch(/28 days/);
    const defence = mkEvent('defence_received', '2026-09-15T10:00:00+01:00');
    expect(one(deriveClocks(mkBundle({ events: [issued, defence] }), '2026-09-20T12:00:00+01:00'), 'default_judgment_14_days')).toMatchObject({ status: 'met', metAt: '2026-09-15T10:00:00+01:00' });
    expect(one(deriveClocks(mkBundle({ events: [issued] }), '2026-09-20T12:00:00+01:00'), 'default_judgment_14_days').status).toBe('breached');
    const judgment = mkEvent('judgment', '2026-09-25T10:00:00+01:00');
    expect(one(deriveClocks(mkBundle({ events: [issued, judgment] }), '2026-09-26T12:00:00+01:00'), 'default_judgment_14_days')).toMatchObject({ status: 'stopped', stoppedReason: 'judgment entered' });
  });
  it('custom clocks on the bundle are re-evaluated against now', () => {
    const custom: Clock = { id: 'clk_custom', claimId: CLAIM_ID, kind: 'custom', label: 'Call back client', basis: 'user-defined', startsAt: '2026-07-01T10:00:00+01:00', dueAt: '2026-07-02T10:00:00+01:00', status: 'running' };
    expect(one(deriveClocks(mkBundle({ clocks: [custom] }), '2026-07-03T12:00:00+01:00'), 'custom').status).toBe('breached');
    expect(one(deriveClocks(mkBundle({ clocks: [custom] }), '2026-07-01T12:00:00+01:00'), 'custom').status).toBe('running');
    expect(one(deriveClocks(mkBundle({ clocks: [{ ...custom, status: 'met', metAt: '2026-07-01T15:00:00+01:00' }] }), '2026-07-03T12:00:00+01:00'), 'custom').status).toBe('met');
  });
});

describe('deriveClocks — a full live-file chronology', () => {
  const hire = mkHire({ id: 'hire_1', endAt: '2026-07-25T12:00:00+01:00' });
  const events = [
    mkEvent('fnol', T.fnol, { id: 'ev_fnol' }),
    mkEvent('services_agreed', T.agreed, { id: 'ev_agreed' }),
    mkEvent('ncaf_sent', T.ncaf, { id: 'ev_ncaf' }),
    mkEvent('cctv_request_sent', '2026-07-02T11:00:00+01:00'),
    mkEvent('hire_started', hire.startAt),
    mkEvent('intervention_offer', T.offer, { id: 'ev_offer', data: { offerId: 'offer_1' } }),
    mkEvent('intervention_reply_sent', '2026-07-07T11:00:00+01:00', { data: { offerId: 'offer_1' } }),
    mkEvent('estimate_received', T.estimate, { id: 'ev_est' }),
    mkEvent('handling_ref_received', '2026-07-10T09:00:00+01:00'),
    mkEvent('report_issued', T.report, { id: 'ev_rep' }),
    mkEvent('collect_or_pay_notice_sent', '2026-07-10T16:00:00+01:00'),
    mkEvent('repair_authorised', T.authorised),
    mkEvent('repair_started', T.repairStart, { id: 'ev_start' }),
    mkEvent('parts_arrived', '2026-07-20T15:00:00+01:00'),
    mkEvent('repair_completed', T.repairDone, { id: 'ev_done' }),
    mkEvent('hire_ended', hire.endAt!),
    mkEvent('payment_pack_sent', T.pack, { id: 'ev_pack' }),
  ];
  const bundle = mkBundle({ events, hire: [hire], storage: [mkStorage({ id: 'sto_1', endAt: '2026-07-12T10:00:00+01:00' })], offers: [mkOffer()] });
  const now = '2026-07-29T12:00:00+01:00';
  const clocks = deriveClocks(bundle, now);

  it('emits the expected set of clock kinds', () => {
    expect(clocks.map((c) => c.kind).sort()).toEqual(
      [
        'gta_4_1_ncaf_1wd',
        'gta_4_2_handling_ref_5wd',
        'gta_3_6_first_notification_5wd',
        'icobs_8_2_6_three_months',
        'intervention_reply_1wd',
        'gta_4_8_offhire_repair_24h',
        'gta_4_10_authorisation_check_3wd',
        'gta_4_11_monitoring_5wd',
        'storage_report_plus_48h',
        'gta_6_7_settlement_1_month',
        'gta_6_8_late_payment_10pc_day31',
        'gta_6_8_late_payment_20pc_day61',
        'chaser_day_7',
        'chaser_day_14',
        'chaser_day_21',
        'complaint_day_28',
        'cctv_preservation',
        'limitation_tort_6y',
        'limitation_contract_6y',
      ].sort(),
    );
  });
  it('has the statuses the chronology dictates', () => {
    const byKind = Object.fromEntries(clocks.map((c) => [c.kind, c])) as Record<ClockKind, Clock>;
    expect(byKind.gta_4_1_ncaf_1wd.status).toBe('met');
    expect(byKind.gta_4_2_handling_ref_5wd.status).toBe('breached'); // ref on Fri 10 Jul, due Thu 9 Jul
    expect(byKind.gta_3_6_first_notification_5wd.status).toBe('met'); // window expired silently
    expect(byKind.icobs_8_2_6_three_months.status).toBe('running');
    expect(byKind.intervention_reply_1wd).toMatchObject({ status: 'met', sourceEventId: 'ev_offer' });
    expect(byKind.gta_4_8_offhire_repair_24h).toMatchObject({ status: 'met', metAt: '2026-07-25T12:00:00+01:00' });
    expect(byKind.gta_4_10_authorisation_check_3wd.status).toBe('breached'); // authorised Tue 14 Jul, due Mon 13 Jul
    expect(byKind.gta_4_11_monitoring_5wd).toMatchObject({ status: 'stopped', stoppedReason: 'repair completed' });
    expect(byKind.storage_report_plus_48h.status).toBe('met');
    expect(byKind.gta_6_7_settlement_1_month.status).toBe('running');
    expect(byKind.chaser_day_7).toMatchObject({ status: 'running', dueAt: '2026-08-03T12:00:00+01:00' });
    expect(byKind.cctv_preservation.status).toBe('met');
    expect(byKind.limitation_tort_6y.dueAt).toBe('2032-07-01T07:45:00+01:00');
  });
  it('every clock carries a basis, an attribution and London-offset timestamps; ids are deterministic', () => {
    for (const c of clocks) {
      expect(c.basis.length, c.kind).toBeGreaterThan(0);
      expect(c.attributableTo, c.kind).toBeDefined();
      expect(c.startsAt, c.kind).toMatch(/[+-]\d{2}:\d{2}$/);
      expect(c.dueAt, c.kind).toMatch(/[+-]\d{2}:\d{2}$/);
      expect(c.claimId).toBe(CLAIM_ID);
    }
    expect(new Set(clocks.map((c) => c.id)).size).toBe(clocks.length);
    expect(deriveClocks(bundle, now)).toEqual(clocks);
  });
  it('dueClocks lists breached clocks and those due within the horizon, soonest first', () => {
    const due = dueClocks(clocks, now, 24 * 6);
    expect(due.map((c) => c.kind)).toEqual(['gta_4_2_handling_ref_5wd', 'gta_4_10_authorisation_check_3wd', 'chaser_day_7']);
  });
});
