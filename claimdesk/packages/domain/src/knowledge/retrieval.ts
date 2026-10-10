// owned by knowledge-use
/**
 * Retrieval into every agent's context (docs/SUPREME-KNOWLEDGE-BUILDER.md §8.1). Pure, deterministic. STUB created by knowledge-core: the signatures below are the contract; bodies throw NOT_IMPLEMENTED until knowledge-use fills them.
 * The contract types (KnowledgeRef, KnowledgeCandidate, RetrievalRequest, KnowledgeHit) are declared in types.ts
 * (core) because the hooks and DTOs use them.
 */
import { notImplemented } from './notImplemented.js';
import type { AgentName, JobType } from '../agents/types.js';
import type { KnowledgeCandidate, KnowledgeHit, RetrievalRequest } from './types.js';

export function buildRetrievalQuery(_input: { agent: AgentName; jobType: JobType; task: string; brief: unknown | null }): string {
  return notImplemented('knowledge-use', 'buildRetrievalQuery');
}

export function rankKnowledge(_cands: KnowledgeCandidate[], _req: RetrievalRequest): KnowledgeHit[] {
  return notImplemented('knowledge-use', 'rankKnowledge');
}

export function renderKnowledgeBlock(_hits: KnowledgeHit[]): string {
  return notImplemented('knowledge-use', 'renderKnowledgeBlock');
}
