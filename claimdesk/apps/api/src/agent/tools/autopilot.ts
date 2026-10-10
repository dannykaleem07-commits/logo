// owned by ap-autopilot
/**
 * Autopilot tools (docs/SUPREME-AUTOPILOT.md §H.2). Registered by agent/tools/index.ts. Each calls an Autopilot route
 * as the agent (dispatcher → decide() → perimeter → route).
 *
 *   read      autopilot_plan · hire_offers_list
 *   draft     hire_offer_prepare      binds the held car and its offer email (nothing is sent)
 *   internal  hire_acceptance_record  the client's answer (sensitive below 0.9 confidence → the owner is asked)
 *             claim_status_set        the status that matches the stage (the perimeter refuses final statuses)
 */
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { ActionDescriptor, Decision } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import type { NeedsYouInput, RunContext, ToolDef } from '../contracts.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from '../contracts.js';
import { toolInputSchema } from '../../ai/strictSchema.js';
import { agentUserId } from '../principal.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
type AnyTool = ToolDef<any, any>;

const id = () => z.string().min(1).max(128);
const enc = encodeURIComponent;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : []);

function tool<S extends z.ZodType>(def: Omit<AnyTool, 'input' | 'strictSchema' | 'maxOutputChars'> & { input: S; maxOutputChars?: number }): AnyTool {
  return { ...def, strictSchema: toolInputSchema(def.input), maxOutputChars: def.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS } as AnyTool;
}

/** The statuses the Autopilot may set (§A.9); final statuses are refused by the perimeter anyway. */
const AUTOPILOT_STATUSES = ['fnol', 'triage', 'accepted', 'hire_active', 'repair', 'total_loss', 'payment_pack', 'chasing'] as const;

const autopilotPlan = tool({
  name: 'autopilot_plan',
  title: 'Autopilot plan of the claim',
  description:
    "The claim's Autopilot plan: the lifecycle stage, which steps are done, due (with mode: automatic, ask the owner, or a person does it), waiting (on whom) or blocked (why). The autopilot owns these steps — do not duplicate them.",
  class: 'read',
  input: z.strictObject({ claimId: id() }),
  http: (i: { claimId: string }) => ({ method: 'GET', url: `/claims/${enc(i.claimId)}/autopilot` }),
  httpRoute: { method: 'GET', pattern: '/claims/:id/autopilot' },
  describe: (i: { claimId: string }): ActionDescriptor => ({ class: 'read', kind: 'read.autopilot_plan', claimId: i.claimId, confidence: 1 }),
  shape: (raw) => {
    const r = obj(raw);
    const plan = obj(r.plan);
    const steps = arr(plan.steps);
    const pick = (s: Record<string, unknown>) => ({ id: s.id, status: s.status, mode: s.mode, dueAt: s.dueAt ?? null, waitingOn: s.waitingOn ?? null, next: s.next });
    return {
      stage: plan.stage,
      mode: plan.mode,
      due: steps.filter((s) => s.status === 'due').map(pick),
      waiting: steps.filter((s) => s.status === 'waiting' || s.status === 'in_progress').map(pick),
      blocked: steps.filter((s) => s.status === 'blocked').map((s) => ({ ...pick(s), blockedBy: arr(s.blockedBy).map((b) => b.message) })),
      done: steps.filter((s) => s.status === 'done').map((s) => s.id),
      stopped: r.stopped ?? null,
    };
  },
});

const hireOffersList = tool({
  name: 'hire_offers_list',
  title: 'Hire offers on the claim',
  description: 'The replacement-car offers made to the client: car, status (draft, sent, accepted, declined, expired, withdrawn), when it was sent and when it expires, and the client’s answer.',
  class: 'read',
  input: z.strictObject({ claimId: id() }),
  http: (i: { claimId: string }) => ({ method: 'GET', url: `/claims/${enc(i.claimId)}/hire-offers` }),
  httpRoute: { method: 'GET', pattern: '/claims/:id/hire-offers' },
  describe: (i: { claimId: string }): ActionDescriptor => ({ class: 'read', kind: 'read.hire_offers_list', claimId: i.claimId, confidence: 1 }),
  shape: (raw) => ({
    offers: arr(obj(raw).offers).map((o) => {
      const t = obj(o.terms);
      return { id: o.id, status: o.status, registration: t.registration, makeModel: t.makeModel, sentAt: o.sentAt ?? null, expiresAt: o.expiresAt, authorisedBy: o.authorisedBy === 'autopilot_green' ? 'autopilot (green)' : 'owner', response: o.response ?? null };
    }),
  }),
});

