// owned by ap-booking
/**
 * Fleet booking routes (docs/SUPREME-AUTOPILOT.md §H.4): availability, calendar, bookings (hold → confirm → handover →
 * return, release, period changes), movements, readiness, damage and locations. Human-only routes (handover, return)
 * are refused to agents by the perimeter (§H.5); claim scope resolves `/bookings/:id` and `/movements/:id` to their
 * claim, and the fleet-wide availability and calendar need the run's own claim.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { defaultBlocksHire, isoToMs, msToUtcIso, unitReadiness, type ReadinessTask } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { badRequest, conflict } from '../errors.js';
import { parse } from '../schemas/common.js';
import {
  availabilityBody,
  bookingPatchBody,
  calendarQuery,
  confirmBody,
  damageBody,
  damagePatchBody,
  handoverBody,
  holdBody,
  locationBody,
  locationPatchBody,
  movementBody,
  movementPatchBody,
  movementsQuery,
  readinessBody,
  readinessPatchBody,
  releaseBody,
  returnBody,
} from '../schemas/bookings.js';
import { gateFor } from '../services/override.js';
import {
  availabilityFor,
  bookingDetail,
  claimBookings,
  confirmBooking,
  fleetCalendar,
  handover,
  movementsBoard,
  patchMovement,
  placeHold,
  releaseBooking,
  returnBooking,
  scheduleMovement,
  updateBookingPeriod,
} from '../booking/service.js';
import { params, requireClaim } from './helpers.js';

const DAY_MS = 86_400_000;

/** Bookings of other claims, as an agent scoped to `scope` may see them (no reference, no names). */
export function unitBookingsFor(ctx: AppContext, unitId: string, scope: string | undefined) {
  return ctx.repos.listReservations(ctx.db, { fleetUnitId: unitId, status: ['held', 'confirmed', 'on_hire', 'returned'], fromMs: isoToMs(ctx.now()) - 30 * DAY_MS }).map((r) =>
    !scope || r.claimId === scope
      ? { id: r.id, claimId: r.claimId, status: r.status, startAt: r.startAt, expectedEndAt: r.expectedEndAt, endAt: r.endAt ?? null, agreementNumber: r.agreementNumber ?? null }
      : { id: null, claimId: null, status: 'booked' as const, startAt: r.startAt, expectedEndAt: r.expectedEndAt, endAt: r.endAt ?? null, agreementNumber: null },
  );
}

export function readinessView(ctx: AppContext, unitId: string, scope?: string) {
  const tasks = ctx.repos.listReadinessTasks(ctx.db, { fleetUnitId: unitId });
  const damage = ctx.repos.listDamage(ctx.db, { fleetUnitId: unitId });
  const open = tasks.filter((t) => t.status === 'open');
  return {
    fleetUnitId: unitId,
    readiness: unitReadiness(open, damage.filter((d) => !d.repairedAt), ctx.now()),
    tasks,
    damage,
    bookings: unitBookingsFor(ctx, unitId, scope),
  };
}

const scopeOf = (request: FastifyRequest): string | undefined => request.agent?.claimScope;

