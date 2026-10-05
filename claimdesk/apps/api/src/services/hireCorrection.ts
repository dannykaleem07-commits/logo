/**
 * Editable and backdated hire dates (docs/V03-MANAGER-MODE-HIRE-PRICING.md §C.3).
 *
 * The hire row is corrected in place; everything that recorded the old figures is append-only and is corrected with
 * new rows: a correcting `hire_started` / `hire_ended` (or `note`) event carries `data.correctsEventId`, and the
 * claimed hire amount is corrected with a superseding ledger row only when that is unambiguous. Invoiced, paid,
 * reduced or written-off rows are never touched — a warn flag asks for a corrected invoice or a credit note instead.
 * Every correction is audited as `hire.correct` with the reason.
 */
import type { FastifyRequest } from 'fastify';
import {
  calculateHire,
  fleetStatusFromHires,
  formatGBP,
  formatRegistration,
  HIRE_END_TRIGGER_TEXT,
  liveEvents,
  londonDate,
  londonParts,
  offHireDeadline,
  overlappingHires,
  type Claim,
  type ClaimEvent,
  type Clock,
  type FleetUnit,
  type HireAgreement,
  type HireCalculation,
  type HireEndTrigger,
  type Id,
  type ISODateTime,
  type LedgerKind,
  type Pence,
} from '@ccguk/domain';
import type { Actor, Db, HireCorrection } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { conflict, HttpError } from '../errors.js';
import type { CorrectHireBody } from '../schemas/hire.js';
import { recomputeClocks } from './claimView.js';
import { gtaRatesFor } from './kb.js';
import { gateFor, type OverrideGate, type OverrideTarget } from './override.js';
import { hirePricingFor, pricingColumns } from './hirePricing.js';

