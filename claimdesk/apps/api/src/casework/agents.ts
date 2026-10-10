// owned by casework
/**
 * The casework jobs (docs/SUPREME-DESIGN.md §C.1, §C.2, §C.4, §C.5):
 *
 *   case.review     (AI)  the case manager: next best action, plan, tasks, questions, hand-offs → code validates them
 *   draft.compose   (AI)  the drafter: letters, CCGUK Word templates, emails through the draft tools (free text only)
 *   offer.analyse   (AI)  figures by code + recommendation → Needs-you offer_decision (never a decision)
 *   research.ask    (AI)  the researcher: an answer with citations, saved as a memory note
 *   case.sweep      (det) 07:30 / 13:30 weekdays: claims with a clock due within 2 working days, unanswered inbound
 *                         mail, or no review for 7 days → case.review (reason sweep)
 *   task.due        (det) due open tasks → case.review (reason task_due)
 */
import { addWorkingDays, CUSTOM_ACTION_CODE, type CaseReviewResult, type DrafterResult, type OfferAnalysis, type ResearchAnswer } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { EnqueueInput, JobOutcome, JobRecord } from '../agent/contracts.js';
import { createNeedsYou, londonDay } from '../agent/core.js';
import { agentUserId } from '../agent/principal.js';
import { runAgent } from '../agent/runAgent.js';
import { recomputeClocks } from '../services/claimView.js';
import { proposeMemory, claimScope } from '../brain/memory.js';
import { queueIndex } from '../brain/fts.js';
import { buildCaseBrief } from './caseBrief.js';
import { aiFailure, checkClaimBudget, countClaimRun, isAiOff } from './ai.js';
import { breachesLoopGuard, isPlaybookCode, validateHandoff, type HandoffDecision } from './handoffs.js';
import { CASE_REVIEW_SPEC, DRAFTER_SPEC, OFFER_ANALYSE_SPEC, RESEARCHER_SPEC } from './specs.js';
import { offerDecisionItem } from './offers.js';
import { settlementFigures } from './quantum.js';
import { maskText } from './mask.js';

export const CASE_MANAGER = agentUserId('case_manager');
export const DRAFTER = agentUserId('drafter');
export const RESEARCHER = agentUserId('researcher');

export type ReviewReason = 'inbound' | 'task_due' | 'sweep' | 'owner' | 'offer';

export interface CaseReviewPayload {
  claimId: string;
  reason: ReviewReason;
  messageId?: string | null;
  taskId?: string | null;
}

const TERMINAL = new Set(['settled', 'closed', 'declined']);

/** The untrusted message for a prompt (only when it is filed on this claim). */
function messageBlock(ctx: AppContext, claimId: string, messageId: string | null | undefined): { kind: 'email'; id: string; text: string } | undefined {
  if (!messageId) return undefined;
  const m = ctx.repos.getMailMessage(ctx.db, messageId);
  if (!m || m.claimId !== claimId) return undefined;
  return { kind: 'email', id: m.id, text: `From: ${m.fromName ?? ''} <${m.fromAddr ?? ''}>\nSubject: ${m.subject ?? ''}\nDate: ${m.sentAt ?? m.receivedAt}\n\n${(m.bodyText ?? '').slice(0, 16_000)}` };
}

function budgetExhausted(ctx: AppContext, job: JobRecord, claimId: string, limit: number, used: number): JobOutcome {
  const day = londonDay(ctx.now());
  createNeedsYou(ctx, {
    kind: 'question',
    claimId,
    title: `Daily agent budget reached on ${ctx.repos.getClaim(ctx.db, claimId)?.reference ?? 'a claim'}`,
    summary: `The agents have already run ${used} times on this claim today (limit ${limit}). Further automatic work waits until tomorrow; "Review now" on the Agent tab still works.`,
    options: [{ id: 'ok', label: 'OK', tone: 'primary' }],
    payload: { claimId, used, limit, day, jobId: job.id, type: job.type },
    priority: 'low',
    createdBy: 'agent:supervisor',
    dedupeKey: `claim_budget:${claimId}:${day}`,
    correlationId: job.correlationId,
  });
  return { kind: 'done', result: { skipped: 'budget', used, limit } };
}

