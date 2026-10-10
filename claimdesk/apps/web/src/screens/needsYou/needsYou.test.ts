import { describe, expect, it } from 'vitest';
import type { NeedsYouItem } from '../../api/needsYouApi';
import { canEditThenApprove, cardWarnings, confirmFieldEdits, londonDateTime, documentRef, emailPreview, fieldDiff, groupNeedsYou, inboxKey, initialEdits, moveSelection, offerRows, optionForKey, orderedNeedsYou, payloadLink, rendererFor } from './needsYou';

const item = (over: Partial<NeedsYouItem>): NeedsYouItem => ({
  id: over.id ?? 'x',
  kind: 'question',
  title: 't',
  summary: 's',
  options: [],
  payload: {},
  priority: 'normal',
  status: 'open',
  createdBy: 'agent:mail',
  createdAt: '2026-10-01T09:00:00.000Z',
  ...over,
});

const NOW = '2026-10-05T09:00:00.000Z';

describe('grouping and navigation', () => {
  it('groups urgent / today / later', () => {
    const g = groupNeedsYou(
      [
        item({ id: 'u', priority: 'urgent' }),
        item({ id: 'overdue', dueAt: '2026-10-05T08:00:00.000Z' }),
        item({ id: 'hi', priority: 'high' }),
        item({ id: 'new', createdAt: '2026-10-05T08:30:00.000Z' }),
        item({ id: 'old', priority: 'low' }),
      ],
      NOW,
    );
    expect(g.urgent.map((i) => i.id)).toEqual(['u', 'overdue']);
    expect(g.today.map((i) => i.id)).toEqual(['hi', 'new']);
    expect(g.later.map((i) => i.id)).toEqual(['old']);
    expect(orderedNeedsYou(g).map((i) => i.id)).toEqual(['u', 'overdue', 'hi', 'new', 'old']);
  });

  it('j/k/a/e/r map to actions except while typing', () => {
    expect(inboxKey({ key: 'j' })).toBe('next');
    expect(inboxKey({ key: 'k' })).toBe('prev');
    expect(inboxKey({ key: 'a' })).toBe('approve');
    expect(inboxKey({ key: 'e' })).toBe('edit');
    expect(inboxKey({ key: 'r' })).toBe('reject');
    expect(inboxKey({ key: 'j', target: { tagName: 'textarea' } })).toBeUndefined();
    expect(inboxKey({ key: 'a', ctrlKey: true })).toBeUndefined();
    expect(inboxKey({ key: 'x' })).toBeUndefined();
  });

  it('moves the selection within bounds', () => {
    expect(moveSelection(['a', 'b', 'c'], undefined, 1)).toBe('a');
    expect(moveSelection(['a', 'b', 'c'], 'a', 1)).toBe('b');
    expect(moveSelection(['a', 'b', 'c'], 'c', 1)).toBe('c');
    expect(moveSelection(['a', 'b', 'c'], 'a', -1)).toBe('a');
    expect(moveSelection([], 'a', 1)).toBeUndefined();
  });

  it('keys pick the primary, edit and danger options', () => {
    const i = item({ options: [{ id: 'approve', label: 'Approve', tone: 'primary' }, { id: 'edit', label: 'Edit', tone: 'neutral', requiresEdit: true }, { id: 'reject', label: 'Reject', tone: 'danger', requiresReason: true }] });
    expect(optionForKey(i, 'approve')?.id).toBe('approve');
    expect(optionForKey(i, 'edit')?.id).toBe('edit');
    expect(optionForKey(i, 'reject')?.id).toBe('reject');
    expect(optionForKey(item({}), 'approve')?.id).toBe('acknowledge');
  });
});

