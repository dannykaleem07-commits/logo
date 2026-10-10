// owned by ap-clash
/**
 * Clash service (docs/SUPREME-AUTOPILOT.md §C.3, §C.4): assembles the ClashWorld for a subject, runs the pure
 * `detectClashes`, persists findings (upsert by dedupe key; resolved when no longer seen) and enforces block findings
 * through the manager-mode gate.
 *
 * For the routes (ap-booking's hold / confirm / period change / handover / return, POST/PATCH hire):
 *
 *   const { findings, overriddenKeys } = enforceClashes(ctx, gateFor(ctx, request), subject, target);
 *   // … write the booking in a transaction, then in the same transaction:
 *   persistFindings(ctx, tx, subject, findings, { overriddenKeys, reason: gate.reason, by: request.actor.userId });
 *
 * Class C blocks are thrown as plain 409s with the clash code (never overridable); class A/B blocks are refused with
 * their OVERRIDE_RULES code (e.g. HIRE_OVERLAP, SAME_REG_ON_HIRE) so a manager in manager mode with X-Manager-Override
 * proceeds (the gate records the override; the app's onSend hook writes `override.<CODE>`). Warn and info findings
 * never refuse: they are stored and returned. Agents never override (a refusal carrying `error.override` becomes
 * Needs-you `override_needed` in the dispatcher). Messages never name another claim or its people.
 *
 * A DRIVER_REFERRAL whose driver the fleet insurer has accepted in writing (an `insurer_accepted` decision recorded by
 * the eligibility_review resolver, with the evidence id, after the driver profile last changed) is downgraded to info.
 */
import {
  CLASH_CATALOGUE,
  addCalendarDays,
  detectClashes,
  mergeAutopilotSettings,
  type AcceptanceAssessment,
  type AutopilotSettings,
  type Claim,
  type ClashFinding,
  type ClashSubject,
  type ClashWorld,
  type HireAgreement,
  type HireNeeds,
  type Id,
  type Reservation,
} from '@ccguk/domain';
import type { ClashScope, ClashUpsertResult, Db } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { conflict } from '../errors.js';
import { createNeedsYou, enqueueJob } from '../agent/core.js';
import type { OverrideGate, OverrideTarget } from '../services/override.js';
import { gtaRatesFor } from '../services/kb.js';
import { signedPackStatus } from '../signing/status.js';

const DAY_MS = 86_400_000;
const BLOCKING = ['held', 'confirmed', 'on_hire', 'returned'] as const;
const LIVE = ['held', 'confirmed', 'on_hire'] as const;
const FINAL: readonly Claim['status'][] = ['declined', 'settled', 'closed'];

