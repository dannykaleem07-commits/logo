// owned by runtime
/**
 * The supervisor (docs/SUPREME-DESIGN.md §C.6): an in-process 60-second interval (not a job), started by the jobs
 * module's onReady when JOBS_ENABLED=true — never in tests, which call `tick(now)` directly. Each tick, in order:
 *
 *   1. expired leases back to the queue (dead ones raise Needs-you failure); snoozed Needs-you items whose time came
 *   2. due schedules → jobs (London time, §C.2 keys)
 *   3. lift usage pauses whose time has passed (+ waiting_usage jobs back to queued)
 *   4. usage gates for the AI lane (budgets.ts, §A.5) — a rejected window pauses until resetsAt + 2 min
 *   5. kill switch, per-agent and per-claim pauses
 *   6. deadline guard: a clock due within 24 h while AI is paused (or the claim's last review failed) → the standard
 *      letter drafted without AI (system job) + Needs-you `ai_paused`
 *   7. fill the lanes up to their concurrency
 *   8. heartbeat for GET /agents/status
 */
import type { ClockKind, ISODateTime, Lane } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { enqueueJob, londonDay, londonDayStart } from './core.js';
import { aiGate, ALL_PRIORITIES, NO_PRIORITY, type AiGate, type LaneLimits } from './budgets.js';
import { effectiveAgentSettings, openGates, raiseJobFailure, type LaneGates, type AnyJobHandler } from './queue.js';
import { runDueSchedules, seedSchedules, type MaterialisedRun } from './scheduler.js';
import { startWorker, workerOwnerId, type RunningJob, type Worker } from './worker.js';
import { allJobHandlers, registryProblems } from './handlers/index.js';
import type { JobRecord } from './contracts.js';

export const SUPERVISOR_TICK_MS = 60_000;
export const DEADLINE_GUARD_HORIZON_MS = 24 * 3_600_000;

/**
 * Standard letters the deadline guard may draft without AI (all on the default auto-send list; never an always-ask
 * template). Other clock kinds raise the Needs-you item without a draft.
 */
export const DEADLINE_FALLBACK_TEMPLATES: Partial<Record<ClockKind, string>> = {
  gta_4_1_ncaf_1wd: 'letter.ncaf',
  gta_4_2_handling_ref_5wd: 'letter.handling_ref_request',
  gta_4_10_authorisation_check_3wd: 'letter.delay_notice_gta_4_10',
  cctv_preservation: 'letter.cctv_preservation',
  chaser_day_7: 'letter.chaser_7',
  chaser_day_14: 'letter.chaser_14',
  chaser_day_21: 'letter.chaser_21',
};

export interface Heartbeat {
  at: ISODateTime;
  gates: LaneGates;
  ai: AiGate & { enabled: boolean; driver: string };
  limits: LaneLimits;
  running: RunningJob[];
  started: number;
  schedules: MaterialisedRun[];
  deadlineGuard: Array<{ claimId: string; clockKind: string; jobId: string }>;
  requeued: number;
  dead: number;
  registryProblems: string[];
}

export interface SupervisorOptions {
  worker?: Worker;
  handlers?: readonly AnyJobHandler[];
  /** Production: start the 60 s interval and the worker's poll. Tests leave it off and call tick(). */
  timers?: boolean;
  tickMs?: number;
}

export interface Supervisor {
  readonly worker: Worker;
  tick(now?: ISODateTime): Promise<Heartbeat>;
  /** The gates as of now (also used by the worker's own poll between ticks). */
  gates(now?: ISODateTime): LaneGates;
  heartbeat(): Heartbeat | undefined;
  start(): void;
  stop(): Promise<void>;
}

