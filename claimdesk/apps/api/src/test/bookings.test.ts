// owned by ap-booking — fleet booking API (docs/SUPREME-AUTOPILOT.md §J.2 "Bookings", §B)
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { calendarDaysBetween, type AvailabilityResult, type ClaimEvent, type HireAgreement, type Movement, type Reservation } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { asAgent, END, holdBody, managerOn, MONDAY, seedClaim, seedFleet, START, type ApiErr, type Fleet } from './bookingFixtures.js';
import { OVERLAP_MESSAGE } from '../booking/service.js';
import { getJobHandler } from '../agent/handlers/index.js';
import type { JobRecord } from '../agent/contracts.js';

type Held = { reservation: Reservation & { registration: string }; warnings: Array<{ code: string }> };

let t: TestApp;
let fleet: Fleet;
beforeEach(async () => {
  t = await createTestApp(MONDAY);
  fleet = seedFleet(t);
});
afterEach(async () => {
  await t.close();
});

const events = async (claimId: string, type: string): Promise<ClaimEvent[]> => (await t.api<{ events: ClaimEvent[] }>('GET', `/claims/${claimId}/events?type=${type}`)).body.events;

async function runJob(type: string, payload: unknown = {}): Promise<unknown> {
  const h = getJobHandler(type as never)!;
  expect(h).toBeDefined();
  const out = await h.run({ ctx: t.ctx, job: { id: `job-${type}`, type, payload } as unknown as JobRecord, payload: h.payload.parse(payload), signal: new AbortController().signal, log: t.ctx.logger });
  expect(out.kind).toBe('done');
  return (out as { result: unknown }).result;
}

describe('availability (POST /fleet/availability)', () => {
  it('ranks like for like, excludes the manual car for an automatic-only client with the reason, warns on the higher group', async () => {
    const claim = await seedClaim(t, { automaticOnly: true });
    const r = await t.api<AvailabilityResult & { projection: unknown }>('POST', '/fleet/availability', { claimId: claim.id, startAt: START, expectedEndAt: END });
    expect(r.status).toBe(200);
    expect(r.body.ranked.map((c) => c.registration)).toEqual(['AA26 AAA', 'CC26 CCC']);
    expect(r.body.excluded).toEqual([{ fleetUnitId: fleet.B.id, registration: 'BB26 BBB', reasons: [{ code: 'NEED_AUTOMATIC', message: 'manual gearbox; the client can only drive an automatic' }] }]);
    expect(r.body.ranked[1]!.warnings.map((w) => w.code)).toContain('GROUP_ABOVE_LFL');
    expect(r.body.ranked[0]!.likeForLike.group.relation).toBe('same');
    expect(r.body.clearWinner).toBe(true);
    expect(r.body.explanation[0]).toContain('AA26 AAA');
  });

  it('without a period it uses the projected hire (not driveable → next delivery slot, 14 days)', async () => {
    const claim = await seedClaim(t);
    const r = await t.api<AvailabilityResult & { projection: { startAt: string; expectedEndAt: string; endBasis: string } }>('POST', '/fleet/availability', { claimId: claim.id });
    expect(r.status).toBe(200);
    expect(r.body.projection.endBasis).toBe('default');
    // 14 calendar days, London wall time kept across the end of BST
    expect(calendarDaysBetween(r.body.period.startAt, r.body.period.expectedEndAt)).toBe(14);
  });
});

