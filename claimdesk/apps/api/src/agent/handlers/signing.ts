// owned by ap-paperwork
/**
 * Paperwork job handlers and Needs-you resolvers (docs/SUPREME-AUTOPILOT.md §H.1, §H.3). Registered by
 * agent/handlers/index.ts.
 *
 *   pack.prepare           cpu, priority 3, agent:autopilot — prepare a stage pack (documents drafted from the file,
 *                          review.check queued for each). Waits while agents are stopped or the claim is paused.
 *   signing.chase          io, priority 4, 09:15 weekdays — reminders after 2 and 5 days, a call after 7 (§E.4)
 *   signing.match_return   io, priority 3, every 15 minutes — returned scans → Needs-you confirm_signed
 *
 *   approve_pack     approve_send / approve_only / edit / reject — approves each document as the owner (human) and,
 *                    for approve_send, emails the pack (owner-approved, 30-second Undo)
 *   confirm_signed   confirm (signed on a date) → POST /documents/:id/mark-signed as the owner; not_signed /
 *                    wrong_document → the request goes back to waiting and the chases continue
 * Resolvers run as the signed-in owner.
 */
import { z } from 'zod';
import { PACK_STAGES } from '@ccguk/domain';
import type { JobHandler, NeedsYouResolver } from '../contracts.js';
import { autonomyState } from '../core.js';
import { HttpError } from '../../errors.js';
import { ownerHeaders } from '../../intake/callerContext.js';
import { approvePack, preparePack, rejectPack } from '../../signing/packs.js';
import { rejectReturn, requireSignedOn, runMatchReturns, runSigningChase } from '../../signing/wet.js';
import { AUTOPILOT_USER_ID, audit } from '../../signing/common.js';

const MIN = 60_000;

type PreparePayload = { claimId: string; stage: (typeof PACK_STAGES)[number]; reservationId?: string | null; restart?: boolean };

const packPrepare: JobHandler<PreparePayload, unknown> = {
  type: 'pack.prepare',
  agent: 'autopilot',
  lane: 'cpu',
  usesAi: false,
  mutatesClaim: true,
  payload: z
    .object({ claimId: z.string().min(1).max(128), stage: z.enum(PACK_STAGES as unknown as [string, ...string[]]), reservationId: z.string().min(1).max(128).nullish(), restart: z.boolean().optional() })
    .passthrough() as never,
  defaultPriority: 3,
  maxAttempts: 3,
  timeoutMs: 10 * MIN,
  async run({ ctx, job, payload }) {
    const st = autonomyState(ctx, { claimId: payload.claimId, agent: 'autopilot' });
    if (st.killSwitch || st.agentPaused || st.claimPaused) return { kind: 'retry', afterMs: 30 * MIN, reason: st.killSwitch ? 'agents are stopped (kill switch)' : st.agentPaused ? 'the Autopilot is paused' : 'the claim is paused' };
    const r = await preparePack(ctx, {
      claimId: payload.claimId,
      stage: payload.stage,
      ...(payload.reservationId ? { reservationId: payload.reservationId } : {}),
      ...(payload.restart ? { restart: true } : {}),
      actor: { userId: AUTOPILOT_USER_ID },
      parentJobId: job.id,
      correlationId: job.correlationId,
    });
    return { kind: 'done', result: { packId: r.pack.id, status: r.pack.status, created: r.created.length, failed: r.failed, reused: r.reused } };
  },
};

const signingChase: JobHandler<Record<string, unknown>, unknown> = {
  type: 'signing.chase',
  agent: 'autopilot',
  lane: 'io',
  usesAi: false,
  mutatesClaim: true,
  payload: z.object({}).passthrough(),
  defaultPriority: 4,
  maxAttempts: 3,
  timeoutMs: 10 * MIN,
  async run({ ctx, job }) {
    const st = autonomyState(ctx, { agent: 'autopilot' });
    if (st.killSwitch || st.agentPaused) return { kind: 'done', result: { skipped: st.killSwitch ? 'kill switch' : 'autopilot paused' } };
    return { kind: 'done', result: await runSigningChase(ctx, job) };
  },
};

