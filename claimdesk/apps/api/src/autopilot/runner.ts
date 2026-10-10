// owned by ap-autopilot
/**
 * The Autopilot runner (docs/SUPREME-AUTOPILOT.md §A.7): `autopilot.tick` for one claim and `autopilot.sweep` for the
 * claims that are due. Deterministic — no model. Every action is a tool call as `agent:autopilot` through
 * `actAsAutopilot` (dispatcher → decide() → perimeter → route), with the step's effective mode and green on the
 * descriptor; inputs are built here by code, never by a model.
 *
 * tick:  sync offers with their emails → facts → plan → log every status change (append-only) → store the plan →
 *        stop when switched off / paused / agents off / kill switch → handle the client's replies and offer reminders →
 *        up to `maxActionsPerTick` due steps in plan order (loop guard: the same step failing 3 times in 24 h →
 *        Needs-you `failure`) → prepare missing-information requests for blocked steps → re-plan and store.
 *
 * Offers, settlements, money and legal never go out without the owner: those steps are "Ask me" / "I do it" by floor,
 * and the policy's always-ask classes apply on top.
 */
import {
  CUSTOM_ACTION_CODE,
  PACK_STAGE_STEP,
  addWorkingDays,
  calculateHire,
  currentOffer,
  diffPlans,
  liveReservation,
  activeReservation,
  offHireDeadline,
  offHireTrigger,
  parseHireReplyCode,
  proposeSlots,
  statusTarget,
  stepDef,
  stepTitle,
  buildHireOfferEmail,
  buildBookingUpdateEmail,
  type AutopilotFacts,
  type AutopilotPlan,
  type AutopilotStepId,
  type AvailabilityCandidate,
  type EmailKind,
  type Handoff,
  type HireOffer,
  type ISODateTime,
  type Movement,
  type NeedsYouOption,
  type StepContext,
  type StepDef,
  type StepState,
} from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { JobOutcome, JobRecord } from '../agent/contracts.js';
import { createNeedsYou, enqueueJob, londonDay } from '../agent/core.js';
import { effectiveAgentSettings } from '../agent/queue.js';
import { validateHandoff } from '../casework/handoffs.js';
import { acceptanceFor, gatesFor } from '../services/claimView.js';
import { recordAcceptance } from '../eligibility/service.js';
import { actAsAutopilot, type ActAsAutopilotResult } from './act.js';
import { evaluate } from './facts.js';
import { claimAutopilotFor, ensureAutopilotInstalled } from './install.js';
import { buildHireOfferTerms, deliveryOf, recordHireOfferResponse, syncHireOffers } from './hireOffers.js';
import { AUTOPILOT_ACTOR } from './nudge.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface TickPayload {
  claimId: string;
  reason?: string;
  forceStepId?: string;
}

export interface StepRun {
  stepId: string;
  action: string;
  ok: boolean;
  note?: string;
  runId?: string;
  needsYouId?: string;
}

export interface TickResult {
  claimId: string;
  stage: string;
  planHash: string;
  acted: StepRun[];
  skipped?: string;
}

interface Env {
  ctx: AppContext;
  job: Pick<JobRecord, 'id' | 'correlationId'>;
  facts: AutopilotFacts;
  plan: AutopilotPlan;
  claimId: string;
}

