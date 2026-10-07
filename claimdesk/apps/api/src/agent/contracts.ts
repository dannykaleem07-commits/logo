/**
 * Agent contracts shared by every Supreme slice (docs/SUPREME-DESIGN.md §A.1, §B.3, §C.1, §C.3, §C.7) — owned by
 * `foundation`. Wave 2 codes against these; change them only through the design document.
 *
 * Additions beyond the design text (additive, documented): `ToolDef.httpRoute` (the Fastify route pattern an HTTP tool
 * calls — the perimeter's route allow-list is built from it), `AgentInput` / `AgentRunResult` (the `runAgent`
 * signature), and `PayloadSchema` (handler payloads accept a zod v3 or `zod/v4` schema).
 */
import type { ZodType as ZodV4Type } from 'zod/v4';
import type { Actor, NeedsYouRecord } from '@ccguk/db';
import type {
  ActionClass,
  AgentName,
  Basis,
  ISODateTime,
  JobStatus,
  JobType,
  JsonSchema,
  Lane,
  NeedsYouKind,
  NeedsYouOption,
  NeedsYouPriority,
  Recommendation,
  ResultSchemaId,
  ToolName,
  ActionDescriptor,
  Decision,
} from '@ccguk/domain';
import type { AppContext, Logger } from '../context.js';
import type { AiAttachment, AiRunOutcome, Effort, ModelId } from '../ai/types.js';

export type { ActionClass, AgentName, Basis, JobStatus, JobType, JsonSchema, Lane, NeedsYouKind, NeedsYouOption, Recommendation, ResultSchemaId, ToolName, ActionDescriptor, Decision, ISODateTime };

// ---------------------------------------------------------------------------
// Queue (§C.3)
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  type: JobType; payload: unknown; claimId?: string; priority?: number; runAfter?: ISODateTime;
  idempotencyKey?: string; parentJobId?: string; correlationId?: string; maxAttempts?: number; createdBy: string;
}
export interface JobRecord extends Required<Pick<EnqueueInput, 'type' | 'payload' | 'createdBy'>> {
  id: string; agent: AgentName | 'system'; claimId?: string; status: JobStatus; lane: Lane; mutates: boolean;
  priority: number; runAfter: ISODateTime; attempts: number; maxAttempts: number; leaseOwner?: string; leaseUntil?: ISODateTime;
  idempotencyKey?: string; parentJobId?: string; correlationId: string; depth: number;
  result?: unknown; error?: string; needsYouId?: string; createdAt: ISODateTime; updatedAt: ISODateTime; finishedAt?: ISODateTime;
}
export type JobOutcome<R = unknown> =
  | { kind: 'done'; result: R; followUps?: EnqueueInput[] }
  | { kind: 'retry'; afterMs: number; reason: string }
  | { kind: 'wait_usage'; until: ISODateTime }              // does not consume an attempt
  | { kind: 'wait_user'; needsYouId: string }               // resumed by the Needs-you resolver
  | { kind: 'fail'; reason: string; deadLetter?: boolean };

/** Any zod schema (v3 `zod` or `zod/v4`) — both satisfy this structurally. */
export interface PayloadSchema<P> {
  parse(data: unknown): P;
  safeParse(data: unknown): { success: boolean; data?: P; error?: unknown };
}

export interface JobContext<P> { ctx: AppContext; job: JobRecord; payload: P; signal: AbortSignal; log: Logger }
export interface JobHandler<P = unknown, R = unknown> {
  type: JobType; agent: AgentName | 'system'; lane: Lane; usesAi: boolean; mutatesClaim: boolean;
  payload: PayloadSchema<P>; defaultPriority: number; maxAttempts: number; timeoutMs: number;
  run(jc: JobContext<P>): Promise<JobOutcome<R>>;
}

// ---------------------------------------------------------------------------
// Tools (§B.3)
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT';

export interface RunContext { runId: string; jobId: string; agent: AgentName; claimScope?: string; token: string;
  allowedTools: ReadonlySet<ToolName>; runDir: string; correlationId: string }

