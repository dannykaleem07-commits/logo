// owned by casework
/**
 * The Case Brief (docs/SUPREME-DESIGN.md §E.2), facts/placeholders (§E.3) and PII masking (§K.3): byte-stable for the
 * same state, live events only, stable fact ids, masked contacts, and placeholders resolved by code. Invented data.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import { briefJson, buildCaseBrief } from '../casework/caseBrief.js';
import { dateDisplay, moneyDisplay, resolvePlaceholders } from '../casework/facts.js';
import { maskAddress, maskDeep, maskDob, maskEmail, maskPhone, maskText, postcodeDistrict } from '../casework/mask.js';
import { claimPlaceholderResolver } from '../routes/casework.js';

const T0 = '2026-10-07T09:00:00.000Z';
let t: TestApp;
let claimId: string;
let ids: ReturnType<TestApp['ctx']['repos']['seedFileOne']>;

beforeEach(async () => {
  t = await createTestApp(T0);
  ids = t.ctx.repos.seedFileOne(t.ctx.db);
  claimId = ids.claimId;
  recomputeClocks(t.ctx, claimId);
});
afterEach(async () => {
  await t.close();
});

describe('mask (§K.3)', () => {
  it('masks identifiers and keeps names', () => {
    expect(maskEmail('jane.doe@example.test')).toBe('j•••@example.test');
    expect(maskPhone('07700 900123')).toBe('07••• •••123');
    expect(maskDob('1988-04-02')).toBe('1988');
    expect(postcodeDistrict('E1 6AN')).toBe('E1');
    expect(maskAddress({ line1: '1 Example Street', town: 'London', postcode: 'E1 6AN' })).toBe('London E1');
    expect(maskDeep({ name: 'Jane Doe', dateOfBirth: '1988-04-02', drivingLicenceNumber: 'DOEJA804028JD9AB', bank: { accountName: 'J Doe', accountNumber: '12345678', sortCode: '12-34-56' }, policyNumber: 'POL-99887766', email: 'jane.doe@example.test' })).toEqual({
      name: 'Jane Doe',
      dateOfBirth: '1988',
      drivingLicenceNumber: '…9AB',
      bank: { accountName: 'J Doe', accountNumber: '…5678', sortCode: '••-••-••' },
      policyNumber: '…7766',
      email: 'j•••@example.test',
    });
    expect(maskDeep({ email: 'jane.doe@example.test' }, { keepContacts: ['jane.doe@example.test'] })).toEqual({ email: 'jane.doe@example.test' });
    const text = maskText('Call 07700 900123 or email jane.doe@example.test; sort code 12-34-56, account 12345678, NI QQ123456C.');
    expect(text).not.toMatch(/900123|jane\.doe|12-34-56|12345678|QQ123456C/);
    expect(text).toContain('j•••@example.test');
  });
});

describe('facts (§E.3)', () => {
  it('formats money and London dates', () => {
    expect(moneyDisplay(128700)).toBe('£1,287.00');
    expect(dateDisplay('2026-10-07')).toBe('7 October 2026');
    // 23:30 UTC on 6 October is 00:30 on 7 October in London (BST)
    expect(dateDisplay('2026-10-06T23:30:00.000Z')).toBe('7 October 2026');
  });

  it('resolves known placeholders and reports unknown ones (left in the text)', () => {
    const brief = buildCaseBrief(t.ctx, claimId, { mask: false });
    const r = resolvePlaceholders('Ref {{fact:claim.reference}}, paid {{ fact:ledger.hire.paidPence }}, {{fact:nope.unknown}}.', brief);
    expect(r.text).toBe(`Ref ${brief.reference}, paid ${brief.facts['ledger.hire.paidPence']!.display}, {{fact:nope.unknown}}.`);
    expect(r.used).toEqual(['claim.reference', 'ledger.hire.paidPence']);
    expect(r.unknown).toEqual(['nope.unknown']);
  });

  it('the registered resolver fills draft text from the unmasked brief', () => {
    expect(claimPlaceholderResolver(t.ctx, claimId, 'Hire at {{fact:hire.current.dailyRatePence}} a day from {{fact:hire.current.startAt}}')).toBe('Hire at £49.80 a day from 10 August 2026');
    expect(claimPlaceholderResolver(t.ctx, claimId, 'Email {{fact:party.claimant.email}}')).toBe('Email jane.doe@example.test');
  });
});

describe('buildCaseBrief (§E.2)', () => {
  it('is byte-stable for the same state and clock', () => {
    const a = briefJson(buildCaseBrief(t.ctx, claimId));
    const b = briefJson(buildCaseBrief(t.ctx, claimId));
    expect(a).toBe(b);
    expect(JSON.stringify(buildCaseBrief(t.ctx, claimId))).toBe(JSON.stringify(buildCaseBrief(t.ctx, claimId)));
    t.setNow('2026-10-08T09:00:00.000Z');
    expect(briefJson(buildCaseBrief(t.ctx, claimId))).not.toBe(a);
  });

  it('has the documented shape and stable fact ids', () => {
    const brief = buildCaseBrief(t.ctx, claimId, { mask: false });
    expect(brief).toMatchObject({ version: 'brief/1', claimId, generatedAt: T0, claim: { status: 'chasing', liability: 'admitted' } });
    expect(Object.keys(brief.facts)).toEqual([...Object.keys(brief.facts)].sort());
    expect(brief.facts['claim.reference']!.display).toBe(brief.reference);
    expect(brief.facts['claim.atFaultInsurerRef']!.display).toBe('EXI/2026/778899');
    expect(brief.facts['party.claimant.name']!.display).toBe('Jane Doe');
    expect(brief.facts['ledger.hire.paidPence']).toBeDefined();
    expect(brief.facts['hire.current.dailyRatePence']).toMatchObject({ value: 4980, display: '£49.80' });
    expect(brief.facts[`offer.${ids.offerId}.amountPence`]).toMatchObject({ value: 2037, display: '£20.37' });
    expect(brief.offers).toEqual([expect.objectContaining({ id: ids.offerId, head: 'hire', amountPence: 2037, clientDecision: 'declined' })]);
    for (const c of brief.clocks) expect(brief.facts[`clock.${c.id}.dueAt`]?.value).toBe(c.dueAt);
    expect(brief.money.heads.map((h) => h.head)).toEqual([...brief.money.heads.map((h) => h.head)].sort());
    expect(brief.nextActions.length).toBeGreaterThan(0);
    expect(brief.recipients.map((r) => r.role)).toEqual(['at_fault_insurer', 'client']);
    expect(brief.correspondence.priorLetters.length).toBeGreaterThan(0);
  });

  it('masks contact details for prompts and keeps names', () => {
    const masked = buildCaseBrief(t.ctx, claimId);
    const json = briefJson(masked);
    expect(json).not.toContain('jane.doe@example.test');
    expect(json).not.toContain('900123');
    expect(json).not.toContain('1 Example Street');
    expect(json).toContain('Jane Doe');
    expect(masked.facts['party.claimant.email']!.display).toBe('j•••@example.test');
    expect(masked.parties.find((p) => p.id === ids.claimantId)!.contact).toContain('London E1');
    // the insurer's business address is not personal data: kept for writing to it
    expect(masked.recipients.find((r) => r.role === 'at_fault_insurer')!.email).toBe('thirdparty.claims@example-insurer.test');
  });

  it('reads live events only: a corrected event no longer drives the brief', () => {
    const before = buildCaseBrief(t.ctx, claimId, { mask: false });
    const ended = t.ctx.repos.listEvents(t.ctx.db, claimId, { type: 'payment_pack_sent' })[0]!;
    t.ctx.repos.appendEvent(t.ctx.db, { claimId, type: 'payment_pack_sent', at: '2026-09-20T15:00:00.000Z', summary: 'Payment pack sent (corrected date)', data: { correctsEventId: ended.id }, createdBy: 'handler' });
    const after = buildCaseBrief(t.ctx, claimId, { mask: false });
    const dues = (b: typeof before) => b.clocks.map((c) => `${c.id}:${c.dueAt}`).join(',');
    expect(dues(after)).not.toBe(dues(before));
    expect(t.ctx.repos.loadClaimBundle(t.ctx.db, claimId).events.some((e) => e.id === ended.id)).toBe(false);
  });

  it('includes approved memory only, and open tasks and Needs-you items', () => {
    t.ctx.repos.createMemoryItem(t.ctx.db, { kind: 'note', scope: `claim:${claimId}`, text: 'Approved: insurer pays faster by email', status: 'approved', createdBy: 'owner' });
    t.ctx.repos.createMemoryItem(t.ctx.db, { kind: 'note', scope: `claim:${claimId}`, text: 'Proposed: not yet approved', createdBy: 'agent:case_manager' });
    t.ctx.repos.createTask(t.ctx.db, { claimId, kind: 'chaser', title: 'Chase', note: 'Chase the balance', dueAt: '2026-10-10T09:00:00.000Z', createdBy: 'agent:case_manager' });
    const brief = buildCaseBrief(t.ctx, claimId);
    expect(brief.memory.map((m) => m.text)).toEqual(['Approved: insurer pays faster by email']);
    expect(brief.openTasks).toEqual([expect.objectContaining({ kind: 'chaser', note: 'Chase the balance' })]);
  });
});