// ---------------------------------------------------------------------------
// case.review
// ---------------------------------------------------------------------------

export interface CaseReviewOutcome {
  runId?: string;
  skipped?: string;
  nextBestAction?: CaseReviewResult['nextBestAction'];
  accepted: Array<{ to: string; type: string; key?: string }>;
  rejected: Array<{ to: string; reason: string }>;
  asked: string[];
  tasks: string[];
  questions: string[];
}

const NEED_STOPWORDS = new Set(['the', 'and', 'from', 'with', 'this', 'that', 'client', 'insurer', 'claim', 'file', 'send', 'request', 'get', 'ask', 'for', 'our', 'their', 'not', 'will', 'without', 'document', 'documents', 'information', 'missing', 'need', 'needs']);
const needWords = (text: string): Set<string> => new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !NEED_STOPWORDS.has(w)));

/** Do two descriptions name the same missing thing (a shared significant word such as "v5c" or "invoice")? */
export function sameNeed(a: string, b: string): boolean {
  const wb = needWords(b);
  return [...needWords(a)].some((w) => wb.has(w));
}

/** Turn a validated CaseReviewResult into tasks, Needs-you items and follow-up jobs (§C.4). Pure of the model. */
export function applyCaseReview(ctx: AppContext, job: JobRecord, claimId: string, result: CaseReviewResult, runId: string): { outcome: CaseReviewOutcome; followUps: EnqueueInput[] } {
  const out: CaseReviewOutcome = { runId, nextBestAction: result.nextBestAction, accepted: [], rejected: [], asked: [], tasks: [], questions: [] };
  const followUps: EnqueueInput[] = [];
  const reference = ctx.repos.getClaim(ctx.db, claimId)?.reference ?? '';
  const loopGuard = breachesLoopGuard(job.depth);

  const askCustom = (title: string, why: string, payload: unknown): string =>
    createNeedsYou(ctx, {
      kind: 'question',
      claimId,
      title: `The case manager proposes a step outside the playbook${reference ? ` on ${reference}` : ''}: ${title}`.slice(0, 300),
      summary: `${why}`.slice(0, 2000),
      recommendation: { action: title, why, confidence: result.nextBestAction.confidence, basis: result.nextBestAction.basis },
      options: [
        { id: 'go_ahead', label: 'Go ahead (prepare it)', tone: 'primary' },
        { id: 'no', label: 'No', tone: 'neutral' },
      ],
      payload: { claimId, proposal: payload, runId },
      priority: 'normal',
      createdBy: CASE_MANAGER,
      dedupeKey: `custom_action:${claimId}:${title.slice(0, 80)}`,
      correlationId: job.correlationId,
      runId,
    }).id;

  // Next best action outside the playbook → the owner confirms — unless it is the same need as a missing-information
  // question whose prepared request already goes to the owner (one Needs-you item per need, not two).
  const nba = result.nextBestAction;
  const coveredByPrepared = nba.code === CUSTOM_ACTION_CODE && result.questionsForOwner.slice(0, 5).some((q) => q.prepareDraft && sameNeed(`${nba.title} ${nba.why}`, `${q.title} ${q.detail} ${q.missing.join(' ')}`));
  if (nba.code === CUSTOM_ACTION_CODE && !coveredByPrepared) out.asked.push(askCustom(nba.title, nba.why, nba));
  else if (!isPlaybookCode(nba.code)) out.rejected.push({ to: 'next_best_action', reason: `action code ${nba.code} is not a playbook code` });

  const consider = (d: HandoffDecision): void => {
    if (!d.ok || !d.job) {
      out.rejected.push({ to: d.handoff.to, reason: d.reason ?? 'invalid' });
      return;
    }
    if (d.ask) {
      out.asked.push(askCustom(d.handoff.to === 'drafter' ? d.handoff.purpose : d.handoff.to, d.reason ?? 'custom action', d.job));
      return;
    }
    if (loopGuard) {
      out.rejected.push({ to: d.handoff.to, reason: 'loop guard: hand-off chain too deep' });
      return;
    }
    followUps.push(d.job);
    out.accepted.push({ to: d.handoff.to, type: d.job.type, ...(d.job.idempotencyKey ? { key: d.job.idempotencyKey } : {}) });
  };
  for (const h of result.handoffs.slice(0, 10)) consider(validateHandoff(ctx, claimId, h, { createdBy: CASE_MANAGER }));

  // Questions for the owner: missing information → a prepared request (drafter, missingInfo) → Needs-you missing_info.
  for (const q of result.questionsForOwner.slice(0, 5)) {
    if (q.prepareDraft) {
      consider(
        validateHandoff(
          ctx,
          claimId,
          { to: 'drafter', templateId: null, emailKind: 'doc_request', purpose: `Request the missing information: ${q.title}. ${q.detail}${q.missing.length ? ` Missing: ${q.missing.join('; ')}.` : ''}`, recipientPartyId: null, replyToMessageId: null, actionCode: null, dueAt: null },
          { createdBy: CASE_MANAGER, missingInfo: true },
        ),
      );
    } else {
      out.questions.push(
        createNeedsYou(ctx, {
          kind: q.missing.length ? 'missing_info' : 'question',
          claimId,
          title: q.title.slice(0, 300),
          summary: `${q.detail}${q.missing.length ? ` Missing: ${q.missing.join('; ')}.` : ''}`.slice(0, 2000),
          options: [{ id: 'answered', label: 'Done', tone: 'primary' }],
          payload: { claimId, missing: q.missing, runId },
          priority: 'normal',
          createdBy: CASE_MANAGER,
          dedupeKey: `case_question:${claimId}:${q.title.slice(0, 80)}`,
          correlationId: job.correlationId,
          runId,
        }).id,
      );
    }
  }

  // Tasks (internal, low risk): one per kind + due date + note.
  const open = ctx.repos.listTasks(ctx.db, { claimId, status: 'open', limit: 500 });
  for (const t of result.tasks.slice(0, 10)) {
    if (!Number.isFinite(Date.parse(t.dueAt))) {
      out.rejected.push({ to: 'task', reason: `task due date ${t.dueAt} is not a date` });
      continue;
    }
    if (t.actionCode && t.actionCode !== CUSTOM_ACTION_CODE && !isPlaybookCode(t.actionCode)) {
      out.rejected.push({ to: 'task', reason: `task action code ${t.actionCode} is not a playbook code` });
      continue;
    }
    const due = new Date(Date.parse(t.dueAt)).toISOString();
    if (open.some((o) => o.kind === t.kind && o.dueAt === due && (o.note ?? '') === t.note)) continue;
    const task = ctx.repos.createTask(ctx.db, { claimId, kind: t.kind, title: t.note.slice(0, 120) || t.kind, note: t.note.slice(0, 2000), ...(t.actionCode ? { actionCode: t.actionCode } : {}), dueAt: due, createdBy: CASE_MANAGER, sourceRunId: runId, now: ctx.now() });
    out.tasks.push(task.id);
  }
  if (loopGuard && (result.handoffs.length || result.questionsForOwner.some((q) => q.prepareDraft))) {
    createNeedsYou(ctx, {
      kind: 'failure',
      claimId,
      title: 'Agents stopped a hand-off loop',
      summary: `The case manager wanted to hand work on at depth ${job.depth + 1}; the loop guard stopped it. Nothing further was done; please look at the claim.`,
      payload: { jobId: job.id, correlationId: job.correlationId, depth: job.depth },
      priority: 'high',
      createdBy: CASE_MANAGER,
      dedupeKey: `loop_guard:${job.correlationId}`,
      correlationId: job.correlationId,
      runId,
    });
  }
  const nextReview = ctx.repos.listTasks(ctx.db, { claimId, status: 'open', limit: 1 })[0]?.dueAt;
  ctx.repos.markClaimReviewed(ctx.db, claimId, { runId, at: ctx.now(), ...(nextReview ? { nextReviewAt: nextReview } : {}) });
  return { outcome: out, followUps };
}

