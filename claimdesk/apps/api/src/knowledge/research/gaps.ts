// owned by knowledge-research
/**
 * Knowledge gaps (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.1, §7.4 step 6, §9.3 gap cards).
 *
 *  - `reportGap`: every question is scrubbed (`scrubForResearch`) before it is stored; claim links live only in
 *    `claim_ids` (internal). The gap key is sha256(normalised question, kind, scope); a duplicate bumps `occurrences`.
 *    Perimeter triage (code): injury → `out_of_scope` (REFER_INJURY); regulated advice → `needs_owner`; FOS → researched
 *    but its findings are tagged Fixmyfile. Priority: blocking a live claim 2; KB verification 5; others 6–8.
 *  - Prepare-and-confirm: a gap that needs the owner (or a blocking gap still unanswered after 24 h) becomes a Needs-you
 *    `knowledge_review` card (variant `gap`) with what was found and where ClaimDesk looked. The owner's answer creates
 *    an `owner_confirmed` item (check method `owner_answer`) and closes the gap.
 *  - Every gap write records `knowledge_changes` + `audit_log` (`knowledge.gap.open` / `knowledge.gap.close`).
 */
import { createHash } from 'node:crypto';
import {
  perimeterTopic,
  scrubForResearch,
  type ClaimDictionary,
  type GapKind,
  type GapOrigin,
  type GapStatus,
  type KnowledgeArea,
  type KnowledgeData,
  type KnowledgeItem,
  type KnowledgeKind,
  type KnowledgeReviewPayload,
  type KnowledgeScope,
} from '@ccguk/domain';
import type { Actor, Db, KnowledgeGapRecord } from '@ccguk/db';
import { OPEN_GAP_STATUSES } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { assertHuman } from '../../services/humanOnly.js';
import { enqueueJob } from '../../agent/core.js';
import { getKnowledgeSettings } from '../settings.js';
import { raiseKnowledgeReview } from '../needsYou.js';
import { addOwnerKnowledge, approveKnowledge } from '../store.js';
import { claimDictionaryFor } from './dictionary.js';

/** Gaps closed for these reasons are not re-opened by a scan (the same question merges into them). */
const SETTLED: ReadonlySet<GapStatus> = new Set(['answered', 'dismissed', 'out_of_scope']);
/** A `no_answer` gap may be raised again after this long. */
const NO_ANSWER_COOLDOWN_MS = 30 * 86_400_000;
/** Retry backoff after an unanswered research attempt: 1 d → 3 d → 7 d (§7.4 step 5). */
export const RESEARCH_BACKOFF_DAYS: readonly number[] = [1, 3, 7];

export const isOpenGap = (g: Pick<KnowledgeGapRecord, 'status'>): boolean => OPEN_GAP_STATUSES.includes(g.status);

const scopeKey = (s: KnowledgeScope): string => (s.kind === 'insurer' ? `insurer:${s.slug}` : s.kind === 'claim_type' ? `claim_type:${s.tag}` : 'global');

export function gapKeyOf(question: string, kind: GapKind, scope: KnowledgeScope): string {
  const norm = question.toLowerCase().replace(/[^a-z0-9[\]]+/g, ' ').trim();
  return createHash('sha256').update(`${norm}\u0000${kind}\u0000${scopeKey(scope)}`).digest('hex').slice(0, 32);
}

export function gapPriority(input: { origin: GapOrigin; kind: GapKind; blocking: boolean; claimIds: string[] }): number {
  if (input.blocking && input.claimIds.length) return 2;
  if (input.origin === 'owner') return 3;
  if (input.blocking) return 4;
  if (input.kind === 'kb_verification') return 5;
  if (input.origin === 'agent_report' || input.origin === 'review_failure' || input.origin === 'source_changed' || input.origin === 'needs_you') return 6;
  if (input.origin === 'research_no_answer' || input.origin === 'intake_unknown') return 7;
  return 8;
}