export function computeGates(ctx: AppContext, now: ISODateTime): { gates: LaneGates; ai: Heartbeat['ai'] } {
  const settings = effectiveAgentSettings(ctx);
  const usage = ctx.repos.getAiUsageState(ctx.db);
  const today = londonDay(now);
  const nextDayStart = londonDayStart(new Date(Date.parse(londonDayStart(now)) + 36 * 3_600_000).toISOString());
  const g = aiGate({ usage, settings, now, today, nextDayStart });
  const enabled = settings.agents.enabled && settings.ai.driver !== 'off';
  const killSwitch = settings.autonomy.killSwitch;
  const gates = openGates();
  gates.killSwitch = killSwitch;
  gates.pausedAgents = [...settings.agents.paused];
  gates.pausedClaims = ctx.repos.listPausedClaims(ctx.db);
  const aiLane = gates.lanes.ai;
  if (killSwitch) Object.assign(aiLane, { open: false, maxPriority: NO_PRIORITY, reason: 'kill_switch' });
  else if (!enabled) Object.assign(aiLane, { open: false, maxPriority: NO_PRIORITY, reason: 'agents_off' });
  else Object.assign(aiLane, { open: g.maxPriority >= 0, maxPriority: g.maxPriority, reason: g.reason });
  for (const lane of ['io', 'cpu'] as Lane[]) gates.lanes[lane] = { open: true, maxPriority: ALL_PRIORITIES };
  return { gates, ai: { ...g, enabled, driver: settings.driverChoice } };
}

/** Did the claim's most recent case review fail (dead/failed job or a non-ok run)? */
function lastReviewFailed(ctx: AppContext, claimId: string): boolean {
  const job = ctx.repos.listAgentJobs(ctx.db, { claimId, type: 'case.review', status: ['succeeded', 'failed', 'dead'], limit: 1 })[0];
  if (job && (job.status === 'failed' || job.status === 'dead')) return true;
  const state = ctx.repos.getClaimAgentState(ctx.db, claimId);
  if (state.lastReviewRunId) {
    const run = ctx.repos.getAgentRun(ctx.db, state.lastReviewRunId);
    if (run?.outcome && run.outcome !== 'ok') return true;
  }
  return false;
}

/** §C.6 deadline guard: enqueue the deterministic fallback for clocks due within 24 h when AI cannot act. */
export function deadlineGuard(ctx: AppContext, now: ISODateTime, ai: Heartbeat['ai'], killSwitch: boolean): Array<{ claimId: string; clockKind: string; jobId: string }> {
  if (!ai.enabled) return [];
  const usage = ctx.repos.getAiUsageState(ctx.db);
  const aiPaused = killSwitch || ai.maxPriority < 0;
  const t = Date.parse(now);
  // Clock instants carry offsets, so filter on parsed instants (not on the stored strings).
  const due = (ctx.handle.sqlite.prepare(`SELECT claim_id, kind, label, due_at FROM clocks WHERE status = 'running'`).all() as Array<{ claim_id: string; kind: ClockKind; label: string; due_at: string }>).filter((c) => {
    const d = Date.parse(c.due_at);
    return Number.isFinite(d) && d >= t && d - t <= DEADLINE_GUARD_HORIZON_MS;
  });
  const out: Array<{ claimId: string; clockKind: string; jobId: string }> = [];
  const failedCache = new Map<string, boolean>();
  for (const c of due) {
    let reason: 'ai_paused' | 'review_failed' | undefined;
    if (aiPaused) reason = 'ai_paused';
    else {
      if (!failedCache.has(c.claim_id)) failedCache.set(c.claim_id, lastReviewFailed(ctx, c.claim_id));
      if (failedCache.get(c.claim_id)) reason = 'review_failed';
    }
    if (!reason) continue;
    const dueIso = new Date(Date.parse(c.due_at)).toISOString();
    const job = enqueueJob(ctx, {
      type: 'clocks.refresh',
      payload: {
        fallback: {
          claimId: c.claim_id,
          clockKind: c.kind,
          label: c.label,
          dueAt: dueIso,
          templateId: DEADLINE_FALLBACK_TEMPLATES[c.kind] ?? null,
          reason,
          pausedUntil: reason === 'ai_paused' ? (usage.pausedUntil ?? null) : null,
        },
      },
      claimId: c.claim_id,
      priority: 1,
      idempotencyKey: `clocks.refresh:fallback:${c.claim_id}:${c.kind}:${londonDay(dueIso)}`,
      createdBy: 'agent:supervisor',
    });
    out.push({ claimId: c.claim_id, clockKind: c.kind, jobId: job.id });
  }
  return out;
}