const signingMatchReturn: JobHandler<Record<string, unknown>, unknown> = {
  type: 'signing.match_return',
  agent: 'autopilot',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({}).passthrough(),
  defaultPriority: 3,
  maxAttempts: 3,
  timeoutMs: 10 * MIN,
  async run({ ctx, job }) {
    return { kind: 'done', result: await runMatchReturns(ctx, job) };
  },
};

const reasonOf = (choice: { note?: string; edits?: unknown }): string | undefined => {
  const n = choice.note?.trim();
  if (n) return n;
  const e = choice.edits && typeof choice.edits === 'object' ? (choice.edits as Record<string, unknown>) : {};
  return typeof e.reason === 'string' && e.reason.trim() ? e.reason.trim() : undefined;
};

type ApprovePackPayload = { packId?: string };

const approvePackResolver: NeedsYouResolver<ApprovePackPayload> = {
  kind: 'approve_pack',
  async resolve(ctx, item, choice, actor) {
    const packId = item.payload?.packId;
    if (!packId) return;
    switch (choice.optionId) {
      case 'approve_send':
      case 'approve_only':
        await approvePack(ctx, packId, actor, { send: choice.optionId === 'approve_send', ...(choice.note ? { note: choice.note } : {}), fromNeedsYou: true });
        return;
      case 'reject': {
        const reason = reasonOf(choice);
        if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Say why the paperwork is rejected');
        rejectPack(ctx, packId, actor, reason, { fromNeedsYou: true });
        return;
      }
      default:
        // edit: the owner opens the documents (Claim > Documents) and approves the pack from the Packs panel afterwards.
        audit(ctx, actor, 'pack.edit_requested', 'document_packs', packId, { needsYouId: item.id });
    }
  },
};

type ConfirmSignedPayload = { signatureRequestId?: string; documentId?: string; evidenceId?: string; signerPartyId?: string; suggestedSignedOn?: string };

const confirmSignedResolver: NeedsYouResolver<ConfirmSignedPayload> = {
  kind: 'confirm_signed',
  async resolve(ctx, item, choice, actor) {
    const p = item.payload ?? {};
    if (!p.documentId || !p.evidenceId) return;
    const edits = choice.edits && typeof choice.edits === 'object' ? (choice.edits as Record<string, unknown>) : {};
    if (choice.optionId === 'confirm') {
      const signedOn = requireSignedOn(edits.signedOn, p.suggestedSignedOn ?? ctx.now().slice(0, 10));
      const method = edits.method === 'wet_ink' ? 'wet_ink' : 'scan';
      if (!ctx.inject) throw new Error('ctx.inject is not wired (buildApp sets it)');
      // Through the human-only route as the owner, so its validation and audit apply exactly as for a click.
      const res = await ctx.inject({
        method: 'POST',
        url: `/api/documents/${encodeURIComponent(p.documentId)}/mark-signed`,
        headers: { ...ownerHeaders(ctx, actor), 'content-type': 'application/json' },
        payload: JSON.stringify({ evidenceId: p.evidenceId, signedOn, method, ...(p.signerPartyId ? { signerPartyId: p.signerPartyId } : {}) }),
      });
      if (res.statusCode >= 400) {
        let message = `The document could not be marked signed (${res.statusCode})`;
        try {
          message = (JSON.parse(res.body) as { error?: { message?: string } }).error?.message ?? message;
        } catch {
          /* keep the default */
        }
        throw new HttpError(res.statusCode === 404 ? 404 : 409, 'MARK_SIGNED_FAILED', message);
      }
      return;
    }
    if (p.signatureRequestId && (choice.optionId === 'not_signed' || choice.optionId === 'wrong_document')) rejectReturn(ctx, p.signatureRequestId, actor, choice.optionId, reasonOf(choice));
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const signingJobHandlers: JobHandler<any, any>[] = [packPrepare, signingChase, signingMatchReturn];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const signingNeedsYouResolvers: NeedsYouResolver<any>[] = [approvePackResolver, confirmSignedResolver];
