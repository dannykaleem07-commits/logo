/**
 * Agent principals and the perimeter (docs/SUPREME-DESIGN.md §B.1, §B.2): run tokens from loopback only, writes recorded
 * as `agent:<name>` with the run id, and every forbidden action refused with 403 AGENT_FORBIDDEN {rule}, audited.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import type { AgentName } from '@ccguk/domain';
import { createTestApp, FNOL, type TestApp } from './helpers.js';
import type { HttpMethod, ToolDef } from '../agent/contracts.js';
import { mintRunToken, revokeRunToken, resolveRunToken } from '../agent/principal.js';
import { agentRouteAllowlist, registerTool } from '../agent/tools/index.js';
import { recomputeClocks } from '../services/claimView.js';
import { autonomyState, createNeedsYou, enqueueJob, getAutonomy, londonDay, londonDayStart, londonHhmm } from '../agent/core.js';
import { parseAiDriverOverride, resolveMailTransport } from '../config.js';
import path from 'node:path';

interface ErrorBody {
  error: { code: string; message: string; details?: { rule?: string } };
}

const TEST_AGENT = 'test' as AgentName;

/** A fixture HTTP tool declaring one route for the allow-list. */
function testTool(name: string, method: HttpMethod, pattern: string): ToolDef<{ claimId: string }, unknown> {
  const input = z.strictObject({ claimId: z.string() });
  return {
    name,
    title: name,
    description: 'test fixture tool',
    class: method === 'GET' ? 'read' : 'internal',
    input,
    strictSchema: { type: 'object', properties: { claimId: { type: 'string' } }, required: ['claimId'], additionalProperties: false },
    http: (i) => ({ method, url: pattern.replace(':id', i.claimId) }),
    httpRoute: { method, pattern },
    describe: (i) => ({ class: method === 'GET' ? 'read' : 'internal', kind: `test.${name}`, claimId: i.claimId, confidence: 1 }),
    maxOutputChars: 20_000,
  };
}

let t: TestApp;
let claimId: string;
let otherClaimId: string;
const unregister: Array<() => void> = [];

beforeAll(() => {
  unregister.push(
    registerTool(testTool('test_event_append', 'POST', '/claims/:id/events')),
    registerTool(testTool('test_offer_patch', 'PATCH', '/claims/:id/offers/:oid')),
    registerTool(testTool('test_ledger_append', 'POST', '/claims/:id/ledger')),
    registerTool(testTool('test_status', 'POST', '/claims/:id/status')),
    registerTool(testTool('test_events_list', 'GET', '/claims/:id/events')),
  );
});
afterAll(() => {
  for (const u of unregister.splice(0)) u();
});

beforeEach(async () => {
  t = await createTestApp('2026-10-07T09:00:00.000Z');
  const ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  claimId = ids.claimId;
  const other = await t.api<{ id: string }>('POST', '/claims', FNOL);
  expect(other.status).toBe(201);
  otherClaimId = other.body.id;
});
afterEach(async () => {
  await t.close();
});

function token(opts: { claimScope?: string; runId?: string; ttlMs?: number } = {}): string {
  return mintRunToken({ name: TEST_AGENT, runId: opts.runId ?? 'run-test-1', jobId: 'job-test-1', ...(opts.claimScope ? { claimScope: opts.claimScope } : {}) }, opts.ttlMs ?? 60_000);
}

async function asAgent<T>(tok: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, extra: { headers?: Record<string, string>; remoteAddress?: string } = {}) {
  const res = await t.app.inject({ method, url: `/api${url}`, payload: payload as never, headers: { authorization: `Bearer ${tok}`, ...extra.headers }, ...(extra.remoteAddress ? { remoteAddress: extra.remoteAddress } : {}) });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : undefined) as T };
}

const eventBody = { type: 'note', at: '2026-10-07T08:30:00.000Z', summary: 'Spoke to the insurer; handling reference to follow.' };

