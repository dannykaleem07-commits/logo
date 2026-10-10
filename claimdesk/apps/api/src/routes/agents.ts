// owned by runtime
/**
 * Agents control room routes (docs/SUPREME-DESIGN.md §C.6, §L.3, §N.6):
 *   GET  /agents/status                     pill, usage meter, lanes, per-agent cards, heartbeat
 *   POST /agents/kill-switch {on, reason?}  audited 'agents.kill_switch'
 *   POST /agents/:name/pause | resume       audited 'agents.pause' / 'agents.resume'
 *   GET  /agents/jobs, GET /agents/jobs/:id, POST /agents/jobs/:id/retry | cancel
 *   GET  /agents/runs, GET /agents/runs/:id (tool-call timeline with decisions and rule ids)
 *   GET  /agents/schedules, PATCH /agents/schedules/:id, POST /agents/schedules/:id/run-now
 *   GET  /claims/:id/agent, POST /claims/:id/agent/pause | resume | review-now
 * People only: agent run tokens never reach these (perimeter route allow-list, §B.2).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AGENT_NAMES, JOB_STATUSES, JOB_TYPES, LANES, type AgentName, type ISODateTime, type JobStatus, type JobType, type Lane } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { HttpError, badRequest, conflict, notFound } from '../errors.js';
import { parse } from '../schemas/common.js';
import { params, requireClaim, requireRole } from './helpers.js';
import { enqueueJob, londonHhmm } from '../agent/core.js';
import { computeGates, getSupervisor } from '../agent/supervisor.js';
import { currentLaneLimits, effectiveAgentSettings } from '../agent/queue.js';
import { getSchedule, isHhmm, listSchedules, runScheduleNow, updateSchedule } from '../agent/scheduler.js';
import { jobsEnabled } from '../jobs.js';

/** Agents shown in the control room (Phase 1). */
export const PHASE1_AGENTS: readonly AgentName[] = ['intake', 'mail', 'case_manager', 'drafter', 'reviewer', 'researcher', 'supervisor'];

export type AgentsPillState = 'running' | 'paused' | 'stopped' | 'off';

const fmtLondonTime = (iso: string): string => londonHhmm(iso);

function humanOnly(request: FastifyRequest): void {
  const id = request.actor?.userId ?? '';
  if (request.agent || id === 'system' || id.startsWith('agent:')) throw new HttpError(403, 'HUMAN_REQUIRED', 'Only a signed-in person can do this.');
}

