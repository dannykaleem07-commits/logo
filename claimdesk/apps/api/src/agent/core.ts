/**
 * Core agent helpers every slice uses (docs/SUPREME-DESIGN.md §C.3, §C.4, §C.7, §D.2) — owned by `foundation`:
 *  - enqueueJob: idempotent enqueue with the handler's lane/agent/priority, correlation + depth from the parent, and
 *    the hand-off loop guard (depth > 6 → the job is recorded dead and Needs-you `failure` is raised);
 *  - createNeedsYou: insert (dedupe-aware) + audit `needs_you.create` + enqueue `notify.dispatch`;
 *  - getAutonomy / autonomyState: the inputs `decide()` needs.
 * Cross-slice calls go through these, jobs and tables — never through another slice's modules (§P.4).
 */
import { JOB_TYPE_INFO, MAX_HANDOFF_DEPTH, londonWallToUtc, utcToLondonWall, type AgentName, type AutonomySettings, type AutonomyState, type ISODateTime } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { EnqueueInput, JobRecord, NeedsYouInput, NeedsYouItem } from './contracts.js';
import { getJobHandler } from './handlers/index.js';

const pad = (n: number): string => String(n).padStart(2, '0');

/** YYYY-MM-DD of an instant in Europe/London. */
export function londonDay(iso: ISODateTime): string {
  const w = new Date(utcToLondonWall(Date.parse(iso)));
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
}

/** HH:MM of an instant in Europe/London (the policy's `nowLocal`). */
export function londonHhmm(iso: ISODateTime): string {
  const w = new Date(utcToLondonWall(Date.parse(iso)));
  return `${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}`;
}

/** The UTC instant of London midnight starting the day that contains `iso`. */
export function londonDayStart(iso: ISODateTime): ISODateTime {
  const w = new Date(utcToLondonWall(Date.parse(iso)));
  return new Date(londonWallToUtc(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()))).toISOString();
}

/**
 * Enqueue a job (idempotent on `idempotencyKey`: the existing row is returned). Lane, agent, claim mutation, default
 * priority and max attempts come from the registered handler (else @ccguk/domain JOB_TYPE_INFO). A follow-up
 * (`parentJobId`) inherits the parent's correlation id and runs at depth + 1.
 */
export function enqueueJob(ctx: AppContext, input: EnqueueInput): JobRecord {
  const handler = getJobHandler(input.type);
  const info = JOB_TYPE_INFO[input.type];
  const parent = input.parentJobId ? ctx.repos.getAgentJob(ctx.db, input.parentJobId) : undefined;
  const depth = parent ? parent.depth + 1 : 0;
  const now = ctx.now();
  const { job, created } = ctx.repos.insertAgentJob(ctx.db, {
    type: input.type,
    payload: input.payload,
    createdBy: input.createdBy,
    agent: handler?.agent ?? info?.agent,
    lane: handler?.lane ?? info?.lane,
    mutates: handler?.mutatesClaim ?? info?.mutatesClaim,
    claimId: input.claimId,
    priority: input.priority ?? handler?.defaultPriority ?? info?.defaultPriority,
    runAfter: input.runAfter,
    idempotencyKey: input.idempotencyKey,
    parentJobId: input.parentJobId,
    correlationId: input.correlationId ?? parent?.correlationId,
    depth,
    maxAttempts: input.maxAttempts ?? handler?.maxAttempts,
    now,
  });
  if (created && depth > MAX_HANDOFF_DEPTH) {
    // Loop guard (§C.4): never run it; tell the owner once per correlation chain.
    const dead = ctx.repos.markAgentJobFailed(ctx.db, job.id, { error: `loop guard: hand-off depth ${depth} > ${MAX_HANDOFF_DEPTH}`, deadLetter: true, now });
    createNeedsYou(ctx, {
      kind: 'failure',
      claimId: input.claimId,
      title: 'Agents stopped a hand-off loop',
      summary: `A chain of ${depth} agent hand-offs (${input.type}) was stopped by the loop guard. Nothing further was done; please look at the claim and decide the next step.`,
      payload: { jobId: job.id, type: input.type, correlationId: job.correlationId, depth },
      priority: 'high',
      createdBy: 'system',
      dedupeKey: `loop_guard:${job.correlationId}`,
      correlationId: job.correlationId,
    });
    return dead as JobRecord;
  }
  return job as JobRecord;
}

/**
 * Create a Needs-you item (or return the open item with the same dedupe key) and, for a new item, audit it and queue
 * `notify.dispatch` (in-app + toast routing is the runtime's notify module).
 */
