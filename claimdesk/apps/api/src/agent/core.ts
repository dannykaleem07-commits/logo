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
    const { item, created } = ctx.repos.createNeedsYouItem(tx, { ...input, now });
    if (!created) return item;
    ctx.repos.appendAudit(tx, {
      actor: { userId: input.createdBy },
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

/** The owner's autonomy settings (stored, merged over DEFAULT_AUTONOMY). */
export function getAutonomy(ctx: AppContext): AutonomySettings {
  return ctx.repos.getAgentSettings(ctx.db).autonomy;
}

/**
 * Automatic sends counted for the rate limits (§D.2 rule 18, §F.8): outbox rows whose stored policy decision was
 * `auto_held` and that were not cancelled (undone). The mail slice stores the `Decision` JSON in `outbox.policy`.
 */
export function automaticSendCounts(ctx: AppContext, claimId: string | undefined, now: ISODateTime): AutonomyState['sends'] {
  const dayStart = londonDayStart(now);
  const hourAgo = new Date(Date.parse(now) - 3_600_000).toISOString();
  const row = ctx.handle.sqlite
    .prepare(
      `SELECT
         sum(CASE WHEN created_at >= @dayStart THEN 1 ELSE 0 END) AS today,
         sum(CASE WHEN created_at >= @hourAgo THEN 1 ELSE 0 END) AS hour,
         sum(CASE WHEN created_at >= @dayStart AND claim_id = @claimId THEN 1 ELSE 0 END) AS claim
       FROM outbox
       WHERE status <> 'cancelled' AND json_valid(policy) AND json_extract(policy, '$.outcome') = 'auto_held'`,
    )
    .get({ dayStart, hourAgo, claimId: claimId ?? '' }) as { today: number | null; hour: number | null; claim: number | null } | undefined;
  return { claimToday: Number(row?.claim ?? 0), lastHour: Number(row?.hour ?? 0), today: Number(row?.today ?? 0) };
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
