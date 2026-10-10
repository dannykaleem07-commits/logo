// owned by ap-foundation
/**
 * Autopilot foundation (docs/SUPREME-AUTOPILOT.md §0.6, §A.7, §A.8, §H.1, §H.4, §H.5): actAsAutopilot runs a tool as
 * the deterministic `agent:autopilot` principal through the dispatcher, decide() and the perimeter (no model); the step
 * rules 4a/4b reach the policy through RunContext.step; the Autopilot pause; nudges; perimeter additions; the kiosk
 * public prefix; Settings > Autopilot; schedules. No real AI, no network.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTOPILOT_PRINCIPAL_TOOLS, STEP_FLOORS } from '@ccguk/domain';
import { createTestApp, FNOL, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import { actAsAutopilot } from '../autopilot/act.js';
import { autopilotTickKey, nudgeAutopilot } from '../autopilot/nudge.js';
import { CLAIM_BOUND_FLEET_ROUTES, HUMAN_ONLY_ROUTES, perimeterVerdict } from '../agent/perimeter.js';
import { isPublicApiRoute } from '../app.js';
import { AUTOPILOT_SCHEDULE_IDS, runDueSchedules, scheduleIdempotencyKey, seedSchedules } from '../agent/scheduler.js';
import { autonomyState } from '../agent/core.js';
import { compileDailyLog } from '../agent/dailyLog.js';
import { getJobHandler } from '../agent/handlers/index.js';

const NOW = '2026-10-07T09:00:00.000Z';
let t: TestApp;
let claimId: string;
let otherClaimId: string;

beforeEach(async () => {
  t = await createTestApp(NOW);
  const ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  claimId = ids.claimId;
  otherClaimId = (await t.api<{ id: string }>('POST', '/claims', FNOL)).body.id;
});
afterEach(async () => {
  await t.close();
});

const note = (cid: string) => ({ claimId: cid, type: 'note', at: '2026-10-07T08:30:00.000Z', summary: 'Autopilot note.', data: null, attributableTo: null, evidenceIds: null });
const policyRows = (runId: string) =>
  (t.ctx.handle.sqlite.prepare("SELECT user_id, run_id, after FROM audit_log WHERE action = 'agent.policy' AND run_id = ?").all(runId) as Array<{ user_id: string; after: string }>).map((r) => ({ userId: r.user_id, ...JSON.parse(r.after) }));
const eventsBy = (cid: string, by: string) => t.ctx.repos.listEvents(t.ctx.db, cid).filter((e) => e.createdBy === by);

describe('actAsAutopilot (§A.7)', () => {
  it('runs a read tool as agent:autopilot with a deterministic run row and no model', async () => {
    const r = await actAsAutopilot(t.ctx, { claimId, step: null, tool: 'claim_get', input: { claimId }, planHash: 'abc123' });
    expect(r.ok).toBe(true);
    const run = t.ctx.repos.getAgentRun(t.ctx.db, r.runId)!;
    expect(run).toMatchObject({ agent: 'autopilot', jobType: 'autopilot.tick', claimId, driver: 'deterministic', model: 'none', promptVersion: 'autopilot/1:abc123', outcome: 'ok' });
    expect(run.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(t.ctx.repos.listAgentToolCalls(t.ctx.db, r.runId)[0]).toMatchObject({ tool: 'claim_get', decision: 'allowed' });
    const audits = t.ctx.handle.sqlite.prepare("SELECT action, user_id FROM audit_log WHERE run_id = ? ORDER BY at").all(r.runId) as Array<{ action: string; user_id: string }>;
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['agent.run.start', 'agent.run.end']));
    expect(audits.every((a) => a.user_id === 'agent:autopilot')).toBe(true);
  });

  it('an auto step acts through decide() and the route as agent:autopilot', async () => {
    const r = await actAsAutopilot(t.ctx, { claimId, step: { id: 'vehicle.repair_track', mode: 'auto', green: true }, tool: 'event_append', input: note(claimId) });
    expect(r.ok, r.content).toBe(true);
    expect(eventsBy(claimId, 'agent:autopilot')).toHaveLength(1);
    expect(policyRows(r.runId)[0]).toMatchObject({ userId: 'agent:autopilot', outcome: 'auto', ruleIds: ['internal_ok'] });
  });

  it('rule 4a: an owner step is never attempted by an agent (deny, nothing written)', async () => {
    const r = await actAsAutopilot(t.ctx, { claimId, step: { id: 'hire.handover', mode: 'owner', green: false }, tool: 'event_append', input: note(claimId) });
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error).toMatchObject({ code: 'POLICY_DENIED', ruleIds: ['step_owner_only'] });
    expect(eventsBy(claimId, 'agent:autopilot')).toHaveLength(0);
    expect(t.ctx.repos.getAgentRun(t.ctx.db, r.runId)).toMatchObject({ outcome: 'error', error: 'POLICY_DENIED' });
  });

  it('rule 4b: a confirm step asks the owner (Needs-you), nothing written', async () => {
    const r = await actAsAutopilot(t.ctx, { claimId, step: { id: 'money.payment', mode: 'confirm', green: false }, tool: 'event_append', input: note(claimId) });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content)).toMatchObject({ status: 'awaiting_owner' });
    expect(r.needsYouId).toBeTruthy();
    expect(eventsBy(claimId, 'agent:autopilot')).toHaveLength(0);
    expect(policyRows(r.runId)[0]).toMatchObject({ outcome: 'ask', ruleIds: ['step_confirm'] });
  });

  it('stays inside its claim and its tool subset', async () => {
    const other = await actAsAutopilot(t.ctx, { claimId, step: null, tool: 'event_append', input: note(otherClaimId) });
    expect(JSON.parse(other.content).error.code).toBe('CLAIM_SCOPE');
    expect(AUTOPILOT_PRINCIPAL_TOOLS).not.toContain('offer_record');
    const notAllowed = await actAsAutopilot(t.ctx, { claimId, step: null, tool: 'offer_record', input: {} });
    expect(JSON.parse(notAllowed.content).error.code).toBe('TOOL_NOT_ALLOWED');
  });

  it('the kill switch stops it; the Autopilot pause (claim or master switch) asks; agent pauses still apply', async () => {
    t.ctx.repos.patchAgentSettings(t.ctx.db, { autonomy: { killSwitch: true } }, { userId: 'test' });
    const killed = await actAsAutopilot(t.ctx, { claimId, step: { id: 'vehicle.repair_track', mode: 'auto', green: true }, tool: 'event_append', input: note(claimId) });
    expect(JSON.parse(killed.content).error).toMatchObject({ code: 'POLICY_DENIED', ruleIds: ['kill_switch'] });
    t.ctx.repos.patchAgentSettings(t.ctx.db, { autonomy: { killSwitch: false } }, { userId: 'test' });

    t.ctx.handle.sqlite.prepare("INSERT INTO claim_autopilot (claim_id, mode, updated_at) VALUES (?, 'paused', ?)").run(claimId, NOW);
    expect(autonomyState(t.ctx, { claimId, agent: 'autopilot' }).claimPaused).toBe(true);
    // The Autopilot's own pause affects only its principal.
    expect(autonomyState(t.ctx, { claimId, agent: 'case_manager' }).claimPaused).toBe(false);
    const paused = await actAsAutopilot(t.ctx, { claimId, step: { id: 'vehicle.repair_track', mode: 'auto', green: true }, tool: 'event_append', input: note(claimId) });
    expect(policyRows(paused.runId)[0]).toMatchObject({ outcome: 'ask', ruleIds: ['paused'] });
    t.ctx.handle.sqlite.prepare("UPDATE claim_autopilot SET mode = 'on' WHERE claim_id = ?").run(claimId);
    expect(autonomyState(t.ctx, { claimId, agent: 'autopilot' }).claimPaused).toBe(false);

    t.ctx.repos.patchAgentSettings(t.ctx.db, { autopilot: { enabled: false } }, { userId: 'test' });
    expect(autonomyState(t.ctx, { claimId, agent: 'autopilot' }).claimPaused).toBe(true);
  });

  it('deterministic runs are not counted as AI runs in the daily log', async () => {
    await actAsAutopilot(t.ctx, { claimId, step: { id: 'hire.handover', mode: 'owner', green: false }, tool: 'event_append', input: note(claimId) });
    const log = compileDailyLog(t.ctx, '2026-10-07');
    expect(log.counts.aiRuns).toBe(0);
    expect(log.counts.aiFailures).toBe(0);
  });
});

describe('nudgeAutopilot', () => {
  it('uses the §H.1 idempotency key and queues nothing until ap-autopilot registers autopilot.tick', () => {
    expect(autopilotTickKey('c1', '2026-10-07T09:00:30.000Z')).toBe('autopilot.tick:c1:2026-10-07T10:00');
    const job = nudgeAutopilot(t.ctx, claimId, 'test');
    if (getJobHandler('autopilot.tick')) {
      expect(job).toMatchObject({ type: 'autopilot.tick', claimId });
      expect(nudgeAutopilot(t.ctx, claimId, 'again')?.id).toBe(job!.id);
    } else {
      expect(job).toBeUndefined();
      expect(t.ctx.handle.sqlite.prepare("SELECT count(*) AS n FROM agent_jobs WHERE type = 'autopilot.tick'").get()).toEqual({ n: 0 });
    }
  });
});

/** A minimal Fastify request for perimeterVerdict. */
function req(method: string, url: string, opts: { params?: Record<string, string>; body?: unknown; query?: Record<string, string>; scope?: string } = {}): FastifyRequest {
  return {
    method,
    url,
    routeOptions: { url },
    headers: {},
    params: opts.params ?? {},
    query: opts.query ?? {},
    body: opts.body,
    agent: { name: 'autopilot', runId: randomUUID(), jobId: 'j', expiresAt: Date.now() + 60_000, ...(opts.scope ? { claimScope: opts.scope } : {}) },
  } as unknown as FastifyRequest;
}

