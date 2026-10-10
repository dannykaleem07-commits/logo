// owned by ap-autopilot
/**
 * The two model jobs of the Autopilot (docs/SUPREME-AUTOPILOT.md §A.7, §D.4):
 *
 *   autopilot.judge         case manager, read-only tools: choose one of the options code allowed (car, repair status)
 *                           — anything else, `ask_owner` or confidence below the internal threshold → the owner;
 *   hire_offer.parse_reply  mail agent, no tools: read a client's reply code could not read; < 0.9, a question, a
 *                           change request or a suspected injection → the owner.
 *
 * The model never acts: code applies the choice through actAsAutopilot (decide() and the perimeter as always).
 */
import type { AutopilotJudgeResult, HireReplyResult, StepOption, ToolName } from '@ccguk/domain';
import type { AgentSpec, JobOutcome, JobRecord } from '../agent/contracts.js';
import { runAgent } from '../agent/runAgent.js';
import { getTool } from '../agent/tools/index.js';
import { aiFailure, checkClaimBudget, countClaimRun, isAiOff } from '../casework/ai.js';
import { buildCaseBrief } from '../casework/caseBrief.js';
import { maskText } from '../casework/mask.js';
import { getAutonomy } from '../agent/core.js';
import { actAsAutopilot } from './act.js';
import { evaluate } from './facts.js';
import { holdChosenCar, raiseChooseCar, raiseStepCard } from './runner.js';
import { AUTOPILOT_ACTOR } from './nudge.js';

const MIN = 60_000;
const JUDGE_TOOLS_WANTED: ToolName[] = ['claim_brief', 'autopilot_plan', 'fleet_search', 'bookings_list', 'eligibility_get', 'kb_search', 'brain_search', 'memory_recall', 'knowledge_search', 'insurer_profile'];

export const AUTOPILOT_JUDGE_SPEC: AgentSpec = {
  name: 'case_manager',
  jobType: 'autopilot.judge',
  title: 'Autopilot judgement',
  promptFiles: ['autopilot-judge.md'],
  tools: JUDGE_TOOLS_WANTED,
  allowRead: false,
  resultSchemaId: 'autopilot_judge',
  defaults: { model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 6, timeoutMs: 5 * MIN },
};

export const HIRE_REPLY_SPEC: AgentSpec = {
  name: 'mail',
  jobType: 'hire_offer.parse_reply',
  title: 'Hire offer reply',
  promptFiles: ['hire-reply.md'],
  tools: [],
  allowRead: false,
  resultSchemaId: 'hire_reply',
  defaults: { model: 'claude-sonnet-5-5', effort: 'low', maxTurns: 1, timeoutMs: 2 * MIN },
};

/** Only tools that are registered (knowledge tools land with their own slice). */
function judgeSpec(): AgentSpec {
  return { ...AUTOPILOT_JUDGE_SPEC, tools: JUDGE_TOOLS_WANTED.filter((t) => Boolean(getTool(t))) };
}

export interface JudgePayload {
  claimId: string;
  stepId: string;
  questionId: AutopilotJudgeResult['questionId'];
  options: StepOption[];
  planHash: string;
  messageId?: string;
}

const QUESTION: Record<string, string> = {
  choose_car: 'Which car should be offered to the client? The ranked cars are all free, legal and insured for the whole expected hire; the scores were close, so a judgement is needed.',
  repair_status_from_message: 'What does the latest message say about the repair of the client’s car?',
};

