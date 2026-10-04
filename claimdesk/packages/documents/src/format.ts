/**
 * Shared formatters for every document template.
 *
 * Templates must never hand-build money or date strings: everything goes through here so the
 * position-consistency engine (domain/consistency) can parse what we print and compare it with the ledger.
 *
 *  - Money: integer pence in, `formatGBP` out (from @ccguk/domain).
 *  - Dates: ISO strings in (`YYYY-MM-DD` or full ISO 8601). Date-times are shown in Europe/London.
 *  - Invalid dates throw — a document must never render "Invalid Date".
 */
import { formatGBP, sumPence, hireDays } from '@ccguk/domain';
import type { Address, ISODate, ISODateTime, Pence } from '@ccguk/domain';

export { formatGBP, sumPence };

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
] as const;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DateParts {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
  hour: number; // 0–23 (0 for a plain ISODate)
  minute: number;
  weekday: number; // 0 = Sunday
  hasTime: boolean;
}

const londonFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hour12: false
});

const SHORT_WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Split an ISO date or date-time into calendar parts (Europe/London for date-times). Throws on invalid input. */
export function dateParts(iso: ISODate | ISODateTime): DateParts {
  if (typeof iso !== 'string' || iso.trim() === '') {
    throw new TypeError(`Expected an ISO date string, received ${JSON.stringify(iso)}`);
  }
  const m = ISO_DATE_RE.exec(iso.trim());
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
      throw new TypeError(`Invalid calendar date: ${iso}`);
    }
    return { year, month, day, hour: 0, minute: 0, weekday: probe.getUTCDay(), hasTime: false };
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new TypeError(`Invalid ISO date-time: ${iso}`);
  const parts: Record<string, string> = {};
  for (const p of londonFormatter.formatToParts(d)) parts[p.type] = p.value;
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    hour: Number(parts['hour']) % 24, // Intl may emit "24" for midnight in some ICU builds
    minute: Number(parts['minute']),
    weekday: SHORT_WEEKDAYS[parts['weekday'] ?? ''] ?? new Date(d).getUTCDay(),
    hasTime: true
  };
}

/** `4 October 2026` */
export function formatDateLong(iso: ISODate | ISODateTime): string {
  const p = dateParts(iso);
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
}

