import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, type DatabaseHandle } from '../client.js';
import { ValidationError } from '../errors.js';
import { seedFileOne } from '../fixtures/fileOne.js';
import { createTestDatabase } from '../testing.js';
import { createClaim } from './claims.js';
import { findFleetUnitsByRegistration } from './fleet.js';
import { addLookup, addOdometer, findByRegistration, listClaimsForRegistration, searchVehicles, upsertVehicle } from './vehicles.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

describe('vehicles', () => {
  it('upsert by normalised registration merges scalars and appends odometer/lookups', () => {
    const a = upsertVehicle(h.db, { registration: 'ab12 cde', make: 'VW', model: 'GOLF', ownership: 'client', odometer: [{ source: 'mot', date: '2026-03-14', miles: 48210 }] });
    expect(a.registration).toBe('AB12CDE');
    const b = upsertVehicle(h.db, { registration: 'AB12-CDE', make: 'VOLKSWAGEN', model: 'GOLF', colour: 'GREY', ownership: 'client', odometer: [{ source: 'mot', date: '2026-03-14', miles: 48210 }, { source: 'client', date: '2026-08-10', miles: 50000 }] });
    expect(b.id).toBe(a.id);
    expect(b.make).toBe('VOLKSWAGEN');
    expect(b.colour).toBe('GREY');
    expect(b.odometer).toHaveLength(2);
    expect(findByRegistration(h.db, ' ab12cde ')?.id).toBe(a.id);
    expect(() => upsertVehicle(h.db, { registration: '  ', make: 'x', model: 'y', ownership: 'client' })).toThrow(ValidationError);
  });

  it('addOdometer keeps readings sorted by date; addLookup assigns ids', () => {
    const v = upsertVehicle(h.db, { registration: 'XX99 YYY', make: 'FORD', model: 'FOCUS', ownership: 'client' });
    addOdometer(h.db, v.id, { source: 'engineer', date: '2026-08-14', miles: 50100 });
    const after = addOdometer(h.db, v.id, { source: 'mot', date: '2025-08-01', miles: 42000 });
    expect(after.odometer.map((o) => o.date)).toEqual(['2025-08-01', '2026-08-14']);
    expect(() => addOdometer(h.db, v.id, { source: 'client', date: '2026-08-15', miles: -1 })).toThrow(ValidationError);
    const lookup = addLookup(h.db, v.id, { provider: 'dvla_ves', kind: 'vehicle', requestedAt: '2026-08-10T10:00:00.000Z', requestedBy: 'u1', registration: 'XX99YYY', raw: { make: 'FORD' }, verification: { status: 'verified', sourceUrl: 'https://driver-vehicle-licensing.api.gov.uk', verifiedAt: '2026-08-10' } });
    expect(lookup.id).toBeTruthy();
    expect(findByRegistration(h.db, 'XX99YYY')?.lookups[0]?.raw).toEqual({ make: 'FORD' });
  });

  it('listClaimsForRegistration finds every file the plate appears on (cross-file check)', () => {
    const ids = seedFileOne(h.db);
    expect(listClaimsForRegistration(h.db, 'ab12 cde').map((c) => c.id)).toEqual([ids.claimId]);
    expect(listClaimsForRegistration(h.db, 'XY34ZZZ').map((c) => c.id)).toEqual([ids.claimId]); // as third-party vehicle
    // a second file on the same registration is allowed (flag, not constraint)
    const second = createClaim(h.db, { accident: { occurredAt: '2026-09-20T08:00:00.000Z', location: 'M25', circumstances: 'x' }, liability: 'unknown', claimantId: ids.claimantId, clientVehicleId: ids.clientVehicleId, openedAt: '2026-09-21T09:00:00.000Z' });
    expect(listClaimsForRegistration(h.db, 'AB12CDE').map((c) => c.id)).toEqual([ids.claimId, second.id]);
    expect(listClaimsForRegistration(h.db, 'NOPE')).toEqual([]);
    // a fleet unit's plate used as a client vehicle is detectable
    expect(findFleetUnitsByRegistration(h.db, 'fl33 eet').map((u) => u.id)).toEqual([ids.fleetUnitId]);
    expect(searchVehicles(h.db, 'golf').length).toBe(2);
  });
});
