/**
 * Repair monitoring diary (BLUEPRINT §3.3; GTA 4.10–4.11, benchmark only).
 *
 *  - Authorisation check 3 working days after the estimate (GTA 4.10).
 *  - Progress checks every 5 working days from repair start until completion (GTA 4.11).
 *  - Delay notice where a delay is ≥ 2 working days or > 20% of the estimated repair duration.
 *
 * Every insurer-caused day is recorded here because the dated chronology wins period arguments.
 */
import type { ClaimEvent, ISODateTime } from '../types.js';
import { addWorkingDays, compareIso, workingDaysBetween } from '../calendar/index.js';

export const MONITORING_BASIS = 'GTA 4.10–4.11 (benchmark only, CCGUK is not a subscriber)';
export const DELAY_NOTICE_MIN_WORKING_DAYS = 2;
export const DELAY_NOTICE_PCT_OVER = 20;
export const AUTHORISATION_CHECK_WD = 3;
export const PROGRESS_CHECK_WD = 5;

export type MonitoringCheckKind = 'authorisation_check' | 'progress_check';
export type MonitoringCheckStatus = 'upcoming' | 'done' | 'overdue';

export interface MonitoringCheck {
  kind: MonitoringCheckKind;
  dueAt: ISODateTime;
  /** Check number within its series (progress checks: 1, 2, 3…). */
  sequence: number;
  status: MonitoringCheckStatus;
  basis: string;
  sourceEventId: string;
  /** The event that satisfied the check, when done. */
  satisfiedByEventId?: string;
}

export type DelayNoticeKind = 'authorisation_delay' | 'repair_overrun' | 'logged_delay';

export interface DelayNotice {
  kind: DelayNoticeKind;
  reason: string;
  workingDaysLate: number;
  /** Percentage of the estimated repair duration (0 when no estimate). */
  pctOver: number;
  attributableTo: 'insurer' | 'repairer' | 'engineer' | 'client' | 'ccguk' | 'third_party' | 'unknown';
  basis: string;
  sourceEventId?: string;
  /** False while the delay is still running (no end event yet). */
  concluded: boolean;
}

export interface MonitoringDiary {
  checks: MonitoringCheck[];
  delayNotices: DelayNotice[];
  expectedCompletionAt?: ISODateTime;
  thresholds: { minWorkingDays: number; pctOver: number };
  basis: string;
}

/** An event that counts as a monitoring touch with the repairer. */
export function isMonitoringTouch(e: ClaimEvent): boolean {
  const d = e.data ?? {};
  return d['kind'] === 'monitoring_check' || d['monitoring'] === true || e.type === 'repair_delay' || e.type === 'parts_ordered' || e.type === 'parts_arrived';
}

function sorted(events: ClaimEvent[], now: ISODateTime): ClaimEvent[] {
  return events.filter((e) => compareIso(e.at, now) <= 0).sort((a, b) => compareIso(a.at, b.at));
}

function pct(late: number, estimateWd: number): number {
  return estimateWd > 0 ? Math.round((late / estimateWd) * 1000) / 10 : 0;
}

function qualifies(late: number, pctOver: number): boolean {
  return late >= DELAY_NOTICE_MIN_WORKING_DAYS || pctOver > DELAY_NOTICE_PCT_OVER;
}