const hireOfferPrepare = tool({
  name: 'hire_offer_prepare',
  title: 'Prepare a hire offer',
  description: 'Bind the held car and the drafted offer email (kind hire_offer) into an offer, with the terms hash code checks before sending. Nothing is sent by this tool: the reviewer and the policy decide.',
  class: 'draft',
  input: z.strictObject({ claimId: id(), reservationId: id(), outboxId: id(), alternatives: z.array(id()).max(5) }),
  http: (i: { claimId: string; reservationId: string; outboxId: string; alternatives: string[] }) => ({ method: 'POST', url: `/claims/${enc(i.claimId)}/hire-offers`, body: { reservationId: i.reservationId, outboxId: i.outboxId, alternatives: i.alternatives } }),
  httpRoute: { method: 'POST', pattern: '/claims/:id/hire-offers' },
  describe: (i: { claimId: string }): ActionDescriptor => ({ class: 'draft', kind: 'hire_offer.prepare', claimId: i.claimId, confidence: 1 }),
  shape: (raw) => {
    const o = obj(obj(raw).offer);
    return { hireOfferId: o.id ?? null, status: o.status ?? null, expiresAt: o.expiresAt ?? null };
  },
});

interface AcceptanceInput {
  hireOfferId: string;
  decision: 'accept' | 'decline';
  messageId: string | null;
  chosenFleetUnitId: string | null;
  confidence: number;
}

const claimOfOffer = (ctx: AppContext, offerId: string): string | undefined => ctx.repos.getHireOffer(ctx.db, offerId)?.claimId;

const hireAcceptanceRecord = tool({
  name: 'hire_acceptance_record',
  title: 'Record the client’s answer to a hire offer',
  description: "Record the client's answer to a replacement-car offer (from their email reply). Below 0.9 confidence the owner is asked instead. A decline releases the held car.",
  class: 'internal',
  input: z.strictObject({ hireOfferId: id(), decision: z.enum(['accept', 'decline']), messageId: id().nullable(), chosenFleetUnitId: id().nullable(), confidence: z.number().min(0).max(1) }),
  http: (i: AcceptanceInput) => ({ method: 'POST', url: `/hire-offers/${enc(i.hireOfferId)}/response`, body: { decision: i.decision, messageId: i.messageId, chosenFleetUnitId: i.chosenFleetUnitId, confidence: i.confidence, how: 'email_reply' } }),
  httpRoute: { method: 'POST', pattern: '/hire-offers/:id/response' },
  describe: (i: AcceptanceInput, _rc: RunContext, ctx: AppContext): ActionDescriptor => {
    const claimId = claimOfOffer(ctx, i.hireOfferId);
    return { class: 'internal', kind: `hire_offer.${i.decision}`, ...(claimId ? { claimId } : {}), confidence: i.confidence, sensitive: i.confidence < 0.9 };
  },
  onAsk: (i: AcceptanceInput, rc: RunContext, ctx: AppContext, d: Decision): NeedsYouInput => {
    const claimId = claimOfOffer(ctx, i.hireOfferId);
    return {
      kind: 'autopilot_step',
      ...(claimId ? { claimId } : {}),
      title: `Confirm the client's answer to the hire offer (${i.decision === 'accept' ? 'yes' : 'no'})`,
      summary: `The reply reads as ${i.decision === 'accept' ? 'a yes' : 'a no'} with confidence ${i.confidence.toFixed(2)}; the policy asks you first (${d.reasons.join('; ') || d.ruleIds.join(', ')}).`,
      options: [
        { id: 'accepted', label: 'It is a yes', tone: 'primary' },
        { id: 'declined', label: 'It is a no', tone: 'neutral', requiresReason: true },
        { id: 'ignore', label: 'Not an answer — keep waiting', tone: 'neutral' },
      ],
      payload: { stepId: 'hire.acceptance', purpose: 'reply_unclear', hireOfferId: i.hireOfferId, ...(i.messageId ? { messageId: i.messageId } : {}), link: claimId ? `/claims/${claimId}?tab=autopilot` : '/', decision: { ruleIds: d.ruleIds, reasons: d.reasons }, runId: rc.runId },
      priority: 'high',
      createdBy: agentUserId(rc.agent),
      correlationId: rc.correlationId,
      dedupeKey: `autopilot:${claimId ?? 'x'}:hire.acceptance:${createHash('sha256').update(`${i.hireOfferId}|${i.messageId ?? ''}`).digest('hex').slice(0, 16)}`,
    };
  },
  shape: (raw) => {
    const o = obj(obj(raw).offer);
    return { hireOfferId: o.id ?? null, status: o.status ?? null };
  },
});

const claimStatusSet = tool({
  name: 'claim_status_set',
  title: 'Set the claim status',
  description: 'Set the claim status that matches its lifecycle stage (fnol, triage, accepted, hire_active, repair, total_loss, payment_pack, chasing). Declined, settled, closed, pre-action and litigation are the owner’s only.',
  class: 'internal',
  input: z.strictObject({ claimId: id(), status: z.enum(AUTOPILOT_STATUSES) }),
  http: (i: { claimId: string; status: string }) => ({ method: 'POST', url: `/claims/${enc(i.claimId)}/status`, body: { status: i.status } }),
  httpRoute: { method: 'POST', pattern: '/claims/:id/status' },
  describe: (i: { claimId: string; status: string }): ActionDescriptor => ({ class: 'internal', kind: `claim.status.${i.status}`, claimId: i.claimId, confidence: 1 }),
  shape: (raw) => ({ status: obj(raw).status ?? null }),
});

export const autopilotTools: AnyTool[] = [autopilotPlan, hireOffersList, hireOfferPrepare, hireAcceptanceRecord, claimStatusSet];