// ---------------------------------------------------------------------------
// Shared helpers (also used by routes/hire.ts)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ms = (iso: string): number => Date.parse(iso);
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** "1 Sep 10:00" (Europe/London); with `year` "1 Sep 2026 10:00". */
export function shortWhen(iso: ISODateTime, year = false): string {
  const p = londonParts(iso);
  return `${p.day} ${MONTHS[p.month - 1]}${year ? ` ${p.year}` : ''} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Entered late: the instant is more than 24 hours before it was recorded. */
export function isLateEntry(at: ISODateTime, recordedAt: ISODateTime): boolean {
  return ms(at) < ms(recordedAt) - DAY_MS;
}

export function endsBeforeStart(startAt: ISODateTime, endAt: ISODateTime | null | undefined): boolean {
  return !!endAt && ms(endAt) < ms(startAt);
}

/** Amber, never-blocking warnings about a hire's dates (§C.1). */
export function hireDateWarnings(claim: Claim, startAt: ISODateTime, endAt: ISODateTime | null | undefined, now: ISODateTime): string[] {
  const out: string[] = [];
  if (endAt && ms(endAt) > ms(now)) out.push(`The hire end (${shortWhen(endAt, true)}) is in the future: the hire will show as running until then.`);
  if (ms(startAt) < ms(claim.accident.occurredAt)) out.push(`The hire starts (${shortWhen(startAt, true)}) before the accident (${shortWhen(claim.accident.occurredAt, true)}).`);
  if (ms(startAt) < ms(now) - 365 * DAY_MS) out.push(`The hire starts more than a year ago (${shortWhen(startAt, true)}).`);
  if (endsBeforeStart(startAt, endAt)) out.push('The hire ends before it starts: it is charged as 0 days until the dates are corrected.');
  return out;
}

/** HIRE_END_BEFORE_START through the gate (class B: overridable in manager mode). */
export function refuseEndBeforeStart(gate: OverrideGate, startAt: ISODateTime, endAt: ISODateTime, target: OverrideTarget): void {
  gate.refuse(new HttpError(400, 'HIRE_END_BEFORE_START', `The hire end (${shortWhen(endAt, true)}) is before its start (${shortWhen(startAt, true)}).`, { startAt, endAt }), target);
}

export interface HireOverlapDetail {
  hireId: Id;
  agreementNumber: string;
  claimId: Id;
  claimReference?: string;
  startAt: ISODateTime;
  endAt?: ISODateTime;
}

/** HIRE_OVERLAP through the gate when the period clashes with another hire of the same car (class A). */
export function refuseOverlap(ctx: AppContext, gate: OverrideGate, unit: FleetUnit, period: { startAt: ISODateTime; endAt?: ISODateTime | null }, target: OverrideTarget, excludeId?: Id): void {
  const clashes = overlappingHires(period, ctx.repos.listHireForFleetUnit(ctx.db, unit.id), excludeId);
  if (!clashes.length) return;
  const overlaps: HireOverlapDetail[] = clashes.map((h) => {
    const ref = ctx.repos.getClaim(ctx.db, h.claimId)?.reference;
    return { hireId: h.id, agreementNumber: h.agreementNumber, claimId: h.claimId, ...(ref ? { claimReference: ref } : {}), startAt: h.startAt, ...(h.endAt ? { endAt: h.endAt } : {}) };
  });
  const reg = registrationOf(ctx, unit);
  const first = overlaps[0]!;
  const period1 = `from ${shortWhen(first.startAt, true)} ${first.endAt ? `to ${shortWhen(first.endAt, true)}` : '(still running)'}`;
  const more = overlaps.length > 1 ? ` and ${overlaps.length - 1} other hire${overlaps.length > 2 ? 's' : ''}` : '';
  gate.refuse(conflict('HIRE_OVERLAP', `${reg} is on hire ${first.agreementNumber} (claim ${first.claimReference ?? first.claimId}) ${period1}${more}.`, { overlaps }), target);
}

export function registrationOf(ctx: AppContext, unit: FleetUnit): string {
  const reg = ctx.repos.getVehicle(ctx.db, unit.vehicleId)?.registration;
  return reg ? formatRegistration(reg) : `Fleet unit ${unit.id}`;
}

/** Write the unit's status only through `fleetStatusFromHires`, and only when it changes. */
export function syncFleetStatus(ctx: AppContext, db: Db, unitId: Id, now: ISODateTime): FleetUnit['status'] {
  const unit = ctx.repos.requireFleetUnit(db, unitId);
  const next = fleetStatusFromHires(unit, ctx.repos.listHireForFleetUnit(db, unitId), now);
  if (next !== unit.status) ctx.repos.updateFleetUnit(db, unitId, { status: next });
  return next;
}

export const HIRE_DATES_INVALID = 'HIRE_DATES_INVALID';

/** Raise HIRE_DATES_INVALID while any hire on the claim ends before it starts; clear it (system, 'Dates corrected') once none does. */
export function syncDatesInvalidFlag(ctx: AppContext, db: Db, claimId: Id, agreementNumber?: string): void {
  const invalid = ctx.repos.listHire(db, claimId).filter((h) => endsBeforeStart(h.startAt, h.endAt));
  const claim = ctx.repos.requireClaim(db, claimId);
  const open = claim.flags.some((f) => f.code === HIRE_DATES_INVALID && !f.clearedAt);
  if (invalid.length && !open) {
    const which = invalid.map((h) => h.agreementNumber).join(', ') || agreementNumber || 'a hire';
    ctx.repos.addClaimFlag(db, claimId, { code: HIRE_DATES_INVALID, severity: 'warn', message: `Hire ${which} ends before it starts (recorded in manager mode): charged as 0 days until the dates are corrected.`, raisedBy: 'system' });
  } else if (!invalid.length && open) {
    ctx.repos.clearClaimFlag(db, claimId, HIRE_DATES_INVALID, ctx.repos.SYSTEM_ACTOR, 'Dates corrected');
  }
}

// ---------------------------------------------------------------------------
// PATCH /claims/:id/hire/:hireId
// ---------------------------------------------------------------------------

export interface HireFigures {
  startAt: string;
  endAt?: string;
  dailyRatePence: number;
  days: number;
  netPence: number;
  grossPence: number;
}

export type LedgerOutcome = { action: 'none' | 'superseded' | 'review' | 'invoiced'; entryId?: string; message: string };

export interface CorrectHireResponse {
  changed: boolean;
  hire: HireAgreement;
  calculation: HireCalculation;
  before: HireFigures;
  after: HireFigures;
  warnings: string[];
  ledger: LedgerOutcome;
  clocks: Clock[];
}

/**
 * The instant a hire is costed to: its end once that has arrived, otherwise now. An end set in the future (Edit dates)
 * is the expected return: the hire is still running and only the days so far are charged.
 */
export function hireCostedTo(h: Pick<HireAgreement, 'endAt'>, now: ISODateTime): ISODateTime {
  return h.endAt && ms(h.endAt) <= ms(now) ? h.endAt : now;
}

const INVOICED_KINDS: ReadonlySet<LedgerKind> = new Set(['invoiced', 'paid', 'interim_paid', 'reduced', 'written_off']);

function figures(h: Pick<HireAgreement, 'startAt' | 'endAt' | 'dailyRatePence'>, c: HireCalculation): HireFigures {
  return { startAt: h.startAt, ...(h.endAt ? { endAt: h.endAt } : {}), dailyRatePence: h.dailyRatePence, days: c.days, netPence: c.netPence, grossPence: c.grossPence };
}

const sameInstant = (a: string | undefined | null, b: string | undefined | null): boolean => (!a && !b) || (!!a && !!b && ms(a) === ms(b));

interface NextHire {
  startAt: ISODateTime;
  endAt?: ISODateTime;
  endTrigger?: HireEndTrigger;
  dailyRatePence: Pence;
  gtaGroup: string;
  clientGtaGroup?: string;
}

/**
 * The ledger after a correction that changed the net or VAT (`ledger: 'auto'`):
 *  - live invoiced/paid/interim_paid/reduced/written_off hire rows → warn flag HIRE_PERIOD_CHANGED_AFTER_INVOICE
 *    (those rows are never touched) → 'invoiced';
 *  - exactly one hire on the claim and exactly one live hire `claimed` row → a correcting `claimed` row that
 *    supersedes it → 'superseded';
 *  - otherwise live `claimed` hire rows → warn flag HIRE_LEDGER_REVIEW → 'review'; none → 'none'.
 */
export function correctHireLedger(
  ctx: AppContext,
  db: Db,
  input: { claimId: Id; hire: HireAgreement; before: HireCalculation; after: HireCalculation; reason: string; createdBy: Id | 'system'; now: ISODateTime; actor?: Actor },
): LedgerOutcome {
  const { claimId, hire, after, reason } = input;
  const live = ctx.repos.listLedger(db, claimId, { head: 'hire' });
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  const now = `now ${days(after.days)} ${formatGBP(after.netPence)}`;
  const sum = (kind: LedgerKind) => live.filter((e) => e.kind === kind).reduce((t, e) => t + e.amountPence, 0);
  const invoicedRows = live.filter((e) => INVOICED_KINDS.has(e.kind));
  if (invoicedRows.length) {
    // "was" is what was invoiced (the live rows), not the previous correction; a later correction updates this flag.
    const invoiced = sum('invoiced');
    const was = invoiced > 0 ? `invoiced ${formatGBP(invoiced)}` : `already ${[...new Set(invoicedRows.map((e) => e.kind.replace(/_/g, ' ')))].join(' and ')}`;
    ctx.repos.raiseOrUpdateClaimFlag(db, claimId, {
      code: 'HIRE_PERIOD_CHANGED_AFTER_INVOICE',
      severity: 'warn',
      message: `Hire ${hire.agreementNumber} changed after it was invoiced (${was}, ${now}): issue a corrected invoice or a credit note.`,
      raisedBy: 'system',
    });
    return { action: 'invoiced', message: 'Already invoiced — issue a corrected invoice or credit note' };
  }
  const claimed = live.filter((e) => e.kind === 'claimed');
  const hiresOnClaim = ctx.repos.listHire(db, claimId).length;
  if (hiresOnClaim === 1 && claimed.length === 1) {
    const old = claimed[0]!;
    const entry = ctx.repos.appendLedgerEntry(db, {
      claimId,
      head: 'hire',
      kind: 'claimed',
      amountPence: after.netPence,
      vatPence: after.vatPence,
      date: londonDate(input.now),
      description: `Credit hire ${days(after.days)} × ${formatGBP(after.dailyRatePence)} (corrected: ${reason})`,
      ...(old.counterpartyId ? { counterpartyId: old.counterpartyId } : {}),
      supersedesId: old.id,
      createdBy: input.createdBy,
    });
    // System-written ledger rows are audited like manual ones.
    if (input.actor) ctx.repos.appendAudit(db, { actor: input.actor, action: 'ledger.append', entity: 'ledger_entries', entityId: entry.id, after: { ...entry, reason: 'hire.correct' }, at: input.now });
    return { action: 'superseded', entryId: entry.id, message: 'Claimed hire amount corrected on the ledger' };
  }
  if (claimed.length > 0) {
    ctx.repos.raiseOrUpdateClaimFlag(db, claimId, {
      code: 'HIRE_LEDGER_REVIEW',
      severity: 'warn',
      message: `Hire ${hire.agreementNumber} dates or rate corrected (claimed on the ledger ${formatGBP(sum('claimed'))}, ${now}): check the claimed hire amount on the ledger.`,
      raisedBy: 'system',
    });
    return { action: 'review', message: 'Check the claimed hire amount on the ledger' };
  }
  return { action: 'none', message: 'No claimed hire amount on the ledger to correct' };
}

/** What identifies a hire's own chronology entries when they carry no data.hireId (older or seeded events). */
interface HireEventKey {
  hireId: Id;
  /** The hire's current start (for hire_started) or end (for hire_ended) — the event's `at`. */
  at: ISODateTime | undefined;
  agreementNumber: string;
  registration: string | undefined;
}

/**
 * The live event of `type` for this hire: by data.hireId; else, among live events of that type with no hireId, the
 * one at the hire's current start/end instant or whose summary names the agreement or the car; else the first live one
 * when this is the claim's only hire.
 */
function liveHireEvent(events: ClaimEvent[], type: 'hire_started' | 'hire_ended', key: HireEventKey, onlyHire: boolean): ClaimEvent | undefined {
  const ofType = events.filter((e) => e.type === type);
  const byId = ofType.find((e) => e.data?.['hireId'] === key.hireId);
  if (byId) return byId;
  const untagged = ofType.filter((e) => !e.data?.['hireId']);
  const reg = key.registration?.replace(/\s+/g, '').toUpperCase();
  const names = (e: ClaimEvent) => {
    const text = e.summary ?? '';
    return text.includes(key.agreementNumber) || (reg !== undefined && reg.length > 0 && text.replace(/\s+/g, '').toUpperCase().includes(reg));
  };
  const match = (key.at ? untagged.find((e) => sameInstant(e.at, key.at)) : undefined) ?? untagged.find(names);
  if (match) return match;
  return onlyHire ? ofType[0] : undefined;
}

export function correctHireDates(ctx: AppContext, request: FastifyRequest, claimId: Id, hireId: Id, body: CorrectHireBody): CorrectHireResponse {
  const claim = ctx.repos.requireClaim(ctx.db, claimId);
  const current = ctx.repos.requireHire(ctx.db, hireId);
  if (current.claimId !== claimId) throw conflict('WRONG_CLAIM', `Hire ${hireId} belongs to another claim`);
  const now = ctx.now();
  const rates = gtaRatesFor(ctx);
  const reason = body.reason;

  // 1. Merge.
  const nextEnd = body.endAt === undefined ? current.endAt : (body.endAt ?? undefined);
  const nextClient = body.clientGtaGroup === undefined ? current.clientGtaGroup : (body.clientGtaGroup ?? undefined);
  const next: NextHire = {
    startAt: body.startAt ?? current.startAt,
    ...(nextEnd ? { endAt: nextEnd } : {}),
    ...(nextEnd ? { endTrigger: body.endTrigger ?? current.endTrigger ?? 'manual' } : {}),
    dailyRatePence: body.dailyRatePence ?? current.dailyRatePence,
    gtaGroup: body.gtaGroup ?? current.gtaGroup,
    ...(nextClient ? { clientGtaGroup: nextClient } : {}),
  };
  const startChanged = !sameInstant(next.startAt, current.startAt);
  const endChanged = !sameInstant(next.endAt, current.endAt);
  const triggerChanged = (next.endTrigger ?? null) !== (current.endTrigger ?? null);
  const rateChanged = next.dailyRatePence !== current.dailyRatePence;
  const groupChanged = next.gtaGroup !== current.gtaGroup;
  const clientGroupChanged = (next.clientGtaGroup ?? null) !== (current.clientGtaGroup ?? null);

  const calcOf = (h: HireAgreement): HireCalculation => calculateHire(h, hireCostedTo(h, now), { rates, ...(h.clientGtaGroup ? { likeForLikeGroup: h.clientGtaGroup } : {}) });
  const beforeCalc = calcOf(current);

  if (!startChanged && !endChanged && !triggerChanged && !rateChanged && !groupChanged && !clientGroupChanged) {
    const f = figures(current, beforeCalc);
    return { changed: false, hire: current, calculation: beforeCalc, before: f, after: f, warnings: [], ledger: { action: 'none', message: 'Nothing changed' }, clocks: ctx.repos.listClocks(ctx.db, claimId) };
  }

  // 2. Guards (allocation is not re-checked on a date correction).
  const gate = gateFor(ctx, request);
  const target: OverrideTarget = { claimId, entity: 'hire_agreements', entityId: hireId };
  const invalid = endsBeforeStart(next.startAt, next.endAt);
  if (invalid) refuseEndBeforeStart(gate, next.startAt, next.endAt!, target);
  const unit = ctx.repos.requireFleetUnit(ctx.db, current.fleetUnitId);
  if (startChanged || endChanged) refuseOverlap(ctx, gate, unit, { startAt: next.startAt, endAt: next.endAt ?? null }, target, hireId);

  // 3. Re-price when the client group, the car-we-give group or the start date changed.
  const patch: HireCorrection = {};
  if (startChanged) patch.startAt = next.startAt;
  if (endChanged) patch.endAt = next.endAt ?? null;
  if (endChanged || triggerChanged) patch.endTrigger = next.endTrigger ?? null;
  if (rateChanged) patch.dailyRatePence = next.dailyRatePence;
  if (groupChanged) patch.gtaGroup = next.gtaGroup;
  if (clientGroupChanged) patch.clientGtaGroup = next.clientGtaGroup ?? null;
  if (clientGroupChanged || startChanged || groupChanged) {
    const pricedUnit: FleetUnit = { ...unit, gtaGroup: next.gtaGroup, dailyRatePence: current.fleetDailyRatePence ?? unit.dailyRatePence };
    if (clientGroupChanged && !next.clientGtaGroup) {
      // the client's group was cleared on purpose: keep it cleared, re-price the car we give only
      const cols = pricingColumns(hirePricingFor(ctx, claimId, pricedUnit, next.startAt));
      Object.assign(patch, { clientGtaGroup: null, clientGtaDailyRatePence: null, hireGtaDailyRatePence: cols.hireGtaDailyRatePence, fleetDailyRatePence: cols.fleetDailyRatePence, pricingNote: null });
    } else {
      const cols = pricingColumns(hirePricingFor(ctx, claimId, pricedUnit, next.startAt, next.clientGtaGroup));
      Object.assign(patch, cols);
    }
  }
  const afterPreview: HireAgreement = { ...current, ...stripNulls(patch) } as HireAgreement;
  if (patch.endAt === null) delete afterPreview.endAt;
  if (patch.endTrigger === null) delete afterPreview.endTrigger;
  if (patch.clientGtaGroup === null) delete afterPreview.clientGtaGroup;
  const afterCalc = calcOf(afterPreview);

  // 4. One transaction.
  const createdBy = request.user.id;
  const { hire, ledger } = ctx.db.transaction((tx) => {
    const h = ctx.repos.correctHire(tx, hireId, patch, { allowEndBeforeStart: invalid });
    const events = liveEvents(ctx.repos.listEvents(tx, claimId));
    const onlyHire = ctx.repos.listHire(tx, claimId).length === 1;
    const unitRow = ctx.repos.getFleetUnit(tx, h.fleetUnitId);
    const registration = unitRow ? ctx.repos.getVehicle(tx, unitRow.vehicleId)?.registration : undefined;
    const keyFor = (at: ISODateTime | undefined): HireEventKey => ({ hireId, at, agreementNumber: h.agreementNumber, registration });
    const append = (e: { type: ClaimEvent['type']; at: ISODateTime; summary: string; data: Record<string, unknown> }) =>
      ctx.repos.appendEvent(tx, { claimId, type: e.type, at: e.at, summary: e.summary, data: e.data, attributableTo: 'ccguk', evidenceIds: [], createdBy, recordedAt: now });
    const rateText = [
      rateChanged ? `daily rate corrected from ${formatGBP(current.dailyRatePence)} to ${formatGBP(next.dailyRatePence)}` : '',
      groupChanged ? `car we give group from ${current.gtaGroup} to ${next.gtaGroup}` : '',
      clientGroupChanged ? `client's car group from ${current.clientGtaGroup ?? 'none'} to ${next.clientGtaGroup ?? 'none'}` : '',
    ].filter(Boolean);
    const extra = rateText.length ? `; ${rateText.join('; ')}` : '';
    let dateEvent = false;
    if (startChanged) {
      const old = liveHireEvent(events, 'hire_started', keyFor(current.startAt), onlyHire);
      append({
        type: 'hire_started',
        at: next.startAt,
        summary: `Hire ${h.agreementNumber} start corrected from ${shortWhen(current.startAt)} to ${shortWhen(next.startAt)}${extra} — ${reason}`,
        data: { hireId, fleetUnitId: h.fleetUnitId, ...(old ? { correctsEventId: old.id } : {}), correction: true, reason, lateEntry: isLateEntry(next.startAt, now) },
      });
      dateEvent = true;
    }
    if (endChanged || (triggerChanged && next.endAt)) {
      const old = liveHireEvent(events, 'hire_ended', keyFor(current.endAt), onlyHire);
      const tail = dateEvent ? '' : extra;
      if (next.endAt) {
        const calc = calculateHire(h, next.endAt, { rates });
        const deadline = offHireDeadline(next.endTrigger ?? 'manual', next.endAt);
        append({
          type: 'hire_ended',
          at: next.endAt,
          summary: old
            ? `Hire ${h.agreementNumber} end corrected from ${current.endAt ? shortWhen(current.endAt) : 'running'} to ${shortWhen(next.endAt)} — ${HIRE_END_TRIGGER_TEXT[next.endTrigger ?? 'manual']}${tail} — ${reason}`
            : `Hire ${h.agreementNumber} ended — ${HIRE_END_TRIGGER_TEXT[next.endTrigger ?? 'manual']}${tail} — ${reason}`,
          data: {
            hireId,
            endTrigger: next.endTrigger,
            basis: deadline.basis,
            days: calc.days,
            netPence: calc.netPence,
            grossPence: calc.grossPence,
            ...(old ? { correctsEventId: old.id } : {}),
            correction: true,
            reason,
            lateEntry: isLateEntry(next.endAt, now),
          },
        });
        dateEvent = true;
      } else if (old) {
        append({
          type: 'note',
          at: now,
          summary: `Hire ${h.agreementNumber} re-opened — end removed${tail}: ${reason}`,
          data: { hireId, correctsEventId: old.id, correction: true, reason, reopened: true },
        });
        dateEvent = true;
      }
    }
    if (!dateEvent && rateText.length) {
      const text = rateText.join('; ');
      append({ type: 'note', at: now, summary: `Hire ${h.agreementNumber} ${text} — ${reason}`, data: { hireId, correction: true, reason } });
    }

    syncFleetStatus(ctx, tx, h.fleetUnitId, now);

    const moneyChanged = afterCalc.netPence !== beforeCalc.netPence || afterCalc.vatPence !== beforeCalc.vatPence;
    const ledgerOutcome: LedgerOutcome =
      body.ledger === 'skip'
        ? { action: 'none', message: 'Ledger left as it is (as asked)' }
        : moneyChanged
          ? correctHireLedger(ctx, tx, { claimId, hire: h, before: beforeCalc, after: afterCalc, reason, createdBy, now, actor: request.actor })
          : { action: 'none', message: 'Charges unchanged — ledger not touched' };

    syncDatesInvalidFlag(ctx, tx, claimId, h.agreementNumber);

    const fromTo = auditChanges(current, h, { startChanged, endChanged, triggerChanged, rateChanged, groupChanged, clientGroupChanged });
    ctx.repos.appendAudit(tx, {
      actor: request.actor,
      action: 'hire.correct',
      entity: 'hire_agreements',
      entityId: hireId,
      before: { ...fromTo.before, days: beforeCalc.days, netPence: beforeCalc.netPence },
      after: { ...fromTo.after, days: afterCalc.days, netPence: afterCalc.netPence, reason, claimId, ledger: ledgerOutcome.action, ...(ledgerOutcome.entryId ? { ledgerEntryId: ledgerOutcome.entryId } : {}) },
      at: now,
    });
    return { hire: h, ledger: ledgerOutcome };
  });

  // 5. Clocks.
  const clocks = recomputeClocks(ctx, claimId);
  const calculation = calcOf(hire);
  return {
    changed: true,
    hire,
    calculation,
    before: figures(current, beforeCalc),
    after: figures(hire, calculation),
    warnings: hireDateWarnings(claim, hire.startAt, hire.endAt, now),
    ledger,
    clocks,
  };
}

function stripNulls(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

function auditChanges(
  a: HireAgreement,
  b: HireAgreement,
  c: { startChanged: boolean; endChanged: boolean; triggerChanged: boolean; rateChanged: boolean; groupChanged: boolean; clientGroupChanged: boolean },
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const put = (k: keyof HireAgreement, on: boolean) => {
    if (!on) return;
    before[k] = a[k] ?? null;
    after[k] = b[k] ?? null;
  };
  put('startAt', c.startChanged);
  put('endAt', c.endChanged);
  put('endTrigger', c.endChanged || c.triggerChanged);
  put('dailyRatePence', c.rateChanged);
  put('gtaGroup', c.groupChanged);
  put('clientGtaGroup', c.clientGroupChanged);
  return { before, after };
}