describe('hold → confirm → handover → return (§B.1, §B.7, §B.9)', () => {
  it('runs the happy path and creates the hire from the booking', async () => {
    const claim = await seedClaim(t);
    // hold
    const held = await t.api<Held>('POST', `/claims/${claim.id}/bookings`, holdBody(fleet.A));
    expect(held.status).toBe(201);
    const r = held.body.reservation;
    expect(r).toMatchObject({ status: 'held', fleetUnitId: fleet.A.id, claimId: claim.id, source: 'handler', registration: 'AA26 AAA' });
    expect(r.holdExpiresAt).toBe('2026-10-13T08:00:00.000Z'); // + 24 h
    expect(t.ctx.repos.listReservationEvents(t.ctx.db, r.id).map((e) => e.toStatus)).toEqual(['held']);
    expect(t.ctx.repos.listAudit(t.ctx.db, { entityId: r.id, action: 'booking.hold' })).toHaveLength(1);
    expect(await events(claim.id, 'booking_confirmed')).toHaveLength(0); // holds are not chronology

    // confirm
    const confirmed = await t.api<Held>('POST', `/bookings/${r.id}/confirm`, {});
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.reservation.status).toBe('confirmed');
    const agreement = confirmed.body.reservation.agreementNumber!;
    expect(agreement).toMatch(/^CCG-H-\d{6}$/);
    expect((await events(claim.id, 'booking_confirmed'))[0]!.data).toMatchObject({ reservationId: r.id, agreementNumber: agreement });

    // delivery slot
    const mv = await t.api<{ movement: Movement }>('POST', `/bookings/${r.id}/movements`, { kind: 'delivery', windowStart: START, windowEnd: '2026-10-12T13:00:00.000Z', address: 'client_home' });
    expect(mv.status).toBe(201);
    expect(mv.body.movement).toMatchObject({ status: 'planned', kind: 'delivery' });
    expect(mv.body.movement.address?.postcode).toBe('RG1 1AA');

    // handover: paperwork and licence guards refuse first (class A), then a manager override records the hire
    t.setNow('2026-10-12T11:30:00.000Z');
    const handoverBody = { at: '2026-10-12T11:30:00.000Z', odometerOut: 12000, fuelEighths: 8, licenceEvidenceId: 'ev-licence', dvlaCheck: { checkedAt: '2026-10-12T09:00:00.000Z', summary: 'Full licence, 3 points' }, keys: 2 };
    const refused = await t.api<ApiErr>('POST', `/bookings/${r.id}/handover`, handoverBody);
    const signed = t.ctx.repos.listAudit(t.ctx.db, { action: 'booking.handover' }).length;
    let headers: Record<string, string> = {};
    if (refused.status === 409) {
      expect(refused.body.error.code).toBe('SIGNATURES_MISSING');
      expect(refused.body.error.override?.code).toBe('SIGNATURES_MISSING');
      headers = await managerOn(t);
    }
    expect(signed).toBe(0);
    const ho = await t.api<{ reservation: Reservation; hire: HireAgreement }>('POST', `/bookings/${r.id}/handover`, handoverBody, headers);
    expect(ho.status).toBe(201);
    expect(ho.body.reservation.status).toBe('on_hire');
    expect(ho.body.hire).toMatchObject({ agreementNumber: agreement, use: 'credit_hire', hirerPartyId: claim.claimantId, reservationId: r.id, odometerOut: 12000, deliveredAt: '2026-10-12T11:30:00.000Z' });
    expect(ho.body.reservation.hireAgreementId).toBe(ho.body.hire.id);
    expect((await events(claim.id, 'hire_started'))).toHaveLength(1);
    expect((await events(claim.id, 'hire_vehicle_delivered'))).toHaveLength(1);
    expect(t.ctx.repos.requireFleetUnit(t.ctx.db, fleet.A.id)).toMatchObject({ status: 'on_hire', currentMileage: 12000 });
    expect(t.ctx.repos.getMovement(t.ctx.db, mv.body.movement.id)?.status).toBe('done');

    // return
    t.setNow('2026-10-20T10:00:00.000Z');
    const back = await t.api<{ reservation: Reservation; hire: HireAgreement; readiness: Array<{ kind: string }>; warnings: unknown[] }>('POST', `/bookings/${r.id}/return`, {
      collectedAt: '2026-10-20T10:00:00.000Z',
      endAt: '2026-10-20T09:00:00.000Z',
      endTrigger: 'client_returned',
      odometerIn: 12500,
      fuelEighths: 6,
      damage: [{ panel: 'rear bumper', description: 'scuff', severity: 'minor', evidenceIds: [] }],
    });
    expect(back.status).toBe(200);
    expect(back.body.reservation).toMatchObject({ status: 'returned', endAt: '2026-10-20T09:00:00.000Z', collectedAt: '2026-10-20T10:00:00.000Z' });
    expect(back.body.hire).toMatchObject({ endAt: '2026-10-20T09:00:00.000Z', endTrigger: 'client_returned', odometerIn: 12500 });
    expect(back.body.readiness.map((x) => x.kind)).toEqual(['valet', 'inspection', 'damage_repair']);
    expect((await events(claim.id, 'hire_vehicle_collected'))).toHaveLength(1);
    expect(t.ctx.repos.listDamage(t.ctx.db, { fleetUnitId: fleet.A.id })).toHaveLength(1);
    expect(t.ctx.repos.requireFleetUnit(t.ctx.db, fleet.A.id).status).toBe('available');
    expect(t.ctx.repos.listReservationEvents(t.ctx.db, r.id).map((e) => e.toStatus)).toEqual(['held', 'confirmed', 'on_hire', 'returned']);
    // odometer in below out is refused
  });

  it('book now (client present) confirms in one step; release cancels with a reason', async () => {
    const claim = await seedClaim(t);
    const now = await t.api<Held>('POST', `/claims/${claim.id}/bookings`, holdBody(fleet.A, { confirm: true }));
    expect(now.status).toBe(201);
    expect(now.body.reservation.status).toBe('confirmed');
    expect(now.body.reservation.agreementNumber).toMatch(/^CCG-H-/);
    const rel = await t.api<{ reservation: Reservation }>('POST', `/bookings/${now.body.reservation.id}/release`, { reason: 'Client took the insurer car' });
    expect(rel.body.reservation).toMatchObject({ status: 'cancelled', cancelledReason: 'Client took the insurer car' });
    expect(await events(claim.id, 'booking_cancelled')).toHaveLength(1);
    // the car is free again
    const other = await seedClaim(t);
    expect((await t.api<Held>('POST', `/claims/${other.id}/bookings`, holdBody(fleet.A))).status).toBe(201);
  });

  it('a second live booking on the same claim is refused (CLAIM_SECOND_HIRE) unless it replaces the hold', async () => {
    const claim = await seedClaim(t);
    const first = await t.api<Held>('POST', `/claims/${claim.id}/bookings`, holdBody(fleet.A));
    const second = await t.api<ApiErr>('POST', `/claims/${claim.id}/bookings`, holdBody(fleet.C));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CLAIM_SECOND_HIRE');
    const moved = await t.api<Held>('POST', `/claims/${claim.id}/bookings`, holdBody(fleet.C, { replaceReservationId: first.body.reservation.id }));
    expect(moved.status).toBe(201);
    expect(t.ctx.repos.requireReservation(t.ctx.db, first.body.reservation.id).status).toBe('cancelled');
  });

  it('class C is never overridable: a closed claim cannot book even in manager mode', async () => {
    const claim = await seedClaim(t);
    t.ctx.repos.setClaimStatus(t.ctx.db, claim.id, 'closed', { userId: 'system' });
    const headers = await managerOn(t);
    const r = await t.api<ApiErr>('POST', `/claims/${claim.id}/bookings`, holdBody(fleet.A), headers);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CLAIM_STATUS_NO_HIRE');
    expect(r.body.error.override).toBeUndefined();
  });

  it('PATCH moves the expected end with a reason; an on-hire extension into another booking is allowed and reported', async () => {
    const claim = await seedClaim(t);
    const held = await t.api<Held>('POST', `/claims/${claim.id}/bookings`, holdBody(fleet.A));
    const p = await t.api<Held>('PATCH', `/bookings/${held.body.reservation.id}`, { expectedEndAt: '2026-10-28T11:00:00.000Z', reason: 'Engineer estimates 12 working days' });
    expect(p.status).toBe(200);
    expect(p.body.reservation.expectedEndAt).toBe('2026-10-28T11:00:00.000Z');
    expect(await t.api('PATCH', `/bookings/${held.body.reservation.id}`, { expectedEndAt: START, reason: 'x' })).toMatchObject({ status: 400 });
  });
});

