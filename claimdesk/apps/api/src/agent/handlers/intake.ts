// owned by intake
/**
 * intake job handlers and Needs-you resolvers (docs/SUPREME-DESIGN.md §C.2, §C.7, §G). Registered by
 * agent/handlers/index.ts (foundation). The work itself is in apps/api/src/intake/pipeline.ts.
 *
 *   intake.process  cpu, deterministic   payload {itemId} — or, from the mail slice, {evidenceId, claimId, source:'email'}
 *   intake.extract  ai                   payload {itemId}
 *   intake.apply    io, deterministic    payload {itemId, extractionId?}
 *
 * Resolvers (run AS THE OWNER):
 *   confirm_fields  apply the ticked proposals through the routes as the owner; the rest are rejected with the reason
 *   new_claim       prepare a new-claim draft (the owner opens it in the wizard), attach the item to a claim, or dismiss
 */
import { z } from 'zod';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import type { JobHandler, NeedsYouItem, NeedsYouResolver } from '../contracts.js';
import { enqueueJob } from '../core.js';
import { conflict, badRequest } from '../../errors.js';
import { applyProposals, ownerApplier, rejectProposals } from '../../intake/apply.js';
import { itemForEvidence } from '../../intake/items.js';
import { buildNewClaimDraft } from '../../intake/newClaimDraft.js';
import type { NormalisedDoc } from '../../intake/normalise.js';
import { applyItem, extractItem, processItem, settleItemStatus, type ConfirmCardPayload, type NewClaimPayload } from '../../intake/pipeline.js';

const processPayload = z.union([
  z.object({ itemId: z.string().min(1) }).passthrough(),
  z.object({ evidenceId: z.string().min(1), claimId: z.string().min(1).nullable().optional(), source: z.enum(['upload', 'email', 'folder', 'capture']).default('email') }).passthrough(),
]);
type ProcessPayload = z.infer<typeof processPayload>;

const itemPayload = z.object({ itemId: z.string().min(1) }).passthrough();
const applyPayload = z.object({ itemId: z.string().min(1), extractionId: z.string().min(1).optional() }).passthrough();

const processHandler: JobHandler<ProcessPayload> = {
  type: 'intake.process',
  agent: 'intake',
  lane: 'cpu',
  usesAi: false,
  mutatesClaim: false,
  payload: processPayload,
  defaultPriority: 3,
  maxAttempts: 3,
  timeoutMs: 5 * 60_000,
  async run({ ctx, job, payload }) {
    let item;
    if ('itemId' in payload && typeof payload.itemId === 'string') {
      item = ctx.repos.getIntakeItem(ctx.db, payload.itemId);
      if (!item) return { kind: 'fail', reason: `intake item ${payload.itemId} not found` };
    } else {
      const p = payload as { evidenceId: string; claimId?: string | null; source: 'upload' | 'email' | 'folder' | 'capture' };
      if (!ctx.repos.getEvidence(ctx.db, p.evidenceId)) return { kind: 'fail', reason: `evidence ${p.evidenceId} not found` };
      item = itemForEvidence(ctx, { evidenceId: p.evidenceId, claimId: p.claimId ?? job.claimId ?? null, source: p.source, createdBy: job.createdBy || 'agent:mail' });
    }
    return processItem(ctx, item, job);
  },
};

const extractHandler: JobHandler<z.infer<typeof itemPayload>> = {
  type: 'intake.extract',
  agent: 'intake',
  lane: 'ai',
  usesAi: true,
  mutatesClaim: false,
  payload: itemPayload,
  defaultPriority: 3,
  maxAttempts: 3,
  timeoutMs: 6 * 60_000,
  async run({ ctx, job, payload }) {
    const item = ctx.repos.getIntakeItem(ctx.db, payload.itemId);
    if (!item) return { kind: 'fail', reason: `intake item ${payload.itemId} not found` };
    return extractItem(ctx, item, job);
  },
};

const applyHandler: JobHandler<z.infer<typeof applyPayload>> = {
  type: 'intake.apply',
  agent: 'intake',
  lane: 'io',
  usesAi: false,
  mutatesClaim: true,
  payload: applyPayload,
  defaultPriority: 3,
  maxAttempts: 3,
  timeoutMs: 5 * 60_000,
  async run({ ctx, job, payload }) {
    const item = ctx.repos.getIntakeItem(ctx.db, payload.itemId);
    if (!item) return { kind: 'fail', reason: `intake item ${payload.itemId} not found` };
    return applyItem(ctx, item, job, payload.extractionId);
  },
};

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

const confirmEdits = z
  .object({
    /** Proposal ids to apply (default: all of the card's pending proposals). */
    apply: z.array(z.string().min(1)).optional(),
    /** The owner's corrected value per proposal id. */
    values: z.record(z.string()).optional(),
  })
  .passthrough();

