// owned by ap-autopilot
/**
 * Autopilot job handlers and Needs-you resolvers (docs/SUPREME-AUTOPILOT.md §H.1, §H.3). Registered by
 * agent/handlers/index.ts.
 *
 *   autopilot.tick          io   deterministic: plan one claim and run its due steps (runner.ts)
 *   autopilot.sweep         io   every 5 min: tick the claims that are due or changed
 *   autopilot.judge         ai   case manager picks one of the options code allowed (judge.ts)
 *   hire_offer.parse_reply  ai   mail agent reads a client's reply code could not read (judge.ts)
 *
 * Resolvers (run as the signed-in owner): choose_car, autopilot_step.
 */
import { z } from 'zod';
import { liveReservation, withHireNeedsDefaults, type AutopilotStepId } from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import type { JobHandler, JobRecord, NeedsYouResolver } from '../contracts.js';
import { runSweep, runTick, type StepCardPayload, type TickPayload } from '../../autopilot/runner.js';
import { runJudge, runParseReply, type JudgePayload, type ParseReplyPayload } from '../../autopilot/judge.js';
import { evaluate } from '../../autopilot/facts.js';
import { applyStepAction } from '../../autopilot/service.js';
import { recordHireOfferResponse } from '../../autopilot/hireOffers.js';
import { nudgeAutopilot } from '../../autopilot/nudge.js';
import { placeHold, releaseBooking } from '../../booking/service.js';
import { STRICT_GATE } from '../../services/override.js';

const MIN = 60_000;

const tick: JobHandler<TickPayload> = {
  type: 'autopilot.tick',
  agent: 'autopilot',
  lane: 'io',
  usesAi: false,
  mutatesClaim: true,
  payload: z.object({ claimId: z.string().min(1), reason: z.string().optional(), forceStepId: z.string().optional() }).passthrough() as never,
  defaultPriority: 2,
  maxAttempts: 3,
  timeoutMs: 5 * MIN,
  run: ({ ctx, job, payload }) => runTick(ctx, job as JobRecord, payload),
};

const sweep: JobHandler<Record<string, unknown>> = {
  type: 'autopilot.sweep',
  agent: 'autopilot',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({}).passthrough(),
  defaultPriority: 4,
  maxAttempts: 3,
  timeoutMs: 5 * MIN,
  async run({ ctx, job }) {
    return { kind: 'done', result: runSweep(ctx, job as JobRecord) };
  },
};

const judge: JobHandler<JudgePayload> = {
  type: 'autopilot.judge',
  agent: 'case_manager',
  lane: 'ai',
  usesAi: true,
  mutatesClaim: false,
  payload: z.object({ claimId: z.string().min(1), stepId: z.string().min(1), questionId: z.string().min(1), options: z.array(z.object({ id: z.string(), label: z.string(), detail: z.string(), recommended: z.boolean() }).passthrough()).min(1).max(10), planHash: z.string(), messageId: z.string().optional() }).passthrough() as never,
  defaultPriority: 2,
  maxAttempts: 3,
  timeoutMs: 6 * MIN,
  run: ({ ctx, job, payload }) => runJudge(ctx, job as JobRecord, payload),
};

