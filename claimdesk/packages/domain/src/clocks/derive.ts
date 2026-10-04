/**
 * deriveClocks(bundle, now): every Clock the chronology supports, derived from events.
 *
 * Rules:
 *  - Only events with `at <= now` are considered, so the function is a pure "state at time T".
 *  - running: now ≤ due and not met/stopped.  breached: now > due and not met in time (a late
 *    `metAt` is kept so the UI can say "met late").  met: the meeting event is ≤ due.
 *    stopped: a stopping event (e.g. payment in full) came before any meeting event.
 *    not_applicable: the forum or rule is not open on these facts, with the reason in `stoppedReason`.
 *  - Every clock carries `basis` exactly as the blueprint states it, `sourceEventId` where an event
 *    started it, and `attributableTo` (whose clock it is).
 *  - Ids are deterministic (`clk:<claimId>:<kind>:<source>`) so re-derivation is stable.
 */
import type { ClaimBundle, ClaimEvent, Clock, ClockKind, EventType, HireAgreement, ISODateTime } from '../types.js';
import {
  MS_PER_HOUR,
  addCalendarDays,
  addCalendarMonths,
  addWeeks,
  addWorkingDays,
  compareIso,
  isWorkingDay,
  isoToMs,
  londonDate,
  msToLondonIso,
  nextWorkingDay,
  toLondonIso,
} from '../calendar/index.js';
import { latePaymentTierStart, paidInFullAt } from '../gta/payment.js';
import { PROGRESS_CHECK_WD, isMonitoringTouch } from '../gta/monitoring.js';
import { clockDefinitions } from './definitions.js';

export const GTA_6_8_HIRES_FROM = '2026-03-16';
export const FOS_NOT_OPEN_REASON = 'third-party claimant is not an eligible complainant against the at-fault insurer (DISP 2.7)';

interface Ctx {
  bundle: ClaimBundle;
  now: ISODateTime;
  events: ClaimEvent[]; // ≤ now, sorted by at
  claimId: string;
}

interface Spec {
  kind: ClockKind;
  startsAt: ISODateTime;
  dueAt: ISODateTime;
  sourceEventId?: string;
  /** Extra id discriminator for multi-instance kinds. */
  instance?: string;
  metAt?: ISODateTime;
  stoppedAt?: ISODateTime;
  stoppedReason?: string;
  label?: string;
  basis?: string;
  attributableTo?: Clock['attributableTo'];
  /** Force a status (used for not_applicable and the silent-expiry 3.6 clock). */
  status?: Clock['status'];
}

const le = (a: ISODateTime, b: ISODateTime): boolean => compareIso(a, b) <= 0;
const lt = (a: ISODateTime, b: ISODateTime): boolean => compareIso(a, b) < 0;
const ge = (a: ISODateTime, b: ISODateTime): boolean => compareIso(a, b) >= 0;
const gt = (a: ISODateTime, b: ISODateTime): boolean => compareIso(a, b) > 0;

/** Status from the timeline. Exported for other engines that hold their own deadlines. */
export function clockStatus(now: ISODateTime, dueAt: ISODateTime, metAt?: ISODateTime, stoppedAt?: ISODateTime): Clock['status'] {
  if (metAt && le(metAt, dueAt) && (!stoppedAt || le(metAt, stoppedAt))) return 'met';
  if (stoppedAt && le(stoppedAt, now) && (!metAt || lt(stoppedAt, metAt))) return 'stopped';
  if (metAt) return 'breached'; // met, but late
  return gt(now, dueAt) ? 'breached' : 'running';
}

function build(ctx: Ctx, s: Spec): Clock {
  const def = clockDefinitions[s.kind];
  const status = s.status ?? clockStatus(ctx.now, s.dueAt, s.metAt, s.stoppedAt);
  const source = s.instance ?? s.sourceEventId ?? 'claim';
  const clock: Clock = {
    id: `clk:${ctx.claimId}:${s.kind}:${source}`,
    claimId: ctx.claimId,
    kind: s.kind,
    label: s.label ?? def.label,
    basis: s.basis ?? def.basis,
    startsAt: toLondonIso(s.startsAt),
    dueAt: toLondonIso(s.dueAt),
    status,
    attributableTo: s.attributableTo ?? def.attributableTo,
  };
  if (s.sourceEventId) clock.sourceEventId = s.sourceEventId;
  if (s.metAt && (status === 'met' || status === 'breached')) clock.metAt = toLondonIso(s.metAt);
  if (status === 'stopped' && s.stoppedAt) clock.stoppedAt = toLondonIso(s.stoppedAt);
  if ((status === 'stopped' || status === 'not_applicable') && s.stoppedReason) clock.stoppedReason = s.stoppedReason;
  return clock;
}