export async function runCaseReview(ctx: AppContext, job: JobRecord, payload: CaseReviewPayload): Promise<JobOutcome> {
  const claim = ctx.repos.getClaim(ctx.db, payload.claimId);
  if (!claim) return { kind: 'fail', reason: `claim ${payload.claimId} not found` };
  if (job.claimId && job.claimId !== claim.id) return { kind: 'fail', reason: 'case.review must run scoped to its own claim' };
  if (TERMINAL.has(claim.status) && payload.reason !== 'owner') return { kind: 'done', result: { skipped: `claim is ${claim.status}` } };
  const budget = checkClaimBudget(ctx, claim.id, payload.reason === 'owner');
  if (!budget.allowed) return budgetExhausted(ctx, job, claim.id, budget.limit, budget.used);
  recomputeClocks(ctx, claim.id);
  const message = messageBlock(ctx, claim.id, payload.messageId);
  const task = payload.taskId ? ctx.repos.getTask(ctx.db, payload.taskId) : undefined;
  countClaimRun(ctx, claim.id);
  const run = await runAgent(ctx, CASE_REVIEW_SPEC, job, {
    task: `Review claim ${claim.reference} (claimId ${claim.id}). Reason: ${payload.reason}${message ? ` — a new message ${message.id} arrived` : ''}${task ? ` — task due: ${task.title}` : ''}.`,
    brief: buildCaseBrief(ctx, claim.id),
    ...(message ? { untrusted: [message] } : {}),
    question: [
      'Decide the next best action and the plan. Use the playbook next actions in the Case Brief (cite their codes), open tasks and the new message.',
      message ? `If the message needs a reply, hand off to mail_reply with messageId ${message.id}, a plan and key points.` : '',
      'Letters and forms: hand off to the drafter with a template id from templates_list that suits the recipient. Missing information: a question for the owner with prepareDraft true. Offers: hand off to offer_analyst — never decide them.',
      'Return the CaseReviewResult JSON.',
    ]
      .filter(Boolean)
      .join('\n'),
  });
  const failure = aiFailure(ctx, run.outcome);
  if (failure) return isAiOff(run.outcome) ? { kind: 'done', result: { skipped: 'AI is off', runId: run.runId } } : failure;
  const { outcome, followUps } = applyCaseReview(ctx, job, claim.id, run.result as CaseReviewResult, run.runId);
  return { kind: 'done', result: outcome, followUps };
}