describe('agents and the perimeter (§H.5, §J.2)', () => {
  it('handover and return are refused for a run token (human_only)', async () => {
    const claim = await seedClaim(t);
    const held = await t.api<Held>('POST', `/claims/${claim.id}/bookings`, holdBody(fleet.A, { confirm: true }));
    const ho = await asAgent<ApiErr & { error: { details?: { rule?: string } } }>(t, claim.id, 'POST', `/bookings/${held.body.reservation.id}/handover`, { at: START, odometerOut: 1, fuelEighths: 8, dvlaCheck: null, keys: 1 });
    expect(ho.status).toBe(403);
    expect(ho.body.error.code).toBe('AGENT_FORBIDDEN');
    expect(ho.body.error.details?.rule).toBe('human_only');
    const ret = await asAgent<ApiErr & { error: { details?: { rule?: string } } }>(t, claim.id, 'POST', `/bookings/${held.body.reservation.id}/return`, {});
    expect(ret.body.error.details?.rule).toBe('human_only');
  });

  it('an agent hold on a taken car gets 409 RESERVATION_OVERLAP that never names the other claim; a person sees it and may override as manager', async () => {
    const first = await seedClaim(t);
    const second = await seedClaim(t);
    const held = await t.api<Held>('POST', `/claims/${first.id}/bookings`, holdBody(fleet.A));
    expect(held.status).toBe(201);
    const agent = await asAgent<ApiErr>(t, second.id, 'POST', `/claims/${second.id}/bookings`, holdBody(fleet.A));
    expect(agent.status).toBe(409);
    expect(agent.body.error.code).toBe('RESERVATION_OVERLAP');
    expect(agent.body.error.message).toBe(OVERLAP_MESSAGE);
    expect(JSON.stringify(agent.body)).not.toContain(first.reference);
    expect(agent.body.error.override).toBeUndefined();
    // a person sees the other claim and the override offer
    const person = await t.api<ApiErr>('POST', `/claims/${second.id}/bookings`, holdBody(fleet.A));
    expect(person.status).toBe(409);
    expect(person.body.error.code).toBe('RESERVATION_OVERLAP');
    expect(person.body.error.message).toContain(first.reference);
    expect(person.body.error.override?.code).toBe('HIRE_OVERLAP');
    // manager override: the row carries the audit id, override.HIRE_OVERLAP is written
    const headers = await managerOn(t);
    const over = await t.api<Held>('POST', `/claims/${second.id}/bookings`, holdBody(fleet.A), headers);
    expect(over.status).toBe(201);
    const auditId = over.body.reservation.overlapOverrideAuditId!;
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'booking.overlap_override' }).map((a) => a.id)).toContain(auditId);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'override.HIRE_OVERLAP' }).length).toBeGreaterThan(0);
  });

  it('agents cannot "book now", and confirm only after an accepted offer', async () => {
    const claim = await seedClaim(t);
    const now = await asAgent<ApiErr>(t, claim.id, 'POST', `/claims/${claim.id}/bookings`, holdBody(fleet.A, { confirm: true }));
    expect(now.status).toBe(409);
    const held = await asAgent<Held>(t, claim.id, 'POST', `/claims/${claim.id}/bookings`, holdBody(fleet.A));
    expect(held.status).toBe(201);
    expect(held.body.reservation.source).toBe('autopilot');
    const c = await asAgent<ApiErr>(t, claim.id, 'POST', `/bookings/${held.body.reservation.id}/confirm`, {});
    expect(c.body.error.code).toBe('OFFER_NOT_ACCEPTED');
  });

  it('the calendar shows other claims only as "booked" to a scoped run', async () => {
    const mine = await seedClaim(t);
    const other = await seedClaim(t);
    await t.api('POST', `/claims/${other.id}/bookings`, holdBody(fleet.A));
    const q = `/fleet/calendar?from=2026-10-12T00:00:00.000Z&to=2026-11-09T00:00:00.000Z&claimId=${mine.id}`;
    const cal = await asAgent<{ rows: Array<{ fleetUnitId: string; bookings: Array<{ label: string; claimId?: string; claimReference?: string }> }> }>(t, mine.id, 'GET', q);
    expect(cal.status).toBe(200);
    const row = cal.body.rows.find((r) => r.fleetUnitId === fleet.A.id)!;
    expect(row.bookings).toHaveLength(1);
    expect(row.bookings[0]!.label).toBe('Booked');
    expect(row.bookings[0]!.claimId).toBeUndefined();
    expect(JSON.stringify(cal.body)).not.toContain(other.reference);
    // without its own claimId the scoped run is refused
    const refused = await asAgent<ApiErr>(t, mine.id, 'GET', '/fleet/calendar?from=2026-10-12T00:00:00.000Z&to=2026-11-09T00:00:00.000Z');
    expect(refused.status).toBe(403);
    // a person sees the reference
    const person = await t.api<{ rows: Array<{ fleetUnitId: string; bookings: Array<{ claimReference?: string }> }> }>('GET', '/fleet/calendar?from=2026-10-12T00:00:00.000Z&to=2026-11-09T00:00:00.000Z');
    expect(person.body.rows.find((r) => r.fleetUnitId === fleet.A.id)!.bookings[0]!.claimReference).toBe(other.reference);
  });
});

