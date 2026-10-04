/**
 * API-side clock supplement. The domain `deriveClocks(bundle, now)` is the engine; this file adds only the kinds it does
 * not emit — the off-hire deadlines that hang off the hire record's expected end trigger (repair complete + 24 h,
 * total-loss payment + 5 WD, insurer termination + 1 WD) so a running hire always shows its off-hire clock.
 * Nothing here is a legal entitlement: GTA references are benchmark only (GTA 2.7(j)).
 */
import {
  addCalendarDays,
  addWorkingDays,
  compareIso,
  offHireDeadline,
  isoToMs,
  msToUtcIso,
  MS_PER_HOUR,
  type ClaimBundle,
  type ClaimEvent,
  type Clock,
  type HireEndTrigger,
  type ISODateTime,
} from '@ccguk/domain';

export const GTA_BENCHMARK = 'benchmark only — CCGUK is not a GTA subscriber (GTA 2.7(j))';

// ---------------------------------------------------------------------------
// Clocks (API-side supplement; replaced by domain deriveClocks when present)
// ---------------------------------------------------------------------------

type DerivedClock = Omit<Clock, 'id' | 'claimId'>;

function statusFor(dueAt: ISODateTime, metAt: ISODateTime | undefined, now: ISODateTime): Pick<Clock, 'status' | 'metAt'> {
  if (metAt) return compareIso(metAt, dueAt) <= 0 ? { status: 'met', metAt } : { status: 'breached', metAt };
  return compareIso(now, dueAt) > 0 ? { status: 'breached' } : { status: 'running' };
}

function firstEvent(events: ClaimEvent[], type: ClaimEvent['type'], after?: ISODateTime): ClaimEvent | undefined {
  return events.filter((e) => e.type === type && (!after || compareIso(e.at, after) >= 0)).sort((a, b) => compareIso(a.at, b.at))[0];
}

function latestEvent(events: ClaimEvent[], type: ClaimEvent['type']): ClaimEvent | undefined {
  return events.filter((e) => e.type === type).sort((a, b) => compareIso(b.at, a.at))[0];
}

const OFFHIRE_TRIGGER_EVENT: Array<{ event: ClaimEvent['type']; trigger: HireEndTrigger; kind: Clock['kind']; label: string }> = [
  { event: 'repair_completed', trigger: 'repair_complete_24h', kind: 'gta_4_8_offhire_repair_24h', label: 'Off-hire within 24 hours of repair completion' },
  { event: 'tl_payment_received', trigger: 'tl_payment_5wd', kind: 'gta_4_14_offhire_tl_payment_5wd', label: 'Off-hire within 5 working days of total-loss payment' },
  { event: 'insurer_termination_notice', trigger: 'insurer_termination_1wd', kind: 'gta_4_9_termination_1wd', label: 'Off-hire within 1 working day of insurer termination notice' },
];

/** The off-hire trigger event type for a given trigger (used by hire end to find the deadline). */
export function offHireEventFor(trigger: HireEndTrigger): ClaimEvent['type'] | undefined {
  return OFFHIRE_TRIGGER_EVENT.find((t) => t.trigger === trigger)?.event;
}