// ---------------------------------------------------------------------------
// draft.compose
// ---------------------------------------------------------------------------

export interface DraftComposePayload {
  claimId: string;
  templateId: string | null;
  emailKind: string | null;
  purpose: string;
  recipientPartyId: string | null;
  replyToMessageId: string | null;
  actionCode: string | null;
  dueAt: string | null;
  missingInfo?: boolean;
  repairOf?: string;
  issues?: Array<{ code?: string; message?: string; fix?: string | null }>;
  loop?: number;
}

export async function runDraftCompose(ctx: AppContext, job: JobRecord, p: DraftComposePayload): Promise<JobOutcome> {
  const claim = ctx.repos.getClaim(ctx.db, p.claimId);
  if (!claim) return { kind: 'fail', reason: `claim ${p.claimId} not found` };
  const budget = checkClaimBudget(ctx, claim.id);
  if (!budget.allowed) return budgetExhausted(ctx, job, claim.id, budget.limit, budget.used);
  countClaimRun(ctx, claim.id);
  const message = messageBlock(ctx, claim.id, p.replyToMessageId);
  const recipient = p.recipientPartyId ? ctx.repos.getParty(ctx.db, p.recipientPartyId) : undefined;
  const run = await runAgent(ctx, DRAFTER_SPEC, job, {
    task: `Draft for claim ${claim.reference} (claimId ${claim.id}): ${p.purpose}`,
    brief: buildCaseBrief(ctx, claim.id, { mask: !recipient?.email }),
    ...(message ? { untrusted: [message] } : {}),
    question: [
      p.templateId ? `Use the template ${p.templateId} (document_draft for a letter, docx_document_draft for a CCGUK Word template).` : '',
      p.emailKind ? `Write an email of kind ${p.emailKind} with email_draft${p.replyToMessageId ? ` replying to message ${p.replyToMessageId} (inReplyToMessageId)` : ''}.` : '',
      recipient ? `Recipient: ${recipient.name} (party ${recipient.id}).` : 'Choose the recipient from the Case Brief recipients.',
      p.actionCode ? `Playbook action: ${p.actionCode}.` : '',
      p.dueAt ? `Due: ${p.dueAt}.` : '',
      p.missingInfo ? 'This is a request for information we are missing: ask clearly for exactly what is missing; the owner confirms it before it goes.' : '',
      p.issues?.length ? `This is repair loop ${p.loop ?? 1} of draft ${p.repairOf ?? ''}. Fix every issue the reviewer listed:\n${p.issues.map((i) => `- ${i.code ?? 'ISSUE'}: ${i.message ?? ''}${i.fix ? ` (fix: ${i.fix})` : ''}`).join('\n')}` : '',
      'Free text only: every figure, date, deadline and reference as a {{fact:<id>}} placeholder from the Case Brief. Return the DrafterResult JSON.',
    ]
      .filter(Boolean)
      .join('\n'),
  });
  const failure = aiFailure(ctx, run.outcome);
  if (failure) return isAiOff(run.outcome) ? { kind: 'fail', reason: 'AI is off; the draft was not prepared' } : failure;
  const result = run.result as DrafterResult;
  if (!result.drafts.length) {
    const ny = createNeedsYou(ctx, {
      kind: result.missingInfo.length || p.missingInfo ? 'missing_info' : 'question',
      claimId: claim.id,
      title: `Draft not prepared on ${claim.reference}: ${p.purpose.slice(0, 120)}`,
      summary: `${result.notes || 'The drafter could not prepare it.'}${result.missingInfo.length ? ` Missing: ${result.missingInfo.join('; ')}` : ''}`.slice(0, 2000),
      options: [{ id: 'ok', label: 'Done', tone: 'primary' }],
      payload: { claimId: claim.id, purpose: p.purpose, missingInfo: result.missingInfo, runId: run.runId },
      priority: 'normal',
      createdBy: DRAFTER,
      dedupeKey: `draft_none:${job.id}`,
      correlationId: job.correlationId,
      runId: run.runId,
    });
    return { kind: 'done', result: { drafts: [], needsYouId: ny.id, runId: run.runId } };
  }
  for (const d of result.drafts) if (d.kind !== 'outbox') queueIndex(ctx, 'document', d.id, { createdBy: DRAFTER });
  return { kind: 'done', result: { drafts: result.drafts.map((d) => ({ kind: d.kind, id: d.id })), missingInfo: result.missingInfo, runId: run.runId } };
}