describe('agent principal', () => {
  it('a declared route works; the audit row records agent:<name> and the run id', async () => {
    const tok = token({ claimScope: claimId, runId: 'run-allowed' });
    const res = await asAgent<{ event: { id: string; createdBy: string } }>(tok, 'POST', `/claims/${claimId}/events`, eventBody);
    expect(res.status).toBe(201);
    expect(res.body.event.createdBy).toBe('agent:test');
    const row = t.ctx.handle.sqlite.prepare("select user_id, run_id, ip from audit_log where action = 'event.append' and entity_id = ?").get(res.body.event.id);
    expect(row).toEqual({ user_id: 'agent:test', run_id: 'run-allowed', ip: '127.0.0.1' });
    expect(t.ctx.repos.listAudit(t.ctx.db, { runId: 'run-allowed' }).map((a) => a.userId)).toContain('agent:test');
    // Reads through a declared GET route work too.
    expect((await asAgent(tok, 'GET', `/claims/${claimId}/events`)).status).toBe(200);
  });

  it('the allow-list is built from the registered tools plus /api/mcp', () => {
    const list = agentRouteAllowlist();
    expect(list.has('POST /api/claims/:id/events')).toBe(true);
    expect(list.has('POST /api/mcp')).toBe(true);
    expect(list.has('GET /api/claims')).toBe(false);
  });

  it('refuses a run token from a non-loopback address (401) and an expired or revoked token (401)', async () => {
    const tok = token();
    expect((await asAgent<ErrorBody>(tok, 'POST', `/claims/${claimId}/events`, eventBody, { remoteAddress: '10.0.0.5' })).status).toBe(401);
    revokeRunToken(tok);
    expect(resolveRunToken(tok)).toBeUndefined();
    const revoked = await asAgent<ErrorBody>(tok, 'POST', `/claims/${claimId}/events`, eventBody);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe('UNAUTHENTICATED');
    const unknown = await asAgent<ErrorBody>('cdk_run_not-a-real-token', 'GET', `/claims/${claimId}/events`);
    expect(unknown.status).toBe(401);
  });
});

