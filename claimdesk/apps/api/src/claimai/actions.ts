// owned by claimai-server
/**
 * Executors (docs/CLAIM-AI-INPUT.md §6.1): code, never the model, runs each validated action — through the existing
 * route in-process as the signed-in owner (`ctx.inject` + `ownerHeaders`, as intake/apply.ts does), so validation,
 * audit and side effects are exactly those of a click in the app. Catch-up lines applied automatically run as
 * `agent:intake` through the same services the intake bundle engine uses (filing, records, back-dated events).
 * Money, offers, legal steps and closing go to Needs-you only.
 */
import { COPY, eventAtFor, type ActionParams, type ContactRole, type EventType, type PlannedAction } from '@ccguk/domain';
import type { Actor, ClaimAiInputRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { createNeedsYou, enqueueJob } from '../agent/core.js';
import { appendClaimEvent } from '../mail/common.js';
import { applyProposal, ownerApplier } from '../intake/apply.js';
import { ownerHeaders } from '../intake/callerContext.js';
import { proposeField } from '../intake/proposals.js';
import { eventType as eventTypeSchema } from '../schemas/events.js';
import { fileBundleEvidence, linkItemsToClaim } from '../intake/bundles/file.js';
import type { BundleState } from '../intake/bundles/recompute.js';
import { isLateEntry } from '../services/hireCorrection.js';
import { recordCorrespondence } from './correspondence.js';
import { createStandingInstruction } from './instructions.js';
import { partyForContact } from './service.js';

export interface ExecEnv {
  ctx: AppContext;
  claimId: string;
  input: ClaimAiInputRecord;
  actor: Actor;
  mode: 'owner' | 'agent';
  /** Catch-up: the bundle state (filing) and bundle file → claim evidence. */
  bundle?: BundleState;
  filed: Record<string, string>;
}

export interface ExecResult {
  state: 'applied' | 'needs_you' | 'failed' | 'skipped';
  refs: Record<string, unknown>;
  message?: string | null;
  error?: { code: string; message: string } | null;
}

const ROUTE_EVENT_TYPES = new Set<string>(eventTypeSchema.options);

/** An in-process request as the owner; a 4xx/5xx is the action's failure with the route's own message. */
export async function ownerCall(env: ExecEnv, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown): Promise<{ ok: true; body: unknown } | { ok: false; error: { code: string; message: string } }> {
  const { ctx } = env;
  if (!ctx.inject) throw new Error('ctx.inject is not wired (buildApp sets it)');
  const res = await ctx.inject({ method, url: `/api${url}`, headers: { ...ownerHeaders(ctx, env.actor), 'content-type': 'application/json' }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  let parsed: unknown;
  try {
    parsed = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    parsed = res.body;
  }
  if (res.statusCode >= 400) {
    const e = ((parsed as { error?: { code?: string; message?: string } } | undefined)?.error ?? {}) as { code?: string; message?: string };
    return { ok: false, error: { code: e.code ?? `HTTP_${res.statusCode}`, message: e.message ?? `The route answered ${res.statusCode}` } };
  }
  return { ok: true, body: parsed };
}

const fail = (code: string, message: string): ExecResult => ({ state: 'failed', refs: {}, error: { code, message } });

function eventData(env: ExecEnv, a: PlannedAction, at: string): Record<string, unknown> {
  return { source: 'ai_input', aiInputId: env.input.id, actionKey: a.key, quote: a.quote, lateEntry: isLateEntry(at, env.ctx.now()) };
}

async function writeEvent(env: ExecEnv, a: PlannedAction, type: string, at: string, summary: string, extra: Record<string, unknown> = {}): Promise<ExecResult> {
  const data = { ...eventData(env, a, at), ...extra };
  if (env.mode === 'owner' && ROUTE_EVENT_TYPES.has(type)) {
    const r = await ownerCall(env, 'POST', `/claims/${env.claimId}/events`, { type, at, summary: summary.slice(0, 2000), data });
    if (!r.ok) return { state: 'failed', refs: {}, error: r.error };
    return { state: 'applied', refs: { eventId: (r.body as { event?: { id?: string } }).event?.id } };
  }
  const e = appendClaimEvent(env.ctx, env.claimId, { type: type as EventType, at, summary: summary.slice(0, 2000), data }, env.actor);
  return { state: 'applied', refs: { eventId: e.id } };
}

function needsYouCard(env: ExecEnv, a: PlannedAction, kind: 'money' | 'legal_review' | 'question', title: string, summary: string, payload: Record<string, unknown>, options?: Array<{ id: string; label: string; tone: 'primary' | 'neutral' | 'danger' }>): ExecResult {
  const item = createNeedsYou(env.ctx, {
    kind,
    claimId: env.claimId,
    title: title.slice(0, 200),
    summary: summary.slice(0, 2000),
    ...(options ? { options } : {}),
    payload: { claimId: env.claimId, inputId: env.input.id, actionKey: a.key, source: 'owner_text', ...payload },
    priority: kind === 'question' ? 'normal' : 'high',
    createdBy: env.actor.userId,
    dedupeKey: `claim_ai:${kind}:${env.input.id}:${a.key}`,
  });
  return { state: 'needs_you', refs: { needsYouId: item.id } };
}

function reference(env: ExecEnv): string {
  return env.ctx.repos.getClaim(env.ctx.db, env.claimId)?.reference ?? 'the claim';
}

/** Run one action. The caller logs, audits and orders the actions. */
export async function executeAction(env: ExecEnv, a: PlannedAction): Promise<ExecResult> {
  const { ctx, claimId } = env;
  const p: ActionParams = a.params;
  const now = ctx.now();
  switch (a.type) {
    case 'event':
    case 'note': {
      const type = a.type === 'note' ? 'note' : (p.eventType ?? 'note');
      const at = p.at ? (p.precision === 'date' ? eventAtFor(p.at, 'date', now) : p.at) : now;
      const extra = a.source === 'catch_up' ? { recordedLate: true, lateSource: { inputId: env.input.id, bundleFileId: p.bundleFileId ?? null, filename: p.filename ?? null } } : {};
      return writeEvent(env, a, type, at, p.summary ?? p.text ?? a.title, extra);
    }
    case 'field_update': {
      if (!p.target || !p.value) return fail('VALIDATION', 'No field or value');
      const r = proposeField(ctx, { claimId, target: p.target, value: p.value, confidence: 1, source: { via: 'owner', label: a.source === 'catch_up' ? 'your catch-up documents' : 'your update', quote: a.quote ?? null } });
      if (r.kind === 'skipped') return r.reason === 'already on the claim' ? { state: 'applied', refs: {}, message: 'Already on the claim' } : fail('VALIDATION', r.reason);
      if (r.proposal.status !== 'pending') return fail('PROPOSAL_REFUSED', r.proposal.validator?.policy?.reasons?.join('; ') || 'This field cannot be applied on this claim');
      if (env.mode !== 'owner') return { state: 'needs_you', refs: { proposalId: r.proposal.id }, message: 'Waiting for your confirmation' };
      const out = await applyProposal(ctx, r.proposal, ownerApplier(ctx, env.actor), { note: 'from your AI input' });
      if (!out.ok) return { state: 'failed', refs: { proposalId: r.proposal.id }, error: out.error ?? { code: 'APPLY_FAILED', message: 'Not applied' } };
      return { state: 'applied', refs: { proposalId: r.proposal.id, previous: p.current ?? null } };
    }
    case 'liability_position': {
      const before = ctx.repos.getClaim(ctx.db, claimId)?.liability ?? 'unknown';
      const r = await ownerCall(env, 'PATCH', `/claims/${claimId}`, { liability: p.value });
      if (!r.ok) return { state: 'failed', refs: {}, error: r.error };
      return { state: 'applied', refs: { previous: before, value: p.value } };
    }
    case 'hire_end': {
      if (!p.hireId || !p.endAt) return fail('VALIDATION', 'No hire or end date');
      const r = await ownerCall(env, 'POST', `/claims/${claimId}/hire/${p.hireId}/end`, { endAt: p.endAt, endTrigger: p.endTrigger ?? 'client_returned', reason: `From your update: '${(a.quote ?? '').slice(0, 300)}'` });
      if (!r.ok) return { state: 'failed', refs: { hireId: p.hireId }, error: r.error };
      return { state: 'applied', refs: { hireId: p.hireId, endAt: p.endAt } };
    }
    case 'hire_correct': {
      if (!p.hireId) return fail('VALIDATION', 'No hire');
      const hire = ctx.repos.listHire(ctx.db, claimId).find((h) => h.id === p.hireId);
      if (!hire) return fail('NOT_FOUND', 'The hire is not on this claim');
      const body = { ...(p.startAt ? { startAt: p.startAt } : {}), ...(p.endAt ? { endAt: p.endAt } : {}), reason: `From your update: '${(a.quote ?? '').slice(0, 300)}'`, ledger: 'auto' };
      const r = await ownerCall(env, 'PATCH', `/claims/${claimId}/hire/${p.hireId}`, body);
      if (!r.ok) return { state: 'failed', refs: { hireId: p.hireId }, error: r.error };
      return { state: 'applied', refs: { hireId: p.hireId, previousStartAt: hire.startAt, previousEndAt: hire.endAt ?? null } };
    }
    case 'task': {
      const due = p.dueAt ?? now;
      const task = ctx.repos.createTask(ctx.db, { claimId, kind: p.taskKind ?? 'other', title: (p.note ?? a.title).slice(0, 120), note: (p.note ?? '').slice(0, 2000), dueAt: new Date(Date.parse(due)).toISOString(), createdBy: env.actor.userId, now });
      ctx.repos.appendAudit(ctx.db, { actor: env.actor, action: 'task.create', entity: 'tasks', entityId: task.id, after: { claimId, kind: task.kind, dueAt: task.dueAt, inputId: env.input.id }, at: now });
      return { state: 'applied', refs: { taskId: task.id } };
    }
    case 'instruction': {
      const rec = createStandingInstruction(ctx, { claimId, text: p.text ?? a.title, appliesTo: p.appliesTo ?? ['all'], effect: p.effect ?? null, until: p.until ?? null, sourceInputId: env.input.id, sourceActionKey: a.key }, env.actor);
      return { state: 'applied', refs: { instructionId: rec.id } };
    }
    case 'pause_agents': {
      const r = await ownerCall(env, 'POST', `/claims/${claimId}/agent/pause`, { reason: (p.reason ?? 'Paused from your update').slice(0, 500) });
      if (!r.ok) return { state: 'failed', refs: {}, error: r.error };
      return { state: 'applied', refs: { paused: true } };
    }
    case 'resume_agents': {
      const r = await ownerCall(env, 'POST', `/claims/${claimId}/agent/resume`, {});
      if (!r.ok) return { state: 'failed', refs: {}, error: r.error };
      return { state: 'applied', refs: { resumed: true } };
    }
    case 'run_job':
      return runJob(env, a);
    case 'money':
      return needsYouCard(
        env,
        a,
        'money',
        `Payment to record on ${reference(env)}: ${a.title.replace(/ — goes to Needs-you.*$/, '')}`,
        `From your update: '${a.quote ?? ''}'. Record it in the ledger when it is in the bank.`,
        { proposal: 'payment_received', entry: { amountPence: p.amountPence ?? null, head: p.head ?? null }, link: `/claims/${claimId}/ledger` },
        [
          { id: 'recorded', label: 'Recorded in the ledger', tone: 'primary' },
          { id: 'not_now', label: 'Not now', tone: 'neutral' },
        ],
      );
    case 'offer_received': {
      const offeror = p.offeror ?? 'the insurer';
      const r =
        p.register === 'intervention'
          ? await ownerCall(env, 'POST', `/claims/${claimId}/offers`, { receivedAt: now, channel: 'phone', offerorName: offeror, terms: { otherTerms: `From your update: '${(a.quote ?? '').slice(0, 300)}'` } })
          : await ownerCall(env, 'POST', `/claims/${claimId}/settlement-offers`, { head: 'global', amountPence: p.amountPence ?? null, receivedAt: now, channel: 'phone', offerorName: offeror, terms: `From your update: '${(a.quote ?? '').slice(0, 300)}'` });
      if (!r.ok) return { state: 'failed', refs: {}, error: r.error };
      const body = r.body as { id?: string; offer?: { id?: string } };
      return { state: 'applied', refs: { offerId: body.offer?.id ?? body.id } };
    }
    case 'offer_decision':
      return needsYouCard(env, a, 'question', COPY.offerCard(reference(env)), `You wrote: '${a.quote ?? ''}'. Decisions on offers are made on the Offers screen.`, { link: `/claims/${claimId}/offers`, kind: 'claim_ai_offer' }, [
        { id: 'open', label: 'Open Offers', tone: 'primary' },
        { id: 'dismiss', label: 'Dismiss', tone: 'neutral' },
      ]);
    case 'legal':
      return needsYouCard(env, a, 'legal_review', `Legal on ${reference(env)}: ${(p.summary ?? p.matter ?? 'a legal step').slice(0, 120)}`, `From your update: '${a.quote ?? ''}'.`, { matter: p.matter ?? 'other', summary: p.summary ?? null, link: `/claims/${claimId}` }, [
        { id: 'noted', label: 'Noted — I will handle it', tone: 'primary' },
        { id: 'dismiss', label: 'Dismiss', tone: 'neutral' },
      ]);
    case 'close_or_decline':
      return needsYouCard(env, a, 'question', COPY.closeCard(reference(env)), `You wrote: '${(a.quote ?? '').slice(0, 300)}'. Closing, settling or declining is done from the status menu, with a reason.`, { link: `/claims/${claimId}?tab=overview`, kind: 'claim_ai_close' }, [
        { id: 'open', label: 'Open the claim', tone: 'primary' },
        { id: 'dismiss', label: 'Dismiss', tone: 'neutral' },
      ]);
    case 'status_change': {
      const before = ctx.repos.getClaim(ctx.db, claimId)?.status;
      const r = await ownerCall(env, 'POST', `/claims/${claimId}/status`, { status: p.status, reason: `From your update: '${(a.quote ?? '').slice(0, 300)}'` });
      if (!r.ok) return { state: 'failed', refs: {}, error: r.error };
      return { state: 'applied', refs: { previous: before } };
    }
    case 'private_note':
      return { state: 'applied', refs: {}, message: 'Kept on this input only' };
    case 'file_evidence': {
      if (!env.bundle || !p.bundleFileId) return fail('NOT_CATCH_UP', 'No catch-up file');
      const filing = await fileBundleEvidence(ctx, env.bundle, claimId, [p.bundleFileId], env.actor, { copies: new Set([p.bundleFileId]) });
      linkItemsToClaim(ctx, env.bundle, claimId, [p.bundleFileId], env.actor);
      const evidenceId = filing.filed[p.bundleFileId];
      if (!evidenceId) return fail('NOT_FILED', 'The file could not be filed (excluded or a container)');
      env.filed[p.bundleFileId] = evidenceId;
      return { state: 'applied', refs: { evidenceId } };
    }
    case 'record_correspondence': {
      if (!p.direction || !p.at) return fail('NEEDS_YOU', 'Pick who sent it and its date first');
      const evidenceId = (p.bundleFileId && env.filed[p.bundleFileId]) || p.evidenceId || null;
      const r = recordCorrespondence(ctx, { claimId, inputId: env.input.id, bundleId: env.input.bundleId ?? null, actionKey: a.key, params: p, evidenceId }, env.actor);
      return { state: 'applied', refs: { correspondenceId: r.correspondenceId, eventId: r.eventId, ...(r.extraEventId ? { extraEventId: r.extraEventId } : {}), evidenceId } };
    }
    case 'hire_start':
    case 'unsupported':
      return { state: 'skipped', refs: {}, message: a.why };
  }
}

async function runJob(env: ExecEnv, a: PlannedAction): Promise<ExecResult> {
  const { ctx, claimId } = env;
  const p = a.params;
  if (p.jobKind === 'review_now') {
    const r = await ownerCall(env, 'POST', `/claims/${claimId}/agent/review-now`, {});
    if (!r.ok) return { state: 'failed', refs: {}, error: r.error };
    return { state: 'applied', refs: { jobId: (r.body as { id?: string }).id } };
  }
  if (p.jobKind === 'replan') {
    const r = await ownerCall(env, 'POST', `/claims/${claimId}/autopilot/evaluate`, {});
    if (!r.ok) return { state: 'failed', refs: {}, error: r.error };
    return { state: 'applied', refs: {} };
  }
  const recipient = (p.recipient ?? null) as ContactRole | null;
  const job = enqueueJob(ctx, {
    type: 'draft.compose',
    claimId,
    priority: 1,
    payload: {
      claimId,
      templateId: p.templateId ?? null,
      emailKind: p.emailKind ?? (p.jobKind === 'send_document' ? 'info_provided' : p.jobKind === 'draft_letter' && !p.templateId ? 'client_update' : null),
      purpose: `${p.purpose ?? a.title}${a.quote ? ` (owner: "${a.quote.slice(0, 200)}")` : ''}`.slice(0, 2000),
      recipientPartyId: partyForContact(ctx, claimId, recipient),
      replyToMessageId: null,
      actionCode: null,
      dueAt: null,
      ...(p.jobKind === 'request_documents' ? { missingInfo: true } : {}),
      ...(p.evidenceIds?.length ? { attachEvidenceIds: p.evidenceIds } : {}),
      ownerInputId: env.input.id,
      ownerText: a.quote ?? '',
    },
    idempotencyKey: `draft.compose:ai-input:${env.input.id}:${a.key}`,
    createdBy: env.actor.userId,
  });
  return { state: 'applied', refs: { jobId: job.id }, message: 'The draft follows the sending rules' };
}
