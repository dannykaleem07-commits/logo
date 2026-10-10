// owned by knowledge-learners
/**
 * L3 owner corrections: token diff, categories and clustering (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.4). STUB created by
 * knowledge-core: the signatures below are the contract; bodies throw NOT_IMPLEMENTED until knowledge-learners fills them.
 */
import { notImplemented } from './notImplemented.js';

export type DiffOp = { op: 'eq' | 'ins' | 'del'; text: string };
export type CorrectionCategory = 'figures' | 'placeholders' | 'greeting_signoff' | 'tone' | 'legal_terms' | 'facts' | 'structure' | 'recipient' | 'attachments' | 'length';

/** Myers over word tokens, deterministic */
export function tokenDiff(_before: string, _after: string): DiffOp[] {
  return notImplemented('knowledge-learners', 'tokenDiff');
}

export function diffStats(_ops: DiffOp[]): { inserted: number; deleted: number; changedRatio: number } {
  return notImplemented('knowledge-learners', 'diffStats');
}

export function categoriseCorrection(_before: string, _after: string, _ops: DiffOp[]): CorrectionCategory[] {
  return notImplemented('knowledge-learners', 'categoriseCorrection');
}

export function clusterKeyOf(_c: { agent: string | null; templateId: string | null; emailKind: string | null; insurerSlug: string | null; categories: CorrectionCategory[]; recurringEdits: string[] }): string {
  return notImplemented('knowledge-learners', 'clusterKeyOf');
}

export function recurringEdits(_corrections: { ops: DiffOp[] }[], _minSupport: number): { phrase: string; op: 'ins' | 'del'; support: number }[] {
  return notImplemented('knowledge-learners', 'recurringEdits');
}
