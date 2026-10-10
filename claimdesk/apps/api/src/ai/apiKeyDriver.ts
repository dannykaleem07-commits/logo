/**
 * ApiKeyDriver (docs/SUPREME-DESIGN.md §A.3) — owned by `gateway`. `@anthropic-ai/sdk` 0.131.0 with a manual agentic
 * loop (not the beta tool runner): the policy gate, `pause_turn`, refusals and usage accounting stay in our code.
 *
 *  - `client.beta.messages.create` with `tool_choice: auto` (forced any/tool is rejected on claude-opus-5-5), strict
 *    tools sorted by name (stable cache prefix), `output_config: { effort, format: json_schema }`, beta
 *    `server-side-fallback-2026-07-01` with `fallbacks: 'default'`, and **no `thinking` field** (adaptive thinking is
 *    always on for claude-opus-5-5); `cache_control: { type: 'ephemeral', ttl: '1h' }` on the last stable system block.
 *  - `refusal` → refused (stop_details); `pause_turn` → continue with the assistant content; `max_tokens` → one retry
 *    at 32,000, then invalid_output; `tool_use` → ToolExecutor (the dispatcher zod-validates; failures are `is_error`
 *    results), with image/document blocks from `ToolCallResult.blocks`.
 *  - `resultMode: 'submit_tool'` fallback: a strict `submit_result` tool whose input schema is the result schema (used
 *    when the API rejects tools + output_config.format with a 400 on the first request, or when configured).
 *  - Typed SDK errors only (never message string-matching).
 *
 * Real AI guard: the constructor throws REAL_AI_FORBIDDEN when `ctx.config.forbidRealAi`; under
 * CLAIMDESK_FORBID_REAL_AI=1 the driver refuses to run without an injected `fetch`.
 */
import { readFileSync } from 'node:fs';
import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, AuthenticationError, BadRequestError, PermissionDeniedError, RateLimitError } from '@anthropic-ai/sdk';
import type { AppContext } from '../context.js';
import { getTool } from '../agent/tools/index.js';
import type { AiAttachment, AiDriver, AiRunOutcome, AiRunRequest, AiUsage, DriverHealth, ToolExecutor } from './types.js';
import { RealAiForbiddenError } from './subscriptionCliDriver.js';
import { costUsd } from './pricing.js';

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const DEFAULT_MAX_TOKENS = 16_000;
export const RETRY_MAX_TOKENS = 32_000;
export const SUBMIT_RESULT_TOOL = 'submit_result';
export const SUBMIT_RESULT_INSTRUCTION = 'When you have finished, call the submit_result tool exactly once with your final result. Do not write the result as text.';

export type ResultMode = 'format' | 'submit_tool';

export interface ApiKeyDriverOptions {
  /** Injected fetch (tests: canned Messages responses, no network). */
  fetch?: typeof fetch;
  /** API key override (default: the secret store). */
  apiKey?: string;
  /** 'format' (default) or 'submit_tool'. */
  resultMode?: ResultMode;
  /** SDK base URL (tests). */
  baseURL?: string;
  /** SDK retries (default 2). */
  maxRetries?: number;
}

type Json = Record<string, unknown>;
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Base64 content blocks for the attachments (PDFs as documents, images as images, text as plain-text documents). */
export function attachmentBlocks(attachments: AiAttachment[]): Json[] {
  const out: Json[] = [];
  for (const a of attachments) {
    const data = readFileSync(a.path);
    if (a.kind === 'pdf') out.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') }, title: a.label });
    else if (a.kind === 'image' && IMAGE_MIME.has(a.mime)) out.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: data.toString('base64') } });
    else if (a.kind === 'text') out.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: data.toString('utf8') }, title: a.label });
    else out.push({ type: 'text', text: `[Attachment ${a.label} (${a.mime}) cannot be shown to the model in this format.]` });
  }
  return out;
}

/**
 * Knowledge Builder web research (KB §7.8): server tools for `req.web` only — `web_fetch` restricted with
 * `allowed_domains` (never also `blocked_domains`), and `web_search` only when the policy allows search. No citations
 * (they are incompatible with output_config.format; quotes are checked against ClaimDesk's own snapshot anyway).
 * Server-tool errors arrive as result blocks, not exceptions; `pause_turn` is already continued by the loop.
 */
