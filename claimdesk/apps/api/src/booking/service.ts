// owned by ap-booking
/**
 * Booking service (docs/SUPREME-AUTOPILOT.md §B): the fleet diary's writes and reads.
 *
 * Race safety (§B.11): every hold / confirm / period change / handover / return runs its read-check-write inside ONE
 * `ctx.db.transaction(fn, { behavior: 'immediate' })` with no `await` inside, so two requests (two claims, or the
 * agent and the owner) cannot interleave between the check and the insert; the overlap trigger of 0013 is the second
 * line of defence (`ReservationOverlapError` → 409 RESERVATION_OVERLAP).
 *
 * Guards: the core booking guards are checked here (overlap, claim status, hard stop, second hire on the claim, the
 * claim's own vehicle, whole-period compliance, readiness, hire before the accident, hold expiry); every other §C.2
 * code comes from the clash service (`checkClashes`, ap-clash) and is enforced through the same manager-mode gate
 * (class A override with a reason, class B relaxable, class C never). Agents never override: a refusal carrying
 * `override` becomes Needs-you `override_needed` in the dispatcher, and an overlap refused to an agent never names the
 * other claim (SD §K.3).
 */
import type { FastifyRequest } from 'fastify';
import {
  CLASH_CATALOGUE,
  READINESS_KIND_TEXT,
  RESERVATION_STATUS_TEXT,
  addCalendarDays,
  canAllocateForPeriod,
  defaultBlocksHire,
  fleetStatusFromHires,
  fleetStatusFromReservations,
  formatRegistration,
  holdExpired,
  isoToMs,
  likeForLike,
  londonDate,
  londonDateTime,
  msToUtcIso,
  occupiedPeriod,
  offHireDeadline,
  overlappingReservations,
  projectHirePeriod,
  readyByTime,
  returnReadinessTasks,
  searchAvailability,
  slotLabel,
  unitLabel,
  unitReadiness,
  withHireNeedsDefaults,
  type Address,
  type AutopilotSettings,
  type AvailabilityQuery,
  type AvailabilityResult,
  type ClashCode,
  type ClashFinding,
  type ClashStage,
  type ClashSubject,
  type DamageSeverity,
  type DriverProfile,
  type FleetUnit,
  type FleetUse,
  type HireAgreement,
  type HireEndTrigger,
  type HireNeeds,
  type Id,
  type ISODateTime,
  type Movement,
  type MovementKind,
  type MovementStatus,
  type ProjectedPeriod,
  type ReadinessKind,
  type Reservation,
  type ReservationStatus,
  type UnitSnapshot,
  type Vehicle,
} from '@ccguk/domain';
import { ReservationOverlapError, type Db } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { conflict, badRequest, HttpError } from '../errors.js';
import { checkClashes, persistFindings } from '../clash/service.js';
import { eligibilityFor } from '../eligibility/service.js';
import { signedPackStatus } from '../signing/status.js';
import { syncEnforceabilityFromPack } from '../signing/enforceability.js';
import { createHireRecord, type CreateHireRecordResult } from '../services/hireCreate.js';
import { endHireRecord } from '../services/hireEnd.js';
import { gtaRatesFor } from '../services/kb.js';
import { hirePricingFor } from '../services/hirePricing.js';
import { loadBundle, recomputeClocks } from '../services/claimView.js';
import { assertNoHardStop } from '../routes/helpers.js';
import { STRICT_GATE, type OverrideGate, type OverrideTarget } from '../services/override.js';
import { nudgeAutopilot } from '../autopilot/nudge.js';

const IMMEDIATE = { behavior: 'immediate' } as const;
export const OVERLAP_MESSAGE = 'The car is held or booked for another claim for part of this period';
const NO_HIRE_STATUSES = new Set(['declined', 'settled', 'closed']);
const DAY_MS = 86_400_000;

export function autopilotSettings(ctx: AppContext): AutopilotSettings {
  return ctx.repos.getAgentSettings(ctx.db).autopilot;
}

const isAgent = (request: FastifyRequest | null): boolean => !!request?.agent;
const actorId = (request: FastifyRequest | null): string => request?.actor.userId ?? 'system';
const SYSTEM = { userId: 'system' as const };
const actorOf = (request: FastifyRequest | null) => request?.actor ?? SYSTEM;

function registrationFor(ctx: AppContext, db: Db, unit: FleetUnit): string {
  const v = ctx.repos.getVehicle(db, unit.vehicleId);
  return v ? formatRegistration(v.registration) : `Fleet unit ${unit.id}`;
}

/** The DB overlap trigger refused: the same 409 as the service check. */
function translateOverlap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ReservationOverlapError) throw conflict('RESERVATION_OVERLAP', OVERLAP_MESSAGE);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Refuse one or more block findings through the gate. Class C (or a code without an override code) is thrown as a
 * plain conflict; class A/B go through `gate.refuse` with the catalogue's override code, one call per override code
 * (so a manager override writes one `override.<CODE>` row per code).
 */
export function refuseFindings(gate: OverrideGate, blocks: Array<{ code: string; message: string }>, target: OverrideTarget): void {
  if (!blocks.length) return;
  const classC = blocks.filter((b) => {
    const def = CLASH_CATALOGUE[b.code as ClashCode];
    return !def || def.overrideClass === 'C' || !def.overrideCode;
  });
  if (classC.length) throw conflict(classC[0]!.code, classC.map((b) => b.message).join(' '), { findings: classC });
  const byCode = new Map<string, Array<{ code: string; message: string }>>();
  for (const b of blocks) {
    const oc = CLASH_CATALOGUE[b.code as ClashCode]!.overrideCode!;
    byCode.set(oc, [...(byCode.get(oc) ?? []), b]);
  }
  for (const [oc, list] of byCode) gate.refuse(conflict(oc, list.map((b) => b.message).join(' '), { findings: list.map((b) => ({ code: b.code, message: b.message })) }), target);
}

interface GuardInput {
  claimId: Id;
  unit: FleetUnit;
  use: FleetUse;
  startAt: ISODateTime;
  expectedEndAt: ISODateTime;
  /** Reservations ignored by the overlap and second-hire checks (the one being changed, a hold being replaced). */
  excludeIds: Id[];
  stage: ClashStage | 'period_change';
  /** The clash subject for the clash service. */
  subject: ClashSubject;
  /** Skip the start-time checks that only apply to new bookings (an on-hire period change). */
  physical?: boolean;
}

interface GuardResult {
  warnings: ClashFinding[];
  overlapOverrideAuditId?: Id;
  findings: ClashFinding[];
}

/** Codes this service checks itself; the clash service's findings for them are not enforced twice. */
const CHECKED_HERE = new Set<string>([
  'UNIT_DOUBLE_BOOKED',
  'CLAIM_STATUS_NO_HIRE',
  'HARD_STOP_FLAG',
  'CLAIM_SECOND_HIRE',
  'UNIT_IS_CLAIM_VEHICLE',
  'UNIT_NOT_READY',
  'UNIT_OFF_ROAD',
  'UNIT_DISPOSED',
  'USE_NOT_DECLARED',
  'POLICY_NOT_IN_FORCE',
  'POLICY_ENDS_IN_PERIOD',
  'MOT_INVALID_AT_START',
  'TAX_INVALID_AT_START',
  'PHV_LICENCE',
  'HIRE_BEFORE_ACCIDENT',
  'HOLD_EXPIRED',
]);

function warnFinding(code: string, message: string, claimId: Id, unitId: Id, reservationId?: Id): ClashFinding | null {
  const def = CLASH_CATALOGUE[code as ClashCode];
  if (!def) return null;
  return {
    code: def.code,
    severity: def.severity === 'block' ? 'warn' : def.severity,
    overrideClass: def.overrideClass,
    message,
    claimId,
    fleetUnitId: unitId,
    ...(reservationId ? { reservationId } : {}),
    related: { claimIds: [claimId], reservationIds: reservationId ? [reservationId] : [], hireIds: [], fleetUnitIds: [unitId], partyIds: [] },
    dedupeKey: [def.code, claimId, unitId, reservationId ?? '-'].join(':'),
  };
}