export function agentsStatus(ctx: AppContext) {
  const now = ctx.now();
  const settings = effectiveAgentSettings(ctx);
  const usage = ctx.repos.getAiUsageState(ctx.db);
  const supervisor = getSupervisor(ctx);
  const heartbeat = supervisor?.heartbeat();
  const { gates, ai } = computeGates(ctx, now);
  const running = supervisor?.worker.running() ?? [];
  const limits = currentLaneLimits(ctx);
  const background = jobsEnabled(ctx) || Boolean(supervisor);
  const paused = Boolean(usage.pausedUntil && usage.pausedUntil > now);

  let state: AgentsPillState;
  let label: string;
  if (settings.autonomy.killSwitch) {
    state = 'stopped';
    label = 'Agents stopped';
  } else if (!settings.agents.enabled || settings.ai.driver === 'off') {
    state = 'off';
    label = 'Agents off';
  } else if (!background) {
    state = 'off';
    label = 'Agents off (background not running)';
  } else if (paused) {
    state = 'paused';
    label = usage.pauseReason === 'daily_cap' ? `Paused — daily cap, resumes ${fmtLondonTime(usage.pausedUntil!)}` : /auth|setup/i.test(usage.pauseReason ?? '') ? 'Paused — sign-in needed' : `Paused — usage resets ${fmtLondonTime(usage.pausedUntil!)}`;
  } else {
    state = 'running';
    label = ai.economy ? 'Agents running (economy)' : 'Agents running';
  }

  const agents = PHASE1_AGENTS.map((name) => {
    const runs = ctx.repos.listAgentRuns(ctx.db, { agent: name, limit: 20 });
    const finished = runs.filter((r) => r.outcome);
    const ok = finished.filter((r) => r.outcome === 'ok').length;
    const durations = finished.filter((r) => r.endedAt).map((r) => Date.parse(r.endedAt!) - Date.parse(r.startedAt)).filter((d) => Number.isFinite(d) && d >= 0);
    return {
      name,
      paused: settings.agents.paused.includes(name),
      running: running.filter((r) => r.agent === name).map((r) => ({ ...r, elapsedMs: Math.max(0, Date.parse(now) - Date.parse(r.startedAt)) })),
      queued: ctx.repos.countAgentJobs(ctx.db, { agent: name, status: ['queued', 'waiting_usage'] }),
      waitingForYou: ctx.repos.countAgentJobs(ctx.db, { agent: name, status: 'waiting_user' }),
      cap: limits.agentCaps[name] ?? null,
      lastRuns: runs.map((r) => ({ id: r.id, jobType: r.jobType, claimId: r.claimId ?? null, outcome: r.outcome ?? null, startedAt: r.startedAt, endedAt: r.endedAt ?? null })),
      successRate: finished.length ? ok / finished.length : null,
      avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    };
  });

  return {
    at: now,
    pill: { state, label },
    jobsEnabled: background,
    enabled: settings.agents.enabled,
    driver: settings.driverChoice,
    killSwitch: settings.autonomy.killSwitch,
    usage: {
      pausedUntil: paused ? usage.pausedUntil! : null,
      pauseReason: paused ? (usage.pauseReason ?? null) : null,
      fiveHour: usage.fiveHour ?? null,
      sevenDay: usage.sevenDay ?? null,
      economy: ai.economy,
      gate: { maxPriority: ai.maxPriority, reason: ai.reason },
      costTodayUsd: usage.costTodayUsd,
      dailyUsdCap: settings.ai.dailyUsdCap,
      reservePercent: settings.ai.reservePercent,
    },
    lanes: Object.fromEntries(LANES.map((l) => [l, { busy: running.filter((r) => r.lane === l).length, limit: limits.lanes[l], open: gates.lanes[l].open, reason: gates.lanes[l].reason ?? null }])) as Record<Lane, { busy: number; limit: number; open: boolean; reason: string | null }>,
    queue: {
      queued: ctx.repos.countAgentJobs(ctx.db, { status: 'queued' }),
      waitingUsage: ctx.repos.countAgentJobs(ctx.db, { status: 'waiting_usage' }),
      waitingUser: ctx.repos.countAgentJobs(ctx.db, { status: 'waiting_user' }),
      dead: ctx.repos.countAgentJobs(ctx.db, { status: 'dead' }),
    },
    agents,
    pausedClaims: gates.pausedClaims.length,
    heartbeat: heartbeat ? { at: heartbeat.at, started: heartbeat.started, dead: heartbeat.dead, requeued: heartbeat.requeued, registryProblems: heartbeat.registryProblems } : null,
  };
}

const csv = <T extends string>(allowed: readonly T[]) =>
  z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined))
    .refine((v) => !v || v.every((x) => (allowed as readonly string[]).includes(x)), 'unknown value')
    .transform((v) => v as T[] | undefined);