/** One knowledge_changes row + one audit_log row for a gap (KR-12). */
export function recordGapChange(ctx: AppContext, tx: Db, actor: Actor, at: string, gap: Pick<KnowledgeGapRecord, 'id'>, action: 'knowledge.gap.open' | 'knowledge.gap.close', after: Record<string, unknown>, reason: string | null, extra: { before?: unknown; runId?: string | null; jobId?: string | null; needsYouId?: string | null } = {}): void {
  ctx.repos.appendKnowledgeChange(tx, { at, actor: actor.userId, action, gapId: gap.id, before: extra.before ?? null, after, reason, runId: extra.runId ?? actor.runId ?? null, jobId: extra.jobId ?? null, needsYouId: extra.needsYouId ?? null });
  ctx.repos.appendAudit(tx, { actor, action, entity: 'knowledge_gaps', entityId: gap.id, ...(extra.before !== undefined ? { before: extra.before } : {}), after: { ...after, ...(reason ? { reason } : {}) }, at });
}

export interface GapReportInput {
  kind: GapKind;
  question: string;
  area: KnowledgeArea;
  scope: KnowledgeScope;
  origin: GapOrigin;
  originRef?: string | null;
  claimIds?: string[];
  blocking?: boolean;
  /** Extra context from the reporter (scrubbed, kept with the gap's first change row). */
  context?: string | null;
  raisedBy: string;
  runId?: string | null;
  jobId?: string | null;
  /** Scans skip questions that were already settled (answered / dismissed / out of scope, or no answer recently). */
  skipIfSettled?: boolean;
}

export interface GapReportResult {
  gap: KnowledgeGapRecord;
  status: 'recorded' | 'merged' | 'skipped';
  removed: string[];
}

/** Record a gap (scrubbed, triaged, deduplicated). Gap reports are recorded even while learning is paused (§12.3). */
export function reportGap(ctx: AppContext, input: GapReportInput, deps: { dict?: ClaimDictionary } = {}): GapReportResult {
  const dict = deps.dict ?? claimDictionaryFor(ctx);
  const scrubbed = scrubForResearch(input.question.replace(/\s+/g, ' ').trim(), dict);
  const question = scrubbed.text.slice(0, 1000);
  if (question.replace(/\[[a-z ]+\]/g, '').trim().length < 8) throw badRequest('Ask a general question (no names, registrations or references) of at least a few words');
  const context = input.context ? scrubForResearch(input.context, dict).text.slice(0, 2000) : null;
  const now = ctx.now();
  const actor: Actor = { userId: input.raisedBy, ...(input.runId && input.raisedBy.startsWith('agent:') ? { runId: input.runId } : {}) };
  const gapKey = gapKeyOf(question, input.kind, input.scope);
  const claimIds = [...new Set((input.claimIds ?? []).filter(Boolean))];
  const blocking = Boolean(input.blocking);

  const open = ctx.repos.findOpenKnowledgeGap(ctx.db, gapKey);
  const merge = (g: KnowledgeGapRecord): GapReportResult => {
    const updated = ctx.repos.updateKnowledgeGap(ctx.db, g.id, {
      occurrences: g.occurrences + 1,
      claimIds: [...new Set([...g.claimIds, ...claimIds])].slice(0, 200),
      blocking: g.blocking || blocking,
      priority: Math.min(g.priority, gapPriority({ origin: input.origin, kind: input.kind, blocking, claimIds })),
      lastSeenAt: now,
      updatedAt: now,
    });
    return { gap: updated, status: 'merged', removed: scrubbed.removed };
  };
  if (open) {
    const r = merge(open);
    if (blocking && !open.blocking) maybeResearchNow(ctx, r.gap, input.raisedBy);
    return r;
  }
  const latest = ctx.repos.latestKnowledgeGapByKey(ctx.db, gapKey);
  if (latest && (SETTLED.has(latest.status) || (latest.status === 'no_answer' && latest.closedAt && Date.parse(now) - Date.parse(latest.closedAt) < NO_ANSWER_COOLDOWN_MS))) {
    if (input.skipIfSettled) return { gap: latest, status: 'skipped', removed: scrubbed.removed };
    if (SETTLED.has(latest.status)) return merge(latest);
  }

  const topic = perimeterTopic(question);
  let status: GapStatus = 'open';
  let closeNote: string | null = null;
  if (topic === 'injury') {
    status = 'out_of_scope';
    closeNote = 'Personal injury is referred out (REFER_INJURY); ClaimDesk never researches it.';
  } else if (topic === 'regulated_advice') {
    status = 'needs_owner';
    closeNote = 'This asks for regulated legal advice: the owner decides.';
  }
  const priority = gapPriority({ origin: input.origin, kind: input.kind, blocking, claimIds });
  const gap = ctx.db.transaction((tx) => {
    const g = ctx.repos.insertKnowledgeGap(tx, { gapKey, kind: input.kind, question, area: input.area, scope: input.scope, origin: input.origin, originRef: input.originRef ?? null, claimIds, blocking, priority, status, raisedBy: input.raisedBy, closeNote, closedBy: status === 'out_of_scope' ? 'policy' : null, at: now });
    recordGapChange(ctx, tx, actor, now, g, 'knowledge.gap.open', { gapKey, kind: g.kind, origin: g.origin, status: g.status, priority: g.priority, blocking: g.blocking, topic, removed: scrubbed.removed, ...(context ? { context } : {}) }, closeNote, { runId: input.runId ?? null, jobId: input.jobId ?? null });
    if (status === 'out_of_scope') recordGapChange(ctx, tx, actor, now, g, 'knowledge.gap.close', { status, ruleId: 'REFER_INJURY' }, closeNote, { runId: input.runId ?? null, jobId: input.jobId ?? null });
    return g;
  });
  if (status === 'needs_owner') raiseGapCard(ctx, gap, { createdBy: input.raisedBy });
  else if (status === 'open' && blocking) maybeResearchNow(ctx, gap, input.raisedBy);
  return { gap, status: 'recorded', removed: scrubbed.removed };
}