/** The core booking guards inside the caller's transaction (see the file comment). */
function bookingGuards(ctx: AppContext, tx: Db, request: FastifyRequest | null, gate: OverrideGate, g: GuardInput): GuardResult {
  const now = ctx.now();
  const claim = ctx.repos.requireClaim(tx, g.claimId);
  const target: OverrideTarget = { claimId: g.claimId, entity: 'fleet_reservations', entityId: g.excludeIds[0] ?? g.unit.id };
  const vehicle = ctx.repos.getVehicle(tx, g.unit.vehicleId);
  const reg = vehicle ? formatRegistration(vehicle.registration) : `Fleet unit ${g.unit.id}`;
  const warnings: ClashFinding[] = [];

  // Class C first: never overridable.
  if (NO_HIRE_STATUSES.has(claim.status)) throw conflict('CLAIM_STATUS_NO_HIRE', `Claim ${claim.reference} is ${claim.status}: no car can be booked on it.`);
  if (g.unit.vehicleId === claim.clientVehicleId || g.unit.vehicleId === claim.thirdPartyVehicleId) throw conflict('UNIT_IS_CLAIM_VEHICLE', `${reg} is a vehicle on this claim — it cannot be its hire car.`);
  if (!g.physical) assertNoHardStop(claim, gate);

  // 1. Overlap with the car's other bookings.
  const diary = ctx.repos.listReservations(tx, { fleetUnitId: g.unit.id });
  const overlaps = overlappingReservations({ startAt: g.startAt, endAt: g.expectedEndAt }, diary, now, g.excludeIds);
  let overlapOverrideAuditId: Id | undefined;
  if (overlaps.length) {
    if (g.physical) {
      // an on-hire period change is physical reality: reported, never refused (§B.11.4)
      const w = warnFinding('UNIT_DOUBLE_BOOKED', `${reg} would still be out when it is booked for another claim — move that booking to another car.`, g.claimId, g.unit.id, g.excludeIds[0]);
      if (w) warnings.push(w);
    } else if (isAgent(request)) {
      throw conflict('RESERVATION_OVERLAP', OVERLAP_MESSAGE);
    } else {
      const refs = overlaps.map((r) => ({ reservationId: r.id, claimId: r.claimId, claimReference: ctx.repos.getClaim(tx, r.claimId)?.reference ?? r.claimId, status: r.status, startAt: r.startAt, expectedEndAt: r.expectedEndAt }));
      const first = refs[0]!;
      const message = `${reg} is ${RESERVATION_STATUS_TEXT[first.status].toLowerCase()} for claim ${first.claimReference} for part of this period (taken a moment ago?).`;
      try {
        gate.refuse(conflict('HIRE_OVERLAP', message, { overlaps: refs }), target);
      } catch (err) {
        if (err instanceof HttpError && err.code === 'HIRE_OVERLAP') {
          const e = new HttpError(409, 'RESERVATION_OVERLAP', err.message, err.details);
          if (err.override) e.override = err.override;
          throw e;
        }
        throw err;
      }
      overlapOverrideAuditId = ctx.repos.appendAudit(tx, {
        actor: actorOf(request),
        action: 'booking.overlap_override',
        entity: 'fleet_reservations',
        entityId: g.excludeIds[0] ?? g.unit.id,
        after: { claimId: g.claimId, fleetUnitId: g.unit.id, overlaps: refs.map((r) => r.reservationId), reason: gate.reason },
        at: now,
      }).id;
    }
  }

  const blocks: Array<{ code: string; message: string }> = [];
  // 2. One live booking per claim (a swap is two touching periods).
  const own = ctx.repos.listReservations(tx, { claimId: g.claimId }).filter((r) => !g.excludeIds.includes(r.id));
  const second = own.filter((r) => r.status === 'held' || r.status === 'confirmed' || (r.status === 'on_hire' && overlappingReservations({ startAt: g.startAt, endAt: g.expectedEndAt }, [r], now).length > 0));
  if (second.length && !g.physical) blocks.push({ code: 'CLAIM_SECOND_HIRE', message: `This claim already has a ${RESERVATION_STATUS_TEXT[second[0]!.status].toLowerCase()} booking — release it first or swap at the end of it.` });

  if (!g.physical) {
    // 3. Whole-period compliance.
    const policies = ctx.repos.listPolicies(tx);
    const compliance = canAllocateForPeriod(g.unit, g.use, policies, { startAt: g.startAt, expectedEndAt: g.expectedEndAt }, vehicle, { now });
    for (const b of compliance.blocks) blocks.push({ code: CLASH_CATALOGUE[b.code as ClashCode] ? b.code : 'POLICY_NOT_IN_FORCE', message: b.message });
    for (const w of compliance.warns) {
      const f = warnFinding(w.code, w.message, g.claimId, g.unit.id);
      if (f) warnings.push(f);
    }
    // 4. Readiness at the start.
    const readiness = unitReadiness(ctx.repos.listReadinessTasks(tx, { fleetUnitId: g.unit.id, status: 'open' }), ctx.repos.listDamage(tx, { fleetUnitId: g.unit.id, unrepaired: true }), g.startAt);
    if (readiness.state === 'not_ready') blocks.push({ code: 'UNIT_NOT_READY', message: `${reg} is not ready for the start: open work blocks hire (${readiness.blocking.length} item${readiness.blocking.length === 1 ? '' : 's'}).` });
    // 5. Hire before the accident (class B).
    if (isoToMs(g.startAt) < isoToMs(claim.accident.occurredAt)) blocks.push({ code: 'HIRE_BEFORE_ACCIDENT', message: `The hire would start before the accident (${londonDate(claim.accident.occurredAt)}).` });
  }

  // 6. Everything else from the clash catalogue (ap-clash).
  const clash = checkClashes(ctx, g.subject);
  for (const f of clash.findings) {
    if (CHECKED_HERE.has(f.code)) continue;
    if (f.severity === 'block' && !g.physical) blocks.push({ code: f.code, message: f.message });
    else warnings.push(f.severity === 'block' ? { ...f, severity: 'warn' } : f);
  }
  refuseFindings(gate, blocks, target);
  return { warnings, findings: clash.findings, ...(overlapOverrideAuditId ? { overlapOverrideAuditId } : {}) };
}

// ---------------------------------------------------------------------------
// Reads: needs, drivers, snapshots, availability
// ---------------------------------------------------------------------------

export function hireNeedsFor(ctx: AppContext, claimId: Id): HireNeeds {
  return withHireNeedsDefaults(ctx.repos.getHireNeeds(ctx.db, claimId)?.needs);
}

function driverProfiles(ctx: AppContext, partyIds: Id[]): Map<Id, DriverProfile> {
  const out = new Map<Id, DriverProfile>();
  if (!partyIds.length) return out;
  const rows = ctx.handle.sqlite.prepare(`SELECT party_id AS partyId, profile FROM driver_profiles WHERE party_id IN (${partyIds.map(() => '?').join(',')})`).all(...partyIds) as Array<{ partyId: string; profile: string }>;
  for (const r of rows) {
    try {
      out.set(r.partyId, JSON.parse(r.profile) as DriverProfile);
    } catch {
      /* unreadable profile: treated as missing */
    }
  }
  return out;
}

/** The claim's drivers for the availability search (main driver first). */
export function claimDrivers(ctx: AppContext, claimId: Id, extra: Id[] = []): AvailabilityQuery['drivers'] {
  const claim = ctx.repos.requireClaim(ctx.db, claimId);
  const ids = [...new Set([claim.driverId ?? claim.claimantId, ...extra])];
  const profiles = driverProfiles(ctx, ids);
  return ids.map((partyId) => {
    const p = ctx.repos.getParty(ctx.db, partyId);
    const profile = profiles.get(partyId);
    return { partyId, ...(profile ? { profile } : {}), party: { name: p?.name ?? 'Driver', ...(p?.dateOfBirth ? { dateOfBirth: p.dateOfBirth } : {}), ...(p?.drivingLicenceNumber ? { drivingLicenceNumber: p.drivingLicenceNumber } : {}) } };
  });
}

/** One snapshot per fleet car (disposed cars included so the owner sees why they are not offered). */
export function unitSnapshots(ctx: AppContext, db: Db = ctx.db, unitIds?: Id[]): UnitSnapshot[] {
  const units = ctx.repos.listFleetUnits(db).filter((u) => !unitIds || unitIds.includes(u.id));
  const ids = units.map((u) => u.id);
  const policies = ctx.repos.listPolicies(db);
  const reservations = ctx.repos.listReservations(db, { fleetUnitId: ids });
  const readiness = ctx.repos.listReadinessTasks(db, { fleetUnitId: ids, status: 'open' });
  const damage = ctx.repos.listDamage(db, { fleetUnitId: ids, unrepaired: true });
  const penalties = ctx.repos.listPenalties(db, { open: true });
  const locations = new Map(ctx.repos.listLocations(db).map((l) => [l.id, l]));
  const out: UnitSnapshot[] = [];
  for (const unit of units) {
    const vehicle = ctx.repos.getVehicle(db, unit.vehicleId);
    if (!vehicle) continue;
    out.push({
      unit,
      vehicle,
      policies,
      reservations: reservations.filter((r) => r.fleetUnitId === unit.id),
      readiness: readiness.filter((t) => t.fleetUnitId === unit.id),
      damage: damage.filter((d) => d.fleetUnitId === unit.id),
      penalties: penalties.filter((p) => p.fleetUnitId === unit.id),
      location: unit.locationId ? (locations.get(unit.locationId) ?? null) : null,
    });
  }
  return out;
}

/** The projected period for a claim (§B.6). */
export function projectedPeriodFor(ctx: AppContext, claimId: Id): ProjectedPeriod {
  const settings = autopilotSettings(ctx);
  const bundle = loadBundle(ctx, claimId);
  const needs = hireNeedsFor(ctx, claimId);
  const elig = eligibilityFor(ctx, claimId);
  const driveable = elig.roadworthiness.driveable ?? bundle.claim.accident.driveable ?? null;
  return projectHirePeriod(
    { claim: bundle.claim, ...(bundle.report ? { report: bundle.report } : {}) },
    needs,
    { driveable, repairStartAt: elig.roadworthiness.repairStartAt },
    settings,
    ctx.now(),
  );
}

export interface AvailabilityInput {
  claimId: Id;
  startAt?: ISODateTime | null;
  expectedEndAt?: ISODateTime | null;
  use?: FleetUse | null;
  limit?: number | null;
  excludeReservationIds?: Id[];
  fleetUnitIds?: Id[];
}

export type AvailabilityResponse = AvailabilityResult & { projection: ProjectedPeriod | null; needs: HireNeeds; claimId: Id };