describe('perimeter (§B.2)', () => {
  async function expectForbidden(res: { status: number; body: ErrorBody }, rule: string) {
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AGENT_FORBIDDEN');
    expect(res.body.error.details?.rule).toBe(rule);
    const denied = t.ctx.repos.listAudit(t.ctx.db, { action: 'agent.tool.denied' });
    expect(denied[0]).toMatchObject({ userId: 'agent:test', runId: 'run-test-1', after: { rule } });
  }

  it('rule 1: an undeclared route is refused', async () => {
    await expectForbidden(await asAgent<ErrorBody>(token(), 'GET', '/claims'), 'route_allowlist');
    await expectForbidden(await asAgent<ErrorBody>(token(), 'PATCH', '/settings', { companyName: 'x' }), 'route_allowlist');
    await expectForbidden(await asAgent<ErrorBody>(token(), 'POST', '/auth/logout'), 'route_allowlist');
  });

  it('rule 2: manager-mode headers are refused', async () => {
    const res = await asAgent<ErrorBody>(token(), 'POST', `/claims/${claimId}/events`, eventBody, { headers: { 'x-manager-override': 'reason' } });
    await expectForbidden(res, 'manager_mode');
    const relaxed = await asAgent<ErrorBody>(token(), 'POST', `/claims/${claimId}/events`, eventBody, { headers: { 'x-manager-relaxed': 'x' } });
    expect(relaxed.body.error.details?.rule).toBe('manager_mode');
  });

  it('rule 3: a claim-scoped run cannot name another claim', async () => {
    const tok = token({ claimScope: claimId });
    await expectForbidden(await asAgent<ErrorBody>(tok, 'POST', `/claims/${otherClaimId}/events`, eventBody), 'claim_scope');
    await expectForbidden(await asAgent<ErrorBody>(tok, 'POST', `/claims/${claimId}/events`, { ...eventBody, claimId: otherClaimId }), 'claim_scope');
    expect((await asAgent(tok, 'POST', `/claims/${claimId}/events`, eventBody)).status).toBe(201);
  });

  it('rule 4: offer decisions, ledger money kinds and settling statuses are refused', async () => {
    const offer = await t.api<{ offer: { id: string } }>('POST', `/claims/${claimId}/offers`, { receivedAt: '2026-10-06T10:00:00.000Z', channel: 'phone', offerorName: 'Example Insurance plc' });
    expect(offer.status).toBe(201);
    const oid = offer.body.offer.id;
    await expectForbidden(await asAgent<ErrorBody>(token(), 'PATCH', `/claims/${claimId}/offers/${oid}`, { clientDecision: 'accepted' }), 'money_settlement');
    await expectForbidden(await asAgent<ErrorBody>(token(), 'PATCH', `/claims/${claimId}/offers/${oid}`, { replySentAt: '2026-10-07T08:00:00.000Z' }), 'money_settlement');
    const after = t.ctx.repos.requireOffer(t.ctx.db, oid);
    expect(after.clientDecision).toBe('pending');
    expect(after.replySentAt).toBeUndefined();

    const ledger = { head: 'hire', amountPence: 10000, date: '2026-10-06', description: 'Payment received' };
    for (const kind of ['paid', 'written_off', 'reduced', 'interim_paid', 'adjustment']) {
      await expectForbidden(await asAgent<ErrorBody>(token(), 'POST', `/claims/${claimId}/ledger`, { ...ledger, kind }), 'money_settlement');
    }
    await expectForbidden(await asAgent<ErrorBody>(token(), 'POST', `/claims/${claimId}/ledger`, { ...ledger, kind: 'claimed', supersedesId: 'x' }), 'money_settlement');
    const claimed = await asAgent<{ createdBy: string }>(token(), 'POST', `/claims/${claimId}/ledger`, { ...ledger, kind: 'claimed', description: 'Hire claimed' });
    expect(claimed.status).toBe(201);
    expect(claimed.body.createdBy).toBe('agent:test');

    for (const status of ['settled', 'closed', 'declined', 'pre_action', 'litigation']) {
      await expectForbidden(await asAgent<ErrorBody>(token(), 'POST', `/claims/${claimId}/status`, { status, reason: 'x' }), 'money_settlement');
    }
  });

  it('parties and vehicles: bank details are never written by an agent; a scoped run writes only its own claim\'s', async () => {
    const mine = t.ctx.repos.requireClaim(t.ctx.db, claimId);
    const theirs = t.ctx.repos.requireClaim(t.ctx.db, otherClaimId);
    const tok = token({ claimScope: claimId });
    await expectForbidden(await asAgent<ErrorBody>(tok, 'PATCH', `/parties/${mine.claimantId}`, { bank: { sortCode: '12-34-56', accountNumber: '12345678' } }), 'money_settlement');
    await expectForbidden(await asAgent<ErrorBody>(token(), 'POST', '/parties', { kind: 'individual', name: 'X', roles: ['witness'], bank: { sortCode: '12-34-56' } }), 'money_settlement');
    await expectForbidden(await asAgent<ErrorBody>(tok, 'PATCH', `/parties/${theirs.claimantId}`, { phone: '07700 900999' }), 'claim_scope');
    await expectForbidden(await asAgent<ErrorBody>(tok, 'PATCH', `/vehicles/${theirs.clientVehicleId}`, { colour: 'Red' }), 'claim_scope');
    // the perimeter lets its own claim's party and vehicle through (the routes then validate the bodies)
    expect((await asAgent(tok, 'PATCH', `/parties/${mine.claimantId}`, { phone: '07700 900111' })).status).not.toBe(403);
    expect((await asAgent(tok, 'PATCH', `/vehicles/${mine.clientVehicleId}`, { colour: 'Silver' })).status).not.toBe(403);
  });

  it('rule 5: human-only routes are refused even if a tool declared them', async () => {
    const doc = await t.api<{ id: string }>('POST', `/claims/${claimId}/documents`, { templateId: 'letter.chaser_7' });
    const unreg = registerTool(testTool('test_doc_approve', 'POST', '/documents/:id/approve'));
    try {
      await expectForbidden(await asAgent<ErrorBody>(token(), 'POST', `/documents/${doc.body.id}/approve`, {}), 'human_only');
      await expectForbidden(await asAgent<ErrorBody>(token(), 'POST', `/documents/${doc.body.id}/sign/start`, {}), 'human_only');
      await expectForbidden(await asAgent<ErrorBody>(token(), 'POST', `/claims/${claimId}/estimate/e1/approve`, {}), 'human_only');
      await expectForbidden(await asAgent<ErrorBody>(token(), 'PATCH', '/directory/d1/verify', {}), 'human_only');
    } finally {
      unreg();
    }
    expect(t.ctx.repos.requireDocument(t.ctx.db, doc.body.id).status).not.toBe('approved');
  });

  it('rule 6: no DELETE is reachable', async () => {
    await expectForbidden(await asAgent<ErrorBody>(token(), 'DELETE', `/claims/${claimId}/events/e1`), 'destructive');
  });

  it('people are unaffected by the perimeter', async () => {
    expect((await t.api('GET', '/claims')).status).toBe(200);
  });
});

