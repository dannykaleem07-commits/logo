/**
 * England & Wales working-day calendar.
 *
 * A working day is Monday–Friday that is not an England & Wales bank holiday.
 *
 * Shape rule: every function that returns a date accepts either an `ISODate` or an
 * `ISODateTime`. A date-only input yields a date-only output; a date-time input yields a
 * London-local ISO 8601 date-time with explicit offset (+00:00 in GMT, +01:00 in BST) that
 * keeps the input's London wall-clock time of day. So 1 working day from Friday 16:00 is
 * Monday 16:00 even across a clock change.
 */
import type { ISODate, ISODateTime } from '../types.js';
import { bankHolidayOn } from './bank-holidays.js';
import {
  MS_PER_DAY,
  daysInMonth,
  isIsoDateOnly,
  isoToLondonWallMs,
  londonDateTime,
  londonWallMsToIso,
  wallMsToIsoDate,
} from './london.js';

export const END_OF_WORKING_DAY_HOUR = 17;

function wallDate(wallMs: number): ISODate {
  return wallMsToIsoDate(wallMs);
}

function wallWeekday(wallMs: number): number {
  return new Date(wallMs).getUTCDay(); // 0 = Sunday
}

function isWorkingWall(wallMs: number): boolean {
  const w = wallWeekday(wallMs);
  if (w === 0 || w === 6) return false;
  return bankHolidayOn(wallDate(wallMs)) === undefined;
}

function emit(input: string, wallMs: number): string {
  return isIsoDateOnly(input) ? wallDate(wallMs) : londonWallMsToIso(wallMs);
}

/** True when the London calendar date of `date` is a Monday–Friday that is not a bank holiday. */
export function isWorkingDay(date: ISODate | ISODateTime): boolean {
  return isWorkingWall(isoToLondonWallMs(date));
}

/** True when the London calendar date of `date` is an England & Wales bank holiday. */
export function isBankHoliday(date: ISODate | ISODateTime): boolean {
  return bankHolidayOn(wallDate(isoToLondonWallMs(date))) !== undefined;
}

/**
 * Add `n` working days (n may be negative). The result keeps the London time of day.
 * Counting starts from the day after `dateTime`, so Saturday + 1 WD = Monday and
 * Friday 16:00 + 1 WD = Monday 16:00. n = 0 returns the input, normalised.
 */
export function addWorkingDays(dateTime: ISODate | ISODateTime, n: number): string {
  if (!Number.isInteger(n)) throw new Error(`addWorkingDays: n must be an integer, got ${n}`);
  let wall = isoToLondonWallMs(dateTime);
  const step = n < 0 ? -MS_PER_DAY : MS_PER_DAY;
  let remaining = Math.abs(n);
  while (remaining > 0) {
    wall += step;
    if (isWorkingWall(wall)) remaining -= 1;
  }
  return emit(dateTime, wall);
}

/**
 * Working days elapsed from `a` to `b`: the count of working days in the half-open interval
 * (date(a), date(b)], i.e. b's date counts if it is a working day, a's date never does.
 * Negative when b is before a. With this convention
 * `addWorkingDays(a, workingDaysBetween(a, b))` lands on b's date whenever b is a working day.
 */
export function workingDaysBetween(a: ISODate | ISODateTime, b: ISODate | ISODateTime): number {
  const wa = Date.UTC(...triple(wallDate(isoToLondonWallMs(a))));
  const wb = Date.UTC(...triple(wallDate(isoToLondonWallMs(b))));
  if (wb < wa) return -workingDaysBetween(b, a);
  let count = 0;
  for (let t = wa + MS_PER_DAY; t <= wb; t += MS_PER_DAY) if (isWorkingWall(t)) count += 1;
  return count;
}

function triple(date: ISODate): [number, number, number] {
  return [Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))];
}

/** Add `n` calendar days keeping the London time of day (DST-safe). */
export function addCalendarDays(dateTime: ISODate | ISODateTime, n: number): string {
  if (!Number.isInteger(n)) throw new Error(`addCalendarDays: n must be an integer, got ${n}`);
  return emit(dateTime, isoToLondonWallMs(dateTime) + n * MS_PER_DAY);
}

/** Add `n` weeks (7n calendar days) keeping the London time of day. */
export function addWeeks(dateTime: ISODate | ISODateTime, n: number): string {
  return addCalendarDays(dateTime, 7 * n);
}

/**
 * Add `n` calendar months with "one calendar month" semantics (UK GDPR Art 12(3) as read by
 * the ICO; GTA 6.7): the same day of the month, clamped to the last day when the target month
 * is shorter — 31 Jan + 1 month = 28 Feb (29 Feb in a leap year). Time of day is kept.
 */
export function addCalendarMonths(dateTime: ISODate | ISODateTime, n: number): string {
  if (!Number.isInteger(n)) throw new Error(`addCalendarMonths: n must be an integer, got ${n}`);
  const wall = new Date(isoToLondonWallMs(dateTime));
  const total = wall.getUTCFullYear() * 12 + wall.getUTCMonth() + n;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1; // 1..12
  const day = Math.min(wall.getUTCDate(), daysInMonth(year, month));
  const out = Date.UTC(year, month - 1, day, wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds(), wall.getUTCMilliseconds());
  return emit(dateTime, out);
}

/** 17:00 London time on the London calendar date of `date`, with the correct GMT/BST offset. */
export function endOfWorkingDay(date: ISODate | ISODateTime): ISODateTime {
  return londonDateTime(wallDate(isoToLondonWallMs(date)), END_OF_WORKING_DAY_HOUR, 0, 0);
}

/** 00:00:00 London time on the London calendar date of `date`. */
export function startOfDay(date: ISODate | ISODateTime): ISODateTime {
  return londonDateTime(wallDate(isoToLondonWallMs(date)), 0, 0, 0);
}

/** 23:59:59 London time on the London calendar date of `date` (statutory "within N days" deadlines end here). */
export function endOfDay(date: ISODate | ISODateTime): ISODateTime {
  return londonDateTime(wallDate(isoToLondonWallMs(date)), 23, 59, 59);
}

/**
 * The next working day. By default strictly after `date`; with `{ inclusive: true }` returns
 * `date` itself when it is already a working day. Keeps the time of day for date-time input.
 */
export function nextWorkingDay(date: ISODate | ISODateTime, opts: { inclusive?: boolean } = {}): string {
  let wall = isoToLondonWallMs(date);
  if (opts.inclusive && isWorkingWall(wall)) return emit(date, wall);
  do wall += MS_PER_DAY;
  while (!isWorkingWall(wall));
  return emit(date, wall);
}

/** The previous working day, strictly before `date` (or `date` itself with `{ inclusive: true }`). */
export function previousWorkingDay(date: ISODate | ISODateTime, opts: { inclusive?: boolean } = {}): string {
  let wall = isoToLondonWallMs(date);
  if (opts.inclusive && isWorkingWall(wall)) return emit(date, wall);
  do wall -= MS_PER_DAY;
  while (!isWorkingWall(wall));
  return emit(date, wall);
}
