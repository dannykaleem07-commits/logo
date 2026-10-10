// owned by ap-autopilot
/**
 * Predicates, requirements and date facts over AutopilotFacts (docs/SUPREME-AUTOPILOT.md §A.4). Pure one-liners; the
 * step catalogue refers to them by id and the integrity test fails on an unknown id.
 *
 * Generated families: `event.<type>` (an event of that type exists), `playbook.<CODE>` (the playbook raises the code
 * now), `pack.<stage>.{exists,approved,sent,signed}`. The five pack predicates of §D.6 (PACK_PREDICATE_IDS) are here
 * too, with the same meaning as the paperwork slice's fallback evaluator.
 */
import { addWorkingDays } from '../calendar/calendar.js';
import { offHireDeadline } from '../gta/hire.js';
import { playbookRuleCodes } from '../playbook/rules.js';
import { PACK_STAGES, type PackStage } from '../signing/types.js';
import type { ClaimStatus, EventType, HireEndTrigger, ISODateTime } from '../types.js';
import { activeReservation, currentHire, currentOffer, firstEvent, lastEvent, liveReservation, movementsOf, msOf, packOf, type AutopilotFacts } from './facts.js';
import type { PredicateId, RequirementId, StageId, TerminalStage } from './types.js';

export type Predicate = (f: AutopilotFacts) => boolean;

const DAY = 86_400_000;

/** Claim-level clash codes the cross-file check (intake.cross_file) clears. */
export const CROSS_FILE_CLASH_CODES = ['DUPLICATE_CLAIM_OPEN', 'SAME_REG_ON_HIRE', 'DUPLICATE_REGISTRATION', 'VIN_REG_MISMATCH', 'FLEET_REG_AS_CLAIM_VEHICLE', 'HARD_STOP_FLAG', 'HIRER_ON_OTHER_HIRE', 'DRIVER_ON_OTHER_HIRE'] as const;

/** Every chronology event type a predicate may test (`event.<type>`). */
export const PREDICATE_EVENT_TYPES: readonly EventType[] = [
  'fnol', 'services_agreed', 'ncaf_sent', 'handling_ref_received', 'engineer_instructed', 'inspection', 'report_issued', 'estimate_received', 'repair_authorised',
  'repair_started', 'repair_delay', 'repair_completed', 'vehicle_returned', 'hire_started', 'hire_ended', 'storage_started', 'storage_ended', 'recovery',
  'collect_or_pay_notice_sent', 'total_loss_confirmed', 'tl_payment_received', 'cash_in_lieu_received', 'insurer_termination_notice', 'intervention_offer',
  'intervention_reply_sent', 'settlement_offer_received', 'payment_pack_sent', 'payment_received', 'chaser_sent', 'complaint_sent', 'cctv_request_sent',
  'hire_offered', 'hire_offer_accepted', 'hire_offer_declined', 'booking_confirmed', 'booking_cancelled', 'hire_vehicle_delivered', 'hire_vehicle_collected',
  'hire_start_notice_sent', 'documents_signed',
];

const has = (f: AutopilotFacts, type: EventType): boolean => f.bundle.events.some((e) => e.type === type);
const playbookHas = (f: AutopilotFacts, code: string): boolean => f.playbook.some((a) => a.code === code);
const statusIn = <T extends string>(v: T | undefined, list: readonly T[]): boolean => v !== undefined && list.includes(v);
const outboxSent = (f: AutopilotFacts, kinds: readonly string[], sinceIso?: string): boolean =>
  f.outbox.some((o) => kinds.includes(o.kind) && o.status === 'sent' && (!sinceIso || (o.sentAt ?? o.createdAt) >= sinceIso));
const outboxLive = (f: AutopilotFacts, kinds: readonly string[]): boolean => f.outbox.some((o) => kinds.includes(o.kind) && o.status !== 'cancelled' && o.status !== 'failed');

const recorded = (f: AutopilotFacts): string | undefined => f.recordedAcceptance?.decision;
const accepted = (f: AutopilotFacts): boolean => recorded(f) === 'accept' || recorded(f) === 'accept_with_conditions';
const declined = (f: AutopilotFacts): boolean => recorded(f) === 'decline';

