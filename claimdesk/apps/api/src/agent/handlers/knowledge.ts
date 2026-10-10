// owned by knowledge-core
/**
 * Knowledge Builder core jobs and the `knowledge_review` resolver (docs/SUPREME-KNOWLEDGE-BUILDER.md §4.6, §9.3, §10.1).
 *
 *   knowledge.publish   cpu · supervisor · priority 5 — publish the learned pack when its member set changed
 *                       (debounced after approvals / auto-applies, and nightly 02:30). With learning paused only an
 *                       owner-triggered publish runs (§12.3).
 *
 * Resolver `knowledge_review` (runs as the signed-in owner):
 *   items    → approve | approve_source_verified | edit_approve (edits: {itemId?, title, body, data, scope}) | reject
 *   conflict → keep_left | keep_right | keep_both | retire_both
 *   alarm    → rollback (core activates the suggested version) | acknowledge — then `onReviewResolved` (knowledge-use)
 *   gap      → answer | dismiss — `onReviewResolved` (knowledge-research)
 */
import { z } from 'zod';
import type { KnowledgeData, KnowledgeItem, KnowledgeReviewPayload, KnowledgeScope } from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import type { JobHandler, NeedsYouItem, NeedsYouResolver } from '../contracts.js';
import { HttpError, badRequest, conflict } from '../../errors.js';
import { isAutomatedActor } from '../../services/humanOnly.js';
import { knowledgeHandler, learningOff } from '../../knowledge/jobs.js';
import { activateVersion, publishLearnedPack } from '../../knowledge/publish.js';
import { approveKnowledge, assertReplayDone, editApproveKnowledge, rejectKnowledge, resolveConflict, type ConflictKeep } from '../../knowledge/store.js';
import { knowledgeHooks } from '../../knowledge/hooks.js';

const SUPERVISOR: Actor = { userId: 'agent:supervisor' };

export const publishPayload = z.object({ reason: z.string().max(500).optional(), nightly: z.boolean().optional() }).passthrough();
type PublishPayload = z.infer<typeof publishPayload>;

export const knowledgePublishHandler = knowledgeHandler<PublishPayload, { result: 'published' | 'unchanged' | 'learning_off'; version: number | null; items: number }>(
  'knowledge.publish',
  publishPayload,
  async ({ ctx, job, payload }) => {
    const ownerTriggered = !isAutomatedActor({ userId: job.createdBy });
    if (learningOff(ctx) && !ownerTriggered) return { kind: 'done', result: { result: 'learning_off', version: null, items: 0 } };
    const actor: Actor = ownerTriggered ? { userId: job.createdBy } : SUPERVISOR;
    const r = publishLearnedPack(ctx, { reason: payload.reason ?? (payload.nightly ? 'nightly publish' : 'publish'), actor });
    return { kind: 'done', result: { result: r.published ? 'published' : 'unchanged', version: r.version, items: r.itemCount } };
  },
  { timeoutMs: 2 * 60_000 },
);

// ---------------------------------------------------------------------------
// knowledge_review resolver
// ---------------------------------------------------------------------------

const scopeSchema = z.union([
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('insurer'), slug: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('claim_type'), tag: z.string().min(1).max(64) }).strict(),
]);
const editSchema = z
  .object({
    itemId: z.string().min(1).max(64).optional(),
    title: z.string().min(1).max(200),
    body: z.string().max(6000),
    data: z.record(z.unknown()),
    scope: scopeSchema,
  })
  .strict();

/** The proposed items a card covers: its listed ids plus any queued item that joined the card later. */
function pendingItemsOf(ctx: AppContext, card: NeedsYouItem, payload: Extract<KnowledgeReviewPayload, { variant: 'items' }>): KnowledgeItem[] {
  const joined = ctx.repos.listKnowledgeItems(ctx.db, { needsYouId: card.id, status: 'proposed', limit: 500 }).items.map((i) => i.id);
  const ids = [...new Set([...payload.itemIds, ...joined])];
  return ctx.repos.getKnowledgeItems(ctx.db, ids).filter((i) => i.status === 'proposed');
}

const firstSnapshot = (i: KnowledgeItem): { snapshotId: string; url: string } | null => {
  const s = i.provenance.find((p) => p.kind === 'snapshot');
  return s && s.kind === 'snapshot' ? { snapshotId: s.snapshotId, url: s.url } : null;
};