/** A blocking gap is researched straight away (priority 4) when research is on. */
function maybeResearchNow(ctx: AppContext, gap: KnowledgeGapRecord, createdBy: string): void {
  const s = getKnowledgeSettings(ctx);
  if (!s.learningEnabled || !s.researchEnabled) return;
  try {
    enqueueResearch(ctx, gap, { priority: 4, createdBy });
  } catch (err) {
    ctx.logger.warn('could not queue research for a blocking gap', { error: String(err), gapId: gap.id });
  }
}

/** Queue `knowledge.research` for a gap (idempotent per attempt). */
export function enqueueResearch(ctx: AppContext, gap: KnowledgeGapRecord, opts: { priority?: number; createdBy: string; owner?: boolean }): string {
  const attempt = gap.attempts + 1;
  const job = enqueueJob(ctx, {
    type: 'knowledge.research',
    payload: { gapId: gap.id, attempt, ...(opts.owner ? { owner: true } : {}) },
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    idempotencyKey: `knowledge.research:${gap.id}:${attempt}${opts.owner ? ':owner' : ''}`,
    createdBy: opts.createdBy,
  });
  return job.id;
}

/** Close a gap with a terminal status (answered, no_answer, out_of_scope, dismissed) or move it (needs_owner, answered_pending, open). */
export function setGapStatus(ctx: AppContext, gapId: string, status: GapStatus, actor: Actor, opts: { note?: string | null; answerItemIds?: string[]; nextAttemptAt?: string | null; attempts?: number; runId?: string | null; jobId?: string | null; spend?: Record<string, unknown>; needsYouId?: string | null } = {}): KnowledgeGapRecord {
  const gap = ctx.repos.getKnowledgeGap(ctx.db, gapId);
  if (!gap) throw notFound('knowledge gap', gapId);
  const now = ctx.now();
  const terminal = !OPEN_GAP_STATUSES.includes(status);
  return ctx.db.transaction((tx) => {
    const g = ctx.repos.updateKnowledgeGap(tx, gapId, {
      status,
      ...(opts.answerItemIds ? { answerItemIds: [...new Set([...gap.answerItemIds, ...opts.answerItemIds])] } : {}),
      ...(opts.nextAttemptAt !== undefined ? { nextAttemptAt: opts.nextAttemptAt } : {}),
      ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
      ...(opts.spend ? { spend: { ...gap.spend, ...opts.spend } } : {}),
      ...(opts.needsYouId !== undefined ? { needsYouId: opts.needsYouId } : {}),
      ...(terminal ? { closedBy: actor.userId, closedAt: now, closeNote: (opts.note ?? gap.closeNote ?? null)?.slice(0, 1000) ?? null } : opts.note !== undefined ? { closeNote: opts.note?.slice(0, 1000) ?? null } : {}),
      updatedAt: now,
    });
    if (gap.status !== status) recordGapChange(ctx, tx, actor, now, g, terminal ? 'knowledge.gap.close' : 'knowledge.gap.open', { status, from: gap.status, answerItemIds: g.answerItemIds }, opts.note ?? null, { before: { status: gap.status }, runId: opts.runId ?? null, jobId: opts.jobId ?? null, needsYouId: opts.needsYouId ?? null });
    return g;
  });
}