const reservationExists = (f: AutopilotFacts): boolean => f.reservations.some((r) => r.status === 'held' || r.status === 'confirmed' || r.status === 'on_hire' || r.status === 'returned') || f.bundle.hire.length > 0;
const confirmedOrLater = (f: AutopilotFacts): boolean => statusIn(activeReservation(f)?.status, ['confirmed', 'on_hire', 'returned'] as const) || f.bundle.hire.length > 0;
const hireStarted = (f: AutopilotFacts): boolean => statusIn(activeReservation(f)?.status, ['on_hire', 'returned'] as const) || f.bundle.hire.length > 0;
const hireActive = (f: AutopilotFacts): boolean => f.bundle.hire.some((h) => !h.endAt) || activeReservation(f)?.status === 'on_hire';
const hireEnded = (f: AutopilotFacts): boolean => hireStarted(f) && !hireActive(f);

const OFF_HIRE_EVENTS: ReadonlyArray<[EventType, HireEndTrigger]> = [
  ['repair_completed', 'repair_complete_24h'],
  ['tl_payment_received', 'tl_payment_5wd'],
  ['insurer_termination_notice', 'insurer_termination_1wd'],
  ['cash_in_lieu_received', 'cash_in_lieu'],
];

/** The first off-hire trigger after the hire start (§A.4 `offHireTrigger`). */
export function offHireTrigger(f: AutopilotFacts): { trigger: HireEndTrigger; at: ISODateTime } | undefined {
  const hire = currentHire(f);
  const start = hire?.startAt ?? activeReservation(f)?.startAt;
  if (!start) return undefined;
  const hits: Array<{ trigger: HireEndTrigger; at: ISODateTime }> = [];
  for (const [type, trigger] of OFF_HIRE_EVENTS) {
    for (const e of f.bundle.events) if (e.type === type && msOf(e.at) >= msOf(start)) hits.push({ trigger, at: e.at });
  }
  if (hire?.endTrigger === 'client_returned' || hire?.endTrigger === 'replacement_purchased') hits.push({ trigger: hire.endTrigger, at: hire.endAt ?? start });
  return hits.sort((a, b) => msOf(a.at) - msOf(b.at))[0];
}

/** Ledger position per head: claimed vs paid / written off (§A.4 `headsResolved`). */
export function headsResolved(f: AutopilotFacts): boolean {
  const heads = new Map<string, { claimed: number; paid: number; writtenOff: boolean }>();
  for (const e of f.bundle.ledger) {
    const h = heads.get(e.head) ?? { claimed: 0, paid: 0, writtenOff: false };
    if (e.kind === 'claimed') h.claimed += e.amountPence;
    if (e.kind === 'paid' || e.kind === 'interim_paid') h.paid += e.amountPence;
    if (e.kind === 'written_off') h.writtenOff = true;
    heads.set(e.head, h);
  }
  const claimed = [...heads.values()].filter((h) => h.claimed > 0);
  if (!claimed.length) return false;
  return claimed.every((h) => h.writtenOff || h.paid >= h.claimed) || f.bundle.claim.status === 'settled';
}

