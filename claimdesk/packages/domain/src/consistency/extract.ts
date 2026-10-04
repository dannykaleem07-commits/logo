/**
 * Extractors for the position-consistency engine (BLUEPRINT §3.7): amounts, dates, deadlines, citations.
 * All indexes refer to the (plain) text passed in.
 */
import { parseGBP } from '../money.js';
import type { ISODate, Pence } from '../types.js';
import { addCalendarDays, addCalendarMonthsSimple, addWorkingDaysSimple, isValidYmd, monthNumber, toIsoDate } from './text.js';

export type AmountContext = 'paid' | 'claimed' | 'offered' | 'invoice' | 'unknown';

export interface ExtractedAmount {
  pence: Pence;
  excerpt: string;
  index: number;
  context: AmountContext;
  /** Set when the amount is a rate ("£49.80 per day") — rates are not compared with ledger totals. */
  perUnit?: 'day' | 'hour' | 'mile' | 'week' | 'month';
  /** 'net' when followed by "+ VAT"/"ex VAT", 'gross' when "inc VAT"/"including VAT". */
  vatHint?: 'net' | 'gross';
}

const AMOUNT_RE = /£\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?!\d)/g;
const BEFORE_WINDOW = 80;
const AFTER_WINDOW = 40;

const CONTEXT_PATTERNS: Array<[Exclude<AmountContext, 'unknown'>, RegExp]> = [
  ['paid', /\b(paid|received|receipt of|remitt(?:ed|ance)|settled|cleared funds|payment of|in payment|been paid|has paid|have paid|was paid)\b/gi],
  ['invoice', /\b(invoice[ds]?|inv\.|fee note)\b/gi],
  ['offered', /\b(offer(?:ed|s)?|proposed|tender(?:ed)?)\b/gi],
  ['claimed', /\b(claimed|claim(?:s|ing)?|outstanding|balance|total(?:ling)?|due|owed|owing|sum of|charges?|costs?|loss|damages)\b/gi]
];

const NEGATION_RE = /\b(?:not|no|never|un|yet to|failed to|fail to|without|awaiting|nor|non-)\b|n['’]t\b/i;
const PER_UNIT_RE = /^\s*(?:\+\s*vat\s*|plus\s+vat\s*|ex\.?\s*vat\s*|inc\.?\s*vat\s*)?(?:per|a|\/|each|every)\s*(day|hour|mile|week|month)/i;
const VAT_NET_RE = /^\s*(?:\+|plus|ex\.?|excluding|exclusive of|net of)\s*(?:of\s+)?vat\b/i;
const VAT_GROSS_RE = /^\s*(?:inc\.?|incl\.?|including|inclusive of|gross of)\s*(?:of\s+)?vat\b/i;

export function extractAmounts(text: string): ExtractedAmount[] {
  const out: ExtractedAmount[] = [];
  AMOUNT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AMOUNT_RE.exec(text)) !== null) {
    const raw = `£${m[1]}${m[2] ? `.${m[2]}` : ''}`;
    const pence = parseGBP(raw);
    if (pence === null) continue;
    const start = m.index;
    const end = m.index + m[0].length;
    const before = text.slice(Math.max(0, start - BEFORE_WINDOW), start);
    const after = text.slice(end, end + AFTER_WINDOW);

    let best: { ctx: AmountContext; distance: number } | undefined;
    for (const [ctx, re] of CONTEXT_PATTERNS) {
      re.lastIndex = 0;
      let k: RegExpExecArray | null;
      while ((k = re.exec(before)) !== null) {
        const distance = before.length - (k.index + k[0].length);
        let effective: AmountContext = ctx;
        if (ctx === 'paid' && NEGATION_RE.test(before.slice(Math.max(0, k.index - 30), k.index))) effective = 'claimed';
        if (!best || distance < best.distance) best = { ctx: effective, distance };
      }
      re.lastIndex = 0;
      while ((k = re.exec(after)) !== null) {
        const distance = k.index + 1; // small bias towards keywords before the amount
        let effective: AmountContext = ctx;
        if (ctx === 'paid' && NEGATION_RE.test(after.slice(0, k.index))) effective = 'claimed';
        if (!best || distance < best.distance) best = { ctx: effective, distance };
      }
    }

    const item: ExtractedAmount = {
      pence,
      excerpt: excerpt(text, start, end),
      index: start,
      context: best?.ctx ?? 'unknown'
    };
    const unit = after.match(PER_UNIT_RE);
    if (unit && unit[1]) item.perUnit = unit[1].toLowerCase() as ExtractedAmount['perUnit'];
    if (VAT_NET_RE.test(after)) item.vatHint = 'net';
    else if (VAT_GROSS_RE.test(after)) item.vatHint = 'gross';
    out.push(item);
  }
  return out;
}