// ---------------------------------------------------------------------------
// offer.analyse
// ---------------------------------------------------------------------------

export async function runOfferAnalyse(ctx: AppContext, job: JobRecord, p: { offerId: string; claimId?: string }): Promise<JobOutcome> {
  const offer = ctx.repos.getOffer(ctx.db, p.offerId);
  if (!offer) return { kind: 'fail', reason: `offer ${p.offerId} not found` };
  if (job.claimId && job.claimId !== offer.claimId) return { kind: 'fail', reason: 'offer.analyse must run scoped to the offer’s claim' };
  const claim = ctx.repos.requireClaim(ctx.db, offer.claimId);
  countClaimRun(ctx, claim.id); // offers always get their analysis (priority 0); counted, never refused
  const figures = settlementFigures(ctx, { claimId: claim.id, offerId: offer.id });
  const run = await runAgent(ctx, OFFER_ANALYSE_SPEC, job, {
    task: `Analyse the offer ${offer.id} from ${offer.offerorName} on claim ${claim.reference} (claimId ${claim.id}) and recommend what the owner should do. You never accept, counter or reject: the owner decides.`,
    brief: { caseBrief: buildCaseBrief(ctx, claim.id), figures },
    question: [
      'The figures were computed by code (settlementArithmetic, expectedValue, the GTA benchmark, PAV); the probabilities are stated assumptions. Cite figures by their fact ids.',
      `Call offer_recommend once with offerId ${offer.id}, then return the OfferAnalysis JSON with the same recommendation.`,
    ].join('\n'),
  });
  const failure = aiFailure(ctx, run.outcome);
  if (failure) return isAiOff(run.outcome) ? { kind: 'done', result: { skipped: 'AI is off', figures: figures.figures } } : failure;
  const result = run.result as OfferAnalysis;
  // The card must carry the recommendation even if the model forgot offer_recommend.
  const open = ctx.repos.findOpenNeedsYouByDedupeKey(ctx.db, `offer_decision:${offer.id}`);
  const hasRec = Boolean((open?.payload as { recommended?: unknown } | undefined)?.recommended);
  let needsYouId = open?.id;
  if (!hasRec) {
    needsYouId = createNeedsYou(ctx, offerDecisionItem(ctx, { offerId: offer.id, recommendation: result.recommendation, counterPence: result.counterPence, reasoning: result.reasoning, basis: result.basis, confidence: result.confidence }, { createdBy: CASE_MANAGER, correlationId: job.correlationId, runId: run.runId })).id;
  }
  return { kind: 'done', result: { recommendation: result.recommendation, confidence: result.confidence, needsYouId, runId: run.runId } };
}

