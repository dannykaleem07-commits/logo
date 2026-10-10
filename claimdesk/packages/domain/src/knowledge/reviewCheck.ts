// owned by knowledge-use
/**
 * The reviewer checks outbound knowledge (docs/SUPREME-KNOWLEDGE-BUILDER.md §8.3). STUB created by knowledge-core: the signatures below are the contract; bodies throw NOT_IMPLEMENTED until knowledge-use fills them.
 */
import { notImplemented } from './notImplemented.js';
import type { RecipientRole } from '../agents/types.js';
import type { ConsistencyFlag } from '../types.js';
import type { KnowledgeHit, KnowledgeRef } from './types.js';

export interface KnowledgeUseInput {
  text: string;
  recipientRole: RecipientRole | null;
  /** from {{cite:ki:…}} / KB / pack placeholders in the draft (SD §E.3 mechanism, ki: prefix added) */
  citedRefs: KnowledgeRef[];
  /** from the drafting run's result basis[] (BasisKind 'knowledge') */
  basisRefs: KnowledgeRef[];
  /** computed + internal items injected into that run */
  internalBodies: { ref: KnowledgeRef; text: string }[];
  resolve(ref: KnowledgeRef): KnowledgeHit | undefined;
}

export function checkKnowledgeUse(_i: KnowledgeUseInput): ConsistencyFlag[] {
  return notImplemented('knowledge-use', 'checkKnowledgeUse');
}
