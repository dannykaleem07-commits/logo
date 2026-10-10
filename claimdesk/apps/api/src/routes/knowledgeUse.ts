// owned by knowledge-use
/**
 * knowledge-use routes (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.3). All `/api`, session auth; every write route is
 * human-only through `assertHuman` (no agent tool declares these routes, so the perimeter refuses run tokens too).
 * DTOs in @ccguk/domain knowledge/api.ts.
 *
 *   GET  /knowledge/search?q=&claimId=&agent=          preview: exactly what that agent would see (hits + the block)
 *   GET  /knowledge/used?targetKind=outbox|document|docx&targetId=   "Knowledge used" badges for a draft
 *   GET  /knowledge/evals/runs?mode=&itemId=&limit=    replay runs (newest first)
 *   GET  /knowledge/evals/runs/:id                     one replay run
 *   POST /knowledge/evals/replay {mode, itemIds?}      start a replay (gate | nightly | drafts)
 *   GET  /knowledge/alarms?status=                     drift alarms
 *   POST /knowledge/alarms/:id/ack {note?}             acknowledge an alarm
 *
 * Boot: registers knowledge-use's hooks (knowledge block, usage rows, alarm cards) and the KB verification overlay.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AGENT_NAMES, type AgentName, type EvalRunView, type JobType, type KnowledgeAlarmView, type KnowledgeSearchResponse, type KnowledgeUsedResponse } from '@ccguk/domain';
import type { EvalRunRecord, KnowledgeAlarmRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import type { AgentSpec } from '../agent/contracts.js';
import { badRequest, notFound } from '../errors.js';
import { params } from './helpers.js';
import { assertHuman } from '../services/humanOnly.js';
import { enqueueJob } from '../agent/core.js';
import { buildCaseBrief } from '../casework/caseBrief.js';
import { hitView } from '../agent/tools/knowledgeUse.js';
import { registerUseHooks } from '../knowledge/use/hooks.js';
import { knowledgeContextFor } from '../knowledge/use/context.js';
import { searchKnowledge } from '../knowledge/use/retrieve.js';
import { knowledgeUsedFor } from '../knowledge/use/review.js';
import { acknowledgeAlarm } from '../knowledge/evals/drift.js';

/** The job type each agent's preview assumes (its main job). */
export const PREVIEW_JOB: Partial<Record<AgentName, JobType>> = {
  case_manager: 'case.review',
  drafter: 'draft.compose',
  mail: 'mail.reply',
  researcher: 'research.ask',
  reviewer: 'review.check',
  intake: 'intake.extract',
};

