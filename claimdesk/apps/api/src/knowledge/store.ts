// owned by knowledge-core
/**
 * The knowledge store (docs/SUPREME-KNOWLEDGE-BUILDER.md §4, §9, §10.4) — the only writer of `knowledge_items`. Every
 * learner, the researcher, the curator and the owner's routes go through it:
 *
 *   proposeKnowledge      validate → item key / version / sha → conflicts → decideKnowledge() → insert (active, proposed
 *                         or rejected) → knowledge_changes + audit_log → publish (auto-apply) or a Needs-you card (queue)
 *   approveKnowledge      human only: a check (owner_review / source_compare) → active → publish
 *   editApproveKnowledge  human only: a new version (content never changes) → check → active
 *   rejectKnowledge, retireKnowledge (the digest's Undo), quarantineKnowledge (alarms; automated allowed — the safe
 *   direction), recordCheck (human only), setHealth (code; display only, KR-2), latestActive, activeLearnedRules
 *   (Phase 3's entry point), insurerSlugForClaim, recordConflicts, resolveConflict.
 *
 * KR-1: code never upgrades verification — the DB triggers refuse it and every upgrade here asserts a person. KR-12:
 * every write records a knowledge_changes row and an audit_log row with the actor, the rule ids, the run and the job.
 */
import { randomUUID } from 'node:crypto';
import {
  contentShaOf,
  decideKnowledge,
  itemKeyFor,
  proposalProblems,
  type ConflictFinding,
  type KnowledgeCheck,
  type KnowledgeConflict,
  type KnowledgeData,
  type KnowledgeDecision,
  type KnowledgeDecisionContext,
  type KnowledgeHealth,
  type KnowledgeItem,
  type KnowledgeProposal,
  type KnowledgeScope,
  type KnowledgeStatus,
  type RuleData,
} from '@ccguk/domain';
import type { Actor, Db } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { HttpError, badRequest, conflict, notFound } from '../errors.js';
import { assertHuman } from '../services/humanOnly.js';
import { enqueueJob } from '../agent/core.js';
import { getKnowledgeSettings } from './settings.js';
import { recordKnowledgeChange } from './changes.js';
import { knowledgeHooks, safeHook } from './hooks.js';
import { schedulePublish } from './publish.js';
import { raiseConflictCard, raiseItemsCard } from './needsYou.js';

export class KnowledgeProposalError extends HttpError {
  constructor(problems: string[]) {
    super(400, 'KNOWLEDGE_INVALID', `The knowledge proposal is not valid: ${problems.join('; ')}`, { problems });
  }
}

export interface ProposeOptions {
  /** Who is acting (default: the proposal's createdBy, with runId for an agent). */
  actor?: Actor;
  contact?: KnowledgeDecisionContext['contact'];
  snapshot?: KnowledgeDecisionContext['snapshot'];
  snippet?: KnowledgeDecisionContext['snippet'];
  /** Conflicts the caller found (learners); `leftRef` '' or 'new' means the item being proposed. */
  conflicts?: ConflictFinding[];
  perimeterFlags?: string[];
  directiveFlags?: string[];
  runId?: string | null;
  jobId?: string | null;
  /** Do not raise a Needs-you card for a queued item (the caller groups its own, or the owner is adding it). */
  noCard?: boolean;
  /** Card grouping for a queued item (one card per insurer's contacts, per curator cluster …). */
  group?: { key: string; title: string };
}

export { recordKnowledgeChange };

export interface ProposeResult {
  item: KnowledgeItem;
  decision: KnowledgeDecision;
  /** false when identical content already existed (idempotent re-proposal) */
  created: boolean;
  conflicts: KnowledgeConflict[];
  publishJobId: string | null;
  needsYouId: string | null;
}

const actorOf = (p: Pick<KnowledgeProposal, 'createdBy' | 'originRunId'>, runId?: string | null): Actor => ({
  userId: p.createdBy,
  ...(p.createdBy.startsWith('agent:') && (runId ?? p.originRunId) ? { runId: (runId ?? p.originRunId)! } : {}),
});

const summaryOf = (i: KnowledgeItem) => ({ id: i.id, itemKey: i.itemKey, version: i.version, kind: i.kind, area: i.area, title: i.title, status: i.status, verification: i.verification, origin: i.origin });

function requireItem(ctx: AppContext, id: string): KnowledgeItem {
  const item = ctx.repos.getKnowledgeItem(ctx.db, id);
  if (!item) throw notFound('knowledge item', id);
  return item;
}

function notifyStatus(ctx: AppContext, item: KnowledgeItem, from: KnowledgeStatus): void {
  const hook = knowledgeHooks(ctx).onItemStatus;
  if (hook) safeHook(ctx, 'onItemStatus', () => hook(ctx, item, from));
}

/** Supersede the current active version of `itemKey` (unless it is `keepId`). Returns the superseded item. */
function supersedeActive(ctx: AppContext, tx: Db, itemKey: string, keepId: string, actor: Actor, at: string, reason: string): KnowledgeItem | undefined {
  const active = ctx.repos.activeKnowledgeByKey(tx, itemKey);
  if (!active || active.id === keepId) return undefined;
  const updated = ctx.repos.updateKnowledgeItemState(tx, active.id, { status: 'superseded', updatedAt: at });
  recordKnowledgeChange(ctx, tx, actor, at, { action: 'knowledge.item.retire', item: active, before: { status: 'active' }, after: { status: 'superseded' }, reason });
  return updated;
}

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

