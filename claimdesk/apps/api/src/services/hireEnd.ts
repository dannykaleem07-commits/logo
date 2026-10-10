// owned by ap-booking
/**
 * Hire end (docs/SUPREME-AUTOPILOT.md §B.9), extracted unchanged in behaviour from `POST /claims/:id/hire/:hireId/end`:
 * end before start (class B), the end recorded with its GTA trigger, the fleet status, the `hire_ended` event and the
 * audit — inside the caller's transaction. The car's diary row (the hire's reservation) becomes `returned` with the
 * contractual end and the collection time, so the occupied period includes the time until the car was back.
 */
import type { FastifyRequest } from 'fastify';
import { calculateHire, HIRE_END_TRIGGER_TEXT, offHireDeadline, type HireAgreement, type HireEndTrigger, type Id, type ISODateTime } from '@ccguk/domain';
import type { Db } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { conflict } from '../errors.js';
import { gtaRatesFor } from './kb.js';
import type { OverrideGate } from './override.js';
import { endsBeforeStart, isLateEntry, refuseEndBeforeStart, syncDatesInvalidFlag, syncFleetStatus } from './hireCorrection.js';

export interface EndHireRecordInput {
  claimId: Id;
  hireId: Id;
  endAt: ISODateTime;
  endTrigger: HireEndTrigger;
  collectedAt?: ISODateTime;
  odometerIn?: number;
  reason?: string;
  userId: string;
}

export function endHireRecord(ctx: AppContext, tx: Db, request: FastifyRequest, gate: OverrideGate, input: EndHireRecordInput): HireAgreement {
  const current = ctx.repos.requireHire(tx, input.hireId);
  if (current.claimId !== input.claimId) throw conflict('WRONG_CLAIM', `Hire ${input.hireId} belongs to another claim`);
  if (current.endAt) throw conflict('HIRE_ALREADY_ENDED', 'Use Edit dates to change the end', { endAt: current.endAt });
  const invalid = endsBeforeStart(current.startAt, input.endAt);
  if (invalid) refuseEndBeforeStart(gate, current.startAt, input.endAt, { claimId: input.claimId, entity: 'hire_agreements', entityId: input.hireId });
  const now = ctx.now();
  const rates = gtaRatesFor(ctx);
  const lateEntry = isLateEntry(input.endAt, now);
  const h = ctx.repos.endHire(tx, input.hireId, { endAt: input.endAt, endTrigger: input.endTrigger, collectedAt: input.collectedAt, odometerIn: input.odometerIn }, { allowEndBeforeStart: invalid });
  // The diary row: returned, occupying until the later of the end and the collection.
  const res = h.reservationId ? ctx.repos.getReservation(tx, h.reservationId) : ctx.repos.listReservations(tx, { hireAgreementId: h.id })[0];
  if (res && res.status === 'on_hire' && !invalid) {
    ctx.repos.updateReservation(tx, res.id, { status: 'returned', endAt: input.endAt, ...(input.collectedAt ? { collectedAt: input.collectedAt } : {}) });
    ctx.repos.appendReservationEvent(tx, { reservationId: res.id, fromStatus: 'on_hire', toStatus: 'returned', actor: request.actor.userId, reason: input.reason ?? HIRE_END_TRIGGER_TEXT[input.endTrigger], data: { hireId: h.id, endAt: input.endAt, collectedAt: input.collectedAt ?? null }, at: now });
  }
  syncFleetStatus(ctx, tx, h.fleetUnitId, now);
  const deadline = offHireDeadline(input.endTrigger, input.endAt);
  const calc = calculateHire(h, h.endAt, { rates });
  ctx.repos.appendEvent(tx, {
    claimId: input.claimId,
    type: 'hire_ended',
    at: input.endAt,
    summary: `Hire ${h.agreementNumber} ended — ${HIRE_END_TRIGGER_TEXT[input.endTrigger]}${input.reason ? `: ${input.reason}` : ''}${lateEntry ? ' — entered late' : ''}`,
    data: { hireId: h.id, endTrigger: input.endTrigger, basis: deadline.basis, days: calc.days, netPence: calc.netPence, grossPence: calc.grossPence, odometerIn: input.odometerIn, lateEntry },
    attributableTo: 'ccguk',
    createdBy: input.userId,
    recordedAt: now,
  });
  if (invalid) syncDatesInvalidFlag(ctx, tx, input.claimId, h.agreementNumber);
  ctx.repos.appendAudit(tx, { actor: request.actor, action: 'hire.end', entity: 'hire_agreements', entityId: h.id, before: { endAt: current.endAt ?? null }, after: { endAt: h.endAt, endTrigger: input.endTrigger, reason: input.reason ?? null, lateEntry }, at: now });
  return h;
}
