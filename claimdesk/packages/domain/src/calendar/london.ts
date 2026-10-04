/**
 * Europe/London wall-clock arithmetic without a time-zone library.
 *
 * UK clocks: GMT (UTC+0) in winter, BST (UTC+1) in summer. BST starts at 01:00 UTC on the
 * last Sunday of March and ends at 01:00 UTC on the last Sunday of October (Summer Time
 * Order 2002). That rule is encoded here so every deadline the platform prints carries the
 * correct offset for its date.
 *
 * Conventions:
 *  - `ISODate`     = YYYY-MM-DD (a London calendar date).
 *  - `ISODateTime` = ISO 8601. If it carries an offset or Z it is an absolute instant. If it
 *    carries no offset it is treated as London wall-clock time.
 *  - Functions here are pure: no Date.now(), no locale, no process time zone.
 */
import type { ISODate, ISODateTime } from '../types.js';

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

export interface IsoParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  /** Offset in minutes east of UTC; null when the string carried none. */
  offsetMinutes: number | null;
  /** false for a bare YYYY-MM-DD. */
  hasTime: boolean;
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** Parse an ISO date or date-time string into its literal parts. Throws on anything else. */
export function parseIso(iso: string): IsoParts {
  const m = ISO_RE.exec(iso.trim());
  if (!m) throw new Error(`parseIso: not an ISO date/date-time: "${iso}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hasTime = m[4] !== undefined;
  const hour = hasTime ? Number(m[4]) : 0;
  const minute = hasTime ? Number(m[5]) : 0;
  const second = m[6] !== undefined ? Number(m[6]) : 0;
  const millisecond = m[7] !== undefined ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0;
  let offsetMinutes: number | null = null;
  if (m[8] !== undefined) {
    const z = m[8];
    if (z === 'Z' || z === 'z') offsetMinutes = 0;
    else {
      const sign = z.startsWith('-') ? -1 : 1;
      const digits = z.slice(1).replace(':', '');
      const hh = Number(digits.slice(0, 2));
      const mm = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
      offsetMinutes = sign * (hh * 60 + mm);
    }
  }
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 60) {
    throw new Error(`parseIso: out-of-range date/time: "${iso}"`);
  }
  return { year, month, day, hour, minute, second, millisecond, offsetMinutes, hasTime };
}

export function isIsoDateOnly(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso.trim());
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  // month 1..12
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/** Day of month of the last Sunday in `month` (1..12) of `year`. */
export function lastSundayOfMonth(year: number, month: number): number {
  const last = daysInMonth(year, month);
  const weekday = new Date(Date.UTC(year, month - 1, last)).getUTCDay(); // 0 = Sunday
  return last - weekday;
}

/** UTC instant (ms) at which BST begins in `year`: 01:00 UTC on the last Sunday of March. */
export function bstStartUtc(year: number): number {
  return Date.UTC(year, 2, lastSundayOfMonth(year, 3), 1, 0, 0, 0);
}

/** UTC instant (ms) at which BST ends in `year`: 01:00 UTC on the last Sunday of October. */
export function bstEndUtc(year: number): number {
  return Date.UTC(year, 9, lastSundayOfMonth(year, 10), 1, 0, 0, 0);
}

/** London offset from UTC, in minutes, for an absolute instant. 60 during BST, otherwise 0. */
export function londonOffsetMinutesAt(utcMs: number): number {
  const year = new Date(utcMs).getUTCFullYear();
  return utcMs >= bstStartUtc(year) && utcMs < bstEndUtc(year) ? 60 : 0;
}

/** Convert a London wall-clock value (encoded as if it were UTC) to the true UTC instant. */
export function londonWallToUtc(wallMs: number): number {
  // Two-step probe handles both transitions. The ambiguous hour in October resolves to its
  // first (BST) occurrence. A wall time in the skipped hour on the March change (01:00–01:59)
  // does not exist: it is shifted forward (01:30 → 02:30 BST, the same instant as 01:30 GMT),
  // never backwards, so a deadline can only move later, not earlier.
  const o1 = londonOffsetMinutesAt(wallMs - MS_PER_HOUR);
  const o2 = londonOffsetMinutesAt(wallMs - o1 * MS_PER_MINUTE);
  const utc = wallMs - o2 * MS_PER_MINUTE;
  if (utcToLondonWall(utc) !== wallMs) return wallMs - o1 * MS_PER_MINUTE; // skipped hour
  return utc;
}

/** Convert a true UTC instant to London wall-clock (encoded as if it were UTC). */
export function utcToLondonWall(utcMs: number): number {
  return utcMs + londonOffsetMinutesAt(utcMs) * MS_PER_MINUTE;
}

/** Absolute UTC instant (ms) of an ISO date or date-time. Date-only = London midnight. */
export function isoToMs(iso: ISODate | ISODateTime): number {
  const p = parseIso(iso);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.millisecond);
  if (p.offsetMinutes !== null) return asUtc - p.offsetMinutes * MS_PER_MINUTE;
  return londonWallToUtc(asUtc);
}

/** London wall-clock (as-if-UTC ms) of an ISO date or date-time. */
export function isoToLondonWallMs(iso: ISODate | ISODateTime): number {
  const p = parseIso(iso);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.millisecond);
  if (p.offsetMinutes === null) return asUtc; // already London wall-clock (or a date)
  return utcToLondonWall(asUtc - p.offsetMinutes * MS_PER_MINUTE);
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

function wallMsToDate(wallMs: number): ISODate {
  const d = new Date(wallMs);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Format an absolute instant as a London-local ISO 8601 string with explicit offset. */
export function msToLondonIso(utcMs: number): ISODateTime {
  const offset = londonOffsetMinutesAt(utcMs);
  const wall = new Date(utcMs + offset * MS_PER_MINUTE);
  const base = `${wallMsToDate(wall.getTime())}T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}`;
  const frac = wall.getUTCMilliseconds() ? `.${pad(wall.getUTCMilliseconds(), 3)}` : '';
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${base}${frac}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Format a London wall-clock value (as-if-UTC ms) as a London-local ISO 8601 string. */
export function londonWallMsToIso(wallMs: number): ISODateTime {
  return msToLondonIso(londonWallToUtc(wallMs));
}

/** Format an absolute instant as UTC ISO 8601 (Z). */
export function msToUtcIso(utcMs: number): ISODateTime {
  return new Date(utcMs).toISOString();
}

/** Re-express any ISO date-time as London local time with explicit offset. */
export function toLondonIso(iso: ISODateTime): ISODateTime {
  return msToLondonIso(isoToMs(iso));
}

/** Re-express any ISO date-time in UTC (Z). */
export function toUtcIso(iso: ISODateTime): ISODateTime {
  return msToUtcIso(isoToMs(iso));
}

/** The London calendar date (YYYY-MM-DD) on which an instant falls. */
export function londonDate(iso: ISODate | ISODateTime): ISODate {
  return wallMsToDate(isoToLondonWallMs(iso));
}

/** London wall-clock parts of an instant. */
export function londonParts(iso: ISODate | ISODateTime): Omit<IsoParts, 'offsetMinutes' | 'hasTime'> & { offsetMinutes: number; weekday: number } {
  const utc = isoToMs(iso);
  const offset = londonOffsetMinutesAt(utc);
  const d = new Date(utc + offset * MS_PER_MINUTE);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    millisecond: d.getUTCMilliseconds(),
    offsetMinutes: offset,
    weekday: d.getUTCDay(), // 0 = Sunday
  };
}

/** True when British Summer Time applies at the instant. */
export function isBst(iso: ISODate | ISODateTime): boolean {
  return londonOffsetMinutesAt(isoToMs(iso)) === 60;
}

/** Compare two ISO values as instants: negative, zero or positive. */
export function compareIso(a: ISODate | ISODateTime, b: ISODate | ISODateTime): number {
  const x = isoToMs(a);
  const y = isoToMs(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Whole London calendar days from `a` to `b` (b − a); negative when b is earlier. */
export function calendarDaysBetween(a: ISODate | ISODateTime, b: ISODate | ISODateTime): number {
  const da = Date.UTC(...dateTriple(londonDate(a)));
  const db = Date.UTC(...dateTriple(londonDate(b)));
  return Math.round((db - da) / MS_PER_DAY);
}

function dateTriple(date: ISODate): [number, number, number] {
  const p = parseIso(date);
  return [p.year, p.month - 1, p.day];
}

/** Build a London-local ISO date-time from a London date and wall-clock time. */
export function londonDateTime(date: ISODate, hour: number, minute = 0, second = 0): ISODateTime {
  const [y, m, d] = dateTriple(date);
  return londonWallMsToIso(Date.UTC(y, m, d, hour, minute, second, 0));
}

/** Format a London wall date (as-if-UTC ms) to YYYY-MM-DD. Exposed for the calendar module. */
export const wallMsToIsoDate = wallMsToDate;
