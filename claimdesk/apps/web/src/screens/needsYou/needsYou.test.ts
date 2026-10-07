import { describe, expect, it } from 'vitest';
import type { NeedsYouItem } from '../../api/needsYouApi';
import { documentRef, emailPreview, fieldDiff, groupNeedsYou, inboxKey, initialEdits, moveSelection, offerRows, optionForKey, orderedNeedsYou, rendererFor } from './needsYou';

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
  });
});
