// owned by claimai-server
/**
 * A claim's AI input (docs/CLAIM-AI-INPUT.md §11.2). Owner session only: no agent tool declares any of these routes
 * (route allow-list), the write routes are in HUMAN_ONLY_ROUTES and call assertHuman as well.
 *
 *   GET    /claims/:id/ai-input                                   AiInputPanel
 *   GET    /claims/:id/ai-input/inputs?limit&offset&kind          { items, total }
 *   POST   /claims/:id/ai-input/updates                           201 AiInputDetail
 *   POST   /claims/:id/ai-input/catch-up                          201 AiInputDetail
 *   GET    /claims/:id/ai-input/:inputId                          AiInputDetail
 *   POST   /claims/:id/ai-input/:inputId/{answers,apply,undo,cancel,think-again,files-done}
 *   POST   /claims/:id/ai-input/:inputId/files/:fileId            owner correction of one catch-up file
 *   PATCH  /claims/:id/ai-input/:inputId                          { autoApply }
 *   GET    /claims/:id/instructions?status=active|all
 *   POST   /claims/:id/instructions                               201 StandingInstruction
 *   POST   /claims/:id/instructions/:instructionId/retire
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AGENT_SCOPES, CONTACT_ROLES, type AgentScope, type ContactRole } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { parse } from '../schemas/common.js';
import { assertHuman } from '../services/humanOnly.js';
import { applyInput } from '../claimai/apply.js';
import { filesDone, replanNow } from '../claimai/catchUp.js';
import { installClaimAi } from '../claimai/hooks.js';
import { createStandingInstruction, instructionView, listInstructionViews, retireStandingInstruction } from '../claimai/instructions.js';
import { interpretUpdate, resumeWaiting, thinkAgain } from '../claimai/interpret.js';
import { auditInput, cancelInput, createCatchUpInput, createUpdateInput, logInput, recordAnswers, recordFileOverride, requireClaimFor, requireInput } from '../claimai/service.js';
import { undoInput } from '../claimai/undo.js';
import { detailView, panelView, summaryView } from '../claimai/views.js';
import { params } from './helpers.js';

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Not a date');
const scopes = z.array(z.enum(AGENT_SCOPES as unknown as [AgentScope, ...AgentScope[]])).min(1).max(AGENT_SCOPES.length);
const contacts = z.array(z.enum(CONTACT_ROLES as unknown as [ContactRole, ...ContactRole[]])).min(1).max(CONTACT_ROLES.length);

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0), kind: z.enum(['update', 'catch_up']).optional() });
const updateBody = z.object({ text: z.string().max(8000).default(''), channel: z.enum(['typed', 'call_note', 'voice_note']).default('typed'), extraText: z.string().max(20000).nullable().optional() });
const answersBody = z.object({
  answers: z.array(z.object({ questionId: z.string().min(1).max(40), optionId: z.string().min(1).max(60).optional(), text: z.string().max(500).optional(), date: isoDate.optional() })).min(1).max(20),
});
const editsSchema = z
  .object({ at: isoDate.optional(), value: z.string().max(4000).optional(), dueAt: isoDate.optional(), until: isoDate.nullable().optional(), text: z.string().max(2000).optional(), appliesTo: scopes.optional() })
  .strict();
const applyBody = z.object({ actions: z.array(z.object({ key: z.string().min(1).max(40), ticked: z.boolean(), edits: editsSchema.optional() })).max(200).optional() }).default({});
const undoBody = z.object({ actionKeys: z.array(z.string().min(1).max(40)).max(200).optional(), reason: z.string().trim().max(500).optional() }).default({});
const catchUpBody = z.object({ note: z.string().max(2000).optional(), autoApply: z.boolean().default(true) }).default({});
const fileBody = z.object({ direction: z.enum(['out', 'in', 'none']).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'The date is YYYY-MM-DD').optional(), kind: z.string().min(1).max(60).optional(), notThisClaim: z.boolean().optional() });
const patchBody = z.object({ autoApply: z.boolean() });
const instructionsQuery = z.object({ status: z.enum(['active', 'all']).default('all') });
const effectSchema = z.union([
  z.object({ kind: z.enum(['hold_contact', 'ask_before_sending']), contacts }),
  z.object({ kind: z.literal('pause_agents') }),
  z.object({ kind: z.literal('none') }),
]);
const instructionBody = z.object({ text: z.string().trim().min(3).max(1000), appliesTo: scopes.optional(), until: isoDate.nullable().optional(), effect: effectSchema.nullable().optional() });
const retireBody = z.object({ reason: z.string().trim().max(500).optional() }).default({});

function human(request: FastifyRequest, what: string): void {
  assertHuman(request.actor, what);
  if (request.agent) throw new HttpError(409, 'HUMAN_REQUIRED', `A person must ${what} — agents and the system cannot`);
}

export function registerClaimAiRoutes(app: FastifyInstance, ctx: AppContext): void {
  installClaimAi(ctx);

  const detail = (claimId: string, inputId: string) => detailView(ctx, requireInput(ctx, claimId, inputId));

  app.get('/claims/:id/ai-input', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaimFor(ctx, id);
    resumeWaiting(ctx, id);
    return panelView(ctx, id);
  });

  app.get('/claims/:id/ai-input/inputs', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaimFor(ctx, id);
    const q = parse(listQuery, request.query ?? {});
    const items = ctx.repos.listAiInputs(ctx.db, { claimId: id, ...(q.kind ? { kind: q.kind } : {}), limit: q.limit, offset: q.offset });
    return { items: items.map((i) => summaryView(ctx, i)), total: ctx.repos.countAiInputs(ctx.db, { claimId: id, ...(q.kind ? { kind: q.kind } : {}) }) };
  });

  app.post('/claims/:id/ai-input/updates', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    human(request, 'give ClaimDesk an update');
    const body = parse(updateBody, request.body ?? {});
    const input = createUpdateInput(ctx, id, { text: body.text, channel: body.channel, extraText: body.extraText ?? null }, request.actor);
    const fresh = interpretUpdate(ctx, input.id, { reason: 'create', actor: request.actor });
    return reply.status(201).send(detailView(ctx, fresh));
  });

  app.post('/claims/:id/ai-input/catch-up', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    human(request, 'start a catch-up');
    const body = parse(catchUpBody, request.body ?? {});
    const input = createCatchUpInput(ctx, id, { note: body.note ?? null, autoApply: body.autoApply }, request.actor);
    return reply.status(201).send(detailView(ctx, input));
  });

  app.get('/claims/:id/ai-input/:inputId', async (request) => {
    const { id, inputId } = params<{ id: string; inputId: string }>(request);
    const input = requireInput(ctx, id, inputId);
    if (input.status === 'waiting_ai' || input.status === 'partly_applied') resumeWaiting(ctx, id);
    return detail(id, inputId);
  });

  app.post('/claims/:id/ai-input/:inputId/answers', async (request) => {
    const { id, inputId } = params<{ id: string; inputId: string }>(request);
    human(request, 'answer a question about an update');
    const body = parse(answersBody, request.body ?? {});
    const input = requireInput(ctx, id, inputId);
    if (!['clarify', 'preview', 'waiting_ai', 'interpreting', 'nothing_to_do', 'partly_applied', 'failed'].includes(input.status)) throw new HttpError(409, 'INPUT_NOT_READY', `This input is ${input.status}`, { status: input.status });
    recordAnswers(ctx, input, body.answers, request.actor);
    if (input.kind === 'update') interpretUpdate(ctx, input.id, { reason: 'answers', actor: request.actor });
    return detail(id, inputId);
  });

  app.post('/claims/:id/ai-input/:inputId/apply', async (request) => {
    const { id, inputId } = params<{ id: string; inputId: string }>(request);
    human(request, 'apply an update');
    const body = parse(applyBody, request.body ?? {});
    const input = await applyInput(ctx, request.actor, id, inputId, body.actions ?? [], { mode: 'owner' });
    return detailView(ctx, input);
  });

  app.post('/claims/:id/ai-input/:inputId/undo', async (request) => {
    const { id, inputId } = params<{ id: string; inputId: string }>(request);
    human(request, 'undo an update');
    const body = parse(undoBody, request.body ?? {});
    const r = await undoInput(ctx, request.actor, id, inputId, { ...(body.actionKeys ? { actionKeys: body.actionKeys } : {}), reason: body.reason ?? null });
    return detailView(ctx, r.input);
  });

  app.post('/claims/:id/ai-input/:inputId/cancel', async (request) => {
    const { id, inputId } = params<{ id: string; inputId: string }>(request);
    human(request, 'cancel an update');
    return detailView(ctx, cancelInput(ctx, id, inputId, request.actor));
  });

  app.post('/claims/:id/ai-input/:inputId/think-again', async (request, reply) => {
    const { id, inputId } = params<{ id: string; inputId: string }>(request);
    human(request, 'ask the AI to think again');
    const input = requireInput(ctx, id, inputId);
    if (input.kind !== 'update') throw new HttpError(409, 'NOT_AN_UPDATE', 'Think again is for typed updates — correct a catch-up file on its row instead');
    if (['applying', 'applied', 'cancelled', 'undone'].includes(input.status)) throw new HttpError(409, 'INPUT_NOT_READY', `This input is ${input.status}`, { status: input.status });
    try {
      const fresh = thinkAgain(ctx, input, request.actor);
      return reply.status(202).send(detailView(ctx, fresh));
    } catch (err) {
      const waiting = (err as { waiting?: unknown }).waiting;
      if (waiting) throw new HttpError(409, 'AI_UNAVAILABLE', 'The AI cannot run right now — your update keeps its place and is read when it is back', { waiting });
      throw err;
    }
  });

  app.post('/claims/:id/ai-input/:inputId/files-done', async (request) => {
    const { id, inputId } = params<{ id: string; inputId: string }>(request);
    human(request, 'finish a catch-up upload');
    const input = requireInput(ctx, id, inputId);
    if (input.kind !== 'catch_up') throw new HttpError(409, 'NOT_CATCH_UP', 'Only catch-up inputs have files');
    if (!input.filesDone) auditInput(ctx, request.actor, 'claim_ai.catch_up.files_done', input, { bundleId: input.bundleId });
    return detailView(ctx, filesDone(ctx, input, request.actor.userId));
  });

  app.post('/claims/:id/ai-input/:inputId/files/:fileId', async (request) => {
    const { id, inputId, fileId } = params<{ id: string; inputId: string; fileId: string }>(request);
    human(request, 'correct a catch-up file');
    const body = parse(fileBody, request.body ?? {});
    const input = requireInput(ctx, id, inputId);
    recordFileOverride(ctx, input, fileId, body as Parameters<typeof recordFileOverride>[3], request.actor);
    return detailView(ctx, replanNow(ctx, ctx.repos.requireAiInput(ctx.db, input.id)));
  });

  app.patch('/claims/:id/ai-input/:inputId', async (request) => {
    const { id, inputId } = params<{ id: string; inputId: string }>(request);
    human(request, 'change how a catch-up is applied');
    const body = parse(patchBody, request.body ?? {});
    const input = requireInput(ctx, id, inputId);
    if (input.kind !== 'catch_up') throw new HttpError(409, 'NOT_CATCH_UP', 'Apply automatically is a catch-up setting');
    if (['applying', 'applied', 'cancelled', 'undone'].includes(input.status)) throw new HttpError(409, 'INPUT_NOT_READY', `This catch-up is ${input.status}`, { status: input.status });
    if (input.autoApply !== body.autoApply) {
      ctx.repos.updateAiInput(ctx.db, input.id, { autoApply: body.autoApply }, ctx.now());
      logInput(ctx, input, 'edited', request.actor.userId, { note: `apply automatically ${body.autoApply ? 'on' : 'off'}` });
      auditInput(ctx, request.actor, 'claim_ai.input.edit', input, { autoApply: body.autoApply });
    }
    return detailView(ctx, body.autoApply ? replanNow(ctx, ctx.repos.requireAiInput(ctx.db, input.id)) : ctx.repos.requireAiInput(ctx.db, input.id));
  });

  app.get('/claims/:id/instructions', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaimFor(ctx, id);
    const q = parse(instructionsQuery, request.query ?? {});
    return { items: listInstructionViews(ctx, id, { status: q.status }) };
  });

  app.post('/claims/:id/instructions', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    human(request, 'give a standing instruction');
    requireClaimFor(ctx, id);
    const body = parse(instructionBody, request.body ?? {});
    const r = createStandingInstruction(
      ctx,
      {
        claimId: id,
        text: body.text,
        ...(body.appliesTo ? { appliesTo: body.appliesTo as Parameters<typeof createStandingInstruction>[1]['appliesTo'] } : {}),
        ...(body.until !== undefined ? { until: body.until } : {}),
        ...(body.effect !== undefined ? { effect: body.effect as Parameters<typeof createStandingInstruction>[1]['effect'] } : {}),
      },
      request.actor,
    );
    return reply.status(201).send(instructionView(ctx, r));
  });

  app.post('/claims/:id/instructions/:instructionId/retire', async (request) => {
    const { id, instructionId } = params<{ id: string; instructionId: string }>(request);
    human(request, 'remove a standing instruction');
    const body = parse(retireBody, request.body ?? {});
    return instructionView(ctx, retireStandingInstruction(ctx, id, instructionId, request.actor, body.reason ?? null));
  });
}
