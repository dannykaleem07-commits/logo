// owned by ap-clash
/**
 * detectClashes (docs/SUPREME-AUTOPILOT.md §C.1, §C.2) — pure.
 *
 * The subject decides which codes run (each catalogue entry lists its subjects):
 *  - proposed_booking / reservation / hire: a "booking context" (claim, car, use, occupied period, hirer, drivers) is
 *    checked against the world;
 *  - claim: the claim-level codes, then every live reservation of the claim (held / confirmed / on hire, at its natural
 *    stage) and every open hire that has no live reservation;
 *  - fleet_unit: FLEET_REG_AS_CLAIM_VEHICLE, then every live reservation and open hire of the car.
 * Handover-only codes (LICENCE_CHECK_STALE, SIGNATURES_MISSING) run only when the stage is `handover`.
 *
 * Messages never name another claim or another claim's people: the related ids are in `related` (the UI and the
 * owner can open them); an agent's refusal text therefore never leaks another file. Dedupe keys are the code, the
 * subject's own ids, then the sorted related ids — stable across runs.
 */
import type { Claim, FleetUnit, FleetUse, HireAgreement, HireEndTrigger, ISODate, ISODateTime, Id, InsurancePolicy, Party, Vehicle } from '../types.js';
import type { AutopilotSettings } from '../autopilot/settings.js';
import type { Reservation } from '../booking/types.js';
import { BLOCKING_RESERVATION_STATUSES } from '../booking/types.js';
import type { DriverProfile } from '../eligibility/types.js';
import { assessDriver } from '../eligibility/driver.js';
import { needLevel } from '../eligibility/need.js';
import { clientCarOnDate } from '../eligibility/roadworthiness.js';
import { londonDate } from '../calendar/index.js';
import { offHireDeadline } from '../gta/hire.js';
import { gtaRate } from '../gta/rates.js';
import { formatRegistration } from '../vehicle/registration.js';
import { CLASH_CATALOGUE } from './catalogue.js';
import { samePerson, vehicleMatch } from './identity.js';
import type { ClashCode, ClashFinding, ClashSeverity, ClashStage, ClashSubject, ClashSubjectKind, ClashWorld } from './types.js';

type Opts = { now: ISODateTime; settings: AutopilotSettings };
type BookingKind = 'proposed_booking' | 'reservation' | 'hire';
type Stage = ClashStage | 'return' | 'period_change';