/** Is a hire needed at all (§A.4 `hireNeeded`)? */
export function hireNeeded(f: AutopilotFacts): boolean {
  if (f.bundle.hire.length > 0) return true;
  if (f.needs?.clientWantsHire === false) return false;
  if (f.eligibility?.need.level === 'none') return false;
  if (f.bundle.offers.some((o) => o.clientDecision === 'accepted')) return false;
  if (f.reservations.some((r) => r.status === 'cancelled' && r.cancelledReason === 'client_declined_hire') && !liveReservation(f)) return false;
  if (f.needs?.otherVehicles === 'available') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Claim status the stage implies (§A.9)
// ---------------------------------------------------------------------------

/** Statuses the autopilot may set (never declined / settled / closed / pre_action / litigation). */
export const AUTOPILOT_STATUSES: readonly ClaimStatus[] = ['fnol', 'triage', 'accepted', 'hire_active', 'repair', 'total_loss', 'payment_pack', 'chasing'];
const STATUS_RANK: Partial<Record<ClaimStatus, number>> = { fnol: 0, triage: 1, accepted: 2, hire_active: 3, repair: 3, total_loss: 3, payment_pack: 4, chasing: 5 };

/** The status that matches a stage, or null when the stage implies no change. */
export function statusForStage(stage: StageId | TerminalStage | undefined, f: AutopilotFacts): ClaimStatus | null {
  switch (stage) {
    case 'enquiry':
    case 'intake':
      return 'fnol';
    case 'qualification':
      return 'triage';
    case 'sign_up':
    case 'vehicle_secured':
    case 'hire_search':
    case 'hire_offer':
    case 'hire_booked':
      return 'accepted';
    case 'handover':
    case 'on_hire':
      if (hireActive(f)) return 'hire_active';
      if (has(f, 'total_loss_confirmed')) return 'total_loss';
      if (has(f, 'repair_started') || has(f, 'repair_authorised')) return 'repair';
      return hireStarted(f) ? 'hire_active' : 'accepted';
    case 'off_hire':
    case 'billing':
      return 'payment_pack';
    case 'recovery':
      return has(f, 'payment_pack_sent') ? 'chasing' : 'payment_pack';
    default:
      return null;
  }
}

/** The status the sync step should set now, or null (in sync, a person changed it recently, or never move backwards). */
export function statusTarget(f: AutopilotFacts & { stage?: StageId | TerminalStage }): ClaimStatus | null {
  const current = f.bundle.claim.status;
  if (!AUTOPILOT_STATUSES.includes(current)) return null;
  const target = statusForStage(f.stage, f);
  if (!target || target === current) return null;
  if (f.lastPersonStatusAt && msOf(f.now) - msOf(f.lastPersonStatusAt) < DAY) return null;
  if ((STATUS_RANK[target] ?? 0) < (STATUS_RANK[current] ?? 0)) return null;
  return target;
}

// ---------------------------------------------------------------------------
// The predicate table
// ---------------------------------------------------------------------------

const base: Record<PredicateId, Predicate> = {
  always: () => true,
  never: () => false,
  'claim.exists': (f) => Boolean(f.bundle.claim.id),
  'claim.declined': (f) => f.bundle.claim.status === 'declined',
  'claim.closed': (f) => f.bundle.claim.status === 'closed' || f.bundle.claim.status === 'settled',
  'client.emailOnFile': (f) => f.clientEmail.onFile,
  'ack.sent': (f) => outboxSent(f, ['ack']),
  'intake.fnolComplete': (f) => f.fnol.valid && f.needs !== null,
  'intake.detailsRequested': (f) => outboxSent(f, ['doc_request'], new Date(msOf(f.now) - 3 * DAY).toISOString()),
  'clash.crossFileClear': (f) => f.lastRun['intake.cross_file'] !== undefined && !f.clashes.some((c) => c.severity === 'block' && (CROSS_FILE_CLASH_CODES as readonly string[]).includes(c.code)),
  'accident.injuries': (f) => f.bundle.claim.accident.injuries === true,
  'injury.referred': (f) => Boolean(f.bundle.claim.injuryReferral) || Boolean(f.eligibility?.injury.referred),
  'cctv.applies': (f) => playbookHas(f, 'REQUEST_CCTV') || has(f, 'cctv_request_sent'),
  'acceptance.recorded': (f) => f.recordedAcceptance !== null,
  'acceptance.declined': declined,
  'acceptance.notDeclined': (f) => !declined(f),
  'acceptance.accepted': accepted,
  'driver.eligible': (f) => f.eligibility?.driver.outcome === 'eligible' && f.eligibility.additionalDrivers.every((d) => d.outcome === 'eligible'),
  'driver.detailsRequested': (f) => outboxSent(f, ['doc_request'], new Date(msOf(f.now) - 3 * DAY).toISOString()) && (f.eligibility?.driver.missing.length ?? 0) > 0,
  'need.settled': (f) => ['strong', 'moderate', 'none'].includes(f.eligibility?.need.level ?? 'unknown'),
  'means.impecuniosity_relied_on': (f) => f.eligibility?.means.basis === 'impecunious',
  'means.ready': (f) => f.eligibility?.means.readiness === 'ready',
  'means.requested': (f) => outboxSent(f, ['doc_request'], new Date(msOf(f.now) - 5 * DAY).toISOString()),
  'roadworthiness.hireFromSet': (f) => (f.eligibility?.roadworthiness.hireFrom ?? 'unknown') !== 'unknown',
  'signup.signed': (f) => packOf(f, 'signup')?.status === 'signed' || has(f, 'services_agreed'),
  'insurer.known': (f) => Boolean(f.bundle.atFaultInsurer),
  'handlingRef.requested': (f) => outboxSent(f, ['handling_ref_request']) || f.bundle.documents.some((d) => d.templateId === 'letter.handling_ref_request' && (d.status === 'sent' || d.status === 'approved')),
  'intervention.any': (f) => f.bundle.offers.length > 0,
  'intervention.unanswered': (f) => f.bundle.offers.some((o) => !o.replySentAt),
  'intervention.answered': (f) => f.bundle.offers.length > 0 && f.bundle.offers.every((o) => Boolean(o.replySentAt)),
  'vehicle.notDriveable': (f) => f.bundle.claim.accident.driveable === false || f.eligibility?.roadworthiness.driveable === false,
  'vehicle.recovered': (f) => f.bundle.recovery.length > 0 || f.bundle.storage.length > 0,
  'storage.any': (f) => f.bundle.storage.length > 0,
  'storage.handled': (f) => f.bundle.storage.every((s) => Boolean(s.endAt)) || has(f, 'collect_or_pay_notice_sent'),
  'vehicle.engineerNeeded': () => true,
  'engineer.instructedOrReported': (f) => has(f, 'engineer_instructed') || has(f, 'inspection') || has(f, 'report_issued') || Boolean(f.bundle.report),
  'inspection.doneOrReported': (f) => has(f, 'inspection') || has(f, 'report_issued') || Boolean(f.bundle.report),
  'inspection.waiting': (f) => {
    const e = lastEvent(f, 'engineer_instructed');
    if (!e) return false;
    const chased = f.lastRun['vehicle.inspection'];
    const from = chased && chased > e.at ? chased : e.at;
    return msOf(addWorkingDays(from, 3)) > msOf(f.now);
  },
  'report.draftWaiting': (f) => f.bundle.documents.some((d) => d.templateId === 'report.engineer' && d.status === 'draft'),
  'report.awaited': (f) => !f.bundle.documents.some((d) => d.templateId === 'report.engineer' && d.status === 'draft'),
  'repair.route': (f) => !has(f, 'total_loss_confirmed'),
  'repair.begun': (f) => has(f, 'report_issued') || has(f, 'repair_authorised') || has(f, 'repair_started') || Boolean(f.bundle.report),
  'repair.newsArrived': (f) => repairNews(f),
  'repair.underway': (f) => !repairNews(f),
  'hire.needed': hireNeeded,
  'hire.inLookAhead': (f) => !f.needs?.neededFrom || msOf(f.needs.neededFrom) <= msOf(f.now) + f.settings.booking.lookAheadDays * DAY,
  'hire.reservationExists': reservationExists,
  'reservation.held': (f) => liveReservation(f)?.status === 'held',
  'reservation.confirmedOrLater': confirmedOrLater,
  'offer.made': (f) => statusIn(currentOffer(f)?.status, ['sent', 'accepted'] as const) || confirmedOrLater(f),
  'offer.sent': (f) => statusIn(currentOffer(f)?.status, ['sent', 'accepted'] as const) || confirmedOrLater(f),
  'offer.accepted': (f) => currentOffer(f)?.status === 'accepted' || confirmedOrLater(f),
  'offer.notExpired': (f) => currentOffer(f)?.status !== 'expired',
  'choice.noneOpen': (f) => !f.openNeedsYou.some((n) => n.kind === 'choose_car'),
  'offer.awaitingReply': (f) => {
    const o = currentOffer(f);
    if (!o || o.status !== 'sent') return false;
    if (msOf(o.expiresAt) <= msOf(f.now)) return false;
    return !replyArrived(f);
  },
  'delivery.arranged': (f) => {
    if (hireStarted(f)) return true;
    const r = activeReservation(f);
    return movementsOf(f, r?.id, 'delivery').some((m) => m.status === 'done' || Boolean(m.clientNotifiedAt) || (m.noticeOutboxId !== undefined && f.outbox.some((o) => o.id === m.noticeOutboxId && o.status === 'sent')));
  },
  'delivery.due': (f) => {
    const m = movementsOf(f, activeReservation(f)?.id, 'delivery')[0];
    return Boolean(m) && msOf(m!.windowStart) - DAY <= msOf(f.now);
  },
  'hire.started': hireStarted,
  'hire.everStarted': hireStarted,
  'hire.active': hireActive,
  'hire.ended': hireEnded,
  'monitor.recent': (f) => {
    const last = f.lastRun['hire.monitor'] ?? currentHire(f)?.startAt ?? activeReservation(f)?.startAt;
    return Boolean(last) && msOf(f.now) - msOf(last) < 7 * DAY;
  },
  'hire.offHireTrigger': (f) => offHireTrigger(f) !== undefined,
  'collection.arranged': (f) => hireEnded(f) || movementsOf(f, activeReservation(f)?.id, 'collection').length > 0,
  'collection.planned': (f) => movementsOf(f, activeReservation(f)?.id, 'collection').length > 0,
  'billing.applies': (f) => hireStarted(f) || f.bundle.storage.length > 0 || f.bundle.recovery.length > 0,
  'billing.ready': (f) => (hireStarted(f) || f.bundle.storage.length > 0 || f.bundle.recovery.length > 0) && !hireActive(f) && f.bundle.storage.every((s) => Boolean(s.endAt)),
  'chaser.due': (f) => ['CHASER_7', 'CHASER_14', 'CHASER_21'].some((c) => playbookHas(f, c)),
  'chaser.notDue': (f) => !['CHASER_7', 'CHASER_14', 'CHASER_21'].some((c) => playbookHas(f, c)),
  'money.headsResolved': headsResolved,
  'settlementOffer.open': (f) => f.settlementOffers.some((o) => o.status === 'open'),
  'settlementOffer.noneOpen': (f) => !f.settlementOffers.some((o) => o.status === 'open'),
  'payment.remittanceIn': (f) => has(f, 'payment_received') || f.lastInbound?.intent === 'payment_remittance',
  'payment.recorded': (f) => f.bundle.ledger.some((e) => e.kind === 'paid' || e.kind === 'interim_paid'),
  'money.clientPayoutDue': (f) => f.bundle.ledger.some((e) => (e.head === 'pav' || e.head === 'excess') && (e.kind === 'paid' || e.kind === 'interim_paid')),
  'status.inSync': (f) => statusTarget(f as AutopilotFacts & { stage?: StageId | TerminalStage }) === null,
  // §D.6 pack predicates (same meaning as apps/api/src/signing/packs.ts packPredicates)
  'vehicle.recovery_storage_or_engineer_needed': (f) =>
    f.bundle.recovery.length > 0 || f.bundle.storage.length > 0 || f.bundle.claim.accident.roadworthyAfter === false || f.bundle.claim.accident.driveable === false || has(f, 'engineer_instructed') || Boolean(f.bundle.report),
  'storage.claimed': (f) => f.bundle.storage.length > 0 || f.bundle.ledger.some((e) => e.head === 'storage' && (e.kind === 'claimed' || e.kind === 'invoiced')),
  'recovery.claimed': (f) => f.bundle.recovery.length > 0 || f.bundle.ledger.some((e) => e.head === 'recovery' && (e.kind === 'claimed' || e.kind === 'invoiced')),
  'engineer.instructed': (f) => has(f, 'engineer_instructed') || Boolean(f.bundle.report) || f.bundle.ledger.some((e) => e.head === 'engineer_fee'),
};

/** A new inbound message from the client after the offer went out (§D.4). */
export function replyArrived(f: AutopilotFacts): boolean {
  const o = currentOffer(f);
  if (!o?.sentAt || !f.lastInbound) return false;
  return msOf(f.lastInbound.at) > msOf(o.sentAt);
}

function repairNews(f: AutopilotFacts): boolean {
  const li = f.lastInbound;
  if (!li || li.intent !== 'bodyshop_update') return false;
  const seen = f.lastRun['vehicle.repair_track'];
  const lastRepairEvent = [lastEvent(f, 'repair_started'), lastEvent(f, 'repair_delay'), lastEvent(f, 'repair_completed')].filter(Boolean).map((e) => e!.recordedAt ?? e!.at).sort().pop();
  const after = [seen, lastRepairEvent].filter(Boolean).sort().pop();
  return !after || msOf(li.at) > msOf(after);
}

for (const t of PREDICATE_EVENT_TYPES) base[`event.${t}`] = (f) => has(f, t);
for (const code of new Set([...playbookRuleCodes, 'CHASER_7', 'CHASER_14', 'CHASER_21', 'COMPLAINT_28', 'SEND_COLLECT_OR_PAY', 'REQUEST_CCTV'])) base[`playbook.${code}`] = (f) => playbookHas(f, code);
for (const stage of PACK_STAGES) {
  base[`pack.${stage}.exists`] = (f) => packOf(f, stage) !== undefined;
  base[`pack.${stage}.approved`] = (f) => statusIn(packOf(f, stage)?.status, ['approved', 'sent', 'signed'] as const) || (stage === 'hire_start' && hireStarted(f));
  base[`pack.${stage}.sent`] = (f) => statusIn(packOf(f, stage)?.status, ['sent', 'signed'] as const);
  base[`pack.${stage}.signed`] = (f) => packOf(f, stage)?.status === 'signed';
}

export const PREDICATES: Readonly<Record<PredicateId, Predicate>> = Object.freeze(base);

/** Evaluate a predicate id (unknown ids are false — the integrity test makes them impossible). */
export function holds(f: AutopilotFacts, id: PredicateId): boolean {
  const p = PREDICATES[id];
  return p ? p(f) : false;
}

// ---------------------------------------------------------------------------
// Requirements (what is missing, in plain English, and who we ask)
// ---------------------------------------------------------------------------

export interface Requirement {
  label: string;
  present: Predicate;
  ask: 'client' | 'insurer' | 'owner';
}

export const REQUIREMENTS: Readonly<Record<RequirementId, Requirement>> = Object.freeze({
  'driver.profile': {
    label: "the driver's licence details (date of birth, full licence since, points and endorsements)",
    present: (f: AutopilotFacts) => Boolean(f.eligibility) && f.eligibility!.driver.outcome !== 'unknown' && f.eligibility!.driver.missing.length === 0,
    ask: 'client',
  },
  'needs.captured': { label: "the client's hire needs (when they need a car, seats, gearbox, use)", present: (f: AutopilotFacts) => f.needs !== null, ask: 'client' },
  'vehicle.driveableAnswered': {
    label: "whether the client's car can be driven",
    present: (f: AutopilotFacts) => f.bundle.claim.accident.driveable !== undefined || (f.eligibility?.roadworthiness.driveable ?? null) !== null,
    ask: 'client',
  },
  'client.email': { label: "the client's email address", present: (f: AutopilotFacts) => f.clientEmail.onFile && !f.clientEmail.bounced, ask: 'client' },
});

/** The missing requirement ids of a list. */
export function missingRequirements(f: AutopilotFacts, ids: readonly RequirementId[]): RequirementId[] {
  return ids.filter((id) => !(REQUIREMENTS[id]?.present(f) ?? false));
}

// ---------------------------------------------------------------------------
// Date facts for deadlines (`StepDeadline.fromFact`)
// ---------------------------------------------------------------------------

export const DATE_FACTS: Readonly<Record<string, (f: AutopilotFacts) => ISODateTime | undefined>> = Object.freeze({
  'claim.openedAt': (f: AutopilotFacts) => f.bundle.claim.openedAt,
  'claim.accident.date': (f: AutopilotFacts) => f.bundle.claim.accident.occurredAt,
  'event.services_agreed.at': (f: AutopilotFacts) => firstEvent(f, 'services_agreed')?.at,
  'event.ncaf_sent.at': (f: AutopilotFacts) => firstEvent(f, 'ncaf_sent')?.at,
  'event.engineer_instructed.at': (f: AutopilotFacts) => lastEvent(f, 'engineer_instructed')?.at,
  'intervention.receivedAt': (f: AutopilotFacts) => f.bundle.offers.filter((o) => !o.replySentAt).map((o) => o.receivedAt).sort()[0],
  'pack.signup.sentAt': (f: AutopilotFacts) => packOf(f, 'signup')?.sentAt,
  'needs.neededFrom': (f: AutopilotFacts) => f.needs?.neededFrom ?? undefined,
  'reservation.createdAt': (f: AutopilotFacts) => liveReservation(f)?.createdAt,
  'offer.expiresAt': (f: AutopilotFacts) => currentOffer(f)?.expiresAt,
  'delivery.windowEnd': (f: AutopilotFacts) => movementsOf(f, activeReservation(f)?.id, 'delivery')[0]?.windowEnd,
  'hire.startAt': (f: AutopilotFacts) => currentHire(f)?.startAt ?? (activeReservation(f)?.status === 'on_hire' ? activeReservation(f)!.startAt : undefined),
  'hire.offHireDeadline': (f: AutopilotFacts) => {
    const t = offHireTrigger(f);
    return t ? offHireDeadline(t.trigger, t.at).dueAt : undefined;
  },
  'collection.windowEnd': (f: AutopilotFacts) => movementsOf(f, activeReservation(f)?.id, 'collection')[0]?.windowEnd,
  'hire.endAt': (f: AutopilotFacts) => currentHire(f)?.endAt,
});

/** All predicate ids that pack definitions or steps may use. */
export const PACK_STAGE_PREDICATES = (stage: PackStage): string[] => [`pack.${stage}.exists`, `pack.${stage}.approved`, `pack.${stage}.sent`, `pack.${stage}.signed`];
