// owned by knowledge-research
/**
 * Privacy for research (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.6, KR-7). Pure.
 *
 *  - `scrubForResearch` replaces personal data and claim identifiers in a research question with placeholders and turns
 *    amounts into ranges ("about £1–2k"). Insurer names stay: they are public entities.
 *  - `containsPii` lists what is still there; `egressGuard` refuses any outbound URL or query that carries PII or a
 *    claim identifier (money excepted — a figure is not personal).
 *  - `perimeterTopic` triages a question: injury → referred out; regulated advice → the owner; FOS → Fixmyfile only.
 *
 * The `ClaimDictionary` holds only salted-by-kind sha256 hashes of every party name, VRM, our refs and insurer refs in
 * the DB (built per run with `buildClaimDictionary`, never sent anywhere), so this module never holds the names.
 */
import { sha256Hex } from '../evidence/hash.js';
import type { ClaimDictionary } from './types.js';

export type ScrubKind = 'name' | 'vrm' | 'claim_ref' | 'insurer_ref' | 'email' | 'phone' | 'postcode' | 'dob' | 'policy_no' | 'money';

/** The dictionary token kinds (each hash is salted with its kind). */
export type DictionaryKind = 'name' | 'vrm' | 'claim_ref' | 'insurer_ref';
const DICT_KINDS: readonly DictionaryKind[] = ['name', 'vrm', 'claim_ref', 'insurer_ref'];

const PLACEHOLDER: Record<ScrubKind, string> = {
  name: '[name]',
  vrm: '[vrm]',
  claim_ref: '[ref]',
  insurer_ref: '[ref]',
  email: '[email]',
  phone: '[phone]',
  postcode: '[postcode]',
  dob: '[date]',
  policy_no: '[policy number]',
  money: '[amount]',
};

/** Lower-case, punctuation to spaces, single-spaced, trimmed. */
export function normaliseDictToken(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const hashOf = (kind: DictionaryKind, norm: string): string => sha256Hex(`${kind}:${norm}`);

/**
 * Build the dictionary from the DB's identifying tokens. Names shorter than 3 characters and common words are skipped
 * (they would scrub ordinary English). VRMs and references are also stored without spaces.
 */
export function buildClaimDictionary(tokens: Partial<Record<DictionaryKind, readonly (string | null | undefined)[]>>): ClaimDictionary {
  const hashes = new Set<string>();
  let maxWords = 1;
  for (const kind of DICT_KINDS) {
    for (const raw of tokens[kind] ?? []) {
      if (!raw) continue;
      const norm = normaliseDictToken(raw);
      if (norm.length < 3 || STOP_NAMES.has(norm)) continue;
      const variants = new Set([norm]);
      if (kind !== 'name') variants.add(norm.replace(/ /g, ''));
      if (kind === 'name') {
        // Each part of a multi-word name that is itself distinctive (≥ 3 letters, not a common word) — surnames alone.
        for (const part of norm.split(' ')) if (part.length >= 3 && !STOP_NAMES.has(part) && !TITLES.has(part)) variants.add(part);
      }
      for (const v of variants) {
        hashes.add(hashOf(kind, v));
        maxWords = Math.max(maxWords, v.split(' ').length);
      }
    }
  }
  return { hashes, maxWords: Math.min(maxWords, 6) };
}

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'sir', 'lady', 'lord']);
/** Words that are also names but would scrub ordinary questions. */
const STOP_NAMES = new Set(['the', 'and', 'for', 'ltd', 'limited', 'plc', 'insurance', 'insurer', 'claims', 'claim', 'motor', 'car', 'cars', 'direct', 'group', 'services', 'company', 'uk', 'court', 'hire', 'will', 'may', 'mark', 'grant', 'bill', 'rose', 'page', 'law', 'rule', 'part', 'west', 'north', 'south', 'east']);

// ---------------------------------------------------------------------------
// Regex detectors
// ---------------------------------------------------------------------------