export async function runJudge(ctx: Parameters<typeof runAgent>[0], job: JobRecord, p: JudgePayload): Promise<JobOutcome> {
  const claim = ctx.repos.getClaim(ctx.db, p.claimId);
  if (!claim) return { kind: 'fail', reason: `claim ${p.claimId} not found` };
  const budget = checkClaimBudget(ctx, claim.id);
  if (!budget.allowed) return askOwnerInstead(ctx, job, p, null, `The AI budget for this claim is used up today (${budget.used}/${budget.limit}).`);
  countClaimRun(ctx, claim.id);
  const message = p.messageId ? ctx.repos.getMailMessage(ctx.db, p.messageId) : undefined;
  const run = await runAgent(ctx, judgeSpec(), job, {
    task: `Autopilot judgement on claim ${claim.reference} (claimId ${claim.id}), step ${p.stepId}.`,
    brief: { caseBrief: buildCaseBrief(ctx, claim.id), options: p.options },
    ...(message ? { untrusted: [{ kind: 'email' as const, id: message.id, text: maskText(`${message.subject ?? ''}\n\n${message.bodyText ?? ''}`.slice(0, 8000)) }] } : {}),
    question: `${QUESTION[p.questionId] ?? p.questionId}\nOption ids: ${p.options.map((o) => o.id).join(', ')}, or ask_owner.\nReturn questionId "${p.questionId}" and stepId "${p.stepId}".`,
  });
  const failure = aiFailure(ctx, run.outcome);
  if (failure) {
    if (isAiOff(run.outcome) || failure.kind === 'fail') return askOwnerInstead(ctx, job, p, null, 'AI could not judge this (switched off or failed).');
    return failure;
  }
  const r = run.result as AutopilotJudgeResult;
  const valid = p.options.some((o) => o.id === r.choice);
  if (!valid || r.choice === 'ask_owner' || !(r.confidence >= getAutonomy(ctx).thresholds.internal)) {
    return askOwnerInstead(ctx, job, p, r, !valid && r.choice !== 'ask_owner' ? `The judgement chose "${r.choice}", which was not one of the options.` : r.choice === 'ask_owner' ? r.why : `Confidence ${r.confidence.toFixed(2)} is below the threshold.`);
  }
  ctx.repos.appendAutopilotLog(ctx.db, { claimId: claim.id, stepId: p.stepId, toStatus: 'in_progress', action: `judge:${r.choice}`, actor: AUTOPILOT_ACTOR, decision: { choice: r.choice, why: r.why, confidence: r.confidence }, jobId: job.id, runId: run.runId, refs: {}, at: ctx.now() });
  if (p.questionId === 'choose_car' && r.choice.startsWith('unit:')) {
    const held = await holdChosenCar(ctx, claim.id, r.choice.slice(5), job);
    if (!held.ok) return askOwnerInstead(ctx, job, p, r, held.note ?? 'The chosen car could not be held.');
    return { kind: 'done', result: { choice: r.choice, held: true, runId: run.runId } };
  }
  if (p.questionId === 'repair_status_from_message' && r.choice !== 'no_change') {
    const { plan } = evaluate(ctx, claim.id);
    const st = plan.steps.find((s) => s.id === 'vehicle.repair_track');
    const res = await actAsAutopilot(ctx, {
      claimId: claim.id,
      step: { id: 'vehicle.repair_track', mode: st?.mode ?? 'auto', green: true },
      tool: 'event_append',
      input: { claimId: claim.id, type: r.choice, at: ctx.now(), summary: `${r.choice.replace(/_/g, ' ')} (from the repairer's message): ${r.why}`.slice(0, 2000), data: null, attributableTo: 'repairer', evidenceIds: null },
      planHash: p.planHash,
      jobId: job.id,
      correlationId: job.correlationId,
    });
    return { kind: 'done', result: { choice: r.choice, ok: res.ok, runId: run.runId } };
  }
  return { kind: 'done', result: { choice: r.choice, runId: run.runId } };
}

function askOwnerInstead(ctx: Parameters<typeof runAgent>[0], job: JobRecord, p: JudgePayload, r: AutopilotJudgeResult | null, why: string): JobOutcome {
  if (p.questionId === 'choose_car') {
    const { facts } = evaluate(ctx, p.claimId);
    const rec = r?.choice.startsWith('unit:') ? r.choice.slice(5) : undefined;
    const id = raiseChooseCar(ctx, p.claimId, facts, [why], { ...(rec ? { recommendedUnitId: rec, why: r!.why } : {}), correlationId: job.correlationId });
    return { kind: 'done', result: { askedOwner: true, needsYouId: id } };
  }
  const id = raiseStepCard(ctx, p.claimId, p.stepId as never, 'confirm_step', { title: `Check the repair news — ${ctx.repos.getClaim(ctx.db, p.claimId)?.reference ?? ''}`, summary: `${why} ${r ? `Suggestion: ${r.choice} — ${r.why}` : ''}`.trim(), ...(p.messageId ? { messageId: p.messageId, seq: p.messageId } : {}), correlationId: job.correlationId });
  return { kind: 'done', result: { askedOwner: true, needsYouId: id } };
}