export function proposeKnowledge(ctx: AppContext, proposal: KnowledgeProposal, opts: ProposeOptions = {}): ProposeResult {
  const problems = proposalProblems(proposal);
  if (problems.length) throw new KnowledgeProposalError(problems);
  const settings = getKnowledgeSettings(ctx);
  const actor = opts.actor ?? actorOf(proposal, opts.runId);
  const now = ctx.now();
  const itemKey = itemKeyFor(proposal);
  const sha = contentShaOf(proposal);
  const latest = ctx.repos.latestKnowledgeVersion(ctx.db, itemKey);

  if (latest && latest.contentSha256 === sha) {
    // Identical content: idempotent. A held item is re-decided once learning is back on.
    if (latest.status === 'proposed' && latest.autonomy.outcome === 'hold' && settings.learningEnabled) return redecideHeld(ctx, latest, proposal, opts);
    return { item: latest, decision: latest.autonomy, created: false, conflicts: [], publishJobId: null, needsYouId: latest.needsYouId };
  }

  const active = ctx.repos.activeKnowledgeByKey(ctx.db, itemKey);
  const supersedesTarget = proposal.supersedesId ? ctx.repos.getKnowledgeItem(ctx.db, proposal.supersedesId) : undefined;
  const replaces = active ?? supersedesTarget ?? null;
  const hookConflicts = (() => {
    const hook = knowledgeHooks(ctx).conflictsFor;
    return hook ? (safeHook(ctx, 'conflictsFor', () => hook(ctx, proposal)) ?? []) : [];
  })();
  const findings = [...(opts.conflicts ?? []), ...hookConflicts];
  const decision = decideKnowledge(proposal, {
    settings,
    conflicts: findings,
    perimeterFlags: opts.perimeterFlags ?? [],
    directiveFlags: opts.directiveFlags ?? [],
    replaces: replaces ? { verification: replaces.verification, origin: replaces.origin } : null,
    contact: opts.contact ?? null,
    snapshot: opts.snapshot ?? null,
    snippet: opts.snippet ?? null,
  });
  const status: KnowledgeStatus = decision.outcome === 'auto_apply' ? 'active' : decision.outcome === 'reject' ? 'rejected' : 'proposed';
  const id = randomUUID();
  const version = (latest?.version ?? 0) + 1;
  const outcomeAction = { auto_apply: 'knowledge.item.auto_apply', reject: 'knowledge.item.reject', hold: 'knowledge.item.hold', queue: null }[decision.outcome];
  const recorded: KnowledgeConflict[] = [];

  const item = ctx.db.transaction((tx) => {
    if (status === 'active') supersedeActive(ctx, tx, itemKey, id, actor, now, `superseded by v${version}`);
    let row = ctx.repos.insertKnowledgeItem(tx, {
      id,
      itemKey,
      version,
      kind: proposal.kind,
      area: proposal.area,
      title: proposal.title.trim(),
      body: proposal.body,
      data: proposal.data,
      tags: [...new Set(proposal.tags)],
      scope: proposal.scope,
      business: [...new Set(proposal.business)],
      useLimit: proposal.useLimit,
      origin: proposal.origin,
      confidence: proposal.confidence,
      supportN: proposal.supportN,
      status,
      health: 'ok',
      validFrom: proposal.validFrom ?? null,
      validTo: proposal.validTo ?? null,
      reviewBy: proposal.reviewBy ?? null,
      provenance: proposal.provenance,
      supersedesId: proposal.supersedesId ?? active?.id ?? null,
      gapId: proposal.gapId ?? null,
      contentSha256: sha,
      autonomy: decision,
      createdBy: proposal.createdBy,
      createdAt: now,
      originJobId: proposal.originJobId ?? opts.jobId ?? null,
      originRunId: proposal.originRunId ?? opts.runId ?? null,
      decidedBy: decision.outcome === 'auto_apply' || decision.outcome === 'reject' ? 'policy' : null,
      decidedAt: decision.outcome === 'auto_apply' || decision.outcome === 'reject' ? now : null,
      decisionNote: decision.outcome === 'auto_apply' || decision.outcome === 'reject' ? decision.reasons.join('; ').slice(0, 1000) : null,
      needsYouId: null,
      updatedAt: now,
    });
    const common = { item: row, ruleIds: decision.ruleIds, runId: opts.runId ?? null, jobId: opts.jobId ?? proposal.originJobId ?? null };
    recordKnowledgeChange(ctx, tx, actor, now, { ...common, action: 'knowledge.item.propose', after: { ...summaryOf(row), outcome: decision.outcome }, reason: decision.reasons.join('; ').slice(0, 1000) });
    if (outcomeAction) recordKnowledgeChange(ctx, tx, actor, now, { ...common, action: outcomeAction, after: { status, outcome: decision.outcome }, reason: decision.reasons.join('; ').slice(0, 1000) });
    // Conflicts are recorded by code only (§6.7); the learned side shows `conflicted` (KR-2: display only).
    if (decision.outcome !== 'reject') {
      for (const f of findings) {
        const leftRef = !f.leftRef || f.leftRef === 'new' ? `ki:${id}` : f.leftRef;
        const { conflict: c, created } = ctx.repos.openKnowledgeConflict(tx, { ...f, leftRef, detectedBy: actor.userId, at: now });
        recorded.push(c);
        if (created) recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.conflict.open', item: row, after: { conflictId: c.id, kind: c.kind, leftRef: c.leftRef, rightRef: c.rightRef }, reason: c.detail });
      }
      if (recorded.length) row = ctx.repos.updateKnowledgeItemState(tx, id, { health: 'conflicted', updatedAt: now });
    }
    return row;
  });

  let publishJobId: string | null = null;
  let needsYouId: string | null = null;
  if (item.status === 'active') {
    if (item.origin !== 'computed') publishJobId = schedulePublish(ctx, { reason: `auto-applied ${item.itemKey}`, createdBy: actor.userId })?.id ?? null;
    notifyStatus(ctx, item, 'proposed');
  } else if (decision.outcome === 'queue') {
    if (recorded.length) {
      for (const c of recorded) {
        const card = raiseConflictCard(ctx, c, actor.userId);
        if (card) needsYouId = card.id;
      }
    }
    if (!opts.noCard && !needsYouId) needsYouId = raiseItemsCard(ctx, item, decision, { createdBy: actor.userId, group: opts.group })?.id ?? null;
    if (item.kind === 'rule' && settings.replay.gateRules) enqueueReplayGate(ctx, item, actor.userId);
  }
  const final = needsYouId && item.needsYouId !== needsYouId ? ctx.repos.getKnowledgeItem(ctx.db, item.id) ?? item : item;
  return { item: final, decision, created: true, conflicts: recorded, publishJobId, needsYouId };
}