interface Detector {
  kind: ScrubKind;
  re: RegExp;
}

/** Order matters: longer, more specific shapes first. All global. */
const DETECTORS: readonly Detector[] = [
  { kind: 'email', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { kind: 'policy_no', re: /\bpolicy\s*(?:no\.?|number|ref(?:erence)?|#)?\s*[:#]?\s*(?=[A-Z0-9/-]*\d)[A-Z0-9][A-Z0-9/-]{4,}\b/gi },
  { kind: 'claim_ref', re: /\bCCG[-\s]?\d{4}[-\s]?\d{3,}\b/gi },
  { kind: 'phone', re: /(?<![\d/])(?:\+44\s?\(?0?\)?\s?|\b0)(?:\d[\s-]?){9,10}(?![\d/])/g },
  { kind: 'postcode', re: /\b(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/gi },
  { kind: 'dob', re: /\b(?:0?[1-9]|[12]\d|3[01])[/.-](?:0?[1-9]|1[0-2])[/.-](?:19|20)\d{2}\b/g },
  { kind: 'vrm', re: /\b[A-Z]{2}\d{2}\s?[A-Z]{3}\b/g },
  { kind: 'insurer_ref', re: /\b[A-Z]{1,6}[/-]?\d{4,}(?:[/-][A-Z0-9]+)*\b/g },
  { kind: 'money', re: /£\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?[km]\b)?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:pounds|GBP)\b/gi },
];

/** "about £1–2k" style range for an amount (KR-7: research sees ranges, never exact figures). */
export function amountRange(text: string): string {
  const m = /(\d[\d,]*(?:\.\d+)?)\s?(k|m)?/i.exec(text.replace(/£/g, ''));
  if (!m) return '[amount]';
  let v = Number(m[1]!.replace(/,/g, ''));
  if (m[2]?.toLowerCase() === 'k') v *= 1000;
  if (m[2]?.toLowerCase() === 'm') v *= 1_000_000;
  if (!Number.isFinite(v)) return '[amount]';
  if (v < 100) return 'under £100';
  if (v < 1000) return 'a few hundred pounds';
  if (v >= 1_000_000) return 'over £1m';
  const k = Math.floor(v / 1000);
  return `about £${k}–${k + 1}k`;
}

interface Span {
  start: number;
  end: number;
  kind: ScrubKind;
  replacement: string;
}

function regexSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    for (let m = d.re.exec(text); m; m = d.re.exec(text)) {
      if (!m[0].trim()) {
        d.re.lastIndex += 1;
        continue;
      }
      spans.push({ start: m.index, end: m.index + m[0].length, kind: d.kind, replacement: d.kind === 'money' ? amountRange(m[0]) : PLACEHOLDER[d.kind] });
    }
  }
  return spans;
}

/** Word tokens with their offsets (letters and digits; apostrophes inside words kept). */
function words(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const re = /[A-Za-z0-9À-ɏ]+(?:['’][A-Za-z]+)?/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

function dictionarySpans(text: string, dict: ClaimDictionary): Span[] {
  if (!dict.hashes.size) return [];
  const ws = words(text);
  const spans: Span[] = [];
  const maxN = Math.max(1, Math.min(dict.maxWords, 6));
  for (let i = 0; i < ws.length; i += 1) {
    for (let n = Math.min(maxN, ws.length - i); n >= 1; n -= 1) {
      const start = ws[i]!.start;
      const end = ws[i + n - 1]!.end;
      const full = normaliseDictToken(text.slice(start, end));
      if (!full || full.length < 3) continue;
      // Possessives ("Smith's") match the name itself.
      const norms = full.endsWith(' s') ? [full, full.slice(0, -2)] : [full];
      const kind = DICT_KINDS.find((k) => norms.some((norm) => dict.hashes.has(hashOf(k, norm)) || (k !== 'name' && dict.hashes.has(hashOf(k, norm.replace(/ /g, ''))))));
      if (kind) {
        spans.push({ start, end, kind, replacement: PLACEHOLDER[kind] });
        i += n - 1;
        break;
      }
    }
  }
  return spans;
}

/** Non-overlapping spans: earliest first, longest wins on a tie. */
function merge(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) continue;
    out.push(s);
  }
  return out;
}

function spansOf(text: string, dict: ClaimDictionary): Span[] {
  return merge([...dictionarySpans(text, dict), ...regexSpans(text)]);
}

/** Replace personal data and claim identifiers with placeholders; amounts become ranges. */
export function scrubForResearch(text: string, dict: ClaimDictionary): { text: string; removed: ScrubKind[] } {
  const spans = spansOf(text, dict);
  if (!spans.length) return { text, removed: [] };
  let out = '';
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + s.replacement;
    at = s.end;
  }
  out += text.slice(at);
  return { text: out.replace(/[ \t]{2,}/g, ' '), removed: [...new Set(spans.map((s) => s.kind))] };
}

