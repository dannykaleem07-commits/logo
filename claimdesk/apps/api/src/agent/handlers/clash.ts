// owned by ap-clash
/**
 * clash job handlers and Needs-you resolvers (docs/SUPREME-AUTOPILOT.md §H.1, §H.3). Registered by
 * agent/handlers/index.ts.
 *
 *   clash.check   io, priority 2 — one subject (claim / fleet unit / reservation / hire): findings upserted; a new block
 *                 finding on a claim with a booking or hire → Needs-you clash_review
 *   clash.sweep   io, priority 6, nightly 02:30 London — every open claim with a booking or hire and every fleet unit;
 *                 new block findings within 48 h of a start → urgent clash_review
 *
 *   clash_review        resolved (reason) / acknowledge (warn) / cancel_booking (reason) / open_booking — updates the
 *                       finding; never overrides by itself (a manager overrides in the booking dialog)
 *   eligibility_review  insurer_accepted (evidence id required) / decline_hire (reason) / request_info (prepared
 *                       doc_request) — recorded as an assessment; insurer_accepted lets the booking proceed past
 *                       DRIVER_REFERRAL (the finding becomes info)
 * Resolvers run as the signed-in owner.
 */
import { z } from 'zod';
import type { Actor } from '@ccguk/db';
import type { ClashSubject } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import { HttpError } from '../../errors.js';
import type { JobHandler, NeedsYouResolver } from '../contracts.js';
import { enqueueJob } from '../core.js';
import { runClashCheck, runClashSweep } from '../../clash/service.js';
import { recordEligibility } from '../../eligibility/service.js';
import { nudgeAutopilot } from '../../autopilot/nudge.js';
import { ownerHeaders } from '../../intake/callerContext.js';

const MIN = 60_000;

type CheckPayload = { subjectKind: 'claim' | 'fleet_unit' | 'reservation' | 'hire'; id: string };

const clashCheck: JobHandler<CheckPayload, unknown> = {
  type: 'clash.check',
  agent: 'autopilot',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({ subjectKind: z.enum(['claim', 'fleet_unit', 'reservation', 'hire']), id: z.string().min(1).max(128) }).passthrough() as never,
  defaultPriority: 2,
  maxAttempts: 3,
  timeoutMs: 5 * MIN,
  async run({ ctx, payload }) {
    const subject: ClashSubject =
      payload.subjectKind === 'claim'
        ? { kind: 'claim', claimId: payload.id }
        : payload.subjectKind === 'fleet_unit'
          ? { kind: 'fleet_unit', fleetUnitId: payload.id }
          : payload.subjectKind === 'reservation'
            ? { kind: 'reservation', reservationId: payload.id, stage: 'period_change' }
            : { kind: 'hire', hireId: payload.id };
    const { findings, ...summary } = runClashCheck(ctx, subject);
    return { kind: 'done', result: { ...summary, codes: findings.map((f) => f.code) } };
  },
};

const clashSweep: JobHandler<Record<string, unknown>, unknown> = {
  type: 'clash.sweep',
  agent: 'autopilot',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({}).passthrough(),
  defaultPriority: 6,
  maxAttempts: 3,
  timeoutMs: 20 * MIN,
  async run({ ctx }) {
    return { kind: 'done', result: runClashSweep(ctx) };
  },
};

function audit(ctx: AppContext, actor: Actor, action: string, entity: string, entityId: string, after: unknown): void {
  ctx.repos.appendAudit(ctx.db, { actor, action, entity, entityId, after, at: ctx.now() });
}

const noteOf = (choice: { note?: string; edits?: unknown }): string | undefined => {
  const n = choice.note?.trim();
  if (n) return n;
  const e = choice.edits && typeof choice.edits === 'object' ? (choice.edits as Record<string, unknown>) : {};
  return typeof e.reason === 'string' && e.reason.trim() ? e.reason.trim() : undefined;
};

type ClashReviewPayload = { findingId?: string; reservationId?: string | null; code?: string };

const clashReviewResolver: NeedsYouResolver<ClashReviewPayload> = {
  kind: 'clash_review',
  async resolve(ctx, item, choice, actor) {
    const findingId = item.payload?.findingId;
    const f = findingId ? ctx.repos.getClashFinding(ctx.db, findingId) : undefined;
    const reason = noteOf(choice);
    switch (choice.optionId) {
      case 'resolved':
      case 'acknowledge': {
        if (!f) return;
        if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Say why (a short reason is kept on the file)');
        const status = choice.optionId === 'acknowledge' && f.severity !== 'block' ? 'acknowledged' : 'resolved';
        if (f.status === 'open' || f.status === 'acknowledged') ctx.repos.setClashFindingStatus(ctx.db, f.id, { status, by: actor.userId, note: reason, at: ctx.now() });
        audit(ctx, actor, status === 'acknowledged' ? 'clash.acknowledge' : 'clash.resolve', 'clash_findings', f.id, { code: f.code, reason, via: 'needs_you' });
        if (f.claimId) nudgeAutopilot(ctx, f.claimId, `clash ${f.code} ${status}`);
        return;
      }
      case 'cancel_booking': {
        const reservationId = item.payload?.reservationId ?? f?.reservationId;
        if (!reservationId) throw new HttpError(409, 'NO_BOOKING', 'This clash is not about a booking');
        if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Say why the booking is cancelled');
        if (!ctx.inject) throw new Error('ctx.inject is not wired (buildApp sets it)');
        // Through the booking route as the owner, so its guards, events and audit apply exactly as for a click.
        const res = await ctx.inject({ method: 'POST', url: `/api/bookings/${encodeURIComponent(reservationId)}/release`, headers: { ...ownerHeaders(ctx, actor), 'content-type': 'application/json' }, payload: JSON.stringify({ reason }) });
        if (res.statusCode >= 400) {
          let message = `The booking could not be cancelled (${res.statusCode})`;
          try {
            message = (JSON.parse(res.body) as { error?: { message?: string } }).error?.message ?? message;
          } catch {
            /* keep the default */
          }
          throw new HttpError(res.statusCode === 404 ? 404 : 409, 'BOOKING_RELEASE_FAILED', message);
        }
        audit(ctx, actor, 'clash.cancel_booking', 'clash_findings', f?.id ?? item.id, { reservationId, reason });
        return;
      }
      default:
        // open_booking: the owner opens the booking (and overrides there as a manager); nothing changes here.
        audit(ctx, actor, 'clash.review_opened', 'needs_you', item.id, { optionId: choice.optionId, findingId: findingId ?? null });
    }
  },
};