const DAY_MS = 86_400_000;
const LIVE_STATUSES = ['held', 'confirmed', 'on_hire'] as const;
const FINAL_CLAIM_STATUSES: readonly Claim['status'][] = ['declined', 'settled', 'closed'];
const OFF_HIRE_EVENTS: Readonly<Partial<Record<string, HireEndTrigger>>> = {
  repair_completed: 'repair_complete_24h',
  tl_payment_received: 'tl_payment_5wd',
  insurer_termination_notice: 'insurer_termination_1wd',
  cash_in_lieu_received: 'cash_in_lieu',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
};
const dayOf = (msv: number): ISODate => londonDate(new Date(msv).toISOString());
const fmtDay = (msv: number | null): string => {
  if (msv === null) return 'open-ended';
  const [y, m, d] = dayOf(msv).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
};
const fmtIsoDay = (d: string): string => {
  const [y, m, dd] = d.slice(0, 10).split('-');
  return `${Number(dd)} ${MONTHS[Number(m) - 1]} ${y}`;
};
const overlaps = (aS: number, aE: number | null, bS: number, bE: number | null): boolean => aS < (bE ?? Number.MAX_SAFE_INTEGER) && bS < (aE ?? Number.MAX_SAFE_INTEGER);
const addDays = (d: ISODate, n: number): ISODate => new Date(Date.parse(`${d.slice(0, 10)}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The period a reservation occupies (§B.1): held/confirmed [start, expectedEnd); on hire until max(expectedEnd, now); returned until max(end, collected). */
export function reservationOccupied(r: Reservation, nowMs: number): { startMs: number; endMs: number | null } | null {
  const s = ms(r.startAt);
  if (s === null) return null;
  switch (r.status) {
    case 'held':
    case 'confirmed':
      return { startMs: s, endMs: ms(r.expectedEndAt) };
    case 'on_hire': {
      const e = ms(r.expectedEndAt);
      return { startMs: s, endMs: e === null ? null : Math.max(e, nowMs) };
    }
    case 'returned': {
      const end = ms(r.endAt) ?? ms(r.expectedEndAt);
      const col = ms(r.collectedAt);
      if (end === null) return { startMs: s, endMs: col };
      return { startMs: s, endMs: Math.max(end, col ?? end) };
    }
    default:
      return null;
  }
}

/** The period a hire agreement occupies: [start, max(end, collected)); open ones until max(expectedEnd, now) or open. */
export function hireOccupied(h: HireAgreement, nowMs: number): { startMs: number; endMs: number | null } | null {
  const s = ms(h.startAt);
  if (s === null) return null;
  const end = ms(h.endAt);
  if (end !== null) return { startMs: s, endMs: Math.max(end, ms(h.collectedAt) ?? end) };
  const exp = ms(h.expectedEndAt);
  return { startMs: s, endMs: exp === null ? null : Math.max(exp, nowMs) };
}

// ---------------------------------------------------------------------------
// World index
// ---------------------------------------------------------------------------

interface Occupancy {
  ref: Id;
  kind: 'reservation' | 'hire';
  claimId: Id;
  fleetUnitId: Id;
  startMs: number;
  endMs: number | null;
  hirerPartyId?: Id;
  driverPartyIds: Id[];
  reservation?: Reservation;
  hire?: HireAgreement;
}

class Index {
  readonly claims = new Map<Id, Claim>();
  readonly vehicles = new Map<Id, Vehicle>();
  readonly parties = new Map<Id, Party>();
  readonly profiles = new Map<Id, DriverProfile>();
  readonly units = new Map<Id, FleetUnit>();
  readonly policies = new Map<Id, InsurancePolicy>();
  readonly nowMs: number;
  readonly occupancies: Occupancy[] = [];

  constructor(
    readonly w: ClashWorld,
    readonly opts: Opts,
  ) {
    this.nowMs = Date.parse(opts.now);
    for (const c of w.claims) this.claims.set(c.id, c);
    for (const v of w.vehicles) this.vehicles.set(v.id, v);
    for (const p of w.parties) this.parties.set(p.id, p);
    for (const p of w.driverProfiles) this.profiles.set(p.partyId, p);
    for (const u of w.fleetUnits) this.units.set(u.id, u);
    for (const p of w.policies) this.policies.set(p.id, p);
    const linkedHires = new Set<Id>();
    for (const r of w.reservations) {
      if (r.hireAgreementId) linkedHires.add(r.hireAgreementId);
      if (!(BLOCKING_RESERVATION_STATUSES as readonly string[]).includes(r.status)) continue;
      const p = reservationOccupied(r, this.nowMs);
      if (!p) continue;
      this.occupancies.push({ ref: r.id, kind: 'reservation', claimId: r.claimId, fleetUnitId: r.fleetUnitId, startMs: p.startMs, endMs: p.endMs, hirerPartyId: r.hirerPartyId, driverPartyIds: r.driverPartyIds ?? [], reservation: r });
    }
    const reservationIds = new Set(w.reservations.map((r) => r.id));
    for (const h of w.hires) {
      if (linkedHires.has(h.id) || (h.reservationId && reservationIds.has(h.reservationId))) continue;
      const p = hireOccupied(h, this.nowMs);
      if (!p) continue;
      const claim = this.claims.get(h.claimId);
      const hirer = h.hirerPartyId ?? claim?.driverId ?? claim?.claimantId;
      this.occupancies.push({
        ref: h.id,
        kind: 'hire',
        claimId: h.claimId,
        fleetUnitId: h.fleetUnitId,
        startMs: p.startMs,
        endMs: p.endMs,
        ...(hirer ? { hirerPartyId: hirer } : {}),
        driverPartyIds: h.driverPartyIds ?? h.additionalDrivers.map((d) => d.partyId),
        hire: h,
      });
    }
  }

  registration(unit: FleetUnit | undefined): string {
    const v = unit ? this.vehicles.get(unit.vehicleId) : undefined;
    return v ? formatRegistration(v.registration) : 'The car';
  }

  claimVehicles(c: Claim): Vehicle[] {
    return [c.clientVehicleId, c.thirdPartyVehicleId].map((id) => (id ? this.vehicles.get(id) : undefined)).filter((v): v is Vehicle => !!v);
  }

  /** The policy chain of a unit: the linked policy, its renewals and its predecessors. */
  policyChain(unit: FleetUnit): InsurancePolicy[] {
    if (!unit.policyId) return [];
    const start = this.policies.get(unit.policyId);
    if (!start) return [];
    const out = new Map<Id, InsurancePolicy>([[start.id, start]]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of this.w.policies) {
        if (out.has(p.id)) continue;
        const linked = [...out.values()].some((q) => q.renewsPolicyId === p.id || p.renewsPolicyId === q.id);
        if (linked) {
          out.set(p.id, p);
          grew = true;
        }
      }
    }
    return [...out.values()].sort((a, b) => a.startDate.localeCompare(b.startDate));
  }
}

// ---------------------------------------------------------------------------
// Booking context
// ---------------------------------------------------------------------------

interface BookingCtx {
  kind: BookingKind;
  stage: Stage;
  claim?: Claim;
  claimId: Id;
  unit?: FleetUnit;
  fleetUnitId: Id;
  vehicle?: Vehicle;
  use: FleetUse;
  startMs: number;
  /** null = open-ended. */
  endMs: number | null;
  hirerPartyId?: Id;
  driverPartyIds: Id[];
  reservation?: Reservation;
  hire?: HireAgreement;
  /** Reservation and hire ids that are this booking (never a clash with itself). */
  self: Set<Id>;
  /** Own reference in dedupe keys. */
  ownRef: Id;
  /** The car is already out (on hire, returned, a hire record, or the return itself). */
  onHire: boolean;
  /** A booking still to be made or confirmed (start-time checks apply as a block). */
  newBooking: boolean;
}

function naturalStage(r: Reservation): Stage {
  return r.status === 'held' ? 'hold' : r.status === 'confirmed' ? 'confirm' : r.status === 'on_hire' ? 'period_change' : 'return';
}

function fromReservation(ix: Index, r: Reservation, stage: Stage): BookingCtx | null {
  const p = reservationOccupied(r, ix.nowMs) ?? (ms(r.startAt) !== null ? { startMs: ms(r.startAt)!, endMs: ms(r.expectedEndAt) } : null);
  if (!p) return null;
  const unit = ix.units.get(r.fleetUnitId);
  const claim = ix.claims.get(r.claimId);
  const self = new Set<Id>([r.id]);
  if (r.hireAgreementId) self.add(r.hireAgreementId);
  for (const h of ix.w.hires) if (h.reservationId === r.id) self.add(h.id);
  const onHire = r.status === 'on_hire' || r.status === 'returned' || stage === 'return';
  return {
    kind: 'reservation',
    stage,
    ...(claim ? { claim } : {}),
    claimId: r.claimId,
    ...(unit ? { unit } : {}),
    fleetUnitId: r.fleetUnitId,
    ...(unit && ix.vehicles.get(unit.vehicleId) ? { vehicle: ix.vehicles.get(unit.vehicleId)! } : {}),
    use: r.use,
    startMs: p.startMs,
    endMs: p.endMs,
    hirerPartyId: r.hirerPartyId,
    driverPartyIds: r.driverPartyIds ?? [],
    reservation: r,
    self,
    ownRef: r.id,
    onHire,
    newBooking: !onHire,
  };
}

function fromHire(ix: Index, h: HireAgreement): BookingCtx | null {
  const p = hireOccupied(h, ix.nowMs);
  if (!p) return null;
  const unit = ix.units.get(h.fleetUnitId);
  const claim = ix.claims.get(h.claimId);
  const self = new Set<Id>([h.id]);
  if (h.reservationId) self.add(h.reservationId);
  for (const r of ix.w.reservations) if (r.hireAgreementId === h.id) self.add(r.id);
  const hirer = h.hirerPartyId ?? claim?.driverId ?? claim?.claimantId;
  return {
    kind: 'hire',
    stage: 'period_change',
    ...(claim ? { claim } : {}),
    claimId: h.claimId,
    ...(unit ? { unit } : {}),
    fleetUnitId: h.fleetUnitId,
    ...(unit && ix.vehicles.get(unit.vehicleId) ? { vehicle: ix.vehicles.get(unit.vehicleId)! } : {}),
    use: h.use ?? 'credit_hire',
    startMs: p.startMs,
    endMs: p.endMs,
    ...(hirer ? { hirerPartyId: hirer } : {}),
    driverPartyIds: h.driverPartyIds ?? h.additionalDrivers.map((d) => d.partyId),
    hire: h,
    self,
    ownRef: h.id,
    onHire: true,
    newBooking: false,
  };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

class Collector {
  constructor(
    private readonly kind: ClashSubjectKind,
    /** Shared between the outer run and its nested runs, so they dedupe together. */
    readonly out: Map<string, ClashFinding> = new Map(),
  ) {}

  applies(code: ClashCode, kind: ClashSubjectKind = this.kind): boolean {
    return CLASH_CATALOGUE[code].subjects.includes(kind);
  }

  add(
    code: ClashCode,
    message: string,
    attrs: { claimId?: Id; fleetUnitId?: Id; reservationId?: Id; hireId?: Id },
    own: Array<Id | undefined>,
    related: Partial<ClashFinding['related']> = {},
    data?: Record<string, unknown>,
    severity?: ClashSeverity,
  ): void {
    const def = CLASH_CATALOGUE[code];
    const rel: ClashFinding['related'] = {
      claimIds: uniq(related.claimIds),
      reservationIds: uniq(related.reservationIds),
      hireIds: uniq(related.hireIds),
      fleetUnitIds: uniq(related.fleetUnitIds),
      partyIds: uniq(related.partyIds),
    };
    const relatedIds = [...rel.claimIds, ...rel.reservationIds, ...rel.hireIds, ...rel.fleetUnitIds].sort();
    const dedupeKey = [code, ...own.filter((x): x is string => !!x), ...Array.from(new Set(relatedIds))].join(':');
    const f: ClashFinding = {
      code,
      severity: severity ?? def.severity,
      overrideClass: def.overrideClass,
      message,
      ...Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined)),
      related: rel,
      dedupeKey,
      ...(data ? { data } : {}),
    };
    const prev = this.out.get(dedupeKey);
    if (!prev || rank(f.severity) > rank(prev.severity)) this.out.set(dedupeKey, f);
  }
}

const uniq = (xs: Id[] | undefined): Id[] => Array.from(new Set((xs ?? []).filter(Boolean)));
const rank = (s: ClashSeverity): number => (s === 'block' ? 2 : s === 'warn' ? 1 : 0);

// ---------------------------------------------------------------------------
// Booking checks
// ---------------------------------------------------------------------------

function checkBooking(ix: Index, b: BookingCtx, col: Collector): void {
  const { settings } = ix.opts;
  const k = b.kind;
  const on = (code: ClashCode): boolean => col.applies(code, k);
  const base = {
    claimId: b.claimId,
    fleetUnitId: b.fleetUnitId,
    ...(b.reservation ? { reservationId: b.reservation.id } : {}),
    ...(b.hire ? { hireId: b.hire.id } : {}),
  };
  const own = [b.ownRef, b.kind === 'proposed_booking' ? b.fleetUnitId : undefined];
  const reg = ix.registration(b.unit);
  const startDay = dayOf(b.startMs);
  // Period end for whole-period checks: the expected end, or (open-ended) the default projection from now.
  const checkEndMs = b.endMs ?? Math.max(b.startMs, ix.nowMs) + settings.projection.defaultHireDays * DAY_MS;
  const endDay = dayOf(checkEndMs - 1);
  const unit = b.unit;
  const v = b.vehicle;
  const handover = b.stage === 'handover';

  // 1, 2 — the car's diary.
  if (unit) {
    const turnaround = (unit.turnaroundMinutes ?? settings.booking.turnaroundMinutes) * 60_000;
    for (const o of ix.occupancies) {
      if (o.fleetUnitId !== b.fleetUnitId || b.self.has(o.ref)) continue;
      const rel = { claimIds: o.claimId !== b.claimId ? [o.claimId] : [], reservationIds: o.kind === 'reservation' ? [o.ref] : [], hireIds: o.kind === 'hire' ? [o.ref] : [o.reservation?.hireAgreementId ?? ''] };
      if (overlaps(b.startMs, b.endMs, o.startMs, o.endMs)) {
        if (on('UNIT_DOUBLE_BOOKED')) {
          const sameClaim = o.claimId === b.claimId;
          const overrideAuditId = b.reservation?.overlapOverrideAuditId ?? o.reservation?.overlapOverrideAuditId;
          const what = o.kind === 'hire' || o.reservation?.status === 'on_hire' || o.reservation?.status === 'returned' ? 'on hire' : 'booked';
          col.add(
            'UNIT_DOUBLE_BOOKED',
            `${reg} is ${what} ${sameClaim ? 'on another booking for this claim' : 'for another claim'} from ${fmtDay(o.startMs)} to ${fmtDay(o.endMs)}, which overlaps this period (${fmtDay(b.startMs)} to ${fmtDay(b.endMs)}).`,
            base,
            own,
            rel,
            { otherStartMs: o.startMs, otherEndMs: o.endMs, ...(overrideAuditId ? { overrideAuditId } : {}) },
          );
        }
        continue;
      }
      if (on('TURNAROUND_SHORT') && turnaround > 0) {
        const gapBefore = o.endMs !== null && o.endMs <= b.startMs ? b.startMs - o.endMs : null;
        const gapAfter = b.endMs !== null && o.startMs >= b.endMs ? o.startMs - b.endMs : null;
        const gap = gapBefore !== null && gapBefore < turnaround ? gapBefore : gapAfter !== null && gapAfter < turnaround ? gapAfter : null;
        if (gap !== null)
          col.add(
            'TURNAROUND_SHORT',
            `Only ${Math.round(gap / 60_000)} minutes between ${gapBefore !== null && gap === gapBefore ? 'the previous return and this start' : 'this return and the next start'} of ${reg} (turnaround ${Math.round(turnaround / 60_000)} minutes).`,
            base,
            own,
            rel,
            { gapMinutes: Math.round(gap / 60_000), turnaroundMinutes: Math.round(turnaround / 60_000) },
          );
      }
    }
  }

  // 3–16 — the car itself.
  if (unit) {
    if (on('UNIT_NOT_READY') && !b.onHire) {
      const blocking = ix.w.readiness.filter((t) => t.fleetUnitId === unit.id && t.status === 'open' && t.blocksHire && (ms(t.readyByAt) === null || ms(t.readyByAt)! > b.startMs));
      const damage = ix.w.damage.filter((d) => d.fleetUnitId === unit.id && !d.repairedAt && (d.severity === 'major' || d.severity === 'unroadworthy') && (ms(d.foundAt) ?? 0) <= b.startMs).filter((d) => {
        const task = d.repairTaskId ? ix.w.readiness.find((t) => t.id === d.repairTaskId) : undefined;
        return !(task && (task.status === 'done' || (ms(task.readyByAt) !== null && ms(task.readyByAt)! <= b.startMs)));
      });
      if (blocking.length || damage.length) {
        const parts = [...blocking.map((t) => `${t.kind.replace(/_/g, ' ')} task${t.readyByAt ? ` (ready by ${fmtDay(ms(t.readyByAt))})` : ''}`), ...damage.map((d) => `unrepaired ${d.severity} damage (${d.panel})`)];
        col.add('UNIT_NOT_READY', `${reg} is not ready on ${fmtDay(b.startMs)}: ${parts.join('; ')}.`, base, own, {}, { taskIds: blocking.map((t) => t.id), damageIds: damage.map((d) => d.id) });
      }
    }
    if (on('UNIT_OFF_ROAD') && !b.onHire && unit.status === 'off_road') col.add('UNIT_OFF_ROAD', `${reg} is marked off the road.`, base, own);
    if (on('UNIT_DISPOSED') && unit.status === 'disposed') col.add('UNIT_DISPOSED', `${reg} has been disposed of.`, base, own);
    if (on('USE_NOT_DECLARED') && !unit.declaredUses.includes(b.use))
      col.add('USE_NOT_DECLARED', `Use "${useLabel(b.use)}" is not declared on ${reg} (declared: ${unit.declaredUses.map(useLabel).join(', ') || 'none'}).`, base, own, {}, { use: b.use, declaredUses: unit.declaredUses });

    // 7, 8 — insurance over the whole period.
    const chain = ix.policyChain(unit);
    const atDay = b.onHire ? dayOf(Math.max(b.startMs, Math.min(ix.nowMs, checkEndMs - 1))) : startDay;
    const inForce = chain.find((p) => p.startDate <= atDay && atDay <= p.endDate);
    if (on('POLICY_NOT_IN_FORCE')) {
      if (!chain.length) col.add('POLICY_NOT_IN_FORCE', `No insurance policy is linked to ${reg}.`, base, own);
      else if (!inForce) col.add('POLICY_NOT_IN_FORCE', `No policy on ${reg} is in force on ${fmtIsoDay(atDay)}.`, base, own, {}, { policyIds: chain.map((p) => p.id) });
      else if (!inForce.coveredUses.includes(b.use))
        col.add('POLICY_NOT_IN_FORCE', `Policy ${inForce.policyNumber} (${inForce.insurerName}) covers ${inForce.coveredUses.map(useLabel).join(', ') || 'no uses'}, not ${useLabel(b.use)}.`, base, own, {}, { policyId: inForce.id });
    }
    if (on('POLICY_ENDS_IN_PERIOD') && inForce && inForce.coveredUses.includes(b.use)) {
      let cur = inForce;
      const seen = new Set<Id>([cur.id]);
      for (;;) {
        const nextDay = addDays(cur.endDate, 1);
        const next = chain.find((p) => !seen.has(p.id) && p.coveredUses.includes(b.use) && p.startDate <= nextDay && p.endDate > cur.endDate);
        if (!next) break;
        seen.add(next.id);
        cur = next;
      }
      if (cur.endDate < endDay)
        col.add('POLICY_ENDS_IN_PERIOD', `${reg} would be uninsured after ${fmtIsoDay(cur.endDate)}: cover ends before the expected end (${fmtIsoDay(endDay)}) and no renewal policy is recorded.`, base, own, {}, { policyId: cur.id, coverEndsOn: cur.endDate, periodEndsOn: endDay });
    }

    if (v) {
      const mot = v.motExpiryDate?.slice(0, 10);
      const motInvalidAtStart = mot ? mot < startDay : !!(v.motStatus && /not valid|expired/i.test(v.motStatus));
      if (on('MOT_INVALID_AT_START') && !b.onHire && motInvalidAtStart) col.add('MOT_INVALID_AT_START', mot ? `${reg}'s MOT expired on ${fmtIsoDay(mot)}.` : `${reg}'s MOT status is "${v.motStatus}".`, base, own, {}, mot ? { motExpiryDate: mot } : {});
      if (on('MOT_LAPSES_IN_PERIOD') && mot && mot >= startDay && mot < endDay)
        col.add('MOT_LAPSES_IN_PERIOD', `${reg}'s MOT expires on ${fmtIsoDay(mot)}, during the hire: book the test before then.`, base, own, {}, { motExpiryDate: mot });
      const tax = v.taxDueDate?.slice(0, 10);
      const untaxedStatus = !!(v.taxStatus && /untaxed|sorn/i.test(v.taxStatus));
      if (on('TAX_INVALID_AT_START') && !b.onHire && (untaxedStatus || (tax !== undefined && tax < startDay)))
        col.add('TAX_INVALID_AT_START', untaxedStatus ? `${reg}'s tax status is "${v.taxStatus}".` : `${reg}'s vehicle tax expired on ${fmtIsoDay(tax!)}.`, base, own);
      if (on('TAX_LAPSES_IN_PERIOD') && !untaxedStatus && tax && tax >= startDay && tax < endDay)
        col.add('TAX_LAPSES_IN_PERIOD', `${reg}'s vehicle tax is due on ${fmtIsoDay(tax)}, during the hire.`, base, own, {}, { taxDueDate: tax });
    }
    if (on('SERVICE_DUE_IN_PERIOD')) {
      const svc = unit.serviceDueDate?.slice(0, 10);
      const days = Math.max(1, Math.ceil((checkEndMs - b.startMs) / DAY_MS));
      const remaining = unit.serviceDueMiles !== undefined && unit.currentMileage !== undefined ? unit.serviceDueMiles - unit.currentMileage : null;
      if (svc && svc < endDay) col.add('SERVICE_DUE_IN_PERIOD', svc < startDay ? `${reg}'s service was due on ${fmtIsoDay(svc)} (overdue).` : `${reg}'s service is due on ${fmtIsoDay(svc)}, during the hire.`, base, own, {}, { serviceDueDate: svc });
      else if (remaining !== null && remaining <= days * 50)
        col.add('SERVICE_DUE_IN_PERIOD', `${reg}'s service is due in about ${Math.max(0, remaining)} miles, which a ${days}-day hire is likely to reach.`, base, own, {}, { milesRemaining: remaining });
    }
    if (on('PHV_LICENCE') && b.use === 'pco') {
      const exp = unit.phvLicenceExpiry?.slice(0, 10);
      if (!unit.phvLicensed) col.add('PHV_LICENCE', `${reg} is not PHV licensed: it cannot go out for PCO work.`, base, own);
      else if (exp && exp < endDay) col.add('PHV_LICENCE', `${reg}'s PHV vehicle licence expires on ${fmtIsoDay(exp)}, before the end of the hire.`, base, own, {}, { phvLicenceExpiry: exp });
    }
    if (on('KEEPER_ADDRESS_STALE') && !unit.keeperAddressCurrent) col.add('KEEPER_ADDRESS_STALE', `${reg}'s V5C keeper address is not current: penalty notices for this hire will go to the old address.`, base, own);
    if (on('OPEN_PENALTY_ON_UNIT')) {
      const open = ix.w.penalties.filter((p) => p.fleetUnitId === unit.id && p.stage !== 'paid' && p.stage !== 'cancelled' && p.responseDeadline.slice(0, 10) >= startDay && p.responseDeadline.slice(0, 10) <= endDay);
      if (open.length) col.add('OPEN_PENALTY_ON_UNIT', `${open.length} open penalty notice${open.length === 1 ? '' : 's'} on ${reg} with a deadline during the hire (first ${fmtIsoDay(open.map((p) => p.responseDeadline).sort()[0]!)}).`, base, own, {}, { penaltyIds: open.map((p) => p.id) });
    }
  }

  const claim = b.claim;
  if (claim) {
    // 17 — the car is this claim's own vehicle.
    if (on('UNIT_IS_CLAIM_VEHICLE') && unit) {
      const own17 = ix.claimVehicles(claim).some((cv) => cv.id === unit.vehicleId || (v && vehicleMatch(cv, v)));
      if (own17) col.add('UNIT_IS_CLAIM_VEHICLE', `${reg} is this claim's own client or third-party vehicle.`, base, own);
    }
    // 19, 20, 38, 39 — claim-level codes that also run for a booking.
    claimCodes(ix, claim, col, k, { startMs: b.startMs, endMs: b.endMs });

    // 23 — this claim already has a car for the period.
    if (on('CLAIM_SECOND_HIRE')) {
      for (const o of ix.occupancies) {
        if (o.claimId !== claim.id || b.self.has(o.ref)) continue;
        if (o.reservation && !(LIVE_STATUSES as readonly string[]).includes(o.reservation.status)) continue;
        if (o.hire && o.hire.endAt) continue;
        if (!overlaps(b.startMs, b.endMs, o.startMs, o.endMs)) continue;
        if (o.fleetUnitId === b.fleetUnitId && on('UNIT_DOUBLE_BOOKED')) continue; // same car: reported as UNIT_DOUBLE_BOOKED
        col.add('CLAIM_SECOND_HIRE', `This claim already has another car ${o.hire || o.reservation?.status === 'on_hire' ? 'on hire' : 'booked'} from ${fmtDay(o.startMs)} to ${fmtDay(o.endMs)} (a swap uses touching periods).`, base, own, { reservationIds: o.kind === 'reservation' ? [o.ref] : [], hireIds: o.kind === 'hire' ? [o.ref] : [], fleetUnitIds: [o.fleetUnitId] });
      }
    }

    // 24, 25 — the same person on another claim's hire.
    if (on('HIRER_ON_OTHER_HIRE') || on('DRIVER_ON_OTHER_HIRE')) {
      const hirer = b.hirerPartyId ? ix.parties.get(b.hirerPartyId) : undefined;
      const extra = b.driverPartyIds.filter((id) => id !== b.hirerPartyId).map((id) => ix.parties.get(id)).filter((p): p is Party => !!p);
      for (const o of ix.occupancies) {
        if (o.claimId === claim.id || b.self.has(o.ref)) continue;
        if (!overlaps(b.startMs, b.endMs, o.startMs, o.endMs)) continue;
        const theirs = [o.hirerPartyId, ...o.driverPartyIds].filter((x): x is Id => !!x).map((id) => ix.parties.get(id)).filter((p): p is Party => !!p);
        const rel = { claimIds: [o.claimId], reservationIds: o.kind === 'reservation' ? [o.ref] : [], hireIds: o.kind === 'hire' ? [o.ref] : [] };
        const oHirer = o.hirerPartyId ? ix.parties.get(o.hirerPartyId) : undefined;
        if (on('HIRER_ON_OTHER_HIRE') && hirer && oHirer && samePerson(hirer, oHirer, profilesOf(ix, hirer, oHirer)))
          col.add('HIRER_ON_OTHER_HIRE', `The hirer already has a car on another claim from ${fmtDay(o.startMs)} to ${fmtDay(o.endMs)}.`, base, own, { ...rel, partyIds: [hirer.id] });
        if (on('DRIVER_ON_OTHER_HIRE'))
          for (const d of extra)
            if (theirs.some((t) => samePerson(d, t, profilesOf(ix, d, t))))
              col.add('DRIVER_ON_OTHER_HIRE', `An additional driver is also named on another hire from ${fmtDay(o.startMs)} to ${fmtDay(o.endMs)}.`, base, [...own, d.id], { ...rel, partyIds: [d.id] });
      }
    }

    // 26, 27 — driver eligibility against the car's policy criteria.
    if ((on('DRIVER_INELIGIBLE') || on('DRIVER_REFERRAL')) && !b.onHire) {
      const chain = unit ? ix.policyChain(unit) : [];
      const policy = chain.find((p) => p.startDate <= startDay && startDay <= p.endDate) ?? (unit?.policyId ? ix.policies.get(unit.policyId) : undefined);
      const criteria = policy?.driverCriteria ?? settings.eligibility.defaultCriteria;
      for (const pid of uniq([b.hirerPartyId ?? '', ...b.driverPartyIds])) {
        const party = ix.parties.get(pid);
        if (!party) continue;
        const e = assessDriver(ix.profiles.get(pid), party, criteria, startDay);
        const who = pid === b.hirerPartyId ? 'The main driver' : 'An additional driver';
        const why = e.reasons.filter((r) => r.outcome === e.outcome).map((r) => r.message).join(' ');
        const data = { partyId: pid, outcome: e.outcome, reasons: e.reasons, criteriaSource: policy?.driverCriteria ? 'policy' : 'settings_default', ...(policy ? { policyId: policy.id } : {}) };
        if (e.outcome === 'ineligible' && on('DRIVER_INELIGIBLE')) col.add('DRIVER_INELIGIBLE', `${who} is not eligible under the ${policy?.driverCriteria ? "car's policy" : 'default'} criteria: ${why}`, base, [...own, pid], { partyIds: [pid] }, data);
        if (e.outcome === 'refer' && on('DRIVER_REFERRAL')) col.add('DRIVER_REFERRAL', `${who} needs referral to the fleet insurer: ${why}`, base, [...own, pid], { partyIds: [pid] }, data);
      }
    }

    // 28 — licence check at handover.
    if (on('LICENCE_CHECK_STALE') && handover) {
      const unitPolicy = unit?.policyId ? ix.policies.get(unit.policyId) : undefined;
      const maxDays = Math.min(unitPolicy?.driverCriteria?.requireDvlaCheckWithinDays ?? settings.eligibility.defaultCriteria.requireDvlaCheckWithinDays, settings.signing.dvlaCheckMaxAgeDays);
      for (const pid of uniq([b.hirerPartyId ?? '', ...b.driverPartyIds])) {
        const check = ix.profiles.get(pid)?.dvlaCheck;
        const who = pid === b.hirerPartyId ? 'the main driver' : 'an additional driver';
        const at = ms(check?.checkedAt);
        if (!check || at === null) col.add('LICENCE_CHECK_STALE', `No licence check is recorded for ${who}: record the DVLA check (date and summary) before handover.`, base, [...own, pid], { partyIds: [pid] }, { partyId: pid, maxAgeDays: maxDays });
        else if (ix.nowMs - at > maxDays * DAY_MS)
          col.add('LICENCE_CHECK_STALE', `The DVLA check for ${who} is from ${fmtDay(at)}, older than ${maxDays} days.`, base, [...own, pid], { partyIds: [pid] }, { partyId: pid, checkedAt: check.checkedAt, maxAgeDays: maxDays });
      }
    }

    // 29, 30 — start against the accident and the services agreement.
    const accidentMs = ms(claim.accident?.occurredAt);
    if (on('HIRE_BEFORE_ACCIDENT') && accidentMs !== null && b.startMs < accidentMs)
      col.add('HIRE_BEFORE_ACCIDENT', `The hire start (${fmtDay(b.startMs)}) is before the accident (${fmtDay(accidentMs)}).`, base, own, {}, { accidentAt: claim.accident.occurredAt }, b.newBooking ? 'block' : 'warn');
    if (on('HIRE_BEFORE_SERVICES')) {
      const events = ix.w.eventsByClaim[claim.id] ?? [];
      const earliest = (t: string): number | null => events.filter((e) => e.type === t).map((e) => ms(e.at)).filter((x): x is number => x !== null).sort((a, z) => a - z)[0] ?? null;
      const services = earliest('services_agreed');
      const ref = services ?? earliest('fnol') ?? ms(claim.openedAt);
      if (ref !== null && dayOf(b.startMs) < dayOf(ref))
        col.add('HIRE_BEFORE_SERVICES', `The hire start (${fmtDay(b.startMs)}) is before ${services !== null ? 'the services were agreed' : 'the first notification'} (${fmtDay(ref)}).`, base, own);
    }

    // 31 — off-hire deadline.
    if (on('HIRE_PAST_OFFHIRE')) {
      const events = ix.w.eventsByClaim[claim.id] ?? [];
      let deadline: { ms: number; basis: string; trigger: HireEndTrigger } | null = null;
      for (const e of events) {
        const trig = OFF_HIRE_EVENTS[e.type];
        const at = ms(e.at);
        if (!trig || at === null || at < b.startMs) continue;
        const d = offHireDeadline(trig, e.at);
        const dms = ms(d.dueAt);
        if (dms !== null && (!deadline || dms < deadline.ms)) deadline = { ms: dms, basis: d.basis, trigger: trig };
      }
      const endRef = ms(b.hire?.endAt) ?? ms(b.reservation?.endAt) ?? ms(b.reservation?.expectedEndAt ?? b.hire?.expectedEndAt) ?? (b.onHire ? ix.nowMs : null);
      if (deadline && endRef !== null && endRef > deadline.ms)
        col.add('HIRE_PAST_OFFHIRE', `The hire ${b.hire?.endAt || b.reservation?.endAt ? 'ended' : 'runs'} after the off-hire deadline of ${fmtDay(deadline.ms)} (${deadline.basis}); the days beyond are unlikely to be recovered.`, base, own, {}, { deadline: new Date(deadline.ms).toISOString(), trigger: deadline.trigger });
    }

    // 33–35 — the claim allows hire.
    if (on('CLAIM_STATUS_NO_HIRE') && FINAL_CLAIM_STATUSES.includes(claim.status)) col.add('CLAIM_STATUS_NO_HIRE', `This claim is ${claim.status}: no hire can be booked or continued on it.`, base, own);
    if (on('ACCEPTANCE_CONDITIONS_UNMET') && !b.onHire) {
      const acc = ix.w.acceptanceByClaim[claim.id];
      if (acc) {
        const gating = acc.conditions.filter((c) => /no hire until/i.test(c) || (settings.eligibility.requireMeansBeforeOffer && /statement of means/i.test(c)));
        if (acc.decision === 'decline') col.add('ACCEPTANCE_CONDITIONS_UNMET', `The acceptance decision for this claim is decline: ${acc.reasons.slice(0, 2).join(' ') || 'see the acceptance assessment'}.`, base, own, {}, { decision: acc.decision });
        else if (gating.length) col.add('ACCEPTANCE_CONDITIONS_UNMET', `An acceptance condition is not met: ${gating.join('; ')}.`, base, own, {}, { decision: acc.decision, conditions: gating });
      }
    }
    if (on('HARD_STOP_FLAG') && !b.onHire) {
      const blocks = (claim.flags ?? []).filter((f) => f.severity === 'block' && !f.clearedAt);
      if (blocks.length) col.add('HARD_STOP_FLAG', `This claim has an uncleared hard stop: ${blocks.map((f) => f.message.trim()).join(' ')}`, base, own, {}, { flags: blocks.map((f) => f.code) });
    }

    // 37 — group above like for like (benchmark rates, never codes).
    if (on('GROUP_ABOVE_LFL') && !b.onHire && !b.reservation?.substitutionReason) {
      const relation = groupRelation(ix, b, claim);
      if (relation === 'higher')
        col.add('GROUP_ABOVE_LFL', `${reg} is in a higher hire group than the client's own car and no substitution reason is recorded: it will be priced at the like-for-like guide.`, base, own);
    }
  }

  // 32 — overdue back.
  if (on('RETURN_OVERDUE')) {
    const overdue = b.reservation ? b.reservation.status === 'on_hire' && ms(b.reservation.expectedEndAt) !== null && ms(b.reservation.expectedEndAt)! < ix.nowMs : b.hire ? !b.hire.endAt && ms(b.hire.expectedEndAt) !== null && ms(b.hire.expectedEndAt)! < ix.nowMs : false;
    if (overdue) {
      const exp = ms(b.reservation?.expectedEndAt ?? b.hire?.expectedEndAt)!;
      col.add('RETURN_OVERDUE', `${reg} was expected back on ${fmtDay(exp)} and has not been returned.`, base, own, {}, { expectedEndAt: new Date(exp).toISOString() });
    }
  }

  // 36 — paperwork at handover.
  if (on('SIGNATURES_MISSING') && handover && b.reservation) {
    const pack = ix.w.signedPackByReservation[b.reservation.id];
    if (!pack || !pack.signed) col.add('SIGNATURES_MISSING', `The hire paperwork is not signed: ${pack?.missing.length ? pack.missing.join(', ') : 'hire agreement, Sch 3 cancellation form and express request to start'}. An unsigned hire is unenforceable (W v Veolia).`, base, own, {}, { missing: pack?.missing ?? [] });
  }

  // 42, 43 — deliveries.
  if (b.reservation && ix.w.movements && unit) {
    const mine = ix.w.movements.filter((m) => m.reservationId === b.reservation!.id && (m.status === 'planned' || m.status === 'confirmed'));
    if (on('DELIVERY_BEFORE_READY')) {
      const readyAt = unitReadyAt(ix, unit.id);
      for (const m of mine.filter((x) => x.kind === 'delivery' || x.kind === 'swap_out')) {
        const ws = ms(m.windowStart);
        if (ws !== null && readyAt !== null && ws < readyAt)
          col.add('DELIVERY_BEFORE_READY', `The delivery window (${fmtDay(ws)}) starts before ${reg} is ready${Number.isFinite(readyAt) ? ` (${fmtDay(readyAt)})` : ''}.`, { ...base }, [...own, m.id], {}, { movementId: m.id });
      }
    }
    if (on('DELIVERY_CAPACITY')) {
      for (const m of mine) {
        const s = ms(m.windowStart);
        const e = ms(m.windowEnd);
        if (s === null || e === null) continue;
        const n = ix.w.movements.filter((x) => x.status !== 'cancelled' && x.status !== 'failed' && overlaps(s, e, ms(x.windowStart) ?? 0, ms(x.windowEnd) ?? 0)).length;
        if (n > settings.booking.maxPerWindow)
          col.add('DELIVERY_CAPACITY', `${n} deliveries and collections share the window starting ${fmtDay(s)} (maximum ${settings.booking.maxPerWindow}).`, base, [...own, m.id], {}, { movementId: m.id, count: n });
      }
    }
  }

  // 44 — expired hold.
  if (on('HOLD_EXPIRED') && b.reservation?.status === 'held' && (b.stage === 'hold' || b.stage === 'confirm' || b.stage === 'handover')) {
    const exp = ms(b.reservation.holdExpiresAt);
    if (exp !== null && exp <= ix.nowMs) col.add('HOLD_EXPIRED', `The hold on ${reg} expired on ${fmtDay(exp)}: hold the car again instead.`, base, own, {}, { holdExpiresAt: b.reservation.holdExpiresAt });
  }
}