/** The kinds of personal data / identifiers still present in `text`. */
export function containsPii(text: string, dict: ClaimDictionary): ScrubKind[] {
  return [...new Set(spansOf(text, dict).map((s) => s.kind))];
}

/** Decode a URL (path, query) to plain words so identifiers hidden in it are seen. */
function egressText(urlOrQuery: string): string {
  let t = urlOrQuery;
  try {
    t = decodeURIComponent(t.replace(/\+/g, ' '));
  } catch {
    /* keep raw */
  }
  return t;
}

/**
 * Every outbound URL and search query passes here before it leaves the PC (KR-7). Refuses on any personal datum or
 * claim identifier; an amount alone is allowed (it is not personal).
 */
export function egressGuard(urlOrQuery: string, dict: ClaimDictionary): { ok: true } | { ok: false; kinds: ScrubKind[] } {
  const text = egressText(urlOrQuery);
  // URL paths are split on separators so dictionary n-grams match ("/search?q=jane+doe").
  const spaced = text.replace(/[/?&=#_.:-]+/g, ' ');
  const kinds = [...new Set([...containsPii(text, dict), ...containsPii(spaced, dict).filter((k) => k === 'name' || k === 'vrm' || k === 'claim_ref' || k === 'insurer_ref')])].filter((k) => k !== 'money');
  // A URL's own host and path segments often look like references (e.g. /ukpga/1988/52): only dictionary hits and
  // unmistakable personal data count for a URL; a free-text query is checked in full.
  const isUrl = /^https?:\/\//i.test(urlOrQuery.trim());
  const relevant = isUrl ? kinds.filter((k) => k !== 'insurer_ref' && k !== 'dob') : kinds;
  return relevant.length ? { ok: false, kinds: relevant } : { ok: true };
}

const INJURY = /\b(?:personal[\s-]+injur(?:y|ies)|injur(?:y|ies|ed)|whiplash|soft[\s-]tissue|pi\s+claims?|medical\s+(?:report|agency|records?)|general\s+damages)\b/i;
const REGULATED = /\b(?:should\s+(?:the\s+client|the\s+claimant|our\s+client|they|he|she|we|i)\s+(?:sue|issue|bring|start\s+proceedings|settle|accept|reject|take\s+(?:it|this)\s+to\s+court)|legal\s+advice|prospects\s+of\s+success|is\s+it\s+worth\s+(?:suing|going\s+to\s+court)|advise\s+(?:the\s+)?(?:client|claimant)\s+(?:to|whether))\b/i;
const FOS = /\b(?:financial\s+ombudsman|ombudsman\s+service|FOS)\b/i;

/** Perimeter triage of a research question (code, §7.1): injury → referred out; regulated advice → the owner; FOS → Fixmyfile. */
export function perimeterTopic(question: string): 'injury' | 'regulated_advice' | 'fos' | null {
  if (INJURY.test(question)) return 'injury';
  if (REGULATED.test(question)) return 'regulated_advice';
  if (FOS.test(question)) return 'fos';
  return null;
}
