import type { FastifyInstance } from 'fastify';
import { EventImmutableError } from '@ccguk/db';
import type { EventType } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { parse } from '../schemas/common.js';
import { eventBody, eventListQuery } from '../schemas/events.js';
import { recomputeClocks } from '../services/claimView.js';
import { applyEventSideEffects } from '../services/sideEffects.js';
import { requireClaim, params } from './helpers.js';

/** Chronology — append-only. Certain event types trigger side effects (see services/sideEffects.ts). */
export function registerEventsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/claims/:id/events', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const q = parse(eventListQuery, request.query);
    const all = ctx.repos.listEvents(ctx.db, id, { type: q.type as EventType | undefined, from: q.since });
    const events = q.limit ? all.slice(0, q.limit) : all;
    return { events };
  });

  app.post('/claims/:id/events', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(eventBody, request.body);
    const { event, effects } = ctx.db.transaction((tx) => {
      const scoped = { ...ctx, db: tx };
      const e = ctx.repos.appendEvent(tx, { ...body, claimId: id, createdBy: request.user.id, recordedAt: ctx.now() });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'event.append', entity: 'claim_events', entityId: e.id, after: { type: e.type, at: e.at, summary: e.summary }, at: ctx.now() });
      const fx = applyEventSideEffects(scoped, e, request.actor);
      return { event: e, effects: fx };
    });
    const clocks = recomputeClocks(ctx, id);
    return reply.status(201).send({ event, effects, clocks });
  });

  app.patch('/claims/:id/events/:eventId', async () => {
    throw new EventImmutableError('update');
  });
  app.delete('/claims/:id/events/:eventId', async () => {
    throw new EventImmutableError('delete');
  });
}
