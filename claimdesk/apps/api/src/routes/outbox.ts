// owned by mail
/**
 * Outbox routes (docs/SUPREME-DESIGN.md §D.3, §L.5, §N.6), people only:
 *
 *   GET  /outbox                 ?status=&claimId=  (held with countdown, awaiting approval, sent, failed …)
 *   GET  /outbox/:id             the email, its transitions, review and policy decision
 *   POST /outbox                 the owner's own email: 30-second Undo, no review unless checkBeforeSending
 *   POST /outbox/:id/approve     {edits?, note?} → queued now, approved_by = the owner
 *   POST /outbox/:id/undo        held / queued → cancelled (impossible once sending)
 *   POST /outbox/:id/send-now    skip the rest of the hold
 *   POST /outbox/:id/retry       failed → queued
 *   POST /outbox/:id/reject      {reason} → cancelled
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OutboxStateError } from '@ccguk/db';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { parse } from '../schemas/common.js';
import { params } from './helpers.js';
import { approveOutbox, describeOutbox, ownerCompose, parseOwnerEdits, rejectOutbox, retryOutbox, sendNowOutbox, undoOutbox } from '../mail/outbox.js';
import { outboxSummary } from './mail.js';

const STATUSES = ['draft', 'reviewing', 'awaiting_approval', 'held', 'queued', 'sending', 'sent', 'failed', 'cancelled'] as const;

const listQuery = z.object({ status: z.string().optional(), claimId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional() });
const address = z.string().trim().email().max(254);
const composeBody = z.object({
  claimId: z.string().min(1).optional(),
  kind: z.string().min(1).max(40).optional(),
  to: z.array(address).min(1).max(20),
  cc: z.array(address).max(20).optional(),
  bcc: z.array(address).max(20).optional(),
  subject: z.string().trim().min(1).max(250),
  bodyText: z.string().min(1).max(50_000),
  attach: z.array(z.object({ evidenceId: z.string().nullable().optional(), documentId: z.string().nullable().optional() })).max(20).optional(),
  inReplyToMessageId: z.string().nullable().optional(),
  checkBeforeSending: z.boolean().optional(),
});
const approveBody = z.object({ edits: z.object({ to: z.array(address).optional(), cc: z.array(address).optional(), subject: z.string().max(250).optional(), bodyText: z.string().max(50_000).optional() }).optional(), note: z.string().max(2000).optional() }).optional();
const rejectBody = z.object({ reason: z.string().trim().min(3).max(2000) });

/** Open Needs-you items about this email are answered by an action taken in the Outbox. */
function supersedeItems(ctx: AppContext, outboxId: string, actor: Actor, note: string): void {
  const keys = ['approve_send', 'missing_info', 'question'].map((k) => `${k}:outbox:${outboxId}`);
  const rows = ctx.handle.sqlite.prepare(`SELECT id FROM needs_you WHERE dedupe_key IN (${keys.map(() => '?').join(',')}) AND status IN ('open','snoozed')`).all(...keys) as Array<{ id: string }>;
  for (const r of rows) ctx.repos.transitionNeedsYou(ctx.db, r.id, { to: 'superseded', actor: actor.userId, note, now: ctx.now() });
}

function detail(ctx: AppContext, id: string) {
  const o = ctx.repos.getOutbox(ctx.db, id);
  if (!o) throw notFound('outbox', id);
  const review = o.reviewId ? ctx.repos.getReview(ctx.db, o.reviewId) : ctx.repos.latestReviewFor(ctx.db, { kind: 'outbox', id: o.id });
  const d = describeOutbox(ctx, o, review);
  return {
    item: outboxSummary(ctx, o),
    events: ctx.repos.listOutboxEvents(ctx.db, o.id),
    review: review ?? null,
    recipients: d.recipients,
    attachmentsCheck: d.attachments,
    now: ctx.now(),
  };
}

/** Map an outbox state conflict to 409 (it is a DbError, otherwise answered 400). */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof OutboxStateError) throw conflict('OUTBOX_STATE', err.message, { outboxId: err.outboxId, status: err.status });
    throw err;
  }
}

export function registerOutboxRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/outbox', async (request) => {
    const q = parse(listQuery, request.query);
    const status = q.status?.split(',').map((s) => s.trim()).filter(Boolean);
    if (status && !status.every((s) => (STATUSES as readonly string[]).includes(s))) throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
    const items = ctx.repos.listOutbox(ctx.db, { ...(q.claimId ? { claimId: q.claimId } : {}), ...(status?.length ? { status: status as (typeof STATUSES)[number][] } : {}), limit: q.limit ?? 200 });
    const counts: Record<string, number> = {};
    for (const s of STATUSES) counts[s] = ctx.repos.listOutbox(ctx.db, { status: s, limit: 100_000, ...(q.claimId ? { claimId: q.claimId } : {}) }).length;
    return { items: items.map((o) => outboxSummary(ctx, o)), counts, now: ctx.now() };
  });

  app.get('/outbox/:id', async (request) => detail(ctx, params<{ id: string }>(request).id));

  app.post('/outbox', async (request, reply) => {
    const body = parse(composeBody, request.body);
    const o = guard(() =>
      ownerCompose(
        ctx,
        {
          to: body.to,
          subject: body.subject,
          bodyText: body.bodyText,
          ...(body.claimId ? { claimId: body.claimId } : {}),
          ...(body.kind ? { kind: body.kind } : {}),
          ...(body.cc ? { cc: body.cc } : {}),
          ...(body.bcc ? { bcc: body.bcc } : {}),
          ...(body.attach ? { attach: body.attach } : {}),
          ...(body.inReplyToMessageId ? { inReplyToMessageId: body.inReplyToMessageId } : {}),
          ...(body.checkBeforeSending ? { checkBeforeSending: true } : {}),
        },
        request.actor,
      ),
    );
    return reply.status(201).send(detail(ctx, o.id));
  });

  app.post('/outbox/:id/approve', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(approveBody, request.body ?? {});
    guard(() => approveOutbox(ctx, id, request.actor, parseOwnerEdits(body?.edits), body?.note));
    supersedeItems(ctx, id, request.actor, 'approved in the Outbox');
    return detail(ctx, id);
  });

  app.post('/outbox/:id/undo', async (request) => {
    const { id } = params<{ id: string }>(request);
    guard(() => undoOutbox(ctx, id, request.actor));
    supersedeItems(ctx, id, request.actor, 'undone in the Outbox');
    return detail(ctx, id);
  });

  app.post('/outbox/:id/send-now', async (request) => {
    const { id } = params<{ id: string }>(request);
    guard(() => sendNowOutbox(ctx, id, request.actor));
    supersedeItems(ctx, id, request.actor, 'sent from the Outbox');
    return detail(ctx, id);
  });

  app.post('/outbox/:id/retry', async (request) => {
    const { id } = params<{ id: string }>(request);
    guard(() => retryOutbox(ctx, id, request.actor));
    return detail(ctx, id);
  });

  app.post('/outbox/:id/reject', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(rejectBody, request.body);
    guard(() => rejectOutbox(ctx, id, request.actor, body.reason));
    supersedeItems(ctx, id, request.actor, `rejected in the Outbox: ${body.reason}`);
    return detail(ctx, id);
  });
}
