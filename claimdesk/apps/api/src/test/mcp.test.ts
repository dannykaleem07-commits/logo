/**
 * The MCP endpoint (docs/SUPREME-DESIGN.md §B.3): `POST|GET|DELETE /api/mcp` for agent run tokens only; a stateless
 * per-request server listing only the run's allowed tools; calls go through the dispatcher.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import { mintRunToken, revokeRunToken } from '../agent/principal.js';
import { registerRun, unregisterRun } from '../agent/dispatcher.js';
import type { RunContext } from '../agent/contracts.js';

let t: TestApp;
let claimId: string;
let rc: RunContext;

beforeEach(async () => {
  t = await createTestApp('2026-10-07T09:00:00.000Z');
  const ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  claimId = ids.claimId;
  const runId = randomUUID();
  const token = mintRunToken({ name: 'case_manager', runId, jobId: 'job-mcp', claimScope: claimId }, 60_000);
  rc = { runId, jobId: 'job-mcp', agent: 'case_manager', claimScope: claimId, token, allowedTools: new Set(['claim_clocks', 'kb_search', 'claim_get']), runDir: `${t.ctx.config.agentRunsDir}/${runId}`, correlationId: 'c' };
  registerRun(rc);
});
afterEach(async () => {
  unregisterRun(rc.runId);
  revokeRunToken(rc.token);
  await t.close();
});

let rpcId = 0;
async function rpc(method: string, params: unknown, token: string | null = rc.token, extra: { remoteAddress?: string } = {}) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    ...(extra.remoteAddress ? { remoteAddress: extra.remoteAddress } : {}),
  });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    /* empty */
  }
  return { status: res.statusCode, body };
}

describe('/api/mcp', () => {
  it('refuses people (no run token) with 403', async () => {
    const r = await rpc('tools/list', {}, null);
    expect(r.status).toBe(403);
    expect((r.body.error as { code: string }).code).toBe('AGENT_ONLY');
    const get = await t.app.inject({ method: 'GET', url: '/api/mcp' });
    expect(get.statusCode).toBe(403);
  });

  it('refuses a revoked token (401) and a token from another computer (401)', async () => {
    expect((await rpc('tools/list', {}, rc.token, { remoteAddress: '192.168.1.20' })).status).toBe(401);
    const runId = randomUUID();
    const dead = mintRunToken({ name: 'mail', runId, jobId: 'j' }, 60_000);
    revokeRunToken(dead);
    expect((await rpc('tools/list', {}, dead)).status).toBe(401);
  });

  it('refuses a valid token whose run is not active (403)', async () => {
    const token = mintRunToken({ name: 'mail', runId: randomUUID(), jobId: 'j' }, 60_000);
    const r = await rpc('tools/list', {}, token);
    expect(r.status).toBe(403);
    expect((r.body.error as { code: string }).code).toBe('RUN_NOT_ACTIVE');
    revokeRunToken(token);
  });

  it('initialize answers as the claimdesk server', async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(r.status).toBe(200);
    expect((r.body.result as { serverInfo: { name: string } }).serverInfo.name).toBe('claimdesk');
  });

  it('tools/list shows exactly the allowed tools with input schemas', async () => {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const r = await rpc('tools/list', {});
    expect(r.status).toBe(200);
    const tools = (r.body.result as { tools: Array<{ name: string; inputSchema: { type: string; properties: object } }> }).tools;
    expect(tools.map((x) => x.name).sort()).toEqual(['claim_clocks', 'claim_get', 'kb_search']);
    expect(tools.find((x) => x.name === 'claim_clocks')!.inputSchema).toMatchObject({ type: 'object', properties: { claimId: { type: 'string' } } });
  });

  it('tools/call runs through the dispatcher (result + tool-call row)', async () => {
    const r = await rpc('tools/call', { name: 'claim_clocks', arguments: { claimId } });
    expect(r.status).toBe(200);
    const result = r.body.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text).clocks.length).toBeGreaterThan(0);
    expect(t.ctx.repos.listAgentToolCalls(t.ctx.db, rc.runId)[0]).toMatchObject({ tool: 'claim_clocks', decision: 'allowed' });
  });

  it('a tool outside the allow-list cannot be called; dispatcher errors come back as isError', async () => {
    const r = await rpc('tools/call', { name: 'event_append', arguments: { claimId } });
    const result = r.body.result as { isError?: boolean } | undefined;
    expect(result?.isError).toBe(true);
    // §B.3 step 1: the refusal is recorded like the API driver's (not swallowed inside the MCP SDK).
    expect(t.ctx.repos.listAgentToolCalls(t.ctx.db, rc.runId).find((c) => c.tool === 'event_append')).toMatchObject({ decision: 'denied' });
    const unknown = await rpc('tools/call', { name: 'offer_recommend', arguments: {} });
    expect((unknown.body.result as { isError?: boolean }).isError).toBe(true);
    expect(t.ctx.repos.listAgentToolCalls(t.ctx.db, rc.runId).find((c) => c.tool === 'offer_recommend')).toMatchObject({ decision: 'denied' });
    const scope = await rpc('tools/call', { name: 'claim_get', arguments: { claimId: 'another-claim' } });
    const sr = scope.body.result as { content: Array<{ text: string }>; isError: boolean };
    expect(sr.isError).toBe(true);
    expect(JSON.parse(sr.content[0]!.text).error.code).toBe('CLAIM_SCOPE');
  });

  it('invalid arguments are refused', async () => {
    const r = await rpc('tools/call', { name: 'claim_clocks', arguments: { claimId: 5 } });
    expect((r.body.result as { isError: boolean }).isError).toBe(true);
    expect(t.ctx.repos.listAgentToolCalls(t.ctx.db, rc.runId).find((c) => c.tool === 'claim_clocks')?.decision).toMatch(/invalid|denied/);
  });
});