function profilesOf(ix: Index, a: Party, b: Party): { a?: DriverProfile; b?: DriverProfile } {
  const pa = ix.profiles.get(a.id);
  const pb = ix.profiles.get(b.id);
  return { ...(pa ? { a: pa } : {}), ...(pb ? { b: pb } : {}) };
}

/** When the car is next ready: null = ready now; Infinity = not ready with no date. */
function unitReadyAt(ix: Index, unitId: Id): number | null {
  let readyAt: number | null = null;
  for (const t of ix.w.readiness) {
    if (t.fleetUnitId !== unitId || t.status !== 'open' || !t.blocksHire) continue;
    const r = ms(t.readyByAt);
    readyAt = Math.max(readyAt ?? -Infinity, r ?? Infinity);
  }
  for (const d of ix.w.damage) {
    if (d.fleetUnitId !== unitId || d.repairedAt || (d.severity !== 'major' && d.severity !== 'unroadworthy')) continue;
    const task = d.repairTaskId ? ix.w.readiness.find((t) => t.id === d.repairTaskId) : undefined;
    if (task?.status === 'done') continue;
    readyAt = Math.max(readyAt ?? -Infinity, ms(task?.readyByAt) ?? Infinity);
  }
  if (ix.units.get(unitId)?.status === 'off_road') readyAt = Infinity;
  return readyAt;
}