async function resolveItems(ctx: AppContext, card: NeedsYouItem, payload: Extract<KnowledgeReviewPayload, { variant: 'items' }>, choice: { optionId: string; edits?: unknown; note?: string }, actor: Actor): Promise<void> {
  const items = pendingItemsOf(ctx, card, payload);
  const note = choice.note?.trim() || null;
  // §12.1: every rule on the card must have its replay verdict before any item is approved (all or nothing).
  if (choice.optionId === 'approve' || choice.optionId === 'approve_source_verified') for (const i of items) assertReplayDone(ctx, i);
  switch (choice.optionId) {
    case 'approve':
      for (const i of items) approveKnowledge(ctx, i.id, { note, needsYouId: card.id }, actor);
      return;
    case 'approve_source_verified': {
      const unmatched = items.filter((i) => {
        const snaps = i.provenance.filter((p) => p.kind === 'snapshot');
        return !snaps.length || !snaps.every((p) => p.kind === 'snapshot' && p.quoteMatch === 'exact');
      });
      if (unmatched.length) throw conflict('QUOTES_NOT_MATCHED', 'Approve as source-verified needs every quote found exactly in the stored copy', { itemIds: unmatched.map((i) => i.id) });
      for (const i of items) {
        const s = firstSnapshot(i)!;
        approveKnowledge(ctx, i.id, { note, verification: 'source_verified', snapshotId: s.snapshotId, sourceUrl: s.url, needsYouId: card.id }, actor);
      }
      return;
    }
    case 'edit_approve': {
      const parsed = editSchema.safeParse(choice.edits);
      if (!parsed.success) throw badRequest('Edit then approve needs the edited title, body, data and scope', parsed.error.issues);
      const target = parsed.data.itemId ?? (items.length === 1 ? items[0]!.id : undefined);
      if (!target || !items.some((i) => i.id === target)) throw badRequest('Say which item you edited (itemId)');
      editApproveKnowledge(ctx, target, { title: parsed.data.title, body: parsed.data.body, data: parsed.data.data as unknown as KnowledgeData, scope: parsed.data.scope as KnowledgeScope, note, needsYouId: card.id }, actor);
      return;
    }
    case 'reject':
      if (!note) throw badRequest('Give a reason for rejecting');
      for (const i of items) rejectKnowledge(ctx, i.id, note, actor, { needsYouId: card.id });
      return;
    default:
      throw badRequest(`Unknown option ${choice.optionId} for a knowledge review`);
  }
}

const CONFLICT_CHOICES: Record<string, ConflictKeep> = { keep_left: 'left', keep_right: 'right', keep_both: 'both', retire_both: 'retire_both' };

export const knowledgeReviewResolver: NeedsYouResolver<KnowledgeReviewPayload> = {
  kind: 'knowledge_review',
  async resolve(ctx, item, choice, actor) {
    const payload = item.payload;
    switch (payload?.variant) {
      case 'items':
        return resolveItems(ctx, item, payload, choice, actor);
      case 'conflict': {
        const keep = CONFLICT_CHOICES[choice.optionId];
        if (!keep) throw badRequest(`Unknown option ${choice.optionId} for a knowledge conflict`);
        resolveConflict(ctx, payload.conflictId, keep, choice.note?.trim() || null, actor);
        return;
      }
      case 'alarm': {
        if (choice.optionId !== 'rollback' && choice.optionId !== 'acknowledge') throw badRequest(`Unknown option ${choice.optionId} for a knowledge alarm`);
        if (choice.optionId === 'rollback') {
          if (payload.suggestedRollbackTo === null) throw badRequest('This alarm has no version to roll back to');
          activateVersion(ctx, payload.suggestedRollbackTo, choice.note?.trim() || `rollback after alarm ${payload.alarmId}`, actor);
        }
        const hook = knowledgeHooks(ctx).onReviewResolved;
        if (hook) await hook(ctx, payload, choice.optionId, actor, { ...(choice.edits !== undefined ? { edits: choice.edits } : {}), ...(choice.note ? { note: choice.note } : {}), needsYouId: item.id });
        return;
      }
      case 'gap': {
        const hook = knowledgeHooks(ctx).onReviewResolved;
        if (!hook) throw new HttpError(409, 'KNOWLEDGE_RESEARCH_NOT_READY', 'Gap research is not built yet; answer it from Knowledge ▸ Gaps once it is');
        await hook(ctx, payload, choice.optionId, actor, { ...(choice.edits !== undefined ? { edits: choice.edits } : {}), ...(choice.note ? { note: choice.note } : {}), needsYouId: item.id });
        return;
      }
      default:
        throw badRequest('This knowledge card has no recognised payload');
    }
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const knowledgeJobHandlers: JobHandler<any, any>[] = [knowledgePublishHandler];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const knowledgeNeedsYouResolvers: NeedsYouResolver<any>[] = [knowledgeReviewResolver];
