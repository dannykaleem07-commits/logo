/**
 * ApiKeyDriver (docs/SUPREME-DESIGN.md §A.3) with an injected fetch — no network, no model. Checks the request body
 * (tool_choice auto, strict sorted tools, output_config effort + format, fallbacks 'default' with the beta header, no
 * thinking, the 1-hour cache breakpoint), the manual tool loop through the real dispatcher, pause_turn, refusal,
 * max_tokens, submit_tool mode (configured and as the 400 fallback), typed errors, cost, and a byte-identical stable
 * prefix across two runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { RESULT_SCHEMAS } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import { ApiKeyDriver, FALLBACK_BETA, SUBMIT_RESULT_TOOL, type ApiKeyDriverOptions } from '../ai/apiKeyDriver.js';
import { RealAiForbiddenError } from '../ai/subscriptionCliDriver.js';
import { assemblePrompts } from '../ai/prompts.js';
import { costUsd } from '../ai/pricing.js';
import { mintRunToken, revokeRunToken } from '../agent/principal.js';
import { executorFor, registerRun, unregisterRun } from '../agent/dispatcher.js';
import type { AgentSpec, RunContext } from '../agent/contracts.js';
import type { AiRunRequest, ToolExecutor } from '../ai/types.js';

type Json = Record<string, unknown>;
interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Json;
}

const RESULT = { answer: 'Invented answer.', citations: [{ kind: 'kb', id: 'gta-4-7', verified: false }], confidence: 0.6 };
const usage = (i = 100, o = 20) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 });
const message = (content: Json[], stop_reason: string, extra: Json = {}): Json => ({ id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, usage: usage(), ...extra });
const final = (result: unknown = RESULT) => message([{ type: 'text', text: JSON.stringify(result) }], 'end_turn');
const toolUse = (name: string, input: unknown, id = `toolu_${randomUUID().slice(0, 8)}`) => message([{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id, name, input }], 'tool_use');

/** A fetch that records requests and answers from a queue (a Response or a status + body). */
function fakeFetch(queue: Array<Json | { status: number; body: Json; headers?: Record<string, string> }>) {
  const captured: Captured[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    captured.push({ url, headers, body: JSON.parse(String(init?.body ?? '{}')) as Json });
    const next = queue.shift();
    if (!next) throw new Error('fake fetch: no more responses queued');
    const isErr = typeof (next as { status?: unknown }).status === 'number' && 'body' in next;
    const status = isErr ? (next as { status: number }).status : 200;
    const body = isErr ? (next as { body: Json }).body : next;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test', ...(isErr ? ((next as { headers?: Record<string, string> }).headers ?? {}) : {}) } });
  }) as typeof fetch;
  return { fn, captured };
}

const spec: AgentSpec = { name: 'researcher', jobType: 'research.ask', title: 'Research', promptFiles: [], tools: ['kb_search', 'claim_clocks'], allowRead: false, resultSchemaId: 'research_answer', defaults: { model: 'claude-opus-5-5', effort: 'high', maxTurns: 6, timeoutMs: 30_000 } };

let t: TestApp;
let claimId: string;
let rc: RunContext;
let executor: ToolExecutor;

beforeEach(async () => {
  t = await createTestApp('2026-10-07T09:00:00.000Z', { config: { forbidRealAi: false } });
  const ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  claimId = ids.claimId;
  const runId = randomUUID();
  const token = mintRunToken({ name: 'researcher', runId, jobId: 'job-api', claimScope: claimId }, 60_000);
  rc = { runId, jobId: 'job-api', agent: 'researcher', claimScope: claimId, token, allowedTools: new Set(spec.tools), runDir: path.join(t.ctx.config.agentRunsDir, runId), correlationId: 'c' };
  registerRun(rc);
  executor = executorFor(t.ctx, rc);
});
afterEach(async () => {
  unregisterRun(rc.runId);
  revokeRunToken(rc.token);
  await t.close();
});