export function availabilityFor(ctx: AppContext, input: AvailabilityInput): AvailabilityResponse {
  const claim = ctx.repos.requireClaim(ctx.db, input.claimId);
  const settings = autopilotSettings(ctx);
  const needs = hireNeedsFor(ctx, claim.id);
  const projection = input.startAt && input.expectedEndAt ? null : projectedPeriodFor(ctx, claim.id);
  const startAt = input.startAt ?? projection!.startAt;
  let expectedEndAt = input.expectedEndAt ?? projection!.expectedEndAt;
  if (isoToMs(expectedEndAt) <= isoToMs(startAt)) expectedEndAt = msToUtcIso(isoToMs(startAt) + settings.projection.defaultHireDays * DAY_MS);
  const client = ctx.repos.getVehicle(ctx.db, claim.clientVehicleId);
  const pricing = (() => {
    const anyUnit = ctx.repos.listFleetUnits(ctx.db)[0];
    return anyUnit ? hirePricingFor(ctx, claim.id, anyUnit, startAt) : null;
  })();
  const clientGroup = pricing?.clientCar.group ?? client?.gtaGroup ?? null;
  // the claim's own live holds are re-searched over (they are the claim's own)
  const ownHolds = ctx.repos.listReservations(ctx.db, { claimId: claim.id, status: ['held', 'confirmed'] }).map((r) => r.id);
  const q: AvailabilityQuery = {
    claimId: claim.id,
    use: input.use ?? (needs.phvWork ? 'pco' : 'credit_hire'),
    startAt,
    expectedEndAt,
    needs,
    clientVehicle: client ? { gtaGroup: client.gtaGroup, bodyType: client.bodyType, fuelType: client.fuelType, transmission: client.transmission, spec: client.spec } : null,
    clientGroup,
    clientGroupSource: pricing?.clientCar.source ?? (client?.gtaGroup ? 'recorded' : 'none'),
    drivers: claimDrivers(ctx, claim.id),
    excludeReservationIds: [...new Set([...(input.excludeReservationIds ?? []), ...ownHolds])],
    limit: input.limit ?? 10,
  };
  const policies = new Map(ctx.repos.listPolicies(ctx.db).map((p) => [p.id, p]));
  const result = searchAvailability(q, unitSnapshots(ctx, ctx.db, input.fleetUnitIds), {
    rates: gtaRatesFor(ctx),
    weights: settings.ranking,
    turnaroundMinutes: settings.booking.turnaroundMinutes,
    clearWinnerGap: settings.green.clearWinnerGap,
    minLikeForLike: settings.green.minLikeForLike,
    criteria: (policyId) => (policyId ? policies.get(policyId)?.driverCriteria : undefined) ?? settings.eligibility.defaultCriteria,
    now: ctx.now(),
    claimVehicleIds: [claim.clientVehicleId, ...(claim.thirdPartyVehicleId ? [claim.thirdPartyVehicleId] : [])],
  });
  return { ...result, projection, needs, claimId: claim.id };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type ReservationView = Reservation & { registration: string; label: string; occupied: { startAt: ISODateTime; endAt: ISODateTime | null } };

export function reservationView(ctx: AppContext, r: Reservation, db: Db = ctx.db): ReservationView {
  const unit = ctx.repos.getFleetUnit(db, r.fleetUnitId);
  const vehicle = unit ? ctx.repos.getVehicle(db, unit.vehicleId) : undefined;
  const p = occupiedPeriod(r, ctx.now());
  return {
    ...r,
    registration: vehicle ? formatRegistration(vehicle.registration) : r.fleetUnitId,
    label: vehicle && unit ? unitLabel(vehicle, unit.gtaGroup) : r.gtaGroup,
    occupied: { startAt: msToUtcIso(p.startMs), endAt: p.endMs === null ? null : msToUtcIso(p.endMs) },
  };
}

export function claimBookings(ctx: AppContext, claimId: Id): { reservations: ReservationView[]; movements: Movement[] } {
  ctx.repos.requireClaim(ctx.db, claimId);
  return {
    reservations: ctx.repos
      .listReservations(ctx.db, { claimId })
      .map((r) => reservationView(ctx, r))
      .sort((a, b) => isoToMs(b.startAt) - isoToMs(a.startAt)),
    movements: ctx.repos.listMovements(ctx.db, { claimId }),
  };
}

export function bookingDetail(ctx: AppContext, id: Id) {
  const r = ctx.repos.requireReservation(ctx.db, id);
  return { ...reservationView(ctx, r), events: ctx.repos.listReservationEvents(ctx.db, id), movements: ctx.repos.listMovements(ctx.db, { reservationId: id }), signedPack: signedPackStatus(ctx, id) };
}

// ---------------------------------------------------------------------------
// Hold
// ---------------------------------------------------------------------------

export interface HoldInput {
  claimId: Id;
  fleetUnitId: Id;
  use: FleetUse;
  startAt: ISODateTime;
  expectedEndAt: ISODateTime;
  hirerPartyId?: Id | null;
  driverPartyIds?: Id[] | null;
  dailyRatePence?: number | null;
  substitutionReason?: string | null;
  /** The claim's current hold this one replaces (cancelled in the same transaction). */
  replaceReservationId?: Id | null;
  /** Book now (client present): hold and confirm in one transaction. */
  confirm?: boolean;
}

export interface BookingWriteResult {
  reservation: ReservationView;
  warnings: ClashFinding[];
}

function expireStaleHolds(ctx: AppContext, tx: Db, fleetUnitId: Id, now: ISODateTime, actor: string): Reservation[] {
  const stale = ctx.repos.listReservations(tx, { fleetUnitId, status: 'held' }).filter((r) => holdExpired(r, now));
  for (const r of stale) {
    ctx.repos.updateReservation(tx, r.id, { status: 'expired' });
    ctx.repos.appendReservationEvent(tx, { reservationId: r.id, fromStatus: 'held', toStatus: 'expired', actor, reason: 'Hold expired', at: now });
  }
  return stale;
}

export function placeHold(ctx: AppContext, request: FastifyRequest | null, gate: OverrideGate, input: HoldInput): BookingWriteResult {
  if (isoToMs(input.expectedEndAt) <= isoToMs(input.startAt)) throw badRequest('The expected end must be after the start');
  const settings = autopilotSettings(ctx);
  const now = ctx.now();
  const source = isAgent(request) ? 'autopilot' : 'handler';
  const result = ctx.db.transaction((tx) => {
    const claim = ctx.repos.requireClaim(tx, input.claimId);
    const unit = ctx.repos.requireFleetUnit(tx, input.fleetUnitId);
    const expired = expireStaleHolds(ctx, tx, unit.id, now, actorId(request));
    const replaced = input.replaceReservationId ? ctx.repos.requireReservation(tx, input.replaceReservationId) : undefined;
    if (replaced && replaced.claimId !== claim.id) throw conflict('WRONG_CLAIM', 'The booking to replace belongs to another claim');
    const hirerPartyId = input.hirerPartyId ?? claim.claimantId;
    const driverPartyIds = input.driverPartyIds?.length ? input.driverPartyIds : [...new Set([claim.driverId ?? claim.claimantId])];
    const subject: ClashSubject = { kind: 'proposed_booking', claimId: claim.id, fleetUnitId: unit.id, use: input.use, startAt: input.startAt, expectedEndAt: input.expectedEndAt, hirerPartyId, driverPartyIds, ...(replaced ? { excludeReservationId: replaced.id } : {}), stage: input.confirm ? 'confirm' : 'hold' };
    const guards = bookingGuards(ctx, tx, request, gate, { claimId: claim.id, unit, use: input.use, startAt: input.startAt, expectedEndAt: input.expectedEndAt, excludeIds: replaced ? [replaced.id] : [], stage: subject.stage, subject });
    // Like for like at the hold: a higher group needs a recorded substitution reason (clash GROUP_ABOVE_LFL, warn).
    const vehicle = ctx.repos.requireVehicle(tx, unit.vehicleId);
    const pricing = hirePricingFor(ctx, claim.id, unit, input.startAt);
    const client = ctx.repos.getVehicle(tx, claim.clientVehicleId);
    const lfl = likeForLike(client ? { gtaGroup: client.gtaGroup, bodyType: client.bodyType, fuelType: client.fuelType, transmission: client.transmission, spec: client.spec } : null, pricing.clientCar.group, vehicle, unit.gtaGroup, gtaRatesFor(ctx), londonDate(input.startAt));
    const warnings = [...guards.warnings];
    if (lfl.group.relation === 'higher' && !input.substitutionReason && !warnings.some((w) => w.code === 'GROUP_ABOVE_LFL')) {
      const w = warnFinding('GROUP_ABOVE_LFL', `${formatRegistration(vehicle.registration)} (${unit.gtaGroup}) is in a higher hire group than the client's car (${pricing.clientCar.group}) — only the like-for-like rate is recoverable; record a substitution reason.`, claim.id, unit.id);
      if (w) warnings.push(w);
    }
    if (replaced && (replaced.status === 'held' || replaced.status === 'confirmed')) {
      ctx.repos.updateReservation(tx, replaced.id, { status: 'cancelled', cancelledReason: `Replaced by a booking of ${formatRegistration(vehicle.registration)}` });
      ctx.repos.appendReservationEvent(tx, { reservationId: replaced.id, fromStatus: replaced.status, toStatus: 'cancelled', actor: actorId(request), reason: 'Replaced by another car', at: now });
    }
    const status: ReservationStatus = input.confirm ? 'confirmed' : 'held';
    const holdExpiresAt = msToUtcIso(isoToMs(now) + settings.booking.holdHours * 3_600_000);
    const ranking = (() => {
      try {
        return availabilityFor(ctx, { claimId: claim.id, startAt: input.startAt, expectedEndAt: input.expectedEndAt, use: input.use, fleetUnitIds: [unit.id], excludeReservationIds: replaced ? [replaced.id] : [] }).ranked[0];
      } catch {
        return undefined;
      }
    })();
    const agreementNumber = input.confirm ? ctx.repos.nextAgreementNumber(tx) : undefined;
    const r = translateOverlap(() =>
      ctx.repos.insertReservation(tx, {
        fleetUnitId: unit.id,
        claimId: claim.id,
        status,
        use: input.use,
        startAt: input.startAt,
        expectedEndAt: input.expectedEndAt,
        ...(input.confirm ? {} : { holdExpiresAt }),
        hirerPartyId,
        driverPartyIds,
        ...(agreementNumber ? { agreementNumber } : {}),
        dailyRatePence: input.dailyRatePence ?? unit.dailyRatePence,
        gtaGroup: unit.gtaGroup,
        ...(pricing.clientCar.group ? { clientGtaGroup: pricing.clientCar.group } : {}),
        ...(pricing.notices.length ? { pricingNote: pricing.notices[0]!.slice(0, 1000) } : {}),
        ...(input.substitutionReason ? { substitutionReason: input.substitutionReason } : {}),
        ...(ranking ? { ranking } : {}),
        clashReport: warnings,
        source,
        ...(guards.overlapOverrideAuditId ? { overlapOverrideAuditId: guards.overlapOverrideAuditId } : {}),
        createdBy: actorId(request),
        createdAt: now,
      }),
    );
    ctx.repos.appendReservationEvent(tx, { reservationId: r.id, toStatus: 'held', actor: actorId(request), reason: input.confirm ? 'Booked (client present)' : `Held until ${holdExpiresAt}`, data: { holdExpiresAt, ranking: ranking ? { score: ranking.score } : null }, at: now });
    if (input.confirm) {
      ctx.repos.appendReservationEvent(tx, { reservationId: r.id, fromStatus: 'held', toStatus: 'confirmed', actor: actorId(request), reason: 'Client present: booked now', data: { agreementNumber }, at: now });
      appendConfirmedEvent(ctx, tx, request, r, vehicle, now);
    }
    persistFindings(ctx, tx, { kind: 'reservation', reservationId: r.id, stage: subject.stage }, guards.findings);
    ctx.repos.appendAudit(tx, {
      actor: actorOf(request),
      action: input.confirm ? 'booking.book_now' : 'booking.hold',
      entity: 'fleet_reservations',
      entityId: r.id,
      after: { claimId: claim.id, fleetUnitId: unit.id, use: input.use, startAt: input.startAt, expectedEndAt: input.expectedEndAt, holdExpiresAt: input.confirm ? null : holdExpiresAt, agreementNumber: agreementNumber ?? null, warnings: warnings.map((w) => w.code), replaced: replaced?.id ?? null, source },
      at: now,
    });
    return { r, warnings, expired };
  }, IMMEDIATE);
  for (const e of result.expired) if (e.claimId !== input.claimId) nudgeAutopilot(ctx, e.claimId, 'hold expired');
  nudgeAutopilot(ctx, input.claimId, input.confirm ? 'booking confirmed' : 'car held');
  return { reservation: reservationView(ctx, result.r), warnings: result.warnings };
}

function appendConfirmedEvent(ctx: AppContext, tx: Db, request: FastifyRequest | null, r: Reservation, vehicle: Vehicle, now: ISODateTime): void {
  ctx.repos.appendEvent(tx, {
    claimId: r.claimId,
    type: 'booking_confirmed',
    at: now,
    summary: `Hire car ${formatRegistration(vehicle.registration)} booked from ${londonDate(r.startAt)}${r.agreementNumber ? ` (agreement ${r.agreementNumber})` : ''}`,
    data: { reservationId: r.id, fleetUnitId: r.fleetUnitId, registration: vehicle.registration, startAt: r.startAt, expectedEndAt: r.expectedEndAt, agreementNumber: r.agreementNumber ?? null },
    attributableTo: 'ccguk',
    createdBy: actorId(request),
    recordedAt: now,
  });
}

// ---------------------------------------------------------------------------
// Confirm / release / period
// ---------------------------------------------------------------------------

function acceptedOffer(ctx: AppContext, claimId: Id, reservationId: Id, hireOfferId: Id | null | undefined): boolean {
  const rows = ctx.handle.sqlite.prepare(`SELECT id, reservation_id AS reservationId FROM hire_offers WHERE claim_id = ? AND status = 'accepted'`).all(claimId) as Array<{ id: string; reservationId: string }>;
  return rows.some((o) => (hireOfferId ? o.id === hireOfferId : true) && (o.reservationId === reservationId || !!hireOfferId));
}

export function confirmBooking(ctx: AppContext, request: FastifyRequest | null, gate: OverrideGate, id: Id, input: { hireOfferId?: Id | null }): BookingWriteResult & { reheld: boolean } {
  const now = ctx.now();
  const current = ctx.repos.requireReservation(ctx.db, id);
  if (current.status === 'confirmed') return { reservation: reservationView(ctx, current), warnings: [], reheld: false };
  if (isAgent(request) && !acceptedOffer(ctx, current.claimId, current.id, input.hireOfferId)) {
    throw conflict('OFFER_NOT_ACCEPTED', 'An agent confirms a booking only after the client accepted the offer (record the acceptance first)');
  }
  const expiredHold = current.status === 'expired' || holdExpired(current, now);
  if (!expiredHold && current.status !== 'held') throw conflict('RESERVATION_STATE', `A ${RESERVATION_STATUS_TEXT[current.status].toLowerCase()} booking cannot be confirmed`);
  const result = ctx.db.transaction((tx) => {
    const r = ctx.repos.requireReservation(tx, id);
    const unit = ctx.repos.requireFleetUnit(tx, r.fleetUnitId);
    const vehicle = ctx.repos.requireVehicle(tx, unit.vehicleId);
    if (expiredHold) {
      // The hold ran out: re-hold if the car is still free, else HOLD_EXPIRED (class C — choose another car).
      const taken = overlappingReservations({ startAt: r.startAt, endAt: r.expectedEndAt }, ctx.repos.listReservations(tx, { fleetUnitId: unit.id }), now, [r.id]);
      if (taken.length) throw conflict('HOLD_EXPIRED', `The hold on ${formatRegistration(vehicle.registration)} expired and the car has been taken since — choose another car.`);
      if (r.status === 'held') {
        ctx.repos.updateReservation(tx, r.id, { status: 'expired' });
        ctx.repos.appendReservationEvent(tx, { reservationId: r.id, fromStatus: 'held', toStatus: 'expired', actor: actorId(request), reason: 'Hold expired before confirmation', at: now });
      }
    }
    const subject: ClashSubject = expiredHold
      ? { kind: 'proposed_booking', claimId: r.claimId, fleetUnitId: unit.id, use: r.use, startAt: r.startAt, expectedEndAt: r.expectedEndAt ?? r.startAt, hirerPartyId: r.hirerPartyId, driverPartyIds: r.driverPartyIds, excludeReservationId: r.id, stage: 'confirm' }
      : { kind: 'reservation', reservationId: r.id, stage: 'confirm' };
    const guards = bookingGuards(ctx, tx, request, gate, { claimId: r.claimId, unit, use: r.use, startAt: r.startAt, expectedEndAt: r.expectedEndAt ?? r.startAt, excludeIds: [r.id], stage: 'confirm', subject });
    const agreementNumber = ctx.repos.nextAgreementNumber(tx);
    let confirmed: Reservation;
    if (expiredHold) {
      const { id: _old, createdAt: _c, updatedAt: _u, status: _s, holdExpiresAt: _h, ...rest } = r;
      confirmed = translateOverlap(() =>
        ctx.repos.insertReservation(tx, { ...rest, status: 'confirmed', agreementNumber, ...(input.hireOfferId ? { hireOfferId: input.hireOfferId } : {}), clashReport: guards.warnings, ...(guards.overlapOverrideAuditId ? { overlapOverrideAuditId: guards.overlapOverrideAuditId } : {}), createdBy: actorId(request), createdAt: now }),
      );
      ctx.repos.appendReservationEvent(tx, { reservationId: confirmed.id, toStatus: 'held', actor: actorId(request), reason: `Re-held after the hold ${r.id} expired (car still free)`, at: now });
      ctx.repos.appendReservationEvent(tx, { reservationId: confirmed.id, fromStatus: 'held', toStatus: 'confirmed', actor: actorId(request), reason: input.hireOfferId ? 'Offer accepted' : 'Confirmed', data: { agreementNumber, hireOfferId: input.hireOfferId ?? null }, at: now });
    } else {
      confirmed = translateOverlap(() => ctx.repos.updateReservation(tx, r.id, { status: 'confirmed', agreementNumber, ...(input.hireOfferId ? { hireOfferId: input.hireOfferId } : {}), clashReport: guards.warnings }));
      ctx.repos.appendReservationEvent(tx, { reservationId: r.id, fromStatus: 'held', toStatus: 'confirmed', actor: actorId(request), reason: input.hireOfferId ? 'Offer accepted' : 'Confirmed', data: { agreementNumber, hireOfferId: input.hireOfferId ?? null }, at: now });
    }
    appendConfirmedEvent(ctx, tx, request, confirmed, vehicle, now);
    persistFindings(ctx, tx, { kind: 'reservation', reservationId: confirmed.id, stage: 'confirm' }, guards.findings);
    ctx.repos.appendAudit(tx, { actor: actorOf(request), action: 'booking.confirm', entity: 'fleet_reservations', entityId: confirmed.id, after: { claimId: r.claimId, agreementNumber, hireOfferId: input.hireOfferId ?? null, reheldFrom: expiredHold ? r.id : null, warnings: guards.warnings.map((w) => w.code) }, at: now });
    return { confirmed, warnings: guards.warnings };
  }, IMMEDIATE);
  nudgeAutopilot(ctx, current.claimId, 'booking confirmed');
  return { reservation: reservationView(ctx, result.confirmed), warnings: result.warnings, reheld: expiredHold };
}

export function releaseBooking(ctx: AppContext, request: FastifyRequest | null, id: Id, reason: string): ReservationView {
  const now = ctx.now();
  const r = ctx.db.transaction((tx) => {
    const cur = ctx.repos.requireReservation(tx, id);
    if (cur.status !== 'held' && cur.status !== 'confirmed') throw conflict('RESERVATION_STATE', `A ${RESERVATION_STATUS_TEXT[cur.status].toLowerCase()} booking cannot be released${cur.status === 'on_hire' ? ' — record the return instead' : ''}`);
    const next = ctx.repos.updateReservation(tx, id, { status: 'cancelled', cancelledReason: reason });
    ctx.repos.appendReservationEvent(tx, { reservationId: id, fromStatus: cur.status, toStatus: 'cancelled', actor: actorId(request), reason, at: now });
    for (const m of ctx.repos.listMovements(tx, { reservationId: id, status: ['planned', 'confirmed'] })) ctx.repos.updateMovement(tx, m.id, { status: 'cancelled', notes: [m.notes, `Booking released: ${reason}`].filter(Boolean).join('\n') });
    if (cur.status === 'confirmed') {
      ctx.repos.appendEvent(tx, { claimId: cur.claimId, type: 'booking_cancelled', at: now, summary: `Hire car booking ${cur.agreementNumber ?? ''} cancelled: ${reason}`.replace('  ', ' '), data: { reservationId: id, reason }, attributableTo: 'ccguk', createdBy: actorId(request), recordedAt: now });
    }
    ctx.repos.appendAudit(tx, { actor: actorOf(request), action: 'booking.release', entity: 'fleet_reservations', entityId: id, before: { status: cur.status }, after: { status: 'cancelled', reason }, at: now });
    return next;
  }, IMMEDIATE);
  nudgeAutopilot(ctx, r.claimId, 'booking released');
  return reservationView(ctx, r);
}

export interface PeriodPatch {
  startAt?: ISODateTime | null;
  expectedEndAt?: ISODateTime | null;
  reason: string;
  substitutionReason?: string | null;
  dailyRatePence?: number | null;
}

export function updateBookingPeriod(ctx: AppContext, request: FastifyRequest | null, gate: OverrideGate, id: Id, patch: PeriodPatch): BookingWriteResult {
  const now = ctx.now();
  const result = ctx.db.transaction((tx) => {
    const r = ctx.repos.requireReservation(tx, id);
    if (!['held', 'confirmed', 'on_hire'].includes(r.status)) throw conflict('RESERVATION_STATE', `A ${RESERVATION_STATUS_TEXT[r.status].toLowerCase()} booking cannot be changed`);
    if (patch.startAt && r.status === 'on_hire') throw conflict('RESERVATION_STATE', 'The start of a hire already under way cannot be moved here — correct the hire dates in the Hire tab');
    const startAt = patch.startAt ?? r.startAt;
    const expectedEndAt = patch.expectedEndAt ?? r.expectedEndAt;
    if (!expectedEndAt) throw badRequest('An expected end is needed');
    if (isoToMs(expectedEndAt) <= isoToMs(startAt)) throw badRequest('The expected end must be after the start');
    const unit = ctx.repos.requireFleetUnit(tx, r.fleetUnitId);
    const physical = r.status === 'on_hire';
    const guards = bookingGuards(ctx, tx, request, gate, { claimId: r.claimId, unit, use: r.use, startAt, expectedEndAt, excludeIds: [r.id], stage: 'period_change', subject: { kind: 'reservation', reservationId: r.id, stage: 'period_change' }, physical });
    const next = translateOverlap(() =>
      ctx.repos.updateReservation(tx, id, {
        startAt,
        expectedEndAt,
        ...(patch.substitutionReason ? { substitutionReason: patch.substitutionReason } : {}),
        ...(patch.dailyRatePence ? { dailyRatePence: patch.dailyRatePence } : {}),
        ...(guards.overlapOverrideAuditId ? { overlapOverrideAuditId: guards.overlapOverrideAuditId } : {}),
        clashReport: guards.warnings,
      }),
    );
    if (physical && r.hireAgreementId) ctx.repos.updateHire(tx, r.hireAgreementId, { expectedEndAt });
    ctx.repos.appendReservationEvent(tx, { reservationId: id, fromStatus: r.status, toStatus: r.status, actor: actorId(request), reason: patch.reason, data: { startAt: { from: r.startAt, to: startAt }, expectedEndAt: { from: r.expectedEndAt, to: expectedEndAt } }, at: now });
    persistFindings(ctx, tx, { kind: 'reservation', reservationId: id, stage: 'period_change' }, guards.findings);
    ctx.repos.appendAudit(tx, { actor: actorOf(request), action: 'booking.update', entity: 'fleet_reservations', entityId: id, before: { startAt: r.startAt, expectedEndAt: r.expectedEndAt }, after: { startAt, expectedEndAt, reason: patch.reason, warnings: guards.warnings.map((w) => w.code) }, at: now });
    return { next, warnings: guards.warnings };
  }, IMMEDIATE);
  nudgeAutopilot(ctx, result.next.claimId, 'booking period changed');
  return { reservation: reservationView(ctx, result.next), warnings: result.warnings };
}

/** After a hire's dates are corrected in the Hire tab, its diary row follows (no trigger refusal for on_hire/returned). */
export function syncReservationFromHire(ctx: AppContext, hireId: Id): void {
  try {
    const h = ctx.repos.getHire(ctx.db, hireId);
    if (!h) return;
    const r = h.reservationId ? ctx.repos.getReservation(ctx.db, h.reservationId) : ctx.repos.listReservations(ctx.db, { hireAgreementId: h.id })[0];
    if (!r || (r.status !== 'on_hire' && r.status !== 'returned')) return;
    const status: ReservationStatus = h.endAt ? 'returned' : 'on_hire';
    const patch = { status, startAt: h.startAt, ...(h.endAt ? { endAt: h.endAt, expectedEndAt: r.expectedEndAt && isoToMs(r.expectedEndAt) > isoToMs(h.startAt) ? r.expectedEndAt : h.endAt } : {}) };
    if (r.status === status && r.startAt === h.startAt && r.endAt === h.endAt) return;
    ctx.db.transaction((tx) => {
      ctx.repos.updateReservation(tx, r.id, patch);
      ctx.repos.appendReservationEvent(tx, { reservationId: r.id, fromStatus: r.status, toStatus: status, actor: 'system', reason: 'Hire dates corrected', data: { hireId, startAt: h.startAt, endAt: h.endAt ?? null }, at: ctx.now() });
    });
  } catch (err) {
    ctx.logger.warn('could not sync the booking from the corrected hire', { hireId, error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

export interface MovementInput {
  kind: MovementKind;
  windowStart: ISODateTime;
  windowEnd: ISODateTime;
  address: 'client_home' | 'delivery_address' | Address | null;
  postcode?: string | null;
  assignedTo?: string | null;
  notes?: string | null;
}

function resolveAddress(ctx: AppContext, claimId: Id, a: MovementInput['address']): Address | null {
  if (a && typeof a === 'object') return a;
  const claim = ctx.repos.requireClaim(ctx.db, claimId);
  const home = ctx.repos.getParty(ctx.db, claim.claimantId)?.address ?? null;
  if (a === 'delivery_address') return hireNeedsFor(ctx, claimId).deliveryAddress ?? home;
  if (a === 'client_home') return home;
  return null;
}

export function scheduleMovement(ctx: AppContext, request: FastifyRequest | null, gate: OverrideGate, reservationId: Id, input: MovementInput): { movement: Movement; warnings: ClashFinding[] } {
  const settings = autopilotSettings(ctx);
  const now = ctx.now();
  if (isoToMs(input.windowEnd) <= isoToMs(input.windowStart)) throw badRequest('The window must end after it starts');
  const address = resolveAddress(ctx, ctx.repos.requireReservation(ctx.db, reservationId).claimId, input.address);
  const result = ctx.db.transaction((tx) => {
    const r = ctx.repos.requireReservation(tx, reservationId);
    if (['cancelled', 'expired'].includes(r.status)) throw conflict('RESERVATION_STATE', `A ${RESERVATION_STATUS_TEXT[r.status].toLowerCase()} booking cannot have a ${input.kind}`);
    if (input.kind === 'delivery' && !['held', 'confirmed'].includes(r.status)) throw conflict('RESERVATION_STATE', 'A delivery is planned for a held or confirmed booking');
    const unit = ctx.repos.requireFleetUnit(tx, r.fleetUnitId);
    const warnings: ClashFinding[] = [];
    const target: OverrideTarget = { claimId: r.claimId, entity: 'fleet_movements', entityId: reservationId };
    if (input.kind === 'delivery' || input.kind === 'swap_in') {
      const ready = unitReadiness(ctx.repos.listReadinessTasks(tx, { fleetUnitId: unit.id, status: 'open' }), ctx.repos.listDamage(tx, { fleetUnitId: unit.id, unrepaired: true }), input.windowStart);
      if (ready.state !== 'ready') {
        const by = readyByTime(ready, input.windowStart);
        refuseFindings(gate, [{ code: 'DELIVERY_BEFORE_READY', message: `The delivery window starts before the car is ready${by ? ` (ready ${by})` : ''}.` }], target);
      }
    }
    const existing = ctx.repos.listMovements(tx, { status: ['planned', 'confirmed'] });
    const clashing = existing.filter((m) => isoToMs(m.windowStart) < isoToMs(input.windowEnd) && isoToMs(input.windowStart) < isoToMs(m.windowEnd));
    if (clashing.length >= settings.booking.maxPerWindow) {
      const w = warnFinding('DELIVERY_CAPACITY', `${clashing.length} other movement${clashing.length === 1 ? ' is' : 's are'} already booked in this window (limit ${settings.booking.maxPerWindow}).`, r.claimId, unit.id, r.id);
      if (w) warnings.push(w);
    }
    // a re-slot replaces the previous planned movement of the same kind
    for (const m of ctx.repos.listMovements(tx, { reservationId, status: ['planned', 'confirmed'] }).filter((m) => m.kind === input.kind)) {
      ctx.repos.updateMovement(tx, m.id, { status: 'cancelled', notes: [m.notes, `Re-slotted to ${slotLabel(input)}`].filter(Boolean).join('\n') });
    }
    const movement = ctx.repos.createMovement(tx, {
      reservationId,
      claimId: r.claimId,
      fleetUnitId: r.fleetUnitId,
      kind: input.kind,
      windowStart: msToUtcIso(isoToMs(input.windowStart)),
      windowEnd: msToUtcIso(isoToMs(input.windowEnd)),
      address,
      postcode: input.postcode ?? address?.postcode ?? null,
      assignedTo: input.assignedTo ?? null,
      status: 'planned',
      ...(input.notes ? { notes: input.notes } : {}),
      createdBy: actorId(request),
    });
    ctx.repos.appendAudit(tx, { actor: actorOf(request), action: 'movement.schedule', entity: 'fleet_movements', entityId: movement.id, after: { reservationId, kind: input.kind, windowStart: movement.windowStart, windowEnd: movement.windowEnd, warnings: warnings.map((w) => w.code) }, at: now });
    return { movement, warnings };
  }, IMMEDIATE);
  nudgeAutopilot(ctx, result.movement.claimId, `${input.kind} scheduled`);
  return result;
}

export interface MovementPatchInput {
  status?: Exclude<MovementStatus, 'done'> | null;
  windowStart?: ISODateTime | null;
  windowEnd?: ISODateTime | null;
  assignedTo?: string | null;
  notes?: string | null;
  reason?: string | null;
  clientNotifiedAt?: ISODateTime | null;
  noticeOutboxId?: Id | null;
}

export function patchMovement(ctx: AppContext, request: FastifyRequest | null, id: Id, patch: MovementPatchInput): Movement {
  const now = ctx.now();
  const m = ctx.db.transaction((tx) => {
    const cur = ctx.repos.requireMovement(tx, id);
    if (cur.status === 'done' || cur.status === 'cancelled') throw conflict('MOVEMENT_CLOSED', `This ${cur.kind} is already ${cur.status}`);
    if (patch.status === 'failed' && !patch.reason) throw badRequest('Say why the movement failed');
    const ws = patch.windowStart ?? cur.windowStart;
    const we = patch.windowEnd ?? cur.windowEnd;
    if (isoToMs(we) <= isoToMs(ws)) throw badRequest('The window must end after it starts');
    const next = ctx.repos.updateMovement(tx, id, {
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.windowStart ? { windowStart: msToUtcIso(isoToMs(patch.windowStart)) } : {}),
      ...(patch.windowEnd ? { windowEnd: msToUtcIso(isoToMs(patch.windowEnd)) } : {}),
      ...(patch.assignedTo !== undefined ? { assignedTo: patch.assignedTo } : {}),
      ...(patch.clientNotifiedAt ? { clientNotifiedAt: patch.clientNotifiedAt } : {}),
      ...(patch.noticeOutboxId ? { noticeOutboxId: patch.noticeOutboxId } : {}),
      ...(patch.notes || patch.reason ? { notes: [cur.notes, patch.notes, patch.reason ? `${patch.status ?? 'Changed'}: ${patch.reason}` : null].filter(Boolean).join('\n') } : {}),
    });
    ctx.repos.appendAudit(tx, { actor: actorOf(request), action: 'movement.update', entity: 'fleet_movements', entityId: id, before: { status: cur.status, windowStart: cur.windowStart, windowEnd: cur.windowEnd }, after: { ...patch }, at: now });
    return next;
  });
  nudgeAutopilot(ctx, m.claimId, `${m.kind} ${m.status}`);
  return m;
}

export type MovementBoardRow = Movement & {
  registration: string;
  label: string;
  claimReference: string;
  clientName: string | null;
  clientPhone: string | null;
  slot: string;
  reservationStatus: ReservationStatus | null;
};

/** Movements board (§I.4): `day` (London date) and `range` day | tomorrow | week. */
export function movementsBoard(ctx: AppContext, opts: { day?: string | null; range?: 'day' | 'tomorrow' | 'week' | null }): { from: ISODateTime; to: ISODateTime; items: MovementBoardRow[] } {
  const today = opts.day ?? londonDate(ctx.now());
  const startDay = opts.range === 'tomorrow' ? addCalendarDays(today, 1) : today;
  const days = opts.range === 'week' ? 7 : 1;
  const from = msToUtcIso(isoToMs(londonDateTime(startDay, 0)));
  const to = msToUtcIso(isoToMs(londonDateTime(addCalendarDays(startDay, days), 0)));
  const items = ctx.repos.listMovements(ctx.db, { from, to }).map((m) => {
    const unit = ctx.repos.getFleetUnit(ctx.db, m.fleetUnitId);
    const vehicle = unit ? ctx.repos.getVehicle(ctx.db, unit.vehicleId) : undefined;
    const claim = ctx.repos.getClaim(ctx.db, m.claimId);
    const client = claim ? ctx.repos.getParty(ctx.db, claim.claimantId) : undefined;
    return {
      ...m,
      registration: vehicle ? formatRegistration(vehicle.registration) : m.fleetUnitId,
      label: vehicle && unit ? unitLabel(vehicle, unit.gtaGroup) : '',
      claimReference: claim?.reference ?? m.claimId,
      clientName: client?.name ?? null,
      clientPhone: client?.phone ?? null,
      slot: slotLabel(m),
      reservationStatus: ctx.repos.getReservation(ctx.db, m.reservationId)?.status ?? null,
    };
  });
  return { from, to, items };
}

// ---------------------------------------------------------------------------
// Handover and return (people only — the routes are human-only in the perimeter)
// ---------------------------------------------------------------------------

export interface HandoverInput {
  at: ISODateTime;
  odometerOut: number;
  fuelEighths: number;
  conditionDocumentId?: Id | null;
  licenceEvidenceId?: Id | null;
  dvlaCheck: { checkedAt: ISODateTime; summary: string; evidenceId?: Id | null } | null;
  keys: number;
  notes?: string | null;
  excessPence?: number | null;
}

export function handover(ctx: AppContext, request: FastifyRequest, gate: OverrideGate, id: Id, input: HandoverInput): { reservation: ReservationView; hire: HireAgreement; created: CreateHireRecordResult } {
  const settings = autopilotSettings(ctx);
  const now = ctx.now();
  const out = ctx.db.transaction((tx) => {
    const r = ctx.repos.requireReservation(tx, id);
    if (r.status !== 'confirmed') throw conflict('RESERVATION_STATE', r.status === 'held' ? 'Confirm the booking before the handover' : `A ${RESERVATION_STATUS_TEXT[r.status].toLowerCase()} booking cannot be handed over`);
    const unit = ctx.repos.requireFleetUnit(tx, r.fleetUnitId);
    const vehicle = ctx.repos.requireVehicle(tx, unit.vehicleId);
    const target: OverrideTarget = { claimId: r.claimId, entity: 'fleet_reservations', entityId: id };
    const expectedEndAt = r.expectedEndAt && isoToMs(r.expectedEndAt) > isoToMs(input.at) ? r.expectedEndAt : msToUtcIso(isoToMs(input.at) + settings.projection.defaultHireDays * DAY_MS);
    // 1. Clash re-check at handover: core guards plus the handover-only checks.
    const guards = bookingGuards(ctx, tx, request, gate, { claimId: r.claimId, unit, use: r.use, startAt: input.at, expectedEndAt, excludeIds: [r.id], stage: 'handover', subject: { kind: 'reservation', reservationId: r.id, stage: 'handover' } });
    const handoverBlocks: Array<{ code: string; message: string }> = [];
    const pack = signedPackStatus(ctx, r.id);
    if (!pack.signed) handoverBlocks.push({ code: 'SIGNATURES_MISSING', message: `The hire paperwork is not signed: ${pack.missing.join(', ') || 'hire-start pack'}.` });
    const maxAge = settings.signing.dvlaCheckMaxAgeDays;
    if (!input.licenceEvidenceId || !input.dvlaCheck) handoverBlocks.push({ code: 'LICENCE_CHECK_STALE', message: !input.licenceEvidenceId ? 'No licence evidence is on file for this handover.' : 'No DVLA licence check is recorded.' });
    else if (isoToMs(input.at) - isoToMs(input.dvlaCheck.checkedAt) > maxAge * DAY_MS) handoverBlocks.push({ code: 'LICENCE_CHECK_STALE', message: `The DVLA check (${londonDate(input.dvlaCheck.checkedAt)}) is older than ${maxAge} days.` });
    refuseFindings(gate, handoverBlocks, target);
    // 2. The hire record from the reservation and the signed pack (§E.5).
    const proven = syncEnforceabilityFromPack(ctx, tx, { reservationId: r.id });
    const created = createHireRecord(ctx, tx, request, gate, {
      claimId: r.claimId,
      fleetUnitId: r.fleetUnitId,
      startAt: input.at,
      use: r.use,
      dailyRatePence: r.dailyRatePence,
      gtaGroup: r.gtaGroup,
      excessPence: input.excessPence ?? 0,
      additionalDrivers: r.driverPartyIds.slice(1).map((partyId) => ({ partyId, evidenceIds: [] })),
      deliveredAt: input.at,
      odometerOut: input.odometerOut,
      ...(proven.signedAt ? { signedAt: proven.signedAt } : {}),
      ...(proven.documentId ? { documentId: proven.documentId } : {}),
      ...(proven.enforceability ? { enforceability: proven.enforceability } : {}),
      ...(r.clientGtaGroup ? { clientGtaGroup: r.clientGtaGroup } : {}),
      ...(r.agreementNumber ? { agreementNumber: r.agreementNumber } : {}),
      hirerPartyId: r.hirerPartyId,
      driverPartyIds: r.driverPartyIds,
      reservationId: r.id,
      expectedEndAt,
      ...(r.pricingNote ? { pricingNote: r.pricingNote } : {}),
      reservation: 'linked',
      userId: request.user.id,
    });
    // 3. Reservation on hire, delivery done, the car's mileage.
    const onHire = ctx.repos.updateReservation(tx, r.id, { status: 'on_hire', startAt: input.at, expectedEndAt, hireAgreementId: created.hire.id, clashReport: guards.warnings });
    ctx.repos.appendReservationEvent(tx, { reservationId: r.id, fromStatus: 'confirmed', toStatus: 'on_hire', actor: actorId(request), reason: 'Handover', data: { hireId: created.hire.id, odometerOut: input.odometerOut, fuelEighths: input.fuelEighths, keys: input.keys }, at: now });
    const delivery = ctx.repos.listMovements(tx, { reservationId: r.id, status: ['planned', 'confirmed'] }).find((m) => m.kind === 'delivery');
    if (delivery) ctx.repos.updateMovement(tx, delivery.id, { status: 'done', doneAt: input.at, odometer: input.odometerOut, fuelEighths: input.fuelEighths, ...(input.conditionDocumentId ? { conditionDocumentId: input.conditionDocumentId } : {}), ...(input.notes ? { notes: input.notes } : {}) });
    ctx.repos.updateFleetUnit(tx, unit.id, { currentMileage: input.odometerOut, mileageAt: input.at });
    ctx.repos.appendEvent(tx, {
      claimId: r.claimId,
      type: 'hire_vehicle_delivered',
      at: input.at,
      summary: `Hire car ${formatRegistration(vehicle.registration)} handed over (agreement ${created.hire.agreementNumber}, ${input.odometerOut.toLocaleString('en-GB')} miles, fuel ${input.fuelEighths}/8)`,
      data: { reservationId: r.id, hireId: created.hire.id, odometerOut: input.odometerOut, fuelEighths: input.fuelEighths, keys: input.keys, conditionDocumentId: input.conditionDocumentId ?? null, licenceEvidenceId: input.licenceEvidenceId ?? null, dvlaCheck: input.dvlaCheck },
      attributableTo: 'ccguk',
      createdBy: request.user.id,
      recordedAt: now,
    });
    persistFindings(ctx, tx, { kind: 'reservation', reservationId: r.id, stage: 'handover' }, guards.findings);
    ctx.repos.appendAudit(tx, { actor: request.actor, action: 'booking.handover', entity: 'fleet_reservations', entityId: r.id, after: { hireId: created.hire.id, agreementNumber: created.hire.agreementNumber, at: input.at, odometerOut: input.odometerOut, fuelEighths: input.fuelEighths, keys: input.keys, signedPack: pack, dvlaCheck: input.dvlaCheck }, at: now });
    return { onHire, created };
  }, IMMEDIATE);
  recomputeClocks(ctx, out.onHire.claimId);
  nudgeAutopilot(ctx, out.onHire.claimId, 'hire started');
  return { reservation: reservationView(ctx, out.onHire), hire: out.created.hire, created: out.created };
}

export interface ReturnInput {
  collectedAt: ISODateTime;
  endAt: ISODateTime;
  endTrigger: HireEndTrigger;
  odometerIn: number;
  fuelEighths: number;
  conditionDocumentId?: Id | null;
  damage: Array<{ panel: string; description: string; severity: DamageSeverity; evidenceIds: Id[] }>;
  notes?: string | null;
}

const TRIGGER_EVENTS: Partial<Record<HireEndTrigger, string>> = {
  repair_complete_24h: 'repair_completed',
  tl_payment_5wd: 'tl_payment_received',
  insurer_termination_1wd: 'insurer_termination_notice',
  cash_in_lieu: 'cash_in_lieu_received',
};

/** HIRE_PAST_OFFHIRE: the end is after the off-hire deadline for the recorded trigger (those days are not recoverable). */
export function offHireCheck(ctx: AppContext, claimId: Id, trigger: HireEndTrigger, endAt: ISODateTime): { deadline: ISODateTime | null; basis: string | null; late: boolean } {
  const type = TRIGGER_EVENTS[trigger];
  if (!type) return { deadline: null, basis: null, late: false };
  const ev = ctx.repos.listEvents(ctx.db, claimId, { type: type as never }).sort((a, b) => isoToMs(b.at) - isoToMs(a.at))[0];
  if (!ev) return { deadline: null, basis: null, late: false };
  const d = offHireDeadline(trigger, ev.at);
  return { deadline: d.dueAt, basis: d.basis, late: isoToMs(endAt) > isoToMs(d.dueAt) };
}

export function returnBooking(ctx: AppContext, request: FastifyRequest, gate: OverrideGate, id: Id, input: ReturnInput): { reservation: ReservationView; hire: HireAgreement; warnings: ClashFinding[]; readiness: Array<{ id: Id; kind: ReadinessKind }> } {
  const settings = autopilotSettings(ctx);
  const now = ctx.now();
  const out = ctx.db.transaction((tx) => {
    const r = ctx.repos.requireReservation(tx, id);
    if (r.status !== 'on_hire' || !r.hireAgreementId) throw conflict('RESERVATION_STATE', `A ${RESERVATION_STATUS_TEXT[r.status].toLowerCase()} booking cannot be returned`);
    const hireBefore = ctx.repos.requireHire(tx, r.hireAgreementId);
    if (hireBefore.odometerOut !== undefined && input.odometerIn < hireBefore.odometerOut) throw badRequest(`Odometer in (${input.odometerIn}) is less than odometer out (${hireBefore.odometerOut})`);
    const unit = ctx.repos.requireFleetUnit(tx, r.fleetUnitId);
    const vehicle = ctx.repos.requireVehicle(tx, unit.vehicleId);
    const hire = endHireRecord(ctx, tx, request, gate, { claimId: r.claimId, hireId: r.hireAgreementId, endAt: input.endAt, endTrigger: input.endTrigger, collectedAt: input.collectedAt, odometerIn: input.odometerIn, ...(input.notes ? { reason: input.notes } : {}), userId: request.user.id });
    // endHireRecord moved the diary row to returned (with the collection time); fetch it.
    const returned = ctx.repos.requireReservation(tx, id);
    const collection = ctx.repos.listMovements(tx, { reservationId: id, status: ['planned', 'confirmed'] }).find((m) => m.kind === 'collection');
    if (collection) ctx.repos.updateMovement(tx, collection.id, { status: 'done', doneAt: input.collectedAt, odometer: input.odometerIn, fuelEighths: input.fuelEighths, ...(input.conditionDocumentId ? { conditionDocumentId: input.conditionDocumentId } : {}) });
    ctx.repos.updateFleetUnit(tx, unit.id, { currentMileage: input.odometerIn, mileageAt: input.collectedAt });
    // Damage and the readiness tasks of every return (§B.2).
    const damageRows = input.damage.map((d) => ctx.repos.createDamage(tx, { fleetUnitId: unit.id, panel: d.panel, description: d.description, severity: d.severity, foundAt: input.collectedAt, foundBy: request.user.id, reservationId: id, ...(collection ? { movementId: collection.id } : {}), evidenceIds: d.evidenceIds, chargeable: 'tbc' }));
    const plans = returnReadinessTasks(input.collectedAt, unit.turnaroundMinutes ?? settings.booking.turnaroundMinutes, input.damage);
    const tasks = plans.map((p) => {
      const damage = p.damageIndex !== undefined ? damageRows[p.damageIndex] : undefined;
      const t = ctx.repos.createReadinessTask(tx, { fleetUnitId: unit.id, kind: p.kind, blocksHire: p.blocksHire, ...(p.readyByAt ? { readyByAt: p.readyByAt } : {}), reservationId: id, ...(damage ? { damageId: damage.id } : {}), note: p.note, createdBy: request.user.id, createdAt: now });
      if (damage) ctx.repos.updateDamage(tx, damage.id, { repairTaskId: t.id });
      return t;
    });
    ctx.repos.appendEvent(tx, {
      claimId: r.claimId,
      type: 'hire_vehicle_collected',
      at: input.collectedAt,
      summary: `Hire car ${formatRegistration(vehicle.registration)} collected (${input.odometerIn.toLocaleString('en-GB')} miles, fuel ${input.fuelEighths}/8${damageRows.length ? `, ${damageRows.length} damage item${damageRows.length === 1 ? '' : 's'}` : ''})`,
      data: { reservationId: id, hireId: hire.id, odometerIn: input.odometerIn, fuelEighths: input.fuelEighths, damageIds: damageRows.map((d) => d.id), conditionDocumentId: input.conditionDocumentId ?? null },
      attributableTo: 'ccguk',
      createdBy: request.user.id,
      recordedAt: now,
    });
    const warnings: ClashFinding[] = [];
    const off = offHireCheck(ctx, r.claimId, input.endTrigger, input.endAt);
    if (off.late) {
      const w = warnFinding('HIRE_PAST_OFFHIRE', `The hire ends after the off-hire deadline (${off.deadline}): ${off.basis}. The days after it are not recoverable.`, r.claimId, unit.id, id);
      if (w) warnings.push(w);
    }
    ctx.repos.appendAudit(tx, { actor: request.actor, action: 'booking.return', entity: 'fleet_reservations', entityId: id, after: { hireId: hire.id, endAt: input.endAt, endTrigger: input.endTrigger, collectedAt: input.collectedAt, odometerIn: input.odometerIn, damage: damageRows.length, offHire: off }, at: now });
    return { returned, hire, warnings, tasks };
  }, IMMEDIATE);
  recomputeClocks(ctx, out.returned.claimId);
  nudgeAutopilot(ctx, out.returned.claimId, 'hire car returned');
  return { reservation: reservationView(ctx, out.returned), hire: out.hire, warnings: out.warnings, readiness: out.tasks.map((t) => ({ id: t.id, kind: t.kind })) };
}

// ---------------------------------------------------------------------------
// Fleet housekeeping (§B.10)
// ---------------------------------------------------------------------------

/** Fleet status from the diary and the hires: on hire iff an on-hire booking (or a running hire) covers now. */
export function syncUnitStatus(ctx: AppContext, db: Db, unitId: Id, now: ISODateTime): FleetUnit['status'] {
  const unit = ctx.repos.requireFleetUnit(db, unitId);
  if (unit.status === 'off_road' || unit.status === 'disposed') return unit.status;
  const fromRes = fleetStatusFromReservations(unit, ctx.repos.listReservations(db, { fleetUnitId: unitId, status: 'on_hire' }), now);
  const fromHires = fleetStatusFromHires(unit, ctx.repos.listHireForFleetUnit(db, unitId), now);
  const next: FleetUnit['status'] = fromRes === 'on_hire' || fromHires === 'on_hire' ? 'on_hire' : 'available';
  if (next !== unit.status) ctx.repos.updateFleetUnit(db, unitId, { status: next });
  return next;
}

export function fleetStatusSync(ctx: AppContext): { checked: number; changed: number } {
  const now = ctx.now();
  let changed = 0;
  const units = ctx.repos.listFleetUnits(ctx.db);
  for (const u of units) {
    const before = u.status;
    if (syncUnitStatus(ctx, ctx.db, u.id, now) !== before) changed += 1;
  }
  return { checked: units.length, changed };
}

/** booking.expire_holds: every held reservation past its expiry → expired (the claim's tick re-plans). */
export function expireHolds(ctx: AppContext, actor = 'agent:autopilot'): { expired: Array<{ id: Id; claimId: Id }> } {
  const now = ctx.now();
  const due = ctx.repos.listExpiredHolds(ctx.db, isoToMs(now));
  const expired: Array<{ id: Id; claimId: Id }> = [];
  for (const r of due) {
    ctx.db.transaction((tx) => {
      const cur = ctx.repos.getReservation(tx, r.id);
      if (!cur || cur.status !== 'held') return;
      ctx.repos.updateReservation(tx, r.id, { status: 'expired' });
      ctx.repos.appendReservationEvent(tx, { reservationId: r.id, fromStatus: 'held', toStatus: 'expired', actor, reason: 'Hold expired', data: { holdExpiresAt: r.holdExpiresAt ?? null }, at: now });
      ctx.repos.appendAudit(tx, { actor: { userId: actor }, action: 'booking.expire', entity: 'fleet_reservations', entityId: r.id, after: { claimId: r.claimId, holdExpiresAt: r.holdExpiresAt ?? null }, at: now });
      expired.push({ id: r.id, claimId: r.claimId });
    }, IMMEDIATE);
  }
  for (const e of expired) nudgeAutopilot(ctx, e.claimId, 'hold expired');
  return { expired };
}

const COMPLIANCE_KINDS: Array<{ kind: ReadinessKind; due: (u: FleetUnit, v: Vehicle) => string | undefined }> = [
  { kind: 'mot', due: (_u, v) => v.motExpiryDate },
  { kind: 'tax', due: (_u, v) => v.taxDueDate },
  { kind: 'service', due: (u) => u.serviceDueDate },
  { kind: 'phv_licence', due: (u) => (u.phvLicensed ? u.phvLicenceExpiry : undefined) },
];

/** fleet.compliance_watch: a readiness task 30 days before each MOT / tax / service / PHV licence date (one open task per kind). */
export function complianceWatch(ctx: AppContext, aheadDays = 30, actor = 'agent:autopilot'): { created: Array<{ fleetUnitId: Id; kind: ReadinessKind; dueAt: ISODateTime }> } {
  const now = ctx.now();
  const today = londonDate(now);
  const horizon = addCalendarDays(today, aheadDays);
  const created: Array<{ fleetUnitId: Id; kind: ReadinessKind; dueAt: ISODateTime }> = [];
  for (const unit of ctx.repos.listFleetUnits(ctx.db)) {
    if (unit.status === 'disposed') continue;
    const vehicle = ctx.repos.getVehicle(ctx.db, unit.vehicleId);
    if (!vehicle) continue;
    const open = ctx.repos.listReadinessTasks(ctx.db, { fleetUnitId: unit.id, status: 'open' });
    for (const c of COMPLIANCE_KINDS) {
      const date = c.due(unit, vehicle);
      if (!date || date > horizon) continue;
      if (open.some((t) => t.kind === c.kind)) continue;
      // the task blocks hire from the day after the due date (the MOT/tax/licence is valid through its date)
      const dueAt = msToUtcIso(isoToMs(londonDateTime(addCalendarDays(date, 1), 0)));
      const t = ctx.repos.createReadinessTask(ctx.db, { fleetUnitId: unit.id, kind: c.kind, blocksHire: defaultBlocksHire(c.kind), dueAt, note: `${READINESS_KIND_TEXT[c.kind]} due ${date} on ${formatRegistration(vehicle.registration)}`, createdBy: actor, createdAt: now });
      created.push({ fleetUnitId: unit.id, kind: t.kind, dueAt });
    }
  }
  return { created };
}

// ---------------------------------------------------------------------------
// Calendar (§I.3)
// ---------------------------------------------------------------------------

export interface CalendarQuery {
  from: ISODateTime;
  to: ISODateTime;
  unitIds?: Id[];
  group?: string | null;
  use?: FleetUse | null;
  locationId?: Id | null;
  /** A claim-scoped run: other claims' bookings appear as "booked" with no reference or name. */
  claimScope?: Id | null;
}

export interface CalendarBar {
  id: Id;
  status: ReservationStatus;
  startAt: ISODateTime;
  endAt: ISODateTime | null;
  holdExpiresAt?: ISODateTime;
  claimId?: Id;
  claimReference?: string;
  clientName?: string;
  agreementNumber?: string;
  label: string;
  clash: boolean;
}

export interface CalendarRow {
  fleetUnitId: Id;
  registration: string;
  label: string;
  group: string;
  status: FleetUnit['status'];
  declaredUses: FleetUse[];
  location: string | null;
  bookings: CalendarBar[];
  readiness: Array<{ id: Id; kind: ReadinessKind; from: ISODateTime; to: ISODateTime | null; blocksHire: boolean }>;
  markers: Array<{ kind: 'mot' | 'tax' | 'policy' | 'service' | 'phv_licence'; date: string; insideBooking: boolean }>;
  movements: Array<{ id: Id; kind: MovementKind; windowStart: ISODateTime; windowEnd: ISODateTime; status: MovementStatus }>;
}

export function fleetCalendar(ctx: AppContext, q: CalendarQuery): { from: ISODateTime; to: ISODateTime; rows: CalendarRow[] } {
  const now = ctx.now();
  const fromMs = isoToMs(q.from);
  const toMs = isoToMs(q.to);
  const policies = new Map(ctx.repos.listPolicies(ctx.db).map((p) => [p.id, p]));
  const locations = new Map(ctx.repos.listLocations(ctx.db).map((l) => [l.id, l.name]));
  const units = ctx.repos
    .listFleetUnits(ctx.db)
    .filter((u) => u.status !== 'disposed')
    .filter((u) => !q.unitIds?.length || q.unitIds.includes(u.id))
    .filter((u) => !q.group || u.gtaGroup.toUpperCase() === q.group.toUpperCase())
    .filter((u) => !q.use || u.declaredUses.includes(q.use))
    .filter((u) => !q.locationId || u.locationId === q.locationId);
  const rows: CalendarRow[] = [];
  for (const unit of units) {
    const vehicle = ctx.repos.getVehicle(ctx.db, unit.vehicleId);
    if (!vehicle) continue;
    const res = ctx.repos.listReservations(ctx.db, { fleetUnitId: unit.id, status: ['held', 'confirmed', 'on_hire', 'returned'], fromMs, toMs });
    const periods = res.map((r) => ({ r, p: occupiedPeriod(r, now) }));
    const bookings: CalendarBar[] = periods
      .filter(({ p }) => p.startMs < toMs && (p.endMs === null || p.endMs > fromMs))
      .map(({ r, p }) => {
        const clash = periods.some((o) => o.r.id !== r.id && o.p.startMs < (p.endMs ?? Infinity) && p.startMs < (o.p.endMs ?? Infinity));
        const mine = !q.claimScope || r.claimId === q.claimScope;
        const claim = mine ? ctx.repos.getClaim(ctx.db, r.claimId) : undefined;
        const client = claim ? ctx.repos.getParty(ctx.db, claim.claimantId) : undefined;
        return {
          id: r.id,
          status: r.status,
          startAt: msToUtcIso(p.startMs),
          endAt: p.endMs === null ? null : msToUtcIso(p.endMs),
          ...(r.holdExpiresAt && r.status === 'held' ? { holdExpiresAt: r.holdExpiresAt } : {}),
          ...(mine ? { claimId: r.claimId, ...(claim ? { claimReference: claim.reference } : {}), ...(client ? { clientName: client.name } : {}), ...(r.agreementNumber ? { agreementNumber: r.agreementNumber } : {}) } : {}),
          label: mine ? `${RESERVATION_STATUS_TEXT[r.status]}${claim ? ` · ${claim.reference}` : ''}` : 'Booked',
          clash,
        };
      });
    const readiness = ctx.repos
      .listReadinessTasks(ctx.db, { fleetUnitId: unit.id, status: 'open' })
      .map((t) => ({ id: t.id, kind: t.kind, from: t.dueAt && isoToMs(t.dueAt) > isoToMs(t.createdAt) && t.blocksHire ? t.dueAt : t.createdAt, to: t.readyByAt ?? null, blocksHire: t.blocksHire }));
    const inside = (date: string): boolean => {
      const ms = isoToMs(londonDateTime(date, 12));
      return periods.some(({ p, r }) => r.status !== 'returned' && p.startMs <= ms && (p.endMs === null || p.endMs > ms));
    };
    const markers: CalendarRow['markers'] = [];
    const add = (kind: CalendarRow['markers'][number]['kind'], date: string | undefined): void => {
      if (!date) return;
      const ms = isoToMs(londonDateTime(date, 12));
      if (ms < fromMs || ms >= toMs) return;
      markers.push({ kind, date, insideBooking: inside(date) });
    };
    add('mot', vehicle.motExpiryDate);
    add('tax', vehicle.taxDueDate);
    add('service', unit.serviceDueDate);
    add('policy', unit.policyId ? policies.get(unit.policyId)?.endDate : undefined);
    if (unit.phvLicensed) add('phv_licence', unit.phvLicenceExpiry);
    const movements = ctx.repos
      .listMovements(ctx.db, { fleetUnitId: unit.id, from: q.from, to: q.to })
      .filter((m) => m.status !== 'cancelled')
      .filter((m) => !q.claimScope || m.claimId === q.claimScope)
      .map((m) => ({ id: m.id, kind: m.kind, windowStart: m.windowStart, windowEnd: m.windowEnd, status: m.status }));
    rows.push({
      fleetUnitId: unit.id,
      registration: formatRegistration(vehicle.registration),
      label: unitLabel(vehicle, unit.gtaGroup),
      group: unit.gtaGroup,
      status: unit.status,
      declaredUses: unit.declaredUses,
      location: unit.locationId ? (locations.get(unit.locationId) ?? null) : null,
      bookings,
      readiness,
      markers,
      movements,
    });
  }
  rows.sort((a, b) => a.group.localeCompare(b.group) || a.registration.localeCompare(b.registration));
  return { from: q.from, to: q.to, rows };
}

/** Single-car, period-aware allocation check (POST /fleet/:id/allocate-check, §B.10). */
export function allocateCheckForPeriod(ctx: AppContext, unitId: Id, input: { use: FleetUse; claimId?: Id; startAt: ISODateTime; expectedEndAt: ISODateTime }): { ok: boolean; reasons: string[]; warnings: string[] } {
  const unit = ctx.repos.requireFleetUnit(ctx.db, unitId);
  const vehicle = ctx.repos.getVehicle(ctx.db, unit.vehicleId);
  const policies = ctx.repos.listPolicies(ctx.db);
  const check = canAllocateForPeriod(unit, input.use, policies, { startAt: input.startAt, expectedEndAt: input.expectedEndAt }, vehicle, { now: ctx.now() });
  const reasons = [...check.reasons];
  const warnings = [...check.warnings];
  const own = input.claimId ? ctx.repos.listReservations(ctx.db, { claimId: input.claimId }).map((r) => r.id) : [];
  const overlaps = overlappingReservations({ startAt: input.startAt, endAt: input.expectedEndAt }, ctx.repos.listReservations(ctx.db, { fleetUnitId: unitId }), ctx.now(), own);
  if (overlaps.length) reasons.push(`Unit is ${overlaps.some((r) => r.status === 'on_hire') ? 'on hire' : 'held or booked'} for part of this period`);
  const ready = unitReadiness(ctx.repos.listReadinessTasks(ctx.db, { fleetUnitId: unitId, status: 'open' }), ctx.repos.listDamage(ctx.db, { fleetUnitId: unitId, unrepaired: true }), input.startAt);
  if (ready.state === 'not_ready') reasons.push('Unit is not ready for the start (open blocking work)');
  else if (ready.state === 'ready_by') warnings.push(`Unit is ready by ${ready.at}`);
  return { ok: reasons.length === 0, reasons, warnings };
}

export { STRICT_GATE };
