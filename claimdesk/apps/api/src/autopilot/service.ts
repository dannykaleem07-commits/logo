// owned by ap-autopilot
/**
 * Owner-facing Autopilot services (docs/SUPREME-AUTOPILOT.md §A.8, §I.1): the plan view, per-claim pause / resume and
 * per-step overrides (run now, skip, always ask, auto, mark done, snooze). Every change is audited and logged in the
 * append-only autopilot_log.
 */
import { STEP_CATALOGUE, STEP_FLOORS, isAutopilotStepId, type AutopilotLogEntry, type AutopilotOverride, type AutopilotPlan, type AutopilotStepId, type ClaimAutopilotRecord } from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { evaluate } from './facts.js';
import { claimAutopilotFor } from './install.js';
import { nudgeAutopilot } from './nudge.js';
import { evaluateAndStore } from './runner.js';

export const STEP_OVERRIDE_ACTIONS = ['run', 'skip', 'ask', 'auto', 'done', 'snooze', 'clear'] as const;
export type StepOverrideAction = (typeof STEP_OVERRIDE_ACTIONS)[number];

export interface AutopilotView {
  claimId: string;
  record: Omit<ClaimAutopilotRecord, 'plan'>;
  plan: AutopilotPlan;
  catalogue: Array<{ id: string; title: string; track: string; stage: string; performer: string; floor: string; defaultMode: string }>;
  log: AutopilotLogEntry[];
  stopped: string | null;
}

/** The claim's plan (evaluated now; nothing is acted on), its record, the catalogue and the latest log rows. */
export function autopilotView(ctx: AppContext, claimId: string, opts: { store?: boolean } = {}): AutopilotView {
  if (!ctx.repos.getClaim(ctx.db, claimId)) throw notFound('claim', claimId);
  const { plan, facts } = opts.store ? evaluateAndStore(ctx, claimId) : evaluate(ctx, claimId);
  const rec = claimAutopilotFor(ctx, claimId);
  const { plan: _p, ...record } = rec;
  const settings = ctx.repos.getAgentSettings(ctx.db);
  const stopped = !facts.settings.enabled ? 'The Autopilot is switched off in Settings > Autopilot.' : !settings.agents.enabled || settings.ai.driver === 'off' ? 'Agents are switched off in Settings > AI: the plan is shown but nothing is done.' : settings.autonomy.killSwitch ? 'The kill switch is on.' : null;
  return {
    claimId,
    record,
    plan,
    catalogue: STEP_CATALOGUE.map((s) => ({ id: s.id, title: s.title, track: s.track, stage: s.stage, performer: s.performer, floor: s.floor, defaultMode: s.defaultMode })),
    log: ctx.repos.listAutopilotLog(ctx.db, { claimId, order: 'desc', limit: 200 }),
    stopped,
  };
}

function audit(ctx: AppContext, actor: Actor, action: string, claimId: string, after: unknown, before?: unknown): void {
  ctx.repos.appendAudit(ctx.db, { actor, action, entity: 'claim_autopilot', entityId: claimId, ...(before !== undefined ? { before } : {}), after, at: ctx.now() });
}

export function pauseAutopilot(ctx: AppContext, actor: Actor, claimId: string, reason: string): ClaimAutopilotRecord {
  const before = claimAutopilotFor(ctx, claimId);
  const rec = ctx.repos.setClaimAutopilotMode(ctx.db, claimId, 'paused', { userId: actor.userId, reason }, ctx.now());
  audit(ctx, actor, 'autopilot.pause', claimId, { mode: 'paused', reason }, { mode: before.mode });
  ctx.repos.appendAutopilotLog(ctx.db, { claimId, stepId: '*', fromStatus: undefined, toStatus: 'paused', action: 'pause', actor: actor.userId, note: reason, at: ctx.now() });
  return rec;
}

export function resumeAutopilot(ctx: AppContext, actor: Actor, claimId: string, reason?: string): ClaimAutopilotRecord {
  const before = claimAutopilotFor(ctx, claimId);
  const rec = ctx.repos.setClaimAutopilotMode(ctx.db, claimId, 'on', { userId: actor.userId }, ctx.now());
  audit(ctx, actor, 'autopilot.resume', claimId, { mode: 'on', reason: reason ?? null }, { mode: before.mode });
  ctx.repos.appendAutopilotLog(ctx.db, { claimId, stepId: '*', toStatus: 'due', action: 'resume', actor: actor.userId, ...(reason ? { note: reason } : {}), at: ctx.now() });
  nudgeAutopilot(ctx, claimId, 'resumed', { createdBy: actor.userId });
  return rec;
}

/** Tomorrow 09:00 London-ish (snooze default): 24 hours from now. */
const tomorrow = (now: string): string => new Date(Date.parse(now) + 24 * 3_600_000).toISOString();

/** Apply a per-step action from the Autopilot tab or a Needs-you card (§A.8). */
export function applyStepAction(ctx: AppContext, actor: Actor, claimId: string, stepId: string, action: StepOverrideAction, opts: { reason?: string | null; until?: string | null } = {}): { record: ClaimAutopilotRecord; queuedTick: boolean } {
  if (!isAutopilotStepId(stepId)) throw badRequest(`Unknown autopilot step ${stepId}`);
  if (!ctx.repos.getClaim(ctx.db, claimId)) throw notFound('claim', claimId);
  claimAutopilotFor(ctx, claimId);
  const now = ctx.now();
  const reason = opts.reason?.trim() ?? '';
  let record: ClaimAutopilotRecord;
  let queuedTick = false;
  if (action === 'run') {
    record = claimAutopilotFor(ctx, claimId);
    queuedTick = Boolean(nudgeAutopilot(ctx, claimId, `run now: ${stepId}`, { createdBy: actor.userId, forceStepId: stepId }));
  } else if (action === 'clear') {
    record = ctx.repos.setStepOverride(ctx.db, claimId, stepId, null, now);
  } else {
    if ((action === 'skip' || action === 'done') && reason.length < 3) throw badRequest(`Say why you ${action === 'skip' ? 'skip' : 'mark done'} this step`);
    if (action === 'snooze' && opts.until && !Number.isFinite(Date.parse(opts.until))) throw badRequest('The snooze date is not valid');
    const override: AutopilotOverride = {
      action,
      reason: reason || (action === 'ask' ? 'Always ask me on this claim' : action === 'auto' ? `Automatic (never below the floor: ${STEP_FLOORS[stepId as AutopilotStepId]})` : 'Snoozed'),
      by: actor.userId,
      at: now,
      ...(action === 'snooze' ? { until: opts.until ? new Date(Date.parse(opts.until)).toISOString() : tomorrow(now) } : {}),
    };
    record = ctx.repos.setStepOverride(ctx.db, claimId, stepId, override, now);
    queuedTick = Boolean(nudgeAutopilot(ctx, claimId, `step ${action}: ${stepId}`, { createdBy: actor.userId }));
  }
  audit(ctx, actor, 'autopilot.step_override', claimId, { stepId, action, reason: reason || null, until: opts.until ?? null });
  ctx.repos.appendAutopilotLog(ctx.db, { claimId, stepId, toStatus: action === 'done' ? 'done' : action === 'skip' ? 'skipped' : action === 'snooze' ? 'waiting' : 'due', action: `override:${action}`, actor: actor.userId, ...(reason ? { note: reason } : {}), at: now });
  return { record, queuedTick };
}