function request(user = 'What does the KB say about cash in lieu?', over: Partial<AiRunRequest> = {}): AiRunRequest {
  const prompts = assemblePrompts(spec, { task: user }, t.ctx);
  return {
    runId: rc.runId,
    jobId: 'job-api',
    agent: 'researcher',
    jobType: 'research.ask',
    claimId,
    model: 'claude-opus-5-5',
    effort: 'high',
    maxTurns: 6,
    timeoutMs: 30_000,
    system: prompts.system,
    user: prompts.user,
    attachments: [],
    tools: spec.tools,
    allowRead: false,
    resultSchema: RESULT_SCHEMAS.research_answer,
    resultSchemaId: 'research_answer',
    runDir: rc.runDir,
    promptVersion: prompts.promptVersion,
    ...over,
  };
}

function driverWith(queue: Parameters<typeof fakeFetch>[0], opts: Partial<ApiKeyDriverOptions> = {}) {
  const f = fakeFetch(queue);
  const d = new ApiKeyDriver(t.ctx, { fetch: f.fn, apiKey: 'sk-ant-api-invented', maxRetries: 0, ...opts });
  return { d, captured: f.captured };
}
const go = (d: ApiKeyDriver, req = request(), ex: ToolExecutor = executor) => d.run(req, ex, new AbortController().signal);

describe('guards', () => {
  it('throws REAL_AI_FORBIDDEN when the process forbids real AI', async () => {
    const forbidden = await createTestApp();
    try {
      expect(() => new ApiKeyDriver(forbidden.ctx, { apiKey: 'x' })).toThrow(RealAiForbiddenError);
    } finally {
      await forbidden.close();
    }
  });

  it('refuses to run without an injected fetch while CLAIMDESK_FORBID_REAL_AI=1', async () => {
    const d = new ApiKeyDriver(t.ctx, { apiKey: 'sk-ant-api-invented' });
    expect(await go(d)).toMatchObject({ kind: 'error', code: 'REAL_AI_FORBIDDEN' });
  });

  it('no key → auth_failed', async () => {
    const f = fakeFetch([]);
    const d = new ApiKeyDriver(t.ctx, { fetch: f.fn });
    expect((await go(d)).kind).toBe('auth_failed');
    expect(f.captured).toHaveLength(0);
  });
});

describe('request shape', () => {
  it('tool_choice auto, strict sorted tools, effort + format, fallbacks + beta header, no thinking, cache breakpoint', async () => {
    const { d, captured } = driverWith([final()]);
    const out = await go(d);
    expect(out.kind).toBe('ok');
    const req = captured[0]!;
    expect(req.url).toMatch(/\/v1\/messages\?beta=true$/);
    expect(req.headers['anthropic-beta']).toContain(FALLBACK_BETA);
    expect(req.headers['x-api-key']).toBe('sk-ant-api-invented');
    const b = req.body;
    expect(b.model).toBe('claude-opus-5-5');
    expect(b.max_tokens).toBe(16_000);
    expect(b.tool_choice).toEqual({ type: 'auto' });
    expect(b.fallbacks).toBe('default');
    expect('thinking' in b).toBe(false);
    expect('betas' in b).toBe(false);
    expect(b.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema: RESULT_SCHEMAS.research_answer } });
    const tools = b.tools as Array<{ name: string; strict: boolean; input_schema: Json }>;
    expect(tools.map((x) => x.name)).toEqual(['claim_clocks', 'kb_search']);
    expect(tools.every((x) => x.strict === true && (x.input_schema as { additionalProperties?: boolean }).additionalProperties === false)).toBe(true);
    const system = b.system as Array<{ type: string; text: string; cache_control?: Json }>;
    expect(system.length).toBeGreaterThanOrEqual(4);
    expect(system.filter((s) => s.cache_control)).toHaveLength(1);
    expect(system[system.length - 1]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const messages = b.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content.at(-1)!.text).toContain('cash in lieu');
  });

  it('the stable prefix (tools + system) is byte-identical across two runs', async () => {
    const a = driverWith([final()]);
    const b = driverWith([final()]);
    await go(a.d, request('First question about hire periods.'));
    await go(b.d, request('A different question about storage.'));
    const prefix = (c: Captured) => JSON.stringify({ tools: c.body.tools, system: c.body.system });
    expect(prefix(a.captured[0]!)).toBe(prefix(b.captured[0]!));
    expect(JSON.stringify(a.captured[0]!.body.messages)).not.toBe(JSON.stringify(b.captured[0]!.body.messages));
  });
});

