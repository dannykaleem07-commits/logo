import { describe, it, expect } from 'vitest';
import { nextActions, priorityFor, sortActions, hireAtRisk, outstandingBalance, defaultPlaybookRules, playbookRuleCodes, findRule } from './index.js';
import { T0, day0Bundle, file1Bundle, offer, hire, storage, clock, gate, greenGates, event, claim, FILE1_ACCIDENT } from './fixture.js';
import type { PlaybookAction } from '../types.js';

const NOW = '2026-10-20T12:00:00+01:00';
const byCode = (actions: PlaybookAction[], code: string): PlaybookAction | undefined => actions.find((a) => a.code === code);
const codes = (actions: PlaybookAction[]): string[] => actions.map((a) => a.code);

describe('rules', () => {
  it('every rule code is unique, carries a basis and a trigger, and the engine codes all exist', () => {
    expect(new Set(playbookRuleCodes).size).toBe(defaultPlaybookRules.length);
    for (const r of defaultPlaybookRules) {
      expect(r.basis.length).toBeGreaterThan(0);
      expect(r.trigger.length).toBeGreaterThan(10);
    }
    for (const code of [
      'SEND_NCAF', 'REQUEST_HANDLING_REF', 'REQUEST_CCTV', 'REPLY_TO_INTERVENTION_OFFER', 'COLLECT_IMPECUNIOSITY_EVIDENCE', 'FIX_ENFORCEABILITY',
      'SEND_COLLECT_OR_PAY', 'SEND_DELAY_NOTICE', 'END_HIRE_NOW', 'SEND_PAYMENT_PACK', 'SPLIT_HEADS_INTERIM', 'CHASER_7', 'CHASER_14', 'CHASER_21',
      'COMPLAINT_28', 'SEND_DSAR', 'ICOBS_INTEREST_CLAIM', 'LETTER_BEFORE_CLAIM', 'PART36_OFFER', 'DEFAULT_JUDGMENT', 'VENDOR_VERIFICATION_PACK',
      'REFER_INJURY', 'FLAG_CONNECTED_WITNESS', 'MONITOR_SUPPLIER',
    ]) expect(playbookRuleCodes).toContain(code);
    expect(findRule('COMPLAINT_28').basis.join(' ')).toContain('DISP 2.7');
    expect(() => findRule('NOPE')).toThrow();
  });

  it('GTA rules say benchmark only; the vendor pack names the exact registered name and company number', () => {
    for (const r of defaultPlaybookRules.filter((x) => x.basis.some((b) => b.startsWith('GTA')))) expect(r.basis.join(' ')).toContain('benchmark only');
    const vendor = findRule('VENDOR_VERIFICATION_PACK');
    expect(vendor.basis.join(' ')).toContain('"Courtesy Cars Group UK Ltd"');
    expect(vendor.basis.join(' ')).toContain('17430389');
  });
});

describe('priorityFor / sortActions', () => {
  it('now when due has passed, today on the same London date, this_week within 7 days, else scheduled; floors apply', () => {
    const now = '2026-10-20T12:00:00+01:00';
    expect(priorityFor('2026-10-20T09:00:00+01:00', now)).toBe('now');
    expect(priorityFor('2026-10-20T17:00:00+01:00', now)).toBe('today');
    expect(priorityFor('2026-10-27T12:00:00+00:00', now)).toBe('this_week');
    expect(priorityFor('2026-10-28T12:00:00+00:00', now)).toBe('scheduled');
    expect(priorityFor('2026-10-28T12:00:00+00:00', now, 'today')).toBe('today');
    expect(priorityFor('2026-10-20T09:00:00+01:00', now, 'scheduled')).toBe('now');
    expect(priorityFor(undefined, now)).toBe('this_week');
  });

  it('sorts by priority, then due date, then code', () => {
    const a = (code: string, priority: PlaybookAction['priority'], dueAt?: string): PlaybookAction => ({ code, title: code, why: '', basis: [], priority, ...(dueAt ? { dueAt } : {}) });
    const sorted = sortActions([a('Z', 'scheduled'), a('B', 'now', '2026-10-21T09:00:00+01:00'), a('A', 'now', '2026-10-21T09:00:00+01:00'), a('C', 'today'), a('D', 'now', '2026-10-20T09:00:00+01:00')]);
    expect(codes(sorted)).toEqual(['D', 'A', 'B', 'C', 'Z']);
  });
});

