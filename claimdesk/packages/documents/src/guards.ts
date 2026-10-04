/**
 * Cheap text guards used by the documents tests and available to the API before it runs the full
 * position-consistency engine (domain/consistency). These only look at strings; they know nothing about the ledger.
 */
import { brand } from './brand.js';

export interface GuardHit {
  kind: 'legacy' | 'banned_phrase';
  needle: string;
  /** Up to ~80 characters around the first occurrence, for the flag message. */
  excerpt: string;
}

/** Strip HTML tags and collapse whitespace so phrases split across inline markup are still caught. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * Legacy details that must never appear (BLUEPRINT §3.10). Case-insensitive, except that the exact string
 * "CARFLEX LTD" is allowed (the supplier's registered name as filed at Companies House).
 */
export function findBlockedStrings(htmlOrText: string): GuardHit[] {
  const text = htmlToText(htmlOrText);
  const hits: GuardHit[] = [];
  for (const needle of brand.legacy.blockedStrings) {
    const re = new RegExp(escapeRegExp(needle), 'gi');
    for (const m of text.matchAll(re)) {
      const matched = m[0];
      if ((brand.legacy.allowedExactCase as readonly string[]).includes(matched)) continue;
      hits.push({ kind: 'legacy', needle, excerpt: excerptAround(text, m.index ?? 0, matched.length) });
      break; // one hit per needle is enough for a block
    }
  }
  return hits;
}

/**
 * Banned disclaimer phrases. The mandatory status line ("… is not regulated by the SRA") necessarily contains the
 * substring "regulated by the SRA", so the status line and any negated form ("not regulated by the SRA") are
 * removed before checking.
 */
export function findBannedPhrases(htmlOrText: string): GuardHit[] {
  let text = htmlToText(htmlOrText);
  text = text.split(brand.company.statusLine).join(' ');
  text = text.replace(/\b(?:not|nor|neither)\s+(?:a\s+firm\s+)?regulated by the SRA/gi, ' ');
  const hits: GuardHit[] = [];
  for (const phrase of brand.legacy.bannedPhrases) {
    const re = new RegExp(escapeRegExp(phrase), 'i');
    const m = re.exec(text);
    if (m) hits.push({ kind: 'banned_phrase', needle: phrase, excerpt: excerptAround(text, m.index, m[0].length) });
  }
  return hits;
}

/** Both guards together. Empty array = clean. */
export function findProhibitedContent(htmlOrText: string): GuardHit[] {
  return [...findBlockedStrings(htmlOrText), ...findBannedPhrases(htmlOrText)];
}

/** Throws with a readable message when a rendered document contains legacy details or banned phrases. */
export function assertNoProhibitedContent(htmlOrText: string, context = 'document'): void {
  const hits = findProhibitedContent(htmlOrText);
  if (hits.length > 0) {
    const lines = hits.map((h) => `  [${h.kind}] "${h.needle}" — ${h.excerpt}`);
    throw new Error(`Prohibited content in ${context}:\n${lines.join('\n')}`);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