describe('the loop', () => {
  it('runs tool calls through the dispatcher and returns the final JSON with summed usage and cost', async () => {
    const { d, captured } = driverWith([toolUse('claim_clocks', { claimId }, 'toolu_1'), final()]);
    const out = await go(d);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.result).toEqual(RESULT);
    expect(out.usage).toMatchObject({ inputTokens: 200, outputTokens: 40, cacheReadTokens: 20, cacheWriteTokens: 10, numTurns: 2 });
    expect(out.usage.costUsd).toBeCloseTo(costUsd(out.usage, 'claude-opus-5-5'), 10);
    const second = captured[1]!.body.messages as Array<{ role: string; content: Array<Json> }>;
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const toolResult = second[2]!.content[0]!;
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect('is_error' in toolResult).toBe(false);
    expect(JSON.parse(((toolResult.content as Json[])[0] as { text: string }).text).clocks.length).toBeGreaterThan(0);
    expect(t.ctx.repos.listAgentToolCalls(t.ctx.db, rc.runId)[0]).toMatchObject({ tool: 'claim_clocks', decision: 'allowed' });
  });

  it('invalid tool input and tools outside the run come back as is_error results', async () => {
    const { d, captured } = driverWith([message([{ type: 'tool_use', id: 't1', name: 'claim_clocks', input: { claimId: 42 } }, { type: 'tool_use', id: 't2', name: 'event_append', input: {} }], 'tool_use'), final()]);
    expect((await go(d)).kind).toBe('ok');
    const results = (captured[1]!.body.messages as Array<{ content: Json[] }>)[2]!.content;
    expect(results.map((r) => r.is_error)).toEqual([true, true]);
  });

  it('passes image/document blocks from ToolCallResult.blocks', async () => {
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
    const ex: ToolExecutor = { call: async () => ({ ok: true, content: '{"path":"input/x.png"}', blocks: [block] }) };
    const { d, captured } = driverWith([toolUse('kb_search', { q: 'x', type: null, topic: null, limit: null }, 'tu'), final()]);
    await go(d, request(), ex);
    const tr = (captured[1]!.body.messages as Array<{ content: Json[] }>)[2]!.content[0]!;
    expect((tr.content as Json[])[1]).toEqual(block);
  });

  it('pause_turn continues with the assistant content', async () => {
    const paused = message([{ type: 'text', text: 'Working…' }], 'pause_turn');
    const { d, captured } = driverWith([paused, final()]);
    expect((await go(d)).kind).toBe('ok');
    const msgs = captured[1]!.body.messages as Array<{ role: string; content: Json[] }>;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]!.content).toEqual(paused.content);
  });

  it('refusal → refused with the stop details', async () => {
    const { d } = driverWith([message([], 'refusal', { stop_details: { type: 'refusal', category: 'general_harms', explanation: 'Invented explanation.' } })]);
    expect(await go(d)).toMatchObject({ kind: 'refused', category: 'general_harms', explanation: 'Invented explanation.' });
  });

  it('max_tokens: one retry at 32,000, then invalid_output', async () => {
    const cut = message([{ type: 'text', text: '{"answer":' }], 'max_tokens');
    const a = driverWith([cut, final()]);
    expect((await go(a.d)).kind).toBe('ok');
    expect(a.captured.map((c) => c.body.max_tokens)).toEqual([16_000, 32_000]);
    const b = driverWith([cut, cut]);
    expect((await go(b.d)).kind).toBe('invalid_output');
  });

  it('a final message that is not JSON → invalid_output; max turns → error', async () => {
    expect((await go(driverWith([message([{ type: 'text', text: 'Sorry, here is prose.' }], 'end_turn')]).d)).kind).toBe('invalid_output');
    const loop = driverWith([toolUse('kb_search', { q: 'a', type: null, topic: null, limit: null }), toolUse('kb_search', { q: 'b', type: null, topic: null, limit: null })]);
    expect(await go(loop.d, request(undefined, { maxTurns: 2 }))).toMatchObject({ kind: 'error', retryable: false, code: 'max_turns' });
  });
});

