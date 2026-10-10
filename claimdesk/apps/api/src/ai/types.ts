/**
 * AI gateway interfaces (docs/SUPREME-DESIGN.md §A.1) — created by `foundation`, verbatim from the design. The drivers
 * (subscription CLI, API key, fake) live beside this file and are owned by `gateway`; `runAgent()` is their only caller.
 */
import type { AgentName, JobType, JsonSchema, ResultSchemaId, ToolName } from '@ccguk/domain';

export type { AgentName, JobType, JsonSchema, ResultSchemaId, ToolName };

export type DriverKind = 'subscription_cli' | 'api_key' | 'fake';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelId = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-4-5' | (string & {});

export interface PromptBlock { id: string; text: string; /** stable across runs → cacheable prefix */ stable: boolean }
export interface AiAttachment { kind: 'pdf' | 'image' | 'text'; path: string; mime: string; sha256: string; label: string; bytes: number }

/**
 * Knowledge Builder web research (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.8, KR-8): only `knowledge.research_web`, only when
 * the owner switched it on (runAgent refuses it otherwise). knowledge-research implements it in the drivers.
 */
export interface WebResearchPolicy { fetchDomains: string[]; denyDomains: string[]; maxFetches: number; allowSearch: boolean /* API driver only */ }

export interface AiRunRequest {
  runId: string; jobId: string; agent: AgentName; jobType: JobType; claimId?: string;
  model: ModelId; effort: Effort; maxTurns: number; timeoutMs: number;
  system: PromptBlock[];            // ordered: stable blocks first (identity, perimeter, contract, role, pack digest)
  user: string;                     // task + Case Brief + <untrusted …> blocks (§K.1)
  attachments: AiAttachment[];      // verified copies inside runDir/input (never the evidence store itself)
  tools: ToolName[];                // allowed subset of the registry; [] = no tools at all
  allowRead: boolean;               // CLI only: expose the built-in Read tool (attachments, evidence_read copies in runDir/input)
  resultSchema: JsonSchema;         // strict-compatible JSON Schema (§B.5)
  resultSchemaId: ResultSchemaId;
  runDir: string;                   // empty per-run directory under <home>\agent-runs\<runId>
  promptVersion: string;            // sha256 of the assembled stable blocks + schema id
  web?: WebResearchPolicy;          // knowledge.research_web only (KB §7.8); absent = no web tools
}

export interface RateLimitSnapshot {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  type?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage' | string;
  utilization?: number;             // normalised 0..1
  resetsAt?: string;                // ISO
}
export interface AiUsage {
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  costUsd?: number; durationMs: number; numTurns: number; rateLimit?: RateLimitSnapshot;
}

export type AiRunOutcome =
  | { kind: 'ok'; result: unknown; usage: AiUsage; model: string; stopReason?: string }
  | { kind: 'usage_limited'; resetsAt?: string; limitType?: string; usage?: AiUsage }
  | { kind: 'auth_failed'; message: string }
  | { kind: 'refused'; category?: string; explanation?: string; usage?: AiUsage }
  | { kind: 'invalid_output'; raw: string; errors: string[]; usage?: AiUsage }
  | { kind: 'timeout'; usage?: AiUsage }
  | { kind: 'error'; retryable: boolean; message: string; code?: string; usage?: AiUsage };

export interface ToolCallResult { ok: boolean; content: string; /** for the API driver: image/document blocks to return */ blocks?: unknown[]; needsYouId?: string }
export interface ToolExecutor { call(name: ToolName, input: unknown): Promise<ToolCallResult> }

export interface DriverHealth {
  kind: DriverKind; ready: boolean; problems: string[];
  cli?: { path?: string; version?: string; authMethod?: string; loggedIn?: boolean; minVersionOk: boolean };
  apiKeyPresent?: boolean;
}

export interface AiDriver {
  readonly kind: DriverKind;
  /** No model call: CLI → `claude --version` + `claude auth status`; API → key present (+ models.retrieve metadata). */
  health(): Promise<DriverHealth>;
  run(req: AiRunRequest, tools: ToolExecutor, signal: AbortSignal): Promise<AiRunOutcome>;
}
