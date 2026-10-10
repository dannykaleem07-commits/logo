// owned by knowledge-learners
/**
 * L6 owner-written letters → snippets (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.6). Pure.
 *
 *   generaliseSnippet  amounts → [amount], dates → [date], references and registrations → [ref], party names → [name];
 *                      `literalsRemain` is true when something identifying is still there (long digit runs, an email
 *                      address, a phone number, a postcode) — such a snippet is queued, never auto-applied (KN-17)
 *   shingleJaccard     word k-shingle Jaccard similarity, used to keep only paragraphs not already in a template
 *   paragraphsOf       the paragraphs of a letter worth considering as snippets
 */

const MONTHS = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const ORD = '(?:st|nd|rd|th)?';

const AMOUNT_RES: readonly RegExp[] = [
  /£\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:k|m|million|thousand))?/gi,
  /\b\d[\d,]*(?:\.\d{1,2})?\s?(?:pounds|gbp|pence)\b/gi,
];
const DATE_RES: readonly RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g,
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g,
  new RegExp(`\\b\\d{1,2}${ORD}\\s+(?:of\\s+)?${MONTHS}(?:,?\\s+\\d{4})?\\b`, 'gi'),
  new RegExp(`\\b${MONTHS}\\s+\\d{1,2}${ORD}(?:,?\\s+\\d{4})?\\b`, 'gi'),
  new RegExp(`\\b${MONTHS}\\s+\\d{4}\\b`, 'gi'),
];
const REF_RES: readonly RegExp[] = [
  /\b[A-Z]{2}\d{2}\s?[A-Z]{3}\b/g, // current-style UK registration
  /\b(?=[A-Za-z0-9/-]*\d)(?=[A-Za-z0-9/-]*[A-Za-z])[A-Za-z0-9]+(?:[/-][A-Za-z0-9]+)+\b/g, // CCG-2026-0012, ABC/123456
  /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,}\b/g, // AB123456C, POL12345
];
const LITERAL_RES: readonly RegExp[] = [
  /\d{3,}/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/, // postcode
  /https?:\/\/\S+/i,
];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** amounts → [amount], dates → [date], references → [ref], party names → [name]. */
export function generaliseSnippet(text: string, names: readonly string[]): { text: string; tokens: string[]; literalsRemain: boolean } {
  let out = text ?? '';
  // Email addresses and links are literals whatever the reference pattern does to them (never generalised away).
  const contactLiteral = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|https?:\/\/\S+|\bwww\.\S+/i.test(out);
  const used = new Map<string, number>();
  const sub = (re: RegExp, token: string): void => {
    out = out.replace(re, (m, ...rest) => {
      const offset = rest.find((x) => typeof x === 'number') as number | undefined;
      if (!used.has(token)) used.set(token, offset ?? 0);
      return m.startsWith(' ') ? ` ${token}` : token;
    });
  };
  const cleanNames = [...new Set(names.map((n) => (n ?? '').trim()).filter((n) => n.length >= 2))].sort((a, b) => b.length - a.length);
  for (const n of cleanNames) sub(new RegExp(`(?<![\\w])${escapeRe(n)}(?![\\w])`, 'gi'), '[name]');
  for (const re of AMOUNT_RES) sub(re, '[amount]');
  for (const re of DATE_RES) sub(re, '[date]');
  for (const re of REF_RES) sub(re, '[ref]');
  // Order tokens by first appearance in the generalised text.
  const tokens = [...used.keys()].sort((a, b) => out.indexOf(a) - out.indexOf(b));
  const stripped = out.replace(/\[(?:amount|date|ref|name)\]/g, ' ');
  const literalsRemain = contactLiteral || LITERAL_RES.some((re) => re.test(stripped));
  return { text: out, tokens, literalsRemain };
}

const shingleWords = (s: string): string[] =>
  (s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s[\]]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

function shingles(words: readonly string[], k: number): Set<string> {
  const out = new Set<string>();
  if (!words.length) return out;
  if (words.length < k) {
    out.add(words.join(' '));
    return out;
  }
  for (let i = 0; i + k <= words.length; i++) out.add(words.slice(i, i + k).join(' '));
  return out;
}

/** Shingle Jaccard similarity (word k-shingles, default k = 5) in 0..1. */
export function shingleJaccard(a: string, b: string, k = 5): number {
  const wa = shingleWords(a);
  const wb = shingleWords(b);
  if (!wa.length && !wb.length) return 1;
  if (!wa.length || !wb.length) return 0;
  const kk = Math.max(1, Math.min(k, wa.length, wb.length));
  const sa = shingles(wa, kk);
  const sb = shingles(wb, kk);
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : Math.round((inter / union) * 10_000) / 10_000;
}

const GREETING_OR_SIGNOFF = /^(?:dear\b|hi\b|hello\b|good\s+(?:morning|afternoon)|(?:kind(?:est)?|best|warm)\s+regards|regards|yours\s+(?:sincerely|faithfully)|many\s+thanks|thanks|thank\s+you|claims\s+team)/i;

/** Paragraphs of a letter worth considering as snippets: 12–200 words, not a greeting or sign-off line. */
export function paragraphsOf(text: string): string[] {
  return (text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => {
      const words = p.split(' ').length;
      return words >= 12 && words <= 200 && !GREETING_OR_SIGNOFF.test(p);
    });
}
