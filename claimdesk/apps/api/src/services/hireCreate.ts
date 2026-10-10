// owned by ap-booking
/**
 * Hire record creation (docs/SUPREME-AUTOPILOT.md §B.9), extracted unchanged in behaviour from `POST /claims/:id/hire`:
 * end before start (class B), `canAllocate` with an on-hire car treated as available, the period overlap with the car's
 * other hires (HIRE_OVERLAP, class A), allocation refusal (ALLOCATION_REFUSED, class A), the pricing snapshot, the
 * `hire_started` (and, for a late entry, `hire_ended`) events, the enforceability flag, the audit row and the fleet
 * status — all inside the caller's transaction `tx`, so a handover's clash checks, the hire and the reservation update
 * commit or roll back together.
 *
 * Two callers:
 *  - the manual path (`POST /claims/:id/hire`): `reservation: 'create'` also writes the car's diary row in the same
 *    transaction (`on_hire`, or `returned` for a hire entered late with its end; source 'handler');
 *  - the handover (`POST /bookings/:id/handover`): the confirmed reservation supplies the agreement number, use,
 *    hirer, drivers, rates and the expected end; the caller moves the reservation to `on_hire`.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import {
  calculateHire,
  formatGBP,
  HIRE_END_TRIGGER_TEXT,
  offHireDeadline,
  overlappingReservations,
  type AdditionalDriver,
  type AllocationCheck,
  type Claim,
  type FleetUnit,
  type FleetUse,
  type HireAgreement,
  type HireEndTrigger,
  type Id,
  type ISODateTime,
  type Pence,
  type Reservation,
} from '@ccguk/domain';
import type { Db } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { conflict } from '../errors.js';
import { canAllocateFor } from '../engines.js';
import { gtaRatesFor } from './kb.js';
import type { OverrideGate, OverrideTarget } from './override.js';
import { hirePricingFor, pricingColumns, type HirePricingGuideResponse } from './hirePricing.js';
import { endsBeforeStart, hireDateWarnings, isLateEntry, refuseEndBeforeStart, refuseOverlap, registrationOf, syncDatesInvalidFlag, syncFleetStatus } from './hireCorrection.js';

export interface CreateHireRecordInput {
  claimId: Id;
  fleetUnitId: Id;
  startAt: ISODateTime;
  use: FleetUse;
  dailyRatePence?: Pence;
  vatRate?: number;
  gtaGroup?: string;
  excessPence: Pence;
  excessWaiverDailyPence?: Pence;
  additionalDrivers?: AdditionalDriver[];
  deliveredAt?: ISODateTime;
  odometerOut?: number;
  signedAt?: ISODateTime;
  documentId?: Id;
  enforceability?: Partial<HireAgreement['enforceability']>;
  needStatementEvidenceId?: Id;
  overrideAllocation?: { reason: string };
  endAt?: ISODateTime;
  endTrigger?: HireEndTrigger;
  endReason?: string;
  clientGtaGroup?: string;
  // From a confirmed reservation (§B.9 step 2)
  agreementNumber?: string;
  hirerPartyId?: Id;
  driverPartyIds?: Id[];
  reservationId?: Id;
  expectedEndAt?: ISODateTime;
  pricingNote?: string;
  /** 'create': write the car's diary row too (manual path). 'linked': the reservation exists (handover). */
  reservation: 'create' | 'linked';
  /** Who recorded it (events' createdBy). */
  userId: string;
}

export interface CreateHireRecordResult {
  hire: HireAgreement;
  allocation: AllocationCheck;
  pricing: HirePricingGuideResponse;
  enforceabilityGaps: string[];
  warnings: string[];
  reservationId: Id | null;
}

