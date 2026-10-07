// owned by runtime
/**
 * Needs-you inbox routes (docs/SUPREME-DESIGN.md §C.7, §L.2, §N.6):
 *   GET  /needs-you?status=&kind=&claimId=&priority=   (default: open)
 *   GET  /needs-you/count                              top-bar badge (open total + urgent)
 *   GET  /needs-you/:id                                item + events
 *   POST /needs-you/:id/resolve {optionId, edits?, note?}   runs the kind's resolver as the signed-in owner
 *   POST /needs-you/:id/snooze {until? | minutes?}
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NEEDS_YOU_KINDS, NEEDS_YOU_PRIORITIES, type NeedsYouKind, type NeedsYouPriority, type NeedsYouStatus } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import { isoDateTime, parse } from '../schemas/common.js';
import { params } from './helpers.js';
import { getNeedsYouDetail, listNeedsYouItems, needsYouCount, resolveNeedsYouItem, snoozeNeedsYouItem } from '../agent/needsYou.js';

const STATUSES = ['open', 'snoozed', 'resolved', 'expired', 'superseded'] as const;

const list = <T extends string>(allowed: readonly T[]) =>
  z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined))
    .refine((v) => !v || v.every((x) => (allowed as readonly string[]).includes(x)), 'unknown value')
    .transform((v) => v as T[] | undefined);

const listQuery = z.object({
  status: z.string().optional(),
  kind: list<NeedsYouKind>(NEEDS_YOU_KINDS),
  priority: list<NeedsYouPriority>(NEEDS_YOU_PRIORITIES),
  claimId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const resolveBody = z.object({
  optionId: z.string().min(1).max(64),
  edits: z.unknown().optional(),
  note: z.string().max(4000).optional(),
});

const snoozeBody = z
  .object({ until: isoDateTime.optional(), minutes: z.number().int().min(1).max(60 * 24 * 30).optional(), note: z.string().max(1000).optional() })
  .refine((b) => b.until !== undefined || b.minutes !== undefined, 'until or minutes is required');

export function registerNeedsYouRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/needs-you', async (request) => {
    const q = parse(listQuery, request.query);
    let status: NeedsYouStatus[] | 'all' | undefined;
    if (q.status === 'all') status = 'all';
    else if (q.status) {
      const parts = q.status.split(',').map((s) => s.trim());
      if (!parts.every((s) => (STATUSES as readonly string[]).includes(s))) throw badRequest(`status must be one of ${STATUSES.join(', ')} or all`);
      status = parts as NeedsYouStatus[];
    }
    const items = listNeedsYouItems(ctx, { status, kind: q.kind, priority: q.priority, claimId: q.claimId, limit: q.limit, offset: q.offset });
    return { items, count: needsYouCount(ctx) };
  });

  app.get('/needs-you/count', async () => needsYouCount(ctx));

  app.get('/needs-you/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    return getNeedsYouDetail(ctx, id);
  });

  app.post('/needs-you/:id/resolve', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(resolveBody, request.body);
    const item = await resolveNeedsYouItem(ctx, id, { optionId: body.optionId, ...(body.edits !== undefined ? { edits: body.edits } : {}), ...(body.note ? { note: body.note } : {}) }, request.actor);
    return { item, count: needsYouCount(ctx) };
  });

  app.post('/needs-you/:id/snooze', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(snoozeBody, request.body);
    const until = body.until ? new Date(Date.parse(body.until)).toISOString() : new Date(Date.parse(ctx.now()) + body.minutes! * 60_000).toISOString();
    const item = snoozeNeedsYouItem(ctx, id, until, request.actor, body.note);
    return { item, count: needsYouCount(ctx) };
  });
}
