/**
 * Text and date utilities for the consistency engine. Internal to the module (not re-exported from the barrel).
 *
 * Every date comparison in the engine is made on the ENGLAND & WALES (Europe/London) calendar date, because that is
 * the date a letter prints. A storage record ending at 2026-06-30T23:30:00Z ended on 1 July 2026 in London, and a
 * letter saying so is right. Wall-clock arithmetic comes from the calendar module (one BST rule for the platform).
 */
import type { ISODate, ISODateTime } from '../types.js';
import { MS_PER_DAY, isoToLondonWallMs, londonDate } from '../calendar/index.js';

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const MONTH_INDEX: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

export function monthNumber(name: string): number | undefined {
  return MONTH_INDEX[name.toLowerCase().replace(/\.$/, '')];
}

export function isValidYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  return d <= dim;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function toIsoDate(y: number, m: number, d: number): ISODate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The London calendar date of an ISO date or date-time. A bare date is returned as is; an instant with Z or an
 * offset is converted to Europe/London; a date-time with no zone is treated as London wall-clock time (the
 * calendar module's convention). Unparseable input falls back to its first ten characters.
 */
export function datePart(iso: ISODateTime | ISODate): ISODate {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  try {
    return londonDate(iso);
  } catch {
    return iso.slice(0, 10);
  }
}

/** London wall-clock instant (ms, UTC-shaped) for an ISO value; NaN when unparseable. */
export function wallMs(iso: ISODateTime | ISODate): number {
  try {
    return isoToLondonWallMs(iso);
  } catch {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? Number.NaN : t;
  }
}

export function formatLongDate(iso: ISODate | ISODateTime): string {
  const d = datePart(iso);
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTH_NAMES[Number(m[2]) - 1] ?? ''} ${Number(m[1])}`;
}

/** Whole days since the epoch of the London calendar date. */
export function dayNumber(iso: ISODate | ISODateTime): number {
  return Math.floor(Date.parse(`${datePart(iso)}T00:00:00Z`) / MS_PER_DAY);
}

/** Calendar days from a to b by London date (b − a). */
export function calendarDaysBetween(a: ISODate | ISODateTime, b: ISODate | ISODateTime): number {
  return dayNumber(b) - dayNumber(a);
}

/**
 * 24-hour periods started between two instants on the London wall clock, minimum 1 — the hire/storage "chargeable
 * day" convention used by the gta module. Measured on the wall clock so a clock change neither adds nor removes a
 * day: 09:00 on 20 October (BST) → 10:00 on 30 October (GMT) is 10 days, not 11.
 */
export function chargeableDays(startAt: ISODateTime, endAt: ISODateTime): number {
  const ms = wallMs(endAt) - wallMs(startAt);
  if (!Number.isFinite(ms) || ms <= 0) return 1;
  return Math.max(1, Math.ceil(ms / MS_PER_DAY));
}

export function addCalendarDays(iso: ISODate, n: number): ISODate {
  const t = Date.parse(`${datePart(iso)}T00:00:00Z`) + n * MS_PER_DAY;
  return new Date(t).toISOString().slice(0, 10);
}

/** Calendar-month arithmetic clamped to the month end (31 Oct + 1 month = 30 Nov). */
export function addCalendarMonthsSimple(iso: ISODate, n: number): ISODate {
  const [y, m, d] = datePart(iso).split('-').map(Number) as [number, number, number];
  const total = (m - 1) + n;
  const ny = y + Math.floor(total / 12);
  const nm = (total % 12 + 12) % 12 + 1;
  const dim = [31, isLeap(ny) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][nm - 1]!;
  return toIsoDate(ny, nm, Math.min(d, dim));
}

/**
 * Monday–Friday working days with no bank-holiday table. Kept for callers that explicitly want a weekday count;
 * the engine itself defaults to the calendar module (England & Wales bank holidays).
 */
export function addWorkingDaysSimple(iso: ISODate, n: number): ISODate {
  let t = Date.parse(`${datePart(iso)}T00:00:00Z`);
  let remaining = n;
  while (remaining > 0) {
    t += MS_PER_DAY;
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return new Date(t).toISOString().slice(0, 10);
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
  '&pound;': '£', '&#163;': '£', '&#xa3;': '£', '&#xA3;': '£', '&ndash;': '–', '&mdash;': '—', '&#8211;': '–', '&#8212;': '—',
  '&middot;': '·', '&bull;': '•', '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”', '&hellip;': '…', '&times;': '×',
  '&minus;': '−', '&euro;': '€', '&sect;': '§', '&para;': '¶', '&deg;': '°', '&copy;': '©', '&reg;': '®', '&rarr;': '→', '&larr;': '←'
};

/** HTML → plain text. Block-level closers become newlines; other tags become spaces; common entities are decoded. */
export function toPlainText(htmlOrText: string): string {
  if (!/[<&]/.test(htmlOrText)) return htmlOrText;
  let s = htmlOrText
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|td|th|section|article|header|footer|table)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m) => {
    if (ENTITIES[m] !== undefined) return ENTITIES[m]!;
    const num = m.match(/^&#x([0-9a-f]+);$/i) ?? m.match(/^&#(\d+);$/);
    if (num && num[1]) {
      const cp = m.toLowerCase().startsWith('&#x') ? parseInt(num[1], 16) : parseInt(num[1], 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return m;
  });
  return s.replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

export function normaliseSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
