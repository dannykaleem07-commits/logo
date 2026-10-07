/**
 * The dispatcher (docs/SUPREME-DESIGN.md §B.3): allow-list, input validation, claim scope, decide() → deny / ask
 * (Needs-you) / auto, the route as the agent principal (perimeter included), agent_tool_calls rows with masked input,
 * shaping and truncation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { AgentName } from '@ccguk/domain';
import { createTestApp, FNOL, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import { mintRunToken, revokeRunToken } from '../agent/principal.js';
import { executeTool, registerRun, truncateOutput, unregisterRun } from '../agent/dispatcher.js';
import { registerTool } from '../agent/tools/index.js';
import type { RunContext, ToolDef } from '../agent/contracts.js';
import { toolInputSchema } from '../ai/strictSchema.js';

let t: TestApp;
let claimId: string;
let otherClaimId: string;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  t = await createTestApp('2026-10-07T09:00:00.000Z');
  const ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  claimId = ids.claimId;
  const other = await t.api<{ id: string }>('POST', '/claims', FNOL);
  otherClaimId = other.body.id;
});
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  await t.close();
});

function run(tools: string[], opts: { claimScope?: string | null; agent?: AgentName } = {}): RunContext {
  const runId = randomUUID();
  const agent = opts.agent ?? 'case_manager';
  const claimScope = opts.claimScope === null ? undefined : (opts.claimScope ?? claimId);
  const token = mintRunToken({ name: agent, runId, jobId: 'job-1', ...(claimScope ? { claimScope } : {}) }, 60_000);
  const rc: RunContext = { runId, jobId: 'job-1', agent, ...(claimScope ? { claimScope } : {}), token, allowedTools: new Set(tools), runDir: `${t.ctx.config.agentRunsDir}/${runId}`, correlationId: 'corr-1' };
  t.ctx.repos.startAgentRun(t.ctx.db, { id: runId, jobId: 'job-1', agent, jobType: 'case.review', driver: 'fake', model: 'm', effort: 'low', promptVersion: 'v', inputSha256: 'x' });
  registerRun(rc);
  cleanups.push(() => {
    unregisterRun(runId);
    revokeRunToken(token);
  });
  return rc;
}

const calls = (rc: RunContext) => t.ctx.repos.listAgentToolCalls(t.ctx.db, rc.runId);
const auditRows = (action: string) => t.ctx.handle.sqlite.prepare('SELECT * FROM audit_log WHERE action = ?').all(action) as Array<{ user_id: string; run_id: string | null; after: string }>;
const eventInput = (cid: string) => ({ claimId: cid, type: 'note', at: '2026-10-07T08:30:00.000Z', summary: 'Spoke to the insurer; handling reference to follow.', data: null, attributableTo: null, evidenceIds: null });

describe('allow-list and validation', () => {
  it('refuses a tool that is not in the run allow-list (denied row)', async () => {
    const rc = run(['claim_clocks']);
    const r = await executeTool(t.ctx, rc, 'claim_get', { claimId });
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error.code).toBe('TOOL_NOT_ALLOWED');
    expect(calls(rc)[0]).toMatchObject({ tool: 'claim_get', decision: 'denied' });
  });

  it('refuses an unknown tool', async () => {
    const rc = run(['nope_tool']);
    const r = await executeTool(t.ctx, rc, 'nope_tool', {});
    expect(JSON.parse(r.content).error.code).toBe('TOOL_NOT_ALLOWED');
  });

  it('returns the zod issues for invalid input (invalid row)', async () => {
    const rc = run(['events_list']);
    const r = await executeTool(t.ctx, rc, 'events_list', { claimId, type: null, since: null, limit: 0, offset: null, extra: 1 });
    expect(r.ok).toBe(false);
    const body = JSON.parse(r.content);
    expect(body.error.code).toBe('INVALID_INPUT');
    expect(body.error.issues.length).toBeGreaterThan(0);
    expect(calls(rc)[0]).toMatchObject({ decision: 'invalid' });
  });
});

describe('claim scope', () => {
  it('refuses an input naming another claim', async () => {
    const rc = run(['claim_get']);
    const r = await executeTool(t.ctx, rc, 'claim_get', { claimId: otherClaimId });
    expect(JSON.parse(r.content).error.code).toBe('CLAIM_SCOPE');
    expect(calls(rc)[0]).toMatchObject({ decision: 'denied', ruleIds: ['claim_scope'] });
  });

  it('narrows claims_search to the scoped claim', async () => {
    const rc = run(['claims_search']);
    const r = await executeTool(t.ctx, rc, 'claims_search', { q: null, status: null, flagged: null, limit: null, offset: null });
    expect(r.ok).toBe(true);
    const out = JSON.parse(r.content);
    expect(out.items.map((i: { id: string }) => i.id)).toEqual([claimId]);
    const unscoped = run(['claims_search'], { claimScope: null });
    const all = JSON.parse((await executeTool(t.ctx, unscoped, 'claims_search', { q: null, status: null, flagged: null, limit: null, offset: null })).content);
    expect(all.items.length).toBe(2);
  });
});

describe('policy: auto / deny / ask', () => {
  it('auto: a read runs through the route as the agent and records an allowed row with the HTTP status', async () => {
    const rc = run(['claim_clocks']);
    const r = await executeTool(t.ctx, rc, 'claim_clocks', { claimId });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content).clocks.length).toBeGreaterThan(0);
    expect(calls(rc)[0]).toMatchObject({ tool: 'claim_clocks', actionClass: 'read', decision: 'allowed', httpStatus: 200 });
    // Reads are not audited as policy decisions.
    expect(auditRows('agent.policy')).toHaveLength(0);
  });

  it('auto: an internal action writes through the route as agent:<name> with the run id, audited agent.policy', async () => {
    const rc = run(['event_append']);
    const r = await executeTool(t.ctx, rc, 'event_append', eventInput(claimId));
    expect(r.ok).toBe(true);
    const events = await t.api<{ events: Array<{ summary: string; createdBy: string }> }>('GET', `/claims/${claimId}/events`);
    const ev = events.body.events.find((e) => e.summary.startsWith('Spoke to the insurer'));
    expect(ev?.createdBy).toBe('agent:case_manager');
    const policy = auditRows('agent.policy');
    expect(policy).toHaveLength(1);
    expect(policy[0]!.user_id).toBe('agent:case_manager');
    expect(policy[0]!.run_id).toBe(rc.runId);
    expect(JSON.parse(policy[0]!.after)).toMatchObject({ tool: 'event_append', outcome: 'auto', ruleIds: ['internal_ok'] });
    expect(calls(rc)[0]).toMatchObject({ decision: 'allowed', httpStatus: 201 });
  });

  it('deny: the kill switch refuses internal actions (reads still work)', async () => {
    t.ctx.repos.patchAgentSettings(t.ctx.db, { autonomy: { killSwitch: true } }, { userId: 'courtesycars' });
    const rc = run(['event_append', 'claim_clocks']);
    const r = await executeTool(t.ctx, rc, 'event_append', eventInput(claimId));
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error).toMatchObject({ code: 'POLICY_DENIED', ruleIds: ['kill_switch'] });
    expect(calls(rc)[0]).toMatchObject({ decision: 'denied', ruleIds: ['kill_switch'] });
    expect((await executeTool(t.ctx, rc, 'claim_clocks', { claimId })).ok).toBe(true);
  });

  it('ask: shadow mode turns an internal action into a Needs-you item and does not act', async () => {
    t.ctx.repos.patchAgentSettings(t.ctx.db, { autonomy: { mode: 'shadow' } }, { userId: 'courtesycars' });
    const before = (await t.api<{ events: unknown[] }>('GET', `/claims/${claimId}/events`)).body.events.length;
    const rc = run(['event_append']);
    const r = await executeTool(t.ctx, rc, 'event_append', eventInput(claimId));
    expect(r.ok).toBe(true);
    const body = JSON.parse(r.content);
    expect(body.status).toBe('awaiting_owner');
    expect(r.needsYouId).toBe(body.needsYouId);
    const item = t.ctx.repos.getNeedsYouItem(t.ctx.db, body.needsYouId);
    expect(item).toMatchObject({ kind: 'question', claimId, createdBy: 'agent:case_manager', correlationId: 'corr-1' });
    expect((await t.api<{ events: unknown[] }>('GET', `/claims/${claimId}/events`)).body.events.length).toBe(before);
    expect(calls(rc)[0]).toMatchObject({ decision: 'asked', ruleIds: ['shadow'], needsYouId: body.needsYouId });
  });

  it('ask without onAsk tells the model to use needs_you_create', async () => {
    const input = z.strictObject({ claimId: z.string() });
    cleanups.push(
      registerTool({
        name: 'test_money_tool',
        title: 't',
        description: 'test',
        class: 'money',
        input,
        strictSchema: toolInputSchema(input),
        run: async () => ({ done: true }),
        describe: (i: { claimId: string }) => ({ class: 'money', kind: 'test.money', claimId: i.claimId, confidence: 1 }),
        maxOutputChars: 20_000,
      } as ToolDef<{ claimId: string }, unknown>),
    );
    const rc = run(['test_money_tool']);
    const r = await executeTool(t.ctx, rc, 'test_money_tool', { claimId });
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error.code).toBe('NEEDS_OWNER');
    expect(calls(rc)[0]).toMatchObject({ decision: 'asked', ruleIds: ['always_ask_classes'] });
  });
});

describe('routes, perimeter and errors', () => {
  it('a route error becomes an is_error result with the route code (error row)', async () => {
    const rc = run(['claim_get'], { claimScope: null });
    const r = await executeTool(t.ctx, rc, 'claim_get', { claimId: 'does-not-exist' });
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error.code).toBe('NOT_FOUND');
    expect(calls(rc)[0]).toMatchObject({ decision: 'error', httpStatus: 404 });
  });

  it('the perimeter refuses a forbidden write even when a tool asks for it', async () => {
    const input = z.strictObject({ claimId: z.string() });
    cleanups.push(
      registerTool({
        name: 'test_paid_ledger',
        title: 't',
        description: 'test',
        class: 'internal',
        input,
        strictSchema: toolInputSchema(input),
        http: (i: { claimId: string }) => ({ method: 'POST', url: `/claims/${i.claimId}/ledger`, body: { head: 'hire', kind: 'paid', amountPence: 100, date: '2026-10-07', description: 'x' } }),
        httpRoute: { method: 'POST', pattern: '/claims/:id/ledger' },
        describe: (i: { claimId: string }) => ({ class: 'internal', kind: 'test.ledger', claimId: i.claimId, confidence: 1 }),
        maxOutputChars: 20_000,
      } as ToolDef<{ claimId: string }, unknown>),
    );
    const rc = run(['test_paid_ledger']);
    const r = await executeTool(t.ctx, rc, 'test_paid_ledger', { claimId });
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error).toMatchObject({ code: 'AGENT_FORBIDDEN', details: { rule: 'money_settlement' } });
    expect(calls(rc)[0]).toMatchObject({ decision: 'error', httpStatus: 403 });
  });
});

describe('shaping, truncation and masking', () => {
  it('truncateOutput keeps within the limit and marks truncation', () => {
    const big = { items: Array.from({ length: 500 }, (_, i) => ({ i, text: 'x'.repeat(50) + '"quoted"' })) };
    const out = truncateOutput(big, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    const parsed = JSON.parse(out);
    expect(parsed.truncated).toBe(true);
    expect(parsed.hint).toMatch(/limit\/offset/);
    expect(truncateOutput({ a: 1 }, 1000)).toBe('{"a":1}');
  });

  it('cuts a tool output at maxOutputChars and masks PII in input_redacted', async () => {
    const input = z.strictObject({ dateOfBirth: z.string(), phone: z.string(), email: z.string(), name: z.string() });
    cleanups.push(
      registerTool({
        name: 'test_big_output',
        title: 't',
        description: 'test',
        class: 'read',
        input,
        strictSchema: toolInputSchema(input),
        run: async () => ({ items: Array.from({ length: 200 }, (_, i) => ({ i, text: 'lorem ipsum '.repeat(10) })) }),
        describe: () => ({ class: 'read', kind: 'test.big', confidence: 1 }),
        maxOutputChars: 300,
      } as ToolDef<z.infer<typeof input>, unknown>),
    );
    const rc = run(['test_big_output']);
    const r = await executeTool(t.ctx, rc, 'test_big_output', { dateOfBirth: '1988-04-02', phone: '07700 900123', email: 'jane.doe@example.test', name: 'Jane Doe' });
    expect(r.ok).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(300);
    expect(JSON.parse(r.content).truncated).toBe(true);
    const row = calls(rc)[0]!;
    expect(row.inputRedacted).toEqual({ dateOfBirth: '1988', phone: '07••• •••123', email: 'j•••@example.test', name: 'Jane Doe' });
    expect(row.outputSummary!.length).toBeLessThanOrEqual(501);
  });

  it('counts tool calls on the run row', async () => {
    const rc = run(['claim_clocks', 'claim_gates']);
    await executeTool(t.ctx, rc, 'claim_clocks', { claimId });
    await executeTool(t.ctx, rc, 'claim_gates', { claimId });
    expect(t.ctx.repos.getAgentRun(t.ctx.db, rc.runId)?.toolCalls).toBe(2);
    expect(calls(rc).map((c) => c.seq)).toEqual([1, 2]);
  });
});