export function deriveClocksFallback(bundle: ClaimBundle, now: ISODateTime): DerivedClock[] {
  const { claim, events, offers, storage, hire } = bundle;
  const out: DerivedClock[] = [];

  // GTA 4.1 — NCAF within 1 working day of FNOL (benchmark).
  const fnol = firstEvent(events, 'fnol');
  const fnolAt = fnol?.at ?? claim.openedAt;
  const ncaf = firstEvent(events, 'ncaf_sent');
  out.push({
    kind: 'gta_4_1_ncaf_1wd',
    label: 'New Claim Advice Form to the at-fault insurer',
    basis: `GTA 4.1 (16 March 2026 wording) — ${GTA_BENCHMARK}`,
    startsAt: fnolAt,
    dueAt: addWorkingDays(fnolAt, 1),
    attributableTo: 'ccguk',
    sourceEventId: fnol?.id,
    ...statusFor(addWorkingDays(fnolAt, 1), ncaf?.at, now),
  });

  // GTA 4.2 — handling reference within 5 working days of the NCAF.
  if (ncaf) {
    const ref = firstEvent(events, 'handling_ref_received', ncaf.at);
    const due = addWorkingDays(ncaf.at, 5);
    out.push({
      kind: 'gta_4_2_handling_ref_5wd',
      label: 'Insurer handling reference expected',
      basis: `GTA 4.2 — ${GTA_BENCHMARK}`,
      startsAt: ncaf.at,
      dueAt: due,
      attributableTo: 'insurer',
      sourceEventId: ncaf.id,
      ...statusFor(due, ref?.at, now),
    });
  }

  // Intervention register — written reply within 1 working day of every offer (lesson c).
  for (const offer of offers) {
    const due = addWorkingDays(offer.receivedAt, 1);
    const sourceEvent = events.find((e) => e.type === 'intervention_offer' && e.data?.offerId === offer.id);
    out.push({
      kind: 'intervention_reply_1wd',
      label: `Written reply to ${offer.offerorName}'s intervention offer`,
      basis: 'BLUEPRINT §3.6 intervention register — reply in writing within 1 working day (mitigation record)',
      startsAt: offer.receivedAt,
      dueAt: due,
      attributableTo: 'ccguk',
      sourceEventId: sourceEvent?.id,
      ...statusFor(due, offer.replySentAt, now),
    });
  }

  // Storage — report issued + 48 h while storage is open (lesson d, File 2).
  const report = latestEvent(events, 'report_issued');
  if (report) {
    for (const s of storage) {
      if (compareIso(s.startAt, report.at) > 0) continue;
      const due = msToUtcIso(isoToMs(report.at) + 48 * MS_PER_HOUR);
      out.push({
        kind: 'storage_report_plus_48h',
        label: `Storage at ${s.location}: collect-or-pay notice / release within 48 h of the engineer's report`,
        basis: "Engineer's report issued — storage beyond report + 48 h needs a collect-or-pay notice (mitigation); insurer practice caps storage at report + 48 h",
        startsAt: report.at,
        dueAt: due,
        attributableTo: 'ccguk',
        sourceEventId: report.id,
        ...statusFor(due, s.endAt, now),
      });
    }
  }

  // Off-hire triggers (GTA 4.8 / 4.14 / 4.9, benchmark) against every hire running at the trigger.
  for (const t of OFFHIRE_TRIGGER_EVENT) {
    const ev = latestEvent(events, t.event);
    if (!ev) continue;
    const deadline = offHireDeadline(t.trigger, ev.at);
    for (const h of hire) {
      if (compareIso(h.startAt, ev.at) > 0) continue;
      if (h.endAt && compareIso(h.endAt, ev.at) < 0) continue;
      out.push({
        kind: t.kind,
        label: `${t.label} (${h.agreementNumber})`,
        basis: deadline.basis,
        startsAt: ev.at,
        dueAt: deadline.dueAt,
        attributableTo: 'ccguk',
        sourceEventId: ev.id,
        ...statusFor(deadline.dueAt, h.endAt, now),
      });
    }
  }

  // Chaser cadence after the payment pack: 7 / 14 / 21 days, complaint at day 28 (DISP 1 route for an at-fault insurer).
  const pack = latestEvent(events, 'payment_pack_sent');
  if (pack) {
    const paid = firstEvent(events, 'payment_received', pack.at);
    const cadence: Array<{ kind: Clock['kind']; days: number; label: string; met: ClaimEvent['type'] }> = [
      { kind: 'chaser_day_7', days: 7, label: 'Chaser 1 (day 7)', met: 'chaser_sent' },
      { kind: 'chaser_day_14', days: 14, label: 'Chaser 2 (day 14)', met: 'chaser_sent' },
      { kind: 'chaser_day_21', days: 21, label: 'Chaser 3 (day 21)', met: 'chaser_sent' },
      { kind: 'complaint_day_28', days: 28, label: 'Formal complaint (day 28, DISP 1)', met: 'complaint_sent' },
    ];
    const chasers = events.filter((e) => e.type === 'chaser_sent' && compareIso(e.at, pack.at) >= 0).sort((a, b) => compareIso(a.at, b.at));
    cadence.forEach((c, i) => {
      const due = addCalendarDays(pack.at, c.days);
      let metAt: ISODateTime | undefined;
      if (paid) metAt = paid.at;
      else if (c.met === 'chaser_sent') metAt = chasers[i]?.at;
      else metAt = firstEvent(events, 'complaint_sent', pack.at)?.at;
      const base = statusFor(due, metAt, now);
      out.push({
        kind: c.kind,
        label: c.label,
        basis: 'BLUEPRINT §7 get-paid-faster cadence; GTA 6.7 one-month settlement expectation (benchmark only); DISP 1 complaint route',
        startsAt: pack.at,
        dueAt: due,
        attributableTo: 'insurer',
        sourceEventId: pack.id,
        ...(paid ? { status: 'stopped' as const, stoppedAt: paid.at, stoppedReason: 'Payment received' } : base),
      });
    });
  }

  return out;
}