// ---------------------------------------------------------------------------
// research.ask
// ---------------------------------------------------------------------------

export interface ResearchPayload {
  claimId?: string | null;
  question: string;
  scope?: 'claim' | 'global';
  askedBy?: string;
}

export async function runResearch(ctx: AppContext, job: JobRecord, p: ResearchPayload): Promise<JobOutcome> {
  const claimId = p.claimId ?? job.claimId;
  const owner = Boolean(p.askedBy && !p.askedBy.startsWith('agent:') && p.askedBy !== 'system');
  if (claimId) {
    const budget = checkClaimBudget(ctx, claimId, owner);
    if (!budget.allowed) return budgetExhausted(ctx, job, claimId, budget.limit, budget.used);
    countClaimRun(ctx, claimId);
  }
  const run = await runAgent(ctx, RESEARCHER_SPEC, job, {
    task: `Research question${claimId ? ` about claim ${ctx.repos.getClaim(ctx.db, claimId)?.reference ?? claimId} (claimId ${claimId})` : ''}.`,
    ...(claimId ? { brief: buildCaseBrief(ctx, claimId) } : {}),
    question: `${maskText(p.question)}\n\nAnswer from the knowledge base, the brain packs and approved memory only, with citations (kb / pack / memory ids). Say plainly when an authority is unverified. Return the ResearchAnswer JSON.`,
  });
  const failure = aiFailure(ctx, run.outcome);
  if (failure) return isAiOff(run.outcome) ? { kind: 'fail', reason: 'AI is off; the question was not researched' } : failure;
  const r = run.result as ResearchAnswer;
  const scope = p.scope === 'global' || !claimId ? 'global' : claimScope(claimId);
  const cites = r.citations.map((c) => `${c.id.startsWith(`${c.kind}:`) ? c.id : `${c.kind}:${c.id}`}${c.verified ? '' : ' (unverified)'}`).join(', ');
  const item = proposeMemory(ctx, {
    kind: 'research',
    scope,
    text: `Q: ${p.question.slice(0, 500)}\nA: ${r.answer}${cites ? `\nSources: ${cites}` : ''}`,
    basis: r.citations.map((c) => ({ kind: c.kind === 'memory' ? 'memory' : c.kind, id: c.id, label: c.verified ? null : 'unverified' })),
    data: { question: p.question, citations: r.citations, confidence: r.confidence, runId: run.runId },
    createdBy: RESEARCHER,
    // §E.6: a claim-scope research note is approved automatically; a global one waits for the owner.
    approve: scope !== 'global',
  });
  queueIndex(ctx, 'note', item.id, { createdBy: RESEARCHER });
  return { kind: 'done', result: { memoryId: item.id, status: item.status, scope, confidence: r.confidence, runId: run.runId } };
}

