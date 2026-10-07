// owned by runtime
/**
 * Needs-you services (docs/SUPREME-DESIGN.md §C.7, §D.4): list / detail / resolve / snooze. Insertion is the
 * foundation's `createNeedsYou` (core.ts).
 *
 * Resolving runs the resolver registered for the item's kind (agent/handlers/index.ts) AS THE SIGNED-IN OWNER — the
 * actor of the request — so human-only checks pass and the audit shows the owner. Edits made before approval are
 * offered to casework as memory corrections through `ctx.services.recordCorrection` (registered by casework; this
 * module never imports it). A job waiting for the owner (`resumes_job_id`, or `waiting_user` on this item) is
 * re-queued.
 */
import type { Actor, NeedsYouEventRecord, NeedsYouRecord } from '@ccguk/db';
import type { ISODateTime, NeedsYouKind, NeedsYouPriority, NeedsYouStatus } from '@ccguk/domain';
import { NEEDS_YOU_KINDS } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { HttpError, badRequest, conflict, notFound } from '../errors.js';
import { getNeedsYouResolver } from './handlers/index.js';

export interface NeedsYouChoice {
  optionId: string;
  edits?: unknown;
  note?: string;
}

/** The correction callback casework registers on `ctx.services` (§E.6). */
export interface CorrectionInput {
  needsYouId: string;
  kind: NeedsYouKind;
  claimId?: string;
  optionId: string;
  before: unknown;
  after: unknown;
  note?: string;
  actor: Actor;
}
export type RecordCorrection = (ctx: AppContext, input: CorrectionInput) => unknown;

/** Late-bound services the runtime reads (declared loosely in context.ts; typed here). */
export interface RuntimeServices {
  supervisor?: unknown;
  recordCorrection?: RecordCorrection;
}
export const runtimeServices = (ctx: AppContext): RuntimeServices => ctx.services as RuntimeServices;

export interface ListNeedsYouQuery {
  status?: NeedsYouStatus | NeedsYouStatus[] | 'all';
  kind?: NeedsYouKind | NeedsYouKind[];
  priority?: NeedsYouPriority | NeedsYouPriority[];
  claimId?: string;
  limit?: number;
  offset?: number;
}

export interface NeedsYouListItem extends NeedsYouRecord {
  claimReference?: string;
}

function withReference(ctx: AppContext, items: NeedsYouRecord[]): NeedsYouListItem[] {
  const refs = new Map<string, string | undefined>();
  return items.map((i) => {
    if (!i.claimId) return i;
    if (!refs.has(i.claimId)) refs.set(i.claimId, ctx.repos.getClaim(ctx.db, i.claimId)?.reference);
    const ref = refs.get(i.claimId);
    return ref ? { ...i, claimReference: ref } : i;
  });
}

export function listNeedsYouItems(ctx: AppContext, q: ListNeedsYouQuery = {}): NeedsYouListItem[] {
  const status = q.status === 'all' ? undefined : (q.status ?? 'open');
  return withReference(ctx, ctx.repos.listNeedsYou(ctx.db, { status, kind: q.kind, priority: q.priority, claimId: q.claimId, limit: q.limit, offset: q.offset }));
}

export interface NeedsYouCountView {
  total: number;
  urgent: number;
  byPriority: Record<NeedsYouPriority, number>;
  snoozed: number;
}

export function needsYouCount(ctx: AppContext): NeedsYouCountView {
  const open = ctx.repos.countNeedsYou(ctx.db, { status: 'open' });
  const snoozed = ctx.repos.countNeedsYou(ctx.db, { status: 'snoozed' }).total;
  return { total: open.total, urgent: open.byPriority.urgent, byPriority: open.byPriority, snoozed };
}

export interface NeedsYouDetail {
  item: NeedsYouListItem;
  events: NeedsYouEventRecord[];
  /** A resolver is registered for this kind (otherwise the generic resolve still records the owner's choice). */
  resolverRegistered: boolean;
  /** The job that resumes when this item is resolved. */
  resumesJob?: { id: string; type: string; status: string };
}

export function getNeedsYouDetail(ctx: AppContext, id: string): NeedsYouDetail {
  const item = ctx.repos.getNeedsYouItem(ctx.db, id);
  if (!item) throw notFound('needs_you', id);
  const job = item.resumesJobId ? ctx.repos.getAgentJob(ctx.db, item.resumesJobId) : undefined;
  return {
    item: withReference(ctx, [item])[0]!,
    events: ctx.repos.listNeedsYouEvents(ctx.db, id),
    resolverRegistered: Boolean(getNeedsYouResolver(item.kind)),
    ...(job ? { resumesJob: { id: job.id, type: job.type, status: job.status } } : {}),
  };
}

/** Is `kind` a Needs-you kind? */
export const isNeedsYouKind = (k: unknown): k is NeedsYouKind => typeof k === 'string' && (NEEDS_YOU_KINDS as readonly string[]).includes(k);