function groupRelation(ix: Index, b: BookingCtx, claim: Claim): 'same' | 'lower' | 'higher' | 'unknown' {
  const ranked = b.reservation?.ranking?.likeForLike?.group?.relation;
  if (ranked) return ranked;
  const clientGroup = b.reservation?.clientGtaGroup ?? ix.vehicles.get(claim.clientVehicleId)?.gtaGroup;
  const carGroup = b.reservation?.gtaGroup ?? b.unit?.gtaGroup;
  if (!clientGroup || !carGroup) return 'unknown';
  if (clientGroup.trim().toUpperCase() === carGroup.trim().toUpperCase()) return 'same';
  if (!ix.w.gtaRates?.length) return 'unknown';
  const at = new Date(b.startMs).toISOString();
  const cr = gtaRate(clientGroup, at, ix.w.gtaRates)?.dailyRatePence;
  const ur = gtaRate(carGroup, at, ix.w.gtaRates)?.dailyRatePence;
  if (cr === undefined || ur === undefined) return 'unknown';
  return ur > cr ? 'higher' : ur < cr ? 'lower' : 'same';
}

function useLabel(u: FleetUse): string {
  return u === 'credit_hire' ? 'credit hire' : u === 'self_drive' ? 'self drive' : 'PCO';
}