describe('nextActions — day 0', () => {
  it('a day-0 bundle produces SEND_NCAF due the next working day (Mon 21 Sep → Tue 22 Sep 09:00), priority today, template letter.ncaf', () => {
    const actions = nextActions(day0Bundle(), { now: T0, clocks: [], gates: [] });
    expect(codes(actions)).toEqual(['SEND_NCAF']);
    const ncaf = actions[0]!;
    expect(ncaf.dueAt).toBe('2026-09-22T09:00:00+01:00');
    expect(ncaf.priority).toBe('today');
    expect(ncaf.templateId).toBe('letter.ncaf');
    expect(ncaf.basis.join(' ')).toContain('GTA 4.1');
    expect(ncaf.basis.join(' ')).toContain('benchmark only');
    expect(ncaf.why).toContain('1 working day');
    expect(ncaf.valuePence).toBeUndefined();
  });

  it('uses the supplied gta_4_1 clock when present and goes to now once breached', () => {
    const c = clock('gta_4_1_ncaf_1wd', T0, '2026-09-22T09:00:00+01:00', { status: 'breached' });
    const actions = nextActions(day0Bundle(), { now: '2026-09-23T09:00:00+01:00', clocks: [c], gates: [] });
    expect(byCode(actions, 'SEND_NCAF')).toMatchObject({ dueAt: '2026-09-22T09:00:00+01:00', priority: 'now' });
  });

  it('a Friday FNOL is due Monday (working days, not calendar days)', () => {
    const fri = '2026-09-25T15:00:00+01:00';
    const b = day0Bundle({ claim: claim({ status: 'fnol', openedAt: fri }), events: [event('fnol', fri)] });
    expect(byCode(nextActions(b, { now: fri, clocks: [], gates: [] }), 'SEND_NCAF')!.dueAt).toBe('2026-09-28T15:00:00+01:00');
  });

  it('injury at FNOL adds REFER_INJURY (today, no template, LASPO basis); a logged referral removes it', () => {
    const b = day0Bundle({ claim: claim({ status: 'fnol', accident: { ...FILE1_ACCIDENT, injuries: true } }) });
    const refer = byCode(nextActions(b, { now: T0, clocks: [], gates: [] }), 'REFER_INJURY')!;
    expect(refer).toMatchObject({ priority: 'today', dueAt: '2026-09-22T09:00:00+01:00' });
    expect(refer.templateId).toBeUndefined();
    expect(refer.why).toContain('no referral fee');
    expect(refer.basis.join(' ')).toContain('LASPO 2012 ss.56–60');
    b.claim = { ...b.claim, injuryReferral: { referredTo: 'PI Solicitors LLP', referredAt: T0, feeTaken: false } };
    expect(byCode(nextActions(b, { now: T0, clocks: [], gates: [] }), 'REFER_INJURY')).toBeUndefined();
  });

  it('REQUEST_CCTV: CCTV available → preservation letter due accident + 7 days; junction location triggers it too; dashcam-only has no letter', () => {
    const cctv = day0Bundle({ claim: claim({ status: 'fnol', accident: { ...FILE1_ACCIDENT, cctvAvailable: true } }) });
    const a = byCode(nextActions(cctv, { now: T0, clocks: [], gates: [] }), 'REQUEST_CCTV')!;
    expect(a).toMatchObject({ dueAt: '2026-09-28T09:00:00+01:00', priority: 'today', templateId: 'letter.cctv_preservation' });
    expect(a.why).toContain('within 7 days');
    const junction = day0Bundle({ claim: claim({ status: 'fnol', accident: { ...FILE1_ACCIDENT, location: 'Barking Road / Green Street junction' } }) });
    expect(byCode(nextActions(junction, { now: T0, clocks: [], gates: [] }), 'REQUEST_CCTV')!.why).toContain('council / TfL / premises CCTV');
    const dashcam = day0Bundle({ claim: claim({ status: 'fnol', accident: { ...FILE1_ACCIDENT, dashcamAvailable: true } }) });
    const d = byCode(nextActions(dashcam, { now: T0, clocks: [], gates: [] }), 'REQUEST_CCTV')!;
    expect(d.templateId).toBeUndefined();
    expect(d.why).toContain('dashcam original file');
    // once the request is logged, or footage is on file, the action goes
    cctv.events.push(event('cctv_request_sent', '2026-09-21T15:00:00+01:00'));
    expect(byCode(nextActions(cctv, { now: '2026-09-22T09:00:00+01:00', clocks: [], gates: [] }), 'REQUEST_CCTV')).toBeUndefined();
  });

  it('REQUEST_HANDLING_REF after the NCAF until the reference arrives (5 WD)', () => {
    const b = day0Bundle({ claim: claim({ status: 'accepted', atFaultInsurerRef: undefined }), events: [event('fnol', T0), event('ncaf_sent', '2026-09-21T16:00:00+01:00')] });
    const a = byCode(nextActions(b, { now: '2026-09-22T09:00:00+01:00', clocks: [], gates: [] }), 'REQUEST_HANDLING_REF')!;
    expect(a).toMatchObject({ dueAt: '2026-09-28T16:00:00+01:00', priority: 'this_week', templateId: 'letter.handling_ref_request' });
    b.events.push(event('handling_ref_received', '2026-09-23T12:00:00+01:00'));
    expect(byCode(nextActions(b, { now: '2026-09-24T09:00:00+01:00', clocks: [], gates: [] }), 'REQUEST_HANDLING_REF')).toBeUndefined();
  });
});