export function enforceabilityGaps(h: HireAgreement): string[] {
  const gaps: string[] = [];
  const e = h.enforceability;
  if (!e.cancellationInfoProvidedAt) gaps.push('CCR 2013 Sch 2 cancellation information not recorded');
  if (!e.schedule3FormProvidedAt) gaps.push('CCR 2013 Sch 3 cancellation form not recorded');
  if (!e.expressRequestToStartAt) gaps.push('Express request to start within the cancellation period (reg 36) not recorded');
  if (!e.cca60fCompliant) gaps.push('RAO art 60F exemption not confirmed (≤12 payments within 12 months, no interest or charges)');
  if (!h.signedAt) gaps.push('Agreement not signed');
  return gaps;
}

/** The hire record (and, on the manual path, its diary row) inside `tx`. Throws (rolling `tx` back) on any refusal. */
export function createHireRecord(ctx: AppContext, tx: Db, request: FastifyRequest, gate: OverrideGate, input: CreateHireRecordInput): CreateHireRecordResult {
  const claim: Claim = ctx.repos.requireClaim(tx, input.claimId);
  const unit: FleetUnit = ctx.repos.requireFleetUnit(tx, input.fleetUnitId);
  const target: OverrideTarget = { claimId: input.claimId, entity: 'fleet_units', entityId: unit.id };
  const endAt = input.endAt;
  const endTrigger = endAt ? (input.endTrigger ?? 'manual') : undefined;
  // 2. End before start.
  const invalid = endsBeforeStart(input.startAt, endAt);
  if (invalid) refuseEndBeforeStart(gate, input.startAt, endAt!, target);
  // 3. Allocation with an on-hire unit treated as available: the period overlap decides that case.
  const policies = ctx.repos.listPolicies(tx);
  const allocation = canAllocateFor({ ...unit, status: unit.status === 'on_hire' ? 'available' : unit.status }, input.use, policies, input.startAt, ctx.repos.getVehicle(tx, unit.vehicleId));
  // 4. Period overlap with the car's other hires.
  refuseOverlap(ctx, gate, unit, { startAt: input.startAt, endAt: endAt ?? null }, target);
  // 5. Allocation refused (status, use, policy, MOT, tax).
  if (!allocation.ok) gate.refuse(conflict('ALLOCATION_REFUSED', `${registrationOf(ctx, unit)} cannot be allocated for ${input.use}: ${allocation.reasons.join('; ')}`, { reasons: allocation.reasons }), target);

  const settings = ctx.settings();
  const now = ctx.now();
  const hireGroup = input.gtaGroup?.trim().toUpperCase() || unit.gtaGroup;
  const pricing = hirePricingFor(ctx, input.claimId, { ...unit, gtaGroup: hireGroup }, input.startAt, input.clientGtaGroup);
  const cols = pricingColumns(pricing);
  const lateEntry = isLateEntry(input.startAt, now);
  const rates = gtaRatesFor(ctx);
  const hirerPartyId = input.hirerPartyId ?? claim.claimantId;
  const driverPartyIds = input.driverPartyIds ?? [...new Set([claim.driverId ?? claim.claimantId, ...(input.additionalDrivers ?? []).map((d) => d.partyId)])];

  // Diary row for the manual path: the claim's own held/confirmed booking of this car becomes the hire's row; any
  // other booking overlapping the period is refused as HIRE_OVERLAP (class A, manager override recorded on the row).
  let reservationId: Id | null = input.reservationId ?? null;
  let overlapOverrideAuditId: Id | undefined;
  let adopted: Reservation | undefined;
  let agreementNumber = input.agreementNumber;
  if (input.reservation === 'create') {
    const diary = ctx.repos.listReservations(tx, { fleetUnitId: unit.id });
    adopted = diary.find((r) => r.claimId === input.claimId && (r.status === 'held' || r.status === 'confirmed'));
    reservationId = adopted?.id ?? randomUUID();
    agreementNumber = agreementNumber ?? adopted?.agreementNumber;
    const others = overlappingReservations({ startAt: input.startAt, endAt: endAt ?? null }, diary, now, adopted ? [adopted.id] : []);
    if (others.length) {
      const reg = registrationOf(ctx, unit);
      if (!gate.applied.some((o) => o.code === 'HIRE_OVERLAP')) {
        gate.refuse(conflict('HIRE_OVERLAP', `${reg} is held or booked for another claim for part of this period.`, { reservations: others.map((r) => ({ id: r.id, status: r.status, startAt: r.startAt, expectedEndAt: r.expectedEndAt })) }), target);
      }
      overlapOverrideAuditId = ctx.repos.appendAudit(tx, {
        actor: request.actor,
        action: 'booking.overlap_override',
        entity: 'fleet_reservations',
        entityId: reservationId,
        after: { claimId: input.claimId, fleetUnitId: unit.id, overlaps: others.map((r) => r.id), reason: gate.reason },
        at: now,
      }).id;
    }
  }

  const h = ctx.repos.createHire(
    tx,
    {
      claimId: input.claimId,
      fleetUnitId: unit.id,
      ...(agreementNumber ? { agreementNumber } : {}),
      startAt: input.startAt,
      ...(endAt ? { endAt, endTrigger } : {}),
      dailyRatePence: input.dailyRatePence ?? unit.dailyRatePence,
      vatRate: input.vatRate ?? settings.rateCard.vatRate,
      gtaGroup: hireGroup,
      excessPence: input.excessPence,
      excessWaiverDailyPence: input.excessWaiverDailyPence,
      additionalDrivers: input.additionalDrivers,
      deliveredAt: input.deliveredAt,
      odometerOut: input.odometerOut,
      signedAt: input.signedAt,
      ...(input.documentId ? { documentId: input.documentId } : {}),
      enforceability: input.enforceability,
      needStatementEvidenceId: input.needStatementEvidenceId,
      fleetDailyRatePence: cols.fleetDailyRatePence,
      ...(cols.clientGtaGroup ? { clientGtaGroup: cols.clientGtaGroup } : {}),
      ...(cols.clientGtaDailyRatePence !== null ? { clientGtaDailyRatePence: cols.clientGtaDailyRatePence } : {}),
      ...(cols.hireGtaDailyRatePence !== null ? { hireGtaDailyRatePence: cols.hireGtaDailyRatePence } : {}),
      ...(input.pricingNote ? { pricingNote: input.pricingNote } : cols.pricingNote ? { pricingNote: cols.pricingNote } : {}),
      use: input.use,
      hirerPartyId,
      driverPartyIds,
      ...(reservationId ? { reservationId } : {}),
      ...(input.expectedEndAt ? { expectedEndAt: input.expectedEndAt } : {}),
    },
    { allowEndBeforeStart: invalid },
  );
  if (input.reservation === 'create' && reservationId) {
    const status = h.endAt ? 'returned' : 'on_hire';
    // a hire entered with its end occupies [start, end); an open manual hire stays open until it ends
    const period = { startAt: h.startAt, expectedEndAt: h.endAt && !invalid ? h.endAt : (input.expectedEndAt ?? adopted?.expectedEndAt ?? null), ...(h.endAt && !invalid ? { endAt: h.endAt } : {}) };
    if (adopted) {
      ctx.repos.updateReservation(tx, adopted.id, { ...period, status, agreementNumber: h.agreementNumber, hireAgreementId: h.id, dailyRatePence: h.dailyRatePence, gtaGroup: h.gtaGroup, ...(overlapOverrideAuditId ? { overlapOverrideAuditId } : {}) });
    } else {
      ctx.repos.insertReservation(tx, {
        id: reservationId,
        fleetUnitId: unit.id,
        claimId: input.claimId,
        status,
        use: input.use,
        ...period,
        hirerPartyId,
        driverPartyIds,
        agreementNumber: h.agreementNumber,
        hireAgreementId: h.id,
        dailyRatePence: h.dailyRatePence,
        gtaGroup: h.gtaGroup,
        ...(h.clientGtaGroup ? { clientGtaGroup: h.clientGtaGroup } : {}),
        ...(h.pricingNote ? { pricingNote: h.pricingNote } : {}),
        source: 'handler',
        ...(overlapOverrideAuditId ? { overlapOverrideAuditId } : {}),
        createdBy: request.actor.userId,
        createdAt: now,
      });
    }
    ctx.repos.appendReservationEvent(tx, { reservationId, ...(adopted ? { fromStatus: adopted.status } : {}), toStatus: status, actor: request.actor.userId, reason: 'Hire recorded in the Hire tab', data: { hireId: h.id }, at: now });
  }
  syncFleetStatus(ctx, tx, unit.id, now);
  ctx.repos.appendEvent(tx, {
    claimId: input.claimId,
    type: 'hire_started',
    at: input.startAt,
    summary: `Hire ${h.agreementNumber} started on ${registrationOf(ctx, unit)} (group ${h.gtaGroup}, ${formatGBP(h.dailyRatePence)}/day ex VAT)${lateEntry ? ' — entered late' : ''}`,
    data: { hireId: h.id, fleetUnitId: unit.id, use: input.use, allocation, lateEntry, ...(reservationId ? { reservationId } : {}) },
    attributableTo: 'ccguk',
    createdBy: input.userId,
    recordedAt: now,
  });
  if (h.endAt && h.endTrigger) {
    const deadline = offHireDeadline(h.endTrigger, h.endAt);
    const calc = calculateHire(h, h.endAt, { rates });
    ctx.repos.appendEvent(tx, {
      claimId: input.claimId,
      type: 'hire_ended',
      at: h.endAt,
      summary: `Hire ${h.agreementNumber} ended — ${HIRE_END_TRIGGER_TEXT[h.endTrigger]}${input.endReason ? `: ${input.endReason}` : ''}`,
      data: { hireId: h.id, endTrigger: h.endTrigger, basis: deadline.basis, days: calc.days, netPence: calc.netPence, grossPence: calc.grossPence, lateEntry: isLateEntry(h.endAt, now) },
      attributableTo: 'ccguk',
      createdBy: input.userId,
      recordedAt: now,
    });
  }
  const gaps = enforceabilityGaps(h);
  if (gaps.length) {
    ctx.repos.addClaimFlag(tx, input.claimId, { code: 'HIRE_ENFORCEABILITY_GAP', severity: 'warn', message: `Hire ${h.agreementNumber}: ${gaps.join('; ')}`, raisedBy: 'system' });
  }
  if (invalid) syncDatesInvalidFlag(ctx, tx, input.claimId, h.agreementNumber);
  ctx.repos.appendAudit(tx, {
    actor: request.actor,
    action: 'hire.create',
    entity: 'hire_agreements',
    entityId: h.id,
    after: {
      claimId: input.claimId,
      fleetUnitId: unit.id,
      use: input.use,
      allocation,
      override: input.overrideAllocation ?? null,
      enforceabilityGaps: gaps,
      lateEntry,
      ...(reservationId ? { reservationId } : {}),
      ...(h.endAt ? { endAt: h.endAt, endTrigger: h.endTrigger, endReason: input.endReason ?? null } : {}),
      pricing: {
        hireGroup: h.gtaGroup,
        hireGtaDailyRatePence: cols.hireGtaDailyRatePence,
        clientGtaGroup: cols.clientGtaGroup,
        clientGroupSource: pricing.clientCar.source,
        clientGtaDailyRatePence: cols.clientGtaDailyRatePence,
        fleetDailyRatePence: cols.fleetDailyRatePence,
        agreedDailyRatePence: h.dailyRatePence,
        differencePerDayPence: pricing.differencePerDayPence,
        higherGroup: pricing.higherGroup,
      },
    },
    at: now,
  });
  const warnings = [...hireDateWarnings(claim, h.startAt, h.endAt, now), ...allocation.warnings];
  return { hire: h, allocation, pricing, enforceabilityGaps: gaps, warnings, reservationId };
}
