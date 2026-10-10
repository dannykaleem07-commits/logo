// owned by knowledge-research
/**
 * Knowledge research jobs (docs/SUPREME-KNOWLEDGE-BUILDER.md §7, §10.1). None takes the per-claim lock; lane, agent and
 * priority come from JOB_TYPE_INFO (`knowledgeHandler`). With learning paused every job finishes `learning_off`
 * (§12.3).
 *
 *   knowledge.gap_scan      io  supervisor  raise gaps from reviews, research.ask, Needs-you, directory, KB, intake,
 *                                           triage; queue due research within the day's budget; first-run self-test
 *   knowledge.research      ai  researcher  one gap: local pass, then the researcher (no web tools)
 *   knowledge.research_web  ai  researcher  one gap with allow-listed WebFetch — only when the owner switched it on
 *   knowledge.fetch         io  supervisor  fetch one URL now (owner fetch-now) or run the source self-test
 *   knowledge.watch         io  supervisor  re-fetch every source behind active items and KB checks (weekly), prune
 *                                           unreferenced snapshot files older than 180 days, then the weekly self-test
 */
import { z } from 'zod';
import type { JobHandler, NeedsYouResolver } from '../contracts.js';
import { isAutomatedActor } from '../../services/humanOnly.js';
import { knowledgeHandler, learningOff } from '../../knowledge/jobs.js';
import { getKnowledgeSettings } from '../../knowledge/settings.js';
import { registerResearchHooks } from '../../knowledge/research/hooks.js';
import { runGapScan } from '../../knowledge/research/gapScan.js';
import { runResearchJob, type ResearchPayload } from '../../knowledge/research/researcher.js';
import { fetchSource } from '../../knowledge/research/fetcher.js';
import { pruneSnapshots, runSelftest, runWatch } from '../../knowledge/research/watch.js';
import { londonDay } from '../core.js';

const MIN = 60_000;

const gapScanPayload = z.object({ slot: z.string().max(64).optional() }).passthrough();
const researchPayload = z.object({ gapId: z.string().min(1).max(64), attempt: z.number().int().min(1).max(100).optional(), owner: z.boolean().optional() }).passthrough();
const fetchPayload = z
  .object({ url: z.string().min(10).max(2000).optional(), reason: z.string().max(500).optional(), gapId: z.string().max(64).optional(), selftest: z.boolean().optional(), domains: z.array(z.string().max(100)).max(50).optional() })
  .passthrough()
  .refine((p) => p.selftest === true || typeof p.url === 'string', { message: 'knowledge.fetch needs a url or selftest: true' });
const watchPayload = z.object({ week: z.string().max(16).optional() }).passthrough();

export const gapScanHandler = knowledgeHandler<z.infer<typeof gapScanPayload>, Record<string, unknown>>('knowledge.gap_scan', gapScanPayload, async ({ ctx, job }) => {
  registerResearchHooks(ctx);
  if (learningOff(ctx)) return { kind: 'done', result: { result: 'learning_off' } };
  const { result, followUps } = runGapScan(ctx, { jobId: job.id });
  return { kind: 'done', result: { result: 'scanned', ...result }, followUps: followUps.map((f) => ({ ...f, parentJobId: job.id })) };
}, { timeoutMs: 5 * MIN });

export const researchHandler = knowledgeHandler<ResearchPayload, Record<string, unknown>>('knowledge.research', researchPayload as never, async ({ ctx, job, payload }) => {
  registerResearchHooks(ctx);
  return runResearchJob(ctx, job, payload, false);
}, { timeoutMs: 10 * MIN });

export const researchWebHandler = knowledgeHandler<ResearchPayload, Record<string, unknown>>('knowledge.research_web', researchPayload as never, async ({ ctx, job, payload }) => {
  registerResearchHooks(ctx);
  return runResearchJob(ctx, job, payload, true);
}, { timeoutMs: 12 * MIN });

export const fetchHandler = knowledgeHandler<z.infer<typeof fetchPayload>, Record<string, unknown>>('knowledge.fetch', fetchPayload as never, async ({ ctx, job, payload, signal }) => {
  if (learningOff(ctx)) return { kind: 'done', result: { result: 'learning_off' } };
  const createdBy = isAutomatedActor({ userId: job.createdBy }) ? 'agent:supervisor' : job.createdBy;
  if (payload.selftest) {
    const rows = await runSelftest(ctx, { ...(payload.domains ? { domains: payload.domains } : {}), jobId: job.id, createdBy, signal });
    return { kind: 'done', result: { result: 'selftest', ok: rows.filter((r) => r.ok).length, failed: rows.filter((r) => !r.ok).map((r) => ({ domain: r.domain, detail: r.detail })) } };
  }
  const r = await fetchSource(ctx, { url: payload.url!, reason: payload.reason ?? 'fetch now', gapId: payload.gapId ?? null, jobId: job.id, createdBy }, { signal });
  return { kind: 'done', result: r.ok ? { result: 'fetched', snapshotId: r.snapshot.id, changed: r.snapshot.changed, flags: r.snapshot.injectionFlags } : { result: 'refused', code: r.code, reason: r.reason } };
}, { timeoutMs: 15 * MIN });

export const watchHandler = knowledgeHandler<z.infer<typeof watchPayload>, Record<string, unknown>>('knowledge.watch', watchPayload, async ({ ctx, job, signal }) => {
  registerResearchHooks(ctx);
  if (learningOff(ctx)) return { kind: 'done', result: { result: 'learning_off' } };
  if (!getKnowledgeSettings(ctx).sourceFetchEnabled) return { kind: 'done', result: { result: 'fetch_off' } };
  const r = await runWatch(ctx, { jobId: job.id, signal });
  const pruned = pruneSnapshots(ctx, { jobId: job.id }).pruned.length;
  return {
    kind: 'done',
    result: { result: 'watched', ...r, pruned },
    followUps: [{ type: 'knowledge.fetch', payload: { selftest: true, reason: 'weekly source self-test' }, idempotencyKey: `knowledge.fetch:selftest:${londonDay(ctx.now())}`, parentJobId: job.id, createdBy: 'agent:supervisor' }],
  };
}, { timeoutMs: 30 * MIN });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const knowledgeResearchJobHandlers: JobHandler<any, any>[] = [gapScanHandler, researchHandler, researchWebHandler, fetchHandler, watchHandler];

/** The gap card is resolved by core's knowledge_review resolver through the `onReviewResolved` hook (no own kind). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const knowledgeResearchNeedsYouResolvers: NeedsYouResolver<any>[] = [];