describe('agent core helpers (agent/core.ts)', () => {
  it('enqueueJob is idempotent and carries correlation id and depth to follow-ups', () => {
    const parent = enqueueJob(t.ctx, { type: 'mail.triage', payload: { messageId: 'm1' }, claimId, idempotencyKey: 'mail.triage:m1', createdBy: 'system' });
    expect(enqueueJob(t.ctx, { type: 'mail.triage', payload: {}, idempotencyKey: 'mail.triage:m1', createdBy: 'system' }).id).toBe(parent.id);
    expect(parent).toMatchObject({ agent: 'mail', lane: 'ai', priority: 1, depth: 0, status: 'queued', correlationId: parent.id });
    const child = enqueueJob(t.ctx, { type: 'case.review', payload: { reason: 'inbound' }, claimId, parentJobId: parent.id, createdBy: 'agent:mail' });
    expect(child).toMatchObject({ depth: 1, correlationId: parent.id, parentJobId: parent.id, agent: 'case_manager' });
  });

  it('the loop guard stops a hand-off chain deeper than 6 and tells the owner once', () => {
    let job = enqueueJob(t.ctx, { type: 'case.review', payload: {}, claimId, createdBy: 'system' });
    for (let i = 0; i < 7; i += 1) job = enqueueJob(t.ctx, { type: 'case.review', payload: { i }, claimId, parentJobId: job.id, createdBy: 'agent:case_manager' });
    expect(job).toMatchObject({ depth: 7, status: 'dead' });
    expect(job.error).toMatch(/loop guard/);
    const items = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'failure' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ claimId, dedupeKey: `loop_guard:${job.correlationId}` });
  });

  it('createNeedsYou dedupes, audits needs_you.create and queues notify.dispatch once', () => {
    const input = { kind: 'approve_send' as const, claimId, title: 'Approve the reply', summary: 'Held for you', payload: { outboxId: 'o1' }, priority: 'high' as const, createdBy: 'agent:mail', dedupeKey: 'approve_send:o1' };
    const a = createNeedsYou(t.ctx, input);
    const b = createNeedsYou(t.ctx, { ...input, title: 'second' });
    expect(b.id).toBe(a.id);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'needs_you.create' })).toHaveLength(1);
    const notify = t.ctx.repos.listAgentJobs(t.ctx.db, { type: 'notify.dispatch' });
    expect(notify).toHaveLength(1);
    expect(notify[0]).toMatchObject({ payload: { needsYouId: a.id }, idempotencyKey: `notify.dispatch:needs_you:${a.id}`, lane: 'io' });
  });

  it('getAutonomy and autonomyState read settings, pauses and London time', () => {
    expect(getAutonomy(t.ctx).mode).toBe('automatic');
    t.ctx.repos.patchAgentSettings(t.ctx.db, { autonomy: { killSwitch: true }, agents: { paused: ['mail'] } }, { userId: 'courtesycars' });
    t.ctx.repos.pauseClaimAgents(t.ctx.db, claimId, { actor: { userId: 'courtesycars' } });
    expect(autonomyState(t.ctx, { claimId, agent: 'mail' })).toEqual({ killSwitch: true, agentPaused: true, claimPaused: true, sends: { claimToday: 0, lastHour: 0, today: 0 }, nowLocal: '10:00' });
    expect(autonomyState(t.ctx, { claimId: otherClaimId, agent: 'drafter' })).toMatchObject({ agentPaused: false, claimPaused: false });
    expect(londonDay('2026-10-07T23:30:00.000Z')).toBe('2026-10-08');
    expect(londonDayStart('2026-10-07T09:00:00.000Z')).toBe('2026-10-06T23:00:00.000Z');
    expect(londonHhmm('2026-12-01T09:05:00.000Z')).toBe('09:05');
  });
});

describe('config (SUPREME additions)', () => {
  it('fake mail transport is refused in production unless CLAIMDESK_ALLOW_FAKE_AI=1; AI_DRIVER parses', () => {
    expect(resolveMailTransport('development', undefined, false)).toBe('real');
    expect(resolveMailTransport('test', 'fake', false)).toBe('fake');
    expect(() => resolveMailTransport('production', 'fake', false)).toThrow(/not allowed in production/);
    expect(resolveMailTransport('production', 'fake', true)).toBe('fake');
    expect(() => resolveMailTransport('development', 'smtp', false)).toThrow(/MAIL_TRANSPORT/);
    expect(parseAiDriverOverride('FAKE')).toBe('fake');
    expect(parseAiDriverOverride('claude')).toBeUndefined();
    expect(t.ctx.config).toMatchObject({ forbidRealAi: true, mailTransport: 'fake', allowFakeAi: false });
    expect(t.ctx.config.agentRunsDir).toBe(path.join(t.ctx.config.appHome, 'agent-runs'));
    expect(process.env.CLAIMDESK_FORBID_REAL_AI).toBe('1');
  });
});