const jobsQuery = z.object({
  status: csv<JobStatus>(JOB_STATUSES),
  type: csv<JobType>(JOB_TYPES),
  agent: z.string().optional(),
  claimId: z.string().optional(),
  correlationId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const runsQuery = z.object({
  agent: z.enum(AGENT_NAMES as unknown as [AgentName, ...AgentName[]]).optional(),
  claimId: z.string().optional(),
  jobId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const killSwitchBody = z.object({ on: z.boolean(), reason: z.string().max(500).optional() });
const pauseBody = z.object({ reason: z.string().max(500).optional() }).optional();
const schedulePatch = z.object({
  enabled: z.boolean().optional(),
  everyMinutes: z.number().int().min(1).max(7 * 24 * 60).nullable().optional(),
  atLocal: z.string().refine(isHhmm, 'expected HH:MM').nullable().optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).nullable().optional(),
});

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/agents/status', async () => agentsStatus(ctx));

  app.post('/agents/kill-switch', async (request) => {
    humanOnly(request);
    const body = parse(killSwitchBody, request.body);
    // Anyone signed in may stop the agents; starting them again is for admin/approver.
    if (!body.on) requireRole(request);
    const before = ctx.repos.getAgentSettings(ctx.db).autonomy.killSwitch;
    const now = ctx.now();
    ctx.repos.patchAgentSettings(ctx.db, { autonomy: { killSwitch: body.on } }, request.actor, now);
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'agents.kill_switch', entity: 'agent_settings', entityId: 'default', before: { killSwitch: before }, after: { killSwitch: body.on, reason: body.reason ?? null }, at: now });
    return agentsStatus(ctx);
  });

  for (const action of ['pause', 'resume'] as const) {
    app.post(`/agents/:name/${action}`, async (request) => {
      humanOnly(request);
      const { name } = params<{ name: string }>(request);
      if (!(AGENT_NAMES as readonly string[]).includes(name)) throw notFound('agent', name);
      const body = parse(pauseBody, request.body ?? undefined);
      const settings = ctx.repos.getAgentSettings(ctx.db);
      const set = new Set(settings.agents.paused);
      if (action === 'pause') set.add(name as AgentName);
      else set.delete(name as AgentName);
      const now = ctx.now();
      ctx.repos.patchAgentSettings(ctx.db, { agents: { paused: [...set] } }, request.actor, now);
      ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: `agents.${action}`, entity: 'agents', entityId: name, after: { scope: 'agent', agent: name, reason: body?.reason ?? null }, at: now });
      return agentsStatus(ctx);
    });
  }

  app.get('/agents/jobs', async (request) => {
    const q = parse(jobsQuery, request.query);
    const filter = { status: q.status, type: q.type, agent: q.agent as AgentName | 'system' | undefined, claimId: q.claimId, correlationId: q.correlationId };
    return { items: ctx.repos.listAgentJobs(ctx.db, { ...filter, limit: q.limit ?? 100, offset: q.offset ?? 0 }), total: ctx.repos.countAgentJobs(ctx.db, filter) };
  });

  app.get('/agents/jobs/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const job = ctx.repos.getAgentJob(ctx.db, id);
    if (!job) throw notFound('agent_jobs', id);
    return {
      job,
      attempts: ctx.repos.listAgentJobAttempts(ctx.db, id),
      runs: ctx.repos.listAgentRuns(ctx.db, { jobId: id, limit: 50 }),
      children: ctx.repos.listAgentJobs(ctx.db, { parentJobId: id, limit: 50 }),
    };
  });

  app.post('/agents/jobs/:id/retry', async (request) => {
    humanOnly(request);
    const { id } = params<{ id: string }>(request);
    const job = ctx.repos.getAgentJob(ctx.db, id);
    if (!job) throw notFound('agent_jobs', id);
    if (!['failed', 'dead', 'cancelled', 'waiting_usage', 'waiting_user'].includes(job.status)) throw conflict('JOB_STATE', `A ${job.status} job cannot be retried.`);
    const now = ctx.now();
    // Cancelled jobs are terminal in the repo; the owner's retry re-queues a fresh copy under the same correlation.
    const next =
      job.status === 'cancelled'
        ? enqueueJob(ctx, { type: job.type, payload: job.payload, claimId: job.claimId, priority: job.priority, correlationId: job.correlationId, createdBy: request.actor.userId })
        : ctx.repos.resumeAgentJob(ctx.db, id, { resetAttempts: true, now });
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'agents.job.retry', entity: 'agent_jobs', entityId: id, before: { status: job.status }, after: { status: next.status, jobId: next.id }, at: now });
    return next;
  });

  app.post('/agents/jobs/:id/cancel', async (request) => {
    humanOnly(request);
    const { id } = params<{ id: string }>(request);
    const job = ctx.repos.getAgentJob(ctx.db, id);
    if (!job) throw notFound('agent_jobs', id);
    if (job.status === 'leased') throw conflict('JOB_RUNNING', 'This job is running now; pause the agent or wait for it to finish.');
    const now = ctx.now();
    const next = ctx.repos.cancelAgentJob(ctx.db, id, { reason: `cancelled by ${request.actor.userId}`, now });
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'agents.job.cancel', entity: 'agent_jobs', entityId: id, before: { status: job.status }, after: { status: next.status }, at: now });
    return next;
  });

  app.get('/agents/runs', async (request) => {
    const q = parse(runsQuery, request.query);
    return { items: ctx.repos.listAgentRuns(ctx.db, { agent: q.agent, claimId: q.claimId, jobId: q.jobId, limit: q.limit ?? 100, offset: q.offset ?? 0 }) };
  });

  app.get('/agents/runs/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const run = ctx.repos.getAgentRun(ctx.db, id);
    if (!run) throw notFound('agent_runs', id);
    return { run, toolCalls: ctx.repos.listAgentToolCalls(ctx.db, id), job: ctx.repos.getAgentJob(ctx.db, run.jobId) ?? null };
  });

  app.get('/agents/schedules', async () => ({ items: listSchedules(ctx) }));

  app.patch('/agents/schedules/:id', async (request) => {
    humanOnly(request);
    requireRole(request);
    const { id } = params<{ id: string }>(request);
    const body = parse(schedulePatch, request.body);
    const before = getSchedule(ctx, id);
    if (!before) throw notFound('agent_schedules', id);
    if (body.everyMinutes === null && body.atLocal === null) throw badRequest('A schedule needs an interval or a time of day');
    const after = updateSchedule(ctx, id, body);
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'agents.schedule', entity: 'agent_schedules', entityId: id, before, after, at: ctx.now() });
    return after;
  });

  app.post('/agents/schedules/:id/run-now', async (request) => {
    humanOnly(request);
    const { id } = params<{ id: string }>(request);
    const jobs = runScheduleNow(ctx, id, request.actor.userId);
    if (!jobs) throw notFound('agent_schedules', id);
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'agents.schedule.run_now', entity: 'agent_schedules', entityId: id, after: { jobIds: jobs.map((j) => j.id) }, at: ctx.now() });
    return { jobs };
  });

  // --- per claim -----------------------------------------------------------------------------------------
  app.get('/claims/:id/agent', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    return {
      state: ctx.repos.getClaimAgentState(ctx.db, id),
      jobs: ctx.repos.listAgentJobs(ctx.db, { claimId: id, limit: 30 }),
      runs: ctx.repos.listAgentRuns(ctx.db, { claimId: id, limit: 30 }),
      needsYou: ctx.repos.listNeedsYou(ctx.db, { claimId: id, status: ['open', 'snoozed'], limit: 50 }),
      tasks: ctx.repos.listTasks(ctx.db, { claimId: id, status: 'open', limit: 50 }),
    };
  });

  app.post('/claims/:id/agent/pause', async (request) => {
    humanOnly(request);
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(pauseBody, request.body ?? undefined);
    return ctx.repos.pauseClaimAgents(ctx.db, id, { actor: request.actor, reason: body?.reason, now: ctx.now() });
  });

  app.post('/claims/:id/agent/resume', async (request) => {
    humanOnly(request);
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    return ctx.repos.resumeClaimAgents(ctx.db, id, { actor: request.actor, now: ctx.now() });
  });

  app.post('/claims/:id/agent/review-now', async (request) => {
    humanOnly(request);
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const now: ISODateTime = ctx.now();
    // Owner-triggered: exempt from the per-claim AI budget (§C.4); one per minute.
    const job = enqueueJob(ctx, { type: 'case.review', payload: { claimId: id, reason: 'owner' }, claimId: id, priority: 1, idempotencyKey: `case.review:${id}:owner:${now.slice(0, 16)}`, createdBy: request.actor.userId });
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'agents.review_now', entity: 'claims', entityId: id, after: { jobId: job.id }, at: now });
    return job;
  });
}
