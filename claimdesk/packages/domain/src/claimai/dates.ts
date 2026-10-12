// owned by claimai-server
/**
 * Relative dates in the owner's words (docs/CLAIM-AI-INPUT.md §3.2), Europe/London. Pure: `now` is passed in.
 *
 * `findDatePhrase` scans a clause for the first date expression; `resolveDate` reads one phrase. `sense` decides a bare
 * weekday: past → the most recent strictly before today ("hire ended on Monday"); future → the next strictly after
 * today ("until Monday"). A date without a year takes the year that keeps it nearest to `now` in the stated sense.
 * Results are London wall time converted to UTC ISO; a date-only result is London midnight (`precision: 'date'`).
 * Dates more than two years from `now` → null (the caller asks a question instead).
 */
import { londonParts, londonWallToUtc, MS_PER_DAY, utcToLondonWall } from '../calendar/london.js';
import type { ISODateTime } from '../types.js';

export interface ResolvedDate {
  at: ISODateTime;
  precision: 'date' | 'datetime';
  /** The words that gave the date ("yesterday", "on Monday at 3pm"). */
  text: string;
}

export interface FoundDate extends ResolvedDate {
  index: number;
  length: number;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WD = String.raw`(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?`;
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MON = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const TIME = String.raw`(?:\s*(?:,\s*)?(?:at\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?|(\d{1,2})[:.](\d{2})\s*(am|pm)?|(\d{1,2})\s*(am|pm)))?`;

const DATE_ALTS = [
  String.raw`day before yesterday`,
  String.raw`today|this morning|this afternoon|this evening|tonight|yesterday|tomorrow`,
  String.raw`end of (?:the )?week|next week`,
  String.raw`(?:on |this |next |last )?${WD}`,
  String.raw`(?:on )?the \d{1,2}(?:st|nd|rd|th)`,
  String.raw`(?:on )?\d{1,2}[/.\-]\d{1,2}(?:[/.\-](?:\d{4}|\d{2}))?`,
  String.raw`(?:on )?\d{1,2}(?:st|nd|rd|th)? (?:of )?${MON}(?:,? \d{4})?`,
  String.raw`(?:on )?${MON} \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?`,
  String.raw`in \d{1,2} (?:days?|weeks?)|\d{1,2} (?:days?|weeks?) ago|a week ago|in a week`,
];
const DATE_RE = new RegExp(String.raw`\b(${DATE_ALTS.join('|')})\b${TIME}`, 'i');
const DATE_RE_G = new RegExp(DATE_RE.source, 'gi');

const pad = (n: number): string => String(n).padStart(2, '0');

interface Day {
  y: number;
  m: number;
  d: number;
}

function dayMs(x: Day): number {
  return Date.UTC(x.y, x.m - 1, x.d);
}
function fromMs(ms: number): Day {
  const t = new Date(ms);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
function addDays(x: Day, n: number): Day {
  return fromMs(dayMs(x) + n * MS_PER_DAY);
}
function realDay(y: number, m: number, d: number): boolean {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** London calendar day of `now`, and its weekday (0 = Sunday). */
export function londonToday(now: ISODateTime): Day & { weekday: number } {
  const p = londonParts(now);
  return { y: p.year, m: p.month, d: p.day, weekday: p.weekday };
}

/** London wall time (day + hh:mm) → UTC ISO. */
export function londonWallIso(day: Day, hh = 0, mm = 0): ISODateTime {
  return new Date(londonWallToUtc(Date.UTC(day.y, day.m - 1, day.d, hh, mm))).toISOString();
}

/** The London calendar day (YYYY-MM-DD) of an instant. */
export function londonDayIso(at: ISODateTime): string {
  const w = new Date(utcToLondonWall(Date.parse(at)));
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
}

/** Pick the year for a day/month without one, nearest to today in the stated sense. */
function withYear(m: number, d: number, today: Day, sense: 'past' | 'future'): Day | null {
  const cands = [today.y - 1, today.y, today.y + 1].filter((y) => realDay(y, m, d)).map((y) => ({ y, m, d }));
  if (!cands.length) return null;
  const t = dayMs(today);
  if (sense === 'past') {
    const ok = cands.filter((c) => dayMs(c) <= t);
    return ok.length ? ok[ok.length - 1]! : cands[0]!;
  }
  const ok = cands.filter((c) => dayMs(c) >= t);
  return ok.length ? ok[0]! : cands[cands.length - 1]!;
}

function weekdayIndex(word: string): number {
  const w = word.toLowerCase();
  return WEEKDAYS.findIndex((x) => x.startsWith(w.slice(0, 3)));
}

function dayOf(phrase: string, today: Day & { weekday: number }, sense: 'past' | 'future'): { day: Day; hh?: number; mm?: number } | null {
  const p = phrase.toLowerCase().replace(/\s+/g, ' ').trim().replace(/^on /, '');
  if (p === 'today') return { day: today };
  if (p === 'this morning') return { day: today, hh: 9, mm: 0 };
  if (p === 'this afternoon') return { day: today, hh: 14, mm: 0 };
  if (p === 'this evening' || p === 'tonight') return { day: today, hh: 19, mm: 0 };
  if (p === 'yesterday') return { day: addDays(today, -1) };
  if (p === 'day before yesterday') return { day: addDays(today, -2) };
  if (p === 'tomorrow') return { day: addDays(today, 1) };
  if (/^end of (the )?week$/.test(p)) {
    const n = (5 - today.weekday + 7) % 7;
    return { day: addDays(today, n) };
  }
  if (p === 'next week') return { day: addDays(today, ((1 - today.weekday + 7) % 7) || 7) };
  let m = /^in (\d{1,2}) (days?|weeks?)$/.exec(p);
  if (m) return { day: addDays(today, Number(m[1]) * (m[2]!.startsWith('week') ? 7 : 1)) };
  if (p === 'in a week') return { day: addDays(today, 7) };
  m = /^(\d{1,2}) (days?|weeks?) ago$/.exec(p);
  if (m) return { day: addDays(today, -Number(m[1]) * (m[2]!.startsWith('week') ? 7 : 1)) };
  if (p === 'a week ago') return { day: addDays(today, -7) };
  m = new RegExp(`^(this |next |last )?(${WD})$`).exec(p);
  if (m) {
    const target = weekdayIndex(m[2]!);
    if (target < 0) return null;
    const mod = m[1]?.trim();
    const back = ((today.weekday - target + 7) % 7) || 7;
    const fwd = ((target - today.weekday + 7) % 7) || 7;
    if (mod === 'next') return { day: addDays(today, fwd) };
    if (mod === 'last') return { day: addDays(today, -back) };
    return { day: addDays(today, sense === 'past' ? -back : fwd) };
  }
  m = /^the (\d{1,2})(st|nd|rd|th)$/.exec(p);
  if (m) {
    const d = Number(m[1]);
    // this month, or the month before / after, nearest in the stated sense
    const opts: Day[] = [];
    for (const delta of [-1, 0, 1]) {
      const mm = today.m + delta;
      const y = mm < 1 ? today.y - 1 : mm > 12 ? today.y + 1 : today.y;
      const mo = ((mm - 1 + 12) % 12) + 1;
      if (realDay(y, mo, d)) opts.push({ y, m: mo, d });
    }
    const t = dayMs(today);
    const pick = sense === 'past' ? opts.filter((o) => dayMs(o) <= t).pop() : opts.find((o) => dayMs(o) >= t);
    return pick ? { day: pick } : null;
  }
  m = /^(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{4}|\d{2}))?$/.exec(p);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    if (m[3]) {
      let y = Number(m[3]);
      if (m[3].length === 2) y += 2000;
      return realDay(y, mo, d) ? { day: { y, m: mo, d } } : null;
    }
    const day = withYear(mo, d, today, sense);
    return day ? { day } : null;
  }
  m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)? (?:of )?(${MON})(?:,? (\\d{4}))?$`).exec(p);
  if (m) {
    const mo = MONTHS[m[2]!.slice(0, 3)]!;
    const d = Number(m[1]);
    if (m[3]) return realDay(Number(m[3]), mo, d) ? { day: { y: Number(m[3]), m: mo, d } } : null;
    const day = withYear(mo, d, today, sense);
    return day ? { day } : null;
  }
  m = new RegExp(`^(${MON}) (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?$`).exec(p);
  if (m) {
    const mo = MONTHS[m[1]!.slice(0, 3)]!;
    const d = Number(m[2]);
    if (m[3]) return realDay(Number(m[3]), mo, d) ? { day: { y: Number(m[3]), m: mo, d } } : null;
    const day = withYear(mo, d, today, sense);
    return day ? { day } : null;
  }
  return null;
}

function timeOf(g: Array<string | undefined>): { hh: number; mm: number } | null {
  // groups: [h1, m1, ap1, h2, m2, ap2, h3, ap3]
  let hh: number | undefined;
  let mm = 0;
  let ap: string | undefined;
  if (g[0] !== undefined) {
    hh = Number(g[0]);
    mm = g[1] ? Number(g[1]) : 0;
    ap = g[2];
  } else if (g[3] !== undefined) {
    hh = Number(g[3]);
    mm = Number(g[4]);
    ap = g[5];
  } else if (g[6] !== undefined) {
    hh = Number(g[6]);
    ap = g[7];
  }
  if (hh === undefined) return null;
  const a = ap?.toLowerCase();
  if (a === 'pm' && hh < 12) hh += 12;
  if (a === 'am' && hh === 12) hh = 0;
  if (!a && g[0] !== undefined && hh >= 1 && hh <= 7) hh += 12; // "at 3" in office talk is 15:00
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

function build(m: RegExpExecArray, now: ISODateTime, sense: 'past' | 'future'): ResolvedDate | null {
  const today = londonToday(now);
  const r = dayOf(m[1]!, today, sense);
  if (!r) return null;
  const t = timeOf(m.slice(2, 10));
  const hh = t?.hh ?? r.hh;
  const mm = t?.mm ?? r.mm ?? 0;
  const at = hh === undefined ? londonWallIso(r.day) : londonWallIso(r.day, hh, mm);
  if (Math.abs(Date.parse(at) - Date.parse(now)) > 2 * 366 * MS_PER_DAY) return null;
  return { at, precision: hh === undefined ? 'date' : 'datetime', text: m[0].trim() };
}

/** The first date expression in `text` (null when none, or when it is more than two years from now). */
export function findDatePhrase(text: string, now: ISODateTime, sense: 'past' | 'future'): FoundDate | null {
  for (const m of text.matchAll(DATE_RE_G)) {
    const r = build(m as RegExpExecArray, now, sense);
    if (r) return { ...r, index: m.index ?? 0, length: m[0].length };
  }
  return null;
}

/** Every date expression in `text`, in order. */
export function findAllDatePhrases(text: string, now: ISODateTime, sense: 'past' | 'future'): FoundDate[] {
  const out: FoundDate[] = [];
  for (const m of text.matchAll(DATE_RE_G)) {
    const r = build(m as RegExpExecArray, now, sense);
    if (r) out.push({ ...r, index: m.index ?? 0, length: m[0].length });
  }
  return out;
}

/** One phrase → a date (§3.2), or null. */
export function resolveDate(phrase: string, now: ISODateTime, sense: 'past' | 'future'): ResolvedDate | null {
  const m = new RegExp(`^\\s*(?:${DATE_RE.source})\\s*$`, 'i').exec(phrase);
  if (!m) return null;
  return build(m, now, sense);
}

/** "until <date>" = the start of that London day (the hold lifts at 00:00 London). */
export function startOfLondonDay(at: ISODateTime): ISODateTime {
  const day = londonDayIso(at);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return londonWallIso({ y, m, d });
}

/**
 * When a dated event is written: a date-only value is London noon of that day (as smart intake does), but never later
 * than `now` (an event "today" recorded at 10:00 is not dated in the future).
 */
export function eventAtFor(at: ISODateTime, precision: 'date' | 'datetime', now: ISODateTime): ISODateTime {
  if (precision === 'datetime') return at;
  const day = londonDayIso(at);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const noon = londonWallIso({ y, m, d }, 12, 0);
  return Date.parse(noon) > Date.parse(now) && londonDayIso(now) === day ? new Date(Date.parse(now)).toISOString() : noon;
}

/** A London 09:00 on the day of `at` (reminders). */
export function nineAm(at: ISODateTime): ISODateTime {
  const day = londonDayIso(at);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return londonWallIso({ y, m, d }, 9, 0);
}

/** Add working days (Mon–Fri; bank holidays not counted here) to a London day, keeping 09:00. */
export function addWeekdays(at: ISODateTime, n: number): ISODateTime {
  const day = londonDayIso(at);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  let cur: Day = { y, m, d };
  let left = n;
  while (left > 0) {
    cur = addDays(cur, 1);
    const wd = new Date(dayMs(cur)).getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return londonWallIso(cur, 9, 0);
}

const SHORT_WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const LONG_WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parts(at: ISODateTime) {
  const w = new Date(utcToLondonWall(Date.parse(at)));
  return { y: w.getUTCFullYear(), m: w.getUTCMonth(), d: w.getUTCDate(), wd: w.getUTCDay(), hh: w.getUTCHours(), mm: w.getUTCMinutes() };
}

/** "Sun 11 Oct 2026" (London). */
export function fmtDay(at: ISODateTime): string {
  const p = parts(at);
  return `${SHORT_WD[p.wd]} ${p.d} ${SHORT_MON[p.m]} ${p.y}`;
}
/** "11 Oct" (London). */
export function fmtDayShort(at: ISODateTime): string {
  const p = parts(at);
  return `${p.d} ${SHORT_MON[p.m]}`;
}
/** "Mon 19 Oct" (London). */
export function fmtDayWeek(at: ISODateTime): string {
  const p = parts(at);
  return `${SHORT_WD[p.wd]} ${p.d} ${SHORT_MON[p.m]}`;
}
/** "Monday 19 October 2026" (London). */
export function fmtDayLong(at: ISODateTime): string {
  const p = parts(at);
  return `${LONG_WD[p.wd]} ${p.d} ${LONG_MON[p.m]} ${p.y}`;
}
/** "2 October 2026" (London). */
export function fmtDateLong(at: ISODateTime): string {
  const p = parts(at);
  return `${p.d} ${LONG_MON[p.m]} ${p.y}`;
}
/** "Sun 11 Oct 2026 09:00" or the day only for date precision. */
export function fmtWhen(at: ISODateTime, precision: 'date' | 'datetime'): string {
  const p = parts(at);
  return precision === 'date' ? fmtDay(at) : `${fmtDay(at)} ${pad(p.hh)}:${pad(p.mm)}`;
}