describe('perimeter additions (§H.5)', () => {
  it('makes the people-only Autopilot routes human-only', () => {
    for (const key of ['POST /api/bookings/:id/handover', 'POST /api/bookings/:id/return', 'POST /api/documents/:id/mark-signed', 'POST /api/packs/:id/approve', 'POST /api/packs/:id/kiosk', 'POST /api/hire-offers/:id/accept', 'PUT /api/parties/:id/driver-profile', 'POST /api/claims/:id/autopilot/pause', 'POST /api/claims/:id/autopilot/steps/:stepId/:action']) {
      expect(HUMAN_ONLY_ROUTES.has(key), key).toBe(true);
      const [method, url] = key.split(' ') as [string, string];
      expect(perimeterVerdict(t.ctx, req(method, url, { params: { id: 'x' }, scope: claimId }), new Set([key]))?.rule, key).toBe('human_only');
    }
  });

  it('refuses every run token on the kiosk routes, whatever the allow-list says', () => {
    expect(perimeterVerdict(t.ctx, req('POST', '/api/kiosk/:token/sign', { params: { token: 't' } }), new Set(['POST /api/kiosk/:token/sign']))).toMatchObject({ rule: 'human_only' });
    expect(perimeterVerdict(t.ctx, req('GET', '/api/kiosk/:token', { params: { token: 't' } }), new Set(['GET /api/kiosk/:token']))).toMatchObject({ rule: 'human_only' });
  });

  it('resolves the claim of a booking (and other Autopilot records) for claim scope', () => {
    t.ctx.handle.sqlite
      .prepare(
        `INSERT INTO fleet_reservations (id, fleet_unit_id, claim_id, status, use, start_at, block_start_ms, hirer_party_id, daily_rate_pence, gta_group, source, created_by, created_at, updated_at)
         VALUES ('res-other', 'unit-x', ?, 'held', 'credit_hire', ?, 0, 'p', 4980, 'C2', 'autopilot', 'test', ?, ?)`,
      )
      .run(otherClaimId, NOW, NOW, NOW);
    const allow = new Set(['POST /api/bookings/:id/confirm']);
    expect(perimeterVerdict(t.ctx, req('POST', '/api/bookings/:id/confirm', { params: { id: 'res-other' }, scope: claimId }), allow)).toMatchObject({ rule: 'claim_scope' });
    expect(perimeterVerdict(t.ctx, req('POST', '/api/bookings/:id/confirm', { params: { id: 'res-other' }, scope: otherClaimId }), allow)).toBeUndefined();
  });

  it('fleet-wide routes need the run’s own claimId', () => {
    expect([...CLAIM_BOUND_FLEET_ROUTES]).toEqual(['/api/fleet/availability', '/api/fleet/calendar']);
    const allow = new Set(['POST /api/fleet/availability', 'GET /api/fleet/calendar']);
    expect(perimeterVerdict(t.ctx, req('POST', '/api/fleet/availability', { body: {}, scope: claimId }), allow)).toMatchObject({ rule: 'claim_scope' });
    expect(perimeterVerdict(t.ctx, req('POST', '/api/fleet/availability', { body: { claimId: otherClaimId }, scope: claimId }), allow)).toMatchObject({ rule: 'claim_scope' });
    expect(perimeterVerdict(t.ctx, req('POST', '/api/fleet/availability', { body: { claimId }, scope: claimId }), allow)).toBeUndefined();
    expect(perimeterVerdict(t.ctx, req('GET', '/api/fleet/calendar', { query: { claimId }, scope: claimId }), allow)).toBeUndefined();
  });

  it('settlement offer decisions stay owner-only (rule 4)', () => {
    const allow = new Set(['PATCH /api/claims/:id/settlement-offers/:oid']);
    expect(perimeterVerdict(t.ctx, req('PATCH', '/api/claims/:id/settlement-offers/:oid', { params: { id: claimId, oid: 'o' }, body: { status: 'accepted' }, scope: claimId }), allow)).toMatchObject({ rule: 'money_settlement' });
  });
});

