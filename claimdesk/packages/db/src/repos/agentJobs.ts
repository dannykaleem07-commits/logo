/**
 * Durable agent job queue (docs/SUPREME-DESIGN.md §C.3). The API process is the only writer; leases exist for crash
 * recovery. Enqueue is idempotent on `idempotency_key`; leasing is one `UPDATE … RETURNING` with the per-claim lock.
 * `agent_job_attempts` is append-only (one row per finished attempt).
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { JOB_TYPE_INFO, type AgentName, type ISODateTime, type JobStatus, type JobType, type Lane } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { agentJobAttempts, agentJobs, type AgentJobAttemptRow, type AgentJobRow } from '../schema.js';
import { denull, nowIso } from '../util.js';

/** Persistence shape of a job — structurally the API's `JobRecord` (§C.3). */
export interface AgentJob {
  id: string;
  type: JobType;
  agent: AgentName | 'system';
  claimId?: string;
  payload: unknown;
  status: JobStatus;
  lane: Lane;
  mutates: boolean;
  priority: number;
  runAfter: ISODateTime;
  attempts: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseUntil?: ISODateTime;
  idempotencyKey?: string;
  parentJobId?: string;
  correlationId: string;
  depth: number;
  result?: unknown;
  error?: string;
  needsYouId?: string;
  createdBy: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  finishedAt?: ISODateTime;
}

export interface EnqueueAgentJobInput {
  type: JobType;
  payload: unknown;
  createdBy: string;
  /** Defaults from @ccguk/domain JOB_TYPE_INFO (the handler registry passes its own values). */
  agent?: AgentName | 'system';
  lane?: Lane;
  mutates?: boolean;
  claimId?: string;
  priority?: number;
  runAfter?: ISODateTime;
  idempotencyKey?: string;
  parentJobId?: string;
  correlationId?: string;
  depth?: number;
  maxAttempts?: number;
  id?: string;
  now?: ISODateTime;
}

export interface AgentJobAttempt {
  id: string;
  jobId: string;
  attempt: number;
  startedAt: ISODateTime;
  finishedAt?: ISODateTime;
  outcome: string;
  error?: string;
  runId?: string;
}

const TERMINAL: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled', 'dead']);

export const isTerminalJobStatus = (s: JobStatus): boolean => TERMINAL.has(s);

function toJob(row: AgentJobRow): AgentJob {
  const d = denull(row);
  return { ...d, payload: row.payload ?? null } as AgentJob;
}

