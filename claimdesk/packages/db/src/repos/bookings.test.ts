// owned by ap-booking — repository for the fleet diary (docs/SUPREME-AUTOPILOT.md §B, §B.11 trigger defence)
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, createDatabase, type DatabaseHandle } from '../client.js';
import { runMigrations } from '../migrate.js';
import {
  appendReservationEvent,
  createDamage,
  createLocation,
  createMovement,
  createReadinessTask,
  defaultLocation,
  getHireNeeds,
  insertReservation,
  listDamage,
  listExpiredHolds,
  listLocations,
  listMovements,
  listReadinessTasks,
  listReservationEvents,
  listReservations,
  putHireNeeds,
  reservationBlock,
  updateLocation,
  updateReservation,
  ReservationOverlapError,
  type NewReservation,
} from './bookings.js';
import { createHire, nextAgreementNumber } from './hire.js';

const handles: DatabaseHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) closeDatabase(h);
});
function db() {
  const h = createDatabase({ path: ':memory:' });
  handles.push(h);
  runMigrations(h.db);
  return h;
}

const res = (extra: Partial<NewReservation> = {}): NewReservation => ({
  fleetUnitId: 'u1',
  claimId: 'c1',
  status: 'held',
  use: 'credit_hire',
  startAt: '2026-10-13T09:00:00.000Z',
  expectedEndAt: '2026-10-20T09:00:00.000Z',
  holdExpiresAt: '2026-10-14T09:00:00.000Z',
  hirerPartyId: 'p1',
  driverPartyIds: ['p1'],
  dailyRatePence: 5000,
  gtaGroup: 'C2',
  source: 'handler',
  createdBy: 'u',
  ...extra,
});

describe('reservations repo + overlap trigger', () => {
  it('stores epoch-ms block columns and reads back a Reservation', () => {
    const h = db();
    const r = insertReservation(h.db, res({ startAt: '2026-10-13T10:00:00+01:00' }));
    expect(r.expectedEndAt).toBe('2026-10-20T09:00:00.000Z');
    expect(reservationBlock(h.db, r.id)).toEqual({ blockStartMs: Date.parse('2026-10-13T09:00:00.000Z'), blockEndMs: Date.parse('2026-10-20T09:00:00.000Z'), holdExpiresMs: Date.parse('2026-10-14T09:00:00.000Z') });
    expect(listReservations(h.db, { claimId: 'c1' })).toHaveLength(1);
    expect(listReservations(h.db, { fleetUnitId: 'u1', fromMs: Date.parse('2026-10-20T09:00:00.000Z') })).toHaveLength(0);
    expect(listReservations(h.db, { fleetUnitId: 'u1', fromMs: Date.parse('2026-10-19T09:00:00.000Z') })).toHaveLength(1);
  });

  it('refuses an overlapping insert with ReservationOverlapError; touching, override and backfill pass', () => {
    const h = db();
    insertReservation(h.db, res());
    expect(() => insertReservation(h.db, res({ claimId: 'c2', startAt: '2026-10-15T09:00:00.000Z', expectedEndAt: '2026-10-25T09:00:00.000Z' }))).toThrow(ReservationOverlapError);
    // mixed ISO forms are compared as instants (10:00+01:00 is 09:00Z → touching)
    expect(insertReservation(h.db, res({ claimId: 'c2', startAt: '2026-10-20T10:00:00+01:00', expectedEndAt: '2026-10-25T09:00:00.000Z' })).status).toBe('held');
    expect(insertReservation(h.db, res({ claimId: 'c3', startAt: '2026-10-15T09:00:00.000Z', overlapOverrideAuditId: 'audit-1' })).status).toBe('held');
    expect(insertReservation(h.db, res({ claimId: 'c4', status: 'on_hire', startAt: '2026-10-15T09:00:00.000Z', source: 'backfill' })).status).toBe('on_hire');
    // cancelled rows do not occupy
    expect(insertReservation(h.db, res({ fleetUnitId: 'u9', status: 'cancelled' })).status).toBe('cancelled');
  });

  it('an update into held/confirmed is re-checked; on_hire/returned updates are never refused', () => {
    const h = db();
    const a = insertReservation(h.db, res());
    const b = insertReservation(h.db, res({ claimId: 'c2', startAt: '2026-10-20T09:00:00.000Z', expectedEndAt: '2026-10-27T09:00:00.000Z' }));
    expect(() => updateReservation(h.db, b.id, { startAt: '2026-10-18T09:00:00.000Z' })).toThrow(ReservationOverlapError);
    const onHire = updateReservation(h.db, a.id, { status: 'confirmed', agreementNumber: 'CCG-H-000001' });
    expect(onHire.status).toBe('confirmed');
    // the overdue hire runs past the next booking: physical reality is recorded
    const late = updateReservation(h.db, a.id, { status: 'on_hire' });
    expect(updateReservation(h.db, late.id, { expectedEndAt: '2026-10-23T09:00:00.000Z' }).expectedEndAt).toBe('2026-10-23T09:00:00.000Z');
    expect(updateReservation(h.db, late.id, { status: 'returned', endAt: '2026-10-23T09:00:00.000Z', collectedAt: '2026-10-23T11:00:00.000Z' }).status).toBe('returned');
    expect(reservationBlock(h.db, a.id)!.blockEndMs).toBe(Date.parse('2026-10-23T11:00:00.000Z'));
  });

  it('expired holds; events are append-only', () => {
    const h = db();
    const a = insertReservation(h.db, res());
    expect(listExpiredHolds(h.db, Date.parse('2026-10-14T08:59:00.000Z'))).toHaveLength(0);
    expect(listExpiredHolds(h.db, Date.parse('2026-10-14T09:00:00.000Z')).map((r) => r.id)).toEqual([a.id]);
    appendReservationEvent(h.db, { reservationId: a.id, toStatus: 'held', actor: 'u', at: '2026-10-12T09:00:00.000Z', data: { x: 1 } });
    expect(listReservationEvents(h.db, a.id)).toHaveLength(1);
    expect(() => h.sqlite.prepare('UPDATE fleet_reservation_events SET actor = ?').run('x')).toThrow();
    expect(() => h.sqlite.prepare('DELETE FROM fleet_reservation_events').run()).toThrow();
  });

  it('one agreement number sequence across hires and confirmed bookings', () => {
    const h = db();
    expect(nextAgreementNumber(h.db)).toBe('CCG-H-000001');
    insertReservation(h.db, res({ status: 'confirmed', agreementNumber: 'CCG-H-000001' }));
    expect(nextAgreementNumber(h.db)).toBe('CCG-H-000002');
    const hire = createHire(h.db, { claimId: 'c9', fleetUnitId: 'u2', startAt: '2026-10-01T09:00:00.000Z', dailyRatePence: 5000, vatRate: 0.2, gtaGroup: 'C2', excessPence: 0 });
    expect(hire.agreementNumber).toBe('CCG-H-000002');
  });
});