// ---------------------------------------------------------------------------
// Claim-level checks
// ---------------------------------------------------------------------------

function claimCodes(ix: Index, claim: Claim, col: Collector, kind: ClashSubjectKind, period: { startMs: number; endMs: number | null } | null): void {
  const { settings } = ix.opts;
  const on = (code: ClashCode): boolean => col.applies(code, kind);
  const base = { claimId: claim.id };
  const clientVehicle = ix.vehicles.get(claim.clientVehicleId);
  const claimOpen = !FINAL_CLAIM_STATUSES.includes(claim.status);
  const accidentMs = ms(claim.accident?.occurredAt);

  // 18 — a fleet registration recorded as a claim vehicle.
  if (on('FLEET_REG_AS_CLAIM_VEHICLE')) {
    for (const cv of ix.claimVehicles(claim)) {
      const unit = ix.w.fleetUnits.find((u) => {
        const uv = ix.vehicles.get(u.vehicleId);
        return u.vehicleId === cv.id || (uv && vehicleMatch(uv, cv));
      });
      if (unit || cv.ownership === 'fleet') {
        const which = cv.id === claim.clientVehicleId ? 'client' : 'third-party';
        col.add('FLEET_REG_AS_CLAIM_VEHICLE', `${formatRegistration(cv.registration)} is a fleet car but is recorded as the ${which} vehicle on this claim: use "Record an incident on hire" instead.`, { ...base, ...(unit ? { fleetUnitId: unit.id } : {}) }, [claim.id, unit?.id ?? cv.id]);
      }
    }
  }

  if (clientVehicle) {
    const display = formatRegistration(clientVehicle.registration);
    for (const other of ix.w.claims) {
      if (other.id === claim.id) continue;
      const otherClient = ix.vehicles.get(other.clientVehicleId);
      const otherTp = other.thirdPartyVehicleId ? ix.vehicles.get(other.thirdPartyVehicleId) : undefined;
      const clientHit = otherClient ? vehicleMatch(clientVehicle, otherClient) : null;
      const otherOpen = !FINAL_CLAIM_STATUSES.includes(other.status);
      const otherAccident = ms(other.accident?.occurredAt);
      const within = accidentMs !== null && otherAccident !== null && Math.abs(accidentMs - otherAccident) <= settings.eligibility.duplicateClaimWindowDays * DAY_MS;

      // 19 — the client's car has a hire on another claim.
      if (on('SAME_REG_ON_HIRE') && clientHit) {
        const live = ix.occupancies.filter((o) => o.claimId === other.id && ((o.reservation && (LIVE_STATUSES as readonly string[]).includes(o.reservation.status)) || (o.hire && !o.hire.endAt) || (period && overlaps(period.startMs, period.endMs, o.startMs, o.endMs))));
        if (live.length)
          col.add(
            'SAME_REG_ON_HIRE',
            `The client's car ${display} is the client vehicle on another claim that already has a hire or booking: possible double hire for one accident.`,
            base,
            [claim.id],
            { claimIds: [other.id], reservationIds: live.filter((o) => o.kind === 'reservation').map((o) => o.ref), hireIds: live.filter((o) => o.kind === 'hire').map((o) => o.ref) },
            { match: clientHit },
          );
      }
      // 20 — duplicate open claim.
      const dupOpen = !!clientHit && claimOpen && otherOpen && within;
      if (on('DUPLICATE_CLAIM_OPEN') && dupOpen)
        col.add('DUPLICATE_CLAIM_OPEN', `The client's car ${display} is on another open claim with an accident within ${settings.eligibility.duplicateClaimWindowDays} days: double recovery risk.`, base, [claim.id], { claimIds: [other.id] }, { match: clientHit });
      // 21 — same registration otherwise.
      const regHit = (otherClient && vehicleMatch(clientVehicle, otherClient) === 'registration') || (otherTp && vehicleMatch(clientVehicle, otherTp) === 'registration');
      if (on('DUPLICATE_REGISTRATION') && regHit && !dupOpen)
        col.add('DUPLICATE_REGISTRATION', `${display} is also on another claim (a linked but separate file).`, base, [claim.id], { claimIds: [other.id] });
      // 22 — same VIN, different registration.
      if (on('VIN_REG_MISMATCH') && clientVehicle.vin) {
        const vinHit = [otherClient, otherTp].find((ov) => ov && vehicleMatch(clientVehicle, ov) === 'vin' && ov.registration && clientVehicle.registration && ov.registration.toUpperCase().replace(/[^A-Z0-9]/g, '') !== clientVehicle.registration.toUpperCase().replace(/[^A-Z0-9]/g, ''));
        if (vinHit) col.add('VIN_REG_MISMATCH', `The VIN of ${display} is on another claim under a different registration (cherished plate?).`, base, [claim.id], { claimIds: [other.id] });
      }
    }
  }

  // 38 — weak need.
  if (on('NEED_WEAK') && ix.w.needsByClaim && claim.id in ix.w.needsByClaim) {
    const n = needLevel(ix.w.needsByClaim[claim.id]);
    if (n.level === 'weak' || n.level === 'none')
      col.add('NEED_WEAK', `The need for a car is ${n.level}: ${[...n.reasons, ...n.mitigationRisks].join(' ')} Hire may be challenged.`, base, [claim.id], {}, { level: n.level });
  }
  // 39 — unanswered intervention offers.
  if (on('INTERVENTION_UNANSWERED')) {
    const open = ix.w.interventionOffers.filter((o) => o.claimId === claim.id && !o.replySentAt);
    if (open.length) col.add('INTERVENTION_UNANSWERED', `${open.length} insurer intervention offer${open.length === 1 ? ' has' : 's have'} no written reply yet (reply within 1 working day).`, base, [claim.id], {}, { offerIds: open.map((o) => o.id) });
  }
  // 40 — client's car on the accident date.
  if (on('CLIENT_CAR_NOT_LEGAL') && clientVehicle && claim.accident?.occurredAt) {
    const s = clientCarOnDate(clientVehicle, claim.accident.occurredAt);
    const parts = [s.mot === 'expired' ? 'no valid MOT' : null, s.tax === 'untaxed' ? 'no vehicle tax' : null].filter(Boolean);
    if (parts.length) col.add('CLIENT_CAR_NOT_LEGAL', `The client's car had ${parts.join(' and ')} on the accident date.`, base, [claim.id], {}, s);
  }
  // 41 — injury not referred.
  if (on('INJURY_NOT_REFERRED') && claim.accident?.injuries === true && !claim.injuryReferral)
    col.add('INJURY_NOT_REFERRED', 'Personal injury is on file and has not been referred to a solicitor (no referral fee — LASPO 2012 ss.56–60). Hire is not affected.', base, [claim.id]);
}

