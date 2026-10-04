/**
 * Clock presentation helpers (pure). Due-state buckets drive the ClockPill colour and the dashboard groups.
 * The clocks themselves are derived server-side by @ccguk/domain/clocks; the web never recomputes deadlines.
 */
import type { Clock, ISODateTime } from '@ccguk/domain';
import { daysBetween } from './dates';

export type DueState = 'overdue' | 'today' | 'soon' | 'later' | 'met' | 'stopped';

export function dueState(clock: Pick<Clock, 'dueAt' | 'status'>, now: ISODateTime | Date = new Date()): DueState {
  if (clock.status === 'met') return 'met';
  if (clock.status === 'stopped' || clock.status === 'not_applicable') return 'stopped';
  const nowD = typeof now === 'string' ? new Date(now) : now;
  const due = new Date(clock.dueAt);
  if (Number.isNaN(due.getTime())) return 'later';
  if (clock.status === 'breached' || due.getTime() < nowD.getTime()) return 'overdue';
  const days = daysBetween(nowD.toISOString(), clock.dueAt);
  if (days <= 0) return 'today';
  if (days <= 3) return 'soon';
  return 'later';
}

export function isDueToday(clock: Pick<Clock, 'dueAt' | 'status'>, now: ISODateTime | Date = new Date()): boolean {
  return dueState(clock, now) === 'today';
}

export function isOverdue(clock: Pick<Clock, 'dueAt' | 'status'>, now: ISODateTime | Date = new Date()): boolean {
  return dueState(clock, now) === 'overdue';
}

/** Open clocks (running or breached) sorted soonest first. */
export function openClocks<T extends Pick<Clock, 'dueAt' | 'status'>>(clocks: T[]): T[] {
  return clocks.filter((c) => c.status === 'running' || c.status === 'breached').sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

/** The oldest (most overdue) open clock, or undefined. */
export function oldestOverdue<T extends Pick<Clock, 'dueAt' | 'status'>>(clocks: T[], now: ISODateTime | Date = new Date()): T | undefined {
  return openClocks(clocks).find((c) => isOverdue(c, now));
}

/** Group a list of clocks by claim id, preserving soonest-first order inside each group. */
export function groupByClaim<T extends Pick<Clock, 'claimId' | 'dueAt' | 'status'>>(clocks: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const c of openClocks(clocks)) {
    const list = out.get(c.claimId) ?? [];
    list.push(c);
    out.set(c.claimId, list);
  }
  return out;
}
