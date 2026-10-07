// owned by runtime
/**
 * The job worker (docs/SUPREME-DESIGN.md §C.3): fills the `ai` / `io` / `cpu` lanes up to their concurrency, runs each
 * leased job's handler with an AbortSignal (timeoutMs), maps the JobOutcome onto the queue and appends one
 * `agent_job_attempts` row per attempt.
 *
 *   done       → succeeded; follow-ups enqueued with the parent's correlation id and depth + 1 (loop guard in enqueueJob)
 *   retry      → back to queued after exponential backoff with jitter; attempts used up → dead + Needs-you failure
 *   wait_usage → waiting_usage until `until` (+2 min), no attempt consumed; the AI lane is paused until then
 *   wait_user  → waiting_user; the Needs-you resolver re-queues it (needs_you.resumes_job_id)
 *   fail       → failed, or dead + Needs-you failure when deadLetter
 *
 * Tests drive it with `fill(now)` / `tick(now)` / `idle()` — no timers. In production `start()` adds a light poll so a
 * newly queued job does not wait for the supervisor's 60-second tick.
 */
import { randomUUID } from 'node:crypto';
import type { ISODateTime, JobType, Lane } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { JobOutcome, JobRecord } from './contracts.js';
import { retryDelayMs, USAGE_RESUME_MARGIN_MS, type LaneLimits } from './budgets.js';
import {
  agentsAtCap,
  currentLaneLimits,
  enqueueFollowUps,
  LANE_ORDER,
  leaseMsForLane,
  leaseNext,
  openGates,
  raiseJobFailure,
  raiseMissingHandler,
  type AnyJobHandler,
  type LaneGates,
} from './queue.js';

export interface RunningJob {
  jobId: string;
  type: JobType;
  agent: string;
  lane: Lane;
  claimId?: string;
  attempt: number;
  startedAt: ISODateTime;
}

export interface JobSettled {
  jobId: string;
  type: JobType;
  outcome: JobOutcome['kind'] | 'timeout' | 'error' | 'invalid_payload' | 'no_handler' | 'deferred';
  status: JobRecord['status'];
  error?: string;
}

export interface WorkerOptions {
  /** Lease owner id (e.g. `worker:<pid>`). */
  owner: string;
  /** Registered handlers (or a lookup). */
  handlers: readonly AnyJobHandler[];
  /** Jitter source (tests pass a fixed one). */
  random?: () => number;
  /** Production only: re-fill lanes when a job finishes and every `pollMs`. Tests leave it off. */
  autoFill?: boolean;
  pollMs?: number;
  /** Current gates for auto-fill (the supervisor's last computation). */
  gates?: () => LaneGates;
}