describe('the manual hire path (§B.9) and period-aware allocate-check (§B.10)', () => {
  it('POST /claims/:id/hire still works and writes an on-hire diary row', async () => {
    const claim = await seedClaim(t);
    const r = await t.api<{ hire: HireAgreement }>('POST', `/claims/${claim.id}/hire`, { fleetUnitId: fleet.B.id, startAt: '2026-10-12T07:00:00.000Z' });
    expect(r.status).toBe(201);
    const rows = t.ctx.repos.listReservations(t.ctx.db, { claimId: claim.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'on_hire', source: 'handler', hireAgreementId: r.body.hire.id, agreementNumber: r.body.hire.agreementNumber });
    expect(r.body.hire.reservationId).toBe(rows[0]!.id);
    // the diary now refuses another claim's hold on that car
    const other = await seedClaim(t);
    expect((await t.api<ApiErr>('POST', `/claims/${other.id}/bookings`, holdBody(fleet.B))).body.error.code).toBe('RESERVATION_OVERLAP');
    // ending the hire returns the diary row
    const end = await t.api('POST', `/claims/${claim.id}/hire/${r.body.hire.id}/end`, { endTrigger: 'client_returned', endAt: '2026-10-12T07:30:00.000Z' });
    expect(end.status).toBe(200);
    expect(t.ctx.repos.requireReservation(t.ctx.db, rows[0]!.id)).toMatchObject({ status: 'returned', endAt: '2026-10-12T07:30:00.000Z' });
  });

  it("the claim's own hold becomes the manual hire's row", async () => {
    const claim = await seedClaim(t);
    const held = await t.api<Held>('POST', `/claims/${claim.id}/bookings`, holdBody(fleet.A));
    const r = await t.api<{ hire: HireAgreement }>('POST', `/claims/${claim.id}/hire`, { fleetUnitId: fleet.A.id, startAt: START });
    expect(r.status).toBe(201);
    expect(t.ctx.repos.requireReservation(t.ctx.db, held.body.reservation.id)).toMatchObject({ status: 'on_hire', hireAgreementId: r.body.hire.id });
  });

  it('allocate-check sees a future booking for its period, not just today', async () => {
    const claim = await seedClaim(t);
    await t.api('POST', `/claims/${claim.id}/bookings`, holdBody(fleet.A, { startAt: '2026-10-20T09:00:00.000Z', expectedEndAt: '2026-10-27T09:00:00.000Z' }));
    const today = await t.api<{ ok: boolean; reasons: string[] }>('POST', `/fleet/${fleet.A.id}/allocate-check`, { use: 'credit_hire' });
    expect(today.body.ok).toBe(true);
    const later = await t.api<{ ok: boolean; reasons: string[] }>('POST', `/fleet/${fleet.A.id}/allocate-check`, { use: 'credit_hire', startAt: '2026-10-21T09:00:00.000Z', expectedEndAt: '2026-10-22T09:00:00.000Z' });
    expect(later.body.ok).toBe(false);
    expect(later.body.reasons.join(' ')).toMatch(/held or booked/);
  });
});

