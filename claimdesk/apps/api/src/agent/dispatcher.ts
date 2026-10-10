// owned by gateway
/**
 * executeTool (docs/SUPREME-DESIGN.md §B.3) — the one door every agent action goes through:
 *   1 registered and in `rc.allowedTools`, else denied;
 *   2 `input.safeParse` (the model's input is untrusted even with strict tools) → is_error with the zod issues;
 *   3 claim scope (an input `claimId` naming another claim → denied);
 *   4 `decide(def.describe(...), settings, state)` (§D) — audited as `agent.policy` for every non-read action;
 *   5 deny → error result; ask → `createNeedsYou(def.onAsk(...))` and `{status:"awaiting_owner",needsYouId}` (a tool
 *     without onAsk tells the model to explain with `needs_you_create`); auto / auto_held → execute (the hold is the
 *     outbox's job);
 *   6 HTTP tools run through `ctx.inject` with `Authorization: Bearer <run token>`, so onRequest, the perimeter and the
 *     route all run; non-2xx → is_error with the route's {code,message} (a refusal carrying `error.override` raises
 *     Needs-you `override_needed` — agents never override);
 *   7 `agent_tool_calls` row (input masked, output summary, decision, status, duration);
 *   8 `shape` + truncate to `maxOutputChars` with `"truncated": true` and a hint to paginate.
 *
 * Gateway extensions (optional fields on gateway tools; other slices' tools never need them): `shapeWith` (shape with
 * the input and run context), `afterHttp` (follow-ups after a successful route call), `dailyLimit` (successful calls per
 * London day), and `withBlocks()` (image/document blocks for the API driver).
 */
import { decide, type Decision } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { ToolCallResult, ToolExecutor } from '../ai/types.js';
import type { HttpMethod, NeedsYouInput, RunContext, ToolDef, ToolName } from './contracts.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from './contracts.js';
import { autonomyState, createNeedsYou, getAutonomy, londonDayStart } from './core.js';
import { agentUserId } from './principal.js';
import { getTool } from './tools/index.js';
import { maskPii } from './tools/core.js';

// ---------------------------------------------------------------------------
// Gateway tool extensions
// ---------------------------------------------------------------------------

