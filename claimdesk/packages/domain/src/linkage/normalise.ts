/**
 * Field normalisers and string similarity for the connected-party checker (BLUEPRINT §3.9).
 * Everything here is deterministic and pure.
 */
import type { Address, BankDetails } from '../types.js';

/** Strip to digits; '+44'/'0044'/'44' → leading 0, dropping a bracketed trunk zero: '+44 (0)7700 900123' → '07700900123'. */
export function normalisePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let digits = raw.replace(/[^\d+]/g, '');
  let national: string | undefined;
  if (digits.startsWith('+44')) national = digits.slice(3);
  else if (digits.startsWith('0044')) national = digits.slice(4);
  else if (digits.startsWith('44') && digits.length >= 12) national = digits.slice(2);
  if (national !== undefined) digits = `0${national.replace(/^0+/, '')}`;
  digits = digits.replace(/\D/g, '');
  if (digits.length < 7) return undefined; // too short to be a usable number
  return digits;
}

export function normaliseEmail(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const e = raw.trim().toLowerCase();
  if (!e.includes('@')) return undefined;
  return e;
}

export function normalisePostcode(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const p = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return p.length >= 5 ? p : undefined;
}

const DWELLING_WORDS = new Set(['flat', 'apartment', 'apt', 'unit', 'room', 'suite', 'no', 'number', 'the']);

/**
 * Postcode (uppercase, no space) + the numbered tokens of line 1 (flat and house numbers, e.g. "2" and "14") + the
 * first alphabetic token that is not a dwelling word. Two flats in one block share a postcode and "Flat" but not
 * the number, so "Flat 2, Rose Court" ≠ "Flat 7, Rose Court", while "14 Elm Road" = "14 Elm Rd".
 */
export function normaliseAddressKey(addr: Address | undefined): string | undefined {
  if (!addr) return undefined;
  const line1 = (addr.line1 ?? '').trim().toLowerCase().replace(/[^\w\s]/g, '');
  const tokens = line1.split(/\s+/).filter(Boolean);
  const numbered = tokens.filter((t) => /\d/.test(t));
  const word = tokens.find((t) => !/\d/.test(t) && !DWELLING_WORDS.has(t)) ?? '';
  const postcode = normalisePostcode(addr.postcode);
  if (postcode) return `${postcode}|${numbered.join('/')}|${word}`;
  const town = (addr.town ?? '').trim().toLowerCase();
  if (!line1) return undefined;
  return `${line1.replace(/\s+/g, ' ')}|${town}`;
}

export function normaliseBankKey(bank: BankDetails | undefined): string | undefined {
  if (!bank) return undefined;
  const sort = (bank.sortCode ?? '').replace(/\D/g, '');
  const acct = (bank.accountNumber ?? '').replace(/\D/g, '');
  if (sort.length !== 6 || acct.length < 6) return undefined;
  return `${sort}${acct}`;
}

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'mx', 'sir', 'prof', 'rev']);
const COMPANY_SUFFIXES = new Set(['ltd', 'limited', 'plc', 'llp', 'co', 'company', 'inc', 'group', 'uk', 'the']);

/** Lowercase tokens with titles and corporate suffixes removed: 'Mr Daniel Kaleem' → ['daniel','kaleem']. */
export function nameTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && !TITLES.has(t) && !COMPANY_SUFFIXES.has(t));
}

export function tokenJaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Jaro similarity (0..1). */
export function jaro(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;
  const matchWindow = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
  const m1 = new Array<boolean>(len1).fill(false);
  const m2 = new Array<boolean>(len2).fill(false);
  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(len2 - 1, i + matchWindow);
    for (let j = lo; j <= hi; j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = true;
      m2[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const t = transpositions / 2;
  return (matches / len1 + matches / len2 + (matches - t) / matches) / 3;
}

/** Jaro-Winkler with the standard prefix scale 0.1 over at most 4 common leading characters. */
export function jaroWinkler(s1: string, s2: string, prefixScale = 0.1): number {
  const j = jaro(s1, s2);
  let prefix = 0;
  const max = Math.min(4, s1.length, s2.length);
  for (let i = 0; i < max; i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return j + prefix * prefixScale * (1 - j);
}

export interface NameSimilarity {
  jaccard: number;
  jaroWinkler: number;
  /** Combined 0..1 score: 0.5 × Jaccard on tokens + 0.5 × Jaro-Winkler on the sorted joined tokens. */
  score: number;
  exact: boolean;
}

export function nameSimilarity(a: string | undefined, b: string | undefined): NameSimilarity {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return { jaccard: 0, jaroWinkler: 0, score: 0, exact: false };
  const ja = tokenJaccard(ta, tb);
  const sa = [...ta].sort().join(' ');
  const sb = [...tb].sort().join(' ');
  const jw = jaroWinkler(sa, sb);
  const exact = sa === sb;
  return { jaccard: ja, jaroWinkler: jw, score: exact ? 1 : 0.5 * ja + 0.5 * jw, exact };
}

/** Round a confidence to 2 dp so reports are stable. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