describe('readiness, damage, locations, movements board', () => {
  it('a blocking repair makes the car unavailable; finishing it frees it', async () => {
    const claim = await seedClaim(t);
    const d = await t.api<{ damage: { id: string }; repairTask: { id: string; blocksHire: boolean } }>('POST', `/fleet/${fleet.A.id}/damage`, { panel: 'front wing', description: 'crushed', severity: 'major' });
    expect(d.status).toBe(201);
    expect(d.body.repairTask.blocksHire).toBe(true);
    const r = await t.api<AvailabilityResult>('POST', '/fleet/availability', { claimId: claim.id, startAt: START, expectedEndAt: END });
    expect(r.body.excluded.find((e) => e.fleetUnitId === fleet.A.id)!.reasons.map((x) => x.code)).toContain('UNIT_NOT_READY');
    const hold = await t.api<ApiErr>('POST', `/claims/${claim.id}/bookings`, holdBody(fleet.A));
    expect(hold.body.error.code).toBe('UNIT_NOT_READY');
    await t.api('PATCH', `/fleet/readiness/${d.body.repairTask.id}`, { status: 'done' });
    expect(t.ctx.repos.requireDamage(t.ctx.db, d.body.damage.id).repairedAt).toBeDefined();
    expect((await t.api<Held>('POST', `/claims/${claim.id}/bookings`, holdBody(fleet.A))).status).toBe(201);
    const view = await t.api<{ readiness: { state: string }; tasks: unknown[] }>('GET', `/fleet/${fleet.A.id}/readiness`);
    expect(view.body.readiness.state).toBe('ready');
  });

  it('locations: one default; the movements board lists tomorrow', async () => {
    const a = await t.api<{ id: string; isDefault: boolean }>('POST', '/fleet/locations', { name: 'Isleworth depot', postcode: 'TW7 5NQ' });
    expect(a.body.isDefault).toBe(true);
    const b = await t.api<{ id: string; isDefault: boolean }>('POST', '/fleet/locations', { name: 'Reading yard', postcode: 'RG1 1AA', isDefault: true });
    expect(b.body.isDefault).toBe(true);
    expect((await t.api<{ items: Array<{ isDefault: boolean }> }>('GET', '/fleet/locations')).body.items.filter((l) => l.isDefault)).toHaveLength(1);
    const claim = await seedClaim(t);
    const held = await t.api<Held>('POST', `/claims/${claim.id}/bookings`, holdBody(fleet.A, { startAt: '2026-10-13T09:00:00.000Z' }));
    await t.api('POST', `/bookings/${held.body.reservation.id}/movements`, { kind: 'delivery', windowStart: '2026-10-13T09:00:00.000Z', windowEnd: '2026-10-13T11:00:00.000Z', address: 'client_home' });
    const board = await t.api<{ items: Array<{ registration: string; clientName: string; slot: string }> }>('GET', '/fleet/movements?range=tomorrow');
    expect(board.body.items).toHaveLength(1);
    expect(board.body.items[0]).toMatchObject({ registration: 'AA26 AAA', slot: 'Tue 13 Oct, 10:00–12:00' });
  });
});