describe('renderers', () => {
  it('reads an email preview from several payload shapes', () => {
    const p = { email: { to: ['h@insurer.example'], subject: 'Re: claim', bodyText: 'Hello', attachments: [{ filename: 'v5c.pdf' }] } };
    expect(emailPreview(p)).toMatchObject({ to: ['h@insurer.example'], subject: 'Re: claim', bodyText: 'Hello', attachments: ['v5c.pdf'] });
    expect(emailPreview({ subject: 'S', body: 'B', to: 'x@y.example' })).toMatchObject({ subject: 'S', bodyText: 'B', to: ['x@y.example'] });
    expect(emailPreview({ nothing: true })).toBeUndefined();
    expect(rendererFor('approve_send', p)).toBe('email');
  });

  it('documents, field diffs and offer analysis', () => {
    expect(documentRef({ documentId: 'd1' })).toBe('d1');
    expect(documentRef({ draftRefs: [{ kind: 'outbox', id: 'o' }, { kind: 'document', id: 'd2' }] })).toBe('d2');
    expect(rendererFor('ai_paused', { documentId: 'd1' })).toBe('document');
    const fields = { fields: [{ target: 'vehicle:client.vin', label: 'VIN', current: null, proposed: 'WVWZZZ1JZXW000001', confidence: 0.93, source: { quote: 'VIN: WVW…' } }] };
    expect(fieldDiff(fields)).toEqual([{ key: 'vehicle:client.vin', label: 'VIN', current: '—', proposed: 'WVWZZZ1JZXW000001', confidence: 0.93, source: 'VIN: WVW…' }]);
    expect(rendererFor('confirm_fields', fields)).toBe('fields');
    expect(initialEdits({ kind: 'confirm_fields', payload: fields })).toMatchObject({ mode: 'fields', fields: { 'vehicle:client.vin': 'WVWZZZ1JZXW000001' } });
    const offer = { analysis: { offerPence: 120000, claimedPence: 150000, recommendation: 'counter', confidence: 0.7, nested: { x: 1 } } };
    const rows = offerRows(offer);
    expect(rows.find((r) => r.label === 'Offer')?.value).toBe('£1,200.00');
    expect(rows.find((r) => r.label === 'Confidence')?.value).toBe('70 %');
    expect(rows.some((r) => r.label === 'Nested')).toBe(false);
    expect(rendererFor('offer_decision', offer)).toBe('offer');
    expect(rendererFor('question', { a: 1 })).toBe('generic');
    expect(initialEdits({ kind: 'question', payload: { a: 1 } })).toMatchObject({ mode: 'json' });
    // no raw JSON editor: questions, warnings and offers take a note, not edits
    expect(canEditThenApprove({ kind: 'question', payload: { messageId: 'm1', disagreements: ['x'] } })).toBe(false);
    expect(canEditThenApprove({ kind: 'spoof_warning', payload: { messageId: 'm1' } })).toBe(false);
    expect(canEditThenApprove({ kind: 'offer_decision', payload: { offerId: 'o1', head: 'pav', amountPence: 1 } })).toBe(false);
    expect(canEditThenApprove({ kind: 'approve_send', payload: { outboxId: 'o1', email: { to: ['a@b.test'], subject: 'S', bodyText: 'B' } } })).toBe(true);
  });
  it('reads the payloads the API slices actually store (intake confirm_fields, casework offer_decision, money)', () => {
    // intake: ConfirmCardPayload
    const card = { itemId: 'i1', claimId: 'c1', evidenceId: 'e1', docType: 'v5c', proposals: [
      { id: 'p1', target: 'vehicle:client.vin', label: 'VIN', currentValue: null, proposedValue: 'WVWZZZ1JZXW000001', confidence: 0.93, sensitive: false, page: 1, quote: 'VIN WVWZZZ1JZXW000001', reasons: [], validator: null },
      { id: 'p2', target: 'vehicle:client.colour', label: 'Colour', currentValue: 'Red', proposedValue: 'Blue', confidence: 0.7, sensitive: false, page: null, quote: null, reasons: [], validator: null },
    ] };
    expect(fieldDiff(card)).toEqual([
      { key: 'p1', label: 'VIN', current: '—', proposed: 'WVWZZZ1JZXW000001', confidence: 0.93, source: 'p.1: VIN WVWZZZ1JZXW000001' },
      { key: 'p2', label: 'Colour', current: 'Red', proposed: 'Blue', confidence: 0.7, defaultOff: true },
    ]);
    expect(rendererFor('confirm_fields', card)).toBe('fields');
    // the resolver's edit shape: {apply: ids, values?: {id: value}} — only changed values are sent
    // below 90 % (and personal details, or another vehicle's document) start unticked: one click never applies them
    expect(confirmFieldEdits(card, {}, {})).toEqual({ apply: ['p1'] });
    expect(confirmFieldEdits(card, { p2: true }, {})).toEqual({ apply: ['p1', 'p2'] });
    const mismatch = { ...card, warnings: ['Client vehicle registration KX21 ABC was not applied: the vehicle on the claim is DK18 WRE'], proposals: [{ ...card.proposals[0]!, ruleIds: ['intake_vehicle_mismatch'] }, { ...card.proposals[1]!, confidence: 0.95, sensitive: true }] };
    expect(fieldDiff(mismatch).map((r) => Boolean(r.defaultOff))).toEqual([true, true]);
    expect(cardWarnings(mismatch)).toHaveLength(1);
    expect(confirmFieldEdits(card, { p2: false }, { p1: 'WVWZZZ1JZXW000009', p2: 'Blue' })).toEqual({ apply: ['p1'], values: { p1: 'WVWZZZ1JZXW000009' } });
    // casework: offer_decision after analysis
    const offer = { recorded: true, offerId: 'o1', head: 'hire', amountPence: 95000, perDay: false, link: '/claims/c1/offers', recommended: { action: 'counter', counterPence: 120000, confidence: 0.6 }, figures: [{ label: 'Hire claimed', factId: 'ledger.hire.claimedPence', pence: 150000 }], settlement: { acceptNowPence: 95000, fightOnPence: 110000, walkAwayPence: 105000 }, gtaBenchmark: { group: 'M2', dailyRatePence: 7468, note: '' }, assumptions: { note: 'Assumed 60 % chance of better.' } };
    const rows = offerRows(offer);
    expect(rendererFor('offer_decision', offer)).toBe('offer');
    expect(rows.find((r) => r.label === 'Offer')?.value).toBe('£950.00');
    expect(rows.find((r) => r.label === 'Recommended')?.value).toBe('counter at £1,200.00 (confidence 60 %)');
    expect(rows.find((r) => r.label === 'Hire claimed')?.value).toBe('£1,500.00');
    expect(rows.find((r) => r.label === 'Walk-away figure')?.value).toBe('£1,050.00');
    expect(rows.find((r) => r.label.startsWith('GTA benchmark'))?.value).toMatch(/benchmark only/);
    // the shape casework stores: the figures table already holds the offer and the settlement rows → each shown once
    const full = { ...offer, figures: [
      { label: 'Offer', factId: 'offer.o1.amountPence', pence: 640000 },
      { label: 'Outstanding (pav)', factId: 'ledger.pav.outstandingPence', pence: 650000 },
      { label: 'Accept now (net)', factId: null, pence: 640000 },
      { label: 'Fight on (net, expected)', factId: null, pence: 300000 },
      { label: 'Walk-away number', factId: null, pence: 293530 },
    ], replyDueAt: '2026-10-12T15:58:49+01:00' };
    const labels = offerRows(full).map((r) => r.label);
    expect(labels.filter((l) => l === 'Offer')).toHaveLength(1);
    expect(labels.filter((l) => /^(Accept now|Fight on|Walk-away)/.test(l))).toHaveLength(3);
    expect(offerRows(full).find((r) => r.label === 'Written reply due')?.value).toBe(londonDateTime('2026-10-12T15:58:49+01:00'));
    expect(londonDateTime('2026-10-12T15:58:49+01:00')).toMatch(/^12 Oct 2026,? 15:58$/);
    // the recorded-offer card (before the analysis)
    expect(rendererFor('offer_decision', { recorded: true, offerId: 'o1', head: 'hire', amountPence: null, from: 'Insurer' })).toBe('offer');
    // links on cards
    expect(payloadLink({ link: '/claims/c1/ledger' })).toBe('/claims/c1/ledger');
    expect(payloadLink({ link: 'https://evil.example' })).toBeUndefined();
    expect(payloadLink({ link: '//evil.example' })).toBeUndefined();
  });
});