/** Owner: dismiss a gap (human only). */
export function dismissGap(ctx: AppContext, gapId: string, reason: string, actor: Actor, needsYouId: string | null = null): KnowledgeGapRecord {
  assertHuman(actor, 'dismiss a knowledge gap');
  if (!reason?.trim()) throw badRequest('Give a reason');
  const gap = ctx.repos.getKnowledgeGap(ctx.db, gapId);
  if (!gap) throw notFound('knowledge gap', gapId);
  if (!isOpenGap(gap)) throw conflict('GAP_CLOSED', `This gap is already ${gap.status}`);
  return setGapStatus(ctx, gapId, 'dismissed', actor, { note: reason, needsYouId });
}

/** Owner: research a gap now (human only; priority 3; re-opens a no_answer gap). */
export function researchNow(ctx: AppContext, gapId: string, actor: Actor): { gap: KnowledgeGapRecord; jobId: string } {
  assertHuman(actor, 'start research');
  const s = getKnowledgeSettings(ctx);
  if (!s.learningEnabled) throw conflict('LEARNING_PAUSED', 'Learning is paused (Knowledge ▸ Safety); resume it to research');
  if (!s.researchEnabled) throw conflict('RESEARCH_OFF', 'Research is switched off (Knowledge ▸ Safety)');
  let gap = ctx.repos.getKnowledgeGap(ctx.db, gapId);
  if (!gap) throw notFound('knowledge gap', gapId);
  if (gap.status === 'out_of_scope') throw conflict('GAP_OUT_OF_SCOPE', 'Personal injury is referred out and never researched');
  if (gap.status === 'answered' || gap.status === 'dismissed') throw conflict('GAP_CLOSED', `This gap is ${gap.status}`);
  if (gap.status === 'researching') throw conflict('GAP_RESEARCHING', 'Research is already running for this gap');
  if (gap.status !== 'open') gap = setGapStatus(ctx, gapId, 'open', actor, { note: 'the owner asked for research now', nextAttemptAt: null });
  return { gap, jobId: enqueueResearch(ctx, gap, { priority: 3, createdBy: actor.userId, owner: true }) };
}

/** Where ClaimDesk looked for a gap (snapshots fetched for it), newest first. */
export function lookedFor(ctx: AppContext, gapId: string): { domain: string; url: string | null }[] {
  const seen = new Set<string>();
  const out: { domain: string; url: string | null }[] = [];
  for (const s of ctx.repos.listSourceSnapshots(ctx.db, { gapId, limit: 50 })) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({ domain: s.domain, url: s.url });
  }
  return out.slice(0, 12);
}