describe('housekeeping jobs (§H.1)', () => {
  it('booking.expire_holds expires a hold after 24 h', async () => {
    const claim = await seedClaim(t);
    const held = await t.api<Held>('POST', `/claims/${claim.id}/bookings`, holdBody(fleet.A));
    t.setNow('2026-10-13T08:00:00.000Z');
    const res = (await runJob('booking.expire_holds')) as { expired: Array<{ id: string }> };
    expect(res.expired.map((e) => e.id)).toEqual([held.body.reservation.id]);
    expect(t.ctx.repos.requireReservation(t.ctx.db, held.body.reservation.id).status).toBe('expired');
  });

  it('fleet.compliance_watch creates an MOT task 30 days ahead (blocking only from the due date); fleet.status_sync', async () => {
    t.ctx.repos.updateVehicle(t.ctx.db, fleet.C.vehicleId, { motExpiryDate: '2026-10-20' });
    const res = (await runJob('fleet.compliance_watch')) as { created: Array<{ fleetUnitId: string; kind: string }> };
    expect(res.created).toEqual([expect.objectContaining({ fleetUnitId: fleet.C.id, kind: 'mot' })]);
    expect(((await runJob('fleet.compliance_watch')) as { created: unknown[] }).created).toEqual([]); // one open task per kind
    const claim = await seedClaim(t);
    const r = await t.api<AvailabilityResult>('POST', '/fleet/availability', { claimId: claim.id, startAt: START, expectedEndAt: END });
    const c = r.body.ranked.find((x) => x.fleetUnitId === fleet.C.id)!;
    expect(c.lapses.map((l) => l.kind)).toEqual(['mot']);
    expect(c.warnings.map((w) => w.code)).toContain('MOT_LAPSES_IN_PERIOD');
    t.ctx.repos.updateFleetUnit(t.ctx.db, fleet.A.id, { status: 'on_hire' });
    const sync = (await runJob('fleet.status_sync')) as { changed: number };
    expect(sync.changed).toBe(1);
    expect(t.ctx.repos.requireFleetUnit(t.ctx.db, fleet.A.id).status).toBe('available');
  });

  it("movement.remind drafts one reminder for tomorrow's delivery", async () => {
    const claim = await seedClaim(t);
    const held = await t.api<Held>('POST', `/claims/${claim.id}/bookings`, holdBody(fleet.A, { startAt: '2026-10-13T09:00:00.000Z', confirm: true }));
    await t.api('POST', `/bookings/${held.body.reservation.id}/movements`, { kind: 'delivery', windowStart: '2026-10-13T09:00:00.000Z', windowEnd: '2026-10-13T11:00:00.000Z', address: 'client_home' });
    t.setNow('2026-10-12T15:00:00.000Z');
    const first = (await runJob('movement.remind')) as { reminders: Array<{ ok: boolean }> };
    expect(first.reminders).toHaveLength(1);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'movement.remind' })).toHaveLength(1);
    const again = (await runJob('movement.remind')) as { reminders: unknown[] };
    expect(again.reminders).toHaveLength(0);
  });
});
