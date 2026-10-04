/**
 * Blank / bracket / token / checkbox regexes and classifiers (§A.6).
 */
import type { BlankPattern } from './types.js';
import { normaliseText } from './text.js';

/** `{{key}}` or `{{key|format}}` on joined paragraph text. */
export const TOKEN_RE = /\{\{\s*([A-Za-z][\w.[\]]*)\s*(?:\|\s*([\w-]+)\s*)?\}\}/g;

/** `[placeholder]` — inner text must contain a letter and must not be a citation year (`[2003] UKHL 64`). */
export const BRACKET_RE = /\[([^[\]\n]{1,160})\]/g;

export function isBracketPlaceholder(inner: string): boolean {
  if (!/\p{L}/u.test(inner)) return false;
  if (/^\d{4}$/.test(inner.trim())) return false;
  return true;
}

/** Whole-run space box date: `        /         /              `. */
export const SPACE_BOX_DATE_RE = /^\s{4,}\/\s{4,}\/\s{4,}$/;

export interface BlankRule {
  pattern: BlankPattern;
  re: RegExp;
  /** Part of the match that a fill replaces (relative to the match); default the whole match. */
  fillRange?: (m: string) => [number, number];
  unit?: (m: string) => string | undefined;
}

const underscores = (m: string): [number, number] => {
  const s = m.indexOf('_');
  const e = m.lastIndexOf('_') + 1;
  return s >= 0 ? [s, e] : [0, m.length];
};

/** Tried in this order (longest/most specific first) on the joined paragraph text. */
export const BLANK_RULES: readonly BlankRule[] = [
  { pattern: 'datetime', re: /_{2,}[ \u00A0]*\/[ \u00A0]*_{2,}[ \u00A0]*\/[ \u00A0]*_{4,}[ \u00A0]+at[ \u00A0]+_{2,}[ \u00A0]*:[ \u00A0]*_{2,}/g },
  { pattern: 'date', re: /_{2,}[ \u00A0]*\/[ \u00A0]*_{2,}[ \u00A0]*\/[ \u00A0]*_{4,}/g },
  { pattern: 'month-year', re: /_{2,}[ \u00A0]*\/[ \u00A0]*_{4,}/g },
  { pattern: 'time', re: /_{2,}[ \u00A0]*:[ \u00A0]*_{2,}/g },
  { pattern: 'reference', re: /CCG-(?:HIRE-)?[_ \u00A0]{3,}(?:-[_ \u00A0]{3,})?/g },
  { pattern: 'money', re: /£[ \u00A0]?_{3,}/g, fillRange: underscores },
  { pattern: 'page-of', re: /_{3,}[ \u00A0]+of[ \u00A0]+_{3,}/g },
  { pattern: 'eighths', re: /_{3,}[ \u00A0]*\/[ \u00A0]*8\b/g, fillRange: underscores },
  { pattern: 'percent', re: /_{3,}[ \u00A0]*%/g, fillRange: underscores },
  { pattern: 'number', re: /_{3,}[ \u00A0]+(?:miles|days|years|mph)\b/g, fillRange: underscores, unit: (m) => /(miles|days|years|mph)$/.exec(m)?.[1] },
  // Grouped boxes such as a sort code `____  —  ____  —  ____` are one text blank (the formatter splits the value).
  { pattern: 'text', re: /_{3,}(?:[ \u00A0]*[—–-][ \u00A0]*_{3,})+/g },
  { pattern: 'text', re: /_{3,}/g }
];

export interface BlankMatch {
  pattern: BlankPattern;
  start: number;
  end: number;
  text: string;
  /** Absolute range a fill replaces. */
  fillStart: number;
  fillEnd: number;
  hasCurrency: boolean;
  prefix?: string;
  unit?: string;
  /** Space box (whole run of spaces) — replaced whole. */
  spaceBox?: boolean;
}

/** Trim trailing whitespace off a reference match that has underscores (header `Ref CCG-______     Page`). */
function trimReference(m: string): string {
  if (!m.includes('_')) return m; // a space box is replaced whole
  return m.replace(/[ \u00A0]+$/, '');
}

/**
 * All blank matches in `text` that do not overlap `claimed`, in rule order (callers sort by position).
 * `runRanges` lets whole-run space boxes (date / reference) be recognised.
 */