export interface GatewayToolExtras<I = unknown> {
  /** Shape with access to the input and the run (pagination, claim-scope narrowing). Wins over `shape`. */
  shapeWith?: (raw: unknown, input: I, rc: RunContext) => unknown;
  /** After a 2xx route call: follow-ups (Needs-you, jobs). The returned fields are merged into the tool output. */
  afterHttp?: (input: I, body: unknown, rc: RunContext, ctx: AppContext) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;
  /** Successful calls allowed per London day across all runs (e.g. vehicle_lookup 20/day). */
  dailyLimit?: number;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export type GatewayToolDef<I = any, O = any> = ToolDef<I, O> & GatewayToolExtras<I>;

const BLOCKS = Symbol.for('claimdesk.tool.blocks');

/** Attach image/document content blocks (API driver) to a run-tool output. */
export function withBlocks<T extends object>(value: T, blocks: unknown[]): T {
  Object.defineProperty(value, BLOCKS, { value: blocks, enumerable: false });
  return value;
}
function blocksOf(value: unknown): unknown[] | undefined {
  return value && typeof value === 'object' ? ((value as Record<symbol, unknown>)[BLOCKS] as unknown[] | undefined) : undefined;
}

// ---------------------------------------------------------------------------
// Active runs (the MCP endpoint resolves a run token's principal to its RunContext)
// ---------------------------------------------------------------------------

const activeRuns = new Map<string, RunContext>();
export function registerRun(rc: RunContext): void {
  activeRuns.set(rc.runId, rc);
}
export function unregisterRun(runId: string): void {
  activeRuns.delete(runId);
}
export function getRunContext(runId: string): RunContext | undefined {
  return activeRuns.get(runId);
}

/** A ToolExecutor for a run; carries the run token so the CLI driver can write mcp.json. */
export function executorFor(ctx: AppContext, rc: RunContext): ToolExecutor & { readonly runToken: string } {
  return { runToken: rc.token, call: (name, input) => executeTool(ctx, rc, name, input) };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export const TRUNCATION_HINT = 'Output was cut to fit; narrow the query or page with limit/offset.';

/** JSON text of `value`, cut to `max` characters with a `"truncated": true` marker when it does not fit. */
export function truncateOutput(value: unknown, max: number = DEFAULT_MAX_OUTPUT_CHARS): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (text.length <= max) return text;
  const wrapperBytes = JSON.stringify({ truncated: true, hint: TRUNCATION_HINT, partial: '' }).length;
  let room = Math.max(0, max - wrapperBytes - 16);
  let out = JSON.stringify({ truncated: true, hint: TRUNCATION_HINT, partial: text.slice(0, room) });
  // JSON escaping can grow the partial text: shrink until it fits.
  while (out.length > max && room > 0) {
    room = Math.max(0, room - Math.ceil((out.length - max) * 1.2) - 8);
    out = JSON.stringify({ truncated: true, hint: TRUNCATION_HINT, partial: text.slice(0, room) });
  }
  return out;
}

const errorResult = (code: string, message: string, extra: Record<string, unknown> = {}): ToolCallResult => ({ ok: false, content: JSON.stringify({ error: { code, message, ...extra } }) });

const summary = (s: string): string => (s.length > 500 ? `${s.slice(0, 500)}…` : s);

function queryString(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    const value = Array.isArray(v) ? v.join(',') : String(v);
    if (value === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}
export { queryString };

// ---------------------------------------------------------------------------
// executeTool
// ---------------------------------------------------------------------------

interface CallRecord {
  tool: string;
  actionClass: string;
  decision: 'allowed' | 'asked' | 'denied' | 'invalid' | 'error';
  ruleIds?: string[];
  input?: unknown;
  output?: string;
  httpStatus?: number;
  needsYouId?: string;
  started: number;
}

function record(ctx: AppContext, rc: RunContext, r: CallRecord): void {
  try {
    ctx.repos.appendAgentToolCall(ctx.db, {
      runId: rc.runId,
      tool: r.tool,
      actionClass: r.actionClass,
      decision: r.decision,
      ...(r.ruleIds?.length ? { ruleIds: r.ruleIds } : {}),
      ...(r.input !== undefined ? { inputRedacted: maskPii(r.input) } : {}),
      ...(r.output !== undefined ? { outputSummary: summary(r.output) } : {}),
      ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}),
      ...(r.needsYouId ? { needsYouId: r.needsYouId } : {}),
      durationMs: Date.now() - r.started,
      at: ctx.now(),
    });
  } catch (err) {
    ctx.logger.error('could not record an agent tool call', { error: String(err), runId: rc.runId, tool: r.tool });
  }
}

function auditPolicy(ctx: AppContext, rc: RunContext, tool: string, decision: Decision): void {
  try {
    ctx.repos.appendAudit(ctx.db, {
      actor: { userId: agentUserId(rc.agent), runId: rc.runId },
      action: 'agent.policy',
      entity: 'agent_runs',
      entityId: rc.runId,
      after: { tool, outcome: decision.outcome, ruleIds: decision.ruleIds, reasons: decision.reasons },
      at: ctx.now(),
    });
  } catch (err) {
    ctx.logger.error('could not audit a policy decision', { error: String(err) });
  }
}

