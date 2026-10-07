// owned by runtime
/**
 * Claim tasks (docs/SUPREME-DESIGN.md §C.2 task.due, §N.6):
 *   GET  /tasks?claimId=&status=&dueBefore=
 *   POST /tasks/:id/complete | cancel | reschedule {dueAt}     audited as the signed-in person
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TaskStatus } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { isoDateTime, parse } from '../schemas/common.js';
import { params } from './helpers.js';

const listQuery = z.object({
  claimId: z.string().optional(),
  status: z.enum(['open', 'done', 'cancelled', 'all']).optional(),
  dueBefore: isoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
const rescheduleBody = z.object({ dueAt: isoDateTime });

export function registerTasksRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/tasks', async (request) => {
    const q = parse(listQuery, request.query);
    const status: TaskStatus | undefined = q.status === 'all' ? undefined : (q.status ?? 'open');
    const items = ctx.repos.listTasks(ctx.db, { claimId: q.claimId, status, dueBefore: q.dueBefore ? new Date(Date.parse(q.dueBefore)).toISOString() : undefined, limit: q.limit, offset: q.offset });
    const refs = new Map<string, string | undefined>();
    return {
      items: items.map((t) => {
        if (!refs.has(t.claimId)) refs.set(t.claimId, ctx.repos.getClaim(ctx.db, t.claimId)?.reference);
        return { ...t, claimReference: refs.get(t.claimId) ?? null };
      }),
    };
  });

  for (const action of ['complete', 'cancel'] as const) {
    app.post(`/tasks/:id/${action}`, async (request) => {
      const { id } = params<{ id: string }>(request);
      const before = ctx.repos.getTask(ctx.db, id);
      if (!before) throw notFound('tasks', id);
      const now = ctx.now();
      const task = action === 'complete' ? ctx.repos.completeTask(ctx.db, id, request.actor, now) : ctx.repos.cancelTask(ctx.db, id, request.actor, now);
      ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: `task.${action}`, entity: 'tasks', entityId: id, before: { status: before.status }, after: { status: task.status, claimId: task.claimId }, at: now });
      return task;
    });
  }

  app.post('/tasks/:id/reschedule', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(rescheduleBody, request.body);
    const before = ctx.repos.getTask(ctx.db, id);
    if (!before) throw notFound('tasks', id);
    const dueAt = new Date(Date.parse(body.dueAt)).toISOString();
    const task = ctx.repos.rescheduleTask(ctx.db, id, dueAt);
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'task.reschedule', entity: 'tasks', entityId: id, before: { dueAt: before.dueAt }, after: { dueAt, claimId: task.claimId }, at: ctx.now() });
    return task;
  });
}
