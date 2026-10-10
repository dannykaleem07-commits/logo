// owned by knowledge-use
/**
 * Drift alarms (docs/SUPREME-KNOWLEDGE-BUILDER.md §12.2): the 14 days since the active version against the 28-day
 * baseline, n ≥ 10; a drop of 15 points or more raises an alarm. Pure.
 *
 * "Drop" means the metric moved in the bad direction: down for rates where higher is better (approval without edit,
 * reviewer first pass), up for the rest (correction size, days to pay, reduction, rejection, contact failure, block
 * rate). Rates (0–100) are compared in percentage points; values that are not rates (median days, median correction
 * size) are compared as a relative change in per cent of the baseline.
 *
 * Perimeter samples (a reviewer block citing a learned item with a perimeter code) are severe whenever the current
 * window has any (n ≥ 1): they need no baseline, and with `autoQuarantineOnPerimeter` the API quarantines the items.
 */
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

export const DRIFT_METRICS: readonly DriftMetric[] = ['approval_without_edit_rate', 'reviewer_first_pass_rate', 'median_correction_size', 'median_working_days_to_pay', 'reduction_rate', 'research_rejection_rate', 'learned_contact_failure_rate', 'knowledge_block_rate'];

/** Direction and unit of each metric. */
export const DRIFT_METRIC_INFO: Readonly<Record<DriftMetric, { higherIsBetter: boolean; unit: 'pct' | 'value'; label: string }>> = {
  approval_without_edit_rate: { higherIsBetter: true, unit: 'pct', label: 'drafts approved without an edit' },
  reviewer_first_pass_rate: { higherIsBetter: true, unit: 'pct', label: 'drafts passing the reviewer first time' },
  median_correction_size: { higherIsBetter: false, unit: 'value', label: 'median size of the owner’s corrections' },
  median_working_days_to_pay: { higherIsBetter: false, unit: 'value', label: 'median working days to pay' },
  reduction_rate: { higherIsBetter: false, unit: 'pct', label: 'claims paid with a reduction' },
  research_rejection_rate: { higherIsBetter: false, unit: 'pct', label: 'research findings the owner rejected' },
  learned_contact_failure_rate: { higherIsBetter: false, unit: 'pct', label: 'learned contacts reported as failed' },
  knowledge_block_rate: { higherIsBetter: false, unit: 'pct', label: 'drafts blocked for knowledge misuse' },
};

/** How far the metric moved in the bad direction (points for rates, % of baseline for values); ≤ 0 = no worse. */
export function badMove(metric: DriftMetric, baseline: number, current: number): number {
  const info = DRIFT_METRIC_INFO[metric];
  const raw = info.higherIsBetter ? baseline - current : current - baseline;
  if (info.unit === 'pct') return Math.round(raw * 100) / 100;
  if (baseline === 0) return current === 0 ? 0 : info.higherIsBetter ? 0 : 100;
  return Math.round((raw / Math.abs(baseline)) * 100 * 100) / 100;
}

export function detectDrift(samples: readonly DriftSample[], opts: { minN: number; dropPctPoints: number }): DriftFinding[] {
  const out: DriftFinding[] = [];
  for (const s of samples) {
    if (s.current === null || !Number.isFinite(s.current)) continue;
    if (s.perimeter) {
      const base = s.baseline ?? 0;
      if (s.n >= 1 && s.current > 0) out.push({ metric: s.metric, key: s.key, baseline: base, current: s.current, n: s.n, dropPctPoints: Math.max(0, badMove(s.metric, base, s.current)), severity: 'severe' });
      continue;
    }
    if (s.baseline === null || !Number.isFinite(s.baseline) || s.n < opts.minN) continue;
    const move = badMove(s.metric, s.baseline, s.current);
    if (move >= opts.dropPctPoints) out.push({ metric: s.metric, key: s.key, baseline: s.baseline, current: s.current, n: s.n, dropPctPoints: move, severity: 'warn' });
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'severe' ? -1 : 1) || a.metric.localeCompare(b.metric) || (a.key ?? '').localeCompare(b.key ?? ''));
}

/** Owner-facing sentence for an alarm card. */
export function describeDrift(f: DriftFinding): string {
  const info = DRIFT_METRIC_INFO[f.metric];
  const fmt = (x: number): string => (info.unit === 'pct' ? `${Math.round(x * 10) / 10}%` : `${Math.round(x * 10) / 10}`);
  if (f.severity === 'severe') return `A reviewer blocked a draft that cited learned knowledge on a perimeter point (${f.n} in the current window).`;
  return `${info.label[0]!.toUpperCase()}${info.label.slice(1)}${f.key ? ` (${f.key})` : ''} moved from ${fmt(f.baseline)} to ${fmt(f.current)} since the active learned version (n=${f.n}).`;
}