export function monitoringDiary(events: ClaimEvent[], estimateWorkingDays: number, now: ISODateTime): MonitoringDiary {
  const evs = sorted(events, now);
  const first = (type: ClaimEvent['type']): ClaimEvent | undefined => evs.find((e) => e.type === type);
  const checks: MonitoringCheck[] = [];
  const delayNotices: DelayNotice[] = [];

  // --- Authorisation check (GTA 4.10) ---------------------------------------------------------
  const estimate = first('estimate_received') ?? first('report_issued');
  const authorised = first('repair_authorised');
  if (estimate) {
    const dueAt = addWorkingDays(estimate.at, AUTHORISATION_CHECK_WD);
    const status: MonitoringCheckStatus = authorised ? 'done' : compareIso(now, dueAt) > 0 ? 'overdue' : 'upcoming';
    const check: MonitoringCheck = { kind: 'authorisation_check', dueAt, sequence: 1, status, basis: `GTA 4.10 — authorisation check at ${AUTHORISATION_CHECK_WD} working days (benchmark only)`, sourceEventId: estimate.id };
    if (authorised) check.satisfiedByEventId = authorised.id;
    checks.push(check);

    const until = authorised?.at ?? now;
    const lateWd = workingDaysBetween(estimate.at, until) - AUTHORISATION_CHECK_WD;
    if (lateWd > 0) {
      const p = pct(lateWd, estimateWorkingDays);
      if (qualifies(lateWd, p)) {
        delayNotices.push({
          kind: 'authorisation_delay',
          reason: authorised
            ? `Repair authorisation received ${lateWd} working day${lateWd === 1 ? '' : 's'} after the ${AUTHORISATION_CHECK_WD}-working-day authorisation point`
            : `Repair authorisation outstanding ${lateWd} working day${lateWd === 1 ? '' : 's'} beyond the ${AUTHORISATION_CHECK_WD}-working-day authorisation point`,
          workingDaysLate: lateWd,
          pctOver: p,
          attributableTo: 'insurer',
          basis: MONITORING_BASIS,
          sourceEventId: estimate.id,
          concluded: Boolean(authorised),
        });
      }
    }
  }

  // --- Progress checks every 5 WD (GTA 4.11) -----------------------------------------------
  const started = first('repair_started');
  const completed = started ? evs.find((e) => e.type === 'repair_completed' && compareIso(e.at, started.at) >= 0) : undefined;
  let expectedCompletionAt: ISODateTime | undefined;
  if (started) {
    const touches = evs.filter((e) => isMonitoringTouch(e) && compareIso(e.at, started.at) > 0);
    const horizon = completed?.at ?? now;
    let prevDue: ISODateTime = started.at;
    for (let k = 1; k <= 200; k += 1) {
      const dueAt = addWorkingDays(started.at, PROGRESS_CHECK_WD * k);
      if (completed && compareIso(dueAt, completed.at) > 0) break; // repair finished: no further checks
      const touch = touches.find((t) => compareIso(t.at, prevDue) > 0 && compareIso(t.at, dueAt) <= 0);
      const status: MonitoringCheckStatus = touch ? 'done' : compareIso(now, dueAt) > 0 ? 'overdue' : 'upcoming';
      const check: MonitoringCheck = { kind: 'progress_check', dueAt, sequence: k, status, basis: `GTA 4.11 — progress check every ${PROGRESS_CHECK_WD} working days during repair (benchmark only)`, sourceEventId: started.id };
      if (touch) check.satisfiedByEventId = touch.id;
      checks.push(check);
      if (compareIso(dueAt, horizon) > 0) break; // emitted the next upcoming check; stop
      prevDue = dueAt;
    }

    // --- Repair over-run against the estimate ---------------------------------------------
    if (estimateWorkingDays > 0) {
      expectedCompletionAt = addWorkingDays(started.at, estimateWorkingDays);
      const actual = completed?.at ?? now;
      const lateWd = workingDaysBetween(expectedCompletionAt, actual);
      if (lateWd > 0) {
        const p = pct(lateWd, estimateWorkingDays);
        if (qualifies(lateWd, p)) {
          delayNotices.push({
            kind: 'repair_overrun',
            reason: completed
              ? `Repair completed ${lateWd} working day${lateWd === 1 ? '' : 's'} (${p}%) beyond the ${estimateWorkingDays}-working-day estimate`
              : `Repair running ${lateWd} working day${lateWd === 1 ? '' : 's'} (${p}%) beyond the ${estimateWorkingDays}-working-day estimate`,
            workingDaysLate: lateWd,
            pctOver: p,
            attributableTo: 'repairer',
            basis: MONITORING_BASIS,
            sourceEventId: started.id,
            concluded: Boolean(completed),
          });
        }
      }
    }
  }

  // --- Logged delays (repair_delay events carrying data.workingDays) -----------------------
  for (const e of evs.filter((x) => x.type === 'repair_delay')) {
    const wd = e.data?.['workingDays'];
    if (typeof wd !== 'number' || !Number.isFinite(wd) || wd <= 0) continue;
    const p = pct(wd, estimateWorkingDays);
    if (!qualifies(wd, p)) continue;
    delayNotices.push({
      kind: 'logged_delay',
      reason: e.summary || `Logged repair delay of ${wd} working days`,
      workingDaysLate: wd,
      pctOver: p,
      attributableTo: mapAttribution(e.attributableTo),
      basis: MONITORING_BASIS,
      sourceEventId: e.id,
      concluded: true,
    });
  }

  const diary: MonitoringDiary = {
    checks,
    delayNotices,
    thresholds: { minWorkingDays: DELAY_NOTICE_MIN_WORKING_DAYS, pctOver: DELAY_NOTICE_PCT_OVER },
    basis: MONITORING_BASIS,
  };
  if (expectedCompletionAt) diary.expectedCompletionAt = expectedCompletionAt;
  return diary;
}

function mapAttribution(a: ClaimEvent['attributableTo']): DelayNotice['attributableTo'] {
  switch (a) {
    case 'insurer':
    case 'repairer':
    case 'engineer':
    case 'client':
    case 'ccguk':
    case 'third_party':
      return a;
    default:
      return 'unknown';
  }
}
