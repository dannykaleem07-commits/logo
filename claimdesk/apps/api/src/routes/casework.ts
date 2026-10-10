// owned by casework
/**
 * casework routes (docs/SUPREME-DESIGN.md §L.9, §N.6 casework row):
 *
 *   GET  /claims/:id/brief   the Case Brief (for the owner: unmasked) + the latest case review (next best action,
 *                            plan, tasks, questions) and the claim's research notes
 *   POST /claims/:id/ask     {question} → research.ask (the owner's question; exempt from the AI budget) — the
 *                            answer is saved as a claim note
 *
 * Registration also wires the casework services the other slices call late-bound (§P.4): the pack digest provider
 * (prompts), the `{{fact:…}}` placeholder resolver (draft tools, email drafts) and the correction recorder (Needs-you).
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CaseReviewResult } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { parse } from '../schemas/common.js';
import { params, requireClaim } from './helpers.js';
import { enqueueJob } from '../agent/core.js';
import { registerPackDigestProvider, registerPlaceholderResolver } from '../ai/prompts.js';
import { runtimeServices } from '../agent/needsYou.js';
import { buildCaseBrief } from '../casework/caseBrief.js';
import { rememberInserted, resolvePlaceholders } from '../casework/facts.js';
import { packDigest } from '../brain/search.js';
import { recordCorrection } from '../brain/memory.js';

function humanOnly(request: FastifyRequest): void {
  const id = request.actor?.userId ?? '';
  if (request.agent || id === 'system' || id.startsWith('agent:')) throw new HttpError(403, 'HUMAN_REQUIRED', 'Only a signed-in person can do this.');
}

const askBody = z.object({ question: z.string().trim().min(3).max(2000), scope: z.enum(['claim', 'global']).optional() }).strict();

/** `{{fact:…}}` → display values from the claim's unmasked Case Brief (unknown ids stay in the text). */
export function claimPlaceholderResolver(ctx: AppContext, claimId: string, text: string): string {
  if (!/\{\{\s*fact:/.test(text)) return text;
  const r = resolvePlaceholders(text, buildCaseBrief(ctx, claimId, { mask: false }));
  rememberInserted(claimId, r.inserted.map((x) => x.display));
  return r.text;
}

/** Wire the casework services on ctx.services (idempotent). */
export function registerCaseworkServices(ctx: AppContext): void {
  registerPackDigestProvider(ctx, (c, spec) => packDigest(c, spec));
  registerPlaceholderResolver(ctx, claimPlaceholderResolver);
  runtimeServices(ctx).recordCorrection = recordCorrection;
}

/** The latest case review on a claim (from the agent run record). */
export function latestCaseReview(ctx: AppContext, claimId: string): { runId: string; at: string; result: CaseReviewResult } | null {
  const runs = ctx.repos.listAgentRuns(ctx.db, { claimId, limit: 50 });
  const run = runs.find((r) => r.jobType === 'case.review' && r.outcome === 'ok' && r.result);
  return run ? { runId: run.id, at: run.endedAt ?? run.startedAt, result: run.result as CaseReviewResult } : null;
}

export function registerCaseworkRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerCaseworkServices(ctx);

  app.get('/claims/:id/brief', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const notes = ctx.repos.listMemoryItems(ctx.db, { scope: `claim:${id}`, status: ['approved', 'proposed'], limit: 50 });
    return { brief: buildCaseBrief(ctx, id, { mask: false }), review: latestCaseReview(ctx, id), notes };
  });

  app.post('/claims/:id/ask', async (request, reply) => {
    humanOnly(request);
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(askBody, request.body ?? {});
    const job = enqueueJob(ctx, {
      type: 'research.ask',
      payload: { claimId: id, question: body.question, scope: body.scope ?? 'claim', askedBy: request.actor.userId },
      claimId: id,
      priority: 2,
      idempotencyKey: `research.ask:${createHash('sha256').update(body.question).digest('hex')}:${id}`,
      createdBy: request.actor.userId,
    });
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'agents.ask', entity: 'claims', entityId: id, after: { jobId: job.id }, at: ctx.now() });
    reply.code(202);
    return job;
  });
}