type EligibilityReviewPayload = { claimId?: string; partyId?: string; policyId?: string | null; outcome?: string; reasons?: unknown };

const eligibilityReviewResolver: NeedsYouResolver<EligibilityReviewPayload> = {
  kind: 'eligibility_review',
  async resolve(ctx, item, choice, actor) {
    const claimId = item.claimId ?? item.payload?.claimId;
    if (!claimId) return;
    const claim = ctx.repos.requireClaim(ctx.db, claimId);
    const edits = choice.edits && typeof choice.edits === 'object' ? (choice.edits as Record<string, unknown>) : {};
    const reason = noteOf(choice);
    const now = ctx.now();
    switch (choice.optionId) {
      case 'insurer_accepted': {
        const partyId = item.payload?.partyId ?? (typeof edits.partyId === 'string' ? edits.partyId : undefined);
        const evidenceId = typeof edits.evidenceId === 'string' ? edits.evidenceId.trim() : '';
        if (!partyId) throw new HttpError(400, 'VALIDATION', 'Which driver did the insurer accept?');
        if (!evidenceId) throw new HttpError(400, 'EVIDENCE_REQUIRED', "Attach the insurer's written acceptance (upload it to the claim's evidence and choose it)");
        const ev = ctx.repos.getEvidence(ctx.db, evidenceId);
        if (!ev || ev.claimId !== claimId) throw new HttpError(400, 'EVIDENCE_REQUIRED', "That evidence is not on this claim: upload the insurer's written acceptance first");
        ctx.repos.appendEligibilityAssessment(ctx.db, {
          claimId,
          partyId,
          ...(item.payload?.policyId ? { policyId: item.payload.policyId } : {}),
          kind: 'driver',
          outcome: 'eligible',
          reasons: [{ code: 'INSURER_ACCEPTED', outcome: 'eligible', message: reason ?? "The fleet insurer accepted this driver in writing.", evidenceId }],
          inputsSha256: `insurer_accepted:${evidenceId}`,
          createdBy: actor.userId,
          createdAt: now,
        });
        audit(ctx, actor, 'eligibility.insurer_accepted', 'claims', claimId, { partyId, evidenceId, note: reason ?? null });
        break;
      }
      case 'decline_hire': {
        if (!reason) throw new HttpError(400, 'REASON_REQUIRED', 'Say why hire is declined');
        ctx.repos.appendEligibilityAssessment(ctx.db, { claimId, kind: 'overall', outcome: 'ineligible', reasons: [{ code: 'HIRE_DECLINED', outcome: 'ineligible', message: reason, by: actor.userId }], inputsSha256: `decline_hire:${now}`, createdBy: actor.userId, createdAt: now });
        audit(ctx, actor, 'eligibility.decline_hire', 'claims', claimId, { reason });
        break;
      }
      case 'request_info': {
        // A prepared doc_request through the normal drafter → reviewer → autonomy path (never sent unreviewed).
        const missing = Array.isArray(edits.missing) ? (edits.missing as unknown[]).filter((x): x is string => typeof x === 'string') : [];
        enqueueJob(ctx, {
          type: 'draft.compose',
          claimId,
          payload: {
            claimId,
            templateId: null,
            emailKind: 'doc_request',
            purpose: `Ask the client for what is needed to check hire eligibility${missing.length ? `: ${missing.join(', ')}` : ''}. For the driving licence: a photo of both sides and a DVLA "share your licence" check code.`,
            recipientPartyId: claim.claimantId,
            replyToMessageId: null,
            actionCode: null,
            dueAt: null,
            missingInfo: true,
          },
          idempotencyKey: `eligibility_review:request_info:${item.id}`,
          createdBy: actor.userId,
        });
        audit(ctx, actor, 'eligibility.request_info', 'claims', claimId, { missing, note: reason ?? null });
        break;
      }
      default:
        return;
    }
    try {
      recordEligibility(ctx, claimId, actor.userId);
    } catch (err) {
      ctx.logger.warn('eligibility could not be re-recorded after a review', { claimId, error: String(err) });
    }
    nudgeAutopilot(ctx, claimId, `eligibility review: ${choice.optionId}`);
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const clashJobHandlers: JobHandler<any, any>[] = [clashCheck, clashSweep];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const clashNeedsYouResolvers: NeedsYouResolver<any>[] = [clashReviewResolver, eligibilityReviewResolver];
