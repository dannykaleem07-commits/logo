// owned by intake
/**
 * intake job handlers and Needs-you resolvers (docs/SUPREME-DESIGN.md §C.2, §C.7, §G). Registered by
 * agent/handlers/index.ts (foundation). The work itself is in apps/api/src/intake/pipeline.ts.
 *
 *   intake.process  cpu, deterministic   payload {itemId} — or, from the mail slice, {evidenceId, claimId, source:'email'}
 *   intake.extract  ai                   payload {itemId}
 *   intake.apply    io, deterministic    payload {itemId, extractionId?}
 *   intake.split             cpu, deterministic  payload {itemId, segments, source}   (smart intake §5.4)
 *   intake.bundle_reconcile  cpu, deterministic  payload {bundleId, revision}          (smart intake §6.1)
 *   intake.bundle_reason     ai                  payload {bundleId, fileset, owner?}   (smart intake §6.2)
 *   intake.bundle_register   io, mutates         payload {bundleId, revision}          (smart intake §6.7, auto only)
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
import { splitItem } from '../../intake/split.js';
import { attachBundle } from '../../intake/bundles/attach.js';
import { autoRegisterJob, reasonJob, reconcileJob } from '../../intake/bundles/jobs.js';
import { registerBundle } from '../../intake/bundles/register.js';
import { cancelBundle } from '../../intake/bundles/service.js';

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
// Smart intake (docs/SMART-INTAKE.md §7.1)
// ---------------------------------------------------------------------------

const splitPayload = z
  .object({
    itemId: z.string().min(1),
    segments: z.array(z.object({ fromPage: z.number().int().min(1), toPage: z.number().int().min(1), docType: z.string(), confidence: z.number(), title: z.string().optional() }).passthrough()).min(2),
    source: z.enum(['rules', 'ai']),
  })
  .passthrough();
const bundleRevisionPayload = z.object({ bundleId: z.string().min(1), revision: z.number().int().min(0) }).passthrough();
const reasonPayload = z.object({ bundleId: z.string().min(1), fileset: z.string(), owner: z.boolean().optional() }).passthrough();

const splitHandler: JobHandler<z.infer<typeof splitPayload>> = {
  type: 'intake.split',
  agent: 'intake',
  lane: 'cpu',
  usesAi: false,
  mutatesClaim: false,
  payload: splitPayload,
  defaultPriority: 3,
  maxAttempts: 3,
  timeoutMs: 5 * 60_000,
  async run({ ctx, job, payload }) {
    const item = ctx.repos.getIntakeItem(ctx.db, payload.itemId);
    if (!item) return { kind: 'fail', reason: `intake item ${payload.itemId} not found` };
    return splitItem(ctx, item, job, payload.segments as never, payload.source);
  },
};

const bundleReconcileHandler: JobHandler<z.infer<typeof bundleRevisionPayload>> = {
  type: 'intake.bundle_reconcile',
  agent: 'intake',
  lane: 'cpu',
  usesAi: false,
  mutatesClaim: false,
  payload: bundleRevisionPayload,
  defaultPriority: 3,
  maxAttempts: 3,
  timeoutMs: 5 * 60_000,
  async run({ ctx, payload }) {
    return reconcileJob(ctx, payload);
  },
};

const bundleReasonHandler: JobHandler<z.infer<typeof reasonPayload>> = {
  type: 'intake.bundle_reason',
  agent: 'intake',
  lane: 'ai',
  usesAi: true,
  mutatesClaim: false,
  payload: reasonPayload,
  defaultPriority: 3,
  maxAttempts: 3,
  timeoutMs: 8 * 60_000,
  async run({ ctx, job, payload }) {
    return reasonJob(ctx, job, payload);
  },
};

const bundleRegisterHandler: JobHandler<z.infer<typeof bundleRevisionPayload>> = {
  type: 'intake.bundle_register',
  agent: 'intake',
  lane: 'io',
  usesAi: false,
  mutatesClaim: true,
  payload: bundleRevisionPayload,
  defaultPriority: 2,
  maxAttempts: 2,
  timeoutMs: 5 * 60_000,
  async run({ ctx, job, payload }) {
    return autoRegisterJob(ctx, job, payload);
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
export async function resolveConfirmFields(ctx: AppContext, item: NeedsYouItem & { payload: ConfirmCardPayload & { bundleId?: string } }, choice: { optionId: string; edits?: unknown; note?: string }, actor: Actor): Promise<void> {
  const payload = item.payload;
  if (!payload?.itemId && !payload?.bundleId) throw badRequest('This card has no intake item');
  const listed = new Set(payload.proposals.map((p) => p.id));
  // A bundle card (smart intake §9) lists proposals of several items: pending = exactly the listed ones.
  const pending = payload.bundleId
    ? ctx.repos.listClaimUpdateProposals(ctx.db, { claimId: payload.claimId, status: 'pending' }).filter((p) => listed.has(p.id))
    : ctx.repos.listClaimUpdateProposals(ctx.db, { intakeItemId: payload.itemId, status: 'pending' }).filter((p) => listed.has(p.id) || p.policyDecision !== 'never');
  const settle = () => {
    const items = payload.bundleId ? [...new Set(pending.map((p) => p.intakeItemId).filter((x): x is string => Boolean(x)))] : [payload.itemId];
    for (const id of items) settleItemStatus(ctx, id);
  };
  if (choice.optionId === 'reject') {
    rejectProposals(ctx, pending.map((p) => p.id), actor, choice.note?.trim() || 'Rejected by the owner');
    settle();
    return;
  }
  if (choice.optionId !== 'apply') throw badRequest(`Unknown option ${choice.optionId}`);
  const parsed = choice.edits === undefined ? {} : confirmEdits.parse(choice.edits);
  // Ids already decided elsewhere (e.g. applied from the Intake screen) are simply not pending any more.
  const wanted = new Set(parsed.apply ?? pending.map((p) => p.id));
  const toApply = pending.filter((p) => wanted.has(p.id));
  const results = await applyProposals(ctx, toApply, ownerApplier(ctx, actor), { ...(parsed.values ? { values: parsed.values } : {}), note: `confirmed by the owner (Needs-you ${item.id})` });
  const failed = results.filter((r) => !r.ok);
  const rest = pending.filter((p) => !wanted.has(p.id)).map((p) => p.id);
  if (rest.length) rejectProposals(ctx, rest, actor, choice.note?.trim() || 'Not ticked by the owner');
  settle();
  if (failed.length) {
    throw conflict('APPLY_FAILED', `${results.length - failed.length} applied; ${failed.length} could not be applied: ${failed.map((f) => `${f.error?.code}: ${f.error?.message}`).join('; ')}`, { failed });
  }
}

const attachEdits = z.object({ claimId: z.string().min(1) }).passthrough();

export async function resolveNewClaim(ctx: AppContext, item: NeedsYouItem & { payload: NewClaimPayload | { bundleId: string } }, choice: { optionId: string; edits?: unknown; note?: string }, actor: Actor): Promise<void> {
  if ('bundleId' in item.payload && item.payload.bundleId) return resolveBundleCard(ctx, item.id, item.payload.bundleId, choice, actor);
  const payload = item.payload as NewClaimPayload;
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

/** The bundle variant of the `new_claim` card (smart intake §9): register / attach / cancel, as the owner. */
async function resolveBundleCard(ctx: AppContext, cardId: string, bundleId: string, choice: { optionId: string; edits?: unknown; note?: string }, actor: Actor): Promise<void> {
  if (choice.optionId === 'register') {
    await registerBundle(ctx, bundleId, actor, { mode: 'owner', acceptPreselected: false, viaCardId: cardId });
    return;
  }
  if (choice.optionId === 'attach') {
    const { claimId } = attachEdits.parse(choice.edits ?? {});
    await attachBundle(ctx, bundleId, actor, { claimId, viaCardId: cardId });
    return;
  }
  if (choice.optionId === 'cancel') {
    cancelBundle(ctx, bundleId, choice.note?.trim() || 'Not a claim', actor, { viaCardId: cardId });
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
export const intakeJobHandlers: JobHandler<any, any>[] = [processHandler, extractHandler, applyHandler, splitHandler, bundleReconcileHandler, bundleReasonHandler, bundleRegisterHandler];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each resolver has its own payload type
export const intakeNeedsYouResolvers: NeedsYouResolver<any>[] = [
  { kind: 'confirm_fields', resolve: resolveConfirmFields } satisfies NeedsYouResolver<ConfirmCardPayload>,
  { kind: 'new_claim', resolve: resolveNewClaim } satisfies NeedsYouResolver<NewClaimPayload | { bundleId: string }>,
];