// ---------------------------------------------------------------------------
// case.sweep / task.due
// ---------------------------------------------------------------------------

export interface SweepCandidate {
  claimId: string;
  reasons: string[];
}

/** Claims the sweep reviews (§C.2): clock due within 2 working days, unanswered inbound mail, or no review for 7 days. */
export function sweepCandidates(ctx: AppContext): SweepCandidate[] {
  const now = ctx.now();
  const horizon = addWorkingDays(now, 2);
  const weekAgo = new Date(Date.parse(now) - 7 * 86_400_000).toISOString();
  const out: SweepCandidate[] = [];
  for (const c of ctx.repos.listClaims(ctx.db, { limit: 10_000 })) {
    if (TERMINAL.has(c.status)) continue;
    const reasons: string[] = [];
    const clocks = ctx.repos.listClocks(ctx.db, c.id).filter((k) => k.status === 'running' && k.dueAt <= horizon);
    if (clocks.length) reasons.push(`clock due: ${clocks.map((k) => k.kind).join(', ')}`);
    const state = ctx.repos.getClaimAgentState(ctx.db, c.id);
    const lastIn = ctx.repos.listMailMessages(ctx.db, { claimId: c.id, direction: 'in', limit: 1 })[0];
    const lastOut = ctx.repos.listMailMessages(ctx.db, { claimId: c.id, direction: 'out', limit: 1 })[0];
    if (lastIn && (!lastOut || lastOut.receivedAt < lastIn.receivedAt) && (!state.lastReviewAt || state.lastReviewAt < lastIn.receivedAt)) reasons.push('unanswered inbound email');
    if (state.lastReviewAt ? state.lastReviewAt < weekAgo : c.openedAt < weekAgo) reasons.push('no review for 7 days');
    if (reasons.length && !state.paused) out.push({ claimId: c.id, reasons });
  }
  return out.sort((a, b) => a.claimId.localeCompare(b.claimId));
}

export function runCaseSweep(ctx: AppContext, job: JobRecord, p: { slot?: string }): JobOutcome {
  const day = londonDay(ctx.now());
  const candidates = sweepCandidates(ctx);
  const followUps: EnqueueInput[] = candidates.map((c) => ({ type: 'case.review', payload: { claimId: c.claimId, reason: 'sweep', sweepReasons: c.reasons }, claimId: c.claimId, priority: 5, idempotencyKey: `case.review:${c.claimId}:sweep:${day}`, createdBy: CASE_MANAGER }));
  return { kind: 'done', result: { slot: p.slot ?? null, claims: candidates.length, candidates }, followUps };
}

export function runTaskDue(ctx: AppContext, job: JobRecord, p: { taskId: string }): JobOutcome {
  const task = ctx.repos.getTask(ctx.db, p.taskId);
  if (!task) return { kind: 'fail', reason: `task ${p.taskId} not found` };
  if (task.status !== 'open') return { kind: 'done', result: { skipped: `task is ${task.status}` } };
  if (task.dueAt > ctx.now()) return { kind: 'done', result: { skipped: 'not due yet' } };
  return {
    kind: 'done',
    result: { taskId: task.id, claimId: task.claimId },
    followUps: [{ type: 'case.review', payload: { claimId: task.claimId, reason: 'task_due', taskId: task.id }, claimId: task.claimId, priority: 3, idempotencyKey: `case.review:${task.claimId}:task_due:${task.id}`, createdBy: CASE_MANAGER }],
  };
}
