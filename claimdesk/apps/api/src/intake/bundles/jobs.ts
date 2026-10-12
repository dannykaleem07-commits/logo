// owned by intake-server
/**
 * The work of the bundle job types (docs/SMART-INTAKE.md §6.1, §6.2, §7.1); the handlers in agent/handlers/intake.ts
 * call these.
 *
 *   intake.bundle_reconcile  cpu  {bundleId, revision}     stale revision → done; recompute; follow-ups (§6.1)
 *   intake.bundle_reason     ai   {bundleId, fileset}      the AI reads the main group together; checked by code
 *   intake.bundle_register   io   {bundleId, revision}     automatic registration as agent:intake (setting on only)
 */
import type { IntakeBundleReasoning } from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import type { JobOutcome, JobRecord } from '../../agent/contracts.js';
import { authFailedWait, londonDay } from '../../agent/core.js';
import { runAgent } from '../../agent/runAgent.js';
import { HttpError } from '../../errors.js';
import { BUNDLE_AGENT, CLOSED_STATUSES, touchBundle } from './hooks.js';
import { bundleReasoningInput, INTAKE_BUNDLE_SPEC, validateReasoning } from './reason.js';
import { afterReconcile, computeBundle, openCard, raiseBundleCard, recomputeBundle } from './recompute.js';
import { registerBundle } from './register.js';

export async function reconcileJob(ctx: AppContext, payload: { bundleId: string; revision: number }): Promise<JobOutcome> {
  const b = ctx.repos.getIntakeBundle(ctx.db, payload.bundleId);
  if (!b) return { kind: 'fail', reason: `intake bundle ${payload.bundleId} not found` };
  if (payload.revision < b.revision) return { kind: 'done', result: { stale: true, revision: payload.revision, current: b.revision } };
  if (CLOSED_STATUSES.has(b.status) || b.status === 'registering') return { kind: 'done', result: { skipped: b.status } };
  const state = recomputeBundle(ctx, b.id);
  const follow = afterReconcile(ctx, state);
  return { kind: 'done', result: { revision: b.revision, status: ctx.repos.requireIntakeBundle(ctx.db, b.id).status, groups: state.computed.groups.map((g) => g.key), conflicts: state.computed.conflicts.filter((c) => c.status === 'open').length, ...follow } };
}