export function registerBookingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- Availability and calendar ------------------------------------------------------------
  app.post('/fleet/availability', async (request) => {
    const body = parse(availabilityBody, request.body);
    return availabilityFor(ctx, { claimId: body.claimId, startAt: body.startAt ?? null, expectedEndAt: body.expectedEndAt ?? null, use: body.use ?? null, limit: body.limit ?? null, ...(body.fleetUnitIds ? { fleetUnitIds: body.fleetUnitIds } : {}) });
  });

  app.get('/fleet/calendar', async (request) => {
    const q = parse(calendarQuery, request.query);
    if (isoToMs(q.to) <= isoToMs(q.from)) throw badRequest('`to` must be after `from`');
    if (isoToMs(q.to) - isoToMs(q.from) > 92 * DAY_MS) throw badRequest('The calendar shows at most 13 weeks at a time');
    return fleetCalendar(ctx, {
      from: msToUtcIso(isoToMs(q.from)),
      to: msToUtcIso(isoToMs(q.to)),
      ...(q.unitIds ? { unitIds: q.unitIds.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      group: q.group ?? null,
      use: q.use ?? null,
      locationId: q.locationId ?? null,
      claimScope: scopeOf(request) ?? null,
    });
  });

  // ---- Bookings ------------------------------------------------------------------------------
  app.get('/claims/:id/bookings', async (request) => {
    const { id } = params<{ id: string }>(request);
    return claimBookings(ctx, id);
  });

  app.post('/claims/:id/bookings', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(holdBody, request.body);
    if (body.confirm && request.agent) throw conflict('AGENT_BOOK_NOW', 'Agents hold a car and confirm it after the client accepts the offer');
    const result = placeHold(ctx, request, gateFor(ctx, request), {
      claimId: id,
      fleetUnitId: body.fleetUnitId,
      use: body.use,
      startAt: body.startAt,
      expectedEndAt: body.expectedEndAt,
      hirerPartyId: body.hirerPartyId ?? null,
      driverPartyIds: body.driverPartyIds ?? null,
      dailyRatePence: body.dailyRatePence ?? null,
      substitutionReason: body.substitutionReason ?? null,
      replaceReservationId: body.replaceReservationId ?? null,
      confirm: body.confirm ?? false,
    });
    return reply.status(201).send(result);
  });

  app.get('/bookings/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    return bookingDetail(ctx, id);
  });

  app.patch('/bookings/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(bookingPatchBody, request.body);
    return updateBookingPeriod(ctx, request, gateFor(ctx, request), id, {
      startAt: body.startAt ?? null,
      expectedEndAt: body.expectedEndAt ?? null,
      reason: body.reason,
      substitutionReason: body.substitutionReason ?? null,
      dailyRatePence: body.dailyRatePence ?? null,
    });
  });

  app.post('/bookings/:id/confirm', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(confirmBody, request.body ?? {});
    return confirmBooking(ctx, request, gateFor(ctx, request), id, { hireOfferId: body.hireOfferId ?? null });
  });

  app.post('/bookings/:id/release', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(releaseBody, request.body);
    return { reservation: releaseBooking(ctx, request, id, body.reason) };
  });

  /** Human-only (perimeter): the car is handed over; the hire record is created from the booking (§B.9). */
  app.post('/bookings/:id/handover', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(handoverBody, request.body);
    const out = handover(ctx, request, gateFor(ctx, request), id, {
      at: body.at,
      odometerOut: body.odometerOut,
      fuelEighths: body.fuelEighths,
      conditionDocumentId: body.conditionDocumentId ?? null,
      licenceEvidenceId: body.licenceEvidenceId ?? null,
      dvlaCheck: body.dvlaCheck ? { checkedAt: body.dvlaCheck.checkedAt, summary: body.dvlaCheck.summary, evidenceId: body.dvlaCheck.evidenceId ?? null } : null,
      keys: body.keys,
      notes: body.notes ?? null,
      excessPence: body.excessPence ?? null,
    });
    return reply.status(201).send({ reservation: out.reservation, hire: out.hire, enforceabilityGaps: out.created.enforceabilityGaps, warnings: out.created.warnings });
  });

  /** Human-only (perimeter): the car is back; the hire ends; damage and readiness tasks are recorded (§B.9). */
  app.post('/bookings/:id/return', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(returnBody, request.body);
    return returnBooking(ctx, request, gateFor(ctx, request), id, {
      collectedAt: body.collectedAt,
      endAt: body.endAt,
      endTrigger: body.endTrigger,
      odometerIn: body.odometerIn,
      fuelEighths: body.fuelEighths,
      conditionDocumentId: body.conditionDocumentId ?? null,
      damage: body.damage,
      notes: body.notes ?? null,
    });
  });

  // ---- Movements -----------------------------------------------------------------------------
  app.post('/bookings/:id/movements', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(movementBody, request.body);
    const out = scheduleMovement(ctx, request, gateFor(ctx, request), id, {
      kind: body.kind,
      windowStart: body.windowStart,
      windowEnd: body.windowEnd,
      address: body.address,
      postcode: body.postcode ?? null,
      assignedTo: body.assignedTo ?? null,
      notes: body.notes ?? null,
    });
    return reply.status(201).send(out);
  });

  app.patch('/movements/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(movementPatchBody, request.body);
    return { movement: patchMovement(ctx, request, id, body) };
  });

  app.get('/fleet/movements', async (request) => {
    const q = parse(movementsQuery, request.query);
    return movementsBoard(ctx, { day: q.day ?? null, range: q.range ?? null });
  });

  // ---- Readiness and damage ------------------------------------------------------------------
  app.get('/fleet/:id/readiness', async (request) => {
    const { id } = params<{ id: string }>(request);
    ctx.repos.requireFleetUnit(ctx.db, id);
    return readinessView(ctx, id, scopeOf(request));
  });

  app.post('/fleet/:id/readiness', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    ctx.repos.requireFleetUnit(ctx.db, id);
    const body = parse(readinessBody, request.body);
    const now = ctx.now();
    const task = ctx.db.transaction((tx) => {
      const t = ctx.repos.createReadinessTask(tx, {
        fleetUnitId: id,
        kind: body.kind,
        blocksHire: body.blocksHire ?? defaultBlocksHire(body.kind),
        ...(body.dueAt ? { dueAt: body.dueAt } : {}),
        ...(body.readyByAt ? { readyByAt: body.readyByAt } : {}),
        ...(body.note ? { note: body.note } : {}),
        ...(body.reservationId ? { reservationId: body.reservationId } : {}),
        ...(body.damageId ? { damageId: body.damageId } : {}),
        createdBy: request.actor.userId,
        createdAt: now,
      });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'fleet.readiness.create', entity: 'fleet_readiness_tasks', entityId: t.id, after: { fleetUnitId: id, kind: t.kind, blocksHire: t.blocksHire, dueAt: t.dueAt ?? null, readyByAt: t.readyByAt ?? null }, at: now });
      return t;
    });
    return reply.status(201).send(task);
  });

  app.patch('/fleet/readiness/:taskId', async (request) => {
    const { taskId } = params<{ taskId: string }>(request);
    const body = parse(readinessPatchBody, request.body);
    const before = ctx.repos.requireReadinessTask(ctx.db, taskId);
    const now = ctx.now();
    return ctx.db.transaction((tx) => {
      const patch: Partial<ReadinessTask> = {
        ...(body.status ? { status: body.status } : {}),
        ...(body.blocksHire !== undefined ? { blocksHire: body.blocksHire } : {}),
        ...(body.dueAt ? { dueAt: body.dueAt } : {}),
        ...(body.readyByAt ? { readyByAt: body.readyByAt } : {}),
        ...(body.note ? { note: body.note } : {}),
        ...(body.status === 'done' ? { doneBy: request.actor.userId, doneAt: now } : {}),
      };
      const t = ctx.repos.updateReadinessTask(tx, taskId, patch);
      // A finished repair task marks its damage repaired.
      if (body.status === 'done' && t.kind === 'damage_repair' && t.damageId) ctx.repos.updateDamage(tx, t.damageId, { repairedAt: now });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'fleet.readiness.update', entity: 'fleet_readiness_tasks', entityId: taskId, before: { status: before.status, readyByAt: before.readyByAt ?? null }, after: patch, at: now });
      return t;
    });
  });

  app.post('/fleet/:id/damage', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    ctx.repos.requireFleetUnit(ctx.db, id);
    const body = parse(damageBody, request.body);
    const now = ctx.now();
    const out = ctx.db.transaction((tx) => {
      const d = ctx.repos.createDamage(tx, { fleetUnitId: id, panel: body.panel, description: body.description, severity: body.severity, foundAt: body.foundAt ?? now, foundBy: request.actor.userId, ...(body.reservationId ? { reservationId: body.reservationId } : {}), evidenceIds: body.evidenceIds, chargeable: body.chargeable });
      let task: ReadinessTask | undefined;
      if (body.createRepairTask) {
        task = ctx.repos.createReadinessTask(tx, { fleetUnitId: id, kind: 'damage_repair', blocksHire: defaultBlocksHire('damage_repair', body.severity), damageId: d.id, note: `Repair ${body.panel}: ${body.description}`.slice(0, 1000), createdBy: request.actor.userId, createdAt: now });
        ctx.repos.updateDamage(tx, d.id, { repairTaskId: task.id });
      }
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'fleet.damage.create', entity: 'fleet_damage', entityId: d.id, after: { fleetUnitId: id, panel: d.panel, severity: d.severity, chargeable: d.chargeable, repairTaskId: task?.id ?? null }, at: now });
      return { damage: ctx.repos.requireDamage(tx, d.id), repairTask: task ?? null };
    });
    return reply.status(201).send(out);
  });

  app.patch('/fleet/damage/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(damagePatchBody, request.body);
    const before = ctx.repos.requireDamage(ctx.db, id);
    const now = ctx.now();
    return ctx.db.transaction((tx) => {
      const d = ctx.repos.updateDamage(tx, id, {
        ...(body.repairedAt ? { repairedAt: body.repairedAt } : {}),
        ...(body.chargeable ? { chargeable: body.chargeable } : {}),
        ...(body.description ? { description: body.description } : {}),
        ...(body.evidenceIds ? { evidenceIds: body.evidenceIds } : {}),
      });
      // Repaired → its open repair task is done.
      if (body.repairedAt && before.repairTaskId) {
        const t = ctx.repos.getReadinessTask(tx, before.repairTaskId);
        if (t?.status === 'open') ctx.repos.updateReadinessTask(tx, t.id, { status: 'done', doneBy: request.actor.userId, doneAt: now });
      }
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'fleet.damage.update', entity: 'fleet_damage', entityId: id, before: { repairedAt: before.repairedAt ?? null, chargeable: before.chargeable }, after: body, at: now });
      return d;
    });
  });

  // ---- Locations -----------------------------------------------------------------------------
  app.get('/fleet/locations', async () => ({ items: ctx.repos.listLocations(ctx.db) }));

  app.post('/fleet/locations', async (request, reply) => {
    const body = parse(locationBody, request.body);
    const now = ctx.now();
    const loc = ctx.db.transaction((tx) => {
      const l = ctx.repos.createLocation(tx, { name: body.name, address: body.address ?? null, postcode: body.postcode ?? body.address?.postcode ?? null, lat: body.lat ?? null, lon: body.lon ?? null, ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}) });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'fleet.location.create', entity: 'fleet_locations', entityId: l.id, after: l, at: now });
      return l;
    });
    return reply.status(201).send(loc);
  });

  app.patch('/fleet/locations/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(locationPatchBody, request.body);
    const before = ctx.repos.requireLocation(ctx.db, id);
    const now = ctx.now();
    return ctx.db.transaction((tx) => {
      const l = ctx.repos.updateLocation(tx, id, body);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'fleet.location.update', entity: 'fleet_locations', entityId: id, before, after: body, at: now });
      return l;
    });
  });
}
