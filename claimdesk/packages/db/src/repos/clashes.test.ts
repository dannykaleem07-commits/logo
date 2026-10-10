// owned by ap-clash
/** clash_findings persistence and driver profiles / eligibility assessments (docs/SUPREME-AUTOPILOT.md §C.4, §F). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClashFinding } from '@ccguk/domain';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { createTestDatabase } from '../testing.js';
import { listClashFindings, setClashFindingStatus, upsertClashFindings } from './clashes.js';
import { appendEligibilityAssessment, getDriverProfile, latestEligibilityAssessment, listDriverProfiles, listEligibilityAssessments, putDriverProfile } from './eligibility.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

const finding = (key: string, extra: Partial<ClashFinding> = {}): ClashFinding => ({
  code: 'UNIT_DOUBLE_BOOKED',
  severity: 'block',
  overrideClass: 'A',
  message: 'm',
  claimId: 'c1',
  fleetUnitId: 'u1',
  related: { claimIds: ['c2'], reservationIds: [], hireIds: [], fleetUnitIds: [], partyIds: [] },
  dedupeKey: key,
  ...extra,
});

describe('clash findings', () => {
  it('inserts, keeps on re-run, resolves when no longer seen, re-opens as a new row', () => {
    const r1 = upsertClashFindings(h.db, { claimId: 'c1' }, [finding('k1'), finding('k2', { code: 'NEED_WEAK', severity: 'warn', overrideClass: 'C' })], { at: '2026-10-12T09:00:00.000Z' });
    expect(r1.inserted.map((f) => f.status)).toEqual(['open', 'open']);
    expect(r1.inserted[1]!.overrideClass).toBe('C');
    const r2 = upsertClashFindings(h.db, { claimId: 'c1' }, [finding('k1')], { at: '2026-10-12T10:00:00.000Z' });
    expect(r2.seen.map((f) => f.dedupeKey)).toEqual(['k1']);
    expect(r2.seen[0]!.lastSeenAt).toBe('2026-10-12T10:00:00.000Z');
    expect(r2.resolved.map((f) => [f.dedupeKey, f.status, f.resolvedBy])).toEqual([['k2', 'resolved', 'system']]);
    const r3 = upsertClashFindings(h.db, { claimId: 'c1' }, [finding('k1'), finding('k2', { code: 'NEED_WEAK', severity: 'warn' })], { at: '2026-10-12T11:00:00.000Z' });
    expect(r3.inserted.map((f) => f.dedupeKey)).toEqual(['k2']);
    expect(listClashFindings(h.db, { claimId: 'c1' })).toHaveLength(3);
    expect(listClashFindings(h.db, { claimId: 'c1', status: ['open', 'acknowledged'] })).toHaveLength(2);
  });
  it('an overridden finding stays overridden when seen again (the nightly sweep never re-opens it)', () => {
    upsertClashFindings(h.db, { claimId: 'c1' }, [finding('k1')], { overridden: { keys: ['k1'], reason: 'client is the same person, checked', by: 'owner' } });
    const [f] = listClashFindings(h.db, { claimId: 'c1' });
    expect(f).toMatchObject({ status: 'overridden', resolvedBy: 'owner', resolutionNote: 'client is the same person, checked' });
    const again = upsertClashFindings(h.db, { claimId: 'c1' }, [finding('k1')]);
    expect(again.seen[0]!.status).toBe('overridden');
    expect(again.inserted).toEqual([]);
    expect(upsertClashFindings(h.db, { claimId: 'c1' }, []).resolved).toEqual([]);
  });
  it('a finding carrying a past override audit id is stored overridden', () => {
    const r = upsertClashFindings(h.db, { fleetUnitId: 'u1' }, [finding('k9', { data: { overrideAuditId: 'a1' } })]);
    expect(r.inserted[0]).toMatchObject({ status: 'overridden', overrideAuditId: 'a1' });
  });
  it('scopes: a reservation run does not resolve the claim-level findings', () => {
    upsertClashFindings(h.db, { claimId: 'c1' }, [finding('kc', { code: 'NEED_WEAK', severity: 'warn', fleetUnitId: undefined }), finding('kr', { reservationId: 'r1' })]);
    const r = upsertClashFindings(h.db, { reservationId: 'r1' }, []);
    expect(r.resolved.map((f) => f.dedupeKey)).toEqual(['kr']);
    const proposed = upsertClashFindings(h.db, { proposed: { claimId: 'c1', fleetUnitId: 'u1' } }, []);
    expect(proposed.resolved).toEqual([]);
  });
  it('acknowledge / resolve by a person', () => {
    const { inserted } = upsertClashFindings(h.db, { claimId: 'c1' }, [finding('k1', { severity: 'warn' })]);
    const ack = setClashFindingStatus(h.db, inserted[0]!.id, { status: 'acknowledged', by: 'owner', note: 'read it' });
    expect(ack).toMatchObject({ status: 'acknowledged', resolvedBy: 'owner', resolutionNote: 'read it' });
    // still open-unique: a re-run keeps the acknowledged row
    expect(upsertClashFindings(h.db, { claimId: 'c1' }, [finding('k1', { severity: 'warn' })]).seen[0]!.status).toBe('acknowledged');
  });
});

describe('driver profiles and assessments', () => {
  it('round-trips a profile and replaces it', () => {
    const p = putDriverProfile(h.db, { partyId: 'p1', licenceCountry: 'GB', licenceType: 'full', categories: ['B'], restrictionCodes: ['78'], points: 3, endorsements: [], disqualifications5y: 0, faultAccidents3y: 0, unspentConvictions: [], medicalConditionsDeclared: false, source: 'declared', updatedBy: 'owner', updatedAt: '2026-10-12T09:00:00.000Z' });
    expect(p.restrictionCodes).toEqual(['78']);
    putDriverProfile(h.db, { ...p, points: 6, source: 'dvla_check', updatedAt: '2026-10-12T10:00:00.000Z' });
    expect(getDriverProfile(h.db, 'p1')).toMatchObject({ points: 6, source: 'dvla_check' });
    expect(listDriverProfiles(h.db, ['p1', 'p2'])).toHaveLength(1);
    expect(listDriverProfiles(h.db, [])).toEqual([]);
  });
  it('assessments are append-only', () => {
    const a = appendEligibilityAssessment(h.db, { claimId: 'c1', partyId: 'p1', kind: 'driver', outcome: 'refer', reasons: [{ code: 'POINTS_REFER' }], inputsSha256: 'x'.repeat(64), createdBy: 'system', createdAt: '2026-10-12T09:00:00.000Z' });
    appendEligibilityAssessment(h.db, { claimId: 'c1', partyId: 'p1', kind: 'driver', outcome: 'eligible', reasons: [], inputsSha256: 'y'.repeat(64), createdBy: 'owner', createdAt: '2026-10-12T10:00:00.000Z' });
    expect(listEligibilityAssessments(h.db, 'c1', { kind: 'driver' })).toHaveLength(2);
    expect(latestEligibilityAssessment(h.db, 'c1', 'driver', 'p1')!.outcome).toBe('eligible');
    expect(() => h.sqlite.prepare('UPDATE eligibility_assessments SET outcome = ? WHERE id = ?').run('eligible', a.id)).toThrow();
    expect(() => h.sqlite.prepare('DELETE FROM eligibility_assessments WHERE id = ?').run(a.id)).toThrow();
  });
});
