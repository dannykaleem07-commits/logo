// owned by knowledge-use
/**
 * Knowledge evals: golden replay, draft replay, drift (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.1, §12).
 *
 *   knowledge.replay         cpu · supervisor · 6 gate / 8 nightly — `{mode: 'gate', itemIds}` when a proposed rule waits
 *                            for the owner (queued by the store), `{mode: 'nightly'}` at 03:00
 *   knowledge.replay_drafts  ai · drafter · 8 — owner button, or weekly when the owner enabled it (default off)
 *   knowledge.drift          io · supervisor · 7 — daily 05:00: drift alarms, quarantine on a perimeter alarm
 *
 * With learning paused (KR-13) every one finishes with `result: 'learning_off'` (§12.3). No job takes a claim lock.
 * The alarm card is answered through core's `knowledge_review` resolver and knowledge-use's `onReviewResolved`.
 */
import { z } from 'zod';
import type { JobHandler, NeedsYouResolver } from '../contracts.js';
import { isAutomatedActor } from '../../services/humanOnly.js';
import { knowledgeHandler, learningOff } from '../../knowledge/jobs.js';
import { runReplayDrafts, runReplayGate, runReplayNightly } from '../../knowledge/evals/replay.js';
import { runDrift } from '../../knowledge/evals/drift.js';
import { registerUseHooks } from '../../knowledge/use/hooks.js';

const MIN = 60_000;

export const replayPayload = z
  .object({ mode: z.enum(['gate', 'nightly']).default('nightly'), itemIds: z.array(z.string().min(1).max(64)).max(50).optional() })
  .passthrough()
  .refine((p) => p.mode !== 'gate' || (p.itemIds?.length ?? 0) > 0, { message: 'a gate replay needs itemIds' });
type ReplayPayload = z.infer<typeof replayPayload>;

export const knowledgeReplayHandler = knowledgeHandler<ReplayPayload, Record<string, unknown>>(
  'knowledge.replay',
  replayPayload as never,
  async ({ ctx, job, payload }) => {
    registerUseHooks(ctx);
    if (learningOff(ctx)) return { kind: 'done', result: { result: 'learning_off' } };
    const actor = isAutomatedActor({ userId: job.createdBy }) ? { userId: 'agent:supervisor' } : { userId: job.createdBy };
    const r = payload.mode === 'gate' ? runReplayGate(ctx, payload.itemIds ?? [], { jobId: job.id, actor }) : runReplayNightly(ctx, { jobId: job.id, actor });
    return { kind: 'done', result: { result: 'replayed', mode: payload.mode, ...r } };
  },
  { timeoutMs: 10 * MIN },
);

export const replayDraftsPayload = z.object({ mode: z.literal('drafts').optional() }).passthrough();

export const knowledgeReplayDraftsHandler = knowledgeHandler<z.infer<typeof replayDraftsPayload>, Record<string, unknown>>(
  'knowledge.replay_drafts',
  replayDraftsPayload,
  async ({ ctx, job }) => {
    registerUseHooks(ctx);
    if (learningOff(ctx)) return { kind: 'done', result: { result: 'learning_off' } };
    return runReplayDrafts(ctx, job, { ownerTriggered: !isAutomatedActor({ userId: job.createdBy }) });
  },
  { timeoutMs: 60 * MIN, maxAttempts: 2 },
);

export const driftPayload = z.object({ day: z.string().max(16).optional() }).passthrough();

export const knowledgeDriftHandler = knowledgeHandler<z.infer<typeof driftPayload>, Record<string, unknown>>(
  'knowledge.drift',
  driftPayload,
  async ({ ctx, job }) => {
    registerUseHooks(ctx);
    if (learningOff(ctx)) return { kind: 'done', result: { result: 'learning_off' } };
    const r = runDrift(ctx, { jobId: job.id });
    return { kind: 'done', result: { result: r.result, version: r.window?.version ?? null, findings: r.findings.length, alarms: r.alarms } };
  },
  { timeoutMs: 5 * MIN },
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const knowledgeEvalsJobHandlers: JobHandler<any, any>[] = [knowledgeReplayHandler, knowledgeReplayDraftsHandler, knowledgeDriftHandler];

/** The alarm card is core's `knowledge_review` kind (resolved through `onReviewResolved`): no own resolver. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const knowledgeEvalsNeedsYouResolvers: NeedsYouResolver<any>[] = [];
