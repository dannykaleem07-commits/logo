// owned by casework
/** Pure helpers for the Agent tab (docs/SUPREME-DESIGN.md §L.9) — kept free of React so they are unit-tested. */
import type { Basis, CaseReviewResult } from '@ccguk/domain';
import type { ClaimAgentJob, ClaimAgentRun } from '../../../../api/caseworkApi';

export type Tone = 'green' | 'amber' | 'red' | 'blue' | 'navy' | 'grey';

export interface NextBest {
  code: string;
  title: string;
  why: string;
  basis: Basis[];
  confidence: number;
  dueAt: string | null;
  source: 'case_review' | 'playbook';
}

/** The next best action: the latest case review's, else the playbook's first action (computed by code). */
export function nextBest(review: CaseReviewResult | null | undefined, playbook: Array<{ code: string; title: string; why: string; dueAt: string | null }>): NextBest | null {
  if (review?.nextBestAction) return { ...review.nextBestAction, source: 'case_review' };
  const p = playbook[0];
  return p ? { code: p.code, title: p.title, why: p.why, basis: [{ kind: 'rule', id: p.code, label: 'playbook' }], confidence: 1, dueAt: p.dueAt, source: 'playbook' } : null;
}

export const confidenceLabel = (c: number): string => `${Math.round(Math.max(0, Math.min(1, c)) * 100)}%`;
export const confidenceTone = (c: number): Tone => (c >= 0.85 ? 'green' : c >= 0.6 ? 'amber' : 'red');

export const OUTCOME_TONE: Record<string, Tone> = { ok: 'green', succeeded: 'green', usage_limited: 'amber', waiting_usage: 'amber', waiting_user: 'blue', queued: 'grey', leased: 'blue', auth_failed: 'red', refused: 'red', invalid_output: 'red', timeout: 'red', error: 'red', failed: 'red', dead: 'red', cancelled: 'grey' };
export const outcomeTone = (o: string | undefined): Tone => (o ? (OUTCOME_TONE[o] ?? 'grey') : 'blue');

export interface HistoryRow {
  id: string;
  at: string;
  kind: 'run' | 'job';
  type: string;
  status: string;
  detail: string;
}

/** Runs and unfinished jobs merged newest first (a job with a run shows once, as its run). */
export function historyRows(runs: ClaimAgentRun[], jobs: ClaimAgentJob[], limit = 30): HistoryRow[] {
  const rows: HistoryRow[] = runs.map((r) => ({ id: r.id, at: r.endedAt ?? r.startedAt, kind: 'run', type: r.jobType, status: r.outcome ?? 'running', detail: `${r.agent.replace(/_/g, ' ')} · ${r.model} · ${r.toolCalls} tool call${r.toolCalls === 1 ? '' : 's'}${r.error ? ` · ${r.error}` : ''}` }));
  for (const j of jobs) {
    if (j.status === 'succeeded' && runs.length) continue;
    rows.push({ id: j.id, at: j.finishedAt ?? j.updatedAt, kind: 'job', type: j.type, status: j.status, detail: j.error ?? `${j.agent.replace(/_/g, ' ')} · attempt ${j.attempts}` });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, limit);
}

/** Validation for "Ask the brain". */
export function askError(q: string): string | undefined {
  const t = q.trim();
  if (t.length < 3) return 'Type a question (at least 3 characters)';
  if (t.length > 2000) return 'Keep the question under 2,000 characters';
  return undefined;
}