const searchQuery = z.object({
  q: z.string().max(300).optional(),
  claimId: z.string().max(128).optional(),
  agent: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(12).optional(),
});
const usedQuery = z.object({ targetKind: z.enum(['outbox', 'document', 'docx']), targetId: z.string().min(1).max(128) });
const runsQuery = z.object({ mode: z.enum(['gate', 'nightly', 'drafts']).optional(), itemId: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() });
const replayBody = z.object({ mode: z.enum(['gate', 'nightly', 'drafts']), itemIds: z.array(z.string().min(1).max(64)).max(50).optional() }).strict();
const alarmsQuery = z.object({ status: z.enum(['open', 'acknowledged', 'resolved', 'all']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() });
const ackBody = z.object({ note: z.string().max(1000).optional() }).strict();

export const evalRunView = (r: EvalRunRecord): EvalRunView => ({ id: r.id, mode: r.mode, baselineVersion: r.baselineVersion, candidate: r.candidate, cases: r.cases, metrics: r.metrics, verdict: r.verdict, details: r.details, startedAt: r.startedAt, finishedAt: r.finishedAt, createdBy: r.createdBy });
export const alarmView = (a: KnowledgeAlarmRecord): KnowledgeAlarmView => ({ ...a });

export function registerKnowledgeUseRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerUseHooks(ctx);
  app.addHook('onReady', async () => {
    registerUseHooks(ctx);
  });

  app.get('/knowledge/search', async (request): Promise<KnowledgeSearchResponse> => {
    const q = searchQuery.parse(request.query);
    const agent = (q.agent ?? 'case_manager') as AgentName;
    if (!(AGENT_NAMES as readonly string[]).includes(agent)) throw badRequest(`Unknown agent ${q.agent}`);
    const jobType = PREVIEW_JOB[agent] ?? 'research.ask';
    if (q.claimId) {
      if (!ctx.repos.getClaim(ctx.db, q.claimId)) throw notFound('claim', q.claimId);
      const r = knowledgeContextFor(ctx, { name: agent, jobType, title: 'preview', promptFiles: [], tools: [], allowRead: false, resultSchemaId: 'research_answer', defaults: { model: 'claude-sonnet-5-5', effort: 'low', maxTurns: 1, timeoutMs: 1 } } as AgentSpec, {
        task: `${q.q?.trim() || 'Review this claim'} (claimId ${q.claimId})`,
        brief: buildCaseBrief(ctx, q.claimId),
      });
      return { hits: (r?.refs ?? []).slice(0, q.limit ?? 12).map(hitView), block: r?.text ?? '' };
    }
    if (!q.q?.trim()) return { hits: [], block: '' };
    const r = searchKnowledge(ctx, { agent, jobType, query: q.q, claim: null, limit: q.limit ?? 12 });
    return { hits: r.hits.map(hitView), block: r.block };
  });

  app.get('/knowledge/used', async (request): Promise<KnowledgeUsedResponse> => {
    const q = usedQuery.parse(request.query);
    return { targetKind: q.targetKind, targetId: q.targetId, refs: knowledgeUsedFor(ctx, q.targetKind, q.targetId) };
  });

  app.get('/knowledge/evals/runs', async (request) => {
    const q = runsQuery.parse(request.query);
    return { runs: ctx.repos.listEvalRuns(ctx.db, { ...(q.mode ? { mode: q.mode } : {}), ...(q.itemId ? { itemId: q.itemId } : {}), limit: q.limit ?? 50, offset: q.offset ?? 0 }).map(evalRunView), cases: ctx.repos.countEvalCases(ctx.db) };
  });

  app.get('/knowledge/evals/runs/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const r = ctx.repos.getEvalRun(ctx.db, id);
    if (!r) throw notFound('replay run', id);
    return evalRunView(r);
  });

  app.post('/knowledge/evals/replay', async (request, reply) => {
    assertHuman(request.actor, 'start a replay');
    const body = replayBody.parse(request.body);
    if (body.mode === 'gate' && !body.itemIds?.length) throw badRequest('A gate replay needs the rule item ids');
    const now = ctx.now();
    const job =
      body.mode === 'drafts'
        ? enqueueJob(ctx, { type: 'knowledge.replay_drafts', payload: { mode: 'drafts' }, idempotencyKey: `knowledge.replay_drafts:owner:${now}`, createdBy: request.actor.userId, priority: 8 })
        : enqueueJob(ctx, { type: 'knowledge.replay', payload: { mode: body.mode, ...(body.itemIds ? { itemIds: body.itemIds } : {}) }, idempotencyKey: `knowledge.replay:${body.mode}:owner:${now}`, createdBy: request.actor.userId, priority: body.mode === 'gate' ? 6 : 8 });
    reply.code(202);
    return { jobId: job.id, type: job.type, status: job.status };
  });

  app.get('/knowledge/alarms', async (request) => {
    const q = alarmsQuery.parse(request.query);
    return { alarms: ctx.repos.listKnowledgeAlarms(ctx.db, { status: q.status ?? 'all', limit: q.limit ?? 100 }).map(alarmView) };
  });

  app.post('/knowledge/alarms/:id/ack', async (request) => {
    assertHuman(request.actor, 'acknowledge a knowledge alarm');
    const { id } = params<{ id: string }>(request);
    const body = ackBody.parse(request.body ?? {});
    return alarmView(acknowledgeAlarm(ctx, id, request.actor, body.note?.trim() || null));
  });
}
