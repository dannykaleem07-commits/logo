import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { EventImmutableError, ValidationError } from '../errors.js';
import { createTestDatabase } from '../testing.js';
import { appendEvent, deleteEvent, firstEventOfType, latestEventOfType, listEvents, updateEvent } from './events.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

const claimId = 'claim-1';

describe('events', () => {
  it('are returned in chronological order of `at`, regardless of insertion order', () => {
    appendEvent(h.db, { claimId, type: 'payment_pack_sent', at: '2026-09-05T15:00:00.000Z', summary: 'pack', createdBy: 'system' });
    appendEvent(h.db, { claimId, type: 'fnol', at: '2026-08-10T09:30:00.000Z', summary: 'fnol', createdBy: 'system' });
    appendEvent(h.db, { claimId, type: 'ncaf_sent', at: '2026-08-11T11:30:00.000Z', summary: 'ncaf', createdBy: 'system' });
    appendEvent(h.db, { claimId, type: 'chaser_sent', at: '2026-09-12T09:00:00.000Z', summary: 'chaser 7', createdBy: 'system' });
    appendEvent(h.db, { claimId, type: 'chaser_sent', at: '2026-09-19T09:00:00.000Z', summary: 'chaser 14', createdBy: 'system' });
    expect(listEvents(h.db, claimId).map((e) => e.type)).toEqual(['fnol', 'ncaf_sent', 'payment_pack_sent', 'chaser_sent', 'chaser_sent']);
    expect(listEvents(h.db, claimId, { type: 'chaser_sent' })).toHaveLength(2);
    expect(listEvents(h.db, claimId, { from: '2026-09-01T00:00:00.000Z', to: '2026-09-13T00:00:00.000Z' }).map((e) => e.summary)).toEqual(['pack', 'chaser 7']);
    expect(latestEventOfType(h.db, claimId, 'chaser_sent')?.summary).toBe('chaser 14');
    expect(firstEventOfType(h.db, claimId, 'chaser_sent')?.summary).toBe('chaser 7');
    expect(latestEventOfType(h.db, claimId, 'complaint_sent')).toBeUndefined();
  });

  it('stamp recordedAt and default evidenceIds, and reject bad dates', () => {
    const e = appendEvent(h.db, { claimId, type: 'note', at: '2026-08-10T09:30:00.000Z', summary: 'n', createdBy: 'u1', data: { foo: 1 } });
    expect(e.recordedAt >= e.at).toBe(true);
    expect(e.evidenceIds).toEqual([]);
    expect(e.data).toEqual({ foo: 1 });
    expect(() => appendEvent(h.db, { claimId, type: 'note', at: 'yesterday', summary: 'n', createdBy: 'u1' })).toThrow(ValidationError);
  });

  it('are append-only at both the repo and database level', () => {
    const e = appendEvent(h.db, { claimId, type: 'note', at: '2026-08-10T09:30:00.000Z', summary: 'n', createdBy: 'u1' });
    expect(() => updateEvent(h.db, e.id, {})).toThrow(EventImmutableError);
    expect(() => deleteEvent(h.db, e.id)).toThrow(EventImmutableError);
    expect(() => h.sqlite.prepare("update claim_events set summary = 'x' where id = ?").run(e.id)).toThrow(/append-only/);
    expect(() => h.sqlite.prepare('delete from claim_events where id = ?').run(e.id)).toThrow(/append-only/);
  });
});
