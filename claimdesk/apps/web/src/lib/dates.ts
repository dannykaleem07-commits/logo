/**
 * Date helpers. All values in and out are ISO strings (ISODate = YYYY-MM-DD, ISODateTime = ISO 8601).
 * Display is en-GB. Working-day arithmetic belongs to @ccguk/domain/calendar, not here.
 */
import type { ISODate, ISODateTime } from '@ccguk/domain';

const MS_DAY = 86_400_000;

export function isISODate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

export function isISODateTime(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !Number.isNaN(Date.parse(s));
}

/** Today's ISODate in the browser's local zone. */
export function todayISO(now: Date = new Date()): ISODate {
  return toLocalISODate(now);
}

export function toLocalISODate(d: Date): ISODate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** "YYYY-MM-DDTHH:mm" (the value of a datetime-local input) from an ISODateTime, in local time. */
export function toDateTimeLocalValue(iso: ISODateTime | undefined | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${toLocalISODate(d)}T${hh}:${mm}`;
}

/** datetime-local value → ISODateTime (UTC, with Z). Returns '' for empty/invalid input. */
export function fromDateTimeLocalValue(value: string): ISODateTime {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

export function formatDate(iso: ISODate | ISODateTime | undefined | null, opts: { long?: boolean } = {}): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', opts.long ? { day: 'numeric', month: 'long', year: 'numeric' } : { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: ISODateTime | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Whole calendar days between two instants, local-day based (negative when `b` is before `a`). */
export function daysBetween(a: ISODateTime | ISODate, b: ISODateTime | ISODate): number {
  const da = new Date(a.length === 10 ? `${a}T00:00:00` : a);
  const db = new Date(b.length === 10 ? `${b}T00:00:00` : b);
  const sa = new Date(da.getFullYear(), da.getMonth(), da.getDate()).getTime();
  const sb = new Date(db.getFullYear(), db.getMonth(), db.getDate()).getTime();
  return Math.round((sb - sa) / MS_DAY);
}

/** Human "due in 3 days" / "overdue by 2 days" / "due today" / "due in 2 hours". */
export function describeDue(dueAt: ISODateTime, now: ISODateTime | Date = new Date()): string {
  const nowD = typeof now === 'string' ? new Date(now) : now;
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return 'no due date';
  const diffMs = due.getTime() - nowD.getTime();
  const days = daysBetween(nowD.toISOString(), dueAt);
  if (days === 0) {
    if (diffMs < 0) return 'overdue (today)';
    const hours = Math.max(1, Math.round(diffMs / 3_600_000));
    return hours >= 12 ? 'due today' : `due in ${hours} h`;
  }
  if (days < 0) return `overdue by ${-days} day${-days === 1 ? '' : 's'}`;
  if (days === 1) return 'due tomorrow';
  return `due in ${days} days`;
}