export function findBlanks(text: string, claimed: Array<[number, number]>, runRanges: Array<[number, number]> = []): BlankMatch[] {
  const taken: Array<[number, number]> = [...claimed];
  const overlaps = (s: number, e: number): boolean => taken.some(([a, b]) => s < b && e > a);
  const out: BlankMatch[] = [];
  // Space boxes first: a whole run that is spaces and slashes (date) — the reference space box is a regex match.
  for (const [rs, re] of runRanges) {
    const runTextValue = text.slice(rs, re);
    if (SPACE_BOX_DATE_RE.test(runTextValue) && !overlaps(rs, re)) {
      out.push({ pattern: 'date', start: rs, end: re, text: runTextValue, fillStart: rs, fillEnd: re, hasCurrency: false, spaceBox: true });
      taken.push([rs, re]);
    }
  }
  for (const rule of BLANK_RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      let matched = m[0];
      if (rule.pattern === 'reference') matched = trimReference(matched);
      const start = m.index;
      const end = start + matched.length;
      if (matched.length === 0 || overlaps(start, end)) continue;
      const [fs, fe] = rule.fillRange ? rule.fillRange(matched) : [0, matched.length];
      const bm: BlankMatch = { pattern: rule.pattern, start, end, text: matched, fillStart: start + fs, fillEnd: start + fe, hasCurrency: rule.pattern === 'money' };
      if (rule.pattern === 'reference') {
        bm.prefix = matched.startsWith('CCG-HIRE-') ? 'CCG-HIRE-' : 'CCG-';
        if (!matched.includes('_')) bm.spaceBox = true;
      }
      const unit = rule.unit?.(matched);
      if (unit) bm.unit = unit;
      out.push(bm);
      taken.push([start, end]);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Separators that end a label/option phrase: middle dot, tab, a wide gap. */
export const SEPARATOR_RE = /[ \u00A0]*·[ \u00A0]*|\t/g;

/** Last ≤ n words of a phrase (after the last separator), trimmed of punctuation. */
export function lastWords(text: string, n: number): string {
  const parts = text.split(/[ \u00A0]*·[ \u00A0]*|\t|[ \u00A0]{3,}/).map((p) => p.trim()).filter((p) => hasLetters(p));
  const tail = parts[parts.length - 1] ?? '';
  const words = cleanLabel(tail).split(/\s+/).filter(Boolean);
  return words.slice(-n).join(' ');
}

/** First ≤ n words of a phrase (before the first separator). */
export function firstWords(text: string, n: number): string {
  const parts = text.split(/[ \u00A0]*·[ \u00A0]*|\t|[ \u00A0]{3,}/).map((p) => p.trim()).filter((p) => hasLetters(p));
  const head = parts[0] ?? '';
  const words = cleanLabel(head).split(/\s+/).filter(Boolean);
  return words.slice(0, n).join(' ');
}

/** Trim decorative punctuation around a label: dashes, colons, brackets left open, bullets. */
export function cleanLabel(text: string): string {
  return normaliseText(text.replace(/[\t\n]+/g, ' '))
    .replace(/^[\s—–\-:·•▪,;(.=+×]+/, '')
    .replace(/[\s—–\-:·•▪,;(=+×]+$/, '')
    .trim();
}

export function hasLetters(text: string): boolean {
  return /\p{L}/u.test(text);
}

/**
 * Signature labels (§A.6 SIGNATURE_RE, applied to short labels so prose that merely mentions signing — "Where this
 * agreement is signed after…", "Signed client authority held?", "Part 2 signed on" — is not a signature slot).
 */
export function isSignatureLabel(label: string): boolean {
  const l = normaliseText(label).replace(/[\s:]+$/, '');
  if (!/\b(signature|signed|sign here|initials?|initial here)\b/i.test(l)) return false;
  if (/\?$/.test(l)) return false;
  if (/\b(on|by)$/i.test(l)) return false;
  const words = l.split(/\s+/).filter(Boolean).length;
  if (/\b(place|where|location)\b/i.test(l)) return false;
  if (words <= 3) return true;
  if (/^(date\s+)?(signature|signed|sign here)\b/i.test(l)) return true;
  if (/\b(initial|sign) here$/i.test(l)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

function rgb(hex: string | undefined): [number, number, number] | undefined {
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return undefined;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

/** Dark cell fill (banner / header row): 0D1C50, 04347F … */
export function isDarkFill(hex: string | undefined): boolean {
  const c = rgb(hex);
  if (!c) return false;
  const l = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  return l < 0.35;
}

/** A real shading fill (not auto / white). */
export function isShaded(hex: string | undefined): boolean {
  if (!hex) return false;
  const h = hex.toUpperCase();
  return h !== 'AUTO' && h !== 'FFFFFF' && /^[0-9A-F]{6}$/.test(h);
}

/** Mid grey label/hint colours: 8A8F9B, 9AA3B2, 808080 … */
export function isGreyColor(hex: string | undefined): boolean {
  const c = rgb(hex);
  if (!c) return false;
  const max = Math.max(...c);
  const min = Math.min(...c);
  const l = (c[0] + c[1] + c[2]) / 3;
  return max - min <= 0x30 && l >= 0x60 && l <= 0xd8;
}

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

export const LEVEL1_NUMBER_RE = /^\d{2}(\s{2,}|\t)\S/;
export const LEVEL1_PART_RE = /^part [a-c]\b/i;
export const LEVEL1_NAMED_RE = /^(enforceability check|cancellation form|exhibit)\b/i;
export const LEVEL2_CODE_RE = /^[A-C]\d\.\d+\s/;
export const LEVEL2_NUMBER_RE = /^\d+\.\d+\s/;
export const BANNER_CODE_RE = /^(PART\s*[A-C]|[A-C]\d)$/;

/**
 * Block ids that the design names differently from the heading slug (README "Block names"): the 04 exhibit page's
 * heading is `Exhibit [AB1]` (slug `exhibit` once the placeholder is dropped); the design calls the block `exhibit-sheet`.
 */
export const BLOCK_ALIASES: Readonly<Record<string, string>> = { exhibit: 'exhibit-sheet' };