describe('submit_tool mode', () => {
  it('configured: a strict submit_result tool, no output_config.format, result from the tool input', async () => {
    const { d, captured } = driverWith([toolUse('claim_clocks', { claimId }), toolUse(SUBMIT_RESULT_TOOL, RESULT)], { resultMode: 'submit_tool' });
    const out = await go(d);
    expect(out).toMatchObject({ kind: 'ok', result: RESULT });
    const b = captured[0]!.body;
    expect(b.output_config).toEqual({ effort: 'high' });
    const tools = b.tools as Array<{ name: string; strict: boolean; input_schema: Json }>;
    expect(tools.map((x) => x.name)).toEqual(['claim_clocks', 'kb_search', SUBMIT_RESULT_TOOL]);
    expect(tools.find((x) => x.name === SUBMIT_RESULT_TOOL)).toMatchObject({ strict: true, input_schema: RESULT_SCHEMAS.research_answer });
    expect(JSON.stringify(b.system)).toContain('submit_result');
  });

  it('fallback: a 400 on the first request with tools + format retries in submit_tool mode', async () => {
    const { d, captured } = driverWith([{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'invented' } } }, toolUse(SUBMIT_RESULT_TOOL, RESULT)]);
    expect(await go(d)).toMatchObject({ kind: 'ok', result: RESULT });
    expect((captured[1]!.body.tools as Array<{ name: string }>).map((x) => x.name)).toContain(SUBMIT_RESULT_TOOL);
  });
});

describe('typed errors', () => {
  it('401 → auth_failed; 429 → retryable; 529 / 500 → retryable; 403 → not retryable', async () => {
    const err = (status: number) => ({ status, body: { type: 'error', error: { type: 'x', message: 'invented' } }, headers: { 'retry-after': '7' } });
    expect((await go(driverWith([err(401)]).d)).kind).toBe('auth_failed');
    expect(await go(driverWith([err(429)]).d)).toMatchObject({ kind: 'error', retryable: true, code: 'rate_limited' });
    expect(await go(driverWith([err(529)]).d)).toMatchObject({ kind: 'error', retryable: true });
    expect(await go(driverWith([err(500)]).d)).toMatchObject({ kind: 'error', retryable: true });
    expect(await go(driverWith([err(403)]).d)).toMatchObject({ kind: 'error', retryable: false });
  });
});

describe('pricing', () => {
  it('costs usage with the price table', () => {
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }, 'claude-opus-5-5')).toBeCloseTo(24.2, 6);
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'claude-sonnet-5-5-20261001')).toBeCloseTo(2, 6);
    expect(costUsd({ inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'unknown-model')).toBe(0);
  });
});

describe('health', () => {
  it('health is offline (presence only); checkKey uses models.retrieve metadata, never a model call', async () => {
    const ok = driverWith([{ id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }]);
    expect(await ok.d.health()).toMatchObject({ kind: 'api_key', ready: true, apiKeyPresent: true });
    expect(ok.captured).toHaveLength(0);
    expect((await ok.d.checkKey()).ready).toBe(true);
    expect(ok.captured[0]!.url).toMatch(/\/v1\/models\/claude-opus-5-5/);
    const bad = driverWith([{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invented' } } }]);
    const h = await bad.d.checkKey();
    expect(h.ready).toBe(false);
    expect(h.problems.join(' ')).toMatch(/refused/);
    expect((await bad.d.health()).ready).toBe(false);
  });
});
