/**
 * Supervisor (docs/SUPREME-DESIGN.md §A.5, §C.6): usage bands, a rejected window pausing until resetsAt + 2 min,
 * deterministic jobs running while AI is paused, the kill switch, agent and claim pauses, the deadline guard, and
 * schedules in London time across the October clock change. Handlers are stubs; no model is called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { JobType, Lane } from '@ccguk/domain';
import { createTestApp, FNOL, type TestApp } from './helpers.js';
import type { JobHandler, JobRecord } from '../agent/contracts.js';
import { enqueueJob } from '../agent/core.js';
import { createSupervisor, getSupervisor, type Supervisor } from '../agent/supervisor.js';
import { aiGate, fiveHourCeiling, sevenDayCeiling, ALL_PRIORITIES, NO_PRIORITY } from '../agent/budgets.js';
import { systemJobHandlers } from '../agent/handlers/system.js';
import { listSchedules, nextRunAfter, scheduleIdempotencyKey, seedSchedules } from '../agent/scheduler.js';

const T0 = '2026-10-05T09:00:00.000Z'; // Monday, BST

const ran: string[] = [];
function stub(type: JobType, lane: Lane, agent: JobHandler['agent']): JobHandler<Record<string, unknown>, unknown> {
  return {
    type,
    lane,
    agent,
    usesAi: lane === 'ai',
    mutatesClaim: false,
    payload: z.object({}).passthrough(),
    defaultPriority: 3,
    maxAttempts: 3,
    timeoutMs: 5_000,
    run: async ({ job }) => {
      ran.push(`${job.type}:${job.id}`);
      return { kind: 'done', result: null };
    },
  };
}
const STUBS = [stub('case.review', 'ai', 'case_manager'), stub('mail.triage', 'ai', 'mail'), stub('mail.sync', 'io', 'mail'), stub('outbox.release', 'io', 'mail'), stub('case.sweep', 'io', 'case_manager'), stub('index.fts', 'cpu', 'researcher')];

let t: TestApp;
let sup: Supervisor;
beforeEach(async () => {
  ran.length = 0;
  t = await createTestApp(T0);
  t.ctx.repos.patchAgentSettings(t.ctx.db, { agents: { enabled: true }, ai: { driver: 'subscription_cli' } }, { userId: 'test' });
  sup = createSupervisor(t.ctx, { handlers: [...systemJobHandlers, ...STUBS] });
});
afterEach(async () => {
  await sup.stop();
  await t.close();
});

const job = (id: string): JobRecord => t.ctx.repos.getAgentJob(t.ctx.db, id) as JobRecord;
const enqueue = (type: JobType, extra: Record<string, unknown> = {}): JobRecord => enqueueJob(t.ctx, { type, payload: {}, createdBy: 'test', ...extra });
const setUsage = (fiveHour: unknown, sevenDay?: unknown) => t.ctx.repos.setAiUsageSnapshot(t.ctx.db, { fiveHour, ...(sevenDay ? { sevenDay } : {}), now: T0 });

describe('usage bands (§A.5)', () => {
  it('maps five-hour utilisation and the reserve to priority ceilings', () => {
    expect(fiveHourCeiling({ status: 'allowed', utilization: 0.5 }, 20).maxPriority).toBe(ALL_PRIORITIES);
    expect(fiveHourCeiling({ status: 'allowed', utilization: 0.65 }, 20).maxPriority).toBe(5);
    expect(fiveHourCeiling({ status: 'allowed', utilization: 0.79 }, 10).maxPriority).toBe(5);
    expect(fiveHourCeiling({ status: 'allowed', utilization: 0.85 }, 10).maxPriority).toBe(3);
    expect(fiveHourCeiling({ status: 'allowed', utilization: 0.85 }, 20).maxPriority).toBe(1);
    expect(fiveHourCeiling({ status: 'allowed_warning', utilization: 0.1 }, 20).maxPriority).toBe(1);
    expect(fiveHourCeiling({ status: 'rejected' }, 20).maxPriority).toBe(NO_PRIORITY);
    expect(sevenDayCeiling({ status: 'allowed', utilization: 0.86 })).toMatchObject({ maxPriority: 3, economy: true });
    expect(sevenDayCeiling({ status: 'allowed', utilization: 0.96 })).toMatchObject({ maxPriority: 1, economy: true });
  });

  it('ignores a snapshot whose window has already reset, and pauses on the API daily cap', () => {
    const settings = t.ctx.repos.getAgentSettings(t.ctx.db);
    const base = { now: T0, today: '2026-10-05', nextDayStart: '2026-10-05T23:00:00.000Z' };
    expect(aiGate({ ...base, settings, usage: { driver: 'x', costTodayUsd: 0, fiveHour: { status: 'rejected', resetsAt: '2026-10-05T08:00:00.000Z' } } }).maxPriority).toBe(ALL_PRIORITIES);
    const api = { ...settings, ai: { ...settings.ai, driver: 'api_key' as const, dailyUsdCap: 5 } };
    const g = aiGate({ ...base, settings: api, usage: { driver: 'api_key', costTodayUsd: 5.5, costDay: '2026-10-05' } });
    expect(g).toMatchObject({ maxPriority: NO_PRIORITY, reason: 'daily_cap', pauseUntil: '2026-10-05T23:00:00.000Z' });
  });

  it('only lets high-priority AI jobs start in the 0.6–0.8 band; deterministic lanes are untouched', async () => {
    setUsage({ status: 'allowed', utilization: 0.7, resetsAt: '2026-10-05T12:00:00.000Z' });
    const low = enqueue('case.review', { idempotencyKey: 'low', priority: 6 });
    const hi = enqueue('mail.triage', { idempotencyKey: 'hi', priority: 5 });
    const det = enqueue('mail.sync', { idempotencyKey: 'det', priority: 9 });
    const hb = await sup.tick(T0);
    await sup.worker.idle();
    expect(hb.gates.lanes.ai.maxPriority).toBe(5);
    expect(job(hi.id).status).toBe('succeeded');
    expect(job(det.id).status).toBe('succeeded');
    expect(job(low.id).status).toBe('queued');
  });
});

describe('rejected window', () => {
  it('pauses AI until resetsAt + 2 min, keeps deterministic work running, then resumes', async () => {
    setUsage({ status: 'rejected', type: 'five_hour', resetsAt: '2026-10-05T09:30:00.000Z' });
    const ai = enqueue('case.review', { idempotencyKey: 'ai' });
    const det = enqueue('mail.sync', { idempotencyKey: 'det' });
    await sup.tick(T0);
    await sup.worker.idle();
    expect(t.ctx.repos.getAiUsageState(t.ctx.db)).toMatchObject({ pausedUntil: '2026-10-05T09:32:00.000Z', pauseReason: 'usage_limited' });
    expect(job(ai.id).status).toBe('queued');
    expect(job(det.id).status).toBe('succeeded');
    const status = await t.api<{ pill: { state: string; label: string } }>('GET', '/agents/status');
    expect(status.body.pill.state).toBe('paused');
    expect(status.body.pill.label).toBe('Paused — usage resets 10:32');
    // Still closed one minute before the margin ends.
    await sup.tick('2026-10-05T09:31:00.000Z');
    await sup.worker.idle();
    expect(job(ai.id).status).toBe('queued');
    const hb = await sup.tick('2026-10-05T09:32:00.000Z');
    await sup.worker.idle();
    expect(hb.gates.lanes.ai.open).toBe(true);
    expect(t.ctx.repos.getAiUsageState(t.ctx.db).pausedUntil).toBeUndefined();
    expect(job(ai.id).status).toBe('succeeded');
    const actions = t.ctx.repos.listAudit(t.ctx.db, { entity: 'ai_usage_state' }).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['ai.pause', 'ai.resume']));
  });
});

describe('kill switch and pauses', () => {
  it('kill switch: no AI leases and no outbox release; mail still syncs', async () => {
    t.ctx.repos.patchAgentSettings(t.ctx.db, { autonomy: { killSwitch: true } }, { userId: 'test' });
    const ai = enqueue('case.review', { idempotencyKey: 'ai' });
    const rel = enqueue('outbox.release', { idempotencyKey: 'rel' });
    const det = enqueue('mail.sync', { idempotencyKey: 'det' });
    const hb = await sup.tick(T0);
    await sup.worker.idle();
    expect(hb.gates.lanes.ai).toMatchObject({ open: false, reason: 'kill_switch' });
    expect(job(ai.id).status).toBe('queued');
    expect(job(rel.id)).toMatchObject({ status: 'waiting_usage', attempts: 0 });
    expect(job(det.id).status).toBe('succeeded');
  });

  it('kill switch route is audited and turning it off needs admin', async () => {
    const on = await t.api<{ killSwitch: boolean; pill: { state: string } }>('POST', '/agents/kill-switch', { on: true, reason: 'test' });
    expect(on.status).toBe(200);
    expect(on.body.killSwitch).toBe(true);
    expect(on.body.pill.state).toBe('stopped');
    const audit = t.ctx.repos.listAudit(t.ctx.db, { action: 'agents.kill_switch' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({ killSwitch: true });
  });

  it('a paused agent and a paused claim are skipped; others run', async () => {
    await t.api('POST', '/agents/mail/pause', { reason: 'test' });
    const claimRes = await t.api<{ claim?: { id: string }; id?: string }>('POST', '/claims', FNOL);
    const claimId = (claimRes.body.claim?.id ?? claimRes.body.id)!;
    await t.api('POST', `/claims/${claimId}/agent/pause`, { reason: 'owner handling' });
    const mail = enqueue('mail.triage', { idempotencyKey: 'mail' });
    const onClaim = enqueue('case.review', { idempotencyKey: 'claim', claimId });
    await sup.tick(T0);
    await sup.worker.idle();
    expect(job(mail.id).status).toBe('queued');
    expect(job(onClaim.id).status).toBe('queued');
    const other = enqueue('case.review', { idempotencyKey: 'other', claimId: 'another-claim' });
    await sup.tick(T0);
    await sup.worker.idle();
    expect(job(other.id).status).toBe('succeeded');
    await t.api('POST', '/agents/mail/resume');
    await t.api('POST', `/claims/${claimId}/agent/resume`);
    await sup.tick(T0);
    await sup.worker.idle();
    await sup.tick(T0);
    await sup.worker.idle();
    expect(job(mail.id).status).toBe('succeeded');
    expect(job(onClaim.id).status).toBe('succeeded');
    const actions = t.ctx.repos.listAudit(t.ctx.db, {}).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['agents.pause', 'agents.resume']));
  });
});

describe('deadline guard', () => {
  it('drafts the standard letter without AI and raises Needs-you ai_paused when a clock is due within 24 h', async () => {
    const claimRes = await t.api<{ claim?: { id: string }; id?: string }>('POST', '/claims', FNOL);
    const claimId = (claimRes.body.claim?.id ?? claimRes.body.id)!;
    t.ctx.repos.replaceClocks(t.ctx.db, claimId, [
      { kind: 'chaser_day_7', label: 'Chaser 1 (day 7)', basis: 'CCGUK playbook', startsAt: '2026-09-28T09:00:00+01:00', dueAt: '2026-10-05T15:00:00+01:00', status: 'running' },
      { kind: 'chaser_day_14', label: 'Chaser 2 (day 14)', basis: 'CCGUK playbook', startsAt: '2026-09-28T09:00:00+01:00', dueAt: '2026-10-12T15:00:00+01:00', status: 'running' },
    ]);
    t.ctx.repos.pauseAi(t.ctx.db, { until: '2026-10-05T13:05:00.000Z', reason: 'usage_limited', now: T0 });
    const hb = await sup.tick(T0);
    await sup.worker.idle();
    expect(hb.deadlineGuard, JSON.stringify(hb.deadlineGuard)).toHaveLength(1);
    expect(hb.deadlineGuard[0]).toMatchObject({ claimId, clockKind: 'chaser_day_7' });
    const fallback = job(hb.deadlineGuard[0]!.jobId);
    expect(fallback.type).toBe('clocks.refresh');
    expect(fallback.status).toBe('succeeded');
    const items = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'ai_paused' });
    expect(items).toHaveLength(1);
    expect(items[0]!.claimId).toBe(claimId);
    expect(items[0]!.title).toMatch(/AI is paused until 14:05/);
    const payload = items[0]!.payload as { documentId: string | null; templateId: string };
    expect(payload.templateId).toBe('letter.chaser_7');
    if (payload.documentId) {
      expect(items[0]!.options.map((o) => o.id)).toEqual(['approve', 'dismiss']);
      expect(t.ctx.repos.getDocument(t.ctx.db, payload.documentId)?.templateId).toBe('letter.chaser_7');
    }
    // No AI run happened, and a second tick does not duplicate anything.
    expect(t.ctx.repos.listAgentRuns(t.ctx.db, {})).toHaveLength(0);
    await sup.tick('2026-10-05T09:05:00.000Z');
    await sup.worker.idle();
    // (Drafting recomputed the claim's real clocks, so other due clocks may now raise their own items.)
    const chaserItems = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'ai_paused' }).filter((i) => (i.payload as { clockKind: string }).clockKind === 'chaser_day_7');
    expect(chaserItems).toHaveLength(1);
  });

  it('does nothing while AI is available and the last review did not fail', async () => {
    const claimRes = await t.api<{ claim?: { id: string }; id?: string }>('POST', '/claims', FNOL);
    const claimId = (claimRes.body.claim?.id ?? claimRes.body.id)!;
    t.ctx.repos.replaceClocks(t.ctx.db, claimId, [{ kind: 'chaser_day_7', label: 'Chaser 1', basis: 'x', startsAt: '2026-09-28T09:00:00+01:00', dueAt: '2026-10-05T15:00:00+01:00', status: 'running' }]);
    const hb = await sup.tick(T0);
    expect(hb.deadlineGuard).toHaveLength(0);
  });
});

describe('schedules (London time)', () => {
  it('seeds idempotently and registers the supervisor on the context', () => {
    const n = listSchedules(t.ctx).length;
    seedSchedules(t.ctx);
    expect(listSchedules(t.ctx)).toHaveLength(n);
    expect(listSchedules(t.ctx).map((s) => s.id)).toEqual(expect.arrayContaining(['mail.sync', 'task.due', 'case.sweep.am', 'case.sweep.pm', 'dailylog.compile', 'clocks.refresh', 'watch.poll', 'retention.cleanup', 'index.fts']));
    expect(getSupervisor(t.ctx)).toBe(sup);
  });

  it('keeps 18:00 London across the October clock change and skips weekends for the sweep', () => {
    // Sat 24 Oct 2026 is BST; Sun 25 Oct the clocks go back.
    expect(nextRunAfter({ atLocal: '18:00' }, '2026-10-24T12:00:00.000Z')).toBe('2026-10-24T17:00:00.000Z');
    expect(nextRunAfter({ atLocal: '18:00' }, '2026-10-24T17:00:00.000Z')).toBe('2026-10-25T18:00:00.000Z');
    expect(nextRunAfter({ atLocal: '07:30', weekdays: [1, 2, 3, 4, 5] }, '2026-10-23T05:00:00.000Z')).toBe('2026-10-23T06:30:00.000Z');
    expect(nextRunAfter({ atLocal: '07:30', weekdays: [1, 2, 3, 4, 5] }, '2026-10-23T12:00:00.000Z')).toBe('2026-10-26T07:30:00.000Z');
    // Spring forward: 29 Mar 2026.
    expect(nextRunAfter({ atLocal: '02:15' }, '2026-03-28T12:00:00.000Z')).toBe('2026-03-29T01:15:00.000Z');
    expect(nextRunAfter({ everyMinutes: 5 }, '2026-10-05T09:02:10.000Z')).toBe('2026-10-05T09:05:00.000Z');
    expect(scheduleIdempotencyKey({ id: 'dailylog.compile', jobType: 'dailylog.compile' }, '2026-10-24T17:00:00.000Z')).toBe('dailylog.compile:2026-10-24');
    expect(scheduleIdempotencyKey({ id: 'case.sweep.am', jobType: 'case.sweep', payload: { slot: 'am' } }, '2026-10-26T07:30:00.000Z')).toBe('case.sweep:2026-10-26:am');
  });

  it('materialises the daily log at 18:00 BST and again at 18:00 GMT the next day', async () => {
    const t2 = await createTestApp('2026-10-24T12:00:00.000Z');
    try {
      const s2 = createSupervisor(t2.ctx, { handlers: [...systemJobHandlers, ...STUBS] });
      const daily = () => listSchedules(t2.ctx).find((s) => s.id === 'dailylog.compile')!;
      expect(daily().nextRunAt).toBe('2026-10-24T17:00:00.000Z');
      await s2.tick('2026-10-24T17:00:30.000Z');
      await s2.worker.idle();
      const logs = t2.ctx.repos.listAgentJobs(t2.ctx.db, { type: 'dailylog.compile' });
      expect(logs.map((j) => j.idempotencyKey)).toEqual(['dailylog.compile:2026-10-24']);
      expect(logs[0]!.status).toBe('succeeded');
      expect(t2.ctx.repos.getDailyLog(t2.ctx.db, '2026-10-24')).toBeDefined();
      expect(daily().nextRunAt).toBe('2026-10-25T18:00:00.000Z');
      // The weekday sweep is not due at the weekend.
      expect(listSchedules(t2.ctx).find((s) => s.id === 'case.sweep.am')!.nextRunAt).toBe('2026-10-26T07:30:00.000Z');
      await s2.stop();
    } finally {
      await t2.close();
    }
  });
});

describe('control-room and settings routes', () => {
  it('autonomy settings: validated, admin-only, always-ask entries refused', async () => {
    t.ctx.repos.createUser(t.ctx.db, { id: 'boss', name: 'Owner', email: 'boss@ccguk.local', role: 'admin', mfaEnabled: false });
    t.ctx.repos.createUser(t.ctx.db, { id: 'clerk', name: 'Clerk', email: 'clerk@ccguk.local', role: 'handler', mfaEnabled: false });
    const admin = { 'x-user-id': 'boss' };
    const got = await t.api<{ settings: { holdMinutes: number }; alwaysAsk: { templates: string[] }; templates: Array<{ id: string; alwaysAsk: boolean }> }>('GET', '/settings/autonomy');
    expect(got.body.settings.holdMinutes).toBe(10);
    expect(got.body.templates.find((x) => x.id === 'letter.letter_before_claim')?.alwaysAsk).toBe(true);
    expect((await t.api('PATCH', '/settings/autonomy', { holdMinutes: 15 }, { 'x-user-id': 'clerk' })).status).toBe(403);
    const bad = await t.api<{ error: { code: string } }>('PATCH', '/settings/autonomy', { autoSendTemplates: ['letter.chaser_7', 'letter.part36_offer'] }, admin);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('ALWAYS_ASK');
    expect((await t.api('PATCH', '/settings/autonomy', { autoSendEmailKinds: ['ack', 'offer_response'] }, admin)).status).toBe(400);
    expect((await t.api('PATCH', '/settings/autonomy', { thresholds: { external: 1.5 } }, admin)).status).toBe(400);
    expect((await t.api('PATCH', '/settings/autonomy', { autoApproveTemplates: ['letter.does_not_exist'] }, admin)).status).toBe(400);
    const ok = await t.api<{ settings: { holdMinutes: number; quietHours: unknown; killSwitch: boolean } }>('PATCH', '/settings/autonomy', { holdMinutes: 15, quietHours: null, killSwitch: true }, admin);
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toMatchObject({ holdMinutes: 15, quietHours: null, killSwitch: true });
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'agents.kill_switch' })).toHaveLength(1);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'autonomy.settings' }).length).toBeGreaterThan(0);
  });

  it('status, jobs, retry/cancel, schedules and review-now', async () => {
    const status = await t.api<{ agents: Array<{ name: string }>; lanes: Record<string, { limit: number }>; pill: { state: string } }>('GET', '/agents/status');
    expect(status.status).toBe(200);
    expect(status.body.agents.map((a) => a.name)).toContain('case_manager');
    expect(status.body.lanes.io!.limit).toBe(4);
    const claimRes = await t.api<{ claim: { id: string } }>('POST', '/claims', FNOL);
    const claimId = claimRes.body.claim.id;
    const review = await t.api<JobRecord>('POST', `/claims/${claimId}/agent/review-now`);
    expect(review.body).toMatchObject({ type: 'case.review', claimId, payload: { claimId, reason: 'owner' }, status: 'queued' });
    const cancelled = await t.api<JobRecord>('POST', `/agents/jobs/${review.body.id}/cancel`);
    expect(cancelled.body.status).toBe('cancelled');
    const retried = await t.api<JobRecord>('POST', `/agents/jobs/${review.body.id}/retry`);
    expect(retried.body.status).toBe('queued');
    const jobs = await t.api<{ items: JobRecord[]; total: number }>('GET', `/agents/jobs?type=case.review&claimId=${claimId}`);
    expect(jobs.body.total).toBe(2);
    const detail = await t.api<{ job: JobRecord; attempts: unknown[] }>('GET', `/agents/jobs/${review.body.id}`);
    expect(detail.body.job.id).toBe(review.body.id);
    const agentView = await t.api<{ jobs: JobRecord[]; state: { paused: boolean } }>('GET', `/claims/${claimId}/agent`);
    expect(agentView.body.state.paused).toBe(false);
    expect(agentView.body.jobs.length).toBe(2);
    const schedules = await t.api<{ items: Array<{ id: string; enabled: boolean }> }>('GET', '/agents/schedules');
    expect(schedules.body.items.length).toBe(9);
    const off = await t.api<{ enabled: boolean }>('PATCH', '/agents/schedules/watch.poll', { enabled: false });
    expect(off.body.enabled).toBe(false);
    const moved = await t.api<{ atLocal: string; nextRunAt: string }>('PATCH', '/agents/schedules/dailylog.compile', { atLocal: '17:30' });
    expect(moved.body).toMatchObject({ atLocal: '17:30', nextRunAt: '2026-10-05T16:30:00.000Z' });
    const now = await t.api<{ jobs: JobRecord[] }>('POST', '/agents/schedules/clocks.refresh/run-now');
    expect(now.body.jobs[0]!.type).toBe('clocks.refresh');
    // GET /jobs and POST /jobs/run keep working.
    const legacy = await t.api<{ jobs: Array<{ job: string; nextRunAt: string | null }> }>('GET', '/jobs');
    expect(legacy.body.jobs.map((j) => j.job)).toEqual(['watch_poll', 'clocks_refresh']);
    const run = await t.api<{ job: string }>('POST', '/jobs/run', { job: 'clocks_refresh' });
    expect(run.body.job).toBe('clocks_refresh');
  });
});
