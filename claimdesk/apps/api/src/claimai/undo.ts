// owned by claimai-server
/**
 * Undo (docs/CLAIM-AI-INPUT.md §6.3): newest first, each line re-checks that undoing is still safe (the value on file
 * is still the applied one, the hire is still as we left it, the job is still queued, the card is still open) and
 * otherwise says why not. Events are undone by correcting events (append-only); evidence filed by a catch-up is never
 * removed; drafts already sent cannot be undone here.
 */
import { COPY, SIDE_EFFECT_EVENT_TYPES, fmtDay, whatChangedLines, type AppliedLine, type PlannedAction, type WhatChanged } from '@ccguk/domain';
import type { Actor, ClaimAiInputRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { assertHuman } from '../services/humanOnly.js';
import { applyProposal, ownerApplier } from '../intake/apply.js';
import { proposeField } from '../intake/proposals.js';
import { ownerCall, type ExecEnv } from './actions.js';
import { autopilotFirstSteps, lineResults, linkFor, orderActions, type LineResult } from './apply.js';
import { withdrawRecord } from './correspondence.js';
import { retireStandingInstruction } from './instructions.js';
import { auditInput, interpretationOf, logInput, requireInput } from './service.js';

const UNDO_FROM = new Set(['applied', 'partly_applied', 'undone']);

type UndoOutcome = { ok: true; refs: Record<string, unknown>; message: string } | { ok: false; why: string };

export async function undoInput(ctx: AppContext, actor: Actor, claimId: string, inputId: string, body: { actionKeys?: string[]; reason?: string | null }): Promise<{ input: ClaimAiInputRecord; results: Record<string, string> }> {
  assertHuman(actor, 'undo an AI input');
  const input = requireInput(ctx, claimId, inputId);
  if (!UNDO_FROM.has(input.status)) throw new HttpError(409, 'INPUT_NOT_READY', `This input is ${input.status}`, { status: input.status });
  const all = lineResults(ctx.repos.listAiInputLog(ctx.db, input.id));
  const interp = interpretationOf(input);
  const order = ctx.repos.listAiInputLog(ctx.db, input.id).filter((l) => l.actionKey && (l.kind === 'applied' || l.kind === 'needs_you')).map((l) => l.actionKey!);
  const keys = [...new Set(order.reverse())].filter((k) => (body.actionKeys ? body.actionKeys.includes(k) : true));
  if (body.actionKeys) for (const k of body.actionKeys) if (!all.has(k)) throw new HttpError(400, 'VALIDATION', `Line ${k} was not applied`, { key: k });
  const env: ExecEnv = { ctx, claimId, input, actor, mode: 'owner', filed: {} };
  const results: Record<string, string> = {};
  for (const key of keys) {
    const r = all.get(key);
    if (!r || (r.state !== 'applied' && r.state !== 'needs_you')) continue;
    const action = r.action ?? interp.actions.find((a) => a.key === key);
    if (!action) continue;
    let out: UndoOutcome;
    try {
      out = await undoOne(env, action, r, body.reason ?? null);
    } catch (err) {
      out = { ok: false, why: (err as Error).message.slice(0, 300) };
    }
    if (out.ok) {
      logInput(ctx, input, 'undone', actor.userId, { actionKey: key, refs: out.refs, note: out.message });
      ctx.repos.appendAudit(ctx.db, { actor, action: 'claim_ai.action.undo', entity: 'claim_ai_inputs', entityId: input.id, after: { inputId: input.id, claimId, key, type: action.type, refs: Object.fromEntries(Object.entries(out.refs).filter(([k]) => /Id$/.test(k))) }, at: ctx.now() });
      results[key] = out.message;
    } else {
      logInput(ctx, input, 'undo_failed', actor.userId, { actionKey: key, note: `Not undone: ${out.why}` });
      results[key] = `Not undone: ${out.why}`;
    }
  }
  const after = lineResults(ctx.repos.listAiInputLog(ctx.db, input.id));
  const stillApplied = [...after.values()].some((x) => (x.state === 'applied' || x.state === 'needs_you') && x.action?.type !== 'private_note' && x.action?.type !== 'file_evidence');
  const anyUndone = [...after.values()].some((x) => x.state === 'undone');
  // What changed is rebuilt from the lines as they are now ("Undone: …"), so the summary never still claims a line
  // that was taken back; the clock lines of the apply are kept, the Autopilot's first steps are fresh.
  const prev = (input.summary ?? null) as WhatChanged | null;
  const lines: AppliedLine[] = [];
  for (const a0 of orderActions(interp.actions)) {
    const r = after.get(a0.key);
    if (!r || r.state === 'proposed') continue;
    lines.push({ action: r.action ?? a0, refs: r.refs as Record<string, string>, state: r.state, message: r.error?.message ?? r.message });
  }
  const summary = whatChangedLines(lines, [], [], autopilotFirstSteps(ctx, claimId), (l) => linkFor(claimId, l.action, { refs: l.refs }));
  if (prev?.clocks?.length) {
    summary.clocks = prev.clocks;
    summary.lines.push(...prev.lines.filter((l) => l.kind === 'clock'));
  }
  const patch = { summary, ...(!stillApplied && anyUndone ? { status: 'undone' as const } : {}) };
  const fresh = Object.keys(results).length ? ctx.repos.updateAiInput(ctx.db, input.id, patch, ctx.now()) : ctx.repos.requireAiInput(ctx.db, input.id);
  auditInput(ctx, actor, 'claim_ai.input.undo', input, { lines: keys.length, undone: Object.values(results).filter((m) => !m.startsWith('Not undone')).length, reasonLength: body.reason?.length ?? 0 });
  return { input: fresh, results };
}

async function undoOne(env: ExecEnv, a: PlannedAction, r: LineResult, reason: string | null): Promise<UndoOutcome> {
  const { ctx, claimId } = env;
  const refs = r.refs as Record<string, string | null | undefined>;
  const when = r.at ? fmtDay(r.at) : 'today';
  switch (a.type) {
    case 'event':
    case 'note': {
      if (a.type === 'event' && a.params.eventType && SIDE_EFFECT_EVENT_TYPES.has(a.params.eventType)) return { ok: false, why: COPY.sideEffectUndo };
      const ev = refs.eventId ? ctx.repos.listEvents(ctx.db, claimId).find((e) => e.id === refs.eventId) : undefined;
      if (!ev) return { ok: false, why: 'the chronology entry was not found' };
      const c = await ownerCall(env, 'POST', `/claims/${claimId}/events`, { type: 'note', at: ev.at, summary: `${COPY.undoEventNote(when)}${reason ? ` — ${reason.slice(0, 200)}` : ''}`, data: { correctsEventId: ev.id, source: 'ai_input', aiInputId: env.input.id, actionKey: a.key } });
      if (!c.ok) return { ok: false, why: c.error.message };
      return { ok: true, refs: { correctingEventId: (c.body as { event?: { id?: string } }).event?.id }, message: 'Withdrawn from the chronology (the entry stays visible, struck through)' };
    }
    case 'field_update': {
      const prev = refs.previous;
      if (!prev) return { ok: false, why: 'there was no value before — change it on the claim' };
      const p = proposeField(ctx, { claimId, target: a.params.target!, value: prev, confidence: 1, source: { via: 'owner', label: 'undo of your AI input' } });
      if (p.kind === 'skipped') return p.reason === 'already on the claim' ? { ok: true, refs: {}, message: 'The previous value is already back' } : { ok: false, why: p.reason };
      if (p.proposal.currentValue && a.params.value && p.proposal.currentValue.replace(/\s+/g, '').toUpperCase() !== a.params.value.replace(/\s+/g, '').toUpperCase()) {
        return { ok: false, why: 'the value on file changed since — change it on the claim' };
      }
      const out = await applyProposal(ctx, p.proposal, ownerApplier(ctx, env.actor), { note: 'undo of your AI input' });
      return out.ok ? { ok: true, refs: { proposalId: p.proposal.id }, message: `Put back: ${prev}` } : { ok: false, why: out.error?.message ?? 'not applied' };
    }
    case 'liability_position': {
      const cur = ctx.repos.getClaim(ctx.db, claimId)?.liability;
      if (cur !== a.params.value) return { ok: false, why: 'liability changed since' };
      const c = await ownerCall(env, 'PATCH', `/claims/${claimId}`, { liability: refs.previous ?? 'unknown' });
      return c.ok ? { ok: true, refs: {}, message: `Liability back to ${refs.previous ?? 'unknown'}` } : { ok: false, why: c.error.message };
    }
    case 'hire_end': {
      const hire = ctx.repos.listHire(ctx.db, claimId).find((h) => h.id === a.params.hireId);
      if (!hire) return { ok: false, why: 'the hire was not found' };
      if (!hire.endAt || Date.parse(hire.endAt) !== Date.parse(String(refs.endAt ?? a.params.endAt))) return { ok: false, why: 'the hire changed since — correct it on the Hire tab' };
      const c = await ownerCall(env, 'PATCH', `/claims/${claimId}/hire/${hire.id}`, { endAt: null, reason: `Undo of your update of ${when}${reason ? `: ${reason.slice(0, 200)}` : ''}` });
      return c.ok ? { ok: true, refs: { hireId: hire.id }, message: `Hire ${hire.agreementNumber} is running again` } : { ok: false, why: c.error.message };
    }
    case 'hire_correct': {
      const body = { ...(a.params.startAt && refs.previousStartAt ? { startAt: refs.previousStartAt } : {}), ...(a.params.endAt ? { endAt: refs.previousEndAt ?? null } : {}), reason: `Undo of your update of ${when}` };
      const c = await ownerCall(env, 'PATCH', `/claims/${claimId}/hire/${a.params.hireId}`, body);
      return c.ok ? { ok: true, refs: {}, message: 'Hire dates put back' } : { ok: false, why: c.error.message };
    }
    case 'task': {
      const t = refs.taskId ? ctx.repos.getTask(ctx.db, refs.taskId) : undefined;
      if (!t || t.status !== 'open') return { ok: false, why: 'the reminder is already done or cancelled' };
      const c = await ownerCall(env, 'POST', `/tasks/${t.id}/cancel`, {});
      return c.ok ? { ok: true, refs: { taskId: t.id }, message: 'Reminder cancelled' } : { ok: false, why: c.error.message };
    }
    case 'instruction': {
      const i = refs.instructionId ? ctx.repos.getInstruction(ctx.db, refs.instructionId) : undefined;
      if (!i) return { ok: false, why: 'the instruction is not on the claim' };
      // already ended (replaced by a newer one, or removed by hand): nothing left in force — the undo is done
      if (i.status !== 'active') return { ok: true, refs: { instructionId: i.id }, message: 'Already ended — nothing to remove' };
      retireStandingInstruction(ctx, claimId, i.id, env.actor, reason ?? 'undo of your AI input');
      return { ok: true, refs: { instructionId: i.id }, message: 'Instruction removed' };
    }
    case 'pause_agents': {
      const c = await ownerCall(env, 'POST', `/claims/${claimId}/agent/resume`, {});
      return c.ok ? { ok: true, refs: {}, message: 'Agents resumed' } : { ok: false, why: c.error.message };
    }
    case 'resume_agents': {
      const c = await ownerCall(env, 'POST', `/claims/${claimId}/agent/pause`, { reason: 'Undo of your AI input' });
      return c.ok ? { ok: true, refs: {}, message: 'Agents paused again' } : { ok: false, why: c.error.message };
    }
    case 'run_job': {
      const job = refs.jobId ? ctx.repos.getAgentJob(ctx.db, refs.jobId) : undefined;
      if (!job) return { ok: false, why: a.params.jobKind === 'replan' ? 'a re-plan cannot be undone' : 'the job was not found' };
      if (job.status !== 'queued' && job.status !== 'waiting_usage') return { ok: false, why: 'it already ran — the draft waits in Outbox / Needs-you' };
      const c = await ownerCall(env, 'POST', `/agents/jobs/${job.id}/cancel`, {});
      return c.ok ? { ok: true, refs: { jobId: job.id }, message: 'Cancelled before it ran' } : { ok: false, why: c.error.message };
    }
    case 'money':
    case 'legal':
    case 'offer_decision':
    case 'close_or_decline': {
      const item = refs.needsYouId ? ctx.repos.getNeedsYouItem(ctx.db, refs.needsYouId) : undefined;
      if (!item || (item.status !== 'open' && item.status !== 'snoozed')) return { ok: false, why: 'the Needs-you card was already answered' };
      ctx.repos.transitionNeedsYou(ctx.db, item.id, { to: 'superseded', actor: env.actor.userId, note: 'undo of your AI input', now: ctx.now() });
      return { ok: true, refs: { needsYouId: item.id }, message: 'Needs-you card withdrawn' };
    }
    case 'record_correspondence': {
      if (!refs.correspondenceId) return { ok: false, why: 'the record was not found' };
      const ids = [refs.eventId, refs.extraEventId].filter((x): x is string => Boolean(x));
      const w = withdrawRecord(ctx, claimId, refs.correspondenceId, ids, env.actor, `${COPY.undoEventNote(when)}${reason ? ` — ${reason.slice(0, 200)}` : ''}`);
      return { ok: true, refs: { correctingEventId: w.correctingEventIds[0] ?? null }, message: 'Record withdrawn (the document stays on file)' };
    }
    case 'status_change': {
      if (!refs.previous) return { ok: false, why: 'the previous status is not known' };
      const c = await ownerCall(env, 'POST', `/claims/${claimId}/status`, { status: refs.previous, reason: `Undo of your update of ${when}` });
      return c.ok ? { ok: true, refs: {}, message: `Status back to ${refs.previous}` } : { ok: false, why: c.error.message };
    }
    case 'file_evidence':
      return { ok: false, why: COPY.evidenceWriteOnce };
    default:
      return { ok: false, why: 'this line cannot be undone here' };
  }
}