/** Jobs to re-queue when `item` is resolved. */
function jobsToResume(ctx: AppContext, item: NeedsYouRecord): string[] {
  const ids = new Set<string>();
  if (item.resumesJobId) ids.add(item.resumesJobId);
  const rows = ctx.handle.sqlite.prepare(`SELECT id FROM agent_jobs WHERE needs_you_id = ? AND status = 'waiting_user'`).all(item.id) as Array<{ id: string }>;
  for (const r of rows) ids.add(r.id);
  return [...ids];
}

/**
 * Resolve an item as the owner. Validation → resolver (kind-specific effect, as `actor`) → correction proposal (edits)
 * → status `resolved` + `needs_you_events` → audit `needs_you.resolve` → resume the waiting job. A resolver error
 * leaves the item open and is returned to the caller.
 */
export async function resolveNeedsYouItem(ctx: AppContext, id: string, choice: NeedsYouChoice, actor: Actor): Promise<NeedsYouRecord> {
  const item = ctx.repos.getNeedsYouItem(ctx.db, id);
  if (!item) throw notFound('needs_you', id);
  if (item.status !== 'open' && item.status !== 'snoozed') throw conflict('NEEDS_YOU_CLOSED', `This item is already ${item.status}.`);
  if (actor.userId === 'system' || actor.userId.startsWith('agent:')) throw new HttpError(403, 'HUMAN_REQUIRED', 'Only a signed-in person can resolve a Needs-you item.');
  const optionId = String(choice.optionId ?? '').trim();
  if (!optionId) throw badRequest('optionId is required');
  const option = item.options.find((o) => o.id === optionId);
  if (item.options.length && !option) throw badRequest(`Unknown option "${optionId}" — choose one of: ${item.options.map((o) => o.id).join(', ')}`);
  if (option?.requiresReason && !choice.note?.trim()) throw badRequest(`"${option.label}" needs a reason`);
  if (option?.requiresEdit && choice.edits === undefined) throw badRequest(`"${option.label}" needs your edits`);

  const resolver = getNeedsYouResolver(item.kind);
  if (resolver) await resolver.resolve(ctx, item, { optionId, ...(choice.edits !== undefined ? { edits: choice.edits } : {}), ...(choice.note ? { note: choice.note } : {}) }, actor);

  const now = ctx.now();
  let correctionRecorded = false;
  if (choice.edits !== undefined) {
    const record = runtimeServices(ctx).recordCorrection;
    if (record) {
      try {
        record(ctx, { needsYouId: id, kind: item.kind, ...(item.claimId ? { claimId: item.claimId } : {}), optionId, before: item.payload, after: choice.edits, ...(choice.note ? { note: choice.note } : {}), actor });
        correctionRecorded = true;
      } catch (err) {
        ctx.logger.warn('correction proposal not recorded', { needsYouId: id, error: String(err) });
      }
    }
  }
  const resumed = jobsToResume(ctx, item);
  const resolved = ctx.db.transaction(() => {
    const r = ctx.repos.resolveNeedsYou(ctx.db, id, {
      actor: actor.userId,
      optionId,
      note: choice.note,
      resolution: { optionId, note: choice.note ?? null, edited: choice.edits !== undefined, ...(choice.edits !== undefined ? { edits: choice.edits } : {}) },
      now,
    });
    ctx.repos.appendAudit(ctx.db, {
      actor,
      action: 'needs_you.resolve',
      entity: 'needs_you',
      entityId: id,
      before: { status: item.status },
      after: { needsYouId: id, kind: item.kind, claimId: item.claimId ?? null, optionId, note: choice.note ?? null, edited: choice.edits !== undefined, correctionRecorded, resumedJobs: resumed },
      at: now,
    });
    for (const jobId of resumed) ctx.repos.resumeAgentJob(ctx.db, jobId, { now });
    return r;
  });
  return resolved;
}

/** Snooze until `until` (the supervisor wakes it). */
export function snoozeNeedsYouItem(ctx: AppContext, id: string, until: ISODateTime, actor: Actor, note?: string): NeedsYouRecord {
  const item = ctx.repos.getNeedsYouItem(ctx.db, id);
  if (!item) throw notFound('needs_you', id);
  if (item.status !== 'open' && item.status !== 'snoozed') throw conflict('NEEDS_YOU_CLOSED', `This item is already ${item.status}.`);
  const now = ctx.now();
  if (!(Date.parse(until) > Date.parse(now))) throw badRequest('Snooze until a time in the future');
  return ctx.db.transaction(() => {
    // snoozed → snoozed is not a transition; wake first so a re-snooze is recorded.
    if (item.status === 'snoozed') ctx.repos.transitionNeedsYou(ctx.db, id, { to: 'open', actor: actor.userId, note: 're-snoozed', now });
    const r = ctx.repos.snoozeNeedsYou(ctx.db, id, { until, actor: actor.userId, note, now });
    ctx.repos.appendAudit(ctx.db, { actor, action: 'needs_you.snooze', entity: 'needs_you', entityId: id, after: { needsYouId: id, until, note: note ?? null }, at: now });
    return r;
  });
}
