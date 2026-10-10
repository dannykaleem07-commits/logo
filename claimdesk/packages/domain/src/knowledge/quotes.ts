// owned by knowledge-research
/**
 * Quote checks against our own stored copy (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.7, KR-9, KR-14). Pure.
 * A quote is `exact` when it appears verbatim, `normalised` when it appears once whitespace runs (and typographic
 * quotes/dashes) are normalised — always case-sensitive — and `not_found` otherwise. Quotes stay at or below the
 * source's `maxQuoteWords`.
 */

/** Collapse whitespace and unify typographic quotes / dashes / non-breaking spaces (case is kept). */
export function normaliseQuoteText(s: string): string {
  return s
    .replace(/[   ]/g, ' ')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

/** exact, or whitespace-normalised (case-sensitive), or not found */
export function findQuote(snapshotText: string, quote: string): 'exact' | 'normalised' | 'not_found' {
  const q = quote.trim();
  if (!q) return 'not_found';
  if (snapshotText.includes(q)) return 'exact';
  const nq = normaliseQuoteText(q);
  if (nq && normaliseQuoteText(snapshotText).includes(nq)) return 'normalised';
  return 'not_found';
}

export function quoteWords(quote: string): number {
  const t = quote.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Where a quote sits in the text (for side-by-side highlighting), or null. */
export function quoteOffset(snapshotText: string, quote: string): { start: number; end: number } | null {
  const q = quote.trim();
  if (!q) return null;
  const i = snapshotText.indexOf(q);
  return i >= 0 ? { start: i, end: i + q.length } : null;
}