describe('kiosk routes are public to the session check (token auth, §E.2)', () => {
  it('matches only the /api/kiosk/ prefix', () => {
    expect(isPublicApiRoute('/api/kiosk/:token')).toBe(true);
    expect(isPublicApiRoute('/api/kiosk/:token/sign')).toBe(true);
    expect(isPublicApiRoute('/api/health')).toBe(true);
    expect(isPublicApiRoute('/api/kioskx')).toBe(false);
    expect(isPublicApiRoute('/api/claims')).toBe(false);
  });
});

describe('Settings > Autopilot (§A.11, §H.4)', () => {
  it('GET shows the effective settings, the defaults and every floor', async () => {
    const r = await t.api<{ settings: { enabled: boolean; booking: { holdHours: number } }; floors: Array<{ id: string; floor: string; reason: string | null }> }>('GET', '/settings/autopilot');
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({ enabled: true, booking: { holdHours: 24 } });
    expect(r.body.floors).toHaveLength(Object.keys(STEP_FLOORS).length);
    expect(r.body.floors.find((f) => f.id === 'hire.pack')).toEqual({ id: 'hire.pack', floor: 'confirm', reason: 'Agreements and forms always need you' });
  });

  it('PATCH merges, audits and refuses a mode below a floor', async () => {
    const ok = await t.api<{ settings: { booking: { holdHours: number; offerReminderHours: number }; stepModes: Record<string, string> } }>('PATCH', '/settings/autopilot', { booking: { holdHours: 12 }, stepModes: { 'hire.offer': 'confirm' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.settings.booking).toMatchObject({ holdHours: 12, offerReminderHours: 4 });
    expect(ok.body.settings.stepModes).toEqual({ 'hire.offer': 'confirm' });
    expect(t.ctx.handle.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'autopilot.settings'").get()).toEqual({ n: 1 });

    const below = await t.api<{ error: { code: string; message: string } }>('PATCH', '/settings/autopilot', { stepModes: { 'hire.handover': 'auto' } });
    expect(below.status).toBe(400);
    expect(below.body.error.code).toBe('STEP_FLOOR');
    expect(below.body.error.message).toMatch(/hire\.handover/);

    const bad = await t.api<{ error: { code: string } }>('PATCH', '/settings/autopilot', { booking: { holdHours: -1 } });
    expect(bad.status).toBe(400);

    const cleared = await t.api<{ settings: { stepModes: Record<string, string> } }>('PATCH', '/settings/autopilot', { stepModes: { 'hire.offer': null } });
    expect(cleared.body.settings.stepModes).toEqual({});
  });

  it('the autonomy settings still save while the Autopilot templates are not registered yet', async () => {
    const r = await t.api('PATCH', '/settings/autonomy', { holdMinutes: 15 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});

describe('Autopilot schedules (§H.1)', () => {
  it('are seeded with the §H.1 idempotency keys and skipped until their handler exists', () => {
    const ids = seedSchedules(t.ctx).map((s) => s.id);
    for (const id of AUTOPILOT_SCHEDULE_IDS) expect(ids).toContain(id);
    const slot = '2026-10-07T09:05:00.000Z';
    expect(scheduleIdempotencyKey({ id: 'autopilot.sweep', jobType: 'autopilot.sweep' }, slot)).toBe('autopilot.sweep:2026-10-07T09:05');
    expect(scheduleIdempotencyKey({ id: 'fleet.status_sync', jobType: 'fleet.status_sync' }, slot)).toBe('fleet.status_sync:2026-10-07T09');
    expect(scheduleIdempotencyKey({ id: 'clash.sweep', jobType: 'clash.sweep' }, slot)).toBe('clash.sweep:2026-10-07');
    expect(scheduleIdempotencyKey({ id: 'signing.match_return', jobType: 'signing.match_return' }, slot)).toBe('signing.match_return:2026-10-07T09:05');
    const runs = runDueSchedules(t.ctx, '2026-10-08T12:00:00.000Z');
    const sweep = runs.find((r) => r.scheduleId === 'autopilot.sweep')!;
    if (!getJobHandler('autopilot.sweep')) expect(sweep).toMatchObject({ jobs: [], skipped: 'no handler registered' });
  });
});