/** A raw `RETURNING *` row (snake_case, JSON as text). */
interface RawJobRow {
  id: string;
  type: string;
  agent: string;
  claim_id: string | null;
  payload: string;
  status: string;
  lane: string;
  mutates: number;
  priority: number;
  run_after: string;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_until: string | null;
  idempotency_key: string | null;
  parent_job_id: string | null;
  correlation_id: string;
  depth: number;
  result: string | null;
  error: string | null;
  needs_you_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

const parseJson = (s: string | null): unknown => {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

function fromRaw(r: RawJobRow): AgentJob {
  return toJob({
    id: r.id,
    type: r.type as JobType,
    agent: r.agent as AgentName,
    claimId: r.claim_id,
    payload: parseJson(r.payload),
    status: r.status as JobStatus,
    lane: r.lane as Lane,
    mutates: Boolean(r.mutates),
    priority: r.priority,
    runAfter: r.run_after,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    leaseOwner: r.lease_owner,
    leaseUntil: r.lease_until,
    idempotencyKey: r.idempotency_key,
    parentJobId: r.parent_job_id,
    correlationId: r.correlation_id,
    depth: r.depth,
    result: parseJson(r.result),
    error: r.error,
    needsYouId: r.needs_you_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  });
}

export function getAgentJob(db: Db, id: string): AgentJob | undefined {
  const row = db.select().from(agentJobs).where(eq(agentJobs.id, id)).get();
  return row ? toJob(row) : undefined;
}

export function requireAgentJob(db: Db, id: string): AgentJob {
  const j = getAgentJob(db, id);
  if (!j) throw new NotFoundError('agent_jobs', id);
  return j;
}

export function getAgentJobByKey(db: Db, idempotencyKey: string): AgentJob | undefined {
  const row = db.select().from(agentJobs).where(eq(agentJobs.idempotencyKey, idempotencyKey)).get();
  return row ? toJob(row) : undefined;
}

/**
 * Insert a job; with an idempotency key already present nothing is inserted and the existing row is returned
 * (`created: false`). `INSERT … ON CONFLICT DO NOTHING`.
 */
export function insertAgentJob(db: Db, input: EnqueueAgentJobInput): { job: AgentJob; created: boolean } {
  const info = JOB_TYPE_INFO[input.type];
  if (!info && (input.lane === undefined || input.agent === undefined)) throw new ValidationError(`Unknown job type ${input.type}: pass agent and lane`);
  const now = input.now ?? nowIso();
  const id = input.id ?? randomUUID();
  const maxAttempts = input.maxAttempts ?? 3;
  if (!(maxAttempts >= 1)) throw new ValidationError('maxAttempts must be at least 1');
  const row = {
    id,
    type: input.type,
    agent: input.agent ?? info!.agent,
    claimId: input.claimId ?? null,
    payload: input.payload ?? null,
    status: 'queued' as const,
    lane: input.lane ?? info!.lane,
    mutates: input.mutates ?? info?.mutatesClaim ?? false,
    priority: input.priority ?? info?.defaultPriority ?? 5,
    runAfter: input.runAfter ?? now,
    attempts: 0,
    maxAttempts,
    idempotencyKey: input.idempotencyKey ?? null,
    parentJobId: input.parentJobId ?? null,
    correlationId: input.correlationId ?? id,
    depth: input.depth ?? 0,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  const inserted = db.insert(agentJobs).values(row).onConflictDoNothing().returning().all();
  if (inserted[0]) return { job: toJob(inserted[0]), created: true };
  const existing = input.idempotencyKey ? getAgentJobByKey(db, input.idempotencyKey) : getAgentJob(db, id);
  if (!existing) throw new ValidationError(`Job ${id} could not be inserted`);
  return { job: existing, created: false };
}

/** Enqueue (idempotent): the new row, or the existing row with the same idempotency key. */
export function enqueueAgentJob(db: Db, input: EnqueueAgentJobInput): AgentJob {
  return insertAgentJob(db, input).job;
}

export interface LeaseAgentJobInput {
  lane: Lane;
  /** Highest priority number allowed to start (usage gates, §A.5). */
  maxPriority: number;
  now: ISODateTime;
  owner: string;
  leaseMs: number;
  pausedAgents?: readonly string[];
  pausedClaims?: readonly string[];
}

/**
 * Lease the next ready job of a lane (§C.3): queued, due, within the priority gate, not for a paused agent or claim, and
 * — for a claim-mutating job — no other claim-mutating job of the same claim currently leased. Counts an attempt.
 */
export function leaseAgentJob(db: Db, input: LeaseAgentJobInput): AgentJob | undefined {
  const leaseUntil = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
  const agents = (input.pausedAgents ?? []).filter(Boolean);
  const claims = (input.pausedClaims ?? []).filter(Boolean);
  const agentsClause = agents.length ? sql` AND j.agent NOT IN (${sql.join(agents.map((a) => sql`${a}`), sql`, `)})` : sql``;
  const claimsClause = claims.length ? sql` AND (j.claim_id IS NULL OR j.claim_id NOT IN (${sql.join(claims.map((c) => sql`${c}`), sql`, `)}))` : sql``;
  const rows = db.all<RawJobRow>(sql`
    UPDATE agent_jobs SET status = 'leased', lease_owner = ${input.owner}, lease_until = ${leaseUntil}, attempts = attempts + 1, updated_at = ${input.now}
    WHERE id = (
      SELECT j.id FROM agent_jobs j
      WHERE j.status = 'queued' AND j.lane = ${input.lane} AND j.run_after <= ${input.now} AND j.priority <= ${input.maxPriority}
        AND (j.claim_id IS NULL OR j.mutates = 0 OR NOT EXISTS (
          SELECT 1 FROM agent_jobs k WHERE k.claim_id = j.claim_id AND k.status = 'leased' AND k.mutates = 1))
        ${agentsClause}
        AND (j.claim_id IS NULL OR j.claim_id NOT IN (SELECT s.claim_id FROM claim_agent_state s WHERE s.paused = 1))
        ${claimsClause}
      ORDER BY j.priority, j.run_after, j.created_at, j.rowid
      LIMIT 1)
    RETURNING *`);
  return rows[0] ? fromRaw(rows[0]) : undefined;
}

function update(db: Db, id: string, set: Partial<typeof agentJobs.$inferInsert>): AgentJob {
  const rows = db.update(agentJobs).set(set).where(eq(agentJobs.id, id)).returning().all();
  if (!rows[0]) throw new NotFoundError('agent_jobs', id);
  return toJob(rows[0]);
}

const clearLease = { leaseOwner: null, leaseUntil: null } as const;

export function markAgentJobSucceeded(db: Db, id: string, input: { result?: unknown; now?: ISODateTime } = {}): AgentJob {
  const now = input.now ?? nowIso();
  return update(db, id, { status: 'succeeded', result: input.result ?? null, error: null, finishedAt: now, updatedAt: now, ...clearLease });
}

/** Failed for good: `failed`, or `dead` when `deadLetter` (the runtime raises Needs-you `failure` for dead jobs). */
export function markAgentJobFailed(db: Db, id: string, input: { error: string; deadLetter?: boolean; now?: ISODateTime }): AgentJob {
  const now = input.now ?? nowIso();
  return update(db, id, { status: input.deadLetter ? 'dead' : 'failed', error: input.error, finishedAt: now, updatedAt: now, ...clearLease });
}

/** Retry later; when the attempts are used up the job is `dead` instead. */
export function retryAgentJobAt(db: Db, id: string, input: { runAfter: ISODateTime; error?: string; now?: ISODateTime }): AgentJob {
  const now = input.now ?? nowIso();
  const job = requireAgentJob(db, id);
  if (job.attempts >= job.maxAttempts) return update(db, id, { status: 'dead', error: input.error ?? job.error ?? 'max attempts reached', finishedAt: now, updatedAt: now, ...clearLease });
  return update(db, id, { status: 'queued', runAfter: input.runAfter, error: input.error ?? null, updatedAt: now, ...clearLease });
}

/** Usage window closed: wait until `until` without consuming the attempt (§A.5). */
export function waitAgentJobUsage(db: Db, id: string, input: { until: ISODateTime; reason?: string; now?: ISODateTime }): AgentJob {
  const now = input.now ?? nowIso();
  const rows = db
    .update(agentJobs)
    .set({ status: 'waiting_usage', runAfter: input.until, attempts: sql`max(${agentJobs.attempts} - 1, 0)`, error: input.reason ?? null, updatedAt: now, ...clearLease })
    .where(eq(agentJobs.id, id))
    .returning()
    .all();
  if (!rows[0]) throw new NotFoundError('agent_jobs', id);
  return toJob(rows[0]);
}

/** Waiting for the owner: resumed by the Needs-you resolver with `resumeAgentJob`. */
export function waitAgentJobUser(db: Db, id: string, input: { needsYouId: string; now?: ISODateTime }): AgentJob {
  const now = input.now ?? nowIso();
  return update(db, id, { status: 'waiting_user', needsYouId: input.needsYouId, updatedAt: now, ...clearLease });
}

/** Put a waiting (or failed/dead, on the owner's retry) job back on the queue. */
export function resumeAgentJob(db: Db, id: string, input: { runAfter?: ISODateTime; resetAttempts?: boolean; now?: ISODateTime } = {}): AgentJob {
  const now = input.now ?? nowIso();
  const job = requireAgentJob(db, id);
  if (job.status === 'succeeded' || job.status === 'cancelled' || job.status === 'leased' || job.status === 'queued') return job;
  return update(db, id, { status: 'queued', runAfter: input.runAfter ?? now, ...(input.resetAttempts ? { attempts: 0 } : {}), finishedAt: null, updatedAt: now, ...clearLease });
}

/** Lift usage waits whose time has come (`waiting_usage` → `queued`). Returns the number of jobs released. */
export function releaseWaitingUsageJobs(db: Db, now: ISODateTime): number {
  const rows = db
    .update(agentJobs)
    .set({ status: 'queued', updatedAt: now })
    .where(and(eq(agentJobs.status, 'waiting_usage'), sql`${agentJobs.runAfter} <= ${now}`))
    .returning({ id: agentJobs.id })
    .all();
  return rows.length;
}

/**
 * Expired leases (crash, hang) go back to `queued` — the attempt stays used; jobs that have used every attempt become
 * `dead`. Returns the affected jobs (the runtime raises Needs-you `failure` for the dead ones).
 */
export function requeueExpiredAgentJobs(db: Db, now: ISODateTime): AgentJob[] {
  const dead = db.all<RawJobRow>(sql`
    UPDATE agent_jobs SET status = 'dead', error = coalesce(error, 'lease expired after the last attempt'), lease_owner = NULL, lease_until = NULL,
      finished_at = ${now}, updated_at = ${now}
    WHERE status = 'leased' AND lease_until < ${now} AND attempts >= max_attempts
    RETURNING *`);
  const requeued = db.all<RawJobRow>(sql`
    UPDATE agent_jobs SET status = 'queued', lease_owner = NULL, lease_until = NULL, updated_at = ${now}
    WHERE status = 'leased' AND lease_until < ${now}
    RETURNING *`);
  return [...dead, ...requeued].map(fromRaw);
}

/** Cancel a job that has not finished (terminal jobs are returned unchanged). */
export function cancelAgentJob(db: Db, id: string, input: { reason?: string; now?: ISODateTime } = {}): AgentJob {
  const job = requireAgentJob(db, id);
  if (TERMINAL.has(job.status)) return job;
  const now = input.now ?? nowIso();
  return update(db, id, { status: 'cancelled', error: input.reason ?? null, finishedAt: now, updatedAt: now, ...clearLease });
}

export interface ListAgentJobsFilter {
  status?: JobStatus | readonly JobStatus[];
  lane?: Lane;
  type?: JobType | readonly JobType[];
  agent?: AgentName | 'system';
  claimId?: string;
  correlationId?: string;
  parentJobId?: string;
  limit?: number;
  offset?: number;
}

function jobWhere(filter: ListAgentJobsFilter): SQL | undefined {
  const where: SQL[] = [];
  const many = <T extends string>(v: T | readonly T[] | undefined): T[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? [...(v as T[])] : [v as T]);
  const statuses = many(filter.status);
  if (statuses?.length) where.push(inArray(agentJobs.status, statuses));
  const types = many(filter.type);
  if (types?.length) where.push(inArray(agentJobs.type, types));
  if (filter.lane) where.push(eq(agentJobs.lane, filter.lane));
  if (filter.agent) where.push(eq(agentJobs.agent, filter.agent));
  if (filter.claimId) where.push(eq(agentJobs.claimId, filter.claimId));
  if (filter.correlationId) where.push(eq(agentJobs.correlationId, filter.correlationId));
  if (filter.parentJobId) where.push(eq(agentJobs.parentJobId, filter.parentJobId));
  return where.length ? and(...where) : undefined;
}

/** Newest first. */
export function listAgentJobs(db: Db, filter: ListAgentJobsFilter = {}): AgentJob[] {
  return db
    .select()
    .from(agentJobs)
    .where(jobWhere(filter))
    .orderBy(desc(agentJobs.createdAt), desc(sql`rowid`))
    .limit(Math.max(1, Math.min(filter.limit ?? 100, 1000)))
    .offset(filter.offset ?? 0)
    .all()
    .map(toJob);
}

export function countAgentJobs(db: Db, filter: ListAgentJobsFilter = {}): number {
  const r = db.select({ n: sql<number>`count(*)` }).from(agentJobs).where(jobWhere(filter)).get();
  return Number(r?.n ?? 0);
}

export interface AppendAgentJobAttemptInput {
  jobId: string;
  attempt: number;
  startedAt: ISODateTime;
  finishedAt?: ISODateTime;
  outcome: string;
  error?: string;
  runId?: string;
}

/** Append-only attempt record (written once, when the attempt ends). */
export function appendAgentJobAttempt(db: Db, input: AppendAgentJobAttemptInput): AgentJobAttempt {
  const row = {
    id: randomUUID(),
    jobId: input.jobId,
    attempt: input.attempt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? null,
    outcome: input.outcome,
    error: input.error ?? null,
    runId: input.runId ?? null,
  };
  db.insert(agentJobAttempts).values(row).run();
  return denull(row) as AgentJobAttempt;
}

export function listAgentJobAttempts(db: Db, jobId: string): AgentJobAttempt[] {
  return db
    .select()
    .from(agentJobAttempts)
    .where(eq(agentJobAttempts.jobId, jobId))
    .orderBy(agentJobAttempts.attempt, agentJobAttempts.startedAt)
    .all()
    .map((r: AgentJobAttemptRow) => denull(r) as AgentJobAttempt);
}
