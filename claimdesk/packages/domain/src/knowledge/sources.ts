// owned by knowledge-research
/**
 * Allowed sources (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.2, KR-8, KR-14). STUB created by knowledge-core: the signatures below are the contract; bodies throw NOT_IMPLEMENTED until knowledge-research fills them.
 * `SourcePolicy` is declared in types.ts (core) because decideKnowledge (KN-11, KN-16) reads its policy kind.
 */
import { notImplemented } from './notImplemented.js';
import type { KnowledgeSettings, SourcePolicy } from './types.js';

/** The built-in allow-list (empty until knowledge-research fills it from §7.2). */
export const SOURCE_POLICIES: readonly SourcePolicy[] = [];

/** exact host or listed subdomain */
export function policyFor(_url: string, _extra: readonly SourcePolicy[]): SourcePolicy | undefined {
  return notImplemented('knowledge-research', 'policyFor');
}

export function fetchAllowed(_url: string, _mode: 'code' | 'agent', _extra: readonly SourcePolicy[], _settings: KnowledgeSettings): { ok: boolean; reason: string } {
  return notImplemented('knowledge-research', 'fetchAllowed');
}
