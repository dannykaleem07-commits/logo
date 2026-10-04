/**
 * Extractors for the position-consistency engine (BLUEPRINT §3.7): amounts, dates, deadlines, citations.
 * All indexes refer to the (plain) text passed in.
 */
import { parseGBP } from '../money.js';
import type { ISODate, Pence } from '../types.js';
import { addCalendarMonths, addWorkingDays as calendarAddWorkingDays } from '../calendar/index.js';
import { addCalendarDays, isValidYmd, monthNumber, toIsoDate } from './text.js';

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
  /**
   * How specific the keyword that gave the context was: 'strong' = a payment/offer/invoice verb or a status word
   * (claimed, outstanding, balance, total, due); 'weak' = a generic noun (charges, costs, claim). Ledger-mismatch
   * checks for claimed figures only fire on strong keywords, so an itemised breakdown line ("call-out £90") is not
   * compared with a head total.
   */
  strength?: 'strong' | 'weak';
}

const AMOUNT_RE = /£\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?!\d)/g;
const BEFORE_WINDOW = 80;
const AFTER_WINDOW = 40;

/**
 * Keyword tiers. A 'paid' verb before the amount in the same sentence beats a WEAK claimed noun ("the storage charges
 * of £1,287" after "you have paid") because the payment verb is the more specific assertion; STRONG status words
 * ("outstanding", "balance", "claimed", "total") keep the nearest-keyword rule so "after your payment the balance is
 * £232.60" still reads as a claimed figure.
 */
const CONTEXT_PATTERNS: Array<[Exclude<AmountContext, 'unknown'>, RegExp, 'strong' | 'weak']> = [
  ['paid', /\b(paid|received|receipt of|remitt(?:ed|ance)|settled|cleared funds|payment of|in payment|been paid|has paid|have paid|was paid|reimbursed)\b/gi, 'strong'],
  ['invoice', /\b(invoice[ds]?|inv\.|fee note)\b/gi, 'strong'],
  ['offered', /\b(offer(?:ed|s|ing)?|proposed|tender(?:ed|ing)?)\b/gi, 'strong'],
  ['claimed', /\b(claimed|outstanding|balance|total(?:ling)?|due|owed|owing)\b/gi, 'strong'],
  ['claimed', /\b(claim(?:s|ing)?|sum of|charges?|costs?|loss|damages)\b/gi, 'weak']
];

const NEGATION_RE = /\b(?:not|no|never|un|yet to|failed to|fail to|without|awaiting|nor|non-)\b|n['’]t\b/i;
const PER_UNIT_RE = /^\s*(?:\+\s*vat\s*|plus\s+vat\s*|ex\.?\s*vat\s*|inc\.?\s*vat\s*)?(?:(?:per|a|\/|each|every)\s*(day|hour|mile|week|month)|(daily|per\s+diem|hourly|weekly|monthly))\b/i;
const ADVERB_UNIT: Record<string, ExtractedAmount['perUnit']> = { daily: 'day', 'per diem': 'day', hourly: 'hour', weekly: 'week', monthly: 'month' };
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
    // Keywords are read within the amount's own sentence: "…admin £25.00. The outstanding balance is £232.60" must
    // not make £25.00 an outstanding figure, and "We received your letter. £1,287 remains outstanding" must not make
    // £1,287 a payment. Newlines are not sentence ends (a two-cell table row "Amount received | £1,287.00" is one unit).
    const before = sentenceTail(text.slice(Math.max(0, start - BEFORE_WINDOW), start));
    const after = sentenceHead(text.slice(end, end + AFTER_WINDOW));

    let best: { ctx: AmountContext; distance: number; tier: 'strong' | 'weak' } | undefined;
    let paidBefore = false; // a non-negated payment verb before the amount, in this sentence, with no other £ amount between
    const sentenceStart = Math.max(before.lastIndexOf('\n'), before.search(/[.!?]\s+(?=[^.!?]*$)/)) + 1;
    for (const [ctx, re, tier] of CONTEXT_PATTERNS) {
      re.lastIndex = 0;
      let k: RegExpExecArray | null;
      while ((k = re.exec(before)) !== null) {
        const distance = before.length - (k.index + k[0].length);
        let effective: AmountContext = ctx;
        const negated = ctx === 'paid' && NEGATION_RE.test(before.slice(Math.max(0, k.index - 30), k.index));
        if (negated) effective = 'claimed';
        if (ctx === 'paid' && !negated && k.index >= sentenceStart && !/£/.test(before.slice(k.index))) paidBefore = true;
        if (!best || distance < best.distance) best = { ctx: effective, distance, tier };
      }
      re.lastIndex = 0;
      while ((k = re.exec(after)) !== null) {
        const distance = k.index + 1; // small bias towards keywords before the amount
        let effective: AmountContext = ctx;
        if (ctx === 'paid' && NEGATION_RE.test(after.slice(0, k.index))) effective = 'claimed';
        if (!best || distance < best.distance) best = { ctx: effective, distance, tier };
      }
    }
    if (best && best.tier === 'weak' && paidBefore) best = { ctx: 'paid', distance: best.distance, tier: 'strong' };

    const item: ExtractedAmount = {
      pence,
      excerpt: excerpt(text, start, end),
      index: start,
      context: best?.ctx ?? 'unknown'
    };
    if (best) item.strength = best.tier;
    const unit = after.match(PER_UNIT_RE);
    if (unit && unit[1]) item.perUnit = unit[1].toLowerCase() as ExtractedAmount['perUnit'];
    else if (unit && unit[2]) item.perUnit = ADVERB_UNIT[unit[2].toLowerCase().replace(/\s+/g, ' ')];
    const rest = unit ? after.slice(unit[0].length) : after;
    if (VAT_NET_RE.test(after) || VAT_NET_RE.test(rest)) item.vatHint = 'net';
    else if (VAT_GROSS_RE.test(after) || VAT_GROSS_RE.test(rest)) item.vatHint = 'gross';
    out.push(item);
  }
  return out;
}

