/**
 * Small text helpers shared by the smart-intake modules (docs/SMART-INTAKE.md §4): loose UK date parsing, London days,
 * registrations, postcodes, phones. Pure; no clock reads.
 */
import { createHash } from 'node:crypto';
import { utcToLondonWall } from '../../calendar/london.js';
import { isValidRegistrationLocal, normaliseRegistrationLocal } from '../fnol.js';

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad2 = (n: number): string => String(n).padStart(2, '0');

function realDate(y: number, m: number, d: number): boolean {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** A date pattern (UK day-first numeric, ISO, or "7 October 2026"), for scanning text. */
export const DATE_PATTERN = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.\-]\d{1,2}[/.\-](?:\d{4}|\d{2})|\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})`;
export const TIME_PATTERN = String.raw`(?:[01]?\d|2[0-3])[:.][0-5]\d(?:\s*(?:am|pm))?`;

/** A written date → YYYY-MM-DD (UK day-first for numeric dates), else undefined. */
export function parseLooseDate(raw: string): string | undefined {
  const s = raw.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return realDate(+m[1]!, +m[2]!, +m[3]!) ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    let y = +m[3]!;
    if (m[3]!.length === 2) y += y > 50 ? 1900 : 2000;
    return realDate(y, +m[2]!, +m[1]!) ? `${y}-${pad2(+m[2]!)}-${pad2(+m[1]!)}` : undefined;
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const k = m[2]!.toLowerCase();
    const mon = MONTHS[k.startsWith('sept') ? 'sept' : k.slice(0, 3)];
    return mon && realDate(+m[3]!, mon, +m[1]!) ? `${m[3]}-${pad2(mon)}-${pad2(+m[1]!)}` : undefined;
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[1]!.toLowerCase().slice(0, 3)];
    return mon && realDate(+m[3]!, mon, +m[2]!) ? `${m[3]}-${pad2(mon)}-${pad2(+m[2]!)}` : undefined;
  }
  return undefined;
}

/** "17:45" / "5.45pm" → "HH:MM", else undefined. */
export function parseLooseTime(raw: string): string | undefined {
  const m = /^(\d{1,2})[:.](\d{2})\s*(am|pm)?$/i.exec(raw.trim());
  if (!m) return undefined;
  let hh = Number(m[1]);
  const mm = Number(m[2]);
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return undefined;
  return `${pad2(hh)}:${pad2(mm)}`;
}

/** First date in a string (with an optional time right after it): { date, time }. */
export function findDateTime(text: string): { date: string; time: string | null; match: string } | undefined {
  const re = new RegExp(`(${DATE_PATTERN})(?:\\s*(?:,|at|@)?\\s*(${TIME_PATTERN}))?`, 'i');
  const m = re.exec(text);
  if (!m) return undefined;
  const date = parseLooseDate(m[1]!);
  if (!date) return undefined;
  let time = m[2] ? (parseLooseTime(m[2]) ?? null) : null;
  if (!time) {
    const t = new RegExp(`\\b(?:time|at)\\b[^0-9]{0,20}(${TIME_PATTERN})`, 'i').exec(text);
    if (t) time = parseLooseTime(t[1]!) ?? null;
  }
  return { date, time, match: m[0] };
}

/** All dates in a string. */
export function findDates(text: string): string[] {
  const re = new RegExp(DATE_PATTERN, 'gi');
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const d = parseLooseDate(m[0]);
    if (d) out.push(d);
  }
  return out;
}

/** The Europe/London calendar day (YYYY-MM-DD) of an ISO date or date-time; a bare date is returned as it is. */
export function londonDayOf(iso: string): string | null {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(iso)) return iso.slice(0, 10); // London wall time already
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(utcToLondonWall(t)).toISOString().slice(0, 10);
}

/** Milliseconds of an ISO value (a bare date = 00:00 UTC of that day; a wall time without offset = treated as UTC). */
export function isoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const s = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(iso) ? `${iso.replace(' ', 'T')}Z` : iso;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** Days between two ISO dates/date-times (b − a), fractional. */
export function daysBetween(a: string, b: string): number | null {
  const x = isoMs(a);
  const y = isoMs(b);
  return x === null || y === null ? null : (y - x) / 86_400_000;
}

// ----- registrations ---------------------------------------------------------

/** Plate-shaped tokens: current, prefix, suffix (dateless only with a label — too many false positives). */
export const VRM_SCAN_RE = /\b(?:[A-HJ-PR-Y]{2}\d{2}\s?[A-HJ-PR-Z]{3}|[A-HJ-NP-TV-Y]\d{1,3}\s?[A-Z]{3}|[A-Z]{3}\s?\d{1,3}[A-HJ-NPR-TV-Y])\b/g;

export function normVrm(v: string): string {
  return normaliseRegistrationLocal(v);
}

/** "KX21ABC" → "KX21 ABC" for current plates. */
export function displayPlate(v: string): string {
  const n = normVrm(v);
  return /^[A-Z]{2}\d{2}[A-Z]{3}$/.test(n) ? `${n.slice(0, 4)} ${n.slice(4)}` : n;
}

export function isPlate(v: string): boolean {
  const n = normVrm(v);
  if (!isValidRegistrationLocal(n)) return false;
  // current-format age identifiers 00 and 01 were never issued
  if (/^[A-Z]{2}\d{2}[A-Z]{3}$/.test(n) && ['00', '01'].includes(n.slice(2, 4))) return false;
  return true;
}

// ----- postcodes, phones, emails --------------------------------------------

export const POSTCODE_SCAN_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/g;
export function normPostcode(p: string): string {
  return p.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
export function displayPostcode(p: string): string {
  const n = normPostcode(p);
  return n.length > 3 ? `${n.slice(0, -3)} ${n.slice(-3)}` : n;
}

export const PHONE_SCAN_RE = /(?:\+44\s?\(?0?\)?\s?\d{2,4}|\(?0\d{2,4}\)?)[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g;
export function normPhone(p: string): string | null {
  let d = p.replace(/[^\d+]/g, '');
  if (d.startsWith('+44')) d = `0${d.slice(3).replace(/^0/, '')}`;
  else if (d.startsWith('0044')) d = `0${d.slice(4)}`;
  d = d.replace(/\D/g, '');
  return /^0\d{9,10}$/.test(d) ? d : null;
}

export const EMAIL_SCAN_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Case-insensitive collapse for loose comparisons. */
export function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** First `n` hex characters of sha1(s) (stable ids: timeline proposals, signals, filesets). */
export function sha1Hex(s: string, n = 12): string {
  return createHash('sha1').update(s, 'utf8').digest('hex').slice(0, n);
}