export interface Worker {
  readonly owner: string;
  /** Lease and start jobs up to each lane's limit; returns the jobs started. Does not wait for them. */
  fill(now: ISODateTime, gates?: LaneGates): JobRecord[];
  /** fill(now) and wait for the jobs it started (tests). */
  tick(now: ISODateTime, gates?: LaneGates): Promise<JobSettled[]>;
  /** Wait until nothing is running. */
  idle(): Promise<void>;
  running(): RunningJob[];
  limits(): LaneLimits;
  /** Results of every job settled so far (bounded, newest last). */
  settled(): JobSettled[];
  start(): void;
  /** Stop leasing; wait up to `graceMs` (default 5 s) for running jobs. */
  stop(graceMs?: number): Promise<void>;
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${Math.round(ms / 1000)} s`);
    this.name = 'TimeoutError';
  }
}

const addMs = (iso: ISODateTime, ms: number): ISODateTime => new Date(Date.parse(iso) + ms).toISOString();

export function startWorker(ctx: AppContext, opts: WorkerOptions): Worker {
  const handlers = [...opts.handlers];
  const byType = new Map<string, AnyJobHandler>(handlers.map((h) => [h.type, h]));
  const random = opts.random ?? Math.random;
  const running = new Map<string, { info: RunningJob; promise: Promise<JobSettled> }>();
  const history: JobSettled[] = [];
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const leaseMs: Record<Lane, number> = { ai: leaseMsForLane(handlers, 'ai'), io: leaseMsForLane(handlers, 'io'), cpu: leaseMsForLane(handlers, 'cpu') };

  const runId = (jobId: string, since: ISODateTime): string | undefined => {
    try {
      return ctx.repos.listAgentRuns(ctx.db, { jobId, since, limit: 1 })[0]?.id;
    } catch {
      return undefined;
    }
  };

  const attemptRow = (job: JobRecord, startedAt: ISODateTime, outcome: string, error?: string): void => {
    try {
      ctx.repos.appendAgentJobAttempt(ctx.db, { jobId: job.id, attempt: job.attempts, startedAt, finishedAt: ctx.now(), outcome, error: error?.slice(0, 2000), runId: runId(job.id, startedAt) });
    } catch (err) {
      ctx.logger.warn('agent job attempt not recorded', { jobId: job.id, error: String(err) });
    }
  };

  /** Retry with backoff or dead-letter when the attempts are used up. */
  const retryOrDead = (job: JobRecord, reason: string, afterMs: number): JobRecord => {
    const now = ctx.now();
    const delay = retryDelayMs(job.attempts, afterMs, random);
    const next = ctx.repos.retryAgentJobAt(ctx.db, job.id, { runAfter: addMs(now, delay), error: reason, now }) as JobRecord;
    if (next.status === 'dead') raiseJobFailure(ctx, next, reason);
    return next;
  };

  const apply = (job: JobRecord, outcome: JobOutcome, startedAt: ISODateTime): JobSettled => {
    const now = ctx.now();
    switch (outcome.kind) {
      case 'done': {
        const done = ctx.db.transaction(() => {
          const j = ctx.repos.markAgentJobSucceeded(ctx.db, job.id, { result: outcome.result ?? null, now }) as JobRecord;
          enqueueFollowUps(ctx, job, outcome.followUps);
          return j;
        });
        attemptRow(job, startedAt, 'succeeded');
        return { jobId: job.id, type: job.type, outcome: 'done', status: done.status };
      }
      case 'retry': {
        attemptRow(job, startedAt, 'retry', outcome.reason);
        const next = retryOrDead(job, outcome.reason, outcome.afterMs);
        return { jobId: job.id, type: job.type, outcome: 'retry', status: next.status, error: outcome.reason };
      }
      case 'wait_usage': {
        attemptRow(job, startedAt, 'wait_usage');
        const until = addMs(outcome.until, USAGE_RESUME_MARGIN_MS);
        const next = ctx.repos.waitAgentJobUsage(ctx.db, job.id, { until, reason: 'usage window closed', now }) as JobRecord;
        // The window is closed for every AI job, not just this one (§A.5).
        if (job.lane === 'ai') {
          const usage = ctx.repos.getAiUsageState(ctx.db);
          if (!usage.pausedUntil || usage.pausedUntil < until) {
            ctx.repos.pauseAi(ctx.db, { until, reason: 'usage_limited', now });
            ctx.repos.appendAudit(ctx.db, { actor: { userId: 'agent:supervisor' }, action: 'ai.pause', entity: 'ai_usage_state', entityId: 'default', after: { until, reason: 'usage_limited', jobId: job.id }, at: now });
          }
        }
        return { jobId: job.id, type: job.type, outcome: 'wait_usage', status: next.status };
      }
      case 'wait_user': {
        attemptRow(job, startedAt, 'wait_user');
        const next = ctx.repos.waitAgentJobUser(ctx.db, job.id, { needsYouId: outcome.needsYouId, now }) as JobRecord;
        return { jobId: job.id, type: job.type, outcome: 'wait_user', status: next.status };
      }
      case 'fail': {
        attemptRow(job, startedAt, outcome.deadLetter ? 'dead' : 'failed', outcome.reason);
        const next = ctx.repos.markAgentJobFailed(ctx.db, job.id, { error: outcome.reason, deadLetter: outcome.deadLetter, now }) as JobRecord;
        if (next.status === 'dead') raiseJobFailure(ctx, next, outcome.reason);
        return { jobId: job.id, type: job.type, outcome: 'fail', status: next.status, error: outcome.reason };
      }
    }
  };

  const execute = async (job: JobRecord, handler: AnyJobHandler, startedAt: ISODateTime): Promise<JobSettled> => {
    const parsed = handler.payload.safeParse(job.payload);
    if (!parsed.success) {
      const reason = `invalid payload for ${job.type}: ${String((parsed.error as { message?: string } | undefined)?.message ?? parsed.error).slice(0, 500)}`;
      attemptRow(job, startedAt, 'dead', reason);
      const dead = ctx.repos.markAgentJobFailed(ctx.db, job.id, { error: reason, deadLetter: true, now: ctx.now() }) as JobRecord;
      raiseJobFailure(ctx, dead, reason);
      return { jobId: job.id, type: job.type, outcome: 'invalid_payload', status: dead.status, error: reason };
    }
    const controller = new AbortController();
    const timeoutMs = handler.timeoutMs > 0 ? handler.timeoutMs : 10 * 60_000;
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const e = new TimeoutError(timeoutMs);
        controller.abort(e);
        reject(e);
      }, timeoutMs);
      timeout.unref?.();
    });
    const log = {
      info: (msg: string, meta?: Record<string, unknown>) => ctx.logger.info(msg, { jobId: job.id, type: job.type, ...meta }),
      warn: (msg: string, meta?: Record<string, unknown>) => ctx.logger.warn(msg, { jobId: job.id, type: job.type, ...meta }),
      error: (msg: string, meta?: Record<string, unknown>) => ctx.logger.error(msg, { jobId: job.id, type: job.type, ...meta }),
    };
    try {
      const outcome = (await Promise.race([handler.run({ ctx, job, payload: parsed.data, signal: controller.signal, log }), timedOut])) as JobOutcome;
      if (!outcome || typeof outcome !== 'object' || !('kind' in outcome)) throw new Error(`handler for ${job.type} returned no outcome`);
      return apply(job, outcome, startedAt);
    } catch (err) {
      const isTimeout = err instanceof TimeoutError;
      const reason = isTimeout ? err.message : err instanceof Error ? err.message : String(err);
      attemptRow(job, startedAt, isTimeout ? 'timeout' : 'error', reason);
      const next = retryOrDead(job, reason, 0);
      ctx.logger.warn('agent job attempt failed', { jobId: job.id, type: job.type, error: reason, status: next.status });
      return { jobId: job.id, type: job.type, outcome: isTimeout ? 'timeout' : 'error', status: next.status, error: reason };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  /** Called right after leasing: guards that need the job's type, then run. */
  const launch = (job: JobRecord, gates: LaneGates, startedAt: ISODateTime): Promise<JobSettled> | JobSettled => {
    const handler = byType.get(job.type);
    if (!handler) {
      const reason = `no handler registered for ${job.type}`;
      attemptRow(job, startedAt, 'dead', reason);
      const dead = ctx.repos.markAgentJobFailed(ctx.db, job.id, { error: reason, deadLetter: true, now: ctx.now() }) as JobRecord;
      raiseMissingHandler(ctx, dead);
      return { jobId: job.id, type: job.type, outcome: 'no_handler', status: dead.status, error: reason };
    }
    // Kill switch: held sends stay held (§C.6) — give the lease back without using the attempt.
    if (gates.killSwitch && job.type === 'outbox.release') {
      const next = ctx.repos.waitAgentJobUsage(ctx.db, job.id, { until: addMs(startedAt, 5 * 60_000), reason: 'kill switch: held', now: startedAt }) as JobRecord;
      return { jobId: job.id, type: job.type, outcome: 'deferred', status: next.status };
    }
    return execute(job, handler, startedAt);
  };

  const record = (s: JobSettled): JobSettled => {
    history.push(s);
    if (history.length > 500) history.splice(0, history.length - 500);
    return s;
  };

  const fill = (now: ISODateTime, gatesIn?: LaneGates): JobRecord[] => {
    if (stopped) return [];
    const gates = gatesIn ?? opts.gates?.() ?? openGates();
    const limits = currentLaneLimits(ctx);
    const started: JobRecord[] = [];
    for (const lane of LANE_ORDER) {
      for (;;) {
        const busy = [...running.values()].filter((r) => r.info.lane === lane);
        if (busy.length >= limits.lanes[lane]) break;
        const perAgent = new Map<string, number>();
        for (const r of busy) perAgent.set(r.info.agent, (perAgent.get(r.info.agent) ?? 0) + 1);
        const excludeAgents = lane === 'ai' ? agentsAtCap(limits.agentCaps, perAgent) : [];
        let job: JobRecord | undefined;
        try {
          job = leaseNext(ctx, { lane, owner: opts.owner, now, gates, leaseMs: leaseMs[lane], excludeAgents });
        } catch (err) {
          ctx.logger.error('agent job lease failed', { lane, error: String(err) });
          break;
        }
        if (!job) break;
        const info: RunningJob = { jobId: job.id, type: job.type, agent: job.agent, lane: job.lane, attempt: job.attempts, startedAt: now, ...(job.claimId ? { claimId: job.claimId } : {}) };
        const leased = job;
        const out = launch(leased, gates, now);
        if (!(out instanceof Promise)) {
          record(out);
          continue;
        }
        const promise = out
          .catch((err): JobSettled => ({ jobId: leased.id, type: leased.type, outcome: 'error', status: 'leased', error: String(err) }))
          .then((s) => {
            running.delete(leased.id);
            record(s);
            if (opts.autoFill && !stopped) setImmediate(() => fill(ctx.now()));
            return s;
          });
        running.set(job.id, { info, promise });
        started.push(job);
      }
    }
    return started;
  };

  const worker: Worker = {
    owner: opts.owner,
    fill,
    async tick(now, gates) {
      const started = fill(now, gates);
      const results = await Promise.all(started.map((j) => running.get(j.id)?.promise).filter((p): p is Promise<JobSettled> => Boolean(p)));
      return results;
    },
    async idle() {
      while (running.size) await Promise.all([...running.values()].map((r) => r.promise));
    },
    running: () => [...running.values()].map((r) => r.info),
    limits: () => currentLaneLimits(ctx),
    settled: () => [...history],
    start() {
      if (timer || !opts.autoFill) return;
      timer = setInterval(() => fill(ctx.now()), opts.pollMs ?? 5_000);
      timer.unref?.();
    },
    async stop(graceMs = 5_000) {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      // Give running jobs a moment; anything still running keeps its lease and is re-queued when the lease expires.
      let t: NodeJS.Timeout | undefined;
      await Promise.race([worker.idle(), new Promise<void>((r) => (t = setTimeout(r, graceMs)))]);
      if (t) clearTimeout(t);
    },
  };
  return worker;
}

/** A lease owner id unique to this process. */
export function workerOwnerId(): string {
  return `worker:${process.pid}:${randomUUID().slice(0, 8)}`;
}