export function webServerTools(req: Pick<AiRunRequest, 'web'>): Json[] {
  if (!req.web) return [];
  const domains = [...new Set(req.web.fetchDomains.map((d) => d.trim().toLowerCase().replace(/^\*\./, '')).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))].slice(0, 64);
  if (!domains.length) return [];
  const out: Json[] = [{ type: 'web_fetch_20260209', name: 'web_fetch', allowed_domains: domains, max_uses: Math.max(1, Math.min(req.web.maxFetches, 20)) }];
  if (req.web.allowSearch) out.push({ type: 'web_search_20260209', name: 'web_search', allowed_domains: domains, max_uses: 3 });
  return out;
}

/** The tool list: registry definitions (strict), plus `submit_result` in submit mode, sorted by name. */
export function buildTools(req: AiRunRequest, mode: ResultMode): Json[] {
  const tools: Json[] = [];
  for (const name of req.tools) {
    const def = getTool(name);
    if (!def) continue;
    tools.push({ name: def.name, description: def.description, input_schema: def.strictSchema, strict: true });
  }
  if (mode === 'submit_tool') {
    tools.push({ name: SUBMIT_RESULT_TOOL, description: 'Submit your final result. Call exactly once, at the end.', input_schema: req.resultSchema, strict: true });
  }
  tools.push(...webServerTools(req));
  return tools.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** System blocks: stable first, with the 1-hour cache breakpoint on the last stable block. */
export function buildSystem(req: AiRunRequest, mode: ResultMode): Json[] {
  let lastStable = -1;
  req.system.forEach((b, i) => {
    if (b.stable) lastStable = i;
  });
  const blocks: Json[] = req.system.map((b, i) => ({ type: 'text', text: b.text, ...(i === lastStable ? { cache_control: { type: 'ephemeral', ttl: '1h' } } : {}) }));
  if (mode === 'submit_tool') blocks.push({ type: 'text', text: SUBMIT_RESULT_INSTRUCTION });
  return blocks;
}

function emptyUsage(): AiUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: 0, numTurns: 0 };
}

function addUsage(total: AiUsage, u: unknown): void {
  const x = (u ?? {}) as Json;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  total.inputTokens += n(x.input_tokens);
  total.outputTokens += n(x.output_tokens);
  total.cacheReadTokens += n(x.cache_read_input_tokens);
  total.cacheWriteTokens += n(x.cache_creation_input_tokens);
}

class FirstRequestRejected extends Error {}

/** The only host the stored API key is sent to (unless a test injects another through the driver options). */
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';

/** Environment variables the Anthropic SDK reads by itself; removed at API start so none can steer a driver. */
export const SDK_STEERING_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_PROFILE', 'ANTHROPIC_CONFIG_DIR', 'ANTHROPIC_LOG', 'ANTHROPIC_WEBHOOK_SIGNING_KEY'] as const;

/** Delete the SDK-steering ANTHROPIC_* variables from this process (server start, before any driver exists). */
export function neutraliseAnthropicEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const k of SDK_STEERING_ENV) {
    if (env[k] !== undefined) {
      delete env[k];
      removed.push(k);
    }
  }
  return removed;
}

