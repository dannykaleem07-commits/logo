import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { AuditImmutableError } from '../errors.js';
import { createTestDatabase } from '../testing.js';
import { appendAudit, deleteAudit, listAudit, listAuditByActions, listAuditForClaim, updateAudit } from './audit.js';

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

describe('audit — claim trail and action listing (0.3 §A.4.2, B44)', () => {
  const at = (d: number) => `2026-10-0${d}T09:00:00.000Z`;
  beforeEach(() => {
    appendAudit(h.db, { actor: { userId: 'u1' }, action: 'claim.status', entity: 'claims', entityId: 'c1', at: at(1) });
    appendAudit(h.db, { actor: { userId: 'u1' }, action: 'hire.create', entity: 'hire_agreements', entityId: 'h1', at: at(2) });
    appendAudit(h.db, { actor: { userId: 'u1' }, action: 'document.approve', entity: 'documents', entityId: 'd1', at: at(3) });
    appendAudit(h.db, { actor: { userId: 'u1' }, action: 'fleet_unit.dispose', entity: 'fleet_units', entityId: 'f1', after: { status: 'disposed', claimId: 'c1' }, at: at(4) });
    appendAudit(h.db, { actor: { userId: 'u2' }, action: 'override.HARD_STOP', entity: 'claims', entityId: 'c1', after: { reason: 'Verify test' }, at: at(5) });
    appendAudit(h.db, { actor: { userId: 'u2' }, action: 'manager_mode.on', entity: 'user', entityId: 'u2', after: { idleMinutes: 60 }, at: at(6) });
    appendAudit(h.db, { actor: { userId: 'u2' }, action: 'manager_mode.off', entity: 'user', entityId: 'u2', after: { why: 'user' }, at: at(7) });
    // another claim and noise
    appendAudit(h.db, { actor: { userId: 'u1' }, action: 'claim.status', entity: 'claims', entityId: 'c2', after: { claimId: 'c2' }, at: at(8) });
    appendAudit(h.db, { actor: { userId: 'u1' }, action: 'overrideish', entity: 'x', entityId: 'y', after: 'not json object', at: at(9) });
    appendAudit(h.db, { actor: { userId: 'u1' }, action: 'overrideXHARD', entity: 'x', entityId: 'y', at: at(9) });
  });

  it('lists the claim, its related records and rows whose after.claimId is the claim, newest first', () => {
    expect(listAuditForClaim(h.db, 'c1').map((a) => a.action)).toEqual(['override.HARD_STOP', 'fleet_unit.dispose', 'claim.status']);
    expect(listAuditForClaim(h.db, 'c1', ['h1', 'd1']).map((a) => a.action)).toEqual(['override.HARD_STOP', 'fleet_unit.dispose', 'document.approve', 'hire.create', 'claim.status']);
    expect(listAuditForClaim(h.db, 'c1', ['h1', 'd1'], 2)).toHaveLength(2);
    expect(listAuditForClaim(h.db, 'c2').map((a) => a.entityId)).toEqual(['c2']);
    expect(listAuditForClaim(h.db, 'nope')).toEqual([]);
  });

  it('handles a large related-id list', () => {
    const many = Array.from({ length: 1500 }, (_, i) => `x${i}`);
    expect(listAuditForClaim(h.db, 'c1', [...many, 'h1']).map((a) => a.action)).toContain('hire.create');
  });

  it('lists by action prefix and exact actions, newest first, with a limit; LIKE wildcards are literal', () => {
    expect(listAuditByActions(h.db, { prefixes: ['override.'], actions: ['manager_mode.on', 'manager_mode.off'] }).map((a) => a.action)).toEqual(['manager_mode.off', 'manager_mode.on', 'override.HARD_STOP']);
    expect(listAuditByActions(h.db, { prefixes: ['override.'] }).map((a) => a.action)).toEqual(['override.HARD_STOP']);
    expect(listAuditByActions(h.db, { prefixes: ['override_'] })).toEqual([]);
    expect(listAuditByActions(h.db, { actions: ['manager_mode.on'] })).toHaveLength(1);
    expect(listAuditByActions(h.db, { prefixes: ['override.'], actions: ['manager_mode.on', 'manager_mode.off'], limit: 1 }).map((a) => a.action)).toEqual(['manager_mode.off']);
    expect(listAuditByActions(h.db, {})).toEqual([]);
  });
});