/** The prepare-and-confirm card (§7.4 step 6): "I couldn't find X. Here is what I found and where I looked. Do you know?" */
export function raiseGapCard(ctx: AppContext, gap: KnowledgeGapRecord, opts: { createdBy: string; preparedItemId?: string | null; found?: string | null; ownerQuestion?: string | null }): string | null {
  if (gap.needsYouId) {
    const existing = ctx.repos.getNeedsYouItem(ctx.db, gap.needsYouId);
    if (existing && (existing.status === 'open' || existing.status === 'snoozed')) return existing.id;
  }
  const looked = lookedFor(ctx, gap.id);
  const question = opts.ownerQuestion?.trim() || gap.question;
  const payload: KnowledgeReviewPayload = { variant: 'gap', gapId: gap.id, question, preparedItemId: opts.preparedItemId ?? null, looked };
  const where = looked.length ? `Where I looked: ${looked.map((l) => l.domain).filter((d, i, a) => a.indexOf(d) === i).join(', ')}.` : 'I found nothing in ClaimDesk’s own knowledge and fetched no source.';
  const card = raiseKnowledgeReview(ctx, {
    payload,
    title: `I couldn't find: ${question}`.slice(0, 200),
    summary: `${gap.status === 'needs_owner' && gap.closeNote ? `${gap.closeNote} ` : ''}${opts.found ? `What I found: ${opts.found} ` : ''}${where} Do you know? Your answer is saved as confirmed knowledge.`.slice(0, 2000),
    priority: gap.blocking ? 'normal' : 'low',
    dedupeKey: `knowledge_review:gap:${gap.id}`,
    createdBy: opts.createdBy.startsWith('agent:') || opts.createdBy === 'system' ? opts.createdBy : 'agent:researcher',
    ...(gap.claimIds.length === 1 ? { claimId: gap.claimIds[0]! } : {}),
  });
  if (card) ctx.repos.updateKnowledgeGap(ctx.db, gap.id, { needsYouId: card.id, updatedAt: ctx.now() });
  return card?.id ?? null;
}

/** The item kind / area / data an owner's answer to a gap becomes. */
export function ownerAnswerItem(gap: KnowledgeGapRecord, answer: string, title: string | null): { kind: KnowledgeKind; area: KnowledgeArea; title: string; body: string; data: KnowledgeData; scope: KnowledgeScope } {
  const t = (title?.trim() || gap.question).slice(0, 200);
  const insurerSlug = gap.scope.kind === 'insurer' ? gap.scope.slug : null;
  if (gap.kind === 'insurer_process' || gap.kind === 'procedure') {
    const steps = answer.split(/\n+/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, 30);
    return { kind: 'procedure', area: 'procedural', title: t, body: answer, data: { steps: steps.length ? steps : [answer.slice(0, 500)], forWhom: insurerSlug ? 'insurer' : 'other', channel: null, insurerSlug }, scope: gap.scope };
  }
  const area: KnowledgeArea = gap.kind === 'legal_point' || gap.kind === 'kb_verification' ? 'legal' : gap.kind === 'quantum_point' ? 'quantum' : gap.kind === 'engineering' ? 'engineering' : 'procedural';
  return { kind: 'fact', area, title: t, body: answer, data: { statement: answer.slice(0, 2000), figure: null, asOf: null, benchmarkOnly: false, kbCheck: null, stat: null }, scope: gap.scope };
}

/**
 * The owner answered a gap card (resolver runs as the owner): `answer` creates an owner_confirmed item (or approves the
 * prepared one) and closes the gap; `dismiss` dismisses it.
 */
