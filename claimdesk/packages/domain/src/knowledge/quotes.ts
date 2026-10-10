// owned by knowledge-research
/**
 * Quote checks against our own stored copy (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.7). STUB created by knowledge-core: the signatures below are the contract; bodies throw NOT_IMPLEMENTED until knowledge-research fills them.
 */
import { notImplemented } from './notImplemented.js';

/** exact, or whitespace-normalised (case-sensitive), or not found */
export function findQuote(_snapshotText: string, _quote: string): 'exact' | 'normalised' | 'not_found' {
  return notImplemented('knowledge-research', 'findQuote');
}

export function quoteWords(_quote: string): number {
  return notImplemented('knowledge-research', 'quoteWords');
}
