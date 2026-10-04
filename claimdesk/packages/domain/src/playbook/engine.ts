/**
 * nextActions(bundle, ctx) — the get-paid-faster engine (BLUEPRINT §7; playbooks.md §3).
 *
 * Clocks and gates are inputs (derived by the clocks and evidence modules; this module imports neither),
 * so the engine is a pure function of the bundle, the clocks, the gates and `now`. Each action says why in
 * one sentence, cites its basis, carries a due date and a priority, names the template that produces the
 * document, lists what blocks it, and — where it can — says what it is worth (money.md discipline).
 *
 * Only events with `at <= now` count. Priorities: 'now' (due has passed or breached), 'today' (due on the
 * London date of now), 'this_week' (within 7 days), 'scheduled' (later); a rule's defaultPriority is a floor.
 */
import type { ClaimBundle, ClaimEvent, ClaimFlag, Clock, ClockKind, EventType, GateResult, HireAgreement, ISODateTime, Pence, PlaybookAction } from '../types.js';
import { MS_PER_DAY, MS_PER_HOUR, addCalendarDays, addWorkingDays, calendarDaysBetween, compareIso, isoToMs, londonDate, msToLondonIso } from '../calendar/index.js';
import { formatGBP } from '../money.js';
import { COMPANY_NUMBER, REGISTERED_NAME, findRule, type PlaybookRule } from './rules.js';

export interface PlaybookContext {
  now: ISODateTime;
  clocks: Clock[];
  gates: GateResult[];
  /** Rule overrides (title, basis, templateId) from the knowledge base, keyed by code. */
  rules?: PlaybookRule[];
  /** Bank of England base rate (%) for the ICOBS interest estimate. Default 4 (assumed; confirm on the day). */
  baseRatePct?: number;
  /** Whether this insurer has ever paid CCGUK before (vendor-verification trigger). Undefined = unknown. */
  insurerPaidBefore?: boolean;
}

export const ASSUMED_BASE_RATE_PCT = 4;
export const CCTV_LOCATION_PATTERN = /\bjunction\b|\broundabout\b|\bhigh street\b|\bcrossroads\b|\btraffic lights?\b|\bsignals?\b|\bbox junction\b|\bbus lane\b/i;
export const PRIORITY_RANK: Record<PlaybookAction['priority'], number> = { now: 0, today: 1, this_week: 2, scheduled: 3 };

const ACTIVE: ReadonlySet<Clock['status']> = new Set(['running', 'breached']);
const le = (a: string, b: string): boolean => compareIso(a, b) <= 0;
const gt = (a: string, b: string): boolean => compareIso(a, b) > 0;