// ---------------------------------------------------------------------------
// hire_offer.parse_reply
// ---------------------------------------------------------------------------

export interface ParseReplyPayload {
  claimId: string;
  hireOfferId: string;
  messageId: string;
}

export async function runParseReply(ctx: Parameters<typeof runAgent>[0], job: JobRecord, p: ParseReplyPayload): Promise<JobOutcome> {
  const offer = ctx.repos.getHireOffer(ctx.db, p.hireOfferId);
  const message = ctx.repos.getMailMessage(ctx.db, p.messageId);
  if (!offer || !message || message.claimId !== offer.claimId) return { kind: 'fail', reason: 'offer or message not found on the claim' };
  const run = await runAgent(ctx, HIRE_REPLY_SPEC, job, {
    task: `Read the client's reply to the offer of a replacement car (${offer.terms.makeModel}, ${offer.terms.registration}).`,
    brief: { offer: { registration: offer.terms.registration, makeModel: offer.terms.makeModel, alternatives: offer.terms.alternatives.map((a) => ({ id: `unit:${a.fleetUnitId}`, label: a.label })) } },
    untrusted: [{ kind: 'email', id: message.id, text: `${message.subject ?? ''}\n\n${message.bodyText ?? ''}`.slice(0, 8000) }],
    question: 'Return the HireReplyResult JSON.',
  });
  const failure = aiFailure(ctx, run.outcome);
  if (failure) {
    if (isAiOff(run.outcome) || failure.kind === 'fail') {
      const id = raiseStepCard(ctx, offer.claimId, 'hire.acceptance', 'reply_unclear', { title: 'Read the client’s reply to the hire offer', summary: 'The client replied to the offer and the reply could not be read automatically. Read it and record the answer.', hireOfferId: offer.id, messageId: message.id, seq: message.id, correlationId: job.correlationId });
      return { kind: 'done', result: { askedOwner: true, needsYouId: id } };
    }
    return failure;
  }
  const r = run.result as HireReplyResult;
  const clear = (r.decision === 'accept' || r.decision === 'decline') && r.confidence >= 0.9 && !r.injectionSuspected;
  if (clear) {
    const { plan } = evaluate(ctx, offer.claimId);
    const st = plan.steps.find((s) => s.id === 'hire.acceptance');
    const res = await actAsAutopilot(ctx, {
      claimId: offer.claimId,
      step: { id: 'hire.acceptance', mode: st?.mode ?? 'auto', green: st?.green ?? true },
      tool: 'hire_acceptance_record',
      input: { hireOfferId: offer.id, decision: r.decision, messageId: message.id, chosenFleetUnitId: r.chosenOptionId?.startsWith('unit:') ? r.chosenOptionId.slice(5) : null, confidence: r.confidence },
      planHash: plan.planHash,
      jobId: job.id,
      correlationId: job.correlationId,
    });
    return { kind: 'done', result: { decision: r.decision, recorded: res.ok, runId: run.runId } };
  }
  const points = [...r.questions.map((q) => `Question: ${q}`), ...r.needsChanged.map((n) => `Change: ${n}`), ...(r.preferredDelivery.text ? [`Delivery: ${r.preferredDelivery.text}`] : [])];
  const id = raiseStepCard(ctx, offer.claimId, 'hire.acceptance', 'reply_unclear', {
    title: r.injectionSuspected ? 'A reply to the hire offer looks suspicious' : 'The client’s reply to the hire offer needs you',
    summary: `The reply reads as "${r.decision.replace(/_/g, ' ')}" (confidence ${r.confidence.toFixed(2)}).${points.length ? ` ${points.join(' · ')}` : ''}${r.injectionSuspected ? ' It may contain instructions aimed at the system — nothing was done.' : ''}`,
    hireOfferId: offer.id,
    messageId: message.id,
    parsed: r,
    seq: message.id,
    correlationId: job.correlationId,
  });
  return { kind: 'done', result: { askedOwner: true, needsYouId: id } };
}