/** A held (learning-off) item proposed again with learning back on: decide it now. */
function redecideHeld(ctx: AppContext, held: KnowledgeItem, proposal: KnowledgeProposal, opts: ProposeOptions): ProposeResult {
  const settings = getKnowledgeSettings(ctx);
  const actor = opts.actor ?? actorOf(proposal, opts.runId);
  const now = ctx.now();
  const active = ctx.repos.activeKnowledgeByKey(ctx.db, held.itemKey);
  const decision = decideKnowledge(proposal, {
    settings,
    conflicts: opts.conflicts ?? [],
    perimeterFlags: opts.perimeterFlags ?? [],
    directiveFlags: opts.directiveFlags ?? [],
    replaces: active ? { verification: active.verification, origin: active.origin } : null,
    contact: opts.contact ?? null,
    snapshot: opts.snapshot ?? null,
    snippet: opts.snippet ?? null,
  });
  if (decision.outcome === 'hold') return { item: held, decision, created: false, conflicts: [], publishJobId: null, needsYouId: held.needsYouId };
  const status: KnowledgeStatus = decision.outcome === 'auto_apply' ? 'active' : decision.outcome === 'reject' ? 'rejected' : 'proposed';
  const item = ctx.db.transaction((tx) => {
    if (status === 'active') supersedeActive(ctx, tx, held.itemKey, held.id, actor, now, `superseded by v${held.version}`);
 // `autonomy` is a decision record, not content: it may be updated when a held item is decided.
    const row = ctx.repos.updateKnowledgeItemState(tx, held.id, { status, autonomy: decision, ...(status !== 'proposed' ? { decidedBy: 'policy', decidedAt: now, decisionNote: decision.reasons.join('; ').slice(0, 1000) } : {}), updatedAt: now });
    const action = { auto_apply: 'knowledge.item.auto_apply', reject: 'knowledge.item.reject', queue: 'knowledge.item.propose', hold: 'knowledge.item.hold' }[decision.outcome];
    recordKnowledgeChange(ctx, tx, actor, now, { action, item: row, before: { status: 'proposed', outcome: 'hold' }, after: { status, outcome: decision.outcome }, ruleIds: decision.ruleIds, reason: 'learning resumed', runId: opts.runId ?? null, jobId: opts.jobId ?? null });
    return row;
  });
  let publishJobId: string | null = null;
  let needsYouId: string | null = item.needsYouId;
  if (item.status === 'active') {
    if (item.origin !== 'computed') publishJobId = schedulePublish(ctx, { reason: `auto-applied ${item.itemKey}`, createdBy: actor.userId })?.id ?? null;
    notifyStatus(ctx, item, 'proposed');
  } else if (decision.outcome === 'queue' && !opts.noCard) {
    needsYouId = raiseItemsCard(ctx, item, decision, { createdBy: actor.userId, group: opts.group })?.id ?? needsYouId;
  }
  return { item: ctx.repos.getKnowledgeItem(ctx.db, item.id) ?? item, decision, created: false, conflicts: [], publishJobId, needsYouId };
}

/** A rule waiting for the owner gets its golden replay queued (§12.1; the knowledge-use handler runs it). */
function enqueueReplayGate(ctx: AppContext, item: KnowledgeItem, createdBy: string): void {
  try {
    enqueueJob(ctx, { type: 'knowledge.replay', payload: { mode: 'gate', itemIds: [item.id] }, idempotencyKey: `knowledge.replay:gate:${item.contentSha256}`, createdBy });
  } catch (err) {
    ctx.logger.warn('could not queue the replay gate', { error: String(err), itemId: item.id });
  }
}

// ---------------------------------------------------------------------------
// owner decisions
// ---------------------------------------------------------------------------

export interface ApproveInput {
  note?: string | null;
  verification?: 'owner_confirmed' | 'source_verified';
  sourceUrl?: string | null;
  snapshotId?: string | null;
  needsYouId?: string | null;
}

