// owned by claimai-server
/** The deterministic phrase parser (docs/CLAIM-AI-INPUT.md §3.3): every pattern P1–P32, clauses, dates, questions. */
import { describe, expect, it } from 'vitest';
import { BANNED_INTAKE_WORDS } from '../intake/smart/types.js';
import { parseOwnerUpdate, resolveDocument, splitClauses, type ParseContext } from './parse.js';

// Monday 12 October 2026, 10:00 London
const NOW = '2026-10-12T09:00:00.000Z';
const HIRE = { id: 'h1', agreementNumber: 'HA-0042', startAt: '2026-10-03T09:00:00.000Z' };
const ctx: ParseContext = {
  now: NOW,
  openHires: [HIRE],
  insurerName: 'Example Mutual',
  clientFirstName: 'Jane',
  evidence: [
    { id: 'ev-old', kind: 'engineer_report', filename: 'Engineer report v1.pdf', createdAt: '2026-10-05T09:00:00.000Z' },
    { id: 'ev-eng', kind: 'engineer_report', filename: 'Engineer report.pdf', createdAt: '2026-10-08T09:00:00.000Z' },
    { id: 'ev-v5c', kind: 'v5c', filename: 'V5C.pdf', createdAt: '2026-10-02T09:00:00.000Z' },
  ],
  templates: [
    { id: 'letter.client_update', title: 'Update on your claim' },
    { id: 'letter.chaser_7', title: 'Chaser' },
  ],
  fieldValues: { 'claim.atFaultInsurerRef': 'TPI/778812' },
  liability: 'unknown',
};
const parse = (t: string, extra: Partial<ParseContext> = {}) => parseOwnerUpdate(t, { ...ctx, ...extra });
const types = (t: string, extra: Partial<ParseContext> = {}) => parse(t, extra).actions.map((a) => `${a.type}:${a.tier}`);

describe('clauses', () => {
  it('splits on sentence ends, ; and new lines, and on , / and only when both sides have a verb', () => {
    expect(splitClauses('client called, car repaired, hire ended yesterday').map((c) => c.text)).toEqual(['client called', 'car repaired', 'hire ended yesterday']);
    expect(splitClauses('TP insurer admitted liability on the phone today, ref AB123').map((c) => c.text)).toEqual(['TP insurer admitted liability on the phone today, ref AB123']);
    expect(splitClauses('Client called. Parts ordered; estimate received\nreview this claim').map((c) => c.text)).toEqual(['Client called', 'Parts ordered', 'estimate received', 'review this claim']);
    expect(splitClauses('the client is lying, decline it').map((c) => c.text)).toEqual(['the client is lying', 'decline it']);
    expect(splitClauses('they paid £3,450.00 for the hire').map((c) => c.text)).toEqual(['they paid £3,450.00 for the hire']);
  });

  it('"client called, car repaired, hire ended yesterday": three lines; the date is shared and said so; the call is today', () => {
    const r = parse('client called, car repaired, hire ended yesterday');
    expect(r.coverage).toBe(1);
    expect(r.questions).toEqual([]);
    const [call, repair, hire] = r.actions;
    expect(call).toMatchObject({ key: 'a1', type: 'event', tier: 'apply', ticked: true, quote: 'client called', source: 'rules', from: 'owner_text', params: { eventType: 'call', at: NOW, precision: 'date' } });
    expect(repair).toMatchObject({ key: 'a2', type: 'event', params: { eventType: 'repair_completed', at: '2026-10-11T11:00:00.000Z' }, detail: "date taken from 'yesterday'", undoable: false });
    expect(hire).toMatchObject({ key: 'a3', type: 'hire_end', tier: 'apply', params: { hireId: 'h1', endAt: '2026-10-11T11:00:00.000Z', endTrigger: 'repair_complete_24h' }, undoable: true });
    expect(hire!.title).toBe('End hire HA-0042 on Sun 11 Oct 2026 (repair completed)');
    expect(r.clauses.map((c) => c.actions)).toEqual([['a1'], ['a2'], ['a3']]);
  });
});