describe('nextActions — intervention, evidence and hire', () => {
  it('an offer without a reply produces REPLY_TO_INTERVENTION_OFFER at priority now, due 1 WD, worth the hire at risk, never blocked', () => {
    const b = file1Bundle({ offers: [offer({ replySentAt: undefined })] });
    const a = byCode(nextActions(b, { now: NOW, clocks: [], gates: greenGates() }), 'REPLY_TO_INTERVENTION_OFFER')!;
    expect(a.priority).toBe('now');
    expect(a.dueAt).toBe('2026-09-24T11:00:00+01:00');
    expect(a.templateId).toBe('letter.intervention_reply');
    expect(a.blockedBy).toBeUndefined();
    expect(a.valuePence).toBe(59_760); // 10 days × £49.80 + VAT
    expect(a.title).toContain('esure (2026-09-23)');
    expect(a.why).toContain('£20.37/day');
    expect(a.basis.join(' ')).toContain('Copley v Lawn');
    // the intervention reply sorts first
    expect(codes(nextActions(b, { now: NOW, clocks: [], gates: greenGates() }))[0]).toBe('REPLY_TO_INTERVENTION_OFFER');
  });

  it('a non-green impecuniosity gate raises COLLECT_IMPECUNIOSITY_EVIDENCE (now once hire has run; before a future hire start otherwise)', () => {
    const gates = [...greenGates().filter((g) => g.gate !== 'impecuniosity'), gate('impecuniosity', 'amber', ['2 more bank statements'])];
    const a = byCode(nextActions(file1Bundle(), { now: NOW, clocks: [], gates }), 'COLLECT_IMPECUNIOSITY_EVIDENCE')!;
    expect(a).toMatchObject({ priority: 'now', dueAt: NOW, templateId: 'form.statement_of_means', valuePence: 59_760 });
    expect(a.why).toContain('Diriye v Bojaj');
    expect(a.why).toContain('2 more bank statements');
    const future = file1Bundle({ hire: [hire({ startAt: '2026-10-26T10:00:00+00:00', endAt: undefined, collectedAt: undefined })], events: [event('fnol', T0), event('ncaf_sent', '2026-09-21T16:00:00+01:00')] });
    const f = byCode(nextActions(future, { now: NOW, clocks: [], gates }), 'COLLECT_IMPECUNIOSITY_EVIDENCE')!;
    expect(f.dueAt).toBe('2026-10-26T10:00:00+00:00');
    expect(f.priority).toBe('this_week');
    expect(f.why).toContain('before the hire starts');
  });

  it('a non-green enforceability gate raises FIX_ENFORCEABILITY worth the whole hire; nothing to fix without a hire agreement', () => {
    const gates = [...greenGates().filter((g) => g.gate !== 'enforceability'), gate('enforceability', 'red', ['express request to start'])];
    const a = byCode(nextActions(file1Bundle(), { now: NOW, clocks: [], gates }), 'FIX_ENFORCEABILITY')!;
    expect(a).toMatchObject({ priority: 'now', valuePence: 59_760 });
    expect(a.why).toContain('W v Veolia');
    expect(a.why).toContain('£597.60');
    expect(byCode(nextActions(day0Bundle(), { now: T0, clocks: [], gates }), 'FIX_ENFORCEABILITY')).toBeUndefined();
  });

  it('SEND_COLLECT_OR_PAY on report day while storage is open, due report + 48h, worth the storage since the report', () => {
    const b = file1Bundle({
      storage: [storage({ endAt: undefined, endTrigger: undefined })],
      hire: [hire({ endAt: undefined, collectedAt: undefined })],
      events: [event('fnol', T0), event('ncaf_sent', '2026-09-21T16:00:00+01:00'), event('report_issued', '2026-09-25T12:00:00+01:00')],
      ledger: [],
    });
    const a = byCode(nextActions(b, { now: '2026-09-26T09:00:00+01:00', clocks: [], gates: greenGates() }), 'SEND_COLLECT_OR_PAY')!;
    expect(a).toMatchObject({ dueAt: '2026-09-27T12:00:00+01:00', priority: 'today', templateId: 'letter.collect_or_pay', valuePence: 5_400 });
    expect(a.why).toContain('report + 48 hours');
    b.events.push(event('collect_or_pay_notice_sent', '2026-09-25T16:00:00+01:00'));
    expect(byCode(nextActions(b, { now: '2026-09-26T09:00:00+01:00', clocks: [], gates: greenGates() }), 'SEND_COLLECT_OR_PAY')).toBeUndefined();
  });

  it('SEND_DELAY_NOTICE when the GTA 4.10 authorisation clock is breached while hire runs', () => {
    const b = file1Bundle({ hire: [hire({ endAt: undefined, collectedAt: undefined })], events: [event('fnol', T0), event('ncaf_sent', '2026-09-21T16:00:00+01:00'), event('report_issued', '2026-09-25T12:00:00+01:00')] });
    const c = clock('gta_4_10_authorisation_check_3wd', '2026-09-25T12:00:00+01:00', '2026-09-30T12:00:00+01:00', { status: 'breached' });
    const a = byCode(nextActions(b, { now: '2026-10-02T09:00:00+01:00', clocks: [c], gates: greenGates() }), 'SEND_DELAY_NOTICE')!;
    expect(a).toMatchObject({ priority: 'now', templateId: 'letter.delay_notice_gta_4_10', valuePence: 5_976 });
    expect(a.why).toContain('2026-09-30');
  });

  it('END_HIRE_NOW when an off-hire clock has fired and the hire is open: value = daily gross × days over', () => {
    const b = file1Bundle({ hire: [hire({ endAt: undefined, collectedAt: undefined })] });
    const c = clock('gta_4_8_offhire_repair_24h', '2026-10-01T15:00:00+01:00', '2026-10-02T15:00:00+01:00', { status: 'breached', label: 'Off-hire within 24 hours of repair completion' });
    const a = byCode(nextActions(b, { now: '2026-10-05T10:00:00+01:00', clocks: [c], gates: greenGates() }), 'END_HIRE_NOW')!;
    // £49.80 + VAT = £59.76/day × 3 days over = £179.28
    expect(a).toMatchObject({ priority: 'now', dueAt: '2026-10-02T15:00:00+01:00', valuePence: 17_928 });
    expect(a.why).toContain('lesson d');
    // running (not yet breached) → today
    const running = clock('gta_4_14_offhire_tl_payment_5wd', '2026-10-05T09:00:00+01:00', '2026-10-12T09:00:00+01:00');
    expect(byCode(nextActions(b, { now: '2026-10-05T10:00:00+01:00', clocks: [running], gates: greenGates() }), 'END_HIRE_NOW')!.priority).toBe('today');
    // closed hire → nothing
    expect(byCode(nextActions(file1Bundle(), { now: '2026-10-05T10:00:00+01:00', clocks: [c], gates: greenGates() }), 'END_HIRE_NOW')).toBeUndefined();
  });
});

