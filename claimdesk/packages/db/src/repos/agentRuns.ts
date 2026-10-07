/**
 * Agent runs and their tool calls (docs/SUPREME-DESIGN.md §A.1 runAgent, §B.3 step 7). `agent_tool_calls` is
 * append-only; `agent_runs` is written at start and finished once.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import type { AgentName, ISODateTime, JobType } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError } from '../errors.js';
import { agentRuns, agentToolCalls, type AgentRunOutcome, type AgentRunRow, type AgentToolCallRow, type ToolCallDecision } from '../schema.js';
import { denull, nowIso } from '../util.js';

export interface AgentRun {
  id: string;
  jobId: string;
  agent: AgentName;
  jobType: JobType;
  claimId?: string;
  driver: string;
  model: string;
  effort: string;
  promptVersion: string;
  inputSha256: string;
  startedAt: ISODateTime;
  endedAt?: ISODateTime;
  outcome?: AgentRunOutcome;
  numTurns?: number;
  toolCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  rateLimit?: unknown;
  result?: unknown;
  error?: string;
}

export interface AgentToolCall {
  id: string;
  runId: string;
  seq: number;
  tool: string;
  actionClass: string;
  decision: ToolCallDecision;
  ruleIds?: string[];
  inputRedacted?: unknown;
  outputSummary?: string;
  httpStatus?: number;
  needsYouId?: string;
  durationMs?: number;
  at: ISODateTime;
}

const toRun = (r: AgentRunRow): AgentRun => denull(r) as AgentRun;
const toCall = (r: AgentToolCallRow): AgentToolCall => denull(r) as AgentToolCall;

export interface StartAgentRunInput {
  id?: string;
  jobId: string;
  agent: AgentName;
  jobType: JobType;
  claimId?: string;
  driver: string;
  model: string;
  effort: string;
  promptVersion: string;
  inputSha256: string;
  startedAt?: ISODateTime;
}

export function startAgentRun(db: Db, input: StartAgentRunInput): AgentRun {
  const row = {
    id: input.id ?? randomUUID(),
    jobId: input.jobId,
    agent: input.agent,
    jobType: input.jobType,
    claimId: input.claimId ?? null,
    driver: input.driver,
    model: input.model,
    effort: input.effort,
    promptVersion: input.promptVersion,
    inputSha256: input.inputSha256,
    startedAt: input.startedAt ?? nowIso(),
    toolCalls: 0,
  };
  return toRun(db.insert(agentRuns).values(row).returning().get());
}

export interface FinishAgentRunInput {
  outcome: AgentRunOutcome;
  endedAt?: ISODateTime;
  model?: string;
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  rateLimit?: unknown;
  result?: unknown;
  error?: string;
}

export function finishAgentRun(db: Db, id: string, input: FinishAgentRunInput): AgentRun {
  const rows = db
    .update(agentRuns)
    .set({
      outcome: input.outcome,
      endedAt: input.endedAt ?? nowIso(),
      ...(input.model !== undefined ? { model: input.model } : {}),
      numTurns: input.numTurns ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cacheReadTokens: input.cacheReadTokens ?? null,
      cacheWriteTokens: input.cacheWriteTokens ?? null,
      costUsd: input.costUsd ?? null,
      rateLimit: input.rateLimit ?? null,
      result: input.result ?? null,
      error: input.error ?? null,
    })
    .where(eq(agentRuns.id, id))
    .returning()
    .all();
  if (!rows[0]) throw new NotFoundError('agent_runs', id);
  return toRun(rows[0]);
}

export function getAgentRun(db: Db, id: string): AgentRun | undefined {
  const r = db.select().from(agentRuns).where(eq(agentRuns.id, id)).get();
  return r ? toRun(r) : undefined;
}

export interface ListAgentRunsFilter {
  agent?: AgentName;
  claimId?: string;
  jobId?: string;
  jobType?: JobType;
  outcome?: AgentRunOutcome;
  since?: ISODateTime;
  limit?: number;
  offset?: number;
}

/** Newest first. */
export function listAgentRuns(db: Db, filter: ListAgentRunsFilter = {}): AgentRun[] {
  const where: SQL[] = [];
  if (filter.agent) where.push(eq(agentRuns.agent, filter.agent));
  if (filter.claimId) where.push(eq(agentRuns.claimId, filter.claimId));
  if (filter.jobId) where.push(eq(agentRuns.jobId, filter.jobId));
  if (filter.jobType) where.push(eq(agentRuns.jobType, filter.jobType));
  if (filter.outcome) where.push(eq(agentRuns.outcome, filter.outcome));
  if (filter.since) where.push(gte(agentRuns.startedAt, filter.since));
  return db
    .select()
    .from(agentRuns)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(agentRuns.startedAt), desc(sql`rowid`))
    .limit(Math.max(1, Math.min(filter.limit ?? 100, 1000)))
    .offset(filter.offset ?? 0)
    .all()
    .map(toRun);
}

export interface AppendAgentToolCallInput {
  runId: string;
  /** Defaults to the next sequence number of the run. */
  seq?: number;
  tool: string;
  actionClass: string;
  decision: ToolCallDecision;
  ruleIds?: string[];
  inputRedacted?: unknown;
  outputSummary?: string;
  httpStatus?: number;
  needsYouId?: string;
  durationMs?: number;
  at?: ISODateTime;
}

/** Append a tool call (append-only) and bump the run's `tool_calls` counter. */
export function appendAgentToolCall(db: Db, input: AppendAgentToolCallInput): AgentToolCall {
  const seq =
    input.seq ??
    Number(db.select({ n: sql<number>`coalesce(max(${agentToolCalls.seq}), 0)` }).from(agentToolCalls).where(eq(agentToolCalls.runId, input.runId)).get()?.n ?? 0) + 1;
  const row = {
    id: randomUUID(),
    runId: input.runId,
    seq,
    tool: input.tool,
    actionClass: input.actionClass,
    decision: input.decision,
    ruleIds: input.ruleIds ?? null,
    inputRedacted: input.inputRedacted ?? null,
    outputSummary: input.outputSummary ?? null,
    httpStatus: input.httpStatus ?? null,
    needsYouId: input.needsYouId ?? null,
    durationMs: input.durationMs ?? null,
    at: input.at ?? nowIso(),
  };
  const inserted = db.insert(agentToolCalls).values(row).returning().get();
  db.update(agentRuns).set({ toolCalls: sql`${agentRuns.toolCalls} + 1` }).where(eq(agentRuns.id, input.runId)).run();
  return toCall(inserted);
}

export function listAgentToolCalls(db: Db, runId: string): AgentToolCall[] {
  return db.select().from(agentToolCalls).where(eq(agentToolCalls.runId, runId)).orderBy(agentToolCalls.seq).all().map(toCall);
}
