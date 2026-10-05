import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Claim } from '@ccguk/domain';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { createTestDatabase } from '../testing.js';
import { listAudit } from './audit.js';
import { addClaimFlag, clearClaimFlag, raiseOrUpdateClaimFlag, createClaim, getClaimByReference, linkClaims, listClaims, nextClaimReference, setClaimStatus, updateClaim, type CreateClaimInput } from './claims.js';
import { createParty } from './parties.js';
import { upsertVehicle } from './vehicles.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

function baseInput(overrides: Partial<CreateClaimInput> = {}): CreateClaimInput {
  const claimant = createParty(h.db, { kind: 'individual', name: overrides.claimantId ? 'x' : 'Test Claimant', roles: ['claimant'] });
  const vehicle = upsertVehicle(h.db, { registration: `T${Math.floor(Math.random() * 1e6)}`, make: 'VW', model: 'GOLF', ownership: 'client' });
  return {
    accident: { occurredAt: '2026-08-08T14:30:00.000Z', location: 'A13', circumstances: 'rear-end' },
    liability: 'unknown',
    claimantId: claimant.id,
    clientVehicleId: vehicle.id,
    ...overrides,
  };
}

describe('claim references', () => {
  it('are sequential per year in CCG-YYYY-NNNNN form', () => {
    const a = createClaim(h.db, baseInput({ openedAt: '2026-08-10T09:00:00.000Z' }));
    const b = createClaim(h.db, baseInput({ openedAt: '2026-08-11T09:00:00.000Z' }));
    const c = createClaim(h.db, baseInput({ openedAt: '2026-12-31T23:59:00.000Z' }));
    expect(a.reference).toBe('CCG-2026-00001');
    expect(b.reference).toBe('CCG-2026-00002');
    expect(c.reference).toBe('CCG-2026-00003');
  });

  it('restart at 00001 for a new year and keep counting the old year', () => {
    createClaim(h.db, baseInput({ openedAt: '2026-08-10T09:00:00.000Z' }));
    const next = createClaim(h.db, baseInput({ openedAt: '2027-01-02T09:00:00.000Z' }));
    const again = createClaim(h.db, baseInput({ openedAt: '2026-09-01T09:00:00.000Z' }));
    expect(next.reference).toBe('CCG-2027-00001');
    expect(again.reference).toBe('CCG-2026-00002');
  });

  it('never reuse a number after a failed insert', () => {
    createClaim(h.db, baseInput());
    expect(() => createClaim(h.db, baseInput({ claimantId: 'missing', clientVehicleId: 'missing', reference: 'CCG-2026-00001' }))).toThrow(); // unique reference
    const c = createClaim(h.db, baseInput());
    expect(c.reference).toBe('CCG-2026-00002');
  });

  it('nextClaimReference rejects nonsense years', () => {
    expect(() => nextClaimReference(h.db, 99)).toThrow();
  });

  it('pads to five digits and can be looked up', () => {
    for (let i = 0; i < 12; i++) createClaim(h.db, baseInput({ openedAt: '2026-05-01T00:00:00.000Z' }));
    expect(getClaimByReference(h.db, 'ccg-2026-00012')?.reference).toBe('CCG-2026-00012');
  });
});