export function autopilotSettingsOf(ctx: AppContext): AutopilotSettings {
  try {
    return mergeAutopilotSettings(ctx.repos.getAgentSettings(ctx.db).autopilot);
  } catch {
    return mergeAutopilotSettings(undefined);
  }
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/** Reservations in the diary that can still clash (blocking statuses, ending within the last two years or open). */
function diaryReservations(ctx: AppContext): Reservation[] {
  const fromMs = Date.parse(ctx.now()) - 730 * DAY_MS;
  return ctx.repos.listReservations(ctx.db, { status: [...BLOCKING], fromMs });
}

/**
 * The rows `detectClashes` needs. Fleet-wide and claim-identity data is loaded whole (one desktop database); the
 * per-claim details (events, acceptance, intervention offers, hire needs, signed packs) only for the focus claims.
 */
export function buildClashWorld(ctx: AppContext, focusClaimIds: Iterable<Id>): ClashWorld {
  const db = ctx.db;
  const focus = new Set(focusClaimIds);
  const claims = ctx.repos.listClaims(db, { limit: 1_000_000 });
  const fleetUnits = ctx.repos.listFleetUnits(db);
  const vehicles = ctx.repos.listVehicles(db, { limit: 1_000_000 });
  const reservations = diaryReservations(ctx);
  const hires: HireAgreement[] = fleetUnits.flatMap((u) => ctx.repos.listHireForFleetUnit(db, u.id));
  const claimById = new Map(claims.map((c) => [c.id, c]));

  const partyIds = new Set<Id>();
  for (const r of reservations) [r.hirerPartyId, ...(r.driverPartyIds ?? [])].forEach((p) => p && partyIds.add(p));
  for (const h of hires) {
    const c = claimById.get(h.claimId);
    [h.hirerPartyId, ...(h.driverPartyIds ?? []), ...h.additionalDrivers.map((d) => d.partyId), c?.driverId, c?.claimantId].forEach((p) => p && partyIds.add(p));
  }
  for (const id of focus) {
    const c = claimById.get(id);
    if (c) [c.claimantId, c.driverId].forEach((p) => p && partyIds.add(p));
  }
  const parties = ctx.repos.getParties(db, [...partyIds]);

  const eventsByClaim: ClashWorld['eventsByClaim'] = {};
  const acceptanceByClaim: ClashWorld['acceptanceByClaim'] = {};
  const needsByClaim: Record<Id, HireNeeds | null> = {};
  const interventionOffers: ClashWorld['interventionOffers'] = [];
  const signedPackByReservation: ClashWorld['signedPackByReservation'] = {};
  for (const id of focus) {
    if (!claimById.has(id)) continue;
    eventsByClaim[id] = ctx.repos.listEvents(db, id);
    const acc = ctx.repos.latestEligibilityAssessment(db, id, 'acceptance');
    if (acc && acc.reasons && typeof acc.reasons === 'object' && !Array.isArray(acc.reasons)) acceptanceByClaim[id] = acc.reasons as AcceptanceAssessment;
    const needs = ctx.repos.getHireNeeds(db, id);
    if (needs) needsByClaim[id] = needs.needs;
    interventionOffers.push(...ctx.repos.listOffers(db, id));
  }
  for (const r of reservations) {
    if (!focus.has(r.claimId) || !(LIVE as readonly string[]).includes(r.status)) continue;
    try {
      signedPackByReservation[r.id] = signedPackStatus(ctx, r.id);
    } catch (err) {
      ctx.logger.warn('clash: signed pack status failed', { reservationId: r.id, error: String(err) });
    }
  }
  const movementsFrom = new Date(Date.parse(ctx.now()) - DAY_MS).toISOString();
  return {
    claims,
    vehicles,
    parties,
    driverProfiles: ctx.repos.listDriverProfiles(db, [...partyIds]),
    fleetUnits,
    policies: ctx.repos.listPolicies(db),
    reservations,
    hires,
    readiness: ctx.repos.listReadinessTasks(db, { status: 'open' }),
    damage: ctx.repos.listDamage(db, { unrepaired: true }),
    penalties: ctx.repos.listPenalties(db, { open: true }),
    eventsByClaim,
    acceptanceByClaim,
    interventionOffers,
    signedPackByReservation,
    needsByClaim,
    movements: ctx.repos.listMovements(db, { status: ['planned', 'confirmed'], from: movementsFrom }),
    gtaRates: gtaRatesFor(ctx),
  };
}

/** The claims a subject is about (whose per-claim details the world must carry). */
export function focusClaimsOf(ctx: AppContext, subject: ClashSubject): Id[] {
  switch (subject.kind) {
    case 'proposed_booking':
    case 'claim':
      return [subject.claimId];
    case 'reservation': {
      const r = ctx.repos.getReservation(ctx.db, subject.reservationId);
      return r ? [r.claimId] : [];
    }
    case 'hire': {
      const h = ctx.repos.getHire(ctx.db, subject.hireId);
      return h ? [h.claimId] : [];
    }
    case 'fleet_unit': {
      const ids = new Set<Id>();
      for (const r of ctx.repos.listReservations(ctx.db, { fleetUnitId: subject.fleetUnitId, status: [...LIVE] })) ids.add(r.claimId);
      for (const h of ctx.repos.listHireForFleetUnit(ctx.db, subject.fleetUnitId)) if (!h.endAt) ids.add(h.claimId);
      return [...ids];
    }
  }
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/** An `insurer_accepted` decision for a referred driver turns DRIVER_REFERRAL into info (§H.3 eligibility_review). */
function applyInsurerAcceptance(ctx: AppContext, findings: ClashFinding[], world: ClashWorld): ClashFinding[] {
  return findings.map((f) => {
    if (f.code !== 'DRIVER_REFERRAL' || !f.claimId) return f;
    const partyId = typeof f.data?.partyId === 'string' ? f.data.partyId : undefined;
    if (!partyId) return f;
    const accepted = insurerAcceptance(ctx, f.claimId, partyId, world.driverProfiles.find((p) => p.partyId === partyId)?.updatedAt);
    if (!accepted) return f;
    return { ...f, severity: 'info', message: `The fleet insurer accepted this driver in writing (evidence on file): ${f.message}`, data: { ...f.data, insurerAccepted: accepted } };
  });
}

/** The recorded insurer acceptance of a referred driver, if it is newer than the driver's profile. */
export function insurerAcceptance(ctx: AppContext, claimId: Id, partyId: Id, profileUpdatedAt?: string): { evidenceId: string; at: string; by: string } | undefined {
  const rows = ctx.repos.listEligibilityAssessments(ctx.db, claimId, { kind: 'driver', partyId });
  for (const a of [...rows].reverse()) {
    const reasons = Array.isArray(a.reasons) ? (a.reasons as Array<Record<string, unknown>>) : [];
    const ok = reasons.find((r) => r.code === 'INSURER_ACCEPTED' && typeof r.evidenceId === 'string');
    if (!ok) continue;
    if (profileUpdatedAt && Date.parse(a.createdAt) < Date.parse(profileUpdatedAt)) return undefined;
    return { evidenceId: ok.evidenceId as string, at: a.createdAt, by: a.createdBy };
  }
  return undefined;
}

export function checkClashesIn(ctx: AppContext, subject: ClashSubject, world: ClashWorld, settings: AutopilotSettings = autopilotSettingsOf(ctx)): { findings: ClashFinding[]; blocks: ClashFinding[] } {
  const raw = detectClashes(subject, world, { now: ctx.now(), settings });
  const findings = applyInsurerAcceptance(ctx, raw, world);
  return { findings, blocks: findings.filter((f) => f.severity === 'block') };
}

/** Run the detector for one subject on a fresh world. */
export function checkClashes(ctx: AppContext, subject: ClashSubject): { findings: ClashFinding[]; blocks: ClashFinding[] } {
  return checkClashesIn(ctx, subject, buildClashWorld(ctx, focusClaimsOf(ctx, subject)));
}

/**
 * Check and enforce (§C.4): class C blocks throw a plain 409 with the clash code; class A/B blocks are refused through
 * the gate with their override code (a manager in manager mode proceeds; the keys of the overridden findings are
 * returned so `persistFindings` stores them as `overridden`). Returns every finding (warns included).
 */
export function enforceClashes(
  ctx: AppContext,
  gate: OverrideGate,
  subject: ClashSubject,
  target: OverrideTarget,
): { findings: ClashFinding[]; blocks: ClashFinding[]; warnings: ClashFinding[]; overriddenKeys: string[] } {
  const { findings, blocks } = checkClashes(ctx, subject);
  const details = (f: ClashFinding) => ({ clashCode: f.code, findings: blocks });
  for (const f of blocks) if (f.overrideClass === 'C') throw conflict(f.code, f.message, details(f));
  const overriddenKeys: string[] = [];
  for (const f of blocks) {
    const code = CLASH_CATALOGUE[f.code].overrideCode ?? f.code;
    gate.refuse(conflict(code, f.message, details(f)), target);
    overriddenKeys.push(f.dedupeKey);
  }
  return { findings, blocks, warnings: findings.filter((f) => f.severity !== 'block'), overriddenKeys };
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

export function scopeOf(subject: ClashSubject): ClashScope {
  switch (subject.kind) {
    case 'proposed_booking':
      return { proposed: { claimId: subject.claimId, fleetUnitId: subject.fleetUnitId } };
    case 'reservation':
      return { reservationId: subject.reservationId };
    case 'hire':
      return { hireId: subject.hireId };
    case 'claim':
      return { claimId: subject.claimId };
    case 'fleet_unit':
      return { fleetUnitId: subject.fleetUnitId };
  }
}

export interface PersistOptions {
  /** Dedupe keys a manager overrode in this request (from `enforceClashes`). */
  overriddenKeys?: readonly string[];
  /** The override reason (gate.reason) and who overrode. */
  reason?: string;
  by?: string;
  overrideAuditId?: Id;
}

/** Upsert the findings of one run (§C.4). Returns what changed (new / seen / resolved). */
export function persistFindings(ctx: AppContext, tx: Db, subject: ClashSubject, findings: ClashFinding[], opts: PersistOptions = {}): ClashUpsertResult {
  return ctx.repos.upsertClashFindings(tx, scopeOf(subject), findings, {
    at: ctx.now(),
    ...(opts.overriddenKeys?.length ? { overridden: { keys: opts.overriddenKeys, reason: opts.reason ?? 'Manager override', by: opts.by ?? 'unknown', ...(opts.overrideAuditId ? { auditId: opts.overrideAuditId } : {}) } } : {}),
  });
}

// ---------------------------------------------------------------------------
// Runs (clash.check job, sweep) and Needs-you
// ---------------------------------------------------------------------------

/** The claim's next booking start (live reservations or open hires), for the 48-hour urgency rule. */
function nextStartMs(ctx: AppContext, claimId: Id): number | null {
  const now = Date.parse(ctx.now());
  const starts = ctx.repos
    .listReservations(ctx.db, { claimId, status: [...LIVE] })
    .map((r) => (r.status === 'on_hire' ? now : Date.parse(r.startAt)))
    .filter((x) => Number.isFinite(x));
  return starts.length ? Math.min(...starts) : null;
}

function hasBooking(ctx: AppContext, claimId: Id): boolean {
  return ctx.repos.listReservations(ctx.db, { claimId, status: [...LIVE] }).length > 0 || ctx.repos.listHire(ctx.db, claimId).some((h) => !h.endAt);
}

/** Raise `clash_review` for a new block finding on a claim with a booking or hire (urgent within 48 h of a start). */
export function raiseClashReview(ctx: AppContext, f: { id: Id; code: string; message: string; severity: string; claimId?: Id; reservationId?: Id; fleetUnitId?: Id; related: ClashFinding['related'] }, createdBy = 'agent:autopilot'): void {
  if (!f.claimId || f.severity !== 'block' || !hasBooking(ctx, f.claimId)) return;
  const claim = ctx.repos.getClaim(ctx.db, f.claimId);
  if (!claim || FINAL.includes(claim.status)) return;
  const start = nextStartMs(ctx, f.claimId);
  const urgent = start !== null && start - Date.parse(ctx.now()) <= 48 * 3_600_000;
  const def = CLASH_CATALOGUE[f.code as keyof typeof CLASH_CATALOGUE];
  createNeedsYou(ctx, {
    kind: 'clash_review',
    claimId: f.claimId,
    title: `Booking clash on ${claim.reference}: ${def?.label ?? f.code}`,
    summary: f.message,
    payload: { findingId: f.id, code: f.code, severity: f.severity, overrideClass: def?.overrideClass ?? 'C', message: f.message, reservationId: f.reservationId ?? null, fleetUnitId: f.fleetUnitId ?? null, related: f.related },
    options: [
      { id: 'resolved', label: 'It is resolved', tone: 'primary', requiresReason: true },
      { id: 'cancel_booking', label: 'Cancel the booking', tone: 'danger', requiresReason: true },
      { id: 'open_booking', label: 'Open the booking (override as manager there)', tone: 'neutral' },
    ],
    priority: urgent ? 'urgent' : 'high',
    createdBy,
    dedupeKey: `clash_review:${f.id}`,
  });
}

export interface ClashRunSummary {
  subjects: number;
  inserted: number;
  resolved: number;
  newBlocks: number;
}

/** Check one subject, persist, and raise Needs-you for new block findings on a booked claim (the `clash.check` job). */
export function runClashCheck(ctx: AppContext, subject: ClashSubject): ClashRunSummary & { findings: ClashFinding[] } {
  const { findings } = checkClashes(ctx, subject);
  const res = ctx.db.transaction((tx) => persistFindings(ctx, tx, subject, findings));
  const newBlocks = res.inserted.filter((f) => f.status === 'open' && f.severity === 'block');
  for (const f of newBlocks) raiseClashReview(ctx, f);
  return { subjects: 1, inserted: res.inserted.length, resolved: res.resolved.length, newBlocks: newBlocks.length, findings };
}

/**
 * Nightly sweep (§C.3): every open claim with a live booking or open hire, and every fleet unit not disposed. One world
 * is built and reused; findings are upserted per subject; new block findings on booked claims raise `clash_review`
 * (urgent within 48 h of a start).
 */
export function runClashSweep(ctx: AppContext): ClashRunSummary {
  const live = ctx.repos.listReservations(ctx.db, { status: [...LIVE] });
  const claimIds = new Set<Id>(live.map((r) => r.claimId));
  const units = ctx.repos.listFleetUnits(ctx.db).filter((u) => u.status !== 'disposed');
  for (const u of units) for (const h of ctx.repos.listHireForFleetUnit(ctx.db, u.id)) if (!h.endAt) claimIds.add(h.claimId);
  const openClaims = [...claimIds].filter((id) => {
    const c = ctx.repos.getClaim(ctx.db, id);
    return c && !FINAL.includes(c.status);
  });
  const world = buildClashWorld(ctx, openClaims);
  const settings = autopilotSettingsOf(ctx);
  const subjects: ClashSubject[] = [...openClaims.map((claimId) => ({ kind: 'claim' as const, claimId })), ...units.map((u) => ({ kind: 'fleet_unit' as const, fleetUnitId: u.id }))];
  const summary: ClashRunSummary = { subjects: subjects.length, inserted: 0, resolved: 0, newBlocks: 0 };
  const newBlocks: Array<Parameters<typeof raiseClashReview>[1]> = [];
  for (const subject of subjects) {
    const { findings } = checkClashesIn(ctx, subject, world, settings);
    const res = ctx.db.transaction((tx) => persistFindings(ctx, tx, subject, findings));
    summary.inserted += res.inserted.length;
    summary.resolved += res.resolved.length;
    for (const f of res.inserted) if (f.status === 'open' && f.severity === 'block') newBlocks.push(f);
  }
  summary.newBlocks = newBlocks.length;
  for (const f of newBlocks) raiseClashReview(ctx, f);
  return summary;
}

/** Queue a `clash.check` (idempotent per subject per minute) — called when a claim, vehicle, party or driver changes. */
export function queueClashCheck(ctx: AppContext, subject: Extract<ClashSubject, { kind: 'claim' | 'fleet_unit' }>, createdBy: string): void {
  try {
    const id = subject.kind === 'claim' ? subject.claimId : subject.fleetUnitId;
    enqueueJob(ctx, {
      type: 'clash.check',
      payload: { subjectKind: subject.kind, id },
      ...(subject.kind === 'claim' ? { claimId: subject.claimId } : {}),
      idempotencyKey: `clash.check:${subject.kind}:${id}:${ctx.now().slice(0, 16)}`,
      createdBy,
    });
  } catch (err) {
    ctx.logger.warn('could not queue a clash check', { subject, error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Daily log (§I.9) — for ap-autopilot's autopilot/dailyLog.ts
// ---------------------------------------------------------------------------

export interface ClashLogLine {
  at: string;
  claimId?: string;
  reference?: string;
  agent: 'autopilot';
  text: string;
  ruleIds: string[];
  link: string;
}

/** The `clashes` daily-log section: findings that were new, overridden or resolved in [start, end). */
export function clashDailyLogLines(ctx: AppContext, bounds: { start: string; end: string }): ClashLogLine[] {
  const s = Date.parse(bounds.start);
  const e = Date.parse(bounds.end);
  const inDay = (iso?: string) => !!iso && Date.parse(iso) >= s && Date.parse(iso) < e;
  const lines: ClashLogLine[] = [];
  const refs = new Map<string, string>();
  const ref = (id?: string) => {
    if (!id) return undefined;
    if (!refs.has(id)) refs.set(id, ctx.repos.getClaim(ctx.db, id)?.reference ?? id);
    return refs.get(id);
  };
  for (const f of ctx.repos.listClashFindings(ctx.db, { changedSince: bounds.start })) {
    const link = f.claimId ? `/claims/${f.claimId}` : f.fleetUnitId ? `/fleet/clashes?unit=${f.fleetUnitId}` : '/fleet/clashes';
    const base = { agent: 'autopilot' as const, ruleIds: [f.code], link, ...(f.claimId ? { claimId: f.claimId, reference: ref(f.claimId)! } : {}) };
    if (inDay(f.firstSeenAt) && f.status !== 'overridden') lines.push({ ...base, at: f.firstSeenAt, text: `New ${f.severity} clash ${f.code}: ${f.message}` });
    if (f.status === 'overridden' && inDay(f.resolvedAt)) lines.push({ ...base, at: f.resolvedAt!, text: `Clash ${f.code} overridden by ${f.resolvedBy ?? 'a manager'}: ${f.resolutionNote ?? ''}`.trim() });
    if (f.status === 'resolved' && inDay(f.resolvedAt)) lines.push({ ...base, at: f.resolvedAt!, text: f.resolvedBy === 'system' ? `Clash ${f.code} no longer detected` : `Clash ${f.code} resolved by ${f.resolvedBy}: ${f.resolutionNote ?? ''}`.trim() });
    if (f.status === 'acknowledged' && inDay(f.resolvedAt)) lines.push({ ...base, at: f.resolvedAt!, text: `Clash ${f.code} acknowledged by ${f.resolvedBy}: ${f.resolutionNote ?? ''}`.trim() });
  }
  return lines.sort((a, b) => a.at.localeCompare(b.at));
}

/** A default period for a check without one: from now (or the given start) for the default hire days. */
export function defaultPeriod(ctx: AppContext, startAt?: string | null, expectedEndAt?: string | null): { startAt: string; expectedEndAt: string } {
  const start = startAt && Number.isFinite(Date.parse(startAt)) ? startAt : ctx.now();
  const end = expectedEndAt && Number.isFinite(Date.parse(expectedEndAt)) ? expectedEndAt : new Date(Date.parse(addCalendarDays(start, autopilotSettingsOf(ctx).projection.defaultHireDays))).toISOString();
  return { startAt: start, expectedEndAt: end };
}
