// owned by claimai-server
/**
 * The apply engine (docs/CLAIM-AI-INPUT.md §6.2): one owner click ("Do it" / "File and record now") or the catch-up
 * auto job runs the ticked lines through their executors, in groups so a job (a draft) sees the updated file: files →
 * records → events → fields → hire → tasks / instructions / pauses → jobs → Needs-you cards. Each line is its own
 * transaction (as when the owner clicks through the screens); a refusal is that line's failure. Retry-safe: a line
 * already applied (log) is never run again. Clocks before / after, the Autopilot re-plan and the case manager's review
 * follow; "What changed" is stored on the input.
 */
import {
  ACCUSATION_WORDS,
  BANNED_INTAKE_WORDS,
  TIER_LABEL,
  buildAction,
  clockChanges,
  isAgentScope,
  stepTitle,
  whatChangedLines,
  type ActionParams,
  type ActionType,
  type AgentScope,
  type AppliedLine,
  type Clock,
  type ClockView,
  type PlannedAction,
  type WhatChanged,
} from '@ccguk/domain';
import type { Actor, ClaimAiInputLogRecord, ClaimAiInputRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { enqueueJob } from '../agent/core.js';
import { runtimeServices } from '../agent/needsYou.js';
import { HttpError } from '../errors.js';
import { claimChanged } from '../autopilot/claimChanged.js';
import { autopilotView } from '../autopilot/service.js';
import { recomputeClocks } from '../services/claimView.js';
import { agentApplier, applyProposals } from '../intake/apply.js';
import { proposeField } from '../intake/proposals.js';
import { raiseBundleConfirmCard } from '../intake/bundles/attach.js';
import { computeBundle, type BundleState } from '../intake/bundles/recompute.js';
import { executeAction, type ExecEnv, type ExecResult } from './actions.js';
import { auditInput, interpretationOf, logInput, requireInput, supersedeInputCards, type StoredInterpretation } from './service.js';

export interface ApplyChoice {
  key: string;
  ticked: boolean;
  edits?: { at?: string; value?: string; dueAt?: string; until?: string | null; text?: string; appliesTo?: AgentScope[] };
}

export type LineState = 'proposed' | 'applied' | 'not_applied' | 'skipped' | 'failed' | 'needs_you' | 'undone';

export interface LineResult {
  state: LineState;
  refs: Record<string, unknown>;
  message: string | null;
  error: { code: string; message: string } | null;
  at: string | null;
  /** The action as it was applied (edits included). */
  action: PlannedAction | null;
}

/** Latest state per action key, from the append-only log. */
export function lineResults(log: ClaimAiInputLogRecord[]): Map<string, LineResult> {
  const out = new Map<string, LineResult>();
  for (const l of log) {
    if (!l.actionKey) continue;
    const prev = out.get(l.actionKey);
    const refs = (l.refs ?? {}) as Record<string, unknown>;
    const action = (l.action as PlannedAction | undefined) ?? prev?.action ?? null;
    switch (l.kind) {
      case 'applied':
        out.set(l.actionKey, { state: 'applied', refs, message: l.note ?? null, error: null, at: l.at, action });
        break;
      case 'needs_you':
        out.set(l.actionKey, { state: 'needs_you', refs, message: l.note ?? null, error: null, at: l.at, action });
        break;
      case 'failed':
        out.set(l.actionKey, { state: 'failed', refs, message: null, error: { code: String(refs.code ?? 'FAILED'), message: l.note ?? 'Not done' }, at: l.at, action });
        break;
      case 'skipped':
        out.set(l.actionKey, { state: 'not_applied', refs, message: l.note ?? null, error: null, at: l.at, action });
        break;
      case 'undone':
        out.set(l.actionKey, { state: 'undone', refs: { ...(prev?.refs ?? {}), ...refs }, message: l.note ?? null, error: null, at: l.at, action });
        break;
      case 'undo_failed':
        if (prev) out.set(l.actionKey, { ...prev, message: l.note ?? 'Not undone' });
        break;
      default:
        break;
    }
  }
  return out;
}

const GROUP: Readonly<Record<ActionType, number>> = {
  file_evidence: 0,
  record_correspondence: 1,
  event: 2,
  note: 2,
  field_update: 3,
  liability_position: 3,
  status_change: 3,
  hire_end: 4,
  hire_correct: 4,
  hire_start: 4,
  task: 5,
  instruction: 5,
  pause_agents: 5,
  resume_agents: 5,
  run_job: 6,
  money: 7,
  offer_received: 7,
  offer_decision: 7,
  legal: 7,
  close_or_decline: 7,
  private_note: 8,
  unsupported: 9,
};
const RECORD_TYPES = new Set<ActionType>(['file_evidence', 'record_correspondence', 'event', 'note', 'field_update', 'liability_position', 'hire_end', 'hire_correct', 'status_change']);

const keyNum = (k: string): number => Number(k.replace(/^\D+/, '').replace(/\D.*$/, '')) || 0;
export function orderActions(actions: PlannedAction[]): PlannedAction[] {
  return [...actions].sort((a, b) => GROUP[a.type] - GROUP[b.type] || keyNum(a.key) - keyNum(b.key) || a.key.localeCompare(b.key));
}

/** Validate an owner's edit of one line (same checks as the interpreter, §5.4); returns the edited action. */
export function applyEdits(ctx: AppContext, a: PlannedAction, edits: NonNullable<ApplyChoice['edits']>): PlannedAction {
  const bad = (message: string) => new HttpError(400, 'VALIDATION', message, { key: a.key, message });
  const p: ActionParams = { ...a.params };
  for (const k of Object.keys(edits) as Array<keyof typeof edits>) {
    if (edits[k] === undefined) continue;
    const allowed = k === 'until' || k === 'appliesTo' ? a.editable.includes(k) : a.editable.includes(k as never);
    if (!allowed) throw bad(`${k} cannot be changed on this line`);
  }
  const date = (v: string, what: string) => {
    if (Number.isNaN(Date.parse(v))) throw bad(`${what} is not a date`);
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(Date.parse(`${v}T11:00:00Z`)).toISOString() : new Date(Date.parse(v)).toISOString();
  };
  if (edits.at !== undefined) {
    const at = date(edits.at, 'The date');
    if (Date.parse(at) > Date.parse(ctx.now()) + 3_600_000 && a.type !== 'task') throw bad('That date is in the future');
    if (a.type === 'hire_end') p.endAt = at;
    else if (a.type === 'hire_correct') {
      if (p.startAt) p.startAt = at;
      else p.endAt = at;
    } else p.at = at;
    p.precision = /^\d{4}-\d{2}-\d{2}$/.test(edits.at) ? 'date' : 'datetime';
  }
  if (edits.dueAt !== undefined) p.dueAt = date(edits.dueAt, 'The reminder date');
  if (edits.until !== undefined) p.until = edits.until === null ? null : date(edits.until, 'The end date');
  if (edits.text !== undefined) {
    const t = edits.text.replace(/\s+/g, ' ').trim();
    if (!t || t.length > 1000) throw bad('The text is 1–1000 characters');
    if (ACCUSATION_WORDS.test(t) || BANNED_INTAKE_WORDS.test(t)) throw bad('This cannot carry an accusation — it stays a private note');
    if (a.type === 'task') p.note = t;
    else if (a.type === 'note') {
      p.text = t;
      p.summary = t;
    } else p.text = t;
  }
  if (edits.value !== undefined) {
    const v = edits.value.trim();
    if (!v) throw bad('No value');
    p.value = v;
  }
  if (edits.appliesTo !== undefined) {
    const scopes = edits.appliesTo.filter(isAgentScope);
    if (!scopes.length) throw bad('Say which agents follow it');
    p.appliesTo = scopes;
  }
  const rebuilt = buildAction({ key: a.key, type: a.type, params: p, quote: a.quote, source: a.source, from: a.from, confidence: a.confidence, detail: a.detail, tier: { quoteVerified: a.source === 'ai' ? a.confidence > 0.5 : null } });
  // the owner's edit never promotes a line: keep the stricter of the two tiers
  const rank = { refused: 0, private: 0, open_screen: 1, needs_you: 2, confirm: 3, apply: 4 } as const;
  return rank[rebuilt.tier] > rank[a.tier] ? { ...rebuilt, tier: a.tier, why: a.why, tickable: a.tickable } : rebuilt;
}

function recordCorrection(ctx: AppContext, input: ClaimAiInputRecord, before: PlannedAction, after: PlannedAction | null, actor: Actor): void {
  const record = runtimeServices(ctx).recordCorrection;
  if (!record || before.source !== 'ai') return;
  try {
    record(ctx, {
      needsYouId: `claim-ai:${input.id}`,
      kind: 'question',
      claimId: input.claimId,
      optionId: 'apply',
      before: { aiInputAction: { type: before.type, params: before.params, quote: before.quote } },
      after: { aiInputAction: after ? { type: after.type, params: after.params } : null },
      actor,
    });
  } catch (err) {
    ctx.logger.warn('claim AI input: a correction could not be recorded', { inputId: input.id, error: String(err) });
  }
}

const toView = (c: Clock): ClockView => ({ kind: c.kind, label: c.label, status: c.status, startsAt: c.startsAt, dueAt: c.dueAt, ...(c.metAt ? { metAt: c.metAt } : {}) });

export function linkFor(claimId: string, a: PlannedAction, r: { refs: Record<string, unknown> }): string | null {
  const refs = r.refs;
  if (refs.needsYouId) return `/needs-you?item=${String(refs.needsYouId)}`;
  switch (a.type) {
    case 'event':
    case 'note':
    case 'record_correspondence':
      return `/claims/${claimId}/chronology`;
    case 'hire_end':
    case 'hire_correct':
    case 'hire_start':
      return `/claims/${claimId}/hire`;
    case 'file_evidence':
      return `/claims/${claimId}/evidence`;
    case 'run_job':
      return a.params.jobKind === 'replan' ? `/claims/${claimId}/autopilot` : `/claims/${claimId}/agent`;
    case 'offer_received':
      return `/claims/${claimId}/offers`;
    case 'instruction':
    case 'pause_agents':
    case 'resume_agents':
      return `/claims/${claimId}/ai`;
    default:
      return null;
  }
}

export function autopilotFirstSteps(ctx: AppContext, claimId: string): WhatChanged['autopilot'] {
  try {
    const v = autopilotView(ctx, claimId);
    const first = v.plan.steps.filter((s) => ['due', 'waiting', 'blocked', 'in_progress', 'paused'].includes(s.status)).slice(0, 5);
    return { stopped: v.stopped, firstSteps: first.map((s) => ({ id: s.id, title: stepTitle(s.id), status: s.status, sentence: s.next })) };
  } catch (err) {
    ctx.logger.warn('claim AI input: autopilot view failed', { claimId, error: String(err) });
    return null;
  }
}

export interface ApplyOptions {
  mode: 'owner' | 'agent';
  jobId?: string;
  /** Re-apply one failed key ("Try again"). */
  onlyKeys?: string[];
}

const APPLY_FROM: ClaimAiInputRecord['status'][] = ['preview', 'clarify', 'waiting_ai', 'partly_applied', 'applied'];

/** Apply an input's lines (owner choices, or the catch-up auto job's `apply` lines). */
export async function applyInput(ctx: AppContext, actor: Actor, claimId: string, inputId: string, choices: ApplyChoice[], opts: ApplyOptions): Promise<ClaimAiInputRecord> {
  const input = requireInput(ctx, claimId, inputId);
  const from = input.kind === 'catch_up' ? [...APPLY_FROM, 'reading' as const] : APPLY_FROM.filter((s) => s !== 'applied');
  if (input.status === 'applying') throw new HttpError(409, 'INPUT_BUSY', 'This input is being applied right now');
  if (!from.includes(input.status)) throw new HttpError(409, 'INPUT_NOT_READY', `This input is ${input.status}`, { status: input.status });
  if (!ctx.repos.casAiInputStatus(ctx.db, input.id, from, 'applying', ctx.now())) throw new HttpError(409, 'INPUT_BUSY', 'This input is being applied right now');
  const restore = () => ctx.repos.casAiInputStatus(ctx.db, input.id, ['applying'], input.status, ctx.now());
  try {
    return await runApply(ctx, actor, input, choices, opts);
  } catch (err) {
    restore();
    throw err;
  }
}

async function runApply(ctx: AppContext, actor: Actor, input: ClaimAiInputRecord, choices: ApplyChoice[], opts: ApplyOptions): Promise<ClaimAiInputRecord> {
  const claimId = input.claimId;
  const interp = interpretationOf(input);
  const byKey = new Map(interp.actions.map((a) => [a.key, a]));
  const done = lineResults(ctx.repos.listAiInputLog(ctx.db, input.id));
  const choiceOf = new Map(choices.map((c) => [c.key, c]));
  // 1. validate the owner's choices and edits (nothing runs on a validation error)
  const edited = new Map<string, PlannedAction>();
  for (const c of choices) {
    const a = byKey.get(c.key);
    if (!a) throw new HttpError(400, 'VALIDATION', `Unknown line ${c.key}`, { key: c.key, message: 'Unknown line' });
    if (c.ticked && !a.tickable) throw new HttpError(400, 'NOT_TICKABLE', `${a.title} cannot be ticked`, { key: c.key });
    if (c.edits && Object.values(c.edits).some((v) => v !== undefined)) edited.set(c.key, applyEdits(ctx, a, c.edits));
  }
  const now = ctx.now();
  for (const [key, a] of edited) {
    logInput(ctx, input, 'edited', actor.userId, { actionKey: key, action: a });
    auditInput(ctx, actor, 'claim_ai.input.edit', input, { key, type: a.type });
    recordCorrection(ctx, input, byKey.get(key)!, a, actor);
  }
  // 2. what runs
  const run: PlannedAction[] = [];
  for (const a0 of interp.actions) {
    const a = edited.get(a0.key) ?? a0;
    const prior = done.get(a.key);
    if (prior && (prior.state === 'applied' || prior.state === 'needs_you' || prior.state === 'undone')) continue;
    if (opts.onlyKeys && !opts.onlyKeys.includes(a.key)) continue;
    if (opts.mode === 'agent') {
      if (a.tier === 'apply') run.push(a);
      continue;
    }
    if (a.type === 'private_note') {
      run.push(a);
      continue;
    }
    const c = choiceOf.get(a.key);
    const ticked = c ? c.ticked : a.ticked;
    if (ticked && a.tickable) run.push(a);
    else if (!prior && a.tickable) {
      logInput(ctx, input, 'skipped', actor.userId, { actionKey: a.key, action: a, note: 'not ticked' });
      if (a.source === 'ai' && (a.tier === 'apply' || (c && !c.ticked))) recordCorrection(ctx, input, a, null, actor);
    }
  }
  // 3. clocks before
  let before: ClockView[] = [];
  try {
    before = recomputeClocks(ctx, claimId).map(toView);
  } catch {
    before = [];
  }
  // 4. execute
  const bundle: BundleState | undefined = input.kind === 'catch_up' && input.bundleId ? computeBundle(ctx, input.bundleId) : undefined;
  const filed: Record<string, string> = {};
  if (bundle) for (const f of bundle.files) if (f.filedClaimId === claimId && f.filedEvidenceId) filed[f.id] = f.filedEvidenceId;
  const env: ExecEnv = { ctx, claimId, input, actor, mode: opts.mode, ...(bundle ? { bundle } : {}), filed };
  const results = new Map<string, ExecResult>();
  const fieldLinesAgent: PlannedAction[] = [];
  for (const a of orderActions(run)) {
    if (opts.mode === 'agent' && a.type === 'field_update') {
      fieldLinesAgent.push(a);
      continue;
    }
    let r: ExecResult;
    try {
      r = await executeAction(env, a);
    } catch (err) {
      const e = err as { code?: string; message?: string; statusCode?: number };
      r = { state: 'failed', refs: {}, error: { code: e.code ?? 'ERROR', message: (e.message ?? String(err)).slice(0, 500) } };
    }
    results.set(a.key, r);
    logLine(ctx, input, a, r, actor);
  }
  // catch-up fields as agent:intake: the intake proposal policy decides (auto → applied; the rest → one confirm card)
  if (fieldLinesAgent.length) {
    const proposals = [];
    for (const a of fieldLinesAgent) {
      const p = proposeField(ctx, { claimId, target: a.params.target!, value: a.params.value!, confidence: a.confidence, source: { via: 'extraction', label: `catch-up '${input.id.slice(0, 8)}'`, quote: a.quote ?? null } });
      if (p.kind === 'skipped') {
        const r: ExecResult = p.reason === 'already on the claim' ? { state: 'applied', refs: {}, message: 'Already on the claim' } : { state: 'failed', refs: {}, error: { code: 'VALIDATION', message: p.reason } };
        results.set(a.key, r);
        logLine(ctx, input, a, r, actor);
        continue;
      }
      proposals.push({ a, proposal: p.proposal });
    }
    const auto = proposals.filter((x) => x.proposal.status === 'pending' && x.proposal.policyDecision === 'auto');
    const outcomes = auto.length ? await applyProposals(ctx, auto.map((x) => x.proposal), agentApplier(ctx, { claimId, jobId: opts.jobId ?? `claim-ai-${input.id}` })) : [];
    const okIds = new Set(outcomes.filter((o) => o.ok).map((o) => o.proposalId));
    const pending = [];
    for (const { a, proposal } of proposals) {
      const r: ExecResult = okIds.has(proposal.id) ? { state: 'applied', refs: { proposalId: proposal.id } } : { state: 'needs_you', refs: { proposalId: proposal.id }, message: 'Waiting for your confirmation' };
      if (!okIds.has(proposal.id)) {
        const fresh = ctx.repos.getClaimUpdateProposal(ctx.db, proposal.id);
        if (fresh?.status === 'pending') pending.push(fresh);
      }
      results.set(a.key, r);
    }
    const card = bundle && pending.length ? raiseBundleConfirmCard(ctx, bundle, claimId, pending) : null;
    for (const { a } of proposals) {
      const r = results.get(a.key)!;
      if (card && r.state === 'needs_you') r.refs.needsYouId = card.id;
      logLine(ctx, input, a, r, actor);
    }
  }
  // 5. clocks after, summary
  let after: ClockView[] = [];
  try {
    after = recomputeClocks(ctx, claimId).map(toView);
  } catch {
    after = [];
  }
  const recordApplied = [...results.entries()].some(([k, r]) => r.state === 'applied' && RECORD_TYPES.has((edited.get(k) ?? byKey.get(k))!.type));
  if (results.size) {
    claimChanged(ctx, [claimId], actor.userId, 'AI input applied');
    if (recordApplied) {
      enqueueJob(ctx, { type: 'case.review', payload: { claimId, reason: 'owner' }, claimId, priority: 1, idempotencyKey: `case.review:${claimId}:owner:${ctx.now().slice(0, 16)}`, createdBy: actor.userId });
    }
  }
  const all = lineResults(ctx.repos.listAiInputLog(ctx.db, input.id));
  const lines: AppliedLine[] = [];
  for (const a0 of orderActions(interp.actions)) {
    const r = all.get(a0.key);
    if (!r || r.state === 'proposed') continue;
    const a = r.action ?? a0;
    lines.push({ action: a, refs: r.refs as Record<string, string>, state: r.state, message: r.error?.message ?? r.message });
  }
  const prevSummary = input.summary as WhatChanged | undefined;
  const clocks = clockChanges(before, after);
  const summary = whatChangedLines(lines, before, after, autopilotFirstSteps(ctx, claimId), (l) => linkFor(claimId, l.action, { refs: l.refs }));
  if (!clocks.length && prevSummary?.clocks?.length) {
    summary.clocks = prevSummary.clocks;
    summary.lines.push(...prevSummary.lines.filter((l) => l.kind === 'clock'));
  }
  // 6. status
  const status = statusAfter(input, interp, all, opts.mode);
  const fresh = ctx.repos.updateAiInput(ctx.db, input.id, { status, summary, appliedBy: actor.userId, appliedAt: ctx.now() }, ctx.now());
  supersedeInputCards(ctx, input.id, actor.userId);
  const count = (s: LineState) => [...results.values()].filter((r) => r.state === s).length;
  auditInput(ctx, actor, input.kind === 'catch_up' ? 'claim_ai.catch_up.apply' : 'claim_ai.input.apply', input, {
    mode: opts.mode,
    applied: count('applied'),
    failed: count('failed'),
    needsYou: count('needs_you'),
    notApplied: [...all.values()].filter((r) => r.state === 'not_applied').length,
    status,
  });
  if (input.kind === 'catch_up' && input.bundleId) closeBundleIfFiled(ctx, input, actor);
  void now;
  return fresh;
}

function logLine(ctx: AppContext, input: ClaimAiInputRecord, a: PlannedAction, r: ExecResult, actor: Actor): void {
  const kind = r.state === 'applied' ? 'applied' : r.state === 'needs_you' ? 'needs_you' : r.state === 'skipped' ? 'skipped' : 'failed';
  const refs = { ...r.refs, ...(r.error ? { code: r.error.code } : {}) };
  logInput(ctx, input, kind, actor.userId, { actionKey: a.key, action: a, refs, ...(r.error ? { note: r.error.message.slice(0, 500) } : r.message ? { note: r.message } : {}), ...(actor.runId ? { runId: actor.runId } : {}) });
  if (r.state === 'applied' || r.state === 'needs_you') {
    // per-action audit as the actor: ids only (never the page text)
    const ids = Object.fromEntries(Object.entries(r.refs).filter(([k, v]) => /Id$/.test(k) && typeof v === 'string'));
    ctx.repos.appendAudit(ctx.db, { actor, action: `claim_ai.action.${a.type}`, entity: 'claim_ai_inputs', entityId: input.id, after: { inputId: input.id, claimId: input.claimId, key: a.key, state: r.state, refs: ids }, at: ctx.now() });
  }
}

/** applied / partly_applied after a run (§6.2 step 6, §8.7). */
function statusAfter(input: ClaimAiInputRecord, interp: StoredInterpretation, all: Map<string, LineResult>, mode: 'owner' | 'agent'): ClaimAiInputRecord['status'] {
  const failed = [...all.values()].some((r) => r.state === 'failed');
  if (input.kind === 'update') return interp.pendingText.length || failed ? 'partly_applied' : 'applied';
  // catch-up: lines still waiting for the owner (who sent it?, a confirm line the job could not tick) keep it open
  const waiting = interp.actions.some((a) => {
    const r = all.get(a.key);
    if (r && (r.state === 'applied' || r.state === 'needs_you' || r.state === 'undone')) return false;
    if (!a.tickable && a.type === 'record_correspondence' && a.tier === 'confirm') return true; // "Who sent it?"
    if (mode === 'agent') return a.tier === 'confirm' || a.tier === 'apply';
    return a.tier === 'apply';
  });
  return waiting || failed || !(interp.catchUp?.settled ?? true) ? 'partly_applied' : 'applied';
}

/** The bundle is attached once no main-group file is left to file (§8.7). */
function closeBundleIfFiled(ctx: AppContext, input: ClaimAiInputRecord, actor: Actor): void {
  const b = ctx.repos.getIntakeBundle(ctx.db, input.bundleId!);
  if (!b || b.status === 'attached' || b.status === 'cancelled') return;
  const interp = interpretationOf(ctx.repos.requireAiInput(ctx.db, input.id));
  if (!interp.catchUp?.settled) return;
  const all = lineResults(ctx.repos.listAiInputLog(ctx.db, input.id));
  const fileLines = interp.actions.filter((a) => a.type === 'file_evidence' && a.tier === 'apply');
  if (fileLines.some((a) => all.get(a.key)?.state !== 'applied')) return;
  const now = ctx.now();
  ctx.repos.updateIntakeBundle(ctx.db, b.id, { status: 'attached', outcome: 'attached', claimId: input.claimId, closedBy: actor.userId, closedAt: now }, now);
  ctx.repos.appendBundleDecision(ctx.db, { bundleId: b.id, revision: b.revision, kind: 'attach', after: { claimId: input.claimId, catchUp: true, inputId: input.id }, actor: actor.userId, at: now });
}

export { TIER_LABEL };
