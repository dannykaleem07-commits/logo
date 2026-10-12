// owned by claimai-server
/**
 * Claim AI input (docs/CLAIM-AI-INPUT.md §1, §5.1, §8.1): the owner's updates and catch-ups on one claim — create,
 * answer, cancel, think again, catch-up overrides — plus the shared shapes (stored interpretation, answers) and the
 * claim context the parser, the AI brief, validation and the executors read.
 *
 * The owner's words are stored once on `claim_ai_inputs` (immutable) and never rewritten; everything the panel shows
 * is re-derivable from the stored interpretation + the append-only log.
 */
import {
  CLAIM_AI_DEFAULTS,
  isCorrespondenceKind,
  type CatchUpFilePlan,
  type ContactRole,
  type CorrespondenceKind,
  type ParseContext,
  type PlannedAction,
  type Question,
  type QuestionAnswer,
} from '@ccguk/domain';
import { listTemplates } from '@ccguk/documents';
import type { Actor, ClaimAiInputRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { createNeedsYou } from '../agent/core.js';
import { HttpError } from '../errors.js';
import { assertHuman } from '../services/humanOnly.js';
import { createBundle } from '../intake/bundles/service.js';
import { activeInstructionViews } from './instructions.js';

export const CASE_MANAGER = 'agent:case_manager';
export const INTAKE_AGENT = 'agent:intake';
const CLOSED_CLAIM = new Set(['closed', 'settled', 'declined']);

// ---------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------

export interface StoredInterpretation {
  understood: string | null;
  actions: PlannedAction[];
  questions: Question[];
  notDone: Array<{ text: string; why: string }>;
  /** Clauses waiting for the AI. */
  pendingText: string[];
  warnings: string[];
  rulesCoverage?: number;
  aiRunId?: string | null;
  /** Catch-up only. */
  catchUp?: { files: CatchUpFilePlan[]; willDo: string[]; blockers: Array<{ code: string; text: string; fileId?: string }>; bundleRevision: number; settled: boolean };
}

export interface StoredAnswer {
  questionId: string;
  optionId: string | null;
  text: string | null;
  date: string | null;
  at: string;
  by: string;
  /** The question and the chosen option's label, kept so a later reading still knows what was asked. */
  question?: string;
  label?: string | null;
}

export const EMPTY_INTERPRETATION: StoredInterpretation = { understood: null, actions: [], questions: [], notDone: [], pendingText: [], warnings: [] };

export function interpretationOf(input: ClaimAiInputRecord): StoredInterpretation {
  const i = input.interpretation as Partial<StoredInterpretation> | undefined;
  return { ...EMPTY_INTERPRETATION, ...(i ?? {}), actions: i?.actions ?? [], questions: i?.questions ?? [], notDone: i?.notDone ?? [], pendingText: i?.pendingText ?? [], warnings: i?.warnings ?? [] };
}

export function answersOf(input: ClaimAiInputRecord): StoredAnswer[] {
  return (input.answers as StoredAnswer[]).filter((a) => a && typeof a.questionId === 'string');
}

/** The latest answer per question id. */
export function answerMap(input: ClaimAiInputRecord): Record<string, QuestionAnswer> {
  const out: Record<string, QuestionAnswer> = {};
  for (const a of answersOf(input)) out[a.questionId] = { optionId: a.optionId, text: a.text, date: a.date };
  return out;
}

// ---------------------------------------------------------------------------
// Claim context
// ---------------------------------------------------------------------------

export function requireClaimFor(ctx: AppContext, claimId: string) {
  const claim = ctx.repos.getClaim(ctx.db, claimId);
  if (!claim) throw new HttpError(404, 'NOT_FOUND', `claim ${claimId} not found`);
  return claim;
}

export function requireInput(ctx: AppContext, claimId: string, inputId: string): ClaimAiInputRecord {
  const input = ctx.repos.getAiInput(ctx.db, inputId);
  if (!input || input.claimId !== claimId) throw new HttpError(404, 'NOT_FOUND', `AI input ${inputId} not found on this claim`);
  return input;
}

export function openHiresOf(ctx: AppContext, claimId: string): Array<{ id: string; agreementNumber: string; startAt: string }> {
  return ctx.repos
    .listHire(ctx.db, claimId)
    .filter((h) => !h.endAt)
    .map((h) => ({ id: h.id, agreementNumber: h.agreementNumber, startAt: h.startAt }));
}

export function insurerNameOf(ctx: AppContext, claimId: string): string | null {
  const claim = ctx.repos.getClaim(ctx.db, claimId);
  if (!claim?.atFaultInsurerId) return null;
  return ctx.repos.getParty(ctx.db, claim.atFaultInsurerId)?.name ?? null;
}

/** Letter templates the owner can ask for by name (title match). */
export function letterTemplates(): Array<{ id: string; title: string }> {
  return listTemplates()
    .filter((t) => t.kind === 'letter' || t.id.startsWith('letter.'))
    .map((t) => ({ id: t.id, title: t.title }));
}

export function fieldValuesOf(ctx: AppContext, claimId: string): Partial<Record<string, string | null>> {
  const claim = ctx.repos.getClaim(ctx.db, claimId);
  if (!claim) return {};
  const claimant = ctx.repos.getParty(ctx.db, claim.claimantId);
  const addr = claimant?.address ? [claimant.address.line1, claimant.address.line2, claimant.address.town, claimant.address.postcode].filter(Boolean).join(', ') : null;
  return {
    'claim.atFaultInsurerRef': claim.atFaultInsurerRef ?? null,
    'claim.accident.policeReference': claim.accident?.policeReference ?? null,
    'party:claimant.phone': claimant?.phone ?? null,
    'party:claimant.email': claimant?.email ?? null,
    'party:claimant.address': addr,
  };
}

export function parseContextFor(ctx: AppContext, claimId: string, answers: Record<string, QuestionAnswer> = {}): ParseContext {
  const claim = requireClaimFor(ctx, claimId);
  const claimant = ctx.repos.getParty(ctx.db, claim.claimantId);
  return {
    now: ctx.now(),
    openHires: openHiresOf(ctx, claimId),
    insurerName: insurerNameOf(ctx, claimId),
    clientFirstName: claimant?.name?.trim().split(/\s+/)[0] ?? null,
    evidence: ctx.repos.listEvidenceForClaim(ctx.db, claimId).map((e) => ({ id: e.id, kind: e.kind, filename: e.filename, createdAt: e.uploadedAt })),
    templates: letterTemplates(),
    answers,
    instructions: activeInstructionViews(ctx, claimId),
    fieldValues: fieldValuesOf(ctx, claimId),
    liability: claim.liability ?? null,
  };
}

/** The party id for a contact on the claim (draft recipients). */
export function partyForContact(ctx: AppContext, claimId: string, contact: ContactRole | null | undefined): string | null {
  const claim = ctx.repos.getClaim(ctx.db, claimId);
  if (!claim || !contact) return null;
  if (contact === 'client') return claim.claimantId;
  if (contact === 'at_fault_insurer') return claim.atFaultInsurerId ?? null;
  for (const pid of claim.thirdPartyIds) {
    const p = ctx.repos.getParty(ctx.db, pid);
    if (p?.roles.includes(contact as never)) return p.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Log + audit helpers
// ---------------------------------------------------------------------------

export function logInput(ctx: AppContext, input: Pick<ClaimAiInputRecord, 'id' | 'claimId'>, kind: Parameters<AppContext['repos']['appendAiInputLog']>[1]['kind'], actor: string, extra: { actionKey?: string; action?: unknown; refs?: unknown; note?: string; runId?: string } = {}) {
  return ctx.repos.appendAiInputLog(ctx.db, { inputId: input.id, claimId: input.claimId, kind, actor, at: ctx.now(), ...extra });
}

export function auditInput(ctx: AppContext, actor: Actor, action: string, input: Pick<ClaimAiInputRecord, 'id' | 'claimId'>, after: Record<string, unknown> = {}): void {
  ctx.repos.appendAudit(ctx.db, { actor, action, entity: 'claim_ai_inputs', entityId: input.id, after: { inputId: input.id, claimId: input.claimId, ...after }, at: ctx.now() });
}

/** Close open Needs-you cards raised for an input (answered, applied or cancelled). */
export function supersedeInputCards(ctx: AppContext, inputId: string, actor: string, kinds: string[] = ['question', 'ready']): void {
  for (const k of kinds) {
    const item = ctx.repos.findOpenNeedsYouByDedupeKey(ctx.db, `claim_ai:${k}:${inputId}`);
    if (item && (item.status === 'open' || item.status === 'snoozed')) {
      ctx.repos.transitionNeedsYou(ctx.db, item.id, { to: 'superseded', actor, note: 'answered in the AI input panel', now: ctx.now() });
    }
  }
}

/** The low-priority "question" card for an input that has questions (so an owner who walked away still sees it). */
export function raiseQuestionCard(ctx: AppContext, input: ClaimAiInputRecord, questions: Question[], createdBy: string): string | null {
  if (!questions.length) return null;
  const claim = ctx.repos.getClaim(ctx.db, input.claimId);
  const item = createNeedsYou(ctx, {
    kind: 'question',
    claimId: input.claimId,
    title: `A question about your update on ${claim?.reference ?? 'a claim'}`,
    summary: questions.map((q) => q.text).join('\n').slice(0, 2000),
    options: [
      { id: 'open', label: 'Open the AI input', tone: 'primary' },
      { id: 'dismiss', label: 'Dismiss', tone: 'neutral' },
    ],
    payload: { claimId: input.claimId, inputId: input.id, link: `/claims/${input.claimId}/ai`, kind: 'claim_ai_question' },
    priority: 'low',
    createdBy,
    dedupeKey: `claim_ai:question:${input.id}`,
  });
  return item.id;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface UpdateBody {
  text: string;
  channel?: 'typed' | 'call_note' | 'voice_note';
  extraText?: string | null;
}

export function assertClaimOpenForInput(ctx: AppContext, claimId: string) {
  const claim = requireClaimFor(ctx, claimId);
  if (CLOSED_CLAIM.has(claim.status)) throw new HttpError(409, 'CLAIM_CLOSED', `This claim is ${claim.status}`, { status: claim.status });
  return claim;
}

/** Store the owner's update (status interpreting) — the interpreter runs right after (interpret.ts). */
export function createUpdateInput(ctx: AppContext, claimId: string, body: UpdateBody, actor: Actor): ClaimAiInputRecord {
  assertHuman(actor, 'give ClaimDesk an update');
  assertClaimOpenForInput(ctx, claimId);
  const text = body.text.trim();
  const extra = body.extraText?.trim() || null;
  if (!text && !extra) throw new HttpError(400, 'VALIDATION', 'Type what happened (or paste a call note)');
  if (text.length > CLAIM_AI_DEFAULTS.maxTextChars) throw new HttpError(400, 'VALIDATION', `At most ${CLAIM_AI_DEFAULTS.maxTextChars} characters`);
  if (extra && extra.length > CLAIM_AI_DEFAULTS.maxExtraChars) throw new HttpError(400, 'VALIDATION', `A call note is at most ${CLAIM_AI_DEFAULTS.maxExtraChars} characters`);
  const input = ctx.repos.createAiInput(ctx.db, { claimId, kind: 'update', channel: body.channel ?? 'typed', text, extraText: extra, status: 'interpreting', createdBy: actor.userId, now: ctx.now() });
  logInput(ctx, input, 'created', actor.userId);
  auditInput(ctx, actor, 'claim_ai.input.create', input, { kind: 'update', channel: input.channel, length: text.length, extraLength: extra?.length ?? 0 });
  return input;
}

/** A catch-up: a smart-intake bundle with the claim fixed + the input that owns it (§8.1). */
export function createCatchUpInput(ctx: AppContext, claimId: string, body: { note?: string | null; autoApply?: boolean }, actor: Actor): ClaimAiInputRecord {
  assertHuman(actor, 'start a catch-up');
  const claim = assertClaimOpenForInput(ctx, claimId);
  const note = (body.note ?? '').trim().slice(0, 2000);
  const day = new Date(Date.parse(ctx.now())).toISOString().slice(0, 10);
  const bundle = createBundle(ctx, { name: `Catch-up ${claim.reference} ${day}`, source: 'upload', mode: 'catch_up', targetClaimId: claim.id }, actor);
  const input = ctx.repos.createAiInput(ctx.db, { claimId, kind: 'catch_up', channel: 'upload', text: note, status: 'reading', bundleId: bundle.id, autoApply: body.autoApply ?? true, createdBy: actor.userId, now: ctx.now() });
  ctx.repos.updateAiInput(ctx.db, input.id, { engine: 'catch_up', interpretation: { ...EMPTY_INTERPRETATION, catchUp: { files: [], willDo: [], blockers: [], bundleRevision: 0, settled: false } } }, ctx.now());
  logInput(ctx, input, 'created', actor.userId, { note: `bundle ${bundle.id}` });
  auditInput(ctx, actor, 'claim_ai.catch_up.create', input, { bundleId: bundle.id, autoApply: input.autoApply, noteLength: note.length });
  return ctx.repos.requireAiInput(ctx.db, input.id);
}

// ---------------------------------------------------------------------------
// Owner steps
// ---------------------------------------------------------------------------

const CANCELLABLE = new Set(['interpreting', 'waiting_ai', 'clarify', 'preview', 'reading', 'failed', 'nothing_to_do']);

export function cancelInput(ctx: AppContext, claimId: string, inputId: string, actor: Actor): ClaimAiInputRecord {
  assertHuman(actor, 'cancel an AI input');
  const input = requireInput(ctx, claimId, inputId);
  if (!CANCELLABLE.has(input.status)) throw new HttpError(409, input.status === 'applying' ? 'INPUT_BUSY' : 'INPUT_APPLIED', `This input is ${input.status}`, { status: input.status });
  ctx.repos.updateAiInput(ctx.db, input.id, { status: 'cancelled' }, ctx.now());
  logInput(ctx, input, 'cancelled', actor.userId);
  supersedeInputCards(ctx, input.id, actor.userId);
  auditInput(ctx, actor, 'claim_ai.input.cancel', input);
  return ctx.repos.requireAiInput(ctx.db, input.id);
}

export function recordAnswers(ctx: AppContext, input: ClaimAiInputRecord, answers: Array<{ questionId: string; optionId?: string | null; text?: string | null; date?: string | null }>, actor: Actor): ClaimAiInputRecord {
  const byId = new Map(interpretationOf(input).questions.map((q) => [q.id, q]));
  const known = new Set(byId.keys());
  const now = ctx.now();
  const stored = answersOf(input);
  for (const a of answers) {
    if (!known.has(a.questionId)) throw new HttpError(400, 'VALIDATION', `Unknown question ${a.questionId}`, { questionId: a.questionId });
    if (!a.optionId && !a.text?.trim() && !a.date) throw new HttpError(400, 'VALIDATION', 'Pick an option, type an answer or give a date', { questionId: a.questionId });
    if (a.date && Number.isNaN(Date.parse(a.date))) throw new HttpError(400, 'VALIDATION', 'Not a date', { questionId: a.questionId });
    const q = byId.get(a.questionId);
    if (a.optionId && q && q.options.length && !q.options.some((o) => o.id === a.optionId)) throw new HttpError(400, 'VALIDATION', `Unknown option ${a.optionId}`, { questionId: a.questionId });
    const label = a.optionId ? (q?.options.find((o) => o.id === a.optionId)?.label ?? null) : null;
    stored.push({ questionId: a.questionId, optionId: a.optionId ?? null, text: a.text?.trim().slice(0, 500) || null, date: a.date ?? null, at: now, by: actor.userId, ...(q ? { question: q.text } : {}), label });
    logInput(ctx, input, 'answered', actor.userId, { note: a.questionId });
  }
  ctx.repos.updateAiInput(ctx.db, input.id, { answers: stored }, now);
  ctx.repos.bumpAiInputRevision(ctx.db, input.id, now);
  auditInput(ctx, actor, 'claim_ai.input.answer', input, { answers: answers.length });
  return ctx.repos.requireAiInput(ctx.db, input.id);
}

export interface FileOverride {
  direction?: 'out' | 'in' | 'none';
  date?: string;
  kind?: CorrespondenceKind;
  notThisClaim?: boolean;
}

/** The owner's per-file overrides, read back from the append-only log (latest wins per field). */
export function fileOverrides(ctx: AppContext, inputId: string): Record<string, FileOverride> {
  const out: Record<string, FileOverride> = {};
  for (const l of ctx.repos.listAiInputLog(ctx.db, inputId)) {
    if (l.kind !== 'file_override' || !l.actionKey) continue;
    const o = (l.action ?? {}) as FileOverride;
    out[l.actionKey] = { ...(out[l.actionKey] ?? {}), ...o };
  }
  return out;
}

export function recordFileOverride(ctx: AppContext, input: ClaimAiInputRecord, fileId: string, body: FileOverride, actor: Actor): void {
  assertHuman(actor, 'correct a catch-up file');
  if (input.kind !== 'catch_up' || !input.bundleId) throw new HttpError(409, 'NOT_CATCH_UP', 'Only catch-up inputs have files');
  const f = ctx.repos.getBundleFile(ctx.db, fileId);
  if (!f || f.bundleId !== input.bundleId) throw new HttpError(404, 'NOT_FOUND', `file ${fileId} not found in this catch-up`);
  if (body.kind && !isCorrespondenceKind(body.kind)) throw new HttpError(400, 'VALIDATION', `Unknown letter kind ${body.kind}`);
  if (body.date && !/^\d{4}-\d{2}-\d{2}/.test(body.date)) throw new HttpError(400, 'VALIDATION', 'The date is YYYY-MM-DD');
  if (body.date && Date.parse(body.date.slice(0, 10)) > Date.parse(ctx.now())) throw new HttpError(400, 'VALIDATION', 'The date is in the future');
  const clean: FileOverride = {
    ...(body.direction ? { direction: body.direction } : {}),
    ...(body.date ? { date: body.date.slice(0, 10) } : {}),
    ...(body.kind ? { kind: body.kind } : {}),
    ...(body.notThisClaim !== undefined ? { notThisClaim: body.notThisClaim } : {}),
  };
  if (!Object.keys(clean).length) throw new HttpError(400, 'VALIDATION', 'Nothing to change');
  logInput(ctx, input, 'file_override', actor.userId, { actionKey: fileId, action: clean });
  ctx.repos.bumpAiInputRevision(ctx.db, input.id, ctx.now());
  auditInput(ctx, actor, 'claim_ai.catch_up.file_override', input, { fileId, fields: Object.keys(clean) });
}