/** Apply the confirmed proposals of a card as the owner; reject the rest with the owner's reason. */
export async function resolveConfirmFields(ctx: AppContext, item: NeedsYouItem & { payload: ConfirmCardPayload }, choice: { optionId: string; edits?: unknown; note?: string }, actor: Actor): Promise<void> {
  const payload = item.payload;
  if (!payload?.itemId) throw badRequest('This card has no intake item');
  const listed = new Set(payload.proposals.map((p) => p.id));
  const pending = ctx.repos.listClaimUpdateProposals(ctx.db, { intakeItemId: payload.itemId, status: 'pending' }).filter((p) => listed.has(p.id) || p.policyDecision !== 'never');
  if (choice.optionId === 'reject') {
    rejectProposals(ctx, pending.map((p) => p.id), actor, choice.note?.trim() || 'Rejected by the owner');
    settleItemStatus(ctx, payload.itemId);
    return;
  }
  if (choice.optionId !== 'apply') throw badRequest(`Unknown option ${choice.optionId}`);
  const parsed = choice.edits === undefined ? {} : confirmEdits.parse(choice.edits);
  const wanted = new Set(parsed.apply ?? pending.map((p) => p.id));
  for (const id of wanted) if (!pending.some((p) => p.id === id)) throw conflict('PROPOSAL_NOT_PENDING', `Proposal ${id} is not waiting on this card`);
  const toApply = pending.filter((p) => wanted.has(p.id));
  const results = await applyProposals(ctx, toApply, ownerApplier(ctx, actor), { ...(parsed.values ? { values: parsed.values } : {}), note: `confirmed by the owner (Needs-you ${item.id})` });
  const failed = results.filter((r) => !r.ok);
  const rest = pending.filter((p) => !wanted.has(p.id)).map((p) => p.id);
  if (rest.length) rejectProposals(ctx, rest, actor, choice.note?.trim() || 'Not ticked by the owner');
  settleItemStatus(ctx, payload.itemId);
  if (failed.length) {
    throw conflict('APPLY_FAILED', `${results.length - failed.length} applied; ${failed.length} could not be applied: ${failed.map((f) => `${f.error?.code}: ${f.error?.message}`).join('; ')}`, { failed });
  }
}

const attachEdits = z.object({ claimId: z.string().min(1) }).passthrough();

export async function resolveNewClaim(ctx: AppContext, item: NeedsYouItem & { payload: NewClaimPayload }, choice: { optionId: string; edits?: unknown; note?: string }, actor: Actor): Promise<void> {
  const payload = item.payload;
  const intakeItem = ctx.repos.getIntakeItem(ctx.db, payload.itemId);
  if (!intakeItem) throw badRequest('The intake item of this card no longer exists');
  const now = ctx.now();
  if (choice.optionId === 'start') {
    const children = ctx.repos.listIntakeItems(ctx.db, { parentItemId: intakeItem.id }).map((c) => c.id);
    const draft = buildNewClaimDraft(ctx, [intakeItem.id, ...children], actor.userId);
    ctx.repos.updateIntakeItem(ctx.db, intakeItem.id, { status: 'proposed', normalised: { ...((intakeItem.normalised ?? {}) as NormalisedDoc), newClaimDraftId: draft.id } }, now);
    ctx.repos.appendAudit(ctx.db, { actor, action: 'intake.new_claim_draft', entity: 'intake_items', entityId: intakeItem.id, after: { draftId: draft.id, itemIds: draft.itemIds, needsYouId: item.id }, at: now });
    return;
  }
  if (choice.optionId === 'attach') {
    const { claimId } = attachEdits.parse(choice.edits ?? {});
    attachItemToClaim(ctx, intakeItem.id, claimId, actor);
    return;
  }
  if (choice.optionId === 'dismiss') {
    ctx.repos.updateIntakeItem(ctx.db, intakeItem.id, { status: 'proposed' }, now);
    return;
  }
  throw badRequest(`Unknown option ${choice.optionId}`);
}

/** Link an item (and its children) to a claim and queue `intake.apply` again. Audited as the actor. */
export function attachItemToClaim(ctx: AppContext, itemId: string, claimId: string, actor: Actor): void {
  const claim = ctx.repos.requireClaim(ctx.db, claimId);
  const now = ctx.now();
  const items = [ctx.repos.requireIntakeItem(ctx.db, itemId), ...ctx.repos.listIntakeItems(ctx.db, { parentItemId: itemId })];
  for (const it of items) {
    if (it.claimId && it.claimId !== claim.id) throw conflict('INTAKE_ON_ANOTHER_CLAIM', `This item is already on another claim`);
    ctx.repos.updateIntakeItem(ctx.db, it.id, { claimId: claim.id }, now);
    ctx.repos.appendAudit(ctx.db, { actor, action: 'intake.attach_claim', entity: 'intake_items', entityId: it.id, after: { claimId: claim.id, claimRef: claim.reference }, at: now });
    if (it.status === 'proposed' || it.status === 'needs_you' || it.status === 'applied') {
      enqueueJob(ctx, { type: 'intake.apply', payload: { itemId: it.id }, claimId: claim.id, idempotencyKey: `intake.apply:${it.id}:claim:${claim.id}`, createdBy: actor.userId });
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each handler has its own payload/result types
export const intakeJobHandlers: JobHandler<any, any>[] = [processHandler, extractHandler, applyHandler];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each resolver has its own payload type
export const intakeNeedsYouResolvers: NeedsYouResolver<any>[] = [
  { kind: 'confirm_fields', resolve: resolveConfirmFields } satisfies NeedsYouResolver<ConfirmCardPayload>,
  { kind: 'new_claim', resolve: resolveNewClaim } satisfies NeedsYouResolver<NewClaimPayload>,
];
