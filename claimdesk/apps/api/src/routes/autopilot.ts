// owned by ap-autopilot
/**
 * Autopilot routes (docs/SUPREME-AUTOPILOT.md §H.4). Session auth; (H) = human-only (agent perimeter §H.5).
 *
 *   GET  /claims/:id/autopilot                       the plan (evaluated now), the record, the catalogue, the log
 *   POST /claims/:id/autopilot/evaluate              evaluate, log the changes, store the plan, queue a tick
 *   POST /claims/:id/autopilot/pause            (H)  { reason }
 *   POST /claims/:id/autopilot/resume           (H)
 *   POST /claims/:id/autopilot/steps/:stepId/:action (H) run | skip | ask | auto | done | snooze | clear
 *   GET  /claims/:id/hire-offers                     the offer register
 *   POST /claims/:id/hire-offers                     bind a held car and its offer email (terms hash)
 *   POST /hire-offers/:id/response                   the client's answer read from email (agents; sensitive < 0.9)
 *   POST /hire-offers/:id/accept                (H)  accepted by phone / in person
 *   POST /hire-offers/:id/withdraw                   withdraw a draft or sent offer
 *
 * The settlement-offer register (GET/POST /claims/:id/settlement-offers, PATCH …/:oid) landed with ClaimDesk 0.4
 * (routes/offers.ts); decisions there stay human-only.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { parse, id as idSchema } from '../schemas/common.js';
import { params, requireClaim } from './helpers.js';
import { applyStepAction, autopilotView, pauseAutopilot, resumeAutopilot, STEP_OVERRIDE_ACTIONS } from '../autopilot/service.js';
import { claimHireOffers, prepareHireOffer, recordHireOfferResponse, withdrawHireOffer } from '../autopilot/hireOffers.js';
import { nudgeAutopilot } from '../autopilot/nudge.js';
import { notFound } from '../errors.js';

const reasonBody = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
const stepActionBody = z.object({ reason: z.string().trim().max(1000).nullish(), until: z.string().min(10).max(40).nullish() }).strict();
const prepareBody = z.object({ reservationId: idSchema, outboxId: idSchema.nullish(), alternatives: z.array(idSchema).max(5).default([]) }).strict();
const responseBody = z
  .object({
    decision: z.enum(['accept', 'decline']),
    messageId: idSchema.nullish(),
    chosenFleetUnitId: idSchema.nullish(),
    confidence: z.number().min(0).max(1).nullish(),
    how: z.enum(['email_reply', 'phone', 'in_person', 'sms']).nullish(),
    note: z.string().max(1000).nullish(),
  })
  .strict();
const acceptBody = z.object({ how: z.enum(['phone', 'in_person']).default('phone'), note: z.string().trim().max(1000).nullish() }).strict();

export function registerAutopilotRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/claims/:id/autopilot', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    return autopilotView(ctx, id);
  });

  app.post('/claims/:id/autopilot/evaluate', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const view = autopilotView(ctx, id, { store: true });
    nudgeAutopilot(ctx, id, 'evaluate', { createdBy: request.actor.userId });
    return view;
  });

  app.post('/claims/:id/autopilot/pause', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(reasonBody, request.body ?? {});
    return { record: pauseAutopilot(ctx, request.actor, id, body.reason) };
  });

  app.post('/claims/:id/autopilot/resume', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(z.object({ reason: z.string().trim().max(1000).nullish() }).strict(), request.body ?? {});
    return { record: resumeAutopilot(ctx, request.actor, id, body.reason ?? undefined) };
  });

  app.post('/claims/:id/autopilot/steps/:stepId/:action', async (request) => {
    const { id, stepId, action } = params<{ id: string; stepId: string; action: string }>(request);
    requireClaim(ctx, id);
    const act = parse(z.enum(STEP_OVERRIDE_ACTIONS), action);
    const body = parse(stepActionBody, request.body ?? {});
    return applyStepAction(ctx, request.actor, id, stepId, act, { reason: body.reason ?? null, until: body.until ?? null });
  });

  app.get('/claims/:id/hire-offers', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    return { offers: claimHireOffers(ctx, id) };
  });

  app.post('/claims/:id/hire-offers', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(prepareBody, request.body);
    const offer = prepareHireOffer(ctx, request.actor, { claimId: id, reservationId: body.reservationId, outboxId: body.outboxId ?? null, alternatives: body.alternatives });
    return reply.status(201).send({ offer });
  });

  app.post('/hire-offers/:id/response', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(responseBody, request.body);
    if (!ctx.repos.getHireOffer(ctx.db, id)) throw notFound('hire offer', id);
    const how = body.how ?? (request.agent ? 'email_reply' : 'phone');
    return {
      offer: recordHireOfferResponse(ctx, request, request.actor, id, {
        decision: body.decision,
        how,
        messageId: body.messageId ?? null,
        chosenFleetUnitId: body.chosenFleetUnitId ?? null,
        confidence: body.confidence ?? null,
        note: body.note ?? null,
      }),
    };
  });

  app.post('/hire-offers/:id/accept', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(acceptBody, request.body ?? {});
    return { offer: recordHireOfferResponse(ctx, request, request.actor, id, { decision: 'accept', how: body.how, note: body.note ?? null, confidence: 1 }) };
  });

  app.post('/hire-offers/:id/withdraw', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(reasonBody, request.body ?? {});
    return { offer: withdrawHireOffer(ctx, request.actor, id, body.reason) };
  });
}