export function createNeedsYou(ctx: AppContext, input: NeedsYouInput): NeedsYouItem {
  const now = ctx.now();
  return ctx.db.transaction((tx) => {
    const { runId, ...row } = input;
    const { item, created } = ctx.repos.createNeedsYouItem(tx, { ...row, now });
    if (!created) return item;
    ctx.repos.appendAudit(tx, {
      actor: { userId: input.createdBy, ...(runId && input.createdBy.startsWith('agent:') ? { runId } : {}) },
      action: 'needs_you.create',
      entity: 'needs_you',
      entityId: item.id,
      after: { kind: item.kind, claimId: item.claimId ?? null, title: item.title, priority: item.priority, dedupeKey: item.dedupeKey ?? null, correlationId: item.correlationId ?? null },
      at: now,
    });
    const info = JOB_TYPE_INFO['notify.dispatch'];
    ctx.repos.insertAgentJob(tx, {
      type: 'notify.dispatch',
      payload: { needsYouId: item.id },
      createdBy: input.createdBy,
      agent: info.agent,
      lane: info.lane,
      mutates: false,
      priority: info.defaultPriority,
      idempotencyKey: `notify.dispatch:needs_you:${item.id}`,
      correlationId: input.correlationId,
      now,
    });
    return item;
  });
}

/** A sign-in failure pause without a stored end (fallback): a day, as runAgent sets it. */
const AUTH_WAIT_FALLBACK_MS = 24 * 60 * 60_000;

/**
 * auth_failed (§A.7) as a job outcome: the job waits with the AI pause (no attempt used) instead of failing for good, so
 * "I've fixed it" on the setup item (or the pause lapsing) runs it again.
 */
export function authFailedWait(ctx: AppContext, message: string): { kind: 'wait_usage'; until: ISODateTime; reason: string } {
  const pausedUntil = ctx.repos.getAiUsageState(ctx.db).pausedUntil;
  const until = pausedUntil && Date.parse(pausedUntil) > Date.parse(ctx.now()) ? pausedUntil : new Date(Date.parse(ctx.now()) + AUTH_WAIT_FALLBACK_MS).toISOString();
  return { kind: 'wait_usage', until, reason: `AI sign-in failed: ${message}`.slice(0, 1000) };
}

/** The owner's autonomy settings (stored, merged over DEFAULT_AUTONOMY). */
export function getAutonomy(ctx: AppContext): AutonomySettings {
  return ctx.repos.getAgentSettings(ctx.db).autonomy;
}

/**
 * Automatic sends counted for the rate limits (§D.2 rule 18, §F.8): outbox rows whose stored policy decision was
 * `auto_held` and that were not cancelled (undone). The mail slice stores the `Decision` JSON in `outbox.policy`.
 * Each row counts at the time it goes out — when it was sent, else when its hold ends, else when it was created — so a
 * quiet-hours email drafted last night and released at 07:30 counts towards today, and one held until tomorrow does
 * not count today.
 */
export function automaticSendCounts(ctx: AppContext, claimId: string | undefined, now: ISODateTime): AutonomyState['sends'] {
  const { dayStart, dayEnd } = londonDayWindow(now);
  const hourAgo = new Date(Date.parse(now) - 3_600_000).toISOString();
  const row = ctx.handle.sqlite
    .prepare(
      `WITH auto AS (
         SELECT o.claim_id AS claim_id,
                COALESCE((SELECT min(e.at) FROM outbox_events e WHERE e.outbox_id = o.id AND e.to_status = 'sent'), o.hold_until, o.created_at) AS out_at
         FROM outbox o
         WHERE o.status <> 'cancelled' AND json_valid(o.policy) AND json_extract(o.policy, '$.outcome') = 'auto_held'
       )
       SELECT
         sum(CASE WHEN out_at >= @dayStart AND out_at < @dayEnd THEN 1 ELSE 0 END) AS today,
         sum(CASE WHEN out_at >= @hourAgo THEN 1 ELSE 0 END) AS hour,
         sum(CASE WHEN out_at >= @dayStart AND out_at < @dayEnd AND claim_id = @claimId THEN 1 ELSE 0 END) AS claim
       FROM auto`,
    )
    .get({ dayStart, dayEnd, hourAgo, claimId: claimId ?? '' }) as { today: number | null; hour: number | null; claim: number | null } | undefined;
  return { claimToday: Number(row?.claim ?? 0), lastHour: Number(row?.hour ?? 0), today: Number(row?.today ?? 0) };
}

/** [start, end) of the Europe/London day containing `iso`, as UTC instants. */
export function londonDayWindow(iso: ISODateTime): { dayStart: ISODateTime; dayEnd: ISODateTime } {
  const dayStart = londonDayStart(iso);
  // 26 h after the start is always inside the next London day (23/25-hour days included).
  const dayEnd = londonDayStart(new Date(Date.parse(dayStart) + 26 * 3_600_000).toISOString());
  return { dayStart, dayEnd };
}

/** The runtime state `decide()` needs for an action by `agent` on `claimId`. */
export function autonomyState(ctx: AppContext, input: { claimId?: string; agent: AgentName }): AutonomyState {
  const settings = ctx.repos.getAgentSettings(ctx.db);
  const now = ctx.now();
  return {
    killSwitch: settings.autonomy.killSwitch,
    agentPaused: settings.agents.paused.includes(input.agent),
    claimPaused: input.claimId ? ctx.repos.getClaimAgentState(ctx.db, input.claimId).paused : false,
    sends: automaticSendCounts(ctx, input.claimId, now),
    nowLocal: londonHhmm(now),
  };
}
