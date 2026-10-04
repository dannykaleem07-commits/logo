/**
 * Background jobs, guarded by JOBS_ENABLED=true (never in tests): a nightly Companies House poll of the watch list
 * and an hourly clocks refresh that recomputes and caches clocks for every open claim. Registered as a route module
 * (`registerJobsModule`) so it hooks the app lifecycle; `POST /jobs/run {job}` runs a job on demand.
 */
import type { FastifyInstance } from 'fastify';
import type { Actor } from '@ccguk/db';
import type { ClaimStatus } from '@ccguk/domain';
import type { AppContext } from './context.js';
import { parse } from './schemas/common.js';
import { jobsRunBody } from './schemas/services.js';
import { recomputeClocks } from './services/claimView.js';
import { pollWatchList } from './routes/watch.js';

export const NIGHTLY_MS = 24 * 60 * 60 * 1000;
export const HOURLY_MS = 60 * 60 * 1000;
const CLOSED: ReadonlySet<ClaimStatus> = new Set(['settled', 'closed', 'declined']);

export interface JobRun {
  job: 'watch_poll' | 'clocks_refresh';
  startedAt: string;
  finishedAt: string;
  result: unknown;
}

export function jobsEnabled(ctx: AppContext): boolean {
  return process.env.JOBS_ENABLED === 'true' && ctx.config.env !== 'test';
}

export function refreshClocks(ctx: AppContext, actor: Actor): { claims: number; clocks: number; breached: number } {
  const open = ctx.repos.listClaims(ctx.db, { limit: 100_000 }).filter((c) => !CLOSED.has(c.status));
  let clocks = 0;
  let breached = 0;
  for (const c of open) {
    try {
      const derived = recomputeClocks(ctx, c.id);
      clocks += derived.length;
      breached += derived.filter((k) => k.status === 'breached').length;
    } catch (err) {
      ctx.logger.warn('clocks refresh failed for claim', { claimId: c.id, error: String(err) });
    }
  }
  ctx.repos.appendAudit(ctx.db, { actor, action: 'job.clocks_refresh', entity: 'jobs', entityId: 'clocks_refresh', after: { claims: open.length, clocks, breached }, at: ctx.now() });
  return { claims: open.length, clocks, breached };
}

export async function runJob(ctx: AppContext, job: JobRun['job'], actor: Actor = ctx.repos.SYSTEM_ACTOR): Promise<JobRun> {
  const startedAt = ctx.now();
  const result = job === 'watch_poll' ? await pollWatchList(ctx, actor) : refreshClocks(ctx, actor);
  return { job, startedAt, finishedAt: ctx.now(), result };
}

export interface Scheduler {
  stop(): void;
  timers: NodeJS.Timeout[];
}

export function startJobs(ctx: AppContext, opts: { nightlyMs?: number; hourlyMs?: number } = {}): Scheduler {
  const timers: NodeJS.Timeout[] = [];
  const safe = (job: JobRun['job']) => () => {
    runJob(ctx, job).then((r) => ctx.logger.info('job finished', { job, result: r.result })).catch((err) => ctx.logger.error('job failed', { job, error: String(err) }));
  };
  timers.push(setInterval(safe('watch_poll'), opts.nightlyMs ?? NIGHTLY_MS));
  timers.push(setInterval(safe('clocks_refresh'), opts.hourlyMs ?? HOURLY_MS));
  for (const t of timers) t.unref();
  ctx.logger.info('jobs scheduled', { watch_poll: `${(opts.nightlyMs ?? NIGHTLY_MS) / 3_600_000}h`, clocks_refresh: `${(opts.hourlyMs ?? HOURLY_MS) / 3_600_000}h` });
  return { timers, stop: () => timers.forEach((t) => clearInterval(t)) };
}

/** Route module: `POST /jobs/run`, `GET /jobs` and the scheduler lifecycle (when JOBS_ENABLED=true). */
export function registerJobsModule(app: FastifyInstance, ctx: AppContext): void {
  let scheduler: Scheduler | undefined;
  if (jobsEnabled(ctx)) {
    app.addHook('onReady', async () => {
      scheduler = startJobs(ctx);
    });
    app.addHook('onClose', async () => scheduler?.stop());
  }
  app.get('/jobs', async () => ({ enabled: jobsEnabled(ctx), jobs: [{ job: 'watch_poll', every: 'nightly' }, { job: 'clocks_refresh', every: 'hourly' }], lastRuns: ctx.repos.listAudit(ctx.db, { entity: 'jobs' }).slice(0, 20) }));
  app.post('/jobs/run', async (request) => {
    const body = parse(jobsRunBody, request.body);
    return runJob(ctx, body.job, request.actor);
  });
}