export async function resolveGapCard(ctx: AppContext, payload: Extract<KnowledgeReviewPayload, { variant: 'gap' }>, choice: string, actor: Actor, extra: { edits?: unknown; note?: string; needsYouId: string }): Promise<void> {
  assertHuman(actor, 'answer a knowledge gap');
  const gap = ctx.repos.getKnowledgeGap(ctx.db, payload.gapId);
  if (!gap) throw notFound('knowledge gap', payload.gapId);
  if (choice === 'dismiss') {
    if (!isOpenGap(gap)) return;
    dismissGap(ctx, gap.id, extra.note?.trim() || 'dismissed from Needs you', actor, extra.needsYouId);
    return;
  }
  if (choice !== 'answer') throw badRequest(`Unknown option ${choice} for a knowledge gap`);
  const edits = (extra.edits && typeof extra.edits === 'object' ? extra.edits : {}) as { answer?: unknown; title?: unknown; usePrepared?: unknown };
  if (edits.usePrepared === true && payload.preparedItemId) {
    const prepared = ctx.repos.getKnowledgeItem(ctx.db, payload.preparedItemId);
    if (prepared?.status === 'proposed') approveKnowledge(ctx, prepared.id, { note: extra.note ?? 'confirmed from the gap card', needsYouId: extra.needsYouId }, actor);
    setGapStatus(ctx, gap.id, 'answered', actor, { note: 'the owner confirmed the prepared answer', answerItemIds: [payload.preparedItemId], needsYouId: extra.needsYouId });
    return;
  }
  const answer = typeof edits.answer === 'string' ? edits.answer.trim() : typeof extra.edits === 'string' ? extra.edits.trim() : '';
  if (answer.length < 3) throw badRequest('Type the answer (it is saved as knowledge you confirmed)');
  const shaped = ownerAnswerItem(gap, answer.slice(0, 4000), typeof edits.title === 'string' ? edits.title : null);
  const r = addOwnerKnowledge(ctx, { ...shaped, gapId: gap.id, note: extra.note ?? 'answered a knowledge gap', needsYouId: extra.needsYouId, tags: [`gap:${gap.gapKey}`] }, actor);
  setGapStatus(ctx, gap.id, 'answered', actor, { note: 'answered by the owner', answerItemIds: [r.item.id], needsYouId: extra.needsYouId });
}

/**
 * onItemStatus (research's part): an answer item that becomes active closes its gap as answered; when every
 * proposed answer of an `answered_pending` gap was rejected, the gap goes back to the queue (or to the owner).
 */
export function gapItemStatusChanged(ctx: AppContext, item: KnowledgeItem): void {
  if (!item.gapId) return;
  const gap = ctx.repos.getKnowledgeGap(ctx.db, item.gapId);
  if (!gap || !isOpenGap(gap)) return;
  const actor: Actor = { userId: 'agent:supervisor' };
  if (item.status === 'active') {
    setGapStatus(ctx, gap.id, 'answered', actor, { note: `answered by ki:${item.id}`, answerItemIds: [item.id] });
    return;
  }
  if ((item.status === 'rejected' || item.status === 'retired') && gap.status === 'answered_pending') {
    const others = ctx.repos.getKnowledgeItems(ctx.db, gap.answerItemIds).filter((i) => i.id !== item.id && (i.status === 'proposed' || i.status === 'active'));
    if (others.length) return;
    const max = getKnowledgeSettings(ctx).budgets.gapMaxAttempts;
    if (gap.attempts < max) setGapStatus(ctx, gap.id, 'open', actor, { note: 'the proposed answer was rejected; research will try again', nextAttemptAt: nextAttemptAfter(ctx, gap.attempts) });
    else {
      const g = setGapStatus(ctx, gap.id, 'needs_owner', actor, { note: 'the proposed answers were rejected' });
      raiseGapCard(ctx, g, { createdBy: 'agent:researcher' });
    }
  }
}

/** When the next research attempt may run after `attempts` attempts (1 d → 3 d → 7 d). */
export function nextAttemptAfter(ctx: AppContext, attempts: number): string {
  const days = RESEARCH_BACKOFF_DAYS[Math.min(Math.max(attempts, 1), RESEARCH_BACKOFF_DAYS.length) - 1]!;
  return new Date(Date.parse(ctx.now()) + days * 86_400_000).toISOString();
}

export { claimDictionaryFor };