/** The part of `s` after its last sentence end ("." / "!" / "?" followed by whitespace). */
function sentenceTail(s: string): string {
  const re = /[.!?]\s+/g;
  let cut = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) cut = m.index + m[0].length;
  return s.slice(cut);
}

/** The part of `s` before its first sentence end. */
function sentenceHead(s: string): string {
  const m = /[.!?](?:\s|$)/.exec(s);
  return m ? s.slice(0, m.index) : s;
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
const DEMAND_CUE_RE = /\b(require[sd]?|respond|reply|pay|paid|payment|remit|settle|confirm|provide|send|return|response|please|must|should|shall|expect|deadline|due|owed|forward|supply|produce|serve|file|issue|comply|respon|invoice|(?:is|are)\s+to\s+be)\w*/i;
/**
 * A past-tense passive before "by" ("was collected by 4 October", "has been paid by 1 October") describes an event,
 * not a deadline. Modal passives ("must be made by", "should be received by", "is to be paid by") ARE demands and
 * must stay in: they are the commonest deadline phrasing in letters.
 */
const PASSIVE_BEFORE_RE = /\b(?:was|were|(?:has|have|had)\s+been)\s+(?:collected|delivered|returned|signed|received|sent|issued|paid|made|repaired|inspected|instructed|completed|authorised|authorized|notified|confirmed|settled|agreed|released|written|dated|caused|driven)\s*$/i;
/** What may sit between "by" and the date: a time ("5pm", "5:00 pm", "17:00 hrs", "noon", "close of business"), "on", a weekday, "the". */
const DEADLINE_GAP_RE = /^\s*(?:(?:\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|hrs|hours|noon|o['’]clock)?|noon|midday|midnight|close\s+of\s+(?:business|play)|end\s+of\s+(?:the\s+)?(?:day|business))\s*,?\s*)?(?:on\s+)?(?:(?:Mon|Tues?|Wednes|Thurs?|Fri|Satur|Sun)day,?\s+)?(?:the\s+)?$/i;
const NUMBER_WORD = '\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fourteen|fifteen|twenty[-\\s]one|twenty[-\\s]eight|twenty|thirty|sixty|ninety';
/** Words that frame a period as a description of a rule, practice or someone's duty rather than a demand on the reader. */
const RULE_FRAMING_RE = /\b(?:practice|industry|benchmark|GTA|ICOBS|DISP|CPR|regulation|rules?\b|guidance|duty|requires?\s+(?:a|an|the|every)\s+(?:motor|insurer|firm|claimant)|provides?\s+for|is\s+that)\b/i;
const RELATIVE_RE = new RegExp(`\\bwithin\\s+(${NUMBER_WORD})\\s+(working\\s+|business\\s+|calendar\\s+|clear\\s+)?(days?|weeks?|months?)\\b`, 'gi');

const RELATIVE_FROM_LETTER_RE = new RegExp(`\\b(${NUMBER_WORD})\\s+(working\\s+|business\\s+|calendar\\s+|clear\\s+)?(days?|weeks?|months?)\\s+(?:from|of|after)\\s+(?:the\\s+)?date\\s+of\\s+this\\s+(?:letter|notice|email)\\b`, 'gi');

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fourteen: 14, fifteen: 15, twenty: 20,
  'twenty one': 21, 'twenty-one': 21, 'twenty eight': 28, 'twenty-eight': 28, thirty: 30, sixty: 60, ninety: 90
};

/**
 * Dates that are stated as deadlines: an absolute date preceded (within 25 characters) by a deadline keyword and a demand
 * cue within 100 characters; or "within N (working) days/months" from the base date. Passive constructions
 * ("was collected by 4 October") are not deadlines.
 */
export function extractDeadlines(text: string, opts: DeadlineOptions = {}): ExtractedDeadline[] {
  const out: ExtractedDeadline[] = [];
  const dates = extractDates(text);
  for (const d of dates) {
    const wide = text.slice(Math.max(0, d.index - 100), d.index);
    // keep to the current sentence: a deadline keyword or demand cue in the previous sentence does not count
    const boundary = Math.max(wide.lastIndexOf('\n'), wide.search(/[.!?]\s+(?=[^.!?]*$)/) >= 0 ? wide.search(/[.!?]\s+(?=[^.!?]*$)/) + 1 : -1);
    const before = boundary >= 0 ? wide.slice(boundary) : wide;
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
    if (gap.length > 48 || /\d{4}/.test(gap)) continue; // another date or too far
    if (!DEADLINE_GAP_RE.test(gap)) continue;
    const beforeKeyword = before.slice(0, before.length - gap.length - keyword.length);
    if (PASSIVE_BEFORE_RE.test(beforeKeyword)) continue;
    if (!DEMAND_CUE_RE.test(before) && !/^(?:deadline|due)/i.test(keyword)) continue;
    out.push({ iso: d.iso, excerpt: d.excerpt, index: d.index, kind: 'absolute' });
  }

  if (opts.baseDate) {
    const addWd = opts.addWorkingDays ?? ((date: ISODate, n: number) => calendarAddWorkingDays(date, n));
    // "within 14 days of the date of this letter" matches both patterns at different offsets: one deadline, not two.
    const covered: Array<[number, number]> = [];
    for (const re of [RELATIVE_RE, RELATIVE_FROM_LETTER_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const mStart = m.index;
        const mEnd = m.index + m[0].length;
        if (covered.some(([s, e]) => mStart < e && mEnd > s)) continue;
        const before = text.slice(Math.max(0, m.index - 80), m.index);
        if (!DEMAND_CUE_RE.test(before) && !DEMAND_CUE_RE.test(text.slice(m.index + m[0].length, m.index + m[0].length + 40))) continue;
        // A period that describes a rule or another party's duty is not a deadline counted from this letter:
        // "a clean pack is settled within one calendar month (GTA 6.7)", "ICOBS 8.2.6R requires an insurer, within
        // three months of receiving a claim, to …". Skip when the same sentence frames it as practice/rule, or the
        // period runs from some other event ("of receiving", "from dispatch") rather than this letter.
        const sentenceBefore = before.slice(Math.max(before.lastIndexOf('. '), before.lastIndexOf('\n')) + 1);
        const afterText = text.slice(mEnd, mEnd + 50);
        if (re === RELATIVE_RE) {
          if (RULE_FRAMING_RE.test(sentenceBefore)) continue;
          if (/^\s*(?:of|from|after)\b/i.test(afterText) && !/^\s*(?:of|from|after)\s+(?:the\s+)?(?:date\s+of\s+)?(?:this|receipt\s+of\s+this)\s+(?:letter|notice|email)\b/i.test(afterText)) continue;
        }
        const nRaw = (m[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
        const n = /^\d+$/.test(nRaw) ? Number(nRaw) : WORDS[nRaw];
        if (!n) continue;
        covered.push([mStart, mEnd]);
        const qualifier = (m[2] ?? '').trim().toLowerCase();
        const unit = (m[3] ?? '').toLowerCase();
        const working = qualifier === 'working' || qualifier === 'business';
        let iso: ISODate;
        const item: ExtractedDeadline = { iso: '', excerpt: excerpt(text, m.index, m.index + m[0].length), index: m.index, kind: 'relative' };
        if (unit.startsWith('month')) {
          iso = addCalendarMonths(opts.baseDate, n);
          item.months = n;
        } else if (unit.startsWith('week')) {
          iso = addCalendarDays(opts.baseDate, 7 * n);
          item.days = 7 * n;
          item.workingDays = false;
        } else {
          iso = working ? addWd(opts.baseDate, n) : addCalendarDays(opts.baseDate, n);
          item.days = n;
          item.workingDays = working;
        }
        item.iso = iso;
        out.push(item);
      }
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

export interface ExtractedCitation {
  /** As written: "Stevens v Equity Syndicate Management [2015] EWCA Civ 93", "[2003] UKHL 64" or "Copley v Lawn". */
  citation: string;
  kind: 'neutral' | 'case_name' | 'full';
  /** The neutral/report citation part, when present. */
  neutral?: string;
  /** The "X v Y" part, when present. */
  caseName?: string;
  excerpt: string;
  index: number;
}

const NEUTRAL_RE = /\[(\d{4})\]\s+(?:\d+\s+)?[A-Z][A-Za-z]*(?:\s+[A-Za-z]+(?:\s+\([A-Za-z]+\))?)?\s+\d+/g;
const LEADING_WORD_RE = /^(?:See|In|Per|Following|Under|Applying|Also|Compare|And|But|The|As|Cf|By|On|At|From|With|Consider|Citing|Although|Since|However|Whereas|Where|Because|If|When|While|For|To|Of|Our|Your|Their|This|That|These|Those)\s+/;
const CASE_NAME_RE = /\b([A-Z][A-Za-z'’&.\-]+(?:\s+(?:[A-Z][A-Za-z'’&.\-]+|of|and|&|the)){0,4})\s+v\.?\s+([A-Z][A-Za-z'’&.\-]+(?:\s+(?:[A-Z][A-Za-z'’&.\-]+|of|and|&|the)){0,4})/g;

/**
 * Case citations in the text. A case name immediately followed by a neutral citation is returned as one 'full' item.
 */
export function extractCitations(text: string): ExtractedCitation[] {
  const neutrals: Array<{ start: number; end: number; text: string }> = [];
  NEUTRAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NEUTRAL_RE.exec(text)) !== null) neutrals.push({ start: m.index, end: m.index + m[0].length, text: m[0].replace(/\s+/g, ' ').trim() });

  const names: Array<{ start: number; end: number; text: string }> = [];
  CASE_NAME_RE.lastIndex = 0;
  while ((m = CASE_NAME_RE.exec(text)) !== null) {
    // trim a trailing year bracket that the greedy name pattern may have swallowed
    let raw = m[0];
    let start = m.index;
    const cut = raw.search(/\s+\[\d{4}\]/);
    if (cut >= 0) raw = raw.slice(0, cut);
    // a name never runs past a sentence end ("Esure Insurance Ltd. Copley v Lawn" is two things); rescan from the cut
    const sentenceEnd = raw.search(/\.\s+(?=[A-Z])/);
    if (sentenceEnd >= 0) {
      raw = raw.slice(0, sentenceEnd + 1);
      CASE_NAME_RE.lastIndex = m.index + raw.length;
    }
    // drop leading sentence words ("See Stevens v …", "In Copley v …") and trailing punctuation
    let lead: RegExpMatchArray | null;
    while ((lead = raw.match(LEADING_WORD_RE)) !== null) {
      raw = raw.slice(lead[0].length);
      start += lead[0].length;
    }
    raw = raw.replace(/[.,;:]+$/, '');
    if (!/\sv\.?\s/.test(raw)) continue;
    names.push({ start, end: start + raw.length, text: raw.replace(/\s+/g, ' ').trim() });
  }

  const out: ExtractedCitation[] = [];
  const usedNeutral = new Set<number>();
  for (const n of names) {
    const follow = neutrals.find((c, i) => !usedNeutral.has(i) && c.start >= n.end && /^[\s,;:(]*$/.test(text.slice(n.end, c.start)) && c.start - n.end <= 4);
    if (follow) {
      usedNeutral.add(neutrals.indexOf(follow));
      out.push({ citation: `${n.text} ${follow.text}`, kind: 'full', neutral: follow.text, caseName: n.text, excerpt: excerpt(text, n.start, follow.end), index: n.start });
    } else {
      out.push({ citation: n.text, kind: 'case_name', caseName: n.text, excerpt: excerpt(text, n.start, n.end), index: n.start });
    }
  }
  neutrals.forEach((c, i) => {
    if (usedNeutral.has(i)) return;
    out.push({ citation: c.text, kind: 'neutral', neutral: c.text, excerpt: excerpt(text, c.start, c.end), index: c.start });
  });
  return out.sort((a, b) => a.index - b.index);
}