export interface ToolDef<I = unknown, O = unknown> {
  name: ToolName;                       // snake_case; appears to the CLI as mcp__claimdesk__<name>
  title: string; description: string;   // description says when to use it and what it never does
  class: ActionClass;
  input: ZodV4Type<I>;                  // written with `zod/v4` (strictObject; nullable instead of optional)
  strictSchema: JsonSchema;             // z.toJSONSchema(input) → toStrictSchema() (strips unsupported keywords)
  /** How the call executes: an HTTP call into an existing route as the agent, or an in-process function. */
  http?: (input: I, rc: RunContext) => { method: HttpMethod; url: string; body?: unknown };
  /**
   * Required with `http`: the route pattern `http()` calls, relative to `/api` (e.g. `{ method: 'POST', pattern:
   * '/claims/:id/events' }`). The perimeter's route allow-list (§B.2 rule 1) is built from these; an HTTP tool without
   * it is refused. `http().url` is relative to `/api` as well.
   */
  httpRoute?: { method: HttpMethod; pattern: string } | Array<{ method: HttpMethod; pattern: string }>;
  run?: (input: I, rc: RunContext, ctx: AppContext) => Promise<O>;
  /** What the autonomy policy sees (§D.2). */
  describe: (input: I, rc: RunContext, ctx: AppContext) => ActionDescriptor;
  /** When the policy says 'ask': build the Needs-you item with the prepared payload instead of acting. */
  onAsk?: (input: I, rc: RunContext, ctx: AppContext, d: Decision) => NeedsYouInput;
  shape?: (raw: unknown) => O;          // trim to the model-relevant fields
  maxOutputChars: number;               // default 20,000; lists paginate with limit/offset
}

export const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Needs-you (§C.7)
// ---------------------------------------------------------------------------

export interface NeedsYouInput {
  kind: NeedsYouKind; claimId?: string; title: string; summary: string; recommendation?: Recommendation;
  options?: NeedsYouOption[]; payload: unknown; priority: NeedsYouPriority; dueAt?: ISODateTime;
  createdBy: string; dedupeKey?: string; correlationId?: string; resumesJobId?: string;
}
/** A stored Needs-you item (the `needs_you` row, JSON parsed). */
export type NeedsYouItem = NeedsYouRecord;
export interface NeedsYouResolver<P = unknown> {
  kind: NeedsYouKind;
  /** Runs as the signed-in OWNER (request.actor), so human-only checks pass and audit shows the owner. */
  resolve(ctx: AppContext, item: NeedsYouItem & { payload: P }, choice: { optionId: string; edits?: unknown; note?: string }, actor: Actor): Promise<void>;
}

// ---------------------------------------------------------------------------
// Agents (§C.1) and runAgent (§A.1)
// ---------------------------------------------------------------------------

export interface AgentSpec {
  name: AgentName; jobType: JobType; title: string;
  promptFiles: string[];                // relative to apps/api/src/agent/prompts (§O)
  tools: ToolName[]; allowRead: boolean; // allowRead → CLI `--tools Read` for attachments
  resultSchemaId: ResultSchemaId;       // @ccguk/domain agents/results.ts
  defaults: { model: ModelId; effort: Effort; maxTurns: number; timeoutMs: number };
}

/** What a job handler hands `runAgent` (the user-message parts; the gateway assembles the prompt, §O). */
export interface AgentInput {
  /** The task header ("Triage this email", "Review claim CCG-… after an inbound message"). */
  task: string;
  /** Case Brief (§E.2) or other structured context, serialised by the gateway. */
  brief?: unknown;
  /** Untrusted content, wrapped in <untrusted_* id=…> blocks with delimiters escaped (§K.1). */
  untrusted?: Array<{ kind: 'email' | 'document' | 'transcript' | 'note'; id: string; text: string }>;
  /** Files copied (verified) into runDir/input. */
  attachments?: AiAttachment[];
  /** The job's question / instructions after the context. */
  question?: string;
  /** Per-call overrides of the spec defaults (model, effort, …). */
  overrides?: Partial<AgentSpec['defaults']>;
}

export interface AgentRunResult<R = unknown> {
  runId: string;
  outcome: AiRunOutcome;
  /** The validated result when `outcome.kind === 'ok'`. */
  result?: R;
}
