/**
 * Background jobs (owned by runtime since ClaimDesk Supreme, docs/SUPREME-DESIGN.md §C.2, §C.6).
 *
 * The nightly Companies House watch poll and the hourly clocks refresh now run through the durable agent queue
 * (`watch.poll` / `clocks.refresh`, handlers in agent/handlers/system.ts) on the supervisor's schedules. With
 * JOBS_ENABLED=true (the launcher sets it; never in tests) onReady starts the worker + supervisor (60-second tick).
 * `GET /jobs` and `POST /jobs/run {job}` keep working: the latter still runs a job on demand, in-process, as the caller.
 * `runJob`, `refreshClocks` and `startJobs` stay exported for compatibility.
 */
import type { FastifyInstance } from 'fastify';
import type { Actor } from '@ccguk/db';
import type { AppContext } from './context.js';
import { parse } from './schemas/common.js';
import { jobsRunBody } from './schemas/services.js';
import { pollWatchList } from './routes/watch.js';
import { refreshAllClocks } from './agent/handlers/system.js';
import { createSupervisor, getSupervisor, type Supervisor } from './agent/supervisor.js';
import { listSchedules } from './agent/scheduler.js';

export const NIGHTLY_MS = 24 * 60 * 60 * 1000;
export const HOURLY_MS = 60 * 60 * 1000;

export interface JobRun {
  job: 'watch_poll' | 'clocks_refresh';
  startedAt: string;
  finishedAt: string;
  result: unknown;
}

export function jobsEnabled(ctx: AppContext): boolean {
  return process.env.JOBS_ENABLED === 'true' && ctx.config.env !== 'test';
}

/** Recompute and cache clocks for every open claim (audited 'job.clocks_refresh'). */
export function refreshClocks(ctx: AppContext, actor: Actor): { claims: number; clocks: number; breached: number } {
  return refreshAllClocks(ctx, actor);
}

/** Run a legacy job in-process now (POST /jobs/run). */
export async function runJob(ctx: AppContext, job: JobRun['job'], actor: Actor = ctx.repos.SYSTEM_ACTOR): Promise<JobRun> {
  const startedAt = ctx.now();
  const result = job === 'watch_poll' ? await pollWatchList(ctx, actor) : refreshClocks(ctx, actor);
  return { job, startedAt, finishedAt: ctx.now(), result };
}

export interface Scheduler {
  stop(): void;
  timers: NodeJS.Timeout[];
  supervisor?: Supervisor;
}

/**
 * Start background work: the agent worker + supervisor (which schedule `watch.poll` at 02:15 and `clocks.refresh`
 * hourly through the queue). The old interval options are accepted and ignored (schedules live in agent_schedules).
 */
export function startJobs(ctx: AppContext, _opts: { nightlyMs?: number; hourlyMs?: number } = {}): Scheduler {
  const supervisor = getSupervisor(ctx) ?? createSupervisor(ctx, { timers: true });
  supervisor.start();
  return {
    timers: [],
    supervisor,
    stop: () => {
      supervisor.stop().catch((err) => ctx.logger.error('supervisor stop failed', { error: String(err) }));
    },
  };
}

/** Route module: `POST /jobs/run`, `GET /jobs` and the worker/supervisor lifecycle (when JOBS_ENABLED=true). */
export function registerJobsModule(app: FastifyInstance, ctx: AppContext): void {
  let scheduler: Scheduler | undefined;
  if (jobsEnabled(ctx)) {
    app.addHook('onReady', async () => {
      scheduler = startJobs(ctx);
    });
    app.addHook('onClose', async () => {
      await scheduler?.supervisor?.stop();
    });
  }
  app.get('/jobs', async () => {
    const schedules = listSchedules(ctx).filter((s) => s.jobType === 'watch.poll' || s.jobType === 'clocks.refresh');
    return {
      enabled: jobsEnabled(ctx),
      jobs: [
        { job: 'watch_poll', every: 'nightly', queueType: 'watch.poll', nextRunAt: schedules.find((s) => s.jobType === 'watch.poll')?.nextRunAt ?? null },
        { job: 'clocks_refresh', every: 'hourly', queueType: 'clocks.refresh', nextRunAt: schedules.find((s) => s.jobType === 'clocks.refresh')?.nextRunAt ?? null },
      ],
      lastRuns: ctx.repos.listAudit(ctx.db, { entity: 'jobs' }).slice(0, 20),
    };
  });
  app.post('/jobs/run', async (request) => {
    const body = parse(jobsRunBody, request.body);
    return runJob(ctx, body.job, request.actor);
  });
}
