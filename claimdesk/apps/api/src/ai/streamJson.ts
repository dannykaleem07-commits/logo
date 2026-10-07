/**
 * Claude Code `--output-format stream-json --verbose` parser (docs/SUPREME-DESIGN.md §A.2) — owned by `gateway`.
 *
 * Line-delimited JSON events:
 *  - `system`/`init`        → when tools were requested, the MCP server `claimdesk` must be `connected` (else fail fast,
 *                             retryable);
 *  - `rate_limit_event`     → a normalised `RateLimitSnapshot` (utilisation 0..1, `resetsAt` ISO), pushed immediately;
 *  - `assistant` / `user`   → counted; API-error messages (synthetic assistant turns, `error` fields) feed classification;
 *  - final `result`         → `success` + `structured_output` → ok; `error_max_turns` → error (not retryable);
 *                             `error_max_structured_output_retries` → invalid_output; `error_during_execution` and any
 *                             `is_error` result → classified (usage limit / auth / typed error / retryable).
 * A process that exits without a result is a retryable error. The last 200 lines are kept (redacted by the caller).
 */
import type { AiRunOutcome, AiUsage, RateLimitSnapshot } from './types.js';
import { classifyFailure, toIso, type FailureSignals } from './usageLimits.js';

export const MCP_SERVER_NAME = 'claimdesk';
export const KEEP_LINES = 200;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Normalise a CLI `rate_limit_event` (or a bare `rate_limit_info` object) into a RateLimitSnapshot. */
export function normaliseRateLimit(raw: unknown): RateLimitSnapshot | undefined {
  const e = obj(raw);
  const info = obj(e.rate_limit_info ?? e.rateLimitInfo ?? e);
  const statusRaw = String(info.status ?? '').toLowerCase();
  const status: RateLimitSnapshot['status'] | undefined =
    statusRaw === 'rejected' ? 'rejected' : statusRaw === 'allowed_warning' || statusRaw === 'warning' ? 'allowed_warning' : statusRaw === 'allowed' ? 'allowed' : undefined;
  if (!status) return undefined;
  const snap: RateLimitSnapshot = { status };
  const type = info.rateLimitType ?? info.rate_limit_type ?? info.type;
  if (typeof type === 'string' && type) snap.type = type;
  const u = info.utilization ?? info.utilisation;
  if (typeof u === 'number' && Number.isFinite(u)) snap.utilization = Math.max(0, Math.min(1, u > 1 ? u / 100 : u));
  const resets = toIso(info.resetsAt ?? info.resets_at);
  if (resets) snap.resetsAt = resets;
  return snap;
}

export interface StreamJsonOptions {
  /** Tools were requested: the init event must show the `claimdesk` MCP server connected. */
  requireMcp: boolean;
  /** Called for every rate-limit snapshot as it arrives (the driver writes ai_usage_state). */
  onRateLimit?: (s: RateLimitSnapshot) => void;
  /** Called once when the init event shows the MCP server is not connected (the driver kills the process). */
  onFatal?: (reason: string) => void;
}

export class StreamJsonParser {
  private buffer = '';
  readonly lines: string[] = [];
  private result: Record<string, unknown> | undefined;
  private errorTexts: string[] = [];
  private apiError: string | undefined;
  private apiErrorParams: unknown;
  private status: number | undefined;
  private lastRateLimit: RateLimitSnapshot | undefined;
  private rejected: RateLimitSnapshot | undefined;
  private model: string | undefined;
  private assistantTurns = 0;
  fatal: string | undefined;
  initSeen = false;

  constructor(private readonly opts: StreamJsonOptions) {}

