// owned by knowledge-learners
/**
 * Conflict detection (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.7), run on every proposal and nightly. Only code records
 * conflicts. STUB created by knowledge-core: the signatures below are the contract; bodies throw NOT_IMPLEMENTED until
 * knowledge-learners fills them. The store calls it through `KnowledgeHooks.conflictsFor` once registered.
 */
import { notImplemented } from './notImplemented.js';
import type { ConflictFinding, KnowledgeItem, KnowledgeProposal } from './types.js';

/** What conflict detection compares a proposal with (all read by the caller; this module stays pure). */
export interface ConflictContext {
  /** active items of the same itemKey or scope */
  active: readonly Pick<KnowledgeItem, 'id' | 'itemKey' | 'kind' | 'area' | 'title' | 'body' | 'data' | 'scope' | 'verification' | 'origin' | 'contentSha256'>[];
  /** directory values for the proposal's insurer (contacts) */
  directory: { slug: string; phones: string[]; emails: string[] } | null;
  /** active pack red-line patterns */
  redLines: readonly { id: string; pattern: string; scope: string | null }[];
  /** KB entries with overlapping citation or tags */
  kb: readonly { id: string; citation: string | null; text: string; tags: string[] }[];
}

export function detectConflicts(_p: KnowledgeProposal, _c: ConflictContext): ConflictFinding[] {
  return notImplemented('knowledge-learners', 'detectConflicts');
}