/** Successful calls of `tool` since the start of today (London), across all runs. */
function callsToday(ctx: AppContext, tool: string): number {
  const row = ctx.handle.sqlite
    .prepare(`SELECT count(*) AS n FROM agent_tool_calls WHERE tool = ? AND decision = 'allowed' AND (http_status IS NULL OR http_status < 400) AND at >= ?`)
    .get(tool, londonDayStart(ctx.now())) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** Execute one tool call for a run (§B.3 steps 1–8). Never throws: failures are `ok: false` results. */
export async function executeTool(ctx: AppContext, rc: RunContext, name: ToolName, rawInput: unknown): Promise<ToolCallResult> {
  const started = Date.now();
  const def = getTool(name) as GatewayToolDef | undefined;

  // 1 registered and allowed
  if (!def || !rc.allowedTools.has(name)) {
    const res = errorResult('TOOL_NOT_ALLOWED', `Tool ${name} is not available in this run`);
    record(ctx, rc, { tool: name, actionClass: def?.class ?? 'unknown', decision: 'denied', input: rawInput, output: res.content, started });
    return res;
  }

  // 2 validate the (untrusted) input
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message }));
    const res = errorResult('INVALID_INPUT', `The input for ${name} is not valid; fix it and call again`, { issues });
    record(ctx, rc, { tool: name, actionClass: def.class, decision: 'invalid', input: rawInput, output: res.content, started });
    return res;
  }
  const input = parsed.data as Record<string, unknown>;

  // 3 claim scope
  if (rc.claimScope && typeof input?.claimId === 'string' && input.claimId !== rc.claimScope) {
    const res = errorResult('CLAIM_SCOPE', `This run is limited to claim ${rc.claimScope}; it cannot act on another claim`);
    record(ctx, rc, { tool: name, actionClass: def.class, decision: 'denied', ruleIds: ['claim_scope'], input, output: res.content, started });
    return res;
  }

  try {
    // 4 policy
    const descriptor = def.describe(input, rc, ctx);
    const claimId = descriptor.claimId ?? rc.claimScope;
    const decision = decide(descriptor, getAutonomy(ctx), autonomyState(ctx, { ...(claimId ? { claimId } : {}), agent: rc.agent }));
    if (descriptor.class !== 'read') auditPolicy(ctx, rc, name, decision);

    // 5 deny / ask
    if (decision.outcome === 'deny') {
      const res = errorResult('POLICY_DENIED', `Not allowed: ${decision.reasons.join('; ') || decision.ruleIds.join(', ')}`, { ruleIds: decision.ruleIds });
      record(ctx, rc, { tool: name, actionClass: def.class, decision: 'denied', ruleIds: decision.ruleIds, input, output: res.content, started });
      return res;
    }
    if (decision.outcome === 'ask') {
      if (!def.onAsk) {
        const res = errorResult('NEEDS_OWNER', `This action needs the owner (${decision.reasons.join('; ') || decision.ruleIds.join(', ')}). Do not retry it: explain the situation and what you recommend with needs_you_create.`, { ruleIds: decision.ruleIds });
        record(ctx, rc, { tool: name, actionClass: def.class, decision: 'asked', ruleIds: decision.ruleIds, input, output: res.content, started });
        return res;
      }
      const ny: NeedsYouInput = def.onAsk(input, rc, ctx, decision);
      const item = createNeedsYou(ctx, { ...ny, createdBy: ny.createdBy || agentUserId(rc.agent), correlationId: ny.correlationId ?? rc.correlationId, runId: ny.runId ?? rc.runId });
      const content = JSON.stringify({ status: 'awaiting_owner', needsYouId: item.id });
      record(ctx, rc, { tool: name, actionClass: def.class, decision: 'asked', ruleIds: decision.ruleIds, input, output: content, needsYouId: item.id, started });
      return { ok: true, content, needsYouId: item.id };
    }

    // daily limit (gateway extension)
    if (def.dailyLimit !== undefined && callsToday(ctx, name) >= def.dailyLimit) {
      const res = errorResult('DAILY_LIMIT', `${name} is limited to ${def.dailyLimit} calls a day; try again tomorrow or ask the owner`);
      record(ctx, rc, { tool: name, actionClass: def.class, decision: 'denied', ruleIds: ['daily_limit'], input, output: res.content, started });
      return res;
    }

    // 6 execute
    let raw: unknown;
    let httpStatus: number | undefined;
    if (def.http) {
      if (!ctx.inject) throw new Error('ctx.inject is not wired (buildApp sets it)');
      const call = (def.http as (i: unknown, r: RunContext, c: AppContext) => { method: HttpMethod; url: string; body?: unknown })(input, rc, ctx);
      const res = await ctx.inject({
        method: call.method,
        url: `/api${call.url.startsWith('/') ? '' : '/'}${call.url}`,
        headers: { authorization: `Bearer ${rc.token}`, ...(call.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(call.body !== undefined ? { payload: JSON.stringify(call.body) } : {}),
      });
      httpStatus = res.statusCode;
      let body: unknown;
      try {
        body = res.body ? JSON.parse(res.body) : undefined;
      } catch {
        body = res.body;
      }
      if (res.statusCode >= 400) {
        const err = ((body as { error?: Record<string, unknown> } | undefined)?.error ?? {}) as Record<string, unknown>;
        let needsYouId: string | undefined;
        if (err.override) {
          const label = String((err.override as Record<string, unknown>).label ?? err.message ?? 'a manager override');
          needsYouId = createNeedsYou(ctx, {
            kind: 'override_needed',
            ...(claimId ? { claimId } : {}),
            title: `A manager override is needed: ${label}`,
            summary: `The agent (${rc.agent}) tried ${name} and the route refused it with ${String(err.code ?? res.statusCode)}: ${String(err.message ?? '')}. Agents never override; decide whether to do this yourself.`,
            payload: { tool: name, input: maskPii(input), error: { code: err.code, message: err.message, override: err.override } },
            priority: 'normal',
            createdBy: agentUserId(rc.agent),
            correlationId: rc.correlationId,
            dedupeKey: `override_needed:${rc.runId}:${name}:${String(err.code ?? '')}`,
            runId: rc.runId,
          }).id;
        }
        const out = errorResult(String(err.code ?? `HTTP_${res.statusCode}`), String(err.message ?? `The route answered ${res.statusCode}`), {
          ...(err.details !== undefined ? { details: err.details } : {}),
          ...(needsYouId ? { needsYouId, note: 'A Needs-you item asks the owner about this.' } : {}),
        });
        record(ctx, rc, { tool: name, actionClass: def.class, decision: 'error', ruleIds: decision.ruleIds, input, output: out.content, httpStatus, ...(needsYouId ? { needsYouId } : {}), started });
        return needsYouId ? { ...out, needsYouId } : out;
      }
      raw = body;
      if (def.afterHttp) {
        const extra = await def.afterHttp(input, body, rc, ctx);
        if (extra && raw && typeof raw === 'object' && !Array.isArray(raw)) raw = { ...(raw as Record<string, unknown>), ...extra };
        else if (extra) raw = { result: raw, ...extra };
      }
    } else if (def.run) {
      raw = await def.run(input, rc, ctx);
    } else {
      throw new Error(`Tool ${name} has neither http nor run`);
    }

    // 8 shape + truncate
    const blocks = blocksOf(raw);
    const shaped = def.shapeWith ? def.shapeWith(raw, input, rc) : def.shape ? def.shape(raw) : raw;
    const content = truncateOutput(shaped, def.maxOutputChars || DEFAULT_MAX_OUTPUT_CHARS);
    // 7 record
    record(ctx, rc, { tool: name, actionClass: def.class, decision: 'allowed', ruleIds: decision.ruleIds, input, output: content, ...(httpStatus !== undefined ? { httpStatus } : {}), started });
    return { ok: true, content, ...(blocks?.length ? { blocks } : {}) };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const res = errorResult(typeof code === 'string' ? code : 'TOOL_FAILED', err instanceof Error ? err.message : String(err));
    record(ctx, rc, { tool: name, actionClass: def.class, decision: 'error', input, output: res.content, started });
    return res;
  }
}
