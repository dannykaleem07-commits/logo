/**
 * Text and date utilities for the consistency engine. Internal to the module (not re-exported from the barrel).
 */
import type { ISODate, ISODateTime } from '../types.js';

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

export function datePart(iso: ISODateTime | ISODate): ISODate {
  return iso.slice(0, 10);
}

export function formatLongDate(iso: ISODate | ISODateTime): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTH_NAMES[Number(m[2]) - 1] ?? ''} ${Number(m[1])}`;
}

const MS_PER_DAY = 86_400_000;

export function dayNumber(iso: ISODate | ISODateTime): number {
  return Math.floor(Date.parse(`${datePart(iso)}T00:00:00Z`) / MS_PER_DAY);
}

/** Calendar days from a to b by date part (b − a). */
export function calendarDaysBetween(a: ISODate | ISODateTime, b: ISODate | ISODateTime): number {
  return dayNumber(b) - dayNumber(a);
}

/** Whole or part days between two timestamps, minimum 1 (storage/hire "chargeable day" convention). */
export function chargeableDays(startAt: ISODateTime, endAt: ISODateTime): number {
  const ms = Date.parse(endAt) - Date.parse(startAt);
  if (!Number.isFinite(ms) || ms <= 0) return 1;
  return Math.max(1, Math.ceil(ms / MS_PER_DAY));
}

export function addCalendarDays(iso: ISODate, n: number): ISODate {
  const t = Date.parse(`${datePart(iso)}T00:00:00Z`) + n * MS_PER_DAY;
  return new Date(t).toISOString().slice(0, 10);
}

export function addCalendarMonthsSimple(iso: ISODate, n: number): ISODate {
  const [y, m, d] = datePart(iso).split('-').map(Number) as [number, number, number];
  const total = (m - 1) + n;
  const ny = y + Math.floor(total / 12);
  const nm = (total % 12 + 12) % 12 + 1;
  const dim = [31, isLeap(ny) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][nm - 1]!;
  return toIsoDate(ny, nm, Math.min(d, dim));
}

/** Monday–Friday working days with no bank-holiday table (fallback when the calendar module is not injected). */
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
  '&pound;': '£', '&#163;': '£', '&#xa3;': '£', '&#xA3;': '£', '&ndash;': '–', '&mdash;': '—', '&#8211;': '–', '&#8212;': '—'
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