function excerpt(text: string, start: number, end: number, radius = 40): string {
  const s = Math.max(0, start - radius);
  const e = Math.min(text.length, end + radius);
  return `${s > 0 ? '…' : ''}${text.slice(s, e).replace(/\s+/g, ' ').trim()}${e < text.length ? '…' : ''}`;
}

export interface ExtractedDate {
  iso: ISODate;
  excerpt: string;
  index: number;
  /** The literal matched, e.g. "4 October 2026". */
  raw: string;
}

const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DATE_PATTERNS: Array<{ re: RegExp; parse: (m: RegExpExecArray) => [number, number, number] | undefined }> = [
  // ISO 2026-10-04
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, parse: (m) => [Number(m[1]), Number(m[2]), Number(m[3])] },
  // 04/10/2026, 4.10.2026, 04-10-2026 (day first, UK)
  { re: /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\b/g, parse: (m) => [Number(m[3]), Number(m[2]), Number(m[1])] },
  // 4 October 2026, 4th Oct 2026, 4 October, 2026
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE},?\\s+(\\d{4})\\b`, 'gi'),
    parse: (m) => {
      const mon = monthNumber(m[2] ?? '');
      return mon ? [Number(m[3]), mon, Number(m[1])] : undefined;
    }
  },
  // October 4, 2026 / October 4th 2026
  {
    re: new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'),
    parse: (m) => {
      const mon = monthNumber(m[1] ?? '');
      return mon ? [Number(m[3]), mon, Number(m[2])] : undefined;
    }
  }
];

/** Every recognisable date in the text, in order of appearance, without overlaps. */
export function extractDates(text: string): ExtractedDate[] {
  const found: ExtractedDate[] = [];
  const taken: Array<[number, number]> = [];
  for (const p of DATE_PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      const ymd = p.parse(m);
      if (!ymd || !isValidYmd(ymd[0], ymd[1], ymd[2])) continue;
      taken.push([start, end]);
      found.push({ iso: toIsoDate(ymd[0], ymd[1], ymd[2]), excerpt: excerpt(text, start, end), index: start, raw: m[0] });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

export interface ExtractedDeadline {
  iso: ISODate;
  excerpt: string;
  index: number;
  kind: 'absolute' | 'relative';
  /** For relative deadlines: the number stated and whether it was working days. */
  days?: number;
  workingDays?: boolean;
  months?: number;
}

export interface DeadlineOptions {
  /** Base date for "within N days" (the draft's date). Relative deadlines are skipped without it. */
  baseDate?: ISODate;
  addWorkingDays?: (date: ISODate, n: number) => ISODate;
}

const DEADLINE_KEYWORD_RE = /\b(by|before|no later than|not later than|on or before|until|deadline(?: of| is)?|due(?: on| by)?|within)\b/gi;
const DEMAND_CUE_RE = /\b(require[sd]?|respond|reply|pay|payment|remit|settle|confirm|provide|send|return|response|please|must|should|expect|deadline|due|forward|supply|produce|serve|file|issue|comply|respon)\w*/i;
const PASSIVE_BEFORE_RE = /\b(?:was|were|been|is|are|be|being)\s+(?:collected|delivered|returned|signed|received|sent|issued|paid|made|repaired|inspected|instructed|completed|authorised|authorized|notified|confirmed|settled|agreed|released|written|dated|caused|driven)\s*$/i;
const RELATIVE_RE = /\bwithin\s+(\d{1,3}|one|two|three|four|five|six|seven|ten|fourteen|twenty[-\s]one|twenty[-\s]eight|thirty)\s+(working\s+|business\s+|calendar\s+|clear\s+)?(days?|months?)\b/gi;

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14, 'twenty one': 21, 'twenty-one': 21, 'twenty eight': 28, 'twenty-eight': 28, thirty: 30 };

/**
 * Dates that are stated as deadlines: an absolute date preceded (within 25 characters) by a deadline keyword and a demand
 * cue within 100 characters; or "within N (working) days/months" from the base date. Passive constructions
 * ("was collected by 4 October") are not deadlines.
 */
export function extractDeadlines(text: string, opts: DeadlineOptions = {}): ExtractedDeadline[] {
  const out: ExtractedDeadline[] = [];
  const dates = extractDates(text);
  for (const d of dates) {
    const before = text.slice(Math.max(0, d.index - 100), d.index);
    let keywordEnd = -1;
    let keyword = '';
    DEADLINE_KEYWORD_RE.lastIndex = 0;
    let k: RegExpExecArray | null;
    while ((k = DEADLINE_KEYWORD_RE.exec(before)) !== null) {
      keywordEnd = k.index + k[0].length;
      keyword = k[0];
    }
    if (keywordEnd < 0) continue;
    const gap = before.slice(keywordEnd);
    if (gap.length > 25 || /\d{4}/.test(gap)) continue; // another date or too far
    if (!/^\s*(?:(?:5|4|12)\s*(?:pm|am|noon)\s*(?:on\s+)?|close of business\s+(?:on\s+)?|midday\s+(?:on\s+)?|the\s+|on\s+|close of play\s+(?:on\s+)?)?$/i.test(gap)) continue;
    const beforeKeyword = before.slice(0, before.length - gap.length - keyword.length);
    if (PASSIVE_BEFORE_RE.test(beforeKeyword)) continue;
    if (!DEMAND_CUE_RE.test(before) && !/^(?:deadline|due)/i.test(keyword)) continue;
    out.push({ iso: d.iso, excerpt: d.excerpt, index: d.index, kind: 'absolute' });
  }

  if (opts.baseDate) {
    const addWd = opts.addWorkingDays ?? addWorkingDaysSimple;
    RELATIVE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RELATIVE_RE.exec(text)) !== null) {
      const before = text.slice(Math.max(0, m.index - 80), m.index);
      if (!DEMAND_CUE_RE.test(before) && !DEMAND_CUE_RE.test(text.slice(m.index + m[0].length, m.index + m[0].length + 40))) continue;
      const nRaw = (m[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
      const n = /^\d+$/.test(nRaw) ? Number(nRaw) : WORDS[nRaw];
      if (!n) continue;
      const qualifier = (m[2] ?? '').trim().toLowerCase();
      const unit = (m[3] ?? '').toLowerCase();
      const working = qualifier === 'working' || qualifier === 'business';
      let iso: ISODate;
      const item: ExtractedDeadline = { iso: '', excerpt: excerpt(text, m.index, m.index + m[0].length), index: m.index, kind: 'relative' };
      if (unit.startsWith('month')) {
        iso = addCalendarMonthsSimple(opts.baseDate, n);
        item.months = n;
      } else {
        iso = working ? addWd(opts.baseDate, n) : addCalendarDays(opts.baseDate, n);
        item.days = n;
        item.workingDays = working;
      }
      item.iso = iso;
      out.push(item);
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

export interface ExtractedCitation {
  /** Neutral or report citation, e.g. "[2015] EWCA Civ 93", or the case name "Stevens v Equity Syndicate Management". */
  citation: string;
  kind: 'neutral' | 'case_name';
  excerpt: string;
  index: number;
}

const NEUTRAL_RE = /\[(\d{4})\]\s+(?:\d+\s+)?[A-Z][A-Za-z]*(?:\s+[A-Za-z]+(?:\s+\([A-Za-z]+\))?)?\s+\d+/g;
const CASE_NAME_RE = /\b([A-Z][A-Za-z'’&.\-]+(?:\s+(?:[A-Z][A-Za-z'’&.\-]+|of|and|&|the)){0,4})\s+v\.?\s+([A-Z][A-Za-z'’&.\-]+(?:\s+(?:[A-Z][A-Za-z'’&.\-]+|of|and|&|the)){0,4})/g;

export function extractCitations(text: string): ExtractedCitation[] {
  const out: ExtractedCitation[] = [];
  NEUTRAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NEUTRAL_RE.exec(text)) !== null) {
    out.push({ citation: m[0].replace(/\s+/g, ' ').trim(), kind: 'neutral', excerpt: excerpt(text, m.index, m.index + m[0].length), index: m.index });
  }
  CASE_NAME_RE.lastIndex = 0;
  while ((m = CASE_NAME_RE.exec(text)) !== null) {
    const name = m[0].replace(/\s+/g, ' ').trim();
    out.push({ citation: name, kind: 'case_name', excerpt: excerpt(text, m.index, m.index + m[0].length), index: m.index });
  }
  return out.sort((a, b) => a.index - b.index);
}