/** Activate `item` with a human check (inside a transaction). Supersedes the current active version of its key. */
function activateWithCheck(ctx: AppContext, tx: Db, item: KnowledgeItem, input: ApproveInput, actor: Actor, at: string, action: 'knowledge.item.approve' | 'knowledge.item.edit_approve'): { item: KnowledgeItem; check: KnowledgeCheck } {
  const verification = input.verification ?? 'owner_confirmed';
  const check = ctx.repos.insertKnowledgeCheck(tx, {
    target: `item:${item.id}`,
    result: verification,
    method: verification === 'source_verified' ? 'source_compare' : 'owner_review',
    snapshotId: input.snapshotId ?? null,
    sourceUrl: input.sourceUrl ?? null,
    quote: null,
    quoteMatch: quoteMatchOf(item, input.snapshotId ?? null),
    note: input.note ?? null,
    checkedBy: actor.userId,
    checkedAt: at,
    needsYouId: input.needsYouId ?? null,
  });
  supersedeActive(ctx, tx, item.itemKey, item.id, actor, at, `superseded by v${item.version} (approved)`);
  const updated = ctx.repos.updateKnowledgeItemState(tx, item.id, { status: 'active', verification, lastCheckId: check.id, decidedBy: actor.userId, decidedAt: at, decisionNote: input.note ?? null, updatedAt: at });
  recordKnowledgeChange(ctx, tx, actor, at, { action: 'knowledge.check', item: updated, after: { checkId: check.id, result: check.result, method: check.method }, reason: input.note ?? null, needsYouId: input.needsYouId ?? null });
  recordKnowledgeChange(ctx, tx, actor, at, { action, item: updated, before: { status: item.status, verification: item.verification }, after: { status: 'active', verification }, reason: input.note ?? null, needsYouId: input.needsYouId ?? null });
  return { item: updated, check };
}

/** Whether every snapshot quote of the item is matched (shown, never decisive: the owner still clicks). */
function quoteMatchOf(item: KnowledgeItem, snapshotId: string | null): KnowledgeCheck['quoteMatch'] {
  const snaps = item.provenance.filter((p) => p.kind === 'snapshot');
  if (!snaps.length) return 'not_applicable';
  const relevant = snapshotId ? snaps.filter((p) => p.kind === 'snapshot' && p.snapshotId === snapshotId) : snaps;
  if (!relevant.length) return 'not_found';
  return relevant.every((p) => p.kind === 'snapshot' && p.quoteMatch === 'exact') ? 'exact' : 'normalised';
}

function assertActivatable(item: KnowledgeItem): void {
  if (item.provenance.length && item.provenance.every((p) => p.kind === 'url')) {
    throw conflict('KNOWLEDGE_NEEDS_SNAPSHOT', 'This item was only discovered by web research (a link, no stored copy). Fetch the page so its quote can be checked before it can be approved.');
  }
}

export function approveKnowledge(ctx: AppContext, id: string, input: ApproveInput, actor: Actor): { item: KnowledgeItem; check: KnowledgeCheck; publishJobId: string | null } {
  assertHuman(actor, 'approve knowledge');
  const item = requireItem(ctx, id);
  if (item.status !== 'proposed') throw conflict('KNOWLEDGE_NOT_PENDING', `This item is ${item.status}; only a proposed item can be approved`, { status: item.status });
  if (item.autonomy.outcome === 'reject') throw conflict('KNOWLEDGE_REJECTED_BY_POLICY', 'The policy rejected this item', { reasons: item.autonomy.reasons });
  assertActivatable(item);
  if (input.verification === 'source_verified' && !input.sourceUrl && !input.snapshotId) throw badRequest('Source-verified needs the source: a snapshot or a URL you compared it against');
  const now = ctx.now();
  const result = ctx.db.transaction((tx) => activateWithCheck(ctx, tx, item, input, actor, now, 'knowledge.item.approve'));
  const publishJobId = result.item.origin !== 'computed' ? (schedulePublish(ctx, { reason: `approved ${result.item.itemKey}`, createdBy: actor.userId })?.id ?? null) : null;
  notifyStatus(ctx, result.item, 'proposed');
  return { ...result, publishJobId };
}

export interface EditApproveInput {
  title: string;
  body: string;
  data: KnowledgeData;
  scope: KnowledgeScope;
  note?: string | null;
  needsYouId?: string | null;
}

