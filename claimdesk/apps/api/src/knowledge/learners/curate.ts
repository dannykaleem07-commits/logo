// owned by knowledge-learners
/**
 * The curator (docs/SUPREME-KNOWLEDGE-BUILDER.md §6.4 step 2) — `knowledge.curate`, AI (Opus, medium, 6 turns,
 * 8 min, agent `researcher`, prompt `knowledge-curator.md`). Triggered by a corrections cluster with ≥ 3 new
 * corrections since its last curation, or the weekly run (Sunday 04:00), which queues one job per such cluster within
 * the daily budget (`budgets.curateRunsPerDay`).
 *
 * The curator only sees the cluster's MASKED diffs (`corrections_get`) and proposes through
 * `knowledge_curate_propose`, which goes through the store and decideKnowledge: curated style with support ≥ 3 may
 * apply itself (KN-18); every rule and strategy waits for the owner (KN-07) with its replay gate queued.
 */
import { isoWeekOf, recurringEdits, type KnowledgeCurateResult, type ToolName } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import type { AgentSpec, JobOutcome, JobRecord } from '../../agent/contracts.js';
import { runAgent } from '../../agent/runAgent.js';
import { enqueueJob, londonDay } from '../../agent/core.js';
import { getTool } from '../../agent/tools/index.js';
import { aiFailure, isAiOff } from '../../casework/ai.js';
import { getKnowledgeSettings } from '../settings.js';
import { CURATE_MIN_NEW, curateRunsToday, markCurated, maskCorrectionText, newSinceCuration } from './corrections.js';
import { LEARNER } from './common.js';

/** The curator's tools: its own two plus knowledge_search / brain_search when registered (knowledge_search lands with knowledge-use). */
export const CURATOR_TOOLS: readonly ToolName[] = ['corrections_get', 'knowledge_curate_propose', 'knowledge_search', 'brain_search'];

export function curateSpec(): AgentSpec {
  return {
    name: 'researcher',
    jobType: 'knowledge.curate',
    title: 'Knowledge curator',
    promptFiles: ['knowledge-curator.md'],
    tools: CURATOR_TOOLS.filter((t) => Boolean(getTool(t))),
    allowRead: false,
    resultSchemaId: 'knowledge_curate',
    defaults: { model: 'claude-opus-5-5', effort: 'medium', maxTurns: 6, timeoutMs: 8 * 60_000 },
  };
}

export interface CuratePayload {
  clusterKey?: string;
  weekly?: boolean;
  force?: boolean;
}

export type CurateJobResult =
  | { result: 'learning_off' | 'nothing_new' }
  | { result: 'queued'; jobIds: string[] }
  | { result: 'curated'; clusterKey: string; runId: string; proposedItemIds: string[]; ignoredItemIds: string[]; noPattern: boolean; corrections: number };

/** Weekly run (or the owner's "curate now"): one job per cluster with new corrections, within the budget. */
function queueWeekly(ctx: AppContext, createdBy: string): string[] {
  const settings = getKnowledgeSettings(ctx);
  let budget = settings.budgets.curateRunsPerDay - curateRunsToday(ctx);
  const out: string[] = [];
  const week = isoWeekOf(londonDay(ctx.now()));
  for (const c of ctx.repos.listCorrectionClusters(ctx.db)) {
    if (budget <= 0) break;
    const fresh = newSinceCuration(ctx, c.clusterKey).length;
    if (fresh === 0 || c.corrections < CURATE_MIN_NEW) continue;
    const job = enqueueJob(ctx, { type: 'knowledge.curate', payload: { clusterKey: c.clusterKey }, idempotencyKey: `knowledge.curate:${c.clusterKey}:${week}`, createdBy });
    out.push(job.id);
    budget -= 1;
  }
  return out;
}

export async function runCurate(ctx: AppContext, job: JobRecord, p: CuratePayload): Promise<JobOutcome<CurateJobResult>> {
  if (!getKnowledgeSettings(ctx).learningEnabled) return { kind: 'done', result: { result: 'learning_off' } };
  if (p.weekly || !p.clusterKey) {
    const jobIds = queueWeekly(ctx, job.createdBy.startsWith('agent:') || job.createdBy === 'system' ? LEARNER : job.createdBy);
    return { kind: 'done', result: jobIds.length ? { result: 'queued', jobIds } : { result: 'nothing_new' } };
  }
  const clusterKey = p.clusterKey;
  const fresh = newSinceCuration(ctx, clusterKey);
  if (!fresh.length && !p.force) return { kind: 'done', result: { result: 'nothing_new' } };
  const recent = ctx.repos.listCorrections(ctx.db, { clusterKey, limit: 30, newestFirst: true });
  const edits = recurringEdits(recent.map((c) => ({ ops: c.diff })), Math.min(3, recent.length))
    .slice(0, 10)
    .map((e) => `- ${e.op === 'del' ? 'removed' : 'added'} "${maskCorrectionText(ctx, e.phrase, null).slice(0, 200)}" in ${e.support} corrections`);
  const run = await runAgent(ctx, curateSpec(), job, {
    task: `Curate the owner's corrections in cluster ${clusterKey} (${recent.length} corrections, ${fresh.length} new since the last curation).`,
    question: [
      `Cluster: ${clusterKey}`,
      `Categories: ${[...new Set(recent.flatMap((c) => c.categories))].sort().join(', ') || 'none'}`,
      `Edits code found in at least ${Math.min(3, recent.length)} corrections:`,
      edits.length ? edits.join('\n') : '- none',
      '',
      `Call corrections_get with clusterKey "${clusterKey}" to read the masked diffs. Propose only what the owner clearly repeats, with knowledge_curate_propose; otherwise set noPattern true. Return the KnowledgeCurateResult JSON.`,
    ].join('\n'),
  });
  const failure = aiFailure(ctx, run.outcome);
  if (failure) return isAiOff(run.outcome) ? { kind: 'fail', reason: 'AI is off; the cluster was not curated' } : (failure as JobOutcome<CurateJobResult>);
  const r = run.result as KnowledgeCurateResult;
  // Only items this run really proposed count (the model cannot claim others).
  const mine = new Set(ctx.repos.getKnowledgeItems(ctx.db, r.proposedItemIds).filter((i) => i.originRunId === run.runId).map((i) => i.id));
  markCurated(ctx, clusterKey);
  return {
    kind: 'done',
    result: { result: 'curated', clusterKey, runId: run.runId, proposedItemIds: r.proposedItemIds.filter((id) => mine.has(id)), ignoredItemIds: r.proposedItemIds.filter((id) => !mine.has(id)), noPattern: r.noPattern, corrections: recent.length },
  };
}
