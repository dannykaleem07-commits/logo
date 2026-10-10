// owned by ap-booking — race safety (docs/SUPREME-AUTOPILOT.md §B.11, §J.5)
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Reservation } from '@ccguk/domain';
import { ReservationOverlapError } from '@ccguk/db';
import { createTestApp, type TestApp } from './helpers.js';
import { asAgent, END, holdBody, MONDAY, seedClaim, seedFleet, START, type ApiErr, type Fleet } from './bookingFixtures.js';

type Held = { reservation: Reservation; warnings: Array<{ code: string }> };

let t: TestApp;
let fleet: Fleet;
beforeEach(async () => {
  t = await createTestApp(MONDAY);
  fleet = seedFleet(t);
});
afterEach(async () => {
  await t.close();
});

describe('J.5 race tests', () => {
  it('1. two claims, same car, same period, at the same time → exactly one 201 and one 409 RESERVATION_OVERLAP; one row', async () => {
    const c1 = await seedClaim(t);
    const c2 = await seedClaim(t);
    const [a, b] = await Promise.all([t.api<Held | ApiErr>('POST', `/claims/${c1.id}/bookings`, holdBody(fleet.A)), t.api<Held | ApiErr>('POST', `/claims/${c2.id}/bookings`, holdBody(fleet.A))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = (a.status === 409 ? a : b).body as ApiErr;
    expect(loser.error.code).toBe('RESERVATION_OVERLAP');
    expect(t.ctx.repos.listReservations(t.ctx.db, { fleetUnitId: fleet.A.id }).filter((r) => r.status === 'held')).toHaveLength(1);
  });

  it('1b. many concurrent holds (agents and people) still produce one booking', async () => {
    const claims = await Promise.all([1, 2, 3, 4, 5].map(() => seedClaim(t)));
    const results = await Promise.all(claims.map((c, i) => (i % 2 ? asAgent<Held | ApiErr>(t, c.id, 'POST', `/claims/${c.id}/bookings`, holdBody(fleet.A)) : t.api<Held | ApiErr>('POST', `/claims/${c.id}/bookings`, holdBody(fleet.A)))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(t.ctx.repos.listReservations(t.ctx.db, { fleetUnitId: fleet.A.id }).filter((r) => r.status === 'held')).toHaveLength(1);
  });

  it('3. owner books A while the autopilot holds A for another claim → the later one is refused (agent 409; person told it was taken)', async () => {
    const c1 = await seedClaim(t);
    const c2 = await seedClaim(t);
    const agent = await asAgent<Held>(t, c1.id, 'POST', `/claims/${c1.id}/bookings`, holdBody(fleet.A));
    expect(agent.status).toBe(201);
    const person = await t.api<ApiErr>('POST', `/claims/${c2.id}/bookings`, holdBody(fleet.A, { confirm: true }));
    expect(person.status).toBe(409);
    expect(person.body.error.message).toMatch(/taken a moment ago/);
    // the person's refreshed search no longer offers A
    const again = await t.api<{ ranked: Array<{ fleetUnitId: string }>; excluded: Array<{ fleetUnitId: string; reasons: Array<{ code: string }> }> }>('POST', '/fleet/availability', { claimId: c2.id, startAt: START, expectedEndAt: END });
    expect(again.body.ranked.map((c) => c.fleetUnitId)).not.toContain(fleet.A.id);
    expect(again.body.excluded.find((e) => e.fleetUnitId === fleet.A.id)!.reasons[0]!.code).toBe('UNIT_DOUBLE_BOOKED');
    // and the agent, refused, re-searches and holds the next car
    const c3 = await seedClaim(t);
    const refused = await asAgent<ApiErr>(t, c3.id, 'POST', `/claims/${c3.id}/bookings`, holdBody(fleet.A));
    expect(refused.body.error.code).toBe('RESERVATION_OVERLAP');
    const next = await asAgent<{ ranked: Array<{ fleetUnitId: string }> }>(t, c3.id, 'POST', '/fleet/availability', { claimId: c3.id, startAt: START, expectedEndAt: END });
    expect(next.status).toBe(200);
    const pick = next.body.ranked[0]!.fleetUnitId;
    expect(pick).not.toBe(fleet.A.id);
    expect((await asAgent<Held>(t, c3.id, 'POST', `/claims/${c3.id}/bookings`, holdBody({ id: pick } as never))).status).toBe(201);
  });

  it('4. trigger defence: a direct repo insert that bypasses the service is refused; override id, touching and backfill pass', async () => {
    const c1 = await seedClaim(t);
    await t.api('POST', `/claims/${c1.id}/bookings`, holdBody(fleet.A));
    const row = { fleetUnitId: fleet.A.id, claimId: 'other-claim', status: 'held' as const, use: 'credit_hire' as const, startAt: '2026-10-14T09:00:00.000Z', expectedEndAt: '2026-10-16T09:00:00.000Z', hirerPartyId: 'p', driverPartyIds: [], dailyRatePence: 4000, gtaGroup: 'S1', source: 'handler' as const, createdBy: 'test' };
    expect(() => t.ctx.repos.insertReservation(t.ctx.db, row)).toThrow(ReservationOverlapError);
    expect(t.ctx.repos.insertReservation(t.ctx.db, { ...row, overlapOverrideAuditId: 'audit-x' }).status).toBe('held');
    expect(t.ctx.repos.insertReservation(t.ctx.db, { ...row, status: 'on_hire', source: 'backfill' }).status).toBe('on_hire');
    expect(t.ctx.repos.insertReservation(t.ctx.db, { ...row, startAt: END, expectedEndAt: '2026-10-30T09:00:00.000Z', claimId: 'touching' }).status).toBe('held');
  });

  it('5. hold expiry race: acceptance after expiry — car still free → re-held and confirmed; car taken → HOLD_EXPIRED', async () => {
    const c1 = await seedClaim(t);
    const held = await t.api<Held>('POST', `/claims/${c1.id}/bookings`, holdBody(fleet.A));
    t.setNow('2026-10-13T08:01:00.000Z'); // one minute after the 24 h hold
    const ok = await t.api<Held & { reheld: boolean }>('POST', `/bookings/${held.body.reservation.id}/confirm`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.reheld).toBe(true);
    expect(ok.body.reservation.status).toBe('confirmed');
    expect(ok.body.reservation.id).not.toBe(held.body.reservation.id);
    expect(t.ctx.repos.requireReservation(t.ctx.db, held.body.reservation.id).status).toBe('expired');

    // second claim: hold B, let it expire, another claim takes B, then the acceptance arrives
    const c2 = await seedClaim(t);
    const c3 = await seedClaim(t);
    const hb = await t.api<Held>('POST', `/claims/${c2.id}/bookings`, holdBody(fleet.B));
    t.setNow('2026-10-14T09:00:00.000Z');
    expect((await t.api<Held>('POST', `/claims/${c3.id}/bookings`, holdBody(fleet.B))).status).toBe(201); // the stale hold is expired in the same transaction
    const late = await t.api<ApiErr>('POST', `/bookings/${hb.body.reservation.id}/confirm`, {});
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('HOLD_EXPIRED');
    expect(late.body.error.override).toBeUndefined(); // class C
  });

  it('6. overdue return: an on-hire car extended into a confirmed booking is recorded (physical reality) and reported', async () => {
    const c1 = await seedClaim(t);
    const c2 = await seedClaim(t);
    // claim 1: car A on hire now via the manual path, expected back on the 20th
    const hire = await t.api<{ hire: { id: string; reservationId: string } }>('POST', `/claims/${c1.id}/hire`, { fleetUnitId: fleet.A.id, startAt: '2026-10-12T07:00:00.000Z' });
    expect(hire.status).toBe(201);
    const onHire = hire.body.hire.reservationId;
    expect((await t.api('PATCH', `/bookings/${onHire}`, { expectedEndAt: '2026-10-20T09:00:00.000Z', reason: 'Repair due back on the 20th' })).status).toBe(200);
    // claim 2: A confirmed from the 21st
    const b = await t.api<Held>('POST', `/claims/${c2.id}/bookings`, holdBody(fleet.A, { startAt: '2026-10-21T09:00:00.000Z', expectedEndAt: '2026-10-28T09:00:00.000Z', confirm: true }));
    expect(b.status).toBe(201);
    // the repair overruns: claim 1's hire is extended into claim 2's booking — allowed, with a warning
    const ext = await t.api<Held>('PATCH', `/bookings/${onHire}`, { expectedEndAt: '2026-10-23T09:00:00.000Z', reason: 'Repair delayed' });
    expect(ext.status).toBe(200);
    expect(ext.body.reservation.expectedEndAt).toBe('2026-10-23T09:00:00.000Z');
    expect(ext.body.warnings.map((w) => w.code)).toContain('UNIT_DOUBLE_BOOKED');
    // a car overdue back keeps occupying until it is returned: once past its expected end, a hold starting before
    // "now" on that car is refused even though the expected end has passed
    t.setNow('2026-10-29T12:00:00.000Z');
    const c3 = await seedClaim(t);
    const r = await t.api<ApiErr>('POST', `/claims/${c3.id}/bookings`, holdBody(fleet.A, { startAt: '2026-10-29T09:00:00.000Z', expectedEndAt: '2026-11-02T09:00:00.000Z' }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('RESERVATION_OVERLAP');
  });
});