/** Edit then approve: the content never changes, so the edit is version + 1 with the owner's check on it. */
export function editApproveKnowledge(ctx: AppContext, id: string, input: EditApproveInput, actor: Actor): { item: KnowledgeItem; check: KnowledgeCheck; replaced: KnowledgeItem; publishJobId: string | null } {
  assertHuman(actor, 'edit and approve knowledge');
  const old = requireItem(ctx, id);
  if (old.status !== 'proposed' && old.status !== 'active') throw conflict('KNOWLEDGE_NOT_EDITABLE', `This item is ${old.status}; only a proposed or active item can be edited`);
  if (old.origin === 'computed') throw conflict('KNOWLEDGE_COMPUTED', 'Computed figures are rebuilt from the records every night and cannot be edited');
  const now = ctx.now();
  const proposal: KnowledgeProposal = {
    kind: old.kind,
    area: old.area,
    title: input.title,
    body: input.body,
    data: input.data,
    tags: old.tags,
    scope: input.scope,
    business: old.business,
    useLimit: old.useLimit,
    origin: old.origin,
    confidence: 1,
    supportN: Math.max(old.supportN, 1),
    validFrom: old.validFrom,
    validTo: old.validTo,
    reviewBy: old.reviewBy,
    provenance: [...old.provenance, { kind: 'owner', userId: actor.userId, at: now, note: input.note ?? null }],
    itemKey: old.itemKey,
    supersedesId: old.id,
    gapId: old.gapId,
    createdBy: actor.userId,
  };
  const problems = proposalProblems(proposal);
  if (problems.length) throw new KnowledgeProposalError(problems);
  // The owner can edit wording, never loosen the perimeter (KN-02, KN-03 still apply).
  const decision = decideKnowledge(proposal, { settings: { ...getKnowledgeSettings(ctx), learningEnabled: true }, conflicts: [], perimeterFlags: [], directiveFlags: [], replaces: null, contact: null, snapshot: null });
  if (decision.outcome === 'reject') throw conflict('KNOWLEDGE_REJECTED_BY_POLICY', `This edit would ${decision.reasons.join('; ')}`, { ruleIds: decision.ruleIds, reasons: decision.reasons });
  const sha = contentShaOf(proposal);
  const latest = ctx.repos.latestKnowledgeVersion(ctx.db, old.itemKey);
  const ownerDecision: KnowledgeDecision = { outcome: 'queue', ruleIds: decision.ruleIds, reasons: ['edited and approved by the owner'], priority: 'low' };
  const result = ctx.db.transaction((tx) => {
    const fresh = ctx.repos.insertKnowledgeItem(tx, {
      id: randomUUID(),
      itemKey: old.itemKey,
      version: (latest?.version ?? old.version) + 1,
      kind: proposal.kind,
      area: proposal.area,
      title: proposal.title.trim(),
      body: proposal.body,
      data: proposal.data,
      tags: proposal.tags,
      scope: proposal.scope,
      business: proposal.business,
      useLimit: proposal.useLimit,
      origin: proposal.origin,
      confidence: proposal.confidence,
      supportN: proposal.supportN,
      status: 'proposed',
      health: 'ok',
      validFrom: proposal.validFrom ?? null,
      validTo: proposal.validTo ?? null,
      reviewBy: proposal.reviewBy ?? null,
      provenance: proposal.provenance,
      supersedesId: old.id,
      gapId: old.gapId,
      contentSha256: sha,
      autonomy: ownerDecision,
      createdBy: actor.userId,
      createdAt: now,
      originJobId: null,
      originRunId: null,
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      needsYouId: input.needsYouId ?? old.needsYouId,
      updatedAt: now,
    });
    recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.item.propose', item: fresh, before: summaryOf(old), after: summaryOf(fresh), reason: 'owner edit', needsYouId: input.needsYouId ?? null });
    let replaced = old;
    if (old.status === 'proposed') {
      replaced = ctx.repos.updateKnowledgeItemState(tx, old.id, { status: 'rejected', decidedBy: actor.userId, decidedAt: now, decisionNote: `replaced by the owner's edit (v${fresh.version})`, updatedAt: now });
      recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.item.reject', item: old, before: { status: 'proposed' }, after: { status: 'rejected' }, reason: `replaced by the owner's edit (v${fresh.version})` });
    }
    const activated = activateWithCheck(ctx, tx, fresh, { note: input.note ?? null, needsYouId: input.needsYouId ?? null }, actor, now, 'knowledge.item.edit_approve');
    if (old.status === 'active') replaced = ctx.repos.getKnowledgeItem(tx, old.id) ?? old;
    return { ...activated, replaced };
  });
  const publishJobId = schedulePublish(ctx, { reason: `edited ${result.item.itemKey}`, createdBy: actor.userId })?.id ?? null;
  notifyStatus(ctx, result.item, 'proposed');
  return { ...result, publishJobId };
}

export function rejectKnowledge(ctx: AppContext, id: string, reason: string, actor: Actor, opts: { needsYouId?: string | null } = {}): KnowledgeItem {
  assertHuman(actor, 'reject knowledge');
  if (!reason?.trim()) throw badRequest('Give a reason (it teaches the learners what not to propose)');
  const item = requireItem(ctx, id);
  if (item.status !== 'proposed') throw conflict('KNOWLEDGE_NOT_PENDING', `This item is ${item.status}; only a proposed item can be rejected`);
  const now = ctx.now();
  const updated = ctx.db.transaction((tx) => {
    const row = ctx.repos.updateKnowledgeItemState(tx, id, { status: 'rejected', decidedBy: actor.userId, decidedAt: now, decisionNote: reason.slice(0, 1000), updatedAt: now });
    recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.item.reject', item: row, before: { status: 'proposed' }, after: { status: 'rejected' }, reason, needsYouId: opts.needsYouId ?? null });
    return row;
  });
  notifyStatus(ctx, updated, 'proposed');
  return updated;
}

/**
 * Retire an active item (the owner's Undo from the digest, a rollback, or `validTo` passing). A person always may;
 * code may only with `allowAutomated` (rollback / expiry — both restrictive: they remove knowledge).
 */
export function retireKnowledge(ctx: AppContext, id: string, reason: string, actor: Actor, opts: { allowAutomated?: boolean; publish?: boolean; needsYouId?: string | null } = {}): { item: KnowledgeItem; publishJobId: string | null } {
  if (!opts.allowAutomated) assertHuman(actor, 'retire knowledge');
  if (!reason?.trim()) throw badRequest('Give a reason');
  const item = requireItem(ctx, id);
  if (item.status !== 'active') throw conflict('KNOWLEDGE_NOT_ACTIVE', `This item is ${item.status}; only an active item can be retired`);
  const now = ctx.now();
  const updated = ctx.db.transaction((tx) => {
    const row = ctx.repos.updateKnowledgeItemState(tx, id, { status: 'retired', decidedBy: actor.userId, decidedAt: now, decisionNote: reason.slice(0, 1000), updatedAt: now });
    recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.item.retire', item: row, before: { status: 'active' }, after: { status: 'retired' }, reason, needsYouId: opts.needsYouId ?? null });
    return row;
  });
  const publishJobId = opts.publish !== false && updated.origin !== 'computed' ? (schedulePublish(ctx, { reason: `retired ${updated.itemKey}`, createdBy: actor.userId })?.id ?? null) : null;
  notifyStatus(ctx, updated, 'active');
  return { item: updated, publishJobId };
}

/** Quarantine an active item (alarms, §12.2). Automated actors allowed: removing knowledge is the safe direction. */
export function quarantineKnowledge(ctx: AppContext, id: string, reason: string, actor: Actor): KnowledgeItem {
  const item = requireItem(ctx, id);
  if (item.status !== 'active') throw conflict('KNOWLEDGE_NOT_ACTIVE', `This item is ${item.status}; only an active item can be quarantined`);
  const now = ctx.now();
  const updated = ctx.db.transaction((tx) => {
    const row = ctx.repos.updateKnowledgeItemState(tx, id, { status: 'quarantined', decidedBy: actor.userId, decidedAt: now, decisionNote: reason.slice(0, 1000), updatedAt: now });
    recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.item.quarantine', item: row, before: { status: 'active' }, after: { status: 'quarantined' }, reason });
    return row;
  });
  if (updated.origin !== 'computed') schedulePublish(ctx, { reason: `quarantined ${updated.itemKey}`, createdBy: actor.userId });
  notifyStatus(ctx, updated, 'active');
  return updated;
}

export interface RecordCheckInput {
  result: KnowledgeCheck['result'];
  method: Exclude<KnowledgeCheck['method'], 'downgrade'>;
  sourceUrl?: string | null;
  snapshotId?: string | null;
  quote?: string | null;
  quoteMatch?: KnowledgeCheck['quoteMatch'];
  note?: string | null;
  needsYouId?: string | null;
}

/**
 * Record a person's check (human only, KR-1). On an item: owner_confirmed / source_verified upgrade it, unverified
 * downgrades it, failed retires it ("wrong"). On a KB entry (`kb:<id>`): the overlay reads it (§4.5).
 */
export function recordCheck(ctx: AppContext, target: `item:${string}` | `kb:${string}`, input: RecordCheckInput, actor: Actor): { check: KnowledgeCheck; item: KnowledgeItem | null } {
  assertHuman(actor, 'record a knowledge check');
  if (input.result === 'source_verified' && !input.sourceUrl && !input.snapshotId) throw badRequest('Source-verified needs the source: a snapshot or a URL you compared it against');
  const now = ctx.now();
  if (target.startsWith('kb:')) {
    const entryId = target.slice(3);
    if (!ctx.kb.entries().some((e) => e.id === entryId)) throw notFound('KB entry', entryId);
    const check = ctx.db.transaction((tx) => {
      const c = ctx.repos.insertKnowledgeCheck(tx, { target, result: input.result, method: input.method, snapshotId: input.snapshotId ?? null, sourceUrl: input.sourceUrl ?? null, quote: input.quote ?? null, quoteMatch: input.quoteMatch ?? 'not_applicable', note: input.note ?? null, checkedBy: actor.userId, checkedAt: now, needsYouId: input.needsYouId ?? null });
      recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.check', after: { checkId: c.id, target, result: c.result, method: c.method }, reason: input.note ?? null, needsYouId: input.needsYouId ?? null });
      return c;
    });
    return { check, item: null };
  }
  const item = requireItem(ctx, target.slice(5));
  if (input.result !== 'failed' && input.result !== 'unverified' && item.status !== 'active' && item.status !== 'proposed') throw conflict('KNOWLEDGE_NOT_CHECKABLE', `This item is ${item.status}`);
  const result = ctx.db.transaction((tx) => {
    const c = ctx.repos.insertKnowledgeCheck(tx, { target, result: input.result, method: input.method, snapshotId: input.snapshotId ?? null, sourceUrl: input.sourceUrl ?? null, quote: input.quote ?? null, quoteMatch: input.quoteMatch ?? quoteMatchOf(item, input.snapshotId ?? null), note: input.note ?? null, checkedBy: actor.userId, checkedAt: now, needsYouId: input.needsYouId ?? null });
    recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.check', item, after: { checkId: c.id, result: c.result, method: c.method }, reason: input.note ?? null, needsYouId: input.needsYouId ?? null });
    let row = item;
    if (c.result === 'owner_confirmed' || c.result === 'source_verified' || (c.result === 'unverified' && item.verification !== 'unverified')) {
      row = ctx.repos.updateKnowledgeItemState(tx, item.id, { verification: c.result, lastCheckId: c.id, updatedAt: now });
    } else if (c.result === 'failed' && item.status === 'active') {
      row = ctx.repos.updateKnowledgeItemState(tx, item.id, { status: 'retired', decidedBy: actor.userId, decidedAt: now, decisionNote: `the owner marked it wrong${input.note ? `: ${input.note}` : ''}`.slice(0, 1000), updatedAt: now });
      recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.item.retire', item: row, before: { status: 'active' }, after: { status: 'retired' }, reason: 'the owner marked it wrong' });
    } else if (c.result === 'failed' && item.status === 'proposed') {
      row = ctx.repos.updateKnowledgeItemState(tx, item.id, { status: 'rejected', decidedBy: actor.userId, decidedAt: now, decisionNote: 'the owner marked it wrong', updatedAt: now });
      recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.item.reject', item: row, before: { status: 'proposed' }, after: { status: 'rejected' }, reason: 'the owner marked it wrong' });
    }
    return { check: c, item: row };
  });
  if (result.item.status !== item.status) {
    if (item.origin !== 'computed') schedulePublish(ctx, { reason: `check on ${item.itemKey}`, createdBy: actor.userId });
    notifyStatus(ctx, result.item, item.status);
  }
  return result;
}

/** Code-set display health (KR-2: never touches verification). No-op when unchanged. */
export function setHealth(ctx: AppContext, id: string, health: KnowledgeHealth, reason: string, actor: Actor = { userId: 'agent:supervisor' }): KnowledgeItem {
  const item = requireItem(ctx, id);
  if (item.health === health) return item;
  const now = ctx.now();
  return ctx.db.transaction((tx) => {
    const row = ctx.repos.updateKnowledgeItemState(tx, id, { health, updatedAt: now });
    recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.item.health', item: row, before: { health: item.health }, after: { health }, reason });
    return row;
  });
}

/** The active version of an item key. */
export function latestActive(ctx: AppContext, itemKey: string): KnowledgeItem | undefined {
  return ctx.repos.activeKnowledgeByKey(ctx.db, itemKey);
}

/** Phase 3's entry point (§4.6): the `rule` items in the active learned-pack version that are still active. */
export function activeLearnedRules(ctx: AppContext): { itemId: string; data: RuleData; item: KnowledgeItem }[] {
  if (!getKnowledgeSettings(ctx).useLearnedKnowledge) return [];
  const state = ctx.repos.getKnowledgePackState(ctx.db);
  if (state.activeVersion === null) return [];
  const members = ctx.repos.listKnowledgePackMembers(ctx.db, state.activeVersion);
  return ctx.repos
    .getKnowledgeItems(ctx.db, members)
    .filter((i) => i.kind === 'rule' && i.status === 'active')
    .sort((a, b) => a.itemKey.localeCompare(b.itemKey))
    .map((i) => ({ itemId: i.id, data: i.data as RuleData, item: i }));
}

/** The claim's at-fault insurer as a directory slug, through `insurer_links` (null when unlinked). */
export function insurerSlugForClaim(ctx: AppContext, claimId: string): string | null {
  const claim = ctx.repos.getClaim(ctx.db, claimId);
  const partyId = (claim as { atFaultInsurerId?: string } | undefined)?.atFaultInsurerId;
  if (!partyId) return null;
  return ctx.repos.getInsurerLink(ctx.db, partyId)?.insurerSlug ?? null;
}

// ---------------------------------------------------------------------------
// conflicts (only code records them; the owner resolves them)
// ---------------------------------------------------------------------------

/** Record conflict findings (code). Learned `ki:` sides show `conflicted`; a card is raised per new conflict. */
export function recordConflicts(ctx: AppContext, findings: readonly ConflictFinding[], opts: { detectedBy: string; card?: boolean }): KnowledgeConflict[] {
  const now = ctx.now();
  const actor: Actor = { userId: opts.detectedBy };
  const out: { conflict: KnowledgeConflict; created: boolean }[] = [];
  ctx.db.transaction((tx) => {
    for (const f of findings) {
      const r = ctx.repos.openKnowledgeConflict(tx, { ...f, detectedBy: opts.detectedBy, at: now });
      out.push(r);
      if (!r.created) continue;
      recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.conflict.open', after: { conflictId: r.conflict.id, kind: f.kind, leftRef: f.leftRef, rightRef: f.rightRef }, reason: f.detail });
      for (const ref of [f.leftRef, f.rightRef]) {
        if (!ref.startsWith('ki:')) continue;
        const item = ctx.repos.getKnowledgeItem(tx, ref.slice(3));
        if (item && item.health !== 'conflicted') {
          ctx.repos.updateKnowledgeItemState(tx, item.id, { health: 'conflicted', updatedAt: now });
          recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.item.health', item, before: { health: item.health }, after: { health: 'conflicted' }, reason: f.detail });
        }
      }
    }
  });
  if (opts.card !== false) for (const r of out) if (r.created) raiseConflictCard(ctx, r.conflict, opts.detectedBy);
  return out.map((r) => r.conflict);
}

export type ConflictKeep = 'left' | 'right' | 'both' | 'retire_both' | 'dismiss';

/** The owner resolves a conflict: keep one side (the other is retired), keep both, retire both, or dismiss. */
export function resolveConflict(ctx: AppContext, id: string, keep: ConflictKeep, note: string | null, actor: Actor): KnowledgeConflict {
  assertHuman(actor, 'resolve a knowledge conflict');
  const c = ctx.repos.getKnowledgeConflict(ctx.db, id);
  if (!c) throw notFound('knowledge conflict', id);
  if (c.status !== 'open') throw conflict('CONFLICT_CLOSED', `This conflict is already ${c.status}`);
  const now = ctx.now();
  const retire = keep === 'left' ? [c.rightRef] : keep === 'right' ? [c.leftRef] : keep === 'retire_both' ? [c.leftRef, c.rightRef] : [];
  const touched: string[] = [];
  const resolved = ctx.db.transaction((tx) => {
    for (const ref of retire) {
      if (!ref.startsWith('ki:')) continue;
      const item = ctx.repos.getKnowledgeItem(tx, ref.slice(3));
      if (!item) continue;
      if (item.status === 'active' || item.status === 'proposed') {
        const status: KnowledgeStatus = item.status === 'active' ? 'retired' : 'rejected';
        const row = ctx.repos.updateKnowledgeItemState(tx, item.id, { status, decidedBy: actor.userId, decidedAt: now, decisionNote: `conflict resolved: ${keep}${note ? ` — ${note}` : ''}`.slice(0, 1000), updatedAt: now });
        recordKnowledgeChange(ctx, tx, actor, now, { action: status === 'retired' ? 'knowledge.item.retire' : 'knowledge.item.reject', item: row, before: { status: item.status }, after: { status }, reason: `conflict ${c.id} resolved: ${keep}` });
        touched.push(item.id);
      }
    }
    const r = ctx.repos.updateKnowledgeConflict(tx, id, { status: keep === 'dismiss' ? 'dismissed' : 'resolved', resolution: `${keep}${note ? `: ${note}` : ''}`.slice(0, 1000), resolvedBy: actor.userId, resolvedAt: now });
    recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.conflict.resolve', after: { conflictId: id, keep }, reason: note });
    // Learned sides with no other open conflict go back to `ok`.
    for (const ref of [c.leftRef, c.rightRef]) {
      if (!ref.startsWith('ki:')) continue;
      const item = ctx.repos.getKnowledgeItem(tx, ref.slice(3));
      if (!item || item.health !== 'conflicted') continue;
      const stillOpen = ctx.repos.listKnowledgeConflicts(tx, { status: 'open', ref }).length > 0;
      if (!stillOpen) {
        ctx.repos.updateKnowledgeItemState(tx, item.id, { health: 'ok', updatedAt: now });
        recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.item.health', item, before: { health: 'conflicted' }, after: { health: 'ok' }, reason: `conflict ${c.id} resolved` });
      }
    }
    return r;
  });
  if (touched.length) schedulePublish(ctx, { reason: `conflict ${c.id} resolved`, createdBy: actor.userId });
  return resolved;
}

/** Owner-added knowledge (POST /knowledge/items): origin owner, approved with an `owner_answer` check in one go. */
export function addOwnerKnowledge(
  ctx: AppContext,
  input: Pick<KnowledgeProposal, 'kind' | 'area' | 'title' | 'body' | 'data' | 'scope'> & { tags?: string[]; business?: KnowledgeProposal['business']; useLimit?: KnowledgeProposal['useLimit']; gapId?: string | null; note?: string | null; needsYouId?: string | null },
  actor: Actor,
): { item: KnowledgeItem; check: KnowledgeCheck; publishJobId: string | null } {
  assertHuman(actor, 'add knowledge');
  const now = ctx.now();
  const proposal: KnowledgeProposal = {
    kind: input.kind,
    area: input.area,
    title: input.title,
    body: input.body,
    data: input.data,
    tags: input.tags ?? [],
    scope: input.scope,
    business: input.business ?? ['ccguk'],
    useLimit: input.useLimit ?? 'internal',
    origin: 'owner',
    confidence: 1,
    supportN: 1,
    provenance: [{ kind: 'owner', userId: actor.userId, at: now, note: input.note ?? null }],
    gapId: input.gapId ?? null,
    createdBy: actor.userId,
  };
  const problems = proposalProblems(proposal);
  if (problems.length) throw new KnowledgeProposalError(problems);
  const decision = decideKnowledge(proposal, { settings: getKnowledgeSettings(ctx), conflicts: [], perimeterFlags: [], directiveFlags: [], replaces: null, contact: null, snapshot: null });
  if (decision.outcome === 'reject') throw conflict('KNOWLEDGE_REJECTED_BY_POLICY', `Knowledge cannot ${decision.reasons.join('; ')}`, { ruleIds: decision.ruleIds, reasons: decision.reasons });
  const proposed = proposeKnowledge(ctx, proposal, { actor, noCard: true });
  if (proposed.item.status === 'active' && proposed.item.verification !== 'unverified') return { item: proposed.item, check: ctx.repos.getKnowledgeCheck(ctx.db, proposed.item.lastCheckId!)!, publishJobId: proposed.publishJobId };
  const item = proposed.item;
  if (item.status !== 'proposed' && item.status !== 'active') throw conflict('KNOWLEDGE_NOT_PENDING', `An identical item exists and is ${item.status}`);
  const result = ctx.db.transaction((tx) => {
    const check = ctx.repos.insertKnowledgeCheck(tx, { target: `item:${item.id}`, result: 'owner_confirmed', method: 'owner_answer', snapshotId: null, sourceUrl: null, quote: null, quoteMatch: 'not_applicable', note: input.note ?? null, checkedBy: actor.userId, checkedAt: now, needsYouId: input.needsYouId ?? null });
    supersedeActive(ctx, tx, item.itemKey, item.id, actor, now, `superseded by the owner's v${item.version}`);
    const row = ctx.repos.updateKnowledgeItemState(tx, item.id, { status: 'active', verification: 'owner_confirmed', lastCheckId: check.id, decidedBy: actor.userId, decidedAt: now, decisionNote: 'added by the owner', updatedAt: now });
    recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.check', item: row, after: { checkId: check.id, result: check.result, method: check.method } });
    recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.item.approve', item: row, before: { status: item.status }, after: { status: 'active', verification: 'owner_confirmed' }, reason: 'added by the owner' });
    return { item: row, check };
  });
  const publishJobId = schedulePublish(ctx, { reason: `owner added ${result.item.itemKey}`, createdBy: actor.userId })?.id ?? null;
  notifyStatus(ctx, result.item, item.status);
  return { ...result, publishJobId };
}