const parseReply: JobHandler<ParseReplyPayload> = {
  type: 'hire_offer.parse_reply',
  agent: 'mail',
  lane: 'ai',
  usesAi: true,
  mutatesClaim: false,
  payload: z.object({ claimId: z.string().min(1), hireOfferId: z.string().min(1), messageId: z.string().min(1) }).passthrough(),
  defaultPriority: 1,
  maxAttempts: 3,
  timeoutMs: 3 * MIN,
  run: ({ ctx, job, payload }) => runParseReply(ctx, job as JobRecord, payload),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const autopilotJobHandlers: JobHandler<any, any>[] = [tick, sweep, judge, parseReply];

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

function audit(ctx: AppContext, actor: Actor, action: string, entityId: string, after: unknown): void {
  ctx.repos.appendAudit(ctx.db, { actor, action, entity: 'needs_you', entityId, after, at: ctx.now() });
}

interface ChooseCarPayload {
  protectiveHoldId?: string | null;
  period?: { startAt: string; expectedEndAt: string } | null;
}

/**
 * choose_car (§H.3): the owner picks a car (the hold is placed or moved, and the offer becomes owner-authorised), asks
 * for a new search, or says no hire. Never sends anything itself — the next tick prepares the offer.
 */
const chooseCarResolver: NeedsYouResolver<ChooseCarPayload> = {
  kind: 'choose_car',
  async resolve(ctx, item, choice, actor) {
    const claimId = item.claimId;
    if (!claimId) return;
    const { facts } = evaluate(ctx, claimId);
    const live = liveReservation(facts);
    if (choice.optionId.startsWith('unit:')) {
      const unitId = choice.optionId.slice(5);
      let reservationId = live?.fleetUnitId === unitId && live.status === 'held' ? live.id : undefined;
      if (!reservationId) {
        const period = item.payload?.period ?? facts.availability?.period;
        if (!period) throw new Error('No hire period to hold the car for');
        const res = placeHold(ctx, null, STRICT_GATE, {
          claimId,
          fleetUnitId: unitId,
          use: facts.availability?.use ?? 'credit_hire',
          startAt: period.startAt,
          expectedEndAt: period.expectedEndAt,
          ...(live && live.status === 'held' ? { replaceReservationId: live.id } : {}),
        });
        reservationId = res.reservation.id;
      }
      ctx.repos.appendAutopilotLog(ctx.db, { claimId, stepId: 'hire.choose', toStatus: 'done', action: 'owner_choice', actor: actor.userId, refs: { reservationId }, note: choice.note ?? `Owner chose ${unitId}`, at: ctx.now() });
      audit(ctx, actor, 'autopilot.step_resolve', item.id, { kind: 'choose_car', optionId: choice.optionId, reservationId });
    } else if (choice.optionId === 'search_again') {
      if (live && live.status === 'held' && live.createdBy.startsWith('agent:')) releaseBooking(ctx, null, live.id, 'Owner asked to search again');
      audit(ctx, actor, 'autopilot.step_resolve', item.id, { kind: 'choose_car', optionId: 'search_again' });
    } else if (choice.optionId === 'no_hire') {
      if (live && (live.status === 'held' || live.status === 'confirmed')) releaseBooking(ctx, null, live.id, `No hire: ${choice.note ?? 'owner decision'}`);
      const needs = withHireNeedsDefaults(ctx.repos.getHireNeeds(ctx.db, claimId)?.needs);
      ctx.repos.putHireNeeds(ctx.db, claimId, { ...needs, clientWantsHire: false, notes: [needs.notes, `No hire (owner): ${choice.note ?? ''}`].filter(Boolean).join('\n') }, actor.userId, ctx.now());
      audit(ctx, actor, 'autopilot.step_resolve', item.id, { kind: 'choose_car', optionId: 'no_hire', note: choice.note ?? null });
    }
    nudgeAutopilot(ctx, claimId, `choose_car: ${choice.optionId}`, { createdBy: actor.userId });
  },
};

/** autopilot_step (§H.3): what a person does, the owner's go-ahead, an expired offer, a reply code could not read. */
const autopilotStepResolver: NeedsYouResolver<StepCardPayload> = {
  kind: 'autopilot_step',
  async resolve(ctx, item, choice, actor) {
    const claimId = item.claimId;
    const p = item.payload;
    if (!claimId || !p?.stepId) return;
    const stepId = p.stepId as AutopilotStepId;
    const note = choice.note?.trim() || undefined;
    switch (choice.optionId) {
      case 'do_it':
        if (stepId === 'qualify.decline') ctx.repos.setClaimStatus(ctx.db, claimId, 'declined', actor, note ?? 'Declined by the owner (Autopilot recommendation)');
        else if (stepId === 'close.readiness') ctx.repos.setClaimStatus(ctx.db, claimId, 'closed', actor, note ?? 'Closed by the owner');
        else applyStepAction(ctx, actor, claimId, stepId, 'done', { reason: note ?? 'The owner said go ahead' });
        break;
      case 'done':
        applyStepAction(ctx, actor, claimId, stepId, 'done', { reason: note ?? 'Done by the owner' });
        break;
      case 'skip':
        applyStepAction(ctx, actor, claimId, stepId, 'skip', { reason: note ?? 'Skipped by the owner' });
        break;
      case 'snooze':
        applyStepAction(ctx, actor, claimId, stepId, 'snooze', {});
        break;
      case 'accepted':
      case 'accepted_by_phone':
        if (p.hireOfferId) recordHireOfferResponse(ctx, null, actor, p.hireOfferId, { decision: 'accept', how: choice.optionId === 'accepted' ? 'email_reply' : 'phone', messageId: choice.optionId === 'accepted' ? (p.messageId ?? null) : null, confidence: 1, note: note ?? null });
        break;
      case 'declined':
        if (p.hireOfferId) recordHireOfferResponse(ctx, null, actor, p.hireOfferId, { decision: 'decline', how: p.messageId ? 'email_reply' : 'phone', messageId: p.messageId ?? null, confidence: 1, note: note ?? null });
        break;
      case 'search_again':
        if (p.hireOfferId) {
          const o = ctx.repos.getHireOffer(ctx.db, p.hireOfferId);
          if (o && (o.status === 'expired' || o.status === 'sent' || o.status === 'draft')) ctx.repos.updateHireOffer(ctx.db, o.id, { status: 'withdrawn' }, ctx.now());
        }
        break;
      default:
        break;
    }
    audit(ctx, actor, 'autopilot.step_resolve', item.id, { stepId, purpose: p.purpose, optionId: choice.optionId, note: note ?? null });
    nudgeAutopilot(ctx, claimId, `autopilot_step ${stepId}: ${choice.optionId}`, { createdBy: actor.userId });
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const autopilotNeedsYouResolvers: NeedsYouResolver<any>[] = [chooseCarResolver, autopilotStepResolver];