export function createSupervisor(ctx: AppContext, opts: SupervisorOptions = {}): Supervisor {
  const handlers = opts.handlers ?? allJobHandlers();
  let last: Heartbeat | undefined;
  let timer: NodeJS.Timeout | undefined;
  let ticking: Promise<Heartbeat> | undefined;
  const gatesNow = (now: ISODateTime = ctx.now()): LaneGates => computeGates(ctx, now).gates;
  const worker =
    opts.worker ??
    startWorker(ctx, { owner: workerOwnerId(), handlers, autoFill: Boolean(opts.timers), gates: () => gatesNow() });

  const problems = registryProblems();
  if (problems.length) ctx.logger.error('agent registry problems', { problems });
  seedSchedules(ctx);

  const tickOnce = async (now: ISODateTime): Promise<Heartbeat> => {
    // 1. expired leases; snoozes that ended
    const expired = ctx.repos.requeueExpiredAgentJobs(ctx.db, now) as JobRecord[];
    const dead = expired.filter((j) => j.status === 'dead');
    for (const j of dead) raiseJobFailure(ctx, j, j.error ?? 'lease expired after the last attempt');
    try {
      ctx.repos.wakeSnoozedNeedsYou(ctx.db, now);
    } catch (err) {
      ctx.logger.warn('waking snoozed Needs-you items failed', { error: String(err) });
    }
    // 2. schedules
    const schedules = runDueSchedules(ctx, now, { hasHandler: (t) => handlers.some((h) => h.type === t) });
    // 3. lift usage pauses whose time has passed
    const usage = ctx.repos.getAiUsageState(ctx.db);
    if (usage.pausedUntil && usage.pausedUntil <= now) {
      ctx.repos.unpauseAi(ctx.db, now);
      ctx.repos.appendAudit(ctx.db, { actor: { userId: 'agent:supervisor' }, action: 'ai.resume', entity: 'ai_usage_state', entityId: 'default', before: { pausedUntil: usage.pausedUntil, pauseReason: usage.pauseReason ?? null }, at: now });
    }
    ctx.repos.releaseWaitingUsageJobs(ctx.db, now);
    // 4–5. usage gates, kill switch, pauses
    let { gates, ai } = computeGates(ctx, now);
    if (ai.pauseUntil) {
      const cur = ctx.repos.getAiUsageState(ctx.db);
      if (!cur.pausedUntil || cur.pausedUntil < ai.pauseUntil) {
        ctx.repos.pauseAi(ctx.db, { until: ai.pauseUntil, reason: ai.pauseReason ?? 'usage_limited', now });
        ctx.repos.appendAudit(ctx.db, { actor: { userId: 'agent:supervisor' }, action: 'ai.pause', entity: 'ai_usage_state', entityId: 'default', after: { until: ai.pauseUntil, reason: ai.pauseReason ?? 'usage_limited' }, at: now });
        ({ gates, ai } = computeGates(ctx, now));
      }
    }
    // 6. deadline guard
    let guarded: Heartbeat['deadlineGuard'] = [];
    try {
      guarded = deadlineGuard(ctx, now, ai, gates.killSwitch);
    } catch (err) {
      ctx.logger.error('deadline guard failed', { error: String(err) });
    }
    // 7. fill lanes
    const started = worker.fill(now, gates);
    // 8. heartbeat
    last = { at: now, gates, ai, limits: worker.limits(), running: worker.running(), started: started.length, schedules, deadlineGuard: guarded, requeued: expired.length - dead.length, dead: dead.length, registryProblems: problems };
    return last;
  };

  const supervisor: Supervisor = {
    worker,
    async tick(now = ctx.now()) {
      // Never overlap two ticks (a slow tick in production).
      if (ticking) await ticking.catch(() => undefined);
      ticking = tickOnce(now);
      try {
        return await ticking;
      } finally {
        ticking = undefined;
      }
    },
    gates: gatesNow,
    heartbeat: () => last,
    start() {
      if (timer) return;
      // Crash recovery on boot: expired leases go back before the first fill.
      supervisor.tick().catch((err) => ctx.logger.error('supervisor tick failed', { error: String(err) }));
      timer = setInterval(() => {
        supervisor.tick().catch((err) => ctx.logger.error('supervisor tick failed', { error: String(err) }));
      }, opts.tickMs ?? SUPERVISOR_TICK_MS);
      timer.unref?.();
      worker.start();
      ctx.logger.info('agent supervisor started', { tickMs: opts.tickMs ?? SUPERVISOR_TICK_MS, owner: worker.owner });
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await worker.stop();
    },
  };
  ctx.services.supervisor = supervisor;
  return supervisor;
}

/** The running supervisor registered on the context (undefined when jobs are off). */
export function getSupervisor(ctx: AppContext): Supervisor | undefined {
  const s = ctx.services.supervisor as Supervisor | undefined;
  return s && typeof s.tick === 'function' ? s : undefined;
}