/** `Sunday 4 October 2026` — use for deadlines so the reader can see the day of the week. */
export function formatDateWithDay(iso: ISODate | ISODateTime): string {
  const p = dateParts(iso);
  return `${DAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
}

/** `04/10/2026` */
export function formatDateShort(iso: ISODate | ISODateTime): string {
  const p = dateParts(iso);
  return `${pad2(p.day)}/${pad2(p.month)}/${p.year}`;
}

/** `14:35` (Europe/London). A plain ISODate formats as `00:00`. */
export function formatTime(iso: ISODate | ISODateTime): string {
  const p = dateParts(iso);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** `4 October 2026, 14:35` (Europe/London). A plain ISODate renders without the time. */
export function formatDateTime(iso: ISODate | ISODateTime): string {
  const p = dateParts(iso);
  const date = `${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
  return p.hasTime ? `${date}, ${pad2(p.hour)}:${pad2(p.minute)}` : date;
}

/** `October 2026` */
export function formatMonthYear(iso: ISODate | ISODateTime): string {
  const p = dateParts(iso);
  return `${MONTHS[p.month - 1]} ${p.year}`;
}

/** Calendar date (Europe/London) as `YYYY-MM-DD`. */
export function toISODate(iso: ISODate | ISODateTime): ISODate {
  const p = dateParts(iso);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Inclusive day count between two dates: 10 Aug → 2 Sep = 24 days. Same day = 1. */
export function daysInclusive(start: ISODate | ISODateTime, end: ISODate | ISODateTime): number {
  const a = dateParts(start);
  const b = dateParts(end);
  const ua = Date.UTC(a.year, a.month - 1, a.day);
  const ub = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((ub - ua) / 86_400_000) + 1;
}

/**
 * Chargeable days for a period, using the same convention as the ledger:
 * - date-times (hire, storage with times): 24-hour periods started, on the London wall clock (@ccguk/domain hireDays);
 * - plain dates: inclusive calendar count.
 * A letter must never print a day count that differs from the invoice, so templates pass the ledger figure when they have it.
 */
export function chargeableDays(start: ISODate | ISODateTime, end: ISODate | ISODateTime): number {
  const timed = start.includes('T') && end.includes('T');
  return timed ? hireDays(start, end) : daysInclusive(start, end);
}

/** `10 August 2026 to 2 September 2026 (23 days)` — `days` is the ledger figure when known; otherwise {@link chargeableDays}. */
export function formatPeriod(start: ISODate | ISODateTime, end: ISODate | ISODateTime, days?: number): string {
  const n = days ?? chargeableDays(start, end);
  return `${formatDateLong(start)} to ${formatDateLong(end)} (${plural(n, 'day')})`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Money and numbers
// ---------------------------------------------------------------------------

/** `£1,287.50` — alias of formatGBP so templates import one module. */
export const formatMoney = (pence: Pence): string => formatGBP(pence);

/** `£1,287` — whole pounds only; use for narrative figures the ledger holds in whole pounds. */
export const formatMoneyWhole = (pence: Pence): string => formatGBP(pence, { showPence: false });

/** `£49.80 per day` */
export function formatRate(pence: Pence, unit: string): string {
  return `${formatGBP(pence)} per ${unit}`;
}

/** 0.2 → `20%` */
export function formatPercent(rate: number, decimals = 0): string {
  return `${(rate * 100).toFixed(decimals)}%`;
}

/** 12345 → `12,345` */
export function formatNumber(n: number, decimals = 0): string {
  return n.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** 12345 → `12,345 miles` */
export function formatMiles(n: number): string {
  return plural(n, 'mile');
}

/** `1 day`, `24 days`, `3 working days` (pass `pluralWord` when it is not singular + "s"). */
export function plural(n: number, singular: string, pluralWord?: string): string {
  const word = n === 1 ? singular : (pluralWord ?? `${singular}s`);
  return `${formatNumber(n)} ${word}`;
}

/** 1 → `1st`, 2 → `2nd`, 23 → `23rd`, 11 → `11th` */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

// ---------------------------------------------------------------------------
// Vehicles, addresses
// ---------------------------------------------------------------------------

/**
 * Display form of a UK registration mark: `AB12 CDE`, `A123 BCD`, `ABC 123D`.
 * Unrecognised formats are returned upper-cased without spaces.
 */
export function formatRegistration(reg: string): string {
  const s = (reg ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  let m = /^([A-Z]{2}\d{2})([A-Z]{3})$/.exec(s); // current format (2001–)
  if (m) return `${m[1]} ${m[2]}`;
  m = /^([A-Z]\d{1,3})([A-Z]{3})$/.exec(s); // prefix (1983–2001)
  if (m) return `${m[1]} ${m[2]}`;
  m = /^([A-Z]{3})(\d{1,3}[A-Z])$/.exec(s); // suffix (1963–1983)
  if (m) return `${m[1]} ${m[2]}`;
  return s;
}

/** Address → display lines (empty parts dropped). */
export function addressLines(address: Address | undefined | null): string[] {
  if (!address) return [];
  const lines = [address.line1, address.line2, address.town, address.county, address.postcode];
  if (address.country && address.country.toUpperCase() !== 'GB' && address.country.toLowerCase() !== 'united kingdom') {
    lines.push(address.country);
  }
  return lines.filter((l): l is string => typeof l === 'string' && l.trim() !== '').map((l) => l.trim());
}

/** Address as one line: `1 Example Street, Example Town, EX1 1AA`. */
export function formatAddressInline(address: Address | undefined | null): string {
  return addressLines(address).join(', ');
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

/** Escape text for HTML. Every piece of data rendered into a template goes through this (or a partial that does). */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * Plain text → paragraphs. Blank lines separate paragraphs; single line breaks become `<br>`.
 * Text is escaped; the result is safe to drop into a layout.
 */
export function nl2p(text: string | undefined | null, className?: string): string {
  if (!text) return '';
  const cls = className ? ` class="${escapeHtml(className)}"` : '';
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((para) => para.trim())
    .filter((para) => para !== '')
    .map((para) => `<p${cls}>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

export interface ListOptions {
  /** Items are already HTML (from other partials); skip escaping. Default false. */
  html?: boolean;
  /** First number for a numbered list. Default 1. */
  start?: number;
  className?: string;
}

/** Numbered requirements list — every request in a letter is numbered so the reply can be checked for omissions. */
export function numberedList(items: ReadonlyArray<string>, opts: ListOptions = {}): string {
  if (items.length === 0) return '';
  const start = opts.start && opts.start !== 1 ? ` start="${Math.trunc(opts.start)}"` : '';
  const cls = `numbered${opts.className ? ` ${escapeHtml(opts.className)}` : ''}`;
  const lis = items.map((it) => `  <li>${opts.html ? it : escapeHtml(it)}</li>`).join('\n');
  return `<ol class="${cls}"${start}>\n${lis}\n</ol>`;
}

/** Bulleted list. */
export function bulletList(items: ReadonlyArray<string>, opts: Omit<ListOptions, 'start'> = {}): string {
  if (items.length === 0) return '';
  const cls = `bullets${opts.className ? ` ${escapeHtml(opts.className)}` : ''}`;
  const lis = items.map((it) => `  <li>${opts.html ? it : escapeHtml(it)}</li>`).join('\n');
  return `<ul class="${cls}">\n${lis}\n</ul>`;
}

/** `["a","b","c"]` → `a, b and c` */
export function joinAnd(items: ReadonlyArray<string>): string {
  const xs = items.filter((x) => x && x.trim() !== '');
  if (xs.length === 0) return '';
  if (xs.length === 1) return xs[0]!;
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