describe('claims repo', () => {
  it('round-trips JSON columns and defaults', () => {
    const c = createClaim(h.db, baseInput());
    expect(c.status).toBe('fnol');
    expect(c.gtaSubscriber).toBe(false);
    expect(c.flags).toEqual([]);
    expect(c.linkedClaimIds).toEqual([]);
    expect(c.thirdPartyIds).toEqual([]);
    expect(c.accident.location).toBe('A13');
    expect(c).not.toHaveProperty('driverId'); // nulls are stripped
  });

  it('lists with status / handler / insurer / search filters', () => {
    const insurer = createParty(h.db, { kind: 'company', name: 'Example Insurance Ltd', roles: ['insurer'] });
    const claimant = createParty(h.db, { kind: 'individual', name: 'Jane Doe', roles: ['claimant'] });
    const vehicle = upsertVehicle(h.db, { registration: 'AB12 CDE', make: 'VW', model: 'GOLF', ownership: 'client' });
    const a = createClaim(h.db, baseInput({ claimantId: claimant.id, clientVehicleId: vehicle.id, atFaultInsurerId: insurer.id, handlerId: 'h1', status: 'hire_active' }));
    const b = createClaim(h.db, baseInput({ handlerId: 'h2', status: 'closed' }));
    expect(listClaims(h.db, { status: 'hire_active' }).map((c) => c.id)).toEqual([a.id]);
    expect(listClaims(h.db, { status: ['hire_active', 'closed'] })).toHaveLength(2);
    expect(listClaims(h.db, { handlerId: 'h2' }).map((c) => c.id)).toEqual([b.id]);
    expect(listClaims(h.db, { atFaultInsurerId: insurer.id }).map((c) => c.id)).toEqual([a.id]);
    expect(listClaims(h.db, { search: 'jane' }).map((c) => c.id)).toEqual([a.id]);
    expect(listClaims(h.db, { search: 'ab12 cde' }).map((c) => c.id)).toEqual([a.id]);
    expect(listClaims(h.db, { search: a.reference }).map((c) => c.id)).toEqual([a.id]);
    expect(listClaims(h.db, { search: 'nobody' })).toEqual([]);
  });

  it('updates fields and bumps updatedAt', () => {
    const c = createClaim(h.db, baseInput());
    const u = updateClaim(h.db, c.id, { liability: 'admitted', liabilityScore: 82, track: 'small_claims' });
    expect(u.liability).toBe('admitted');
    expect(u.liabilityScore).toBe(82);
    expect(u.track).toBe('small_claims');
    expect(u.updatedAt >= c.updatedAt).toBe(true);
  });

  it('setClaimStatus writes an audit row with before/after', () => {
    const c = createClaim(h.db, baseInput());
    const u = setClaimStatus(h.db, c.id, 'accepted', { userId: 'user-1', ip: '10.0.0.1' }, 'liability admitted by insurer');
    expect(u.status).toBe('accepted');
    const audit = listAudit(h.db, { entity: 'claims', entityId: c.id });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'claim.status', userId: 'user-1', ip: '10.0.0.1', before: { status: 'fnol' }, after: { status: 'accepted', reason: 'liability admitted by insurer' } });
  });

  it('flags: raiseOrUpdate brings the open flag up to date (one flag, latest message), or raises a new one after clearing', () => {
    const c = createClaim(h.db, baseInput());
    raiseOrUpdateClaimFlag(h.db, c.id, { code: 'HIRE_PERIOD_CHANGED_AFTER_INVOICE', severity: 'warn', message: 'now 4 days', raisedBy: 'system' });
    const again = raiseOrUpdateClaimFlag(h.db, c.id, { code: 'HIRE_PERIOD_CHANGED_AFTER_INVOICE', severity: 'warn', message: 'now 11 days', raisedBy: 'system' });
    expect(again.flags.map((f) => f.message)).toEqual(['now 11 days']);
    clearClaimFlag(h.db, c.id, 'HIRE_PERIOD_CHANGED_AFTER_INVOICE', { userId: 'u1' }, 'credit note issued');
    const next = raiseOrUpdateClaimFlag(h.db, c.id, { code: 'HIRE_PERIOD_CHANGED_AFTER_INVOICE', severity: 'warn', message: 'now 12 days', raisedBy: 'system' });
    expect(next.flags.map((f) => [f.message, Boolean(f.clearedAt)])).toEqual([['now 11 days', true], ['now 12 days', false]]);
  });

  it('flags: add is de-duplicated while uncleared; clear needs a reason and is audited', () => {
    const c = createClaim(h.db, baseInput());
    addClaimFlag(h.db, c.id, { code: 'DUPLICATE_REGISTRATION', severity: 'block', message: 'AB12CDE on CCG-2026-00001', raisedBy: 'system' });
    const dup = addClaimFlag(h.db, c.id, { code: 'DUPLICATE_REGISTRATION', severity: 'block', message: 'again', raisedBy: 'system' });
    expect(dup.flags).toHaveLength(1);
    expect(listClaims(h.db, { flagged: 'block' }).map((x) => x.id)).toEqual([c.id]);
    expect(() => clearClaimFlag(h.db, c.id, 'DUPLICATE_REGISTRATION', { userId: 'u1' }, '')).toThrow();
    const cleared = clearClaimFlag(h.db, c.id, 'DUPLICATE_REGISTRATION', { userId: 'u1' }, 'separate incident on separate file, linked');
    expect(cleared.flags[0]?.clearedBy).toBe('u1');
    expect(cleared.flags[0]?.clearedReason).toContain('separate');
    expect(listClaims(h.db, { flagged: true })).toEqual([]);
    expect(listAudit(h.db, { action: 'claim.flag.clear' })).toHaveLength(1);
  });

  it('links claims both ways', () => {
    const a = createClaim(h.db, baseInput());
    const b = createClaim(h.db, baseInput());
    linkClaims(h.db, a.id, b.id);
    linkClaims(h.db, a.id, b.id);
    const claims = listClaims(h.db);
    const byId = new Map(claims.map((c: Claim) => [c.id, c]));
    expect(byId.get(a.id)?.linkedClaimIds).toEqual([b.id]);
    expect(byId.get(b.id)?.linkedClaimIds).toEqual([a.id]);
  });
});
