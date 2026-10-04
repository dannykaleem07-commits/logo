/**
 * Fleet penalty clocks (BLUEPRINT §3.12): NIP 14 days, s.172 28 days, PCN discount /
 * representations / appeal.
 *
 * Day-count conventions (England & Wales):
 *  - s.1 RTOA 1988: the NIP must be SERVED "within fourteen days of the commission of the offence";
 *    the offence day is excluded, so the last day is contravention date + 14.
 *  - s.172(7)(a) RTA 1988: "within the period of 28 days beginning with the day on which the notice
 *    is served" — the service day is day 1, so the last day is service date + 27.
 *  - TMA 2004 civil enforcement: discount "within 14 days beginning with the date of service" (+13);
 *    representations / appeals "within 28 days beginning with the date of service" (+27).
 *  The deadline PRINTED on the notice governs: `discountDeadline` / `responseDeadline` are used
 *  when present and the computed date is only a fallback. `receivedAt` stands in for the date of
 *  service; a posted notice may be deemed served earlier, so treat computed dates as the latest
 *  safe reading, not a guarantee.
 */
import type { Clock, ClockKind, ISODateTime, PenaltyNotice } from '../types.js';
import { addCalendarDays, compareIso, endOfDay, toLondonIso } from '../calendar/index.js';
import { clockDefinitions } from './definitions.js';

export interface PenaltyClockFacts {
  /** The claim (or other owner) id to stamp on the clocks; defaults to `penalty:<notice.id>`. */
  claimId?: string;
  /** When the s.172 / PCN response (or liability transfer) was sent. */
  respondedAt?: ISODateTime;
  /** When the penalty was paid. */
  paidAt?: ISODateTime;
  /** When formal representations (or the hirer transfer) were sent. */
  representationsSentAt?: ISODateTime;
  /** When the notice of rejection was received — starts the appeal clock. */
  rejectionReceivedAt?: ISODateTime;
  /** When the tribunal / POPLA / IAS appeal was lodged. */
  appealLodgedAt?: ISODateTime;
}

const RESPONDED_STAGES: ReadonlySet<PenaltyNotice['stage']> = new Set(['liability_transferred', 'representations', 'appeal', 'paid', 'cancelled']);

function status(now: ISODateTime, dueAt: ISODateTime, metAt?: ISODateTime, stoppedAt?: ISODateTime): Clock['status'] {
  if (metAt && compareIso(metAt, dueAt) <= 0 && (!stoppedAt || compareIso(metAt, stoppedAt) <= 0)) return 'met';
  if (stoppedAt && compareIso(stoppedAt, now) <= 0) return 'stopped';
  if (metAt) return 'breached';
  return compareIso(now, dueAt) > 0 ? 'breached' : 'running';
}