describe('nextActions — payment pack, chasers and escalation', () => {
  it('File 1 complete with green gates: only SEND_PAYMENT_PACK, due 1 WD after hire end, worth the £232.60 outstanding', () => {
    const actions = nextActions(file1Bundle(), { now: NOW, clocks: [], gates: greenGates() });
    expect(codes(actions)).toEqual(['SEND_PAYMENT_PACK']);
    const a = actions[0]!;
    expect(a).toMatchObject({ dueAt: '2026-10-05T10:00:00+01:00', priority: 'now', templateId: 'pack.gta_payment', valuePence: 23_260 });
    expect(a.blockedBy).toBeUndefined();
    expect(a.basis.join(' ')).toContain('GTA 6.1–6.3');
  });

  it('the pack is blocked by every non-green gate', () => {
    const gates = [...greenGates().filter((g) => g.gate !== 'impecuniosity' && g.gate !== 'rate'), gate('impecuniosity', 'amber', ['x']), gate('rate', 'red', ['BHR comparator'])];
    const a = byCode(nextActions(file1Bundle(), { now: NOW, clocks: [], gates }), 'SEND_PAYMENT_PACK')!;
    expect(a.blockedBy).toEqual(['impecuniosity', 'rate']); // in gate order
    expect(a.why).toContain('2 gates are not green');
  });

  it('chasers follow the clocks: the first active chaser only, then the complaint at day 28 (DISP 1, ICOBS 8.1/8.2, no FOS threat)', () => {
    const packAt = '2026-10-05T12:00:00+01:00';
    const b = file1Bundle({ events: [...file1Bundle().events, event('payment_pack_sent', packAt)] });
    const clocks = [
      clock('chaser_day_7', packAt, '2026-10-12T12:00:00+01:00', { status: 'met', metAt: '2026-10-12T10:00:00+01:00', sourceEventId: 'pack' }),
      clock('chaser_day_14', packAt, '2026-10-19T12:00:00+01:00', { sourceEventId: 'pack' }),
      clock('chaser_day_21', packAt, '2026-10-26T12:00:00+00:00', { sourceEventId: 'pack' }),
      clock('complaint_day_28', packAt, '2026-11-02T12:00:00+00:00', { sourceEventId: 'pack' }),
    ];
    const actions = nextActions(b, { now: '2026-10-14T10:00:00+01:00', clocks, gates: greenGates() });
    expect(codes(actions)).toEqual(['CHASER_14', 'COMPLAINT_28']);
    const chaser = actions[0]!;
    expect(chaser).toMatchObject({ dueAt: '2026-10-19T12:00:00+01:00', priority: 'this_week', templateId: 'letter.chaser_14', valuePence: 23_260 });
    expect(chaser.why).toContain('9 days after the payment pack');
    expect(chaser.why).toContain('team leader');
    const complaint = actions[1]!;
    expect(complaint).toMatchObject({ dueAt: '2026-11-02T12:00:00+00:00', priority: 'scheduled', templateId: 'letter.complaint_disp' });
    expect(complaint.why).toContain('ICOBS 8.1 and 8.2');
    expect(complaint.why).toContain('never threaten the FOS');
    expect(complaint.basis.join(' ')).toContain('DISP 2.7');
  });

  it('SPLIT_HEADS_INTERIM when a reduction disputes hire only and undisputed heads are unpaid; nothing once they are paid', () => {
    const reductionAt = '2026-10-08T10:00:00+01:00';
    const unpaid = file1Bundle({
      ledger: file1Bundle().ledger.filter((e) => e.kind !== 'paid'),
      events: [...file1Bundle().events, event('payment_pack_sent', '2026-10-05T12:00:00+01:00'), event('reduction_received', reductionAt, { data: { disputedHeads: ['hire'], reason: 'intervention rate' } })],
    });
    const a = byCode(nextActions(unpaid, { now: '2026-10-09T12:00:00+01:00', clocks: [], gates: greenGates() }), 'SPLIT_HEADS_INTERIM')!;
    // storage 32,400 + recovery 13,800 + engineer 28,500 = 74,700 undisputed
    expect(a).toMatchObject({ dueAt: '2026-10-09T10:00:00+01:00', priority: 'now', valuePence: 74_700, templateId: 'letter.chaser_7' });
    expect(a.why).toContain('CPR 25.7 once litigated');
    expect(a.why).toContain('£747.00');
    const paid = file1Bundle({ events: unpaid.events });
    expect(byCode(nextActions(paid, { now: '2026-10-09T12:00:00+01:00', clocks: [], gates: greenGates() }), 'SPLIT_HEADS_INTERIM')).toBeUndefined();
  });

  it('SEND_DSAR when the insurer alleges an offer that is not in the register; gone once the DSAR is sent', () => {
    const b = file1Bundle({ events: [...file1Bundle().events, event('letter_in', '2026-10-10T10:00:00+01:00', { data: { allegedOffer: true }, attributableTo: 'insurer' })] });
    const a = byCode(nextActions(b, { now: NOW, clocks: [], gates: greenGates() }), 'SEND_DSAR')!;
    expect(a).toMatchObject({ dueAt: '2026-10-12T10:00:00+01:00', priority: 'now', templateId: 'letter.dsar', valuePence: 59_760 });
    expect(a.why).toContain('call recordings');
    b.events.push(event('dsar_sent', '2026-10-12T09:00:00+01:00'));
    expect(byCode(nextActions(b, { now: NOW, clocks: [], gates: greenGates() }), 'SEND_DSAR')).toBeUndefined();
  });

  it('ICOBS_INTEREST_CLAIM on a breached ICOBS clock: £232.60 × (4% + 4%) × 30 days / 365 = £1.53, with the scope caveat', () => {
    const c = clock('icobs_8_2_6_three_months', '2026-09-21T16:00:00+01:00', '2026-12-21T16:00:00+00:00', { status: 'breached' });
    const a = byCode(nextActions(file1Bundle(), { now: '2027-01-20T12:00:00+00:00', clocks: [c], gates: greenGates() }), 'ICOBS_INTEREST_CLAIM')!;
    expect(a.valuePence).toBe(153);
    expect(a.priority).toBe('this_week');
    expect(a.why).toContain('assumed — confirm');
    expect(a.why).toContain('ICOBS 8.2.1R');
    expect(a.basis.join(' ')).toContain('Scope caveat');
    // base rate supplied: 3.75 + 4 = 7.75% → 23,260 × 7.75% × 30 / 365 = 148.17p
    const b = byCode(nextActions(file1Bundle(), { now: '2027-01-20T12:00:00+00:00', clocks: [c], gates: greenGates(), baseRatePct: 3.75 }), 'ICOBS_INTEREST_CLAIM')!;
    expect(b.valuePence).toBe(148);
    expect(b.why).not.toContain('assumed');
  });

  it('LETTER_BEFORE_CLAIM once the eight-week DISP window has passed unpaid (draft for the litigant in person), 5 WD to send', () => {
    const b = file1Bundle({ events: [...file1Bundle().events, event('payment_pack_sent', '2026-10-05T12:00:00+01:00'), event('complaint_sent', '2026-11-02T12:00:00+00:00')] });
    const disp = clock('disp_final_response_8_weeks', '2026-11-02T12:00:00+00:00', '2026-12-01T12:00:00+00:00', { status: 'breached' });
    const a = byCode(nextActions(b, { now: '2026-12-02T09:00:00+00:00', clocks: [disp], gates: greenGates() }), 'LETTER_BEFORE_CLAIM')!;
    expect(a).toMatchObject({ dueAt: '2026-12-08T12:00:00+00:00', priority: 'this_week', templateId: 'letter.letter_before_claim', valuePence: 23_260 });
    expect(a.why).toContain('litigant in person');
    // a final response that did not settle also triggers it, without the clock
    const fr = file1Bundle({ events: [...b.events, event('final_response_received', '2026-11-20T12:00:00+00:00')] });
    expect(byCode(nextActions(fr, { now: '2026-11-21T09:00:00+00:00', clocks: [], gates: greenGates() }), 'LETTER_BEFORE_CLAIM')!.dueAt).toBe('2026-11-27T12:00:00+00:00');
    b.events.push(event('letter_before_claim_sent', '2026-12-03T12:00:00+00:00'));
    expect(byCode(nextActions(b, { now: '2026-12-04T09:00:00+00:00', clocks: [disp], gates: greenGates() }), 'LETTER_BEFORE_CLAIM')).toBeUndefined();
  });

  it('PART36_OFFER at issue and DEFAULT_JUDGMENT on a breached defence clock (claimant files; CCGUK prepares)', () => {
    const issuedAt = '2027-01-10T10:00:00+00:00';
    const b = file1Bundle({ events: [...file1Bundle().events, event('payment_pack_sent', '2026-10-05T12:00:00+01:00'), event('proceedings_issued', issuedAt)] });
    const p36 = byCode(nextActions(b, { now: '2027-01-11T09:00:00+00:00', clocks: [], gates: greenGates() }), 'PART36_OFFER')!;
    expect(p36).toMatchObject({ dueAt: '2027-01-17T10:00:00+00:00', priority: 'this_week', templateId: 'letter.part36_offer', valuePence: 23_260 });
    expect(p36.why).toContain('CPR 36.17(4)');
    const dj = clock('default_judgment_14_days', issuedAt, '2027-01-24T10:00:00+00:00', { status: 'breached' });
    const d = byCode(nextActions(b, { now: '2027-01-25T09:00:00+00:00', clocks: [dj], gates: greenGates() }), 'DEFAULT_JUDGMENT')!;
    expect(d).toMatchObject({ priority: 'now', dueAt: '2027-01-24T10:00:00+00:00' });
    expect(d.why).toContain('CPR 12.3');
    expect(d.why).toContain('the claimant files it');
    b.events.push(event('defence_received', '2027-01-20T10:00:00+00:00'));
    expect(byCode(nextActions(b, { now: '2027-01-25T09:00:00+00:00', clocks: [dj], gates: greenGates() }), 'DEFAULT_JUDGMENT')).toBeUndefined();
  });

  it('VENDOR_VERIFICATION_PACK on a bank-validation reason, or no payment a month after the pack from an insurer that never paid before', () => {
    const b = file1Bundle({ events: [...file1Bundle().events, event('note', '2026-10-06T09:00:00+01:00', { data: { reason: 'bank_validation' }, summary: 'esure: bank details could not be validated' })] });
    const a = byCode(nextActions(b, { now: NOW, clocks: [], gates: greenGates() }), 'VENDOR_VERIFICATION_PACK')!;
    expect(a).toMatchObject({ dueAt: '2026-10-07T09:00:00+01:00', priority: 'now', templateId: 'letter.vendor_verification_pack', valuePence: 23_260 });
    expect(a.why).toContain('"Courtesy Cars Group UK Ltd"');
    expect(a.why).toContain('17430389');
    expect(a.why).toContain('never send legacy details');
    const packAt = '2026-10-05T12:00:00+01:00';
    const unpaid = file1Bundle({ ledger: file1Bundle().ledger.filter((e) => e.kind !== 'paid'), events: [...file1Bundle().events, event('payment_pack_sent', packAt)] });
    const settlement = clock('gta_6_7_settlement_1_month', packAt, '2026-11-05T12:00:00+00:00', { status: 'breached' });
    expect(byCode(nextActions(unpaid, { now: '2026-11-06T09:00:00+00:00', clocks: [settlement], gates: greenGates() }), 'VENDOR_VERIFICATION_PACK')).toBeUndefined();
    const never = byCode(nextActions(unpaid, { now: '2026-11-06T09:00:00+00:00', clocks: [settlement], gates: greenGates(), insurerPaidBefore: false }), 'VENDOR_VERIFICATION_PACK')!;
    expect(never.why).toContain('never paid CCGUK before');
    expect(never.valuePence).toBe(134_460);
  });

  it('flags: connected witness and high-risk supplier raise actions until cleared; closed or declined files produce nothing', () => {
    const b = file1Bundle();
    b.claim = {
      ...b.claim,
      flags: [
        { code: 'NON_INDEPENDENT_WITNESS', severity: 'warn', message: 'Witness shares the claimant’s address', raisedAt: '2026-09-22T09:00:00+01:00', raisedBy: 'system' },
        { code: 'SUPPLIER_HIGH_RISK', severity: 'warn', message: 'CARFLEX LTD (12640635): strike-off suspended', raisedAt: '2026-09-22T09:00:00+01:00', raisedBy: 'system' },
      ],
    };
    const actions = nextActions(b, { now: NOW, clocks: [], gates: greenGates() });
    expect(byCode(actions, 'FLAG_CONNECTED_WITNESS')).toMatchObject({ priority: 'now', dueAt: '2026-09-23T09:00:00+01:00' });
    expect(byCode(actions, 'FLAG_CONNECTED_WITNESS')!.why).toContain('Witness shares the claimant’s address');
    expect(byCode(actions, 'MONITOR_SUPPLIER')).toMatchObject({ dueAt: '2026-09-29T09:00:00+01:00' });
    b.claim = { ...b.claim, flags: b.claim.flags.map((f) => ({ ...f, clearedAt: '2026-09-23T09:00:00+01:00', clearedBy: 'u-approver', clearedReason: 'checked' })) };
    expect(codes(nextActions(b, { now: NOW, clocks: [], gates: greenGates() }))).toEqual(['SEND_PAYMENT_PACK']);
    expect(nextActions(file1Bundle({ claim: claim({ status: 'closed' }) }), { now: NOW, clocks: [], gates: [] })).toEqual([]);
    expect(nextActions(file1Bundle({ claim: claim({ status: 'declined' }) }), { now: NOW, clocks: [], gates: [] })).toEqual([]);
  });

  it('injected rules override title and template without touching the trigger logic', () => {
    const actions = nextActions(day0Bundle(), { now: T0, clocks: [], gates: [], rules: [{ code: 'SEND_NCAF', title: 'Custom NCAF', basis: ['kb:gta-4-1'], templateId: 'letter.ncaf_v2', trigger: 'kb' }] });
    expect(actions[0]).toMatchObject({ code: 'SEND_NCAF', title: 'Custom NCAF', templateId: 'letter.ncaf_v2', basis: ['kb:gta-4-1'] });
  });
});

