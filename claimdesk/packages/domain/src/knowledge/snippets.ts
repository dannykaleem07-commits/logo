// owned by knowledge-learners
/**
 * L6 owner-written letters → snippets (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.6). STUB created by knowledge-core: the
 * signatures below are the contract; bodies throw NOT_IMPLEMENTED until knowledge-learners fills them.
 */
import { notImplemented } from './notImplemented.js';

/** amounts → [amount], dates → [date], references → [ref], party names → [name]. */
export function generaliseSnippet(_text: string, _names: readonly string[]): { text: string; tokens: string[]; literalsRemain: boolean } {
  return notImplemented('knowledge-learners', 'generaliseSnippet');
}

/** Shingle Jaccard similarity (word k-shingles, default k = 5) in 0..1. */
export function shingleJaccard(_a: string, _b: string, _k?: number): number {
  return notImplemented('knowledge-learners', 'shingleJaccard');
}
