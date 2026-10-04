import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { AuditImmutableError } from '../errors.js';
import { createTestDatabase } from '../testing.js';
import { appendAudit, deleteAudit, listAudit, updateAudit } from './audit.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

describe('audit log', () => {
  it('appends and lists newest first with filters', () => {
    appendAudit(h.db, { actor: { userId: 'u1', ip: '127.0.0.1' }, action: 'claim.status', entity: 'claims', entityId: 'c1', before: { status: 'fnol' }, after: { status: 'triage' }, at: '2026-08-10T09:00:00.000Z' });
    appendAudit(h.db, { actor: { userId: 'u2' }, action: 'document.approve', entity: 'documents', entityId: 'd1', at: '2026-08-11T09:00:00.000Z' });
    const all = listAudit(h.db);
    expect(all.map((a) => a.action)).toEqual(['document.approve', 'claim.status']);
    expect(all[1]).toMatchObject({ userId: 'u1', ip: '127.0.0.1', before: { status: 'fnol' }, after: { status: 'triage' } });
    expect(all[0]).not.toHaveProperty('ip');
    expect(listAudit(h.db, { entity: 'claims', entityId: 'c1' })).toHaveLength(1);
    expect(listAudit(h.db, { userId: 'u2' })).toHaveLength(1);
    expect(listAudit(h.db, { action: 'nope' })).toHaveLength(0);
  });

  it('is append-only in the repo and in the database', () => {
    const a = appendAudit(h.db, { actor: { userId: 'u1' }, action: 'x', entity: 'y', entityId: 'z' });
    expect(() => updateAudit(h.db, a.id, {})).toThrow(AuditImmutableError);
    expect(() => deleteAudit(h.db, a.id)).toThrow(AuditImmutableError);
    expect(() => h.sqlite.prepare("update audit_log set action = 'tampered' where id = ?").run(a.id)).toThrow(/append-only/);
    expect(() => h.sqlite.prepare('delete from audit_log where id = ?').run(a.id)).toThrow(/append-only/);
    expect(() => h.sqlite.prepare('delete from audit_log').run()).toThrow(/append-only/);
    expect(listAudit(h.db)).toHaveLength(1);
  });
});