function unitCodes(ix: Index, unit: FleetUnit, col: Collector): void {
  if (!col.applies('FLEET_REG_AS_CLAIM_VEHICLE', 'fleet_unit')) return;
  const uv = ix.vehicles.get(unit.vehicleId);
  for (const c of ix.w.claims) {
    const hit = ix.claimVehicles(c).find((cv) => cv.id === unit.vehicleId || (uv && vehicleMatch(uv, cv)));
    if (!hit) continue;
    const which = hit.id === c.clientVehicleId ? 'client' : 'third-party';
    col.add('FLEET_REG_AS_CLAIM_VEHICLE', `${formatRegistration(hit.registration)} is a fleet car but is recorded as the ${which} vehicle on a claim: use "Record an incident on hire" instead.`, { claimId: c.id, fleetUnitId: unit.id }, [c.id, unit.id]);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function detectClashes(subject: ClashSubject, world: ClashWorld, opts: { now: ISODateTime; settings: AutopilotSettings }): ClashFinding[] {
  const ix = new Index(world, opts);
  const col = new Collector(subject.kind);
  const nested = (k: ClashSubjectKind): Collector => new Collector(k, col.out);

  switch (subject.kind) {
    case 'proposed_booking': {
      const s = ms(subject.startAt);
      if (s === null) return [];
      const unit = ix.units.get(subject.fleetUnitId);
      const claim = ix.claims.get(subject.claimId);
      const self = new Set<Id>();
      if (subject.excludeReservationId) {
        self.add(subject.excludeReservationId);
        const r = world.reservations.find((x) => x.id === subject.excludeReservationId);
        if (r?.hireAgreementId) self.add(r.hireAgreementId);
      }
      checkBooking(
        ix,
        {
          kind: 'proposed_booking',
          stage: subject.stage,
          ...(claim ? { claim } : {}),
          claimId: subject.claimId,
          ...(unit ? { unit } : {}),
          fleetUnitId: subject.fleetUnitId,
          ...(unit && ix.vehicles.get(unit.vehicleId) ? { vehicle: ix.vehicles.get(unit.vehicleId)! } : {}),
          use: subject.use,
          startMs: s,
          endMs: ms(subject.expectedEndAt),
          hirerPartyId: subject.hirerPartyId,
          driverPartyIds: subject.driverPartyIds,
          self,
          ownRef: subject.claimId,
          onHire: false,
          newBooking: true,
        },
        col,
      );
      break;
    }
    case 'reservation': {
      const r = world.reservations.find((x) => x.id === subject.reservationId);
      const b = r ? fromReservation(ix, r, subject.stage) : null;
      if (b) checkBooking(ix, b, col);
      break;
    }
    case 'hire': {
      const h = world.hires.find((x) => x.id === subject.hireId);
      const b = h ? fromHire(ix, h) : null;
      if (b) checkBooking(ix, b, col);
      break;
    }
    case 'claim': {
      const claim = ix.claims.get(subject.claimId);
      if (!claim) return [];
      claimCodes(ix, claim, col, 'claim', null);
      runLive(ix, (r) => r.claimId === claim.id, (h) => h.claimId === claim.id, nested);
      break;
    }
    case 'fleet_unit': {
      const unit = ix.units.get(subject.fleetUnitId);
      if (!unit) return [];
      unitCodes(ix, unit, col);
      runLive(ix, (r) => r.fleetUnitId === unit.id, (h) => h.fleetUnitId === unit.id, nested);
      break;
    }
  }
  return [...col.out.values()];
}

/** Every live reservation (natural stage) and open hire without a live reservation, matching the filters. */
function runLive(ix: Index, rf: (r: Reservation) => boolean, hf: (h: HireAgreement) => boolean, nested: (k: ClashSubjectKind) => Collector): void {
  const covered = new Set<Id>();
  for (const r of ix.w.reservations) {
    if (!rf(r) || !(LIVE_STATUSES as readonly string[]).includes(r.status)) continue;
    const b = fromReservation(ix, r, naturalStage(r));
    if (!b) continue;
    for (const id of b.self) covered.add(id);
    checkBooking(ix, b, nested('reservation'));
  }
  for (const h of ix.w.hires) {
    if (!hf(h) || h.endAt || covered.has(h.id)) continue;
    const b = fromHire(ix, h);
    if (b) checkBooking(ix, b, nested('hire'));
  }
}