  /** Feed raw stdout text (any chunking). */
  push(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, '');
      this.buffer = this.buffer.slice(i + 1);
      this.line(line);
    }
  }

  /** Flush a trailing partial line. */
  end(): void {
    if (this.buffer.trim()) this.line(this.buffer);
    this.buffer = '';
  }

  private keep(line: string): void {
    this.lines.push(line.length > 4000 ? `${line.slice(0, 4000)}…` : line);
    if (this.lines.length > KEEP_LINES) this.lines.shift();
  }

  line(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.keep(trimmed);
    let ev: Record<string, unknown>;
    try {
      ev = obj(JSON.parse(trimmed));
    } catch {
      return; // not JSON (a stray log line): kept for the record only
    }
    const type = ev.type;
    if (type === 'system' && ev.subtype === 'init') {
      this.initSeen = true;
      if (typeof ev.model === 'string') this.model = ev.model;
      if (this.opts.requireMcp) {
        const servers = Array.isArray(ev.mcp_servers) ? (ev.mcp_servers as unknown[]).map(obj) : [];
        const ours = servers.find((s) => s.name === MCP_SERVER_NAME);
        if (!ours || ours.status !== 'connected') this.setFatal(`MCP server ${MCP_SERVER_NAME} is ${ours ? String(ours.status) : 'missing'} (expected connected)`);
      }
      return;
    }
    if (type === 'rate_limit_event') {
      const snap = normaliseRateLimit(ev);
      if (snap) {
        this.lastRateLimit = snap;
        if (snap.status === 'rejected') this.rejected = snap;
        this.opts.onRateLimit?.(snap);
      }
      return;
    }
    if (type === 'assistant') {
      this.assistantTurns += 1;
      const message = obj(ev.message);
      if (typeof message.model === 'string' && message.model !== '<synthetic>') this.model = message.model;
      const isApiError = ev.error !== undefined || ev.isApiErrorMessage === true || message.model === '<synthetic>';
      if (isApiError) {
        if (typeof ev.error === 'string') this.errorTexts.push(ev.error);
        const content = Array.isArray(message.content) ? (message.content as unknown[]).map(obj) : [];
        for (const c of content) if (c.type === 'text' && typeof c.text === 'string') this.errorTexts.push(c.text);
      }
      this.takeTypedError(ev);
      return;
    }
    if (type === 'result') {
      this.result = ev;
      this.takeTypedError(ev);
      return;
    }
  }

  private takeTypedError(ev: Record<string, unknown>): void {
    if (typeof ev.api_error === 'string') this.apiError = ev.api_error;
    if (ev.api_error_params !== undefined) this.apiErrorParams = ev.api_error_params;
    const status = ev.api_error_status ?? ev.status;
    if (typeof status === 'number') this.status = status;
  }

  private setFatal(reason: string): void {
    if (this.fatal) return;
    this.fatal = reason;
    this.opts.onFatal?.(reason);
  }

  /** Usage so far (from the result event when present). */
  usage(durationMs: number): AiUsage {
    const r = this.result ?? {};
    const u = obj(r.usage);
    const usage: AiUsage = {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cacheReadTokens: num(u.cache_read_input_tokens),
      cacheWriteTokens: num(u.cache_creation_input_tokens),
      durationMs: num(r.duration_ms) || durationMs,
      numTurns: num(r.num_turns) || this.assistantTurns,
    };
    if (typeof r.total_cost_usd === 'number') usage.costUsd = r.total_cost_usd;
    if (this.lastRateLimit) usage.rateLimit = this.lastRateLimit;
    return usage;
  }

  modelUsed(fallback: string): string {
    const mu = obj(this.result?.modelUsage);
    const first = Object.keys(mu)[0];
    return this.model ?? first ?? fallback;
  }

  private signals(extraTexts: string[] = []): FailureSignals {
    const r = this.result ?? {};
    const texts = [...this.errorTexts, ...extraTexts];
    if (typeof r.result === 'string' && (r.is_error === true || r.subtype !== 'success')) texts.push(r.result);
    if (Array.isArray(r.errors)) for (const e of r.errors) texts.push(typeof e === 'string' ? e : JSON.stringify(e));
    const s: FailureSignals = { texts };
    if (this.apiError) s.apiError = this.apiError;
    if (this.apiErrorParams !== undefined) s.apiErrorParams = this.apiErrorParams;
    if (this.status !== undefined) s.status = this.status;
    const rl = this.rejected ?? this.lastRateLimit;
    if (rl) s.rateLimit = rl;
    return s;
  }

  /**
   * The outcome once the process has exited. `stderr` is used for classification only when there was no usable
   * result; `timedOut` wins over everything.
   */
  outcome(input: { model: string; durationMs: number; exitCode: number | null; stderr: string; timedOut: boolean }): AiRunOutcome {
    const usage = this.usage(input.durationMs);
    if (input.timedOut) return { kind: 'timeout', usage };
    if (this.fatal) return { kind: 'error', retryable: true, code: 'MCP_NOT_CONNECTED', message: this.fatal, usage };
    const r = this.result;
    // A rejected rate-limit event means the window is closed even if the result looks like a generic error.
    if (this.rejected) {
      const c = classifyFailure(this.signals());
      if (c?.kind === 'usage_limited') return { kind: 'usage_limited', ...(c.resetsAt ? { resetsAt: c.resetsAt } : {}), ...(c.limitType ? { limitType: c.limitType } : {}), usage };
    }
    if (!r) {
      const c = classifyFailure(this.signals(input.stderr ? [input.stderr] : []));
      if (c) return this.fromClassification(c, usage);
      return { kind: 'error', retryable: true, code: 'NO_RESULT', message: `Claude Code exited (code ${input.exitCode ?? 'null'}) without a result`, usage };
    }
    const subtype = String(r.subtype ?? '');
    if (subtype === 'success' && r.is_error !== true) {
      if (r.structured_output !== undefined && r.structured_output !== null) return { kind: 'ok', result: r.structured_output, usage, model: this.modelUsed(input.model), ...(typeof r.stop_reason === 'string' ? { stopReason: r.stop_reason } : {}) };
      const raw = typeof r.result === 'string' ? r.result : '';
      return { kind: 'invalid_output', raw: raw.slice(0, 4000), errors: ['the result carried no structured_output'], usage };
    }
    if (subtype === 'error_max_turns') return { kind: 'error', retryable: false, code: 'max_turns', message: 'The run reached its maximum number of turns', usage };
    if (subtype === 'error_max_structured_output_retries') {
      return { kind: 'invalid_output', raw: typeof r.result === 'string' ? r.result.slice(0, 4000) : '', errors: ['the model could not produce output matching the schema'], usage };
    }
    const c = classifyFailure(this.signals());
    if (c) return this.fromClassification(c, usage);
    const message = typeof r.result === 'string' && r.result ? r.result.slice(0, 500) : `Claude Code run failed (${subtype || 'error'})`;
    return { kind: 'error', retryable: true, code: subtype || 'error', message, usage };
  }

  private fromClassification(c: NonNullable<ReturnType<typeof classifyFailure>>, usage: AiUsage): AiRunOutcome {
    if (c.kind === 'usage_limited') return { kind: 'usage_limited', ...(c.resetsAt ? { resetsAt: c.resetsAt } : {}), ...(c.limitType ? { limitType: c.limitType } : {}), usage };
    if (c.kind === 'auth_failed') return { kind: 'auth_failed', message: c.message };
    return { kind: 'error', retryable: c.retryable, code: c.code, message: c.message, usage };
  }
}