describe('patterns P1–P32', () => {
  it('P1 hire ended: client_returned without a repair clause; no hire → unsupported; two hires → question; the answer picks one', () => {
    expect(parse('the hire ended on 9th October').actions[0]).toMatchObject({ type: 'hire_end', params: { endTrigger: 'client_returned', endAt: '2026-10-09T11:00:00.000Z' } });
    expect(parse('off hire today').actions[0]).toMatchObject({ type: 'hire_end' });
    expect(parse('hire ended yesterday', { openHires: [] }).actions[0]).toMatchObject({ type: 'unsupported', tier: 'refused', ticked: false, tickable: false });
    const two = { openHires: [HIRE, { id: 'h2', agreementNumber: 'HA-0043', startAt: '2026-10-04T09:00:00.000Z' }] };
    const q = parse('hire ended yesterday', two);
    expect(q.actions).toEqual([]);
    expect(q.questions[0]).toMatchObject({ id: 'q1-hire', text: 'Which hire ended?', options: [{ id: 'h1', label: 'HA-0042' }, { id: 'h2', label: 'HA-0043' }] });
    const a = parse('hire ended yesterday', { ...two, answers: { 'q1-hire': { optionId: 'h2', text: null, date: null } } });
    expect(a.questions).toEqual([]);
    expect(a.actions[0]).toMatchObject({ type: 'hire_end', params: { hireId: 'h2', agreementNumber: 'HA-0043' } });
  });

  it('P2–P10 chronology events (P10 total loss needs a tick)', () => {
    const ev = (t: string) => parse(t).actions[0]!.params.eventType;
    expect(ev('the car has been repaired')).toBe('repair_completed');
    expect(ev('repairs are done')).toBe('repair_completed');
    expect(ev('repairs started on Monday')).toBe('repair_started');
    expect(parse('repairs started on Monday').actions[0]!.params.at).toBe('2026-10-05T11:00:00.000Z');
    expect(ev('garage is delayed waiting for parts')).toBe('repair_delay');
    expect(ev('parts ordered on Friday')).toBe('parts_ordered');
    expect(ev('parts arrived')).toBe('parts_arrived');
    expect(ev('client got her car back')).toBe('vehicle_returned');
    expect(ev('car collected 2/10/2026')).toBe('recovery');
    expect(ev('engineer inspected the car yesterday')).toBe('inspection');
    expect(ev('engineer was instructed')).toBe('engineer_instructed');
    expect(ev('estimate received')).toBe('estimate_received');
    expect(parse('car written off').actions[0]).toMatchObject({ params: { eventType: 'total_loss_confirmed' }, tier: 'confirm', ticked: false });
  });

  it('P11 a call (today by default, own date when given)', () => {
    expect(parse('spoke to Jane this morning').actions[0]).toMatchObject({ type: 'event', params: { eventType: 'call', at: '2026-10-12T08:00:00.000Z', precision: 'datetime' } });
    expect(parse('the insurer rang').actions[0]).toMatchObject({ params: { eventType: 'call' } });
  });

  it('P12 liability admitted: liability (tick), call, follow-up task in 2 working days; a reference in the same clause is the insurer\'s (no AI needed)', () => {
    const r = parse('TP insurer admitted liability on the phone today, ref AB123');
    expect(r.coverage).toBe(1);
    expect(r.clauses[0]!.matched).toBe(true);
    // A different reference is on file (TPI/778812): the new one needs a tick, never a silent overwrite.
    expect(r.actions.map((a) => `${a.type}:${a.tier}`)).toEqual(['liability_position:confirm', 'event:apply', 'task:apply', 'field_update:confirm']);
    expect(r.actions[3]).toMatchObject({ params: { target: 'claim.atFaultInsurerRef', value: 'AB123', current: 'TPI/778812' }, ticked: false });
    // No reference on file: applied, plus "handling reference received" today.
    const noPhone = parse('TP insurer admitted liability today ref AB123', { fieldValues: {} });
    expect(noPhone.coverage).toBe(1);
    expect(noPhone.actions.map((a) => `${a.params.eventType ?? a.type}:${a.tier}`)).toEqual(['liability_position:confirm', 'note:apply', 'task:apply', 'field_update:apply', 'handling_ref_received:apply']);
    expect(noPhone.actions[1]!.params.at?.slice(0, 10)).toBe('2026-10-12');
    expect(r.actions[0]).toMatchObject({ params: { value: 'admitted', current: 'unknown' }, ticked: false });
    expect(r.actions[2]).toMatchObject({ params: { taskKind: 'follow_up', dueAt: '2026-10-14T08:00:00.000Z', note: 'Ask Example Mutual to confirm the admission in writing' } });
    const plain = parse('their insurer has accepted liability');
    expect(plain.coverage).toBe(1);
    expect(plain.actions.map((a) => a.type)).toEqual(['liability_position', 'note', 'task']);
  });

  it('P13 liability denied / disputed / split', () => {
    expect(types('liability denied')).toEqual(['liability_position:confirm', 'note:apply']);
    expect(parse('liability is split 50/50').actions[0]).toMatchObject({ params: { value: 'split' }, detail: 'split 50/50' });
  });

  it('P14 the insurer reference: kept as typed (upper-cased); overwrite → tick; empty → apply + handling_ref_received', () => {
    const over = parse('their ref is TPI/9999');
    expect(over.actions).toHaveLength(1);
    expect(over.actions[0]).toMatchObject({ type: 'field_update', tier: 'confirm', why: 'On file: TPI/778812 — tick to replace', params: { target: 'claim.atFaultInsurerRef', value: 'TPI/9999', current: 'TPI/778812' } });
    const fresh = parse('insurer reference is ab 12345', { fieldValues: {} });
    expect(fresh.actions.map((a) => `${a.type}:${a.tier}`)).toEqual(['field_update:apply', 'event:apply']);
    expect(fresh.actions[0]!.params.value).toBe('AB 12345');
    expect(fresh.actions[1]!.params.eventType).toBe('handling_ref_received');
    expect(parse('their ref is TPI/778812').actions).toEqual([]); // already on file
    expect(parse('ref 12345').coverage).toBe(0); // no insurer context
  });

  it('P15 police reference; P16 the client’s new phone / email / address', () => {
    expect(parse('police reference is CR/123/26').actions[0]).toMatchObject({ type: 'field_update', params: { target: 'claim.accident.policeReference', value: 'CR/123/26' } });
    expect(parse("client's new phone is 07700 900123").actions[0]).toMatchObject({ params: { target: 'party:claimant.phone', value: '07700 900123' } });
    expect(parse('her email is jane.doe@example.test').actions[0]).toMatchObject({ params: { target: 'party:claimant.email' } });
  });

  it('P17 hold contact: until the start of the stated day; no date → "Until when?"; answers set it', () => {
    const r = parse("don't chase the client until Monday");
    expect(r.actions[0]).toMatchObject({ type: 'instruction', tier: 'apply', params: { text: "Don't chase the client until Monday", effect: { kind: 'hold_contact', contacts: ['client'] }, until: '2026-10-18T23:00:00.000Z', appliesTo: ['all'] } });
    expect(parse('do not email the insurer until 20/10').actions[0]!.params.effect).toEqual({ kind: 'hold_contact', contacts: ['at_fault_insurer'] });
    const q = parse("don't chase the client");
    expect(q.actions).toEqual([]);
    expect(q.questions[0]).toMatchObject({ id: 'q1-until', text: 'Until when?', allowDate: true, options: [{ id: 'monday' }, { id: 'week' }, { id: 'until_say' }] });
    expect(parse("don't chase the client", { answers: { 'q1-until': { optionId: 'until_say', text: null, date: null } } }).actions[0]!.params.until).toBeNull();
    expect(parse("don't chase the client", { answers: { 'q1-until': { optionId: 'week', text: null, date: null } } }).actions[0]!.params.until).toBe('2026-10-18T23:00:00.000Z');
    expect(parse("don't chase the client", { answers: { 'q1-until': { optionId: null, text: null, date: '2026-10-21' } } }).actions[0]!.params.until).toBe('2026-10-20T23:00:00.000Z');
  });

  it('P18 ask me before sending; P19 pause (with a timed instruction) / resume', () => {
    expect(parse('ask me before sending anything to the insurer').actions[0]!.params.effect).toEqual({ kind: 'ask_before_sending', contacts: ['at_fault_insurer'] });
    const p = parse('pause this claim until Friday');
    expect(p.actions.map((a) => a.type)).toEqual(['pause_agents', 'instruction']);
    expect(p.actions[0]!.params.until).toBe('2026-10-15T23:00:00.000Z');
    expect(p.actions[1]!.params.effect).toEqual({ kind: 'pause_agents' });
    expect(types('pause the agents')).toEqual(['pause_agents:apply']);
    expect(types('resume this claim')).toEqual(['resume_agents:apply']);
  });

  it('P20 send a document: newest of its kind; none → question; refused while the contact is held', () => {
    const r = parse('send the engineer report to the insurer');
    expect(r.actions[0]).toMatchObject({ type: 'run_job', tier: 'apply', detail: 'newest of 2', params: { jobKind: 'send_document', recipient: 'at_fault_insurer', evidenceIds: ['ev-eng'] } });
    const q = parse('send the estimate to the insurer');
    expect(q.questions[0]).toMatchObject({ id: 'q1-doc', text: 'Which document should I send (the estimate)?' });
    expect(parse('send the estimate to the insurer', { answers: { 'q1-doc': { optionId: 'ev-v5c', text: null, date: null } } }).actions[0]!.params.evidenceIds).toEqual(['ev-v5c']);
    expect(resolveDocument('the V5C', ctx.evidence).evidence?.id).toBe('ev-v5c');
  });

  it('P21 chase (refused while held); P22 ask for documents; P23 draft a letter; P24 review / re-plan', () => {
    expect(parse('chase the insurer').actions[0]).toMatchObject({ type: 'run_job', params: { jobKind: 'chase', emailKind: 'chaser', recipient: 'at_fault_insurer' } });
    const held = [{ id: 'i1', text: "Don't chase the client until Monday", appliesTo: ['all' as const], effect: { kind: 'hold_contact' as const, contacts: ['client' as const] }, activeFrom: NOW, until: '2026-10-18T23:00:00.000Z' }];
    expect(parse('chase the client', { instructions: held }).actions[0]).toMatchObject({ tier: 'refused', why: "You asked: Don't chase the client until Monday" });
    expect(parse('ask the client for bank statements').actions[0]).toMatchObject({ params: { jobKind: 'request_documents', emailKind: 'doc_request', purpose: 'bank statements' } });
    expect(parse('draft an update on your claim to the client').actions[0]).toMatchObject({ params: { jobKind: 'draft_letter', templateId: 'letter.client_update', recipient: 'client' } });
    expect(parse('write a letter to the insurer').questions[0]).toMatchObject({ text: 'Which letter should I prepare?' });
    expect(types('review this claim')).toEqual(['run_job:apply']);
    expect(parse('replan the claim').actions[0]!.params.jobKind).toBe('replan');
  });

  it('P25 reminders at 09:00 on the stated day', () => {
    expect(parse('remind me to call the insurer tomorrow').actions[0]).toMatchObject({ type: 'task', params: { taskKind: 'other', dueAt: '2026-10-13T08:00:00.000Z', note: 'Call the insurer' } });
    expect(parse('call the client on Thursday').actions[0]).toMatchObject({ params: { taskKind: 'call', dueAt: '2026-10-15T08:00:00.000Z' } });
    expect(parse('follow up next week').actions[0]).toMatchObject({ params: { taskKind: 'follow_up', dueAt: '2026-10-19T08:00:00.000Z' } });
  });

  it('P26 notes; P27 solicitor → legal (Needs-you) + client hold + note', () => {
    expect(parse('note: client prefers email').actions[0]).toMatchObject({ type: 'note', params: { summary: 'Client prefers email' } });
    expect(types('client now has a solicitor')).toEqual(['legal:needs_you', 'instruction:apply', 'note:apply']);
    expect(parse('client now has a solicitor').actions[1]!.params.effect).toEqual({ kind: 'hold_contact', contacts: ['client'] });
  });

  it('P28 offers (record only, tick) — replacement car → intervention register; P29 money → Needs-you; P30 decisions; P31 close / legal', () => {
    expect(parse('Example Mutual offered £2,000 for a replacement car').actions[0]).toMatchObject({ type: 'offer_received', tier: 'confirm', params: { amountPence: 200000, register: 'intervention' } });
    expect(parse('they offered £1,250.50').actions[0]!.params).toMatchObject({ amountPence: 125050, register: 'settlement' });
    expect(parse('they paid £3,450.00 for the hire').actions[0]).toMatchObject({ type: 'money', tier: 'needs_you', ticked: true, params: { amountPence: 345000, head: 'hire' } });
    expect(types('accept the offer')).toEqual(['offer_decision:needs_you']);
    expect(types('close this claim')).toEqual(['close_or_decline:needs_you']);
    expect(types('send a letter before claim')).toEqual(['legal:needs_you']);
  });

  it('a legal step after an offer in the same sentence is its own clause (never lost in a note)', () => {
    const t = types('they offered £3,000 to settle, issue proceedings, close the claim');
    expect(t).toEqual(expect.arrayContaining(['offer_received:confirm', 'legal:needs_you', 'close_or_decline:needs_you']));
  });
  it('P32 accusation words → private note only (never an instruction, event or prompt text); the rest still parses', () => {
    const r = parse('the client is lying, decline it');
    expect(r.privateNote).toBe(true);
    expect(r.actions.map((a) => `${a.type}:${a.tier}`)).toEqual(['private_note:private', 'close_or_decline:needs_you']);
    for (const a of r.actions.filter((x) => x.type !== 'private_note')) expect(BANNED_INTAKE_WORDS.test(JSON.stringify(a))).toBe(false);
    expect(types("don't chase the client, it's a scam")).toContain('private_note:private');
    // whole words only: "supplying" / "applying" are not accusations
    expect(parse('the garage is supplying parts').privateNote).toBe(false);
  });

  it('not understood → unmatched clauses (for the AI); coverage counts them', () => {
    const r = parse('garage says parts due Thursday, keep the client posted weekly');
    expect(r.clauses).toEqual([
      { text: 'garage says parts due Thursday', matched: false, actions: [] },
      { text: 'keep the client posted weekly', matched: false, actions: [] },
    ]);
    expect(r.coverage).toBe(0);
    const half = parse('client called. the client is happy');
    expect(half.coverage).toBe(0.5);
    expect(parse('').coverage).toBe(1);
  });

  it('a past event dated in the future → a question, not an action', () => {
    const r = parse('repairs started on 20/10/2026');
    expect(r.actions).toEqual([]);
    expect(r.questions[0]).toMatchObject({ id: 'q1-future', allowDate: true });
  });
});