describe('helpers', () => {
  it('hireAtRisk: agreed period, or at least 14 days for an open hire; ledger fallback', () => {
    expect(hireAtRisk(file1Bundle(), NOW)).toBe(59_760);
    expect(hireAtRisk(file1Bundle({ hire: [hire({ endAt: undefined })] }), '2026-09-24T10:00:00+01:00')).toBe(14 * 5_976);
    expect(hireAtRisk(file1Bundle({ hire: [hire({ endAt: undefined })] }), NOW)).toBe(29 * 5_976); // 22 Sep 10:00 → 20 Oct 12:00 = 28d2h → 29 days
    expect(hireAtRisk(file1Bundle({ hire: [] }), NOW)).toBe(59_760);
    expect(hireAtRisk(file1Bundle({ hire: [], ledger: [] }), NOW)).toBe(0);
  });

  it('outstandingBalance: claimed − paid as at now, optionally by head', () => {
    expect(outstandingBalance(file1Bundle(), NOW)).toBe(23_260);
    expect(outstandingBalance(file1Bundle(), '2026-10-03T12:00:00+01:00')).toBe(134_460);
    expect(outstandingBalance(file1Bundle(), NOW, new Set(['hire']))).toBe(23_260);
    expect(outstandingBalance(file1Bundle(), NOW, new Set(['storage']))).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Adversarial verification — unknown gates are not green, KB-shaped rules inject, London dates.
// ---------------------------------------------------------------------------------------------
describe('adversarial: playbook', () => {
  it('the payment pack is blocked when no gate results are supplied (gates unknown ≠ gates green)', () => {
    const a = byCode(nextActions(file1Bundle(), { now: NOW, clocks: [], gates: [] }), 'SEND_PAYMENT_PACK')!;
    expect(a.blockedBy).toEqual(['gates_not_evaluated']);
    expect(a.why).toContain('not been evaluated');
    // with all eight gates green it is unblocked
    expect(byCode(nextActions(file1Bundle(), { now: NOW, clocks: [], gates: greenGates() }), 'SEND_PAYMENT_PACK')!.blockedBy).toBeUndefined();
  });

  it('a KB-shaped rule (templateId null, priority instead of defaultPriority) injects cleanly', () => {
    const rules = [{ code: 'REFER_INJURY', title: 'Refer PI out', basis: ['laspo-56-60'], templateId: null, priority: 'now' as const, trigger: 'kb' }];
    const b = day0Bundle({ claim: claim({ status: 'fnol', accident: { ...FILE1_ACCIDENT, injuries: true } }) });
    const refer = byCode(nextActions(b, { now: T0, clocks: [], gates: [], rules }), 'REFER_INJURY')!;
    expect(refer.templateId).toBeUndefined();
    expect(refer.priority).toBe('now');
    expect(refer.basis).toEqual(['laspo-56-60']);
    expect(refer.title).toBe('Refer PI out');
  });

  it('REQUEST_CCTV after the 7-day window says the window closed and goes to now, instead of claiming time remains', () => {
    const cctv = day0Bundle({ claim: claim({ status: 'fnol', accident: { ...FILE1_ACCIDENT, cctvAvailable: true } }) });
    const a = byCode(nextActions(cctv, { now: '2026-10-01T09:00:00+01:00', clocks: [], gates: [] }), 'REQUEST_CCTV')!;
    expect(a.priority).toBe('now');
    expect(a.dueAt).toBe('2026-09-28T09:00:00+01:00');
    expect(a.why).toContain('closed on 2026-09-28');
    expect(a.why).not.toContain('within 7 days of the accident');
  });

  it('NCAF fallback: 1 working day from a BST Friday lands on the GMT Monday at the same wall-clock time (same convention as the clocks module)', () => {
    const fri = '2026-10-23T16:00:00+01:00'; // Friday in BST; Monday 26 Oct 2026 is the first GMT day
    const b = day0Bundle({ claim: claim({ status: 'fnol', openedAt: fri }), events: [event('fnol', fri)] });
    expect(byCode(nextActions(b, { now: fri, clocks: [], gates: [] }), 'SEND_NCAF')!.dueAt).toBe('2026-10-26T16:00:00+00:00');
  });

  it('chaser day counts use London dates: a pack logged at 00:30 BST on 5 Oct is 9 days before 14 Oct, not 10', () => {
    const packAt = '2026-10-05T00:30:00+01:00'; // 23:30 UTC on 4 Oct
    const b = file1Bundle({ events: [...file1Bundle().events, event('payment_pack_sent', packAt)] });
    const clocks = [clock('chaser_day_7', packAt, '2026-10-12T00:30:00+01:00', { sourceEventId: 'pack' })];
    const a = byCode(nextActions(b, { now: '2026-10-14T10:00:00+01:00', clocks, gates: greenGates() }), 'CHASER_7')!;
    expect(a.why).toContain('9 days after the payment pack of 2026-10-05');
    expect(a.priority).toBe('now');
  });

  it('the hire-ended test is by London instant, not by date: a hire ending later today is still open', () => {
    const b = file1Bundle({ hire: [hire({ endAt: '2026-10-20T17:00:00+01:00' })] });
    expect(byCode(nextActions(b, { now: '2026-10-20T12:00:00+01:00', clocks: [], gates: greenGates() }), 'SEND_PAYMENT_PACK')).toBeUndefined();
    expect(byCode(nextActions(b, { now: '2026-10-20T17:00:00+01:00', clocks: [], gates: greenGates() }), 'SEND_PAYMENT_PACK')).toBeDefined();
  });
});