export class ApiKeyDriver implements AiDriver {
  readonly kind = 'api_key' as const;

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: ApiKeyDriverOptions = {},
  ) {
    if (ctx.config.forbidRealAi) throw new RealAiForbiddenError('The Anthropic API-key driver');
  }

  private async apiKey(): Promise<string | undefined> {
    return this.opts.apiKey ?? (await this.ctx.secrets.get('anthropic_api_key'));
  }

  private client(apiKey: string, timeoutMs: number): Anthropic {
    // §A.2/§K.2: the key comes only from the secret store, and no ANTHROPIC_* variable steers this client — the SDK
    // would otherwise take ANTHROPIC_BASE_URL (send the key elsewhere), ANTHROPIC_AUTH_TOKEN (an extra bearer header),
    // ANTHROPIC_CUSTOM_HEADERS and ANTHROPIC_LOG from the environment (see also neutraliseAnthropicEnv at start-up).
    return new Anthropic({
      apiKey,
      authToken: null,
      baseURL: this.opts.baseURL ?? ANTHROPIC_API_BASE_URL,
      logLevel: 'off',
      maxRetries: this.opts.maxRetries ?? 2,
      timeout: timeoutMs,
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
    });
  }

  /** Result of the last `checkKey()` (metadata call), kept so status reads stay offline and fast. */
  private lastKeyProblem: string | null | undefined;

  /** Presence of the key plus the last key check's result (no network). */
  async health(): Promise<DriverHealth> {
    const present = this.ctx.secrets.has('anthropic_api_key') || Boolean(this.opts.apiKey);
    const problems: string[] = [];
    if (!present) problems.push('No Anthropic API key saved: paste a key from console.anthropic.com in Settings > AI');
    else if (this.lastKeyProblem) problems.push(this.lastKeyProblem);
    return { kind: this.kind, ready: present && !problems.length, problems, apiKeyPresent: present };
  }

  /**
   * Check the key with `models.retrieve` (metadata only — no model call), then report health. Used by POST /ai/check.
   * Refused (no network) while the process forbids real AI unless a fetch was injected.
   */
  async checkKey(model = 'claude-opus-5-5'): Promise<DriverHealth> {
    const key = await this.apiKey();
    if (key && (this.opts.fetch || process.env.CLAIMDESK_FORBID_REAL_AI !== '1')) {
      try {
        await this.client(key, 10_000).models.retrieve(model);
        this.lastKeyProblem = null;
      } catch (err) {
        if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) this.lastKeyProblem = 'The Anthropic API key was refused: check or replace it';
        else if (err instanceof APIError) this.lastKeyProblem = `Anthropic API check failed (${err.status ?? 'network'})`;
        else this.lastKeyProblem = 'Anthropic API could not be reached';
      }
    }
    return this.health();
  }

  async run(req: AiRunRequest, tools: ToolExecutor, signal: AbortSignal): Promise<AiRunOutcome> {
    if (process.env.CLAIMDESK_FORBID_REAL_AI === '1' && !this.opts.fetch) {
      return { kind: 'error', retryable: false, code: 'REAL_AI_FORBIDDEN', message: new RealAiForbiddenError('The Anthropic API').message };
    }
    const key = await this.apiKey();
    if (!key) return { kind: 'auth_failed', message: 'No Anthropic API key saved (Settings > AI)' };
    const mode = this.opts.resultMode ?? 'format';
    try {
      return await this.loop(req, tools, signal, key, mode);
    } catch (err) {
      if (err instanceof FirstRequestRejected && mode === 'format') return this.loop(req, tools, signal, key, 'submit_tool').catch((e: unknown) => this.fromError(e, signal));
      return this.fromError(err, signal);
    }
  }

  private fromError(err: unknown, signal: AbortSignal): AiRunOutcome {
    const e = err instanceof FirstRequestRejected ? (err.cause as unknown) : err;
    if (e instanceof APIUserAbortError || signal.aborted) return { kind: 'timeout' };
    if (e instanceof APIConnectionTimeoutError) return { kind: 'timeout' };
    if (e instanceof AuthenticationError) return { kind: 'auth_failed', message: 'The Anthropic API key was refused (401): check or replace it in Settings > AI' };
    if (e instanceof PermissionDeniedError) return { kind: 'error', retryable: false, code: 'permission_denied', message: 'The Anthropic API refused this request (403)' };
    if (e instanceof RateLimitError) {
      const retryAfter = Number(e.headers?.get?.('retry-after') ?? NaN);
      return { kind: 'error', retryable: true, code: 'rate_limited', message: `Anthropic API rate limit (429)${Number.isFinite(retryAfter) ? `; retry after ${retryAfter}s` : ''}` };
    }
    if (e instanceof BadRequestError) return { kind: 'error', retryable: false, code: 'bad_request', message: 'The Anthropic API rejected the request (400)' };
    if (e instanceof APIConnectionError) return { kind: 'error', retryable: true, code: 'connection', message: 'Could not reach the Anthropic API' };
    if (e instanceof APIError) {
      const status = e.status ?? 0;
      return { kind: 'error', retryable: status >= 500 || status === 529 || status === 0, code: `http_${status}`, message: `Anthropic API error (${status})` };
    }
    return { kind: 'error', retryable: true, code: 'unexpected', message: e instanceof Error ? e.message : String(e) };
  }

  private async loop(req: AiRunRequest, tools: ToolExecutor, signal: AbortSignal, key: string, mode: ResultMode): Promise<AiRunOutcome> {
    const started = Date.now();
    const client = this.client(key, req.timeoutMs);
    const toolList = buildTools(req, mode);
    const system = buildSystem(req, mode);
    const messages: Json[] = [{ role: 'user', content: [...attachmentBlocks(req.attachments), { type: 'text', text: req.user }] }];
    const usage = emptyUsage();
    const allowed = new Set(req.tools);
    let model = req.model;
    let maxTokens = DEFAULT_MAX_TOKENS;
    let nudged = false;
    const done = (o: AiRunOutcome): AiRunOutcome => {
      usage.durationMs = Date.now() - started;
      usage.costUsd = costUsd(usage, model);
      return o;
    };

    for (let turn = 0; turn < req.maxTurns; turn += 1) {
      const params: Json = {
        model: req.model,
        max_tokens: maxTokens,
        system,
        ...(toolList.length ? { tools: toolList, tool_choice: { type: 'auto' } } : {}),
        output_config: { effort: req.effort, ...(mode === 'format' ? { format: { type: 'json_schema', schema: req.resultSchema } } : {}) },
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        messages,
      };
      let res: Json;
      try {
        res = (await client.beta.messages.create(params as never, { signal })) as unknown as Json;
      } catch (err) {
        // tools + output_config.format rejected on the very first request → the caller retries in submit_tool mode.
        if (turn === 0 && mode === 'format' && toolList.length && err instanceof BadRequestError) throw new FirstRequestRejected('first request rejected', { cause: err });
        throw err;
      }
      usage.numTurns += 1;
      addUsage(usage, res.usage);
      if (typeof res.model === 'string') model = res.model;
      const content = (Array.isArray(res.content) ? res.content : []) as Json[];
      const stop = res.stop_reason;

      if (stop === 'refusal') {
        const d = (res.stop_details ?? {}) as Json;
        return done({ kind: 'refused', ...(typeof d.category === 'string' ? { category: d.category } : {}), ...(typeof d.explanation === 'string' ? { explanation: d.explanation } : {}), usage });
      }
      if (stop === 'pause_turn') {
        messages.push({ role: 'assistant', content });
        continue;
      }
      if (stop === 'max_tokens') {
        if (maxTokens < RETRY_MAX_TOKENS) {
          maxTokens = RETRY_MAX_TOKENS; // one retry of the same request with a bigger budget
          continue;
        }
        return done({ kind: 'invalid_output', raw: textOf(content).slice(0, 4000), errors: [`the model hit max_tokens (${maxTokens}) twice`], usage });
      }
      const uses = content.filter((c) => c.type === 'tool_use');
      if (mode === 'submit_tool') {
        const submit = uses.find((u) => u.name === SUBMIT_RESULT_TOOL);
        if (submit) return done({ kind: 'ok', result: submit.input, usage, model, stopReason: String(stop ?? '') });
      }
      if (uses.length) {
        messages.push({ role: 'assistant', content });
        const results: Json[] = [];
        for (const u of uses) results.push(await this.runTool(u, tools, allowed));
        messages.push({ role: 'user', content: results });
        continue;
      }
      if (mode === 'submit_tool') {
        if (nudged) return done({ kind: 'invalid_output', raw: textOf(content).slice(0, 4000), errors: ['the model finished without calling submit_result'], usage });
        nudged = true;
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: [{ type: 'text', text: SUBMIT_RESULT_INSTRUCTION }] });
        continue;
      }
      const raw = textOf(content);
      try {
        return done({ kind: 'ok', result: JSON.parse(raw) as unknown, usage, model, stopReason: String(stop ?? '') });
      } catch {
        return done({ kind: 'invalid_output', raw: raw.slice(0, 4000), errors: ['the final message was not JSON'], usage });
      }
    }
    return done({ kind: 'error', retryable: false, code: 'max_turns', message: 'max turns', usage });
  }

  private async runTool(use: Json, tools: ToolExecutor, allowed: ReadonlySet<string>): Promise<Json> {
    const id = String(use.id ?? '');
    const name = String(use.name ?? '');
    if (!allowed.has(name)) return { type: 'tool_result', tool_use_id: id, is_error: true, content: JSON.stringify({ error: { code: 'TOOL_NOT_ALLOWED', message: `Tool ${name} is not available in this run` } }) };
    try {
      const r = await tools.call(name, use.input);
      const blocks = Array.isArray(r.blocks) ? (r.blocks as Json[]) : [];
      return { type: 'tool_result', tool_use_id: id, ...(r.ok ? {} : { is_error: true }), content: [{ type: 'text', text: r.content }, ...blocks] };
    } catch (err) {
      return { type: 'tool_result', tool_use_id: id, is_error: true, content: JSON.stringify({ error: { code: 'TOOL_FAILED', message: err instanceof Error ? err.message : String(err) } }) };
    }
  }
}

function textOf(content: Json[]): string {
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => String(c.text))
    .join('')
    .trim();
}