export function derivePenaltyClocks(notice: PenaltyNotice, now: ISODateTime, facts: PenaltyClockFacts = {}): Clock[] {
  const claimId = facts.claimId ?? `penalty:${notice.id}`;
  const out: Clock[] = [];
  const served = toLondonIso(notice.receivedAt);
  const stageDone = RESPONDED_STAGES.has(notice.stage);

  const push = (kind: ClockKind, c: Omit<Clock, 'id' | 'claimId' | 'kind' | 'label' | 'basis' | 'attributableTo'> & Partial<Pick<Clock, 'label' | 'basis' | 'attributableTo'>>): void => {
    const def = clockDefinitions[kind];
    out.push({
      id: `pen:${notice.id}:${kind}`,
      claimId,
      kind,
      label: c.label ?? def.label,
      basis: c.basis ?? def.basis,
      attributableTo: c.attributableTo ?? def.attributableTo,
      startsAt: c.startsAt,
      dueAt: c.dueAt,
      status: c.status,
      ...(c.metAt ? { metAt: c.metAt } : {}),
      ...(c.stoppedAt ? { stoppedAt: c.stoppedAt } : {}),
      ...(c.stoppedReason ? { stoppedReason: c.stoppedReason } : {}),
      ...(c.sourceEventId ? { sourceEventId: c.sourceEventId } : {}),
    });
  };

  const paidAt = facts.paidAt;
  const cancelled = notice.stage === 'cancelled';

  if (notice.kind === 'nip_s172') {
    // NIP: served within 14 days of the offence (the issuer's clock; breach = out of time).
    const nipDue = endOfDay(addCalendarDays(notice.contraventionAt, 14));
    const servedInTime = compareIso(served, nipDue) <= 0;
    push('nip_14_days', {
      startsAt: toLondonIso(notice.contraventionAt),
      dueAt: nipDue,
      status: servedInTime ? 'met' : 'breached',
      metAt: served,
      sourceEventId: notice.id,
    });

    // s.172: 28 days beginning with the day of service.
    const s172Due = notice.responseDeadline ? endOfDay(notice.responseDeadline) : endOfDay(addCalendarDays(served, 27));
    const metAt = facts.respondedAt;
    let st = status(now, s172Due, metAt, cancelled ? now : undefined);
    if (!metAt && stageDone && !cancelled) st = 'met';
    push('s172_28_days', {
      startsAt: served,
      dueAt: s172Due,
      status: st,
      ...(metAt ? { metAt } : {}),
      ...(cancelled ? { stoppedAt: now, stoppedReason: 'notice cancelled' } : {}),
      sourceEventId: notice.id,
    });
    return out;
  }

  if (notice.kind === 'fpn') {
    const due = endOfDay(notice.responseDeadline);
    const stoppedAt = cancelled ? now : undefined;
    push('custom', {
      label: 'Fixed penalty — pay or request a hearing',
      basis: 'ss.52 and 75 RTOA 1988 — suspended enforcement period stated on the notice (not less than 21 days; commonly 28)',
      startsAt: served,
      dueAt: due,
      status: status(now, due, paidAt, stoppedAt),
      ...(paidAt ? { metAt: paidAt } : {}),
      ...(stoppedAt ? { stoppedAt, stoppedReason: 'notice cancelled' } : {}),
      sourceEventId: notice.id,
    });
    return out;
  }

  // PCN family: council, private, congestion/ULEZ, Dart Charge.
  const isPrivate = notice.kind === 'pcn_private';
  const discountDue = notice.discountDeadline ? endOfDay(notice.discountDeadline) : endOfDay(addCalendarDays(served, 13));
  const repsDue = notice.responseDeadline ? endOfDay(notice.responseDeadline) : endOfDay(addCalendarDays(served, 27));
  const repsAt = facts.representationsSentAt ?? facts.respondedAt;

  const discountStop = cancelled ? now : repsAt;
  const discountStopReason = cancelled ? 'notice cancelled' : repsAt ? 'representations / liability transfer sent — discount suspended pending the outcome' : undefined;
  let discountStatus = status(now, discountDue, paidAt, discountStop);
  if (!paidAt && notice.stage === 'paid') discountStatus = 'met';
  push('pcn_discount_14_days', {
    startsAt: served,
    dueAt: discountDue,
    status: discountStatus,
    ...(paidAt ? { metAt: paidAt } : {}),
    ...(discountStop && discountStatus === 'stopped' ? { stoppedAt: discountStop, stoppedReason: discountStopReason ?? '' } : {}),
    sourceEventId: notice.id,
    ...(isPrivate ? { basis: 'Private parking charge — discount period under the operator’s terms and the BPA / IPC Code of Practice (contract, not statute); check the notice' } : {}),
  });

  const repsStop = cancelled ? now : paidAt;
  let repsStatus = status(now, repsDue, repsAt, repsStop);
  if (!repsAt && stageDone && notice.stage !== 'paid' && !cancelled) repsStatus = 'met';
  push('pcn_representations_28_days', {
    startsAt: served,
    dueAt: repsDue,
    status: repsStatus,
    ...(repsAt ? { metAt: repsAt } : {}),
    ...(repsStop && repsStatus === 'stopped' ? { stoppedAt: repsStop, stoppedReason: cancelled ? 'notice cancelled' : 'penalty paid' } : {}),
    sourceEventId: notice.id,
    ...(isPrivate ? { basis: 'Private parking charge — appeal to the operator within 28 days (BPA / IPC Code of Practice; POFA 2012 Sch 4 keeper-liability conditions)' } : {}),
  });

  if (facts.rejectionReceivedAt) {
    const start = toLondonIso(facts.rejectionReceivedAt);
    const appealDue = endOfDay(addCalendarDays(start, 27));
    const appealAt = facts.appealLodgedAt;
    const appealStop = cancelled ? now : paidAt;
    let appealStatus = status(now, appealDue, appealAt, appealStop);
    if (!appealAt && notice.stage === 'appeal') appealStatus = 'met';
    push('pcn_appeal_28_days', {
      startsAt: start,
      dueAt: appealDue,
      status: appealStatus,
      ...(appealAt ? { metAt: appealAt } : {}),
      ...(appealStop && appealStatus === 'stopped' ? { stoppedAt: appealStop, stoppedReason: cancelled ? 'notice cancelled' : 'penalty paid' } : {}),
      sourceEventId: notice.id,
      ...(isPrivate ? { basis: 'Private parking charge — POPLA (BPA) or IAS (IPC) appeal within 28 days of the operator’s rejection' } : {}),
    });
  }

  return out;
}