function first(ctx: Ctx, type: EventType, after?: ISODateTime, pred?: (e: ClaimEvent) => boolean): ClaimEvent | undefined {
  return ctx.events.find((e) => e.type === type && (!after || ge(e.at, after)) && (!pred || pred(e)));
}
function last(ctx: Ctx, type: EventType, pred?: (e: ClaimEvent) => boolean): ClaimEvent | undefined {
  const all = ctx.events.filter((e) => e.type === type && (!pred || pred(e)));
  return all[all.length - 1];
}
function all(ctx: Ctx, type: EventType, after?: ISODateTime): ClaimEvent[] {
  return ctx.events.filter((e) => e.type === type && (!after || ge(e.at, after)));
}
function plusHours(at: ISODateTime, h: number): ISODateTime {
  return msToLondonIso(isoToMs(at) + h * MS_PER_HOUR);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * When the hire(s) active at `at` ended, for the off-hire clocks.
 *  - 'none'      : no hire was active at `at` (nothing to off-hire) → no clock.
 *  - { endedAt } : the (latest) end among active hires, or undefined while still running.
 */
function hireEndAfter(ctx: Ctx, at: ISODateTime): 'none' | { endedAt?: ISODateTime; hireIds: string[] } {
  const hires = ctx.bundle.hire.filter((h) => le(h.startAt, ctx.now));
  if (hires.length === 0) {
    // No hire records: fall back to events.
    const started = first(ctx, 'hire_started');
    if (!started || gt(started.at, at)) return 'none';
    const ended = first(ctx, 'hire_ended', at);
    const endedBefore = ctx.events.some((e) => e.type === 'hire_ended' && lt(e.at, at));
    if (endedBefore && !ended) return 'none';
    return ended ? { endedAt: ended.at, hireIds: [] } : { hireIds: [] };
  }
  const active: HireAgreement[] = hires.filter((h) => le(h.startAt, at) && (!h.endAt || ge(h.endAt, at)));
  if (active.length === 0) return 'none';
  const ends = active.map((h) => (h.endAt && le(h.endAt, ctx.now) ? h.endAt : undefined));
  if (ends.some((e) => e === undefined)) return { hireIds: active.map((h) => h.id) };
  const latest = (ends as ISODateTime[]).sort(compareIso)[ends.length - 1]!;
  return { endedAt: latest, hireIds: active.map((h) => h.id) };
}

function earliestHireStart(ctx: Ctx): ISODateTime | undefined {
  const starts = ctx.bundle.hire.map((h) => h.startAt);
  const ev = first(ctx, 'hire_started');
  if (ev) starts.push(ev.at);
  if (starts.length === 0) return undefined;
  return starts.sort(compareIso)[0];
}

// ---------------------------------------------------------------------------------------------

export function deriveClocks(bundle: ClaimBundle, now: ISODateTime): Clock[] {
  const events = bundle.events.filter((e) => le(e.at, now)).sort((a, b) => compareIso(a.at, b.at));
  const ctx: Ctx = { bundle, now, events, claimId: bundle.claim.id };
  const clocks: Clock[] = [];
  const add = (s: Spec | undefined): void => {
    if (s) clocks.push(build(ctx, s));
  };

  // --- GTA 4.1: NCAF within 1 WD of agreeing services ---------------------------------------
  const agreed = first(ctx, 'services_agreed') ?? first(ctx, 'hire_started') ?? first(ctx, 'fnol');
  const ncaf = first(ctx, 'ncaf_sent');
  {
    const startsAt = agreed?.at ?? bundle.claim.openedAt;
    if (le(startsAt, now)) {
      const spec: Spec = { kind: 'gta_4_1_ncaf_1wd', startsAt, dueAt: addWorkingDays(startsAt, 1) };
      if (agreed) spec.sourceEventId = agreed.id;
      if (ncaf) spec.metAt = ncaf.at;
      add(spec);
    }
  }

  if (ncaf) {
    // --- GTA 4.2: handling reference within 5 WD of the NCAF -------------------------------
    const ref = first(ctx, 'handling_ref_received', ncaf.at);
    add({ kind: 'gta_4_2_handling_ref_5wd', startsAt: ncaf.at, dueAt: addWorkingDays(ncaf.at, 5), sourceEventId: ncaf.id, ...(ref ? { metAt: ref.at } : {}) });

    // --- GTA 3.6: insurer's first-notification window (expires silently) --------------------
    const due36 = addWorkingDays(ncaf.at, 5);
    const dispute = first(ctx, 'first_notification_dispute', ncaf.at);
    if (dispute && le(dispute.at, due36)) {
      add({
        kind: 'gta_3_6_first_notification_5wd',
        startsAt: ncaf.at,
        dueAt: due36,
        sourceEventId: ncaf.id,
        status: 'stopped',
        stoppedAt: dispute.at,
        stoppedReason: 'insurer asserted first notification within the 5-working-day window (GTA 3.6) — compare its NCAF date with ours',
      });
    } else {
      const expired = gt(now, due36);
      add({ kind: 'gta_3_6_first_notification_5wd', startsAt: ncaf.at, dueAt: due36, sourceEventId: ncaf.id, status: expired ? 'met' : 'running', ...(expired ? { metAt: due36 } : {}) });
    }

    // --- ICOBS 8.2.6: three months from first notification ----------------------------------
    const reply = ctx.events.find((e) => ge(e.at, ncaf.at) && (e.type === 'reduction_received' || e.type === 'pav_offer_received' || e.type === 'payment_received'));
    add({ kind: 'icobs_8_2_6_three_months', startsAt: ncaf.at, dueAt: addCalendarMonths(ncaf.at, 3), sourceEventId: ncaf.id, ...(reply ? { metAt: reply.at } : {}) });
  }

  // --- Intervention offers: written reply within 1 WD ----------------------------------------
  {
    const offerEvents = all(ctx, 'intervention_offer');
    const replyEvents = all(ctx, 'intervention_reply_sent');
    const consumedReplies = new Set<string>();
    const consumedOfferEvents = new Set<string>();
    const takeReply = (offerId: string | undefined, after: ISODateTime): ClaimEvent | undefined => {
      let r = offerId ? replyEvents.find((e) => str(e.data?.['offerId']) === offerId) : undefined;
      if (!r) r = replyEvents.find((e) => !consumedReplies.has(e.id) && !str(e.data?.['offerId']) && ge(e.at, after));
      if (r) consumedReplies.add(r.id);
      return r;
    };
    for (const offer of bundle.offers.filter((o) => le(o.receivedAt, now))) {
      const ev = offerEvents.find((e) => str(e.data?.['offerId']) === offer.id) ?? offerEvents.find((e) => !consumedOfferEvents.has(e.id) && compareIso(e.at, offer.receivedAt) === 0);
      if (ev) consumedOfferEvents.add(ev.id);
      const metAt = offer.replySentAt && le(offer.replySentAt, now) ? offer.replySentAt : takeReply(offer.id, offer.receivedAt)?.at;
      add({
        kind: 'intervention_reply_1wd',
        startsAt: offer.receivedAt,
        dueAt: addWorkingDays(offer.receivedAt, 1),
        ...(ev ? { sourceEventId: ev.id } : {}),
        instance: ev?.id ?? offer.id,
        label: `${clockDefinitions.intervention_reply_1wd.label} — ${offer.offerorName}`,
        ...(metAt ? { metAt } : {}),
      });
    }
    for (const ev of offerEvents.filter((e) => !consumedOfferEvents.has(e.id))) {
      const metAt = takeReply(str(ev.data?.['offerId']), ev.at)?.at;
      add({ kind: 'intervention_reply_1wd', startsAt: ev.at, dueAt: addWorkingDays(ev.at, 1), sourceEventId: ev.id, ...(metAt ? { metAt } : {}) });
    }
  }

  // --- Off-hire triggers (GTA 4.8 / 4.9 / 4.14) ------------------------------------------------
  const offHire = (kind: ClockKind, type: EventType, due: (at: ISODateTime) => ISODateTime): void => {
    const trigger = first(ctx, type);
    if (!trigger) return;
    const end = hireEndAfter(ctx, trigger.at);
    if (end === 'none') return;
    add({ kind, startsAt: trigger.at, dueAt: due(trigger.at), sourceEventId: trigger.id, ...(end.endedAt ? { metAt: end.endedAt } : {}) });
  };
  offHire('gta_4_8_offhire_repair_24h', 'repair_completed', (at) => plusHours(at, 24));
  offHire('gta_4_9_termination_1wd', 'insurer_termination_notice', (at) => addWorkingDays(at, 1));
  offHire('gta_4_14_offhire_tl_payment_5wd', 'tl_payment_received', (at) => addWorkingDays(at, 5));

  // --- GTA 4.10: authorisation check 3 WD after the estimate -------------------------------
  {
    const estimate = first(ctx, 'estimate_received') ?? first(ctx, 'report_issued');
    if (estimate) {
      const authorised = first(ctx, 'repair_authorised', estimate.at);
      const tl = first(ctx, 'total_loss_confirmed', estimate.at);
      add({
        kind: 'gta_4_10_authorisation_check_3wd',
        startsAt: estimate.at,
        dueAt: addWorkingDays(estimate.at, 3),
        sourceEventId: estimate.id,
        ...(authorised ? { metAt: authorised.at } : {}),
        ...(tl && !authorised ? { stoppedAt: tl.at, stoppedReason: 'total loss confirmed — no repair authorisation expected' } : {}),
      });
    }
  }

  // --- GTA 4.11: monitoring every 5 WD, next due check only ----------------------------------
  // The cadence is anchored to the last monitoring touch (or the repair start): the next check is
  // due 5 WD after the last contact. A missed check shows as breached until the next touch is
  // logged, and a touch always moves the clock on — it can never get stuck on a stale check.
  // `monitoringDiary` in the gta module lists the whole series with the same rule.
  {
    const started = first(ctx, 'repair_started');
    if (started) {
      const completed = first(ctx, 'repair_completed', started.at);
      const touches = ctx.events.filter((e) => isMonitoringTouch(e) && gt(e.at, started.at) && (!completed || le(e.at, completed.at)));
      const anchor = touches[touches.length - 1] ?? started;
      const k = touches.length + 1;
      const dueAt = addWorkingDays(anchor.at, PROGRESS_CHECK_WD);
      const spec: Spec = { kind: 'gta_4_11_monitoring_5wd', startsAt: anchor.at, dueAt, sourceEventId: started.id, label: `${clockDefinitions.gta_4_11_monitoring_5wd.label} #${k}` };
      if (completed && lt(completed.at, dueAt)) {
        spec.status = 'stopped';
        spec.stoppedAt = completed.at;
        spec.stoppedReason = 'repair completed';
      }
      add(spec);
    }
  }

  // --- Storage: collect-or-pay notice by report + 48h (insurer practice, live File 2) --------
  {
    const report = first(ctx, 'report_issued');
    if (report) {
      const dueAt = plusHours(report.at, 48);
      const notice = first(ctx, 'collect_or_pay_notice_sent', report.at);
      const openStorage = bundle.storage.filter((s) => le(s.startAt, report.at) && (!s.endAt || gt(s.endAt, report.at)));
      const spec = (instance: string, endAt?: ISODateTime): Spec => ({
        kind: 'storage_report_plus_48h',
        startsAt: report.at,
        dueAt,
        sourceEventId: report.id,
        instance: `${report.id}:${instance}`,
        ...(notice ? { metAt: notice.at } : {}),
        ...(!notice && endAt && le(endAt, dueAt) && le(endAt, now) ? { stoppedAt: endAt, stoppedReason: 'storage ended within 48 hours of the report' } : {}),
      });
      if (openStorage.length > 0) {
        for (const s of openStorage) add(spec(s.id, s.endAt));
      } else if (bundle.storage.length === 0) {
        const started = first(ctx, 'storage_started');
        const endedBefore = ctx.events.some((e) => e.type === 'storage_ended' && le(e.at, report.at));
        if (started && le(started.at, report.at) && !endedBefore) add(spec('events', first(ctx, 'storage_ended', report.at)?.at));
      }
    }
  }

  // --- Payment pack: GTA 6.7, 6.8.6, chasers 7/14/21, complaint 28 ----------------------------
  {
    const pack = last(ctx, 'payment_pack_sent') ?? last(ctx, 'letter_out', (e) => e.data?.['kind'] === 'invoice');
    if (pack) {
      const paidAt = paidInFullAt(bundle, now);
      const paid = paidAt && ge(paidAt, pack.at) ? paidAt : undefined;

      add({ kind: 'gta_6_7_settlement_1_month', startsAt: pack.at, dueAt: addCalendarMonths(pack.at, 1), sourceEventId: pack.id, ...(paid ? { metAt: paid } : {}) });

      const hireStart = earliestHireStart(ctx);
      const notApplicable = !hireStart
        ? 'no hire on the file — GTA 6.8.6 additions attach to hire charges'
        : londonDate(hireStart) < GTA_6_8_HIRES_FROM
          ? `hire commenced ${londonDate(hireStart)}, before 16 March 2026 — GTA 6.8.6 late-payment additions apply to hires from 16 March 2026 only`
          : undefined;
      // Tier boundaries are 00:00 London on day 31 / day 61 (pack day = day 0), the same instants
      // `latePaymentUplift` reports as day31At/day61At, so a letter and this clock agree.
      for (const [kind, days] of [
        ['gta_6_8_late_payment_10pc_day31', 31],
        ['gta_6_8_late_payment_20pc_day61', 61],
      ] as const) {
        add({
          kind,
          startsAt: pack.at,
          dueAt: latePaymentTierStart(pack.at, days),
          sourceEventId: pack.id,
          ...(paid ? { metAt: paid } : {}),
          ...(notApplicable ? { status: 'not_applicable', stoppedReason: notApplicable } : {}),
        });
      }

      // Chasers: nth chaser_sent after the pack; explicit data.chaser / data.day tags win.
      const chasers = all(ctx, 'chaser_sent', pack.at);
      const tagged = (n: number): ClaimEvent | undefined => chasers.find((e) => e.data?.['chaser'] === n || e.data?.['day'] === 7 * n);
      const pool = chasers.filter((e) => typeof e.data?.['chaser'] !== 'number' && typeof e.data?.['day'] !== 'number');
      for (const [kind, n] of [
        ['chaser_day_7', 1],
        ['chaser_day_14', 2],
        ['chaser_day_21', 3],
      ] as const) {
        const match = tagged(n) ?? pool[n - 1];
        add({
          kind,
          startsAt: pack.at,
          dueAt: addCalendarDays(pack.at, 7 * n),
          sourceEventId: pack.id,
          ...(match ? { metAt: match.at } : {}),
          ...(paid ? { stoppedAt: paid, stoppedReason: 'paid in full' } : {}),
        });
      }
      const complaint = first(ctx, 'complaint_sent', pack.at);
      add({
        kind: 'complaint_day_28',
        startsAt: pack.at,
        dueAt: addCalendarDays(pack.at, 28),
        sourceEventId: pack.id,
        ...(complaint ? { metAt: complaint.at } : {}),
        ...(paid ? { stoppedAt: paid, stoppedReason: 'paid in full' } : {}),
      });
    }
  }

  // --- DISP: final response within 8 weeks; FOS 6 months -------------------------------------
  {
    const complaint = first(ctx, 'complaint_sent');
    if (complaint) {
      const finalResponse = first(ctx, 'final_response_received', complaint.at);
      add({ kind: 'disp_final_response_8_weeks', startsAt: complaint.at, dueAt: addWeeks(complaint.at, 8), sourceEventId: complaint.id, ...(finalResponse ? { metAt: finalResponse.at } : {}) });
      if (finalResponse) {
        const againstOwnInsurer = finalResponse.data?.['againstOwnInsurer'] === true || complaint.data?.['againstOwnInsurer'] === true;
        const referral = ctx.events.find((e) => ge(e.at, finalResponse.at) && e.data?.['kind'] === 'fos_referral');
        add({
          kind: 'fos_referral_6_months',
          startsAt: finalResponse.at,
          dueAt: addCalendarMonths(finalResponse.at, 6),
          sourceEventId: finalResponse.id,
          ...(referral ? { metAt: referral.at } : {}),
          ...(againstOwnInsurer ? {} : { status: 'not_applicable', stoppedReason: FOS_NOT_OPEN_REASON }),
        });
      }
    }
  }

  // --- DSAR: one calendar month per request ---------------------------------------------------
  // ICO reading of Art 12(3): the corresponding date next month (month-end when shorter); if that
  // date is a weekend or bank holiday the controller has until the next working day. Alleging a
  // breach a day early in an ICO complaint would be wrong, so the clock rolls forward too.
  {
    const responses = all(ctx, 'dsar_response');
    const consumed = new Set<string>();
    for (const dsar of all(ctx, 'dsar_sent')) {
      let r = responses.find((e) => str(e.data?.['dsarId']) === dsar.id || str(e.data?.['dsarEventId']) === dsar.id);
      if (!r) r = responses.find((e) => !consumed.has(e.id) && !str(e.data?.['dsarId']) && !str(e.data?.['dsarEventId']) && ge(e.at, dsar.at));
      if (r) consumed.add(r.id);
      const recipient = str(dsar.data?.['recipient']);
      const monthLater = addCalendarMonths(dsar.at, 1);
      add({
        kind: 'dsar_1_month',
        startsAt: dsar.at,
        dueAt: isWorkingDay(monthLater) ? monthLater : nextWorkingDay(monthLater),
        sourceEventId: dsar.id,
        ...(recipient ? { label: `${clockDefinitions.dsar_1_month.label} — ${recipient}` } : {}),
        ...(r ? { metAt: r.at } : {}),
      });
    }
  }

  // --- CCTV preservation: 7 days from FNOL ----------------------------------------------------
  {
    const fnol = first(ctx, 'fnol');
    const startsAt = fnol?.at ?? bundle.claim.openedAt;
    if (le(startsAt, now)) {
      const request = first(ctx, 'cctv_request_sent');
      const noCctv = bundle.claim.accident.cctvAvailable === false && bundle.claim.accident.dashcamAvailable !== true;
      add({
        kind: 'cctv_preservation',
        startsAt,
        dueAt: addCalendarDays(startsAt, 7),
        ...(fnol ? { sourceEventId: fnol.id } : {}),
        ...(request ? { metAt: request.at } : {}),
        ...(noCctv && !request ? { status: 'not_applicable', stoppedReason: 'no CCTV or dashcam identified at FNOL — re-open if a camera is found' } : {}),
      });
    }
  }

  // --- Limitation -----------------------------------------------------------------------------
  {
    const issued = first(ctx, 'proceedings_issued');
    const settled = first(ctx, 'settled');
    const stop = issued ? { stoppedAt: issued.at, stoppedReason: 'proceedings issued' } : settled ? { stoppedAt: settled.at, stoppedReason: 'claim settled' } : {};
    const accident = bundle.claim.accident.occurredAt;
    add({ kind: 'limitation_tort_6y', startsAt: accident, dueAt: addCalendarMonths(accident, 72), ...stop });
    if (bundle.claim.accident.injuries === true) {
      add({ kind: 'limitation_pi_3y', startsAt: accident, dueAt: addCalendarMonths(accident, 36), label: 'refer out — personal injury', ...stop });
    }
    for (const h of bundle.hire) {
      const start = h.signedAt ?? h.startAt;
      if (le(start, now)) add({ kind: 'limitation_contract_6y', startsAt: start, dueAt: addCalendarMonths(start, 72), instance: h.id, label: `${clockDefinitions.limitation_contract_6y.label} — ${h.agreementNumber}`, ...stop });
    }
  }

  // --- Part 36 relevant period --------------------------------------------------------------
  {
    const judgment = first(ctx, 'judgment');
    const settled = first(ctx, 'settled');
    for (const type of ['part36_sent', 'part36_received'] as const) {
      for (const offer of all(ctx, type)) {
        const daysRaw = offer.data?.['relevantPeriodDays'];
        const days = typeof daysRaw === 'number' && daysRaw >= 21 ? daysRaw : 21;
        const met =
          type === 'part36_received'
            ? ctx.events.find((e) => ge(e.at, offer.at) && (e.data?.['kind'] === 'part36_response' || (e.type === 'settled' && e.data?.['part36EventId'] === offer.id)))
            : ctx.events.find((e) => ge(e.at, offer.at) && (e.data?.['kind'] === 'part36_accepted' || (e.type === 'settled' && e.data?.['part36EventId'] === offer.id)));
        const stopEv = [judgment, settled].filter((e): e is ClaimEvent => Boolean(e && ge(e.at, offer.at)) && e !== met).sort((a, b) => compareIso(a.at, b.at))[0];
        add({
          kind: 'part36_relevant_period_21_days',
          startsAt: offer.at,
          dueAt: addCalendarDays(offer.at, days),
          sourceEventId: offer.id,
          attributableTo: type === 'part36_received' ? 'ccguk' : 'insurer',
          label: `${clockDefinitions.part36_relevant_period_21_days.label} — ${type === 'part36_received' ? 'offer received, our response' : 'our offer, their acceptance'}`,
          ...(met ? { metAt: met.at } : {}),
          ...(stopEv ? { stoppedAt: stopEv.at, stoppedReason: stopEv.type === 'judgment' ? 'judgment entered' : 'claim settled' } : {}),
        });
      }
    }
  }

  // --- Default judgment: AoS/defence 14 days from service (28 for the defence if AoS filed) -----
  {
    const issued = first(ctx, 'proceedings_issued');
    if (issued) {
      const servedAt = str(issued.data?.['servedAt']) && le(str(issued.data?.['servedAt'])!, now) ? str(issued.data?.['servedAt'])! : issued.at;
      const aosEvent = ctx.events.find((e) => ge(e.at, issued.at) && e.data?.['kind'] === 'acknowledgment_of_service');
      const aosAt = str(issued.data?.['acknowledgmentFiledAt']) ?? aosEvent?.at;
      const defence = first(ctx, 'defence_received', issued.at);
      const judgment = first(ctx, 'judgment', issued.at);
      const settled = first(ctx, 'settled', issued.at);
      const stopEv = [judgment, settled].filter((e): e is ClaimEvent => Boolean(e)).sort((a, b) => compareIso(a.at, b.at))[0];
      add({
        kind: 'default_judgment_14_days',
        startsAt: servedAt,
        dueAt: addCalendarDays(servedAt, aosAt ? 28 : 14),
        sourceEventId: issued.id,
        label: aosAt ? 'Defence due (28 days — acknowledgment of service filed)' : clockDefinitions.default_judgment_14_days.label,
        ...(defence ? { metAt: defence.at } : {}),
        ...(stopEv && !defence ? { stoppedAt: stopEv.at, stoppedReason: stopEv.type === 'judgment' ? 'judgment entered' : 'claim settled' } : {}),
      });
    }
  }

  // --- Custom clocks carried on the bundle: re-evaluate against now -------------------------
  for (const c of bundle.clocks.filter((x) => x.kind === 'custom')) {
    const status = c.status === 'running' || c.status === 'breached' ? clockStatus(now, c.dueAt, c.metAt, c.stoppedAt) : c.status;
    clocks.push({ ...c, status });
  }

  return clocks;
}

/** Clocks that need action now: running clocks due within `withinHours` or already breached. */
export function dueClocks(clocks: Clock[], now: ISODateTime, withinHours = 24): Clock[] {
  const horizon = isoToMs(now) + withinHours * MS_PER_HOUR;
  return clocks
    .filter((c) => c.status === 'breached' || (c.status === 'running' && isoToMs(c.dueAt) <= horizon))
    .sort((a, b) => compareIso(a.dueAt, b.dueAt));
}
