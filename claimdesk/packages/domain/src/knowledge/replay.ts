// owned by knowledge-use
/**
 * Golden replay (docs/SUPREME-KNOWLEDGE-BUILDER.md §12.1): correlational evidence from the business's own history, not
 * proof. STUB created by knowledge-core: the signatures below are the contract; bodies throw NOT_IMPLEMENTED until knowledge-use fills them.
 */
import { notImplemented } from './notImplemented.js';
import type { EvalCase, OutcomeStats, RuleData } from './types.js';

export interface ReplayResult {
  verdict: 'no_worse' | 'worse' | 'inconclusive';
  casesAffected: number;
  consistent: OutcomeStats;
  inconsistent: OutcomeStats;
  hardViolations: string[];
  perRule: { itemId: string; affected: number; deltaDaysMedian: number | null; deltaPaidPct: number | null }[];
}

export function replayRules(_cases: EvalCase[], _rules: { itemId: string; data: RuleData }[], _opts: { tolerancePct: number; minCases: number }): ReplayResult {
  return notImplemented('knowledge-use', 'replayRules');
}