describe('movements, locations, readiness, damage, hire needs', () => {
  it('movements filter by window instants', () => {
    const h = db();
    const base = { reservationId: 'r1', claimId: 'c1', fleetUnitId: 'u1', kind: 'delivery' as const, address: null, postcode: 'TW7 5NQ', assignedTo: null, status: 'planned' as const, createdBy: 'u' };
    createMovement(h.db, { ...base, windowStart: '2026-10-13T10:00:00+01:00', windowEnd: '2026-10-13T12:00:00+01:00' });
    createMovement(h.db, { ...base, kind: 'collection', windowStart: '2026-10-20T09:00:00.000Z', windowEnd: '2026-10-20T11:00:00.000Z' });
    expect(listMovements(h.db, { from: '2026-10-13T00:00:00.000Z', to: '2026-10-14T00:00:00.000Z' }).map((m) => m.kind)).toEqual(['delivery']);
    expect(listMovements(h.db, { reservationId: 'r1' })).toHaveLength(2);
    expect(() => createMovement(h.db, { ...base, windowStart: '2026-10-20T11:00:00.000Z', windowEnd: '2026-10-20T09:00:00.000Z' })).toThrow();
  });

  it('one default location', () => {
    const h = db();
    const a = createLocation(h.db, { name: 'Isleworth', address: null, postcode: 'TW7 5NQ', lat: null, lon: null });
    expect(a.isDefault).toBe(true);
    const b = createLocation(h.db, { name: 'Barking', address: null, postcode: 'IG11 0HZ', lat: null, lon: null });
    expect(b.isDefault).toBe(false);
    updateLocation(h.db, b.id, { isDefault: true });
    expect(defaultLocation(h.db)?.id).toBe(b.id);
    expect(listLocations(h.db).filter((l) => l.isDefault)).toHaveLength(1);
  });

  it('readiness tasks, damage and hire needs round-trip', () => {
    const h = db();
    createReadinessTask(h.db, { fleetUnitId: 'u1', kind: 'valet', blocksHire: false, readyByAt: '2026-10-13T11:00:00.000Z', createdBy: 'u' });
    expect(listReadinessTasks(h.db, { fleetUnitId: 'u1', status: 'open' })).toHaveLength(1);
    createDamage(h.db, { fleetUnitId: 'u1', panel: 'bumper', description: 'scuff', severity: 'minor', foundAt: '2026-10-13T11:00:00.000Z', foundBy: 'u' });
    expect(listDamage(h.db, { fleetUnitId: 'u1', unrepaired: true })[0]).toMatchObject({ chargeable: 'tbc', evidenceIds: [] });
    expect(getHireNeeds(h.db, 'c1')).toBeUndefined();
    const needs = { neededFrom: null, deliveryAddress: null, deliveryPostcode: 'TW7', seatsMin: 5, automaticOnly: true, automaticPreferred: false, towbar: false, wheelchairAccessible: false, handControls: false, isofixCount: 0, evOk: null, phvWork: false, largeBoot: false, occupation: null, journeys: null, dependants: null, otherVehicles: 'none' as const, ownInsurerCourtesyCar: 'unknown' as const, clientCoverType: 'unknown' as const, clientWantsHire: true, notes: null, source: {} };
    putHireNeeds(h.db, 'c1', needs, 'u');
    putHireNeeds(h.db, 'c1', { ...needs, seatsMin: 7 }, 'u2');
    expect(getHireNeeds(h.db, 'c1')).toMatchObject({ updatedBy: 'u2', needs: { seatsMin: 7, automaticOnly: true } });
  });
});
