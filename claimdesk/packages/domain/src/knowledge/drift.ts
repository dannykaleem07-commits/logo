// owned by knowledge-use
/**
 * Drift alarms (docs/SUPREME-KNOWLEDGE-BUILDER.md §12.2): the 14 days since the active version against the 28-day
 * baseline, n ≥ 10, a drop of 15 points or more raises an alarm. STUB created by knowledge-core: the signatures below are the contract; bodies throw NOT_IMPLEMENTED until knowledge-use fills them.
 */
import { notImplemented } from './notImplemented.js';

export type DriftMetric = 'approval_without_edit_rate' | 'reviewer_first_pass_rate' | 'median_correction_size' | 'median_working_days_to_pay' | 'reduction_rate' | 'research_rejection_rate' | 'learned_contact_failure_rate' | 'knowledge_block_rate';

export interface DriftSample {
  metric: DriftMetric;
  /** e.g. an action kind for approval rates */
  key: string | null;
  baseline: number | null;
  current: number | null;
  n: number;
  /** a perimeter-tied metric (severe) */
  perimeter: boolean;
}

export interface DriftFinding {
  metric: DriftMetric;
  key: string | null;
  baseline: number;
  current: number;
  n: number;
  dropPctPoints: number;
  severity: 'warn' | 'severe';
}

export function detectDrift(_samples: readonly DriftSample[], _opts: { minN: number; dropPctPoints: number }): DriftFinding[] {
  return notImplemented('knowledge-use', 'detectDrift');
}