interface Ctx extends PlaybookContext {
  bundle: ClaimBundle;
  events: ClaimEvent[]; // ≤ now, sorted
  today: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function priorityFor(dueAt: ISODateTime | undefined, now: ISODateTime, floor?: PlaybookAction['priority']): PlaybookAction['priority'] {
  let p: PlaybookAction['priority'];
  if (!dueAt) p = floor ?? 'this_week';
  else if (le(dueAt, now)) p = 'now';
  else if (londonDate(dueAt) === londonDate(now)) p = 'today';
  else if (calendarDaysBetween(now, dueAt) <= 7) p = 'this_week';
  else p = 'scheduled';
  if (floor && PRIORITY_RANK[floor] < PRIORITY_RANK[p]) p = floor;
  return p;
}

/** Each 24-hour period started counts as a day (minimum 1). */
function daysBetween(startAt: ISODateTime, endAt: ISODateTime): number {
  return Math.max(1, Math.ceil((isoToMs(endAt) - isoToMs(startAt)) / MS_PER_DAY));
}

function grossOf(net: Pence, vatRate: number): Pence {
  return net + Math.round(net * vatRate);
}

/** Hire at risk: agreed period, or the period to `now` (minimum 14 days) for an open hire. */
export function hireAtRisk(bundle: ClaimBundle, now: ISODateTime): Pence {
  let total = 0;
  for (const h of bundle.hire) {
    const end = h.endAt ?? now;
    const days = Math.max(h.endAt ? 1 : 14, daysBetween(h.startAt, end));
    total += grossOf(days * h.dailyRatePence, h.vatRate);
  }
  if (total === 0) {
    const claimed = bundle.ledger.filter((e) => e.head === 'hire' && e.kind === 'claimed');
    total = claimed.reduce((a, e) => a + e.amountPence + (e.vatPence ?? 0), 0);
  }
  return total;
}

/** Claimed − paid − written off (gross), live entries dated ≤ now. */
export function outstandingBalance(bundle: ClaimBundle, now: ISODateTime, heads?: ReadonlySet<string>): Pence {
  const asOf = londonDate(now);
  const superseded = new Set(bundle.ledger.map((e) => e.supersedesId).filter((x): x is string => !!x));
  let claimed = 0;
  let paid = 0;
  for (const e of bundle.ledger) {
    if (superseded.has(e.id) || e.date > asOf) continue;
    if (heads && !heads.has(e.head)) continue;
    const g = (e.head === 'salvage' ? -1 : 1) * (e.amountPence + (e.vatPence ?? 0));
    if (e.kind === 'claimed' || e.kind === 'adjustment') claimed += g;
    else if (e.kind === 'paid' || e.kind === 'interim_paid' || e.kind === 'written_off') paid += g;
  }
  return claimed - paid;
}

function uncleared(flags: ClaimFlag[] | undefined, code: string): ClaimFlag | undefined {
  return (flags ?? []).find((f) => f.code === code && !f.clearedAt);
}

export function nextActions(bundle: ClaimBundle, ctxIn: PlaybookContext): PlaybookAction[] {
  if (bundle.claim.status === 'closed' || bundle.claim.status === 'declined') return [];
  const now = ctxIn.now;
  const ctx: Ctx = {
    ...ctxIn,
    bundle,
    events: bundle.events.filter((e) => le(e.at, now)).sort((a, b) => compareIso(a.at, b.at)),
    today: londonDate(now),
  };
  const actions: PlaybookAction[] = [];
  const add = (a: PlaybookAction | undefined): void => {
    if (a) actions.push(a);
  };

  const first = (type: EventType, after?: ISODateTime, pred?: (e: ClaimEvent) => boolean): ClaimEvent | undefined =>
    ctx.events.find((e) => e.type === type && (!after || compareIso(e.at, after) >= 0) && (!pred || pred(e)));
  const last = (type: EventType): ClaimEvent | undefined => {
    const all = ctx.events.filter((e) => e.type === type);
    return all[all.length - 1];
  };
  const clocksOf = (kind: ClockKind, statuses: ReadonlySet<Clock['status']> = ACTIVE): Clock[] => ctx.clocks.filter((c) => c.kind === kind && statuses.has(c.status));
  const gate = (name: GateResult['gate']): GateResult | undefined => ctx.gates.find((g) => g.gate === name);
  const nonGreenGates = (): string[] => ctx.gates.filter((g) => g.status !== 'green').map((g) => g.gate);
  const rule = (code: string): PlaybookRule => findRule(code, ctx.rules);

  const make = (code: string, fields: { why: string; dueAt?: ISODateTime; priority?: PlaybookAction['priority']; blockedBy?: string[]; valuePence?: Pence; extraBasis?: string[]; templateId?: string | null; titleSuffix?: string }): PlaybookAction => {
    const r = rule(code);
    const action: PlaybookAction = {
      code,
      title: fields.titleSuffix ? `${r.title} — ${fields.titleSuffix}` : r.title,
      why: fields.why,
      basis: [...r.basis, ...(fields.extraBasis ?? [])],
      priority: fields.priority ?? priorityFor(fields.dueAt, now, r.defaultPriority ?? r.priority),
    };
    if (fields.dueAt) action.dueAt = fields.dueAt;
    const templateId = fields.templateId === undefined ? (r.templateId ?? undefined) : fields.templateId === null ? undefined : fields.templateId;
    if (templateId) action.templateId = templateId;
    if (fields.blockedBy && fields.blockedBy.length > 0) action.blockedBy = fields.blockedBy;
    if (fields.valuePence !== undefined && fields.valuePence > 0) action.valuePence = fields.valuePence;
    return action;
  };

  const fnol = first('fnol');
  const fnolAt = fnol?.at ?? bundle.claim.openedAt;
  const hireValue = hireAtRisk(bundle, now);
  const outstanding = outstandingBalance(bundle, now);
  const openHires: HireAgreement[] = bundle.hire.filter((h) => le(h.startAt, now) && (!h.endAt || gt(h.endAt, now)));
  const hireEnded = bundle.hire.length > 0 && bundle.hire.every((h) => !!h.endAt && le(h.endAt, now));
  const settled = !!first('settled');

  // --- 1. SEND_NCAF ------------------------------------------------------------------------------
  const ncaf = first('ncaf_sent');
  if (!ncaf) {
    const clock = clocksOf('gta_4_1_ncaf_1wd')[0];
    const agreed = first('services_agreed') ?? first('hire_started') ?? fnol;
    const dueAt = clock?.dueAt ?? addWorkingDays(agreed?.at ?? bundle.claim.openedAt, 1);
    add(
      make('SEND_NCAF', {
        why: 'The New Claim Advice Form within 1 working day of agreeing services starts the insurer’s GTA 4.2 / 3.6 clocks and the ICOBS 8.2.6 three-month clock, and fixes the notification date for the period argument.',
        dueAt,
        valuePence: hireValue,
      }),
    );
  }

  // --- 2. REQUEST_HANDLING_REF ---------------------------------------------------------------------
  if (ncaf && !first('handling_ref_received', ncaf.at) && !bundle.claim.atFaultInsurerRef) {
    const clock = clocksOf('gta_4_2_handling_ref_5wd')[0];
    const dueAt = clock?.dueAt ?? addWorkingDays(ncaf.at, 5);
    add(
      make('REQUEST_HANDLING_REF', {
        why: `The insurer should give its handling centre and reference within 5 working days of the NCAF sent ${londonDate(ncaf.at)}; without a reference every later letter is unmatched and the chronology cannot show insurer delay.`,
        dueAt,
      }),
    );
  }

  // --- 3. REQUEST_CCTV -----------------------------------------------------------------------------
  {
    const acc = bundle.claim.accident;
    const hasFootage = bundle.evidence.some((e) => e.kind === 'cctv' || e.kind === 'dashcam');
    const locationTrigger = CCTV_LOCATION_PATTERN.test(`${acc.location} ${acc.circumstances}`);
    const dashcamOnly = acc.dashcamAvailable === true && acc.cctvAvailable !== true && !locationTrigger;
    if ((acc.cctvAvailable === true || acc.dashcamAvailable === true || locationTrigger) && !first('cctv_request_sent') && !hasFootage) {
      const clock = clocksOf('cctv_preservation')[0];
      const dueAt = clock?.dueAt ?? addCalendarDays(acc.occurredAt, 7);
      const what = [acc.cctvAvailable && 'CCTV', acc.dashcamAvailable && 'dashcam', !acc.cctvAvailable && locationTrigger && 'council / TfL / premises CCTV at a junction, roundabout or high street'].filter(Boolean).join(', ');
      const windowClosed = le(dueAt, now);
      const lead = dashcamOnly
        ? windowClosed
          ? `The 7-day window for the dashcam original closed on ${londonDate(dueAt)} — obtain the original file (hashed) immediately`
          : 'Obtain the dashcam original file (hashed) within 7 days'
        : windowClosed
          ? `The 7-day window from the accident on ${londonDate(acc.occurredAt)} closed on ${londonDate(dueAt)} — send the preservation request for ${what} immediately; footage may still exist`
          : `Send the preservation request for ${what} within 7 days of the accident on ${londonDate(acc.occurredAt)}`;
      add(
        make('REQUEST_CCTV', {
          why: `${lead}: footage is overwritten within weeks and it is the single highest-value action on a disputed-liability file.`,
          dueAt,
          valuePence: hireValue,
          ...(dashcamOnly ? { templateId: null } : {}),
        }),
      );
    }
  }

  // --- 4. REPLY_TO_INTERVENTION_OFFER (never blocked, always 'now') ---------------------------------
  for (const offer of bundle.offers.filter((o) => le(o.receivedAt, now) && !o.replySentAt)) {
    const clock = ctx.clocks.find((c) => c.kind === 'intervention_reply_1wd' && (c.id.endsWith(`:${offer.id}`) || c.label.endsWith(offer.offerorName)) && ACTIVE.has(c.status));
    const dueAt = clock?.dueAt ?? addWorkingDays(offer.receivedAt, 1);
    add(
      make('REPLY_TO_INTERVENTION_OFFER', {
        titleSuffix: `${offer.offerorName} (${londonDate(offer.receivedAt)})`,
        why: `${offer.offerorName}’s offer received ${londonDate(offer.receivedAt)}${offer.dailyRatePence ? ` at ${formatGBP(offer.dailyRatePence)}/day` : ''} has no written reply: an unanswered offer is the mitigation failure that loses hire (Copley v Lawn; Opoku v Tintas), so reply with reasons within 1 working day.`,
        dueAt,
        priority: 'now',
        valuePence: hireValue,
      }),
    );
  }

  // --- 5. COLLECT_IMPECUNIOSITY_EVIDENCE ---------------------------------------------------------
  {
    const g = gate('impecuniosity');
    if (g && g.status !== 'green') {
      const futureHire = bundle.hire.filter((h) => gt(h.startAt, now)).sort((a, b) => compareIso(a.startAt, b.startAt))[0];
      const dueAt = futureHire ? futureHire.startAt : openHires.length > 0 || hireEnded ? now : addWorkingDays(now, 2);
      add(
        make('COLLECT_IMPECUNIOSITY_EVIDENCE', {
          why: `Impecuniosity gate is ${g.status} (${g.missing.join('; ') || 'items missing'}): the claimant must plead and prove it (Diriye v Bojaj), so the statement of means, 3 months’ bank statements and income evidence are collected ${futureHire ? 'before the hire starts' : 'now, before any pleading'}.`,
          dueAt,
          priority: futureHire ? priorityFor(dueAt, now, 'this_week') : 'now',
          valuePence: hireValue,
        }),
      );
    }
  }

  // --- 6. FIX_ENFORCEABILITY -----------------------------------------------------------------------
  {
    const g = gate('enforceability');
    if (g && g.status !== 'green' && bundle.hire.length > 0) {
      const futureHire = bundle.hire.filter((h) => gt(h.startAt, now)).sort((a, b) => compareIso(a.startAt, b.startAt))[0];
      const dueAt = futureHire ? futureHire.startAt : now;
      add(
        make('FIX_ENFORCEABILITY', {
          why: `Enforceability gate is ${g.status} (${g.missing.join('; ') || 'items missing'}): an agreement that fails the cancellation regulations or the CCA recovers nothing (W v Veolia; Dimond v Lovell), so the whole hire of ${formatGBP(hireValue)} is at risk until cured.`,
          dueAt,
          priority: futureHire ? priorityFor(dueAt, now, 'this_week') : 'now',
          valuePence: hireValue,
        }),
      );
    }
  }

  // --- 7. SEND_COLLECT_OR_PAY ----------------------------------------------------------------------
  {
    const report = first('report_issued');
    if (report) {
      const openStorage = bundle.storage.filter((s) => le(s.startAt, now) && (!s.endAt || gt(s.endAt, now)));
      const notice = first('collect_or_pay_notice_sent', report.at);
      if (openStorage.length > 0 && !notice) {
        const clock = clocksOf('storage_report_plus_48h')[0];
        const dueAt = clock?.dueAt ?? msToLondonIso(isoToMs(report.at) + 48 * MS_PER_HOUR);
        const sinceReport = Math.max(0, calendarDaysBetween(report.at, now));
        const atRisk = openStorage.reduce((a, s) => a + grossOf(Math.max(1, sinceReport) * s.dailyRatePence, s.vatRate), 0);
        add(
          make('SEND_COLLECT_OR_PAY', {
            why: `The engineer’s report issued ${londonDate(report.at)} and storage is still running: insurers cap storage at report + 48 hours (live File 2), so the collect-or-pay notice makes every further day the insurer’s choice.`,
            dueAt,
            valuePence: atRisk,
          }),
        );
      }
    }
  }

  // --- 8. SEND_DELAY_NOTICE -----------------------------------------------------------------------
  {
    const breached410 = clocksOf('gta_4_10_authorisation_check_3wd', new Set(['breached']))[0];
    const breached411 = clocksOf('gta_4_11_monitoring_5wd', new Set(['breached']))[0];
    const delayEvent = last('repair_delay');
    const noticeAfterDelay = delayEvent ? ctx.events.some((e) => compareIso(e.at, delayEvent.at) >= 0 && (e.type === 'letter_out' || e.type === 'email_out') && str(e.data?.['kind']) === 'delay_notice') : false;
    const trigger = breached410 ?? breached411 ?? (delayEvent && !noticeAfterDelay ? delayEvent : undefined);
    if (trigger && openHires.length > 0) {
      const reason = breached410 ? `repair authorisation is overdue (GTA 4.10 check due ${londonDate(breached410.dueAt)})` : breached411 ? `the GTA 4.11 monitoring check due ${londonDate(breached411.dueAt)} was missed` : `a repair delay was logged on ${londonDate(delayEvent!.at)}`;
      add(
        make('SEND_DELAY_NOTICE', {
          why: `Hire is running and ${reason}: a dated delay notice puts the delay on the insurer’s side of the chronology, which is what wins the period argument.`,
          dueAt: now,
          valuePence: openHires.reduce((a, h) => a + grossOf(h.dailyRatePence, h.vatRate), 0),
        }),
      );
    }
  }

  // --- 9. END_HIRE_NOW ----------------------------------------------------------------------------
  if (openHires.length > 0) {
    const offHire = (['gta_4_8_offhire_repair_24h', 'gta_4_9_termination_1wd', 'gta_4_14_offhire_tl_payment_5wd'] as const).flatMap((k) => clocksOf(k)).sort((a, b) => compareIso(a.dueAt, b.dueAt))[0];
    if (offHire) {
      const dailyGross = openHires.reduce((a, h) => a + grossOf(h.dailyRatePence, h.vatRate), 0);
      const daysOver = Math.max(0, calendarDaysBetween(offHire.dueAt, now));
      add(
        make('END_HIRE_NOW', {
          why: `${offHire.label} — the off-hire trigger has fired and the hire is still open; every day past ${offHire.dueAt} (${formatGBP(dailyGross)}/day) is unrecoverable on the GTA benchmark and is the live-file failure (lesson d).`,
          dueAt: offHire.dueAt,
          priority: offHire.status === 'breached' ? 'now' : priorityFor(offHire.dueAt, now, 'today'),
          valuePence: dailyGross * Math.max(1, daysOver),
        }),
      );
    }
  }

  // --- 10. SEND_PAYMENT_PACK ----------------------------------------------------------------------
  const pack = last('payment_pack_sent');
  if (hireEnded && !pack && !settled) {
    const hireEnd = bundle.hire.map((h) => h.endAt!).sort(compareIso)[bundle.hire.length - 1]!;
    // No gate results at all means the gates have not been evaluated — unknown is not green (ARCHITECTURE rule 5).
    const blocked = ctx.gates.length === 0 ? ['gates_not_evaluated'] : nonGreenGates();
    const blockedText =
      ctx.gates.length === 0
        ? ', but the evidence gates have not been evaluated — run the gate check before the pack goes'
        : blocked.length > 0
          ? `, but ${blocked.length} gate${blocked.length === 1 ? ' is' : 's are'} not green (${blocked.join(', ')}) and a pack sent before they are is the pack that gets reduced`
          : '';
    add(
      make('SEND_PAYMENT_PACK', {
        why: `Hire ended ${londonDate(hireEnd)}: a clean payment pack (covering letter, mitigation questionnaire, advice form, hire period validation form, engineer’s report, storage and recovery accounts) starts the one-month settlement benchmark${blockedText}.`,
        dueAt: addWorkingDays(hireEnd, 1),
        blockedBy: blocked,
        valuePence: outstanding > 0 ? outstanding : hireValue,
      }),
    );
  }

  // --- 11. SPLIT_HEADS_INTERIM ---------------------------------------------------------------------
  {
    const reduction = ctx.events
      .filter((e) => e.type === 'reduction_received')
      .reverse()
      .find((e) => {
        const heads = e.data?.['disputedHeads'];
        return Array.isArray(heads) && heads.length === 1 && heads[0] === 'hire';
      });
    if (reduction && !settled) {
      const undisputedHeads = new Set(['repair', 'pav', 'salvage', 'diminution', 'recovery', 'storage', 'engineer_fee', 'excess', 'loss_of_use', 'personal_effects', 'loss_of_earnings', 'travel', 'misc']);
      const undisputed = outstandingBalance(bundle, now, undisputedHeads);
      if (undisputed > 0) {
        const litigated = !!first('proceedings_issued');
        add(
          make('SPLIT_HEADS_INTERIM', {
            why: `The reduction received ${londonDate(reduction.at)} disputes hire only, so ${formatGBP(undisputed)} of undisputed heads is payable now${litigated ? ' and an interim payment application under CPR 25.20–25.26 is open' : ' (interim payment under CPR 25.20–25.26 once litigated)'} — use the chaser template with a split-heads note, and keep hire in the schedule at full value.`,
            dueAt: addWorkingDays(reduction.at, 1),
            valuePence: undisputed,
          }),
        );
      }
    }
  }

  // --- 12. CHASER_7 / 14 / 21 and COMPLAINT_28 ---------------------------------------------------
  if (!settled) {
    const chaserKinds = [
      ['chaser_day_7', 'CHASER_7'],
      ['chaser_day_14', 'CHASER_14'],
      ['chaser_day_21', 'CHASER_21'],
    ] as const;
    const nextChaser = chaserKinds.map(([kind, code]) => ({ code, clock: clocksOf(kind)[0] })).find((x) => x.clock);
    if (nextChaser?.clock) {
      const c = nextChaser.clock;
      const n = nextChaser.code === 'CHASER_7' ? 1 : nextChaser.code === 'CHASER_14' ? 2 : 3;
      const escalate = n === 1 ? 'the handler' : n === 2 ? 'the team leader' : 'the claims manager';
      add(
        make(nextChaser.code, {
          why: `${formatGBP(outstanding)} remains unpaid ${calendarDaysBetween(c.startsAt, now)} days after the payment pack of ${londonDate(c.startsAt)}: chaser ${n} to ${escalate}, with the complaint at day 28 named as the next step.`,
          dueAt: c.dueAt,
          valuePence: outstanding,
        }),
      );
    }
    const complaint = clocksOf('complaint_day_28')[0];
    if (complaint) {
      add(
        make('COMPLAINT_28', {
          why: `Unpaid 28 days after the pack of ${londonDate(complaint.startsAt)}: a formal complaint under DISP 1 citing ICOBS 8.1 and 8.2 starts the eight-week final-response clock and costs the insurer compliance time — never threaten the FOS to an at-fault insurer (DISP 2.7: the claimant is not an eligible complainant).`,
          dueAt: complaint.dueAt,
          valuePence: outstanding,
        }),
      );
    }
  }

  // --- 13. SEND_DSAR ------------------------------------------------------------------------------
  {
    const allegation = ctx.events
      .filter((e) => ['letter_in', 'email_in', 'call', 'reduction_received', 'note', 'final_response_received'].includes(e.type))
      .reverse()
      .find((e) => e.data?.['allegedOffer'] === true || ['offer_ignored', 'intervention_offer_ignored', 'alleged_offer'].includes(str(e.data?.['reason']) ?? ''));
    if (allegation && !first('dsar_sent', allegation.at)) {
      add(
        make('SEND_DSAR', {
          why: `On ${londonDate(allegation.at)} the insurer alleged an intervention offer that is not in the register: a DSAR for the call recordings, notes and offer record (one month to respond) either produces the offer or proves it was never made.`,
          dueAt: addWorkingDays(allegation.at, 1),
          valuePence: hireValue,
        }),
      );
    }
  }

  // --- 14. ICOBS_INTEREST_CLAIM --------------------------------------------------------------------
  {
    const icobs = clocksOf('icobs_8_2_6_three_months', new Set(['breached']))[0];
    if (icobs && !settled && outstanding > 0) {
      const base = ctx.baseRatePct ?? ASSUMED_BASE_RATE_PCT;
      const rate = base + 4;
      const days = Math.max(0, calendarDaysBetween(icobs.dueAt, now));
      const estimate = Math.round((outstanding * rate * days) / 100 / 365);
      add(
        make('ICOBS_INTEREST_CLAIM', {
          why: `The insurer gave no reasoned offer or reply within three months of notification (due ${londonDate(icobs.dueAt)}): interest at base + 4% (${rate}% with base ${base}%${ctx.baseRatePct === undefined ? ', assumed — confirm' : ''}) on ${formatGBP(outstanding)} for ${days} days is about ${formatGBP(estimate)}, claimable once ICOBS 8.2.1R scope is confirmed.`,
          dueAt: addWorkingDays(now, 5),
          valuePence: estimate,
          extraBasis: ['Scope caveat: ICOBS 8.2.1R to be confirmed (BLUEPRINT §10)'],
        }),
      );
    }
  }

  // --- 15. LETTER_BEFORE_CLAIM ---------------------------------------------------------------------
  {
    const complaintSent = first('complaint_sent');
    const disp = clocksOf('disp_final_response_8_weeks', new Set(['breached']))[0];
    const finalResponse = complaintSent ? first('final_response_received', complaintSent.at) : undefined;
    const trigger = disp ? { at: disp.dueAt, reason: `the eight-week final-response period expired ${londonDate(disp.dueAt)}` } : finalResponse ? { at: finalResponse.at, reason: `the final response of ${londonDate(finalResponse.at)} did not settle the claim` } : undefined;
    if (trigger && !settled && outstanding > 0 && !first('letter_before_claim_sent') && !first('proceedings_issued')) {
      add(
        make('LETTER_BEFORE_CLAIM', {
          why: `${trigger.reason} and ${formatGBP(outstanding)} remains unpaid: a Practice Direction-compliant letter before claim, drafted for the claimant to send as litigant in person, is the next rung and the last one before issue.`,
          dueAt: addWorkingDays(trigger.at, 5),
          valuePence: outstanding,
        }),
      );
    }
  }

  // --- 16. PART36_OFFER ---------------------------------------------------------------------------
  {
    const issued = first('proceedings_issued');
    if (issued && !first('part36_sent', issued.at) && !settled && !first('judgment')) {
      add(
        make('PART36_OFFER', {
          why: `Proceedings were issued ${londonDate(issued.at)}: a claimant’s Part 36 offer (relevant period 21 days) at or just under the schedule total puts the CPR 36.17(4) consequences on the insurer — drafted for the claimant or solicitor to serve.`,
          dueAt: addCalendarDays(issued.at, 7),
          valuePence: outstanding,
        }),
      );
    }
  }

  // --- 17. DEFAULT_JUDGMENT -----------------------------------------------------------------------
  {
    const dj = clocksOf('default_judgment_14_days', new Set(['breached']))[0];
    if (dj && !first('defence_received', dj.startsAt) && !first('judgment') && !settled) {
      add(
        make('DEFAULT_JUDGMENT', {
          why: `No acknowledgment of service or defence by ${dj.dueAt}: the claimant (or instructed solicitor) may request default judgment under CPR 12.3 — CCGUK prepares the request and the schedule; the claimant files it.`,
          dueAt: dj.dueAt,
          priority: 'now',
          valuePence: outstanding,
        }),
      );
    }
  }

  // --- 18. VENDOR_VERIFICATION_PACK ----------------------------------------------------------------
  {
    const alreadySent = ctx.events.some((e) => (e.type === 'letter_out' || e.type === 'email_out') && str(e.data?.['kind']) === 'vendor_verification_pack') || bundle.documents.some((d) => d.templateId === 'letter.vendor_verification_pack' && (d.status === 'sent' || d.status === 'approved'));
    const bankValidation = ctx.events
      .filter((e) => e.type === 'reduction_received' || e.type === 'note' || e.type === 'email_in' || e.type === 'letter_in' || e.type === 'call')
      .reverse()
      .find((e) => ['bank_validation', 'bank_details_not_validated', 'vendor_verification'].includes(str(e.data?.['reason']) ?? ''));
    const settlementClock = clocksOf('gta_6_7_settlement_1_month', new Set(['breached']))[0];
    const neverPaid = pack && settlementClock && !first('payment_received', pack.at) && ctx.insurerPaidBefore === false;
    const trigger = bankValidation ?? (neverPaid ? settlementClock : undefined);
    if (trigger && !alreadySent && !settled) {
      const at = 'at' in trigger ? trigger.at : trigger.dueAt;
      add(
        make('VENDOR_VERIFICATION_PACK', {
          why: `${bankValidation ? `The insurer reported on ${londonDate(bankValidation.at)} that CCGUK’s bank details could not be validated` : `No payment a month after the pack from an insurer that has never paid CCGUK before`}: send the vendor-verification pack — bank letter on bank letterhead in the exact registered name "${REGISTERED_NAME}", certificate of incorporation (${COMPANY_NUMBER}), proof of registered office and director ID — so Confirmation of Payee returns a full match; never send legacy details.`,
          dueAt: addWorkingDays(at, 1),
          valuePence: outstanding,
        }),
      );
    }
  }

  // --- 19. REFER_INJURY ---------------------------------------------------------------------------
  if (bundle.claim.accident.injuries === true && !bundle.claim.injuryReferral) {
    add(
      make('REFER_INJURY', {
        why: 'Injury was reported at FNOL: refer the personal injury element to a PI solicitor with no referral fee (LASPO 2012 ss.56–60) and log it; CCGUK continues the damage-only claim and gives no advice on the injury.',
        dueAt: addWorkingDays(fnolAt, 1),
      }),
    );
  }

  // --- 20. FLAG_CONNECTED_WITNESS ------------------------------------------------------------------
  {
    const flag = uncleared(bundle.claim.flags, 'NON_INDEPENDENT_WITNESS') ?? uncleared(bundle.flags, 'NON_INDEPENDENT_WITNESS');
    if (flag) {
      add(
        make('FLAG_CONNECTED_WITNESS', {
          why: `${flag.message || 'The witness is connected to the claimant'}: do not rely on the statement alone — seek CCTV, the third party’s own account or a police report, and disclose the connection rather than explain it away.`,
          dueAt: addWorkingDays(flag.raisedAt, 1),
        }),
      );
    }
  }

  // --- 21. MONITOR_SUPPLIER -------------------------------------------------------------------------
  {
    const flag = uncleared(bundle.claim.flags, 'SUPPLIER_HIGH_RISK') ?? uncleared(bundle.flags, 'SUPPLIER_HIGH_RISK');
    if (flag) {
      add(
        make('MONITOR_SUPPLIER', {
          why: `${flag.message || 'A supplier on this file is high risk'}: expect the insurer’s vendor checks to challenge that supplier’s invoices, so qualify an alternative and keep the invoices’ supporting evidence complete.`,
          dueAt: addWorkingDays(flag.raisedAt, 5),
        }),
      );
    }
  }

  return sortActions(actions);
}

/** Priority rank, then due date (undefined last), then code. */
export function sortActions(actions: PlaybookAction[]): PlaybookAction[] {
  return [...actions].sort((a, b) => {
    const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (p !== 0) return p;
    if (a.dueAt && b.dueAt) {
      const d = compareIso(a.dueAt, b.dueAt);
      if (d !== 0) return d;
    } else if (a.dueAt !== b.dueAt) return a.dueAt ? -1 : 1;
    return a.code.localeCompare(b.code);
  });
}