export async function reasonJob(ctx: AppContext, job: JobRecord, payload: { bundleId: string; fileset: string; owner?: boolean }): Promise<JobOutcome> {
  const b = ctx.repos.getIntakeBundle(ctx.db, payload.bundleId);
  if (!b) return { kind: 'fail', reason: `intake bundle ${payload.bundleId} not found` };
  if (CLOSED_STATUSES.has(b.status)) return { kind: 'done', result: { skipped: b.status } };
  const state = computeBundle(ctx, b.id);
  if (state.computed.fileset !== payload.fileset && !payload.owner) return { kind: 'done', result: { stale: true } };
  if (!state.main.length) {
    ctx.repos.updateIntakeBundle(ctx.db, b.id, { reasoningStatus: 'skipped' }, ctx.now());
    return { kind: 'done', result: { skipped: 'no files in the case' } };
  }
  const live = [...state.fcs.values()].filter((fc) => !state.computed.files[fc.file.id]?.excluded);
  const input = bundleReasoningInput({
    bundle: b,
    files: live.map((fc) => ({ fc, groupKey: state.computed.files[fc.file.id]?.groupKey ?? 'unsure' })),
    groups: state.computed.groups.map((g) => ({ key: g.key, label: g.label, reasons: g.reasons.map((r) => r.text), fileIds: g.fileIds })),
    draft: state.computed.draft.fields.map((f) => ({ key: f.key, value: f.value, status: f.status })),
    conflicts: state.computed.conflicts.filter((c) => c.status === 'open').map((c) => ({ key: c.key, options: c.options.map((o) => o.display) })),
    today: londonDay(ctx.now()),
  });
  const r = await runAgent(ctx, INTAKE_BUNDLE_SPEC, job, input);
  const o = r.outcome;
  const now = ctx.now();
  if (o.kind === 'ok' && r.result) {
    const result = r.result as IntakeBundleReasoning;
    const contribution = validateReasoning(result, live.filter((fc) => state.main.some((m) => m.file.id === fc.file.id)), now);
    const checks = { ...contribution.checks, candidates: contribution.candidates.length, timeline: contribution.timeline.length, liabilityStatements: contribution.liability.length, injectionSuspected: contribution.injection };
    const stored = ctx.repos.appendBundleReasoning(ctx.db, { bundleId: b.id, fileset: payload.fileset, runId: r.runId, result, checks, now });
    ctx.repos.updateIntakeBundle(ctx.db, b.id, { reasoningStatus: 'done', reasoningFileset: state.computed.fileset }, now);
    ctx.repos.appendAudit(ctx.db, { actor: { userId: BUNDLE_AGENT, runId: r.runId }, action: 'intake.bundle.reason', entity: 'intake_bundles', entityId: b.id, after: { reasoningId: stored.id, files: state.main.length, checks, owner: Boolean(payload.owner) }, at: now });
    touchBundle(ctx, ctx.repos.requireIntakeBundle(ctx.db, b.id), { delaySeconds: 0 });
    return { kind: 'done', result: { reasoningId: stored.id, runId: r.runId, checks } };
  }
  if (o.kind === 'usage_limited') {
    ctx.repos.updateIntakeBundle(ctx.db, b.id, { reasoningStatus: 'waiting_ai' }, now);
    return { kind: 'wait_usage', until: o.resetsAt ?? new Date(Date.parse(now) + 15 * 60_000).toISOString() };
  }
  if (o.kind === 'auth_failed') {
    ctx.repos.updateIntakeBundle(ctx.db, b.id, { reasoningStatus: 'waiting_ai' }, now);
    return authFailedWait(ctx, o.message);
  }
  if (o.kind === 'error' && o.code === 'AI_OFF') {
    // the AI is switched off: the deterministic draft stands; the next reconcile queues the reading again
    ctx.repos.updateIntakeBundle(ctx.db, b.id, { reasoningStatus: 'waiting_ai', reasoningFileset: null }, now);
    return { kind: 'done', result: { waiting: 'AI is switched off' } };
  }
  const message = o.kind === 'error' ? o.message : o.kind === 'invalid_output' ? `invalid result: ${o.errors.join('; ')}` : o.kind === 'refused' ? `refused: ${o.explanation ?? o.category ?? ''}` : o.kind;
  const retryable = (o.kind === 'error' && o.retryable) || o.kind === 'timeout' || o.kind === 'invalid_output';
  if (retryable && job.attempts < job.maxAttempts) return { kind: 'retry', afterMs: 60_000, reason: message };
  // the owner sees plain words; the technical reason stays on the failed job (Agents > Jobs, Needs-you "Problem")
  const why = o.kind === 'refused' ? 'the AI declined to read these documents' : o.kind === 'timeout' ? 'it took too long' : o.kind === 'invalid_output' ? 'its answer could not be used' : 'something went wrong';
  ctx.repos.updateIntakeBundle(ctx.db, b.id, { reasoningStatus: 'failed', error: `The AI check of these documents did not finish (${why}). The draft from the documents’ text still stands — use “Think again” to try once more.` }, now);
  return { kind: 'fail', reason: message };
}

export async function autoRegisterJob(ctx: AppContext, job: JobRecord, payload: { bundleId: string; revision: number }): Promise<JobOutcome> {
  const b = ctx.repos.getIntakeBundle(ctx.db, payload.bundleId);
  if (!b) return { kind: 'fail', reason: `intake bundle ${payload.bundleId} not found` };
  if (payload.revision < b.revision) return { kind: 'done', result: { stale: true } };
  if (CLOSED_STATUSES.has(b.status)) return { kind: 'done', result: { skipped: b.status } };
  // a catch-up bundle belongs to an existing claim: never registered (docs/CLAIM-AI-INPUT.md §8.2, defence in depth)
  if (b.mode === 'catch_up') return { kind: 'done', result: { skipped: 'catch-up bundle' } };
  if (!ctx.repos.getAgentSettings(ctx.db).intake.bundles.autoRegister) return { kind: 'done', result: { skipped: 'automatic registration is off' } };
  const actor: Actor = { userId: BUNDLE_AGENT, runId: `intake-register-${job.id}` };
  try {
    const r = await registerBundle(ctx, b.id, actor, { mode: 'auto' });
    return { kind: 'done', result: { claimId: r.claim.id, reference: r.claim.reference, error: r.error } };
  } catch (err) {
    if (err instanceof HttpError && (err.statusCode === 409 || err.statusCode === 400)) {
      // not registered: the owner decides (the card says why)
      const fresh = ctx.repos.requireIntakeBundle(ctx.db, b.id);
      if (!CLOSED_STATUSES.has(fresh.status) && !openCard(ctx, fresh)) {
        const state = recomputeBundle(ctx, b.id);
        const card = raiseBundleCard(ctx, state);
        ctx.repos.updateIntakeBundle(ctx.db, b.id, { needsYouId: card.id, status: 'needs_you' }, ctx.now());
      }
      return { kind: 'done', result: { registered: false, code: err.code, reason: err.message.slice(0, 500), details: err.details ?? null } };
    }
    throw err;
  }
}