const parse = (content: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(content) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const errorOf = (r: { content: string }): { code: string; message: string } => {
  const e = (parse(r.content).error ?? {}) as { code?: unknown; message?: unknown };
  return { code: String(e.code ?? 'TOOL_FAILED'), message: String(e.message ?? '') };
};

function stepCtx(plan: AutopilotPlan, id: AutopilotStepId, fallbackMode: StepState['mode'] = 'auto'): StepContext {
  const st = plan.steps.find((s) => s.id === id);
  return { id, mode: st?.mode ?? fallbackMode, green: st?.green ?? false };
}

function log(env: Env, stepId: string, entry: { toStatus: string; action?: string; runId?: string; needsYouId?: string; note?: string; decision?: unknown; refs?: Record<string, unknown> }): void {
  env.ctx.repos.appendAutopilotLog(env.ctx.db, {
    claimId: env.claimId,
    stepId,
    toStatus: entry.toStatus as never,
    actor: AUTOPILOT_ACTOR,
    jobId: env.job.id,
    ...(entry.action ? { action: entry.action } : {}),
    ...(entry.runId ? { runId: entry.runId } : {}),
    ...(entry.needsYouId ? { needsYouId: entry.needsYouId } : {}),
    ...(entry.note ? { note: entry.note.slice(0, 1000) } : {}),
    ...(entry.decision !== undefined ? { decision: entry.decision } : {}),
    refs: (entry.refs ?? {}) as never,
    at: env.ctx.now(),
  });
}

async function act(env: Env, stepId: AutopilotStepId, tool: string, input: unknown, step?: StepContext): Promise<ActAsAutopilotResult> {
  return actAsAutopilot(env.ctx, { claimId: env.claimId, step: step ?? stepCtx(env.plan, stepId), tool, input, planHash: env.plan.planHash, jobId: env.job.id, correlationId: env.job.correlationId });
}

function claimOf(env: Env) {
  return env.facts.bundle.claim;
}

const salutation = (name: string): string => name.trim() || 'Sir or Madam';

// ---------------------------------------------------------------------------
// Needs-you for the owner
// ---------------------------------------------------------------------------

export type StepCardPurpose = 'owner_step' | 'confirm_step' | 'offer_expired' | 'reply_other_sender' | 'reply_unclear' | 'loop_guard';

export interface StepCardPayload {
  stepId: AutopilotStepId;
  purpose: StepCardPurpose;
  hireOfferId?: string;
  messageId?: string;
  reservationId?: string;
  link: string;
  parsed?: unknown;
}

const OWNER_TEXT: Partial<Record<AutopilotStepId, string>> = {
  'qualify.decline': 'The acceptance check says decline this claim. Declining is your decision: check the reasons, then decline it (a decline letter is prepared for the client) or skip this step to keep going.',
  'qualify.need': "The client's need for a car looks weak or is not clear. Decide whether a hire is justified before a car is offered.",
  'signup.signed': 'The sign-up pack is approved but not signed yet. Get it signed in the office (kiosk on the PC) or send it for signature from the Documents tab.',
  'vehicle.report': 'A draft engineer report is waiting. Check it and issue it from the Engineering tab — issuing a report is a person’s decision.',
  'hire.handover': 'The car is due to be handed over. Take the hire-start pack (kiosk signing on the PC), see the licence, record the DVLA check, the odometer and fuel, then click "Handover done" on the booking.',
  'hire.return': 'The hire car is due back. Collect it, record the odometer, fuel and any damage, then click "Return" on the booking to end the hire at the right time.',
  'money.offer': 'An insurer’s settlement offer is open. Offers and settlements always need you: decide on the offer screen (accept, counter or reject).',
  'money.client_payout': 'Money that belongs to the client (PAV or excess) has been received. Pay it on to the client and mark this step done.',
  'close.readiness': 'Every head is paid, settled or written off. Close the file when you are happy (a closure letter is prepared for the client).',
};

function cardOptions(purpose: StepCardPurpose, def: StepDef): NeedsYouOption[] {
  switch (purpose) {
    case 'offer_expired':
      return [
        { id: 'accepted_by_phone', label: 'Client accepted by phone', tone: 'primary' },
        { id: 'declined', label: 'Client does not want the car', tone: 'neutral', requiresReason: true },
        { id: 'search_again', label: 'Search again', tone: 'neutral' },
      ];
    case 'reply_other_sender':
    case 'reply_unclear':
      return [
        { id: 'accepted', label: 'Treat it as a yes', tone: 'primary' },
        { id: 'declined', label: 'Treat it as a no', tone: 'neutral', requiresReason: true },
        { id: 'ignore', label: 'Not an answer — keep waiting', tone: 'neutral' },
      ];
    default:
      return [
        ...(def.id === 'qualify.decline' || def.id === 'close.readiness' || purpose === 'confirm_step' ? [{ id: 'do_it', label: def.id === 'qualify.decline' ? 'Decline the claim' : def.id === 'close.readiness' ? 'Close the file' : 'Go ahead', tone: 'primary' as const }] : []),
        { id: 'done', label: 'Mark done', tone: purpose === 'owner_step' ? ('primary' as const) : ('neutral' as const), requiresReason: true },
        { id: 'skip', label: 'Skip this step', tone: 'neutral', requiresReason: true },
        { id: 'snooze', label: 'Remind me tomorrow', tone: 'neutral' },
        { id: 'open', label: 'Open the claim', tone: 'neutral' },
      ];
  }
}

export function raiseStepCard(ctx: AppContext, claimId: string, stepId: AutopilotStepId, purpose: StepCardPurpose, extra: { title?: string; summary?: string; priority?: 'urgent' | 'high' | 'normal' | 'low'; hireOfferId?: string; messageId?: string; reservationId?: string; parsed?: unknown; dueAt?: ISODateTime; correlationId?: string; seq?: string } = {}): string {
  const def = stepDef(stepId);
  const ref = ctx.repos.getClaim(ctx.db, claimId)?.reference ?? 'the claim';
  const payload: StepCardPayload = {
    stepId,
    purpose,
    link: `/claims/${claimId}?tab=autopilot`,
    ...(extra.hireOfferId ? { hireOfferId: extra.hireOfferId } : {}),
    ...(extra.messageId ? { messageId: extra.messageId } : {}),
    ...(extra.reservationId ? { reservationId: extra.reservationId } : {}),
    ...(extra.parsed !== undefined ? { parsed: extra.parsed } : {}),
  };
  const item = createNeedsYou(ctx, {
    kind: 'autopilot_step',
    claimId,
    title: (extra.title ?? `${def.title} — ${ref}`).slice(0, 200),
    summary: (extra.summary ?? OWNER_TEXT[stepId] ?? `The autopilot has prepared "${def.title}" for you to confirm.`).slice(0, 2000),
    options: cardOptions(purpose, def),
    payload,
    priority: extra.priority ?? (purpose === 'offer_expired' || purpose.startsWith('reply') ? 'high' : 'normal'),
    ...(extra.dueAt ? { dueAt: extra.dueAt } : {}),
    createdBy: AUTOPILOT_ACTOR,
    dedupeKey: `autopilot:${claimId}:${stepId}:${extra.seq ?? purpose}`,
    ...(extra.correlationId ? { correlationId: extra.correlationId } : {}),
  });
  return item.id;
}

// ---------------------------------------------------------------------------
// Drafts (hand-offs to the drafter, as the case manager would)
// ---------------------------------------------------------------------------

const PURPOSE: Partial<Record<AutopilotStepId, string>> = {
  'intake.acknowledge': 'Acknowledge the new claim to the client: thank them, say we have their details and what happens next (we look for a replacement car where they need one). No figures, no promises about the outcome.',
  'intake.complete_fnol': 'Ask the client for the details still missing from the first notification (listed in the brief). Plain and short.',
  'intake.cctv': 'Ask the holder of any CCTV covering the accident location to preserve the footage (date, time and place from the brief).',
  'qualify.means': 'Ask the client for evidence of means: the statement of means (CCGUK-07) and three months of bank statements, explaining why we need them.',
  'notify.ncaf': 'Send the New Claim Advice Form to the at-fault insurer.',
  'notify.handling_ref': "Ask the at-fault insurer for their handling centre and claim reference.",
  'notify.intervention': "Reply in writing to the insurer's intervention offer (record it, explain the client's position neutrally).",
  'vehicle.recovery': "Instruct recovery and storage of the client's car, which cannot be driven.",
  'vehicle.storage': 'Send the collect-or-pay notice for the stored car.',
  'vehicle.engineer': "Instruct the independent engineer to inspect the client's car.",
  'vehicle.inspection': 'Chase the engineer for the inspection date (instructed 3 working days ago).',
  'hire.start_notice': 'Tell the at-fault insurer the hire has started: vehicle group, start date, agreement number and our handling reference. No daily rate.',
  'hire.monitor': 'Weekly check-in with the client on hire: is the repair progressing, do they still need the car, any problem with it?',
  'money.chasers': 'Chase the at-fault insurer for payment of the payment pack.',
  'money.complaint': 'Raise a formal complaint about the unpaid claim (day 28).',
};

function recipientParty(env: Env, def: StepDef): string | null {
  if (def.action.kind !== 'draft') return null;
  const c = claimOf(env);
  if (def.action.recipient === 'client') return c.claimantId;
  if (def.action.recipient === 'at_fault_insurer') return c.atFaultInsurerId ?? null;
  return null;
}

function draftStep(env: Env, def: StepDef, st: StepState, opts: { missingInfo?: boolean; purpose?: string; actionCode?: string } = {}): StepRun {
  if (def.action.kind !== 'draft') return { stepId: def.id, action: 'draft', ok: false, note: 'not a draft step' };
  const actionCode = opts.actionCode ?? (def.id === 'money.chasers' ? (['CHASER_21', 'CHASER_14', 'CHASER_7'].find((c) => env.facts.playbook.some((a) => a.code === c)) ?? 'CHASER_7') : def.action.actionCode);
  const h: Handoff = {
    to: 'drafter',
    templateId: def.action.templateId,
    emailKind: def.action.emailKind,
    purpose: opts.purpose ?? PURPOSE[def.id] ?? def.title,
    recipientPartyId: recipientParty(env, def),
    replyToMessageId: null,
    actionCode,
    dueAt: st.dueAt ?? null,
  };
  const v = validateHandoff(env.ctx, env.claimId, h, { createdBy: AUTOPILOT_ACTOR, missingInfo: Boolean(opts.missingInfo), now: env.ctx.now() });
  if (!v.ok || !v.job) return { stepId: def.id, action: 'draft', ok: false, note: v.reason ?? 'the hand-off was refused' };
  if (v.ask || actionCode === CUSTOM_ACTION_CODE) return { stepId: def.id, action: 'draft', ok: false, note: 'custom action: asks the owner' };
  // Already asked for today, or an earlier draft for the same purpose is still being written, reviewed or waiting for the
  // owner: nothing to do (no duplicate draft, no repeated log line, no action budget used).
  if (v.job.idempotencyKey && draftInFlight(env.ctx, v.job.idempotencyKey)) return { stepId: def.id, action: 'none', ok: true, note: 'draft in progress' };
  const job = enqueueJob(env.ctx, { ...v.job, parentJobId: env.job.id, correlationId: env.job.correlationId });
  return { stepId: def.id, action: `draft:${actionCode ?? def.action.emailKind ?? def.action.templateId}`, ok: true, note: `draft.compose ${job.id}` };
}

const OPEN_OUTBOX = new Set(['draft', 'reviewing', 'awaiting_approval', 'held', 'queued', 'sending']);

/**
 * True when the drafter hand-off with this idempotency key (`draft.compose:<claim>:<purpose>:<day>`) already exists, or
 * an earlier day's hand-off for the same purpose is still running or produced a draft that is not sent, cancelled or
 * approved yet. Keeps a step that waits on the owner's approval from re-drafting every tick and every day.
 */
export function draftInFlight(ctx: AppContext, idempotencyKey: string): boolean {
  if (ctx.repos.getAgentJobByKey(ctx.db, idempotencyKey)) return true;
  const prefix = idempotencyKey.slice(0, idempotencyKey.lastIndexOf(':') + 1);
  if (!prefix) return false;
  const jobs = ctx.handle.sqlite
    .prepare(`SELECT status, result FROM agent_jobs WHERE type = 'draft.compose' AND substr(idempotency_key, 1, ?) = ? ORDER BY created_at DESC LIMIT 10`)
    .all(prefix.length, prefix) as Array<{ status: string; result: string | null }>;
  for (const j of jobs) {
    if (['queued', 'leased', 'waiting_usage', 'waiting_user'].includes(j.status)) return true;
    let drafts: Array<{ kind?: string; id?: string }> = [];
    try {
      drafts = ((j.result ? JSON.parse(j.result) : {}) as { drafts?: typeof drafts }).drafts ?? [];
    } catch {
      drafts = [];
    }
    for (const d of drafts) {
      if (!d.id) continue;
      if (d.kind === 'outbox') {
        const o = ctx.repos.getOutbox(ctx.db, d.id);
        if (o && OPEN_OUTBOX.has(o.status)) return true;
      } else {
        const doc = ctx.repos.getDocument(ctx.db, d.id);
        if (doc && (doc.status === 'draft' || doc.status === 'blocked' || doc.status === 'approved')) return true;
      }
    }
  }
  return false;
}

/** The email kind a covering email for an approved letter goes out as (auto-send kinds per §0.6 / SD §D.2). */
const LETTER_EMAIL_KIND: Record<string, EmailKind> = {
  'letter.ncaf': 'ncaf_cover',
  'letter.handling_ref_request': 'handling_ref_request',
  'letter.cctv_preservation': 'cctv_request',
  'letter.chaser_7': 'chaser',
  'letter.chaser_14': 'chaser',
  'letter.chaser_21': 'chaser',
  'letter.complaint_disp': 'complaint',
  'letter.intervention_reply': 'offer_response',
  'letter.supplier_instruction_engineer': 'supplier_instruction',
  'letter.recovery_storage_instruction': 'supplier_instruction',
};

/**
 * A letter step whose letter is drafted and approved (by the reviewer's allow-list or by the owner) but not sent yet:
 * email it to the recipient as `agent:autopilot` with the letter attached, through `email_draft` — the outbox decision
 * (review, allow-lists, first contact, hold window) decides whether it goes automatically or comes to the owner. Sending
 * marks the letter sent and records its event (e.g. `ncaf_sent`), which completes the step. Without an email address the
 * owner is asked to post it. Returns undefined when there is no approved letter waiting.
 */
async function sendApprovedLetter(env: Env, def: StepDef, st: StepState): Promise<StepRun | undefined> {
  if (def.action.kind !== 'draft' || !def.action.templateId) return undefined;
  const templateId = def.action.templateId;
  const doc = env.ctx.repos.listDocuments(env.ctx.db, { claimId: env.claimId, templateId, status: 'approved' }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (!doc) return undefined;
  const outbox = env.ctx.repos.listOutbox(env.ctx.db, { claimId: env.claimId }).filter((o) => (o.attachmentsJson ?? []).some((a) => a.documentId === doc.id) && o.status !== 'cancelled' && o.status !== 'failed');
  if (outbox.length) return { stepId: def.id, action: 'none', ok: true, note: 'letter email in progress' };
  const c = claimOf(env);
  const partyId = def.action.recipient === 'client' ? c.claimantId : def.action.recipient === 'at_fault_insurer' ? c.atFaultInsurerId : undefined;
  const party = partyId ? env.ctx.repos.getParty(env.ctx.db, partyId) : undefined;
  if (!party?.email) {
    const ny = raiseStepCard(env.ctx, env.claimId, def.id, 'owner_step', { summary: `"${doc.title}" is approved but there is no email address for the ${def.action.recipient.replace(/_/g, ' ')}. Post it (or add the address on the claim) and mark this step done.`, seq: `post:${doc.id}`, correlationId: env.job.correlationId, ...(st.dueAt ? { dueAt: st.dueAt } : {}) });
    return { stepId: def.id, action: 'needs_you:autopilot_step', ok: true, needsYouId: ny, note: 'no email address: post the letter' };
  }
  const kind = LETTER_EMAIL_KIND[templateId] ?? (def.action.recipient === 'client' ? 'client_update' : 'insurer_notice');
  const salutationTo = def.action.recipient === 'client' ? salutation(env.facts.bundle.claimant.name) : 'Sir or Madam';
  const res = await act(env, def.id, 'email_draft', {
    claimId: env.claimId,
    kind,
    to: [party.email],
    cc: null,
    subject: doc.title,
    bodyText: `Dear ${salutationTo},\n\nPlease find attached our ${doc.title.replace(/^./, (x) => x.toLowerCase())}.\n\nKind regards,\nClaims Team, Courtesy Cars Group UK Ltd`,
    attach: [{ evidenceId: null, documentId: doc.id }],
    inReplyToMessageId: null,
  });
  if (!res.ok) return { stepId: def.id, action: 'tool:email_draft', ok: false, runId: res.runId, note: `${errorOf(res).code}: ${errorOf(res).message}` };
  const outboxId = String(parse(res.content).outboxId ?? '');
  if (outboxId) env.ctx.repos.tagOutboxStep(env.ctx.db, outboxId, def.id);
  return { stepId: def.id, action: 'tool:email_draft:letter', ok: true, runId: res.runId, note: `${doc.title} emailed (${outboxId})` };
}

/** Code-built email (offer, booking update) drafted as agent:autopilot through email_draft (review + policy as usual). */
async function codeEmail(env: Env, stepId: AutopilotStepId, kind: 'hire_offer' | 'booking_update', email: { subject: string; bodyText: string }, step?: StepContext): Promise<{ ok: boolean; outboxId?: string; runId: string; note?: string }> {
  const to = env.facts.bundle.claimant.email;
  if (!to) return { ok: false, runId: '', note: 'no client email' };
  const res = await act(env, stepId, 'email_draft', { claimId: env.claimId, kind, to: [to], cc: null, subject: email.subject, bodyText: email.bodyText, attach: [], inReplyToMessageId: null }, step);
  if (!res.ok) return { ok: false, runId: res.runId, note: `${errorOf(res).code}: ${errorOf(res).message}` };
  const outboxId = String(parse(res.content).outboxId ?? '');
  if (outboxId) env.ctx.repos.tagOutboxStep(env.ctx.db, outboxId, stepId);
  return { ok: Boolean(outboxId), outboxId, runId: res.runId };
}

// ---------------------------------------------------------------------------
// Hire: search → choose → hold (§D.1)
// ---------------------------------------------------------------------------

function holdInput(env: Env, c: AvailabilityCandidate): Record<string, unknown> {
  const a = env.facts.availability!;
  return { claimId: env.claimId, fleetUnitId: c.fleetUnitId, use: a.use, startAt: a.period.startAt, expectedEndAt: a.period.expectedEndAt, rankingRef: `score ${Math.round(c.score)}` };
}

/** Hold a candidate (re-searching past a car taken a moment ago, max 2 retries in the tick). */
async function holdCandidate(env: Env, candidates: AvailabilityCandidate[], step: StepContext): Promise<{ ok: boolean; reservationId?: string; candidate?: AvailabilityCandidate; runId?: string; note?: string }> {
  let tries = 0;
  for (const c of candidates) {
    if (tries > 2) break;
    const res = await act(env, 'hire.hold', 'booking_hold', holdInput(env, c), step);
    if (res.ok) {
      const body = parse(res.content) as { reservation?: { id?: string } };
      return { ok: true, reservationId: body.reservation?.id, candidate: c, runId: res.runId };
    }
    const e = errorOf(res);
    if (e.code === 'RESERVATION_OVERLAP') {
      tries += 1;
      continue;
    }
    return { ok: false, note: `${e.code}: ${e.message}`, runId: res.runId };
  }
  return { ok: false, note: 'every candidate was taken a moment ago' };
}

function aiPaused(ctx: AppContext): boolean {
  const s = effectiveAgentSettings(ctx);
  if (s.ai.driver === 'off' || !s.agents.enabled || s.autonomy.killSwitch) return true;
  const pausedUntil = ctx.repos.getAiUsageState(ctx.db).pausedUntil;
  return Boolean(pausedUntil && Date.parse(pausedUntil) > Date.parse(ctx.now()));
}

export function raiseChooseCar(ctx: AppContext, claimId: string, f: AutopilotFacts, reasons: string[], opts: { recommendedUnitId?: string; why?: string; protectiveHoldId?: string; correlationId?: string } = {}): string {
  const ranked = f.availability?.ranked ?? [];
  const top = ranked.slice(0, 3);
  const rec = top.find((c) => c.fleetUnitId === opts.recommendedUnitId) ?? top[0];
  const ref = f.bundle.claim.reference;
  return createNeedsYou(ctx, {
    kind: 'choose_car',
    claimId,
    title: ranked.length ? `Choose the car for ${ref}` : `No car is free for ${ref}`,
    summary: (ranked.length
      ? `The autopilot ranked ${ranked.length} car${ranked.length === 1 ? '' : 's'}${opts.protectiveHoldId ? ' and is holding the top one so it is not taken' : ''}. It did not offer one by itself because: ${reasons.join(' ')}`
      : `No fleet car is free, legal and insured for the whole expected hire. ${f.availability?.explanation.slice(0, 3).join(' ') ?? ''}`
    ).slice(0, 2000),
    ...(rec ? { recommendation: { action: `Offer ${rec.registration}`, why: opts.why ?? rec.likeForLike.sentence, confidence: 0.7, basis: [{ kind: 'rule', id: 'autopilot.availability', label: 'Availability ranking (like for like, needs, readiness, cover, cost, distance)' }] } } : {}),
    options: [
      ...top.map((c) => ({ id: `unit:${c.fleetUnitId}`, label: `${c.registration} — ${c.label}${c === rec ? ' (recommended)' : ''}`, tone: c === rec ? ('primary' as const) : ('neutral' as const) })),
      { id: 'search_again', label: 'Search again (change needs or dates first)', tone: 'neutral' },
      { id: 'no_hire', label: 'No hire for this client', tone: 'danger', requiresReason: true },
    ],
    payload: { ranked: top.map((c) => ({ fleetUnitId: c.fleetUnitId, registration: c.registration, label: c.label, score: c.score, likeForLike: c.likeForLike.sentence, factors: c.factors, driverOutcome: c.driverOutcome, warnings: c.warnings.map((w) => w.message) })), reasons, excluded: (f.availability?.excluded ?? []).slice(0, 10), protectiveHoldId: opts.protectiveHoldId ?? null, period: f.availability?.period ?? null, link: `/claims/${claimId}?tab=autopilot` },
    priority: 'high',
    createdBy: AUTOPILOT_ACTOR,
    dedupeKey: `autopilot:${claimId}:hire.choose:${londonDay(ctx.now())}`,
    ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
  }).id;
}

async function runHireChoice(env: Env): Promise<StepRun> {
  const f = env.facts;
  const a = f.availability;
  if (!a) return { stepId: 'hire.search', action: 'search', ok: false, note: 'the availability search could not run' };
  const choose = env.plan.steps.find((s) => s.id === 'hire.choose')!;
  const search = env.plan.steps.find((s) => s.id === 'hire.search')!;
  // "Always ask me" on either step (or a not-green situation) sends the choice to the owner.
  const auto = choose.mode === 'auto' && search.mode === 'auto';
  if (!a.ranked.length) {
    const ny = raiseChooseCar(env.ctx, env.claimId, f, ['No car is available.'], { correlationId: env.job.correlationId });
    return { stepId: 'hire.choose', action: 'needs_you:choose_car', ok: true, needsYouId: ny, note: 'no car free' };
  }
  const holdStep: StepContext = { ...stepCtx(env.plan, 'hire.hold'), green: choose.green };
  if (choose.green && a.clearWinner && auto) {
    const h = await holdCandidate(env, a.ranked, holdStep);
    if (!h.ok && h.note?.startsWith('NEEDS_OWNER')) {
      // The autonomy policy (e.g. shadow mode) wants the owner for the hold itself: the owner chooses the car.
      const ny = raiseChooseCar(env.ctx, env.claimId, f, [`${h.note.replace(/^NEEDS_OWNER:\s*/, '').split(' Do not retry')[0]}`], { recommendedUnitId: a.ranked[0]!.fleetUnitId, correlationId: env.job.correlationId });
      return { stepId: 'hire.choose', action: 'needs_you:choose_car', ok: true, needsYouId: ny, note: 'the hold needs the owner' };
    }
    return { stepId: 'hire.choose', action: 'tool:booking_hold', ok: h.ok, ...(h.runId ? { runId: h.runId } : {}), note: h.ok ? `held ${h.candidate!.registration} (clear winner)` : h.note };
  }
  if (choose.green && !a.clearWinner && auto) {
    const deadline = choose.dueAt ? Date.parse(choose.dueAt) : NaN;
    if (aiPaused(env.ctx) && (!Number.isFinite(deadline) || deadline - Date.parse(env.ctx.now()) < DAY)) {
      // §A.7 deterministic fallback: the top-ranked car, in confirm mode.
      const h = env.facts.settings.green.protectiveHold ? await holdCandidate(env, a.ranked, holdStep) : { ok: false };
      const ny = raiseChooseCar(env.ctx, env.claimId, f, ['AI is paused, so the autopilot is not choosing between close candidates by itself.'], { ...(h.ok && 'reservationId' in h && h.reservationId ? { protectiveHoldId: h.reservationId } : {}), correlationId: env.job.correlationId });
      return { stepId: 'hire.choose', action: 'fallback:choose_car', ok: true, needsYouId: ny };
    }
    const options = a.ranked.slice(0, 3).map((c) => ({ id: `unit:${c.fleetUnitId}`, label: `${c.registration} — ${c.label}`, detail: `Score ${Math.round(c.score)}. ${c.likeForLike.sentence}`, recommended: c === a.ranked[0] }));
    const job = enqueueJob(env.ctx, {
      type: 'autopilot.judge',
      claimId: env.claimId,
      payload: { claimId: env.claimId, stepId: 'hire.choose', questionId: 'choose_car', options, planHash: env.plan.planHash },
      idempotencyKey: `autopilot.judge:${env.claimId}:hire.choose:${env.plan.planHash}`,
      parentJobId: env.job.id,
      correlationId: env.job.correlationId,
      createdBy: AUTOPILOT_ACTOR,
    });
    return { stepId: 'hire.choose', action: 'judge:choose_car', ok: true, note: `judge ${job.id}` };
  }
  // Not green (or set to ask): protective hold on the top car (setting, default on) + choose_car for the owner.
  const reasons = [...new Set([...choose.modeReasons, ...search.modeReasons])].filter((r) => !/always need you|person does/.test(r));
  if (!reasons.length) reasons.push('This step is set to ask you first.');
  let holdId: string | undefined;
  if (f.settings.green.protectiveHold && !liveReservation(f)) {
    const h = await holdCandidate(env, a.ranked, { ...holdStep, mode: 'auto' });
    if (h.ok) holdId = h.reservationId;
  }
  const ny = raiseChooseCar(env.ctx, env.claimId, f, reasons, { ...(holdId ? { protectiveHoldId: holdId } : {}), correlationId: env.job.correlationId });
  return { stepId: 'hire.choose', action: 'needs_you:choose_car', ok: true, needsYouId: ny, note: holdId ? 'protective hold placed' : undefined };
}

/** Apply a judged / chosen car: hold it (moving an existing hold). */
export async function holdChosenCar(ctx: AppContext, claimId: string, fleetUnitId: string, job: Pick<JobRecord, 'id' | 'correlationId'>): Promise<StepRun> {
  const { facts, plan } = evaluate(ctx, claimId);
  const env: Env = { ctx, job, facts, plan, claimId };
  const candidates = facts.availability?.ranked.filter((c) => c.fleetUnitId === fleetUnitId) ?? [];
  if (!candidates.length) return { stepId: 'hire.choose', action: 'hold', ok: false, note: 'the chosen car is no longer available' };
  const step = { ...stepCtx(plan, 'hire.hold'), green: plan.steps.find((s) => s.id === 'hire.choose')?.green ?? false };
  const h = await holdCandidate(env, candidates, step);
  return { stepId: 'hire.choose', action: 'tool:booking_hold', ok: h.ok, ...(h.runId ? { runId: h.runId } : {}), ...(h.note ? { note: h.note } : {}) };
}

// ---------------------------------------------------------------------------
// Hire: offer → acceptance → confirm → delivery
// ---------------------------------------------------------------------------

async function runOffer(env: Env, st: StepState): Promise<StepRun> {
  const r = liveReservation(env.facts);
  if (!r || r.status !== 'held') return { stepId: 'hire.offer', action: 'offer', ok: false, note: 'no held car' };
  const delivery = Boolean(deliveryOf(env.ctx, r.id));
  const email = buildHireOfferEmail({ salutationName: salutation(env.facts.bundle.claimant.name), delivery });
  const step: StepContext = { id: 'hire.offer', mode: st.mode, green: st.green };
  const drafted = await codeEmail(env, 'hire.offer', 'hire_offer', email, step);
  if (!drafted.ok || !drafted.outboxId) return { stepId: 'hire.offer', action: 'tool:email_draft', ok: false, ...(drafted.runId ? { runId: drafted.runId } : {}), note: drafted.note };
  const alternatives = (env.facts.availability?.ranked ?? r.ranking ? (env.facts.availability?.ranked ?? []) : [])
    .filter((c) => c.fleetUnitId !== r.fleetUnitId)
    .slice(0, env.facts.settings.booking.alternativesShown)
    .map((c) => c.fleetUnitId);
  const res = await act(env, 'hire.offer', 'hire_offer_prepare', { claimId: env.claimId, reservationId: r.id, outboxId: drafted.outboxId, alternatives }, step);
  return { stepId: 'hire.offer', action: 'tool:hire_offer_prepare', ok: res.ok, runId: res.runId, note: res.ok ? `offer email ${drafted.outboxId}` : `${errorOf(res).code}: ${errorOf(res).message}` };
}

const lc = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** Inbound messages on the claim that answer the current offer and have not been handled yet. */
function offerReplies(env: Env, offer: HireOffer): Array<{ id: string; fromAddr: string; text: string; fromClient: boolean }> {
  if (!offer.sentAt) return [];
  const ob = offer.outboxId ? env.ctx.repos.getOutbox(env.ctx.db, offer.outboxId) : undefined;
  const handled = new Set(env.ctx.repos.listAutopilotLog(env.ctx.db, { claimId: env.claimId, stepId: 'hire.acceptance' }).map((e) => (e.action?.startsWith('reply:') ? e.action.slice(6) : '')));
  const client = lc(env.facts.bundle.claimant.email);
  const ref = env.facts.bundle.claim.reference.toUpperCase();
  const out: Array<{ id: string; fromAddr: string; text: string; fromClient: boolean }> = [];
  for (const m of env.ctx.repos.listMailMessages(env.ctx.db, { claimId: env.claimId, direction: 'in', limit: 50 })) {
    if (handled.has(m.id)) continue;
    if (Date.parse(m.receivedAt) <= Date.parse(offer.sentAt)) continue;
    const threads = [m.inReplyTo, ...(m.referencesJson ?? [])].filter(Boolean) as string[];
    const hit = (ob?.smtpMessageId && threads.includes(ob.smtpMessageId)) || ((m.subject ?? '').toUpperCase().includes(ref) && /replacement car/i.test(m.subject ?? ''));
    if (!hit) continue;
    out.push({ id: m.id, fromAddr: m.fromAddr ?? '', text: m.bodyText ?? '', fromClient: lc(m.fromAddr) === client || lc(m.replyTo) === client });
  }
  return out.reverse();
}

async function runAcceptance(env: Env): Promise<StepRun> {
  const offer = currentOffer(env.facts);
  if (!offer) return { stepId: 'hire.acceptance', action: 'acceptance', ok: false, note: 'no offer' };
  const replies = offerReplies(env, offer);
  for (const m of replies) {
    log(env, 'hire.acceptance', { toStatus: 'in_progress', action: `reply:${m.id}` });
    if (!m.fromClient) {
      const ny = raiseStepCard(env.ctx, env.claimId, 'hire.acceptance', 'reply_other_sender', { title: 'Someone else replied to the hire offer', summary: `A reply to the offer of ${offer.terms.registration} came from ${m.fromAddr}, not the client's address on file. Decide whether it is the client's answer.`, hireOfferId: offer.id, messageId: m.id, seq: m.id, correlationId: env.job.correlationId });
      return { stepId: 'hire.acceptance', action: 'needs_you:reply_other_sender', ok: true, needsYouId: ny };
    }
    const parsed = parseHireReplyCode(m.text);
    if (parsed) {
      const res = await act(env, 'hire.acceptance', 'hire_acceptance_record', { hireOfferId: offer.id, decision: parsed.decision, messageId: m.id, chosenFleetUnitId: null, confidence: parsed.confidence });
      return { stepId: 'hire.acceptance', action: 'tool:hire_acceptance_record', ok: res.ok, runId: res.runId, note: res.ok ? `${parsed.decision} (read by code: "${parsed.line.slice(0, 60)}")` : errorOf(res).message };
    }
    const job = enqueueJob(env.ctx, {
      type: 'hire_offer.parse_reply',
      claimId: env.claimId,
      payload: { claimId: env.claimId, hireOfferId: offer.id, messageId: m.id },
      idempotencyKey: `hire_offer.parse_reply:${m.id}`,
      parentJobId: env.job.id,
      correlationId: env.job.correlationId,
      createdBy: AUTOPILOT_ACTOR,
    });
    return { stepId: 'hire.acceptance', action: 'judge:parse_reply', ok: true, note: `parse_reply ${job.id}` };
  }
  if (offer.status === 'accepted') return { stepId: 'hire.acceptance', action: 'none', ok: true };
  return { stepId: 'hire.acceptance', action: 'none', ok: true, note: 'waiting for the client' };
}

function ensureCallTask(env: Env, note: string): void {
  const open = env.ctx.repos.listTasks(env.ctx.db, { claimId: env.claimId, status: 'open', limit: 200 }).some((t) => t.kind === 'call' && t.note === note);
  if (open) return;
  env.ctx.repos.createTask(env.ctx.db, { claimId: env.claimId, kind: 'call', title: note.slice(0, 120), note, dueAt: env.ctx.now(), createdBy: AUTOPILOT_ACTOR, now: env.ctx.now() });
}

/** Offer reminder (§D.4): once, `offerReminderHours` after the offer went out, while it is still open. */
async function offerReminder(env: Env): Promise<StepRun | undefined> {
  const offer = currentOffer(env.facts);
  if (!offer || offer.status !== 'sent' || !offer.sentAt) return undefined;
  const now = Date.parse(env.ctx.now());
  if (now < Date.parse(offer.sentAt) + env.facts.settings.booking.offerReminderHours * HOUR || now >= Date.parse(offer.expiresAt)) return undefined;
  if (env.ctx.repos.listAutopilotLog(env.ctx.db, { claimId: env.claimId, stepId: 'hire.acceptance', action: `reminder:${offer.id}` }).length) return undefined;
  if (offerReplies(env, offer).length) return undefined;
  const email = buildBookingUpdateEmail({ salutationName: salutation(env.facts.bundle.claimant.name), kind: 'reminder' });
  const d = await codeEmail(env, 'hire.acceptance', 'booking_update', email, stepCtx(env.plan, 'hire.acceptance'));
  log(env, 'hire.acceptance', { toStatus: 'waiting', action: `reminder:${offer.id}`, ...(d.runId ? { runId: d.runId } : {}), note: d.ok ? `reminder ${d.outboxId}` : d.note });
  return { stepId: 'hire.acceptance', action: 'reminder', ok: d.ok, ...(d.runId ? { runId: d.runId } : {}) };
}

/** An offer that expired unanswered (§D.4): once, a card to call the client plus a call task. */
function expiredOffer(env: Env): StepRun | undefined {
  const offer = currentOffer(env.facts);
  if (!offer || offer.status !== 'expired') return undefined;
  if (env.ctx.repos.listAutopilotLog(env.ctx.db, { claimId: env.claimId, stepId: 'hire.acceptance', action: `expired:${offer.id}` }).length) return undefined;
  const ny = raiseStepCard(env.ctx, env.claimId, 'hire.acceptance', 'offer_expired', {
    title: `Client has not replied — call them? (${env.facts.bundle.claim.reference})`,
    summary: `The offer of ${offer.terms.registration} expired with no answer and the hold has run out. Call the client: if they still want the car, record it here and the autopilot re-holds it if it is still free (or finds another).`,
    hireOfferId: offer.id,
    seq: offer.id,
    correlationId: env.job.correlationId,
  });
  ensureCallTask(env, `Call the client about the replacement car ${offer.terms.registration} — the offer expired without an answer.`);
  log(env, 'hire.acceptance', { toStatus: 'waiting', action: `expired:${offer.id}`, needsYouId: ny });
  return { stepId: 'hire.acceptance', action: 'needs_you:offer_expired', ok: true, needsYouId: ny };
}

async function runConfirm(env: Env): Promise<StepRun> {
  const offer = currentOffer(env.facts);
  const reservationId = offer?.reservationId ?? liveReservation(env.facts)?.id;
  if (!reservationId) return { stepId: 'hire.confirm', action: 'confirm', ok: false, note: 'no booking' };
  const res = await act(env, 'hire.confirm', 'booking_confirm', { reservationId, hireOfferId: offer?.status === 'accepted' ? offer.id : null });
  if (!res.ok && errorOf(res).code === 'HOLD_EXPIRED') {
    const facts = evaluate(env.ctx, env.claimId).facts;
    const ny = raiseChooseCar(env.ctx, env.claimId, facts, [`The client said yes, but the hold had expired and ${offer?.terms.registration ?? 'the car'} was taken in the meantime. Choose another car.`], { correlationId: env.job.correlationId });
    return { stepId: 'hire.confirm', action: 'needs_you:choose_car', ok: true, runId: res.runId, needsYouId: ny };
  }
  if (res.ok && !env.facts.bundle.events.some((e) => e.type === 'services_agreed')) {
    // §D.7: the GTA 4.1 clock starts from a recorded event — services agreed when the booking is confirmed (if not
    // signed earlier). Recorded by code (event_append does not take this type from agents), audited as the autopilot.
    const now = env.ctx.now();
    const ev = env.ctx.repos.appendEvent(env.ctx.db, { claimId: env.claimId, type: 'services_agreed', at: now, summary: 'Services agreed: the client accepted the replacement car and the booking is confirmed', data: { reservationId, hireOfferId: offer?.id ?? null }, attributableTo: 'client', createdBy: AUTOPILOT_ACTOR, recordedAt: now });
    env.ctx.repos.appendAudit(env.ctx.db, { actor: { userId: AUTOPILOT_ACTOR, runId: res.runId }, action: 'event.append', entity: 'claim_events', entityId: ev.id, after: { claimId: env.claimId, type: 'services_agreed', reason: 'booking confirmed after the client accepted the offer' }, at: now });
  }
  return { stepId: 'hire.confirm', action: 'tool:booking_confirm', ok: res.ok, runId: res.runId, ...(res.ok ? {} : { note: `${errorOf(res).code}: ${errorOf(res).message}` }) };
}

function slotFor(env: Env, earliest: ISODateTime, readyBy: ISODateTime): { windowStart: string; windowEnd: string } | undefined {
  const s = env.facts.settings.booking;
  const existing = env.ctx.repos.listMovements(env.ctx.db, { status: ['planned', 'confirmed'] });
  return proposeSlots({ earliest, readyBy, businessHours: s.businessHours, windowMinutes: s.windowMinutes, leadMinutes: s.leadMinutes, existing, maxPerWindow: s.maxPerWindow }, 1)[0];
}

async function bindNotice(env: Env, stepId: AutopilotStepId, m: Movement, kind: 'delivery' | 'collection'): Promise<StepRun> {
  const email = buildBookingUpdateEmail({ salutationName: salutation(env.facts.bundle.claimant.name), kind });
  const d = await codeEmail(env, stepId, 'booking_update', email);
  if (d.ok && d.outboxId) env.ctx.repos.updateMovement(env.ctx.db, m.id, { noticeOutboxId: d.outboxId });
  return { stepId, action: `tool:movement_schedule+email`, ok: d.ok, ...(d.runId ? { runId: d.runId } : {}), note: d.ok ? `${kind} ${m.windowStart}; notice ${d.outboxId}` : d.note };
}

async function runDelivery(env: Env): Promise<StepRun> {
  const r = activeReservation(env.facts);
  if (!r || r.status !== 'confirmed') return { stepId: 'hire.delivery', action: 'delivery', ok: false, note: 'no confirmed booking' };
  let m = deliveryOf(env.ctx, r.id);
  if (!m) {
    const readyBy = r.ranking?.readyBy ?? env.ctx.now();
    const earliest = Date.parse(r.startAt) > Date.parse(env.ctx.now()) ? r.startAt : env.ctx.now();
    const slot = slotFor(env, earliest, readyBy);
    if (!slot) return { stepId: 'hire.delivery', action: 'delivery', ok: false, note: 'no delivery slot free in the next weeks' };
    const res = await act(env, 'hire.delivery', 'movement_schedule', { reservationId: r.id, kind: 'delivery', windowStart: slot.windowStart, windowEnd: slot.windowEnd, address: env.facts.needs?.deliveryAddress ? 'delivery_address' : 'client_home' });
    if (!res.ok) return { stepId: 'hire.delivery', action: 'tool:movement_schedule', ok: false, runId: res.runId, note: `${errorOf(res).code}: ${errorOf(res).message}` };
    m = deliveryOf(env.ctx, r.id);
    if (!m) return { stepId: 'hire.delivery', action: 'tool:movement_schedule', ok: false, note: 'the delivery was not recorded' };
  }
  if (m.noticeOutboxId) {
    const ob = env.ctx.repos.getOutbox(env.ctx.db, m.noticeOutboxId);
    if (ob && !['cancelled', 'failed'].includes(ob.status)) return { stepId: 'hire.delivery', action: 'none', ok: true, note: 'notice already drafted' };
  }
  return bindNotice(env, 'hire.delivery', m, 'delivery');
}

async function runCollection(env: Env): Promise<StepRun> {
  const r = activeReservation(env.facts);
  if (!r || r.status !== 'on_hire') return { stepId: 'hire.offhire', action: 'collection', ok: false, note: 'no car on hire' };
  const trig = offHireTrigger(env.facts);
  if (!trig) return { stepId: 'hire.offhire', action: 'collection', ok: false, note: 'no off-hire trigger' };
  const deadline = new Date(Date.parse(offHireDeadline(trig.trigger, trig.at).dueAt)).toISOString();
  if (!r.expectedEndAt || Math.abs(Date.parse(r.expectedEndAt) - Date.parse(deadline)) > 60_000) {
    const res = await act(env, 'hire.offhire', 'booking_update_period', { reservationId: r.id, expectedEndAt: deadline, reason: `Off-hire trigger (${trig.trigger.replace(/_/g, ' ')}) recorded: the hire ends by the deadline` });
    if (!res.ok) return { stepId: 'hire.offhire', action: 'tool:booking_update_period', ok: false, runId: res.runId, note: `${errorOf(res).code}: ${errorOf(res).message}` };
  }
  let m = env.ctx.repos.listMovements(env.ctx.db, { reservationId: r.id, status: ['planned', 'confirmed'] }).find((x) => x.kind === 'collection');
  if (!m) {
    const earliest = env.ctx.now();
    let slot = slotFor(env, earliest, earliest);
    // Keep the collection before the deadline where a slot allows; otherwise the first slot after it (the return dialog warns).
    if (slot && Date.parse(slot.windowStart) > Date.parse(deadline)) slot = slotFor(env, earliest, earliest) ?? slot;
    if (!slot) return { stepId: 'hire.offhire', action: 'collection', ok: false, note: 'no collection slot free' };
    const res = await act(env, 'hire.offhire', 'movement_schedule', { reservationId: r.id, kind: 'collection', windowStart: slot.windowStart, windowEnd: slot.windowEnd, address: env.facts.needs?.deliveryAddress ? 'delivery_address' : 'client_home' });
    if (!res.ok) return { stepId: 'hire.offhire', action: 'tool:movement_schedule', ok: false, runId: res.runId, note: `${errorOf(res).code}: ${errorOf(res).message}` };
    m = env.ctx.repos.listMovements(env.ctx.db, { reservationId: r.id, status: ['planned', 'confirmed'] }).find((x) => x.kind === 'collection');
    if (!m) return { stepId: 'hire.offhire', action: 'collection', ok: false, note: 'the collection was not recorded' };
  }
  if (m.noticeOutboxId) return { stepId: 'hire.offhire', action: 'none', ok: true };
  return bindNotice(env, 'hire.offhire', m, 'collection');
}

// ---------------------------------------------------------------------------
// Other steps
// ---------------------------------------------------------------------------

async function runTool(env: Env, def: StepDef, st: StepState): Promise<StepRun> {
  const c = claimOf(env);
  switch (def.id) {
    case 'intake.cross_file': {
      const res = await act(env, def.id, 'clash_check', { claimId: env.claimId, fleetUnitId: null, startAt: null, expectedEndAt: null });
      return { stepId: def.id, action: 'tool:clash_check', ok: res.ok, runId: res.runId };
    }
    case 'qualify.acceptance':
    case 'qualify.driver': {
      const res = await act(env, def.id, 'eligibility_assess', { claimId: env.claimId });
      if (res.ok && def.id === 'qualify.acceptance' && !res.needsYouId) {
        // The acceptance decision is computed by code (assessAcceptance) and recorded with the assessment.
        const bundle = env.facts.bundle;
        recordAcceptance(env.ctx, env.claimId, acceptanceFor(env.ctx, bundle, gatesFor(bundle)) as unknown as { decision: string } & Record<string, unknown>, AUTOPILOT_ACTOR);
      }
      return { stepId: def.id, action: 'tool:eligibility_assess', ok: res.ok, runId: res.runId, ...(res.needsYouId ? { needsYouId: res.needsYouId } : {}) };
    }
    case 'intake.injury_referral': {
      const res = await act(env, def.id, 'legal_escalate', {
        claimId: env.claimId,
        matter: 'injury',
        summary: `The client reported injuries in the accident on ${c.accident.occurredAt.slice(0, 10)}. The injury claim must be referred out (no referral fee) before anything else is said about it.`,
        recommendation: 'Refer the injury element to a solicitor of the client’s choice and record the referral on the claim.',
        draftRefs: [],
      });
      return { stepId: def.id, action: 'tool:legal_escalate', ok: res.ok, runId: res.runId, ...(res.needsYouId ? { needsYouId: res.needsYouId } : {}) };
    }
    case 'status.sync': {
      const status = statusTarget({ ...env.facts, stage: env.plan.stage } as AutopilotFacts & { stage: typeof env.plan.stage });
      if (!status) return { stepId: def.id, action: 'none', ok: true };
      const res = await act(env, def.id, 'claim_status_set', { claimId: env.claimId, status });
      return { stepId: def.id, action: `tool:claim_status_set:${status}`, ok: res.ok, runId: res.runId, ...(res.ok ? {} : { note: errorOf(res).message }) };
    }
    case 'hire.search':
    case 'hire.choose':
    case 'hire.hold':
      return runHireChoice(env);
    case 'hire.offer':
      return runOffer(env, st);
    case 'hire.confirm':
      return runConfirm(env);
    case 'hire.delivery':
      return runDelivery(env);
    case 'hire.offhire':
      return runCollection(env);
    default:
      return { stepId: def.id, action: 'none', ok: true };
  }
}

async function runPack(env: Env, def: StepDef): Promise<StepRun> {
  if (def.action.kind !== 'pack') return { stepId: def.id, action: 'pack', ok: false };
  const stage = def.action.stage;
  const reservationId = stage === 'hire_start' || stage === 'off_hire' ? (activeReservation(env.facts)?.id ?? null) : null;
  const res = await act(env, def.id, 'pack_prepare', { claimId: env.claimId, stage, reservationId });
  const out: StepRun = { stepId: def.id, action: `tool:pack_prepare:${stage}`, ok: res.ok, runId: res.runId };
  if (res.ok && def.id === 'money.invoices') {
    // §D.8: the claimed hire figure is proposed for the owner to write (money always asks).
    for (const h of env.facts.bundle.hire.filter((x) => x.endAt)) {
      if (env.facts.bundle.ledger.some((e) => e.head === 'hire' && e.kind === 'claimed')) break;
      try {
        const calc = calculateHire(h);
        await act(env, def.id, 'ledger_propose', { claimId: env.claimId, kind: 'claimed', head: 'hire', amountPence: Math.max(1, calc.grossPence), basis: [{ kind: 'rule', id: 'calculateHire', label: `${calc.days} days at the agreement rate, VAT included (agreement ${h.agreementNumber})` }] });
      } catch (err) {
        env.ctx.logger.warn('autopilot: hire calculation failed', { claimId: env.claimId, error: String(err) });
      }
    }
  }
  return out;
}

async function runJudgeStep(env: Env, def: StepDef): Promise<StepRun> {
  if (def.id === 'hire.choose') return runHireChoice(env);
  if (def.id === 'hire.acceptance') return runAcceptance(env);
  if (def.id === 'vehicle.repair_track') {
    const msg = env.facts.lastInbound;
    if (!msg) return { stepId: def.id, action: 'none', ok: true };
    log(env, def.id, { toStatus: 'in_progress', action: `seen:${msg.messageId}` });
    const options = [
      { id: 'repair_started', label: 'The repair has started', detail: 'append repair_started', recommended: false },
      { id: 'repair_delay', label: 'The repair is delayed', detail: 'append repair_delay', recommended: false },
      { id: 'repair_completed', label: 'The repair is complete', detail: 'append repair_completed (starts the off-hire clock)', recommended: false },
      { id: 'no_change', label: 'Nothing new about the repair', detail: 'no event', recommended: true },
    ];
    const job = enqueueJob(env.ctx, {
      type: 'autopilot.judge',
      claimId: env.claimId,
      payload: { claimId: env.claimId, stepId: def.id, questionId: 'repair_status_from_message', options, planHash: env.plan.planHash, messageId: msg.messageId },
      idempotencyKey: `autopilot.judge:${env.claimId}:${def.id}:${msg.messageId}`,
      parentJobId: env.job.id,
      correlationId: env.job.correlationId,
      createdBy: AUTOPILOT_ACTOR,
    });
    return { stepId: def.id, action: 'judge:repair_status_from_message', ok: true, note: `judge ${job.id}` };
  }
  return { stepId: def.id, action: 'none', ok: true };
}

/** Run one due step in its effective mode (§A.7 step 4). */
export async function executeStep(env: Env, st: StepState): Promise<StepRun> {
  const run = await executeStepOnce(env, st);
  if (run.ok || !run.note?.startsWith('NEEDS_OWNER')) return run;
  // The autonomy policy wants the owner for this action (e.g. shadow mode): tell the owner instead of retrying.
  const reason = run.note.replace(/^NEEDS_OWNER:\s*/, '').split(' Do not retry')[0];
  const ny = raiseStepCard(env.ctx, env.claimId, st.id, 'owner_step', { summary: `${OWNER_TEXT[st.id] ?? `The autopilot could not do "${stepDef(st.id).title}" by itself.`} ${reason}`, correlationId: env.job.correlationId });
  return { ...run, needsYouId: ny };
}

async function executeStepOnce(env: Env, st: StepState): Promise<StepRun> {
  const def = stepDef(st.id);
  if (st.mode === 'owner' && def.performer === 'person') {
    const ny = raiseStepCard(env.ctx, env.claimId, def.id, 'owner_step', { ...(st.dueAt ? { dueAt: st.dueAt } : {}), correlationId: env.job.correlationId, ...(st.refs.reservationId ? { reservationId: st.refs.reservationId } : {}) });
    return { stepId: def.id, action: 'needs_you:autopilot_step', ok: true, needsYouId: ny };
  }
  switch (def.action.kind) {
    case 'draft':
      return (await sendApprovedLetter(env, def, st)) ?? draftStep(env, def, st);
    case 'pack':
      return runPack(env, def);
    case 'tool':
      if (st.mode === 'owner') {
        const ny = raiseStepCard(env.ctx, env.claimId, def.id, 'owner_step', { correlationId: env.job.correlationId });
        return { stepId: def.id, action: 'needs_you:autopilot_step', ok: true, needsYouId: ny };
      }
      return runTool(env, def, st);
    case 'judge':
      return runJudgeStep(env, def);
    case 'needs_you': {
      if (def.action.needsYouKind === 'offer_decision' || def.action.needsYouKind === 'money' || def.action.needsYouKind === 'new_claim') {
        // These cards are raised by their own flows (offer.analyse, payment_received_propose, intake); the owner decides.
        const ny = raiseStepCard(env.ctx, env.claimId, def.id, 'owner_step', { correlationId: env.job.correlationId });
        return { stepId: def.id, action: 'needs_you:autopilot_step', ok: true, needsYouId: ny };
      }
      const ny = raiseStepCard(env.ctx, env.claimId, def.id, st.mode === 'owner' ? 'owner_step' : 'confirm_step', { ...(st.modeReasons.length ? { summary: `${OWNER_TEXT[def.id] ?? def.title}${st.modeReasons.length ? ` (${st.modeReasons.join('; ')})` : ''}` } : {}), correlationId: env.job.correlationId });
      return { stepId: def.id, action: 'needs_you:autopilot_step', ok: true, needsYouId: ny };
    }
    case 'status':
    case 'none':
      return { stepId: def.id, action: 'none', ok: true };
  }
}

/** A blocked step whose requirement we ask the client for: one prepared request every 3 days at most. */
function missingInfo(env: Env, st: StepState): StepRun | undefined {
  const req = st.blockedBy.find((b) => b.kind === 'requirement');
  if (!req) return undefined;
  const last = env.ctx.repos.listAutopilotLog(env.ctx.db, { claimId: env.claimId, stepId: st.id, action: 'missing_info', order: 'desc', limit: 1 })[0];
  if (last && Date.parse(env.ctx.now()) - Date.parse(last.at) < 3 * DAY) return undefined;
  if (!env.facts.bundle.claimant.email) return undefined;
  const def = stepDef(st.id);
  const h: Handoff = {
    to: 'drafter',
    templateId: null,
    emailKind: 'doc_request',
    purpose: `Ask the client for ${st.missing.join('; ')} — needed for "${def.title}". Plain and short; say why we need it.`,
    recipientPartyId: env.facts.bundle.claim.claimantId,
    replyToMessageId: null,
    actionCode: st.id === 'qualify.driver' ? 'DRIVER_ELIGIBILITY' : 'CHECK_NEED',
    dueAt: null,
  };
  const v = validateHandoff(env.ctx, env.claimId, h, { createdBy: AUTOPILOT_ACTOR, missingInfo: true, now: env.ctx.now() });
  if (!v.ok || !v.job) return { stepId: st.id, action: 'missing_info', ok: false, note: v.reason };
  enqueueJob(env.ctx, { ...v.job, parentJobId: env.job.id, correlationId: env.job.correlationId });
  log(env, st.id, { toStatus: 'blocked', action: 'missing_info', note: st.missing.join('; ') });
  return { stepId: st.id, action: 'missing_info', ok: true };
}

function loopGuardTripped(env: Env, stepId: AutopilotStepId): boolean {
  const s = env.facts.settings.loopGuard;
  const since = new Date(Date.parse(env.ctx.now()) - s.hours * HOUR).toISOString();
  const fails = env.ctx.repos.listAutopilotLog(env.ctx.db, { claimId: env.claimId, stepId, from: since }).filter((e) => e.toStatus === 'failed').length;
  if (fails < s.repeats) return false;
  createNeedsYou(env.ctx, {
    kind: 'failure',
    claimId: env.claimId,
    title: `Autopilot stopped retrying "${stepTitle(stepId)}"`,
    summary: `The step failed ${fails} times in ${s.hours} hours. The autopilot will not try it again until you look at it (Autopilot tab → the step → Run now, Skip or Mark done).`,
    payload: { stepId, link: `/claims/${env.claimId}?tab=autopilot` },
    priority: 'high',
    createdBy: AUTOPILOT_ACTOR,
    dedupeKey: `autopilot:${env.claimId}:${stepId}:loop_guard`,
    correlationId: env.job.correlationId,
  });
  return true;
}

// ---------------------------------------------------------------------------
// tick / sweep
// ---------------------------------------------------------------------------

/** Why the runner does not act on a claim now (null = it may act). */
export function stopReason(ctx: AppContext, f: AutopilotFacts): string | null {
  const s = effectiveAgentSettings(ctx);
  if (s.autonomy.killSwitch) return 'kill switch';
  if (!f.settings.enabled) return 'Autopilot switched off in Settings';
  if (f.claimAutopilot.mode !== 'on') return `Autopilot ${f.claimAutopilot.mode} on this claim`;
  if (f.agentPaused) return 'agents paused on this claim';
  if (!s.agents.enabled || s.ai.driver === 'off') return 'agents are switched off in Settings > AI';
  const st = f.bundle.claim.status;
  if (st === 'declined' || st === 'closed' || st === 'settled') return `claim ${st}`;
  return null;
}

/** Evaluate, log the changes and store the plan (no action). */
export function evaluateAndStore(ctx: AppContext, claimId: string, opts: { jobId?: string; forceStepId?: AutopilotStepId } = {}): { facts: AutopilotFacts; plan: AutopilotPlan } {
  const before = claimAutopilotFor(ctx, claimId).plan;
  const r = evaluate(ctx, claimId, opts.forceStepId ? { forceStepId: opts.forceStepId } : {});
  const now = ctx.now();
  for (const t of diffPlans(before, r.plan)) {
    ctx.repos.appendAutopilotLog(ctx.db, { claimId, stepId: t.stepId, ...(t.from ? { fromStatus: t.from } : {}), toStatus: t.to, actor: AUTOPILOT_ACTOR, ...(opts.jobId ? { jobId: opts.jobId } : {}), refs: t.refs, at: now });
  }
  ctx.repos.saveAutopilotPlan(ctx.db, claimId, r.plan, now);
  return r;
}

export async function runTick(ctx: AppContext, job: JobRecord, payload: TickPayload): Promise<JobOutcome<TickResult>> {
  const claimId = payload.claimId;
  if (!ctx.repos.getClaim(ctx.db, claimId)) return { kind: 'done', result: { claimId, stage: 'unknown', planHash: '', acted: [], skipped: 'claim not found' } };
  syncHireOffers(ctx, claimId);
  const forceStepId = payload.forceStepId && stepIdOk(payload.forceStepId) ? payload.forceStepId : undefined;
  let { facts, plan } = evaluateAndStore(ctx, claimId, { jobId: job.id, ...(forceStepId ? { forceStepId } : {}) });
  const stop = stopReason(ctx, facts);
  if (stop) return { kind: 'done', result: { claimId, stage: plan.stage, planHash: plan.planHash, acted: [], skipped: stop } };
  const env: Env = { ctx, job, facts, plan, claimId };
  const acted: StepRun[] = [];
  const reminder = await offerReminder(env);
  if (reminder) acted.push(reminder);
  const expired = expiredOffer(env);
  if (expired) acted.push(expired);
  // A reply to the offer is read as soon as it arrives — also after the hold expired (a late "yes" re-holds the car).
  const live = currentOffer(env.facts);
  if (live && (live.status === 'sent' || live.status === 'expired') && offerReplies(env, live).length) {
    const run = await runAcceptance(env);
    acted.push(run);
    log(env, 'hire.acceptance', { toStatus: run.ok ? 'in_progress' : 'failed', action: run.action, ...(run.runId ? { runId: run.runId } : {}), ...(run.needsYouId ? { needsYouId: run.needsYouId } : {}), ...(run.note ? { note: run.note } : {}) });
    ({ facts, plan } = evaluateAndStore(ctx, claimId, { jobId: job.id }));
    env.facts = facts;
    env.plan = plan;
  }
  const max = Math.max(1, facts.settings.maxActionsPerTick);
  const attempted = new Set<string>();
  for (;;) {
    if (acted.length >= max) break;
    const id = env.plan.due.find((d) => !attempted.has(d));
    if (!id) break;
    attempted.add(id);
    const st = env.plan.steps.find((s) => s.id === id)!;
    if (loopGuardTripped(env, id)) continue;
    let run: StepRun;
    try {
      run = await executeStep(env, st);
    } catch (err) {
      run = { stepId: id, action: 'error', ok: false, note: err instanceof Error ? err.message : String(err) };
    }
    if (run.action === 'none' && run.ok) continue;
    acted.push(run);
    log(env, run.stepId, { toStatus: run.ok ? 'in_progress' : 'failed', action: run.action, ...(run.runId ? { runId: run.runId } : {}), ...(run.needsYouId ? { needsYouId: run.needsYouId } : {}), ...(run.note ? { note: run.note } : {}), refs: st.refs as never });
    // Re-plan after a hire action so the next due steps see the hold / offer (one claim, same tick).
    if (run.ok && /booking_hold|booking_confirm|hire_acceptance_record|hire_offer_prepare|movement_schedule|eligibility_assess/.test(run.action)) {
      ({ facts, plan } = evaluateAndStore(ctx, claimId, { jobId: job.id }));
      env.facts = facts;
      env.plan = plan;
    }
  }
  for (const st of env.plan.steps.filter((s) => s.status === 'blocked' && s.mode !== 'owner')) {
    if (acted.length >= max) break;
    const run = missingInfo(env, st);
    if (run) acted.push(run);
  }
  if (acted.length) ({ plan } = evaluateAndStore(ctx, claimId, { jobId: job.id }));
  return { kind: 'done', result: { claimId, stage: plan.stage, planHash: plan.planHash, acted } };
}

const stepIdOk = (id: string): id is AutopilotStepId => {
  try {
    stepDef(id);
    return true;
  } catch {
    return false;
  }
};

/**
 * autopilot.sweep (every 5 min): ticks for claims whose next check is due, never evaluated, or with mail, events,
 * outbox or bookings changed since their last evaluation. Installs the Autopilot on first run (§K).
 */
export function runSweep(ctx: AppContext, job: JobRecord): { queued: number; claims: string[] } {
  ensureAutopilotInstalled(ctx);
  const now = ctx.now();
  const ids = new Set<string>();
  // claims with no Autopilot row yet (created since the install) → create the row and tick
  for (const r of ctx.handle.sqlite.prepare(`SELECT c.id FROM claims c LEFT JOIN claim_autopilot a ON a.claim_id = c.id WHERE a.claim_id IS NULL AND c.status NOT IN ('closed','settled','declined')`).all() as Array<{ id: string }>) {
    claimAutopilotFor(ctx, r.id);
    ids.add(r.id);
  }
  for (const r of ctx.repos.listClaimAutopilotDue(ctx.db, now)) ids.add(r.claimId);
  const changed = ctx.handle.sqlite
    .prepare(
      `SELECT a.claim_id AS id FROM claim_autopilot a WHERE a.mode IN ('on','paused') AND a.last_evaluated_at IS NOT NULL AND (
         EXISTS (SELECT 1 FROM claim_events e WHERE e.claim_id = a.claim_id AND e.recorded_at > a.last_evaluated_at)
      OR EXISTS (SELECT 1 FROM mail_messages m WHERE m.claim_id = a.claim_id AND m.received_at > a.last_evaluated_at)
      OR EXISTS (SELECT 1 FROM outbox o WHERE o.claim_id = a.claim_id AND o.updated_at > a.last_evaluated_at)
      OR EXISTS (SELECT 1 FROM fleet_reservations r WHERE r.claim_id = a.claim_id AND r.updated_at > a.last_evaluated_at)
      OR EXISTS (SELECT 1 FROM needs_you n WHERE n.claim_id = a.claim_id AND n.resolved_at > a.last_evaluated_at))`,
    )
    .all() as Array<{ id: string }>;
  for (const r of changed) ids.add(r.id);
  const claims = [...ids].filter((id) => {
    const c = ctx.repos.getClaim(ctx.db, id);
    return c && !['closed', 'settled'].includes(c.status);
  });
  for (const claimId of claims) {
    enqueueJob(ctx, { type: 'autopilot.tick', claimId, payload: { claimId, reason: 'sweep' }, idempotencyKey: `autopilot.tick:${claimId}:${londonDay(now)}T${now.slice(11, 16)}:sweep`, parentJobId: job.id, correlationId: job.correlationId, createdBy: AUTOPILOT_ACTOR });
  }
  return { queued: claims.length, claims };
}

/** Next working day 09:00-ish for snoozes ("remind me tomorrow"). */
export function tomorrowMorning(now: ISODateTime): ISODateTime {
  const d = addWorkingDays(now, 1);
  return new Date(Date.parse(d)).toISOString();
}
