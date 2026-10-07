/**
 * ClaimDesk Supreme phase 1 persistence (docs/SUPREME-DESIGN.md §N.1–N.4, §C.3, §C.7): fresh migrations, append-only
 * triggers, idempotent enqueue, leasing (priority/run_after order, claim lock, paused agents and claims), usage waits,
 * expired leases, Needs-you dedupe, audit run ids, settings defaults.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUTONOMY } from '@ccguk/domain';
import { closeDatabase, type DatabaseHandle } from './client.js';
import { createTestDatabase } from './testing.js';
import { appendAudit, listAudit } from './repos/audit.js';
import {
  appendAgentJobAttempt,
  cancelAgentJob,
  enqueueAgentJob,
  getAgentJob,
  insertAgentJob,
  leaseAgentJob,
  listAgentJobAttempts,
  listAgentJobs,
  markAgentJobFailed,
  markAgentJobSucceeded,
  releaseWaitingUsageJobs,
  requeueExpiredAgentJobs,
  resumeAgentJob,
  retryAgentJobAt,
  waitAgentJobUsage,
  waitAgentJobUser,
} from './repos/agentJobs.js';
import { appendAgentToolCall, finishAgentRun, getAgentRun, listAgentRuns, listAgentToolCalls, startAgentRun } from './repos/agentRuns.js';
import { countNeedsYou, createNeedsYouItem, listNeedsYou, listNeedsYouEvents, resolveNeedsYou, snoozeNeedsYou, transitionNeedsYou, wakeSnoozedNeedsYou } from './repos/needsYou.js';
import { completeTask, createTask, listDueTasks, rescheduleTask } from './repos/tasks.js';
import { appendReview, latestReviewFor } from './repos/reviews.js';
import { getDailyLog, upsertDailyLog } from './repos/dailyLogs.js';
import { appendNotificationDelivery, createNotification, listNotifications, markNotificationRead } from './repos/notifications.js';
import { getAgentSettings, patchAgentSettings } from './repos/agentSettings.js';
import { claimRunsToday, countClaimRun, getClaimAgentState, listPausedClaims, markClaimReviewed, pauseClaimAgents, resumeClaimAgents } from './repos/claimAgentState.js';
import { addAiCost, getAiUsageState, isAiPaused, pauseAi, setAiUsageSnapshot, unpauseAi } from './repos/aiUsage.js';

let h: DatabaseHandle;
beforeEach(() => {
  h = createTestDatabase();
});
afterEach(() => closeDatabase(h));

const T0 = '2026-10-07T09:00:00.000Z';
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();
const OWNER = { userId: 'courtesycars' };
const lease = (lane: 'ai' | 'io' | 'cpu', extra: Partial<Parameters<typeof leaseAgentJob>[1]> = {}) =>
  leaseAgentJob(h.db, { lane, maxPriority: 9, now: T0, owner: 'test', leaseMs: 60_000, ...extra });

describe('migrations 0008–0011', () => {
  it('creates every Supreme table, the FTS5 tables and audit_log.run_id', () => {
    const names = (h.sqlite.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const t of [
      'agent_jobs', 'agent_job_attempts', 'agent_schedules', 'agent_runs', 'agent_tool_calls', 'ai_usage_state', 'agent_settings', 'claim_agent_state',
      'needs_you', 'needs_you_events', 'tasks', 'reviews', 'notifications', 'daily_logs',
      'mail_accounts', 'mail_folder_state', 'mail_messages', 'mail_attachments', 'mail_matches', 'mail_classifications', 'outbox', 'outbox_events',
      'intake_items', 'intake_extractions', 'claim_update_proposals',
      'brain_packs', 'brain_pack_versions', 'brain_entries', 'brain_fts', 'search_docs', 'memory_items',
    ]) expect(names, t).toContain(t);
    const cols = (h.sqlite.prepare('pragma table_info(audit_log)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('run_id');
    expect((h.sqlite.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number }).n).toBe(12);
  });

  it('keeps brain_fts in sync with brain_entries (insert, update, delete)', () => {
    const ins = h.sqlite.prepare("insert into brain_entries (id, pack_id, version, kind, title, body, tags, business, data) values (?, 'p', '1', 'strategy', ?, ?, 'hire', '[\"ccguk\"]', '{}')");
    ins.run('e1', 'Hire rate challenges', 'When the insurer disputes the daily hire rate, cite the benchmark.');
    ins.run('e2', 'Storage', 'Storage charges accrue daily.');
    const match = (q: string) => (h.sqlite.prepare('select e.id from brain_fts f join brain_entries e on e.rowid_key = f.rowid where brain_fts match ? order by bm25(brain_fts)').all(q) as Array<{ id: string }>).map((r) => r.id);
    expect(match('disputes')).toEqual(['e1']);
    expect(match('charges')).toEqual(['e2']);
    h.sqlite.prepare("update brain_entries set body = 'Recovery charges' where id = 'e1'").run();
    expect(match('disputes')).toEqual([]);
    expect(match('recovery')).toEqual(['e1']);
    h.sqlite.prepare("delete from brain_entries where id = 'e2'").run();
    expect(match('storage')).toEqual([]);
  });

  it('search_docs is a porter-stemmed FTS5 table', () => {
    h.sqlite.prepare("insert into search_docs (title, body, claim_id, source_kind, source_id, at) values ('Email', 'The insurer is chasing the engineer reports', 'c1', 'email', 'm1', ?)").run(T0);
    expect(h.sqlite.prepare("select source_id from search_docs where search_docs match 'report' and claim_id = 'c1'").all()).toEqual([{ source_id: 'm1' }]);
  });

  it('brain_packs.kind accepts ccguk, playbook, learned, other only', () => {
    const ins = h.sqlite.prepare("insert into brain_packs (id, name, kind, business, precedence, created_at, updated_at) values (?, 'n', ?, '[]', 10, ?, ?)");
    for (const k of ['ccguk', 'playbook', 'learned', 'other']) ins.run(`p-${k}`, k, T0, T0);
    expect(() => ins.run('bad', 'danny', T0, T0)).toThrow(/CHECK/);
  });
});

describe('append-only tables refuse UPDATE and DELETE', () => {
  const seed: Record<string, string> = {
    agent_job_attempts: "insert into agent_job_attempts (id, job_id, attempt, started_at, outcome) values ('x', 'j', 1, '2026-10-07', 'ok')",
    agent_tool_calls: "insert into agent_tool_calls (id, run_id, seq, tool, action_class, decision, at) values ('x', 'r', 1, 'claim_get', 'read', 'allowed', '2026-10-07')",
    needs_you_events: "insert into needs_you_events (id, needs_you_id, to_status, actor, at) values ('x', 'n', 'open', 'agent:mail', '2026-10-07')",
    reviews: "insert into reviews (id, target_kind, target_id, loop, rules, facts, verdict, touches, created_at) values ('x', 'outbox', 'o', 0, '{}', '{}', 'pass', '{}', '2026-10-07')",
    mail_matches: "insert into mail_matches (id, mail_message_id, score, signals, decided_by, decided_at) values ('x', 'm', 100, '[]', 'auto', '2026-10-07')",
    mail_classifications: "insert into mail_classifications (id, mail_message_id, intent, secondary, confidence, extracted, summary, injection, deterministic, created_at) values ('x', 'm', 'other', '[]', 0.5, '{}', 's', '{}', '{}', '2026-10-07')",
    outbox_events: "insert into outbox_events (id, outbox_id, to_status, actor, at) values ('x', 'o', 'draft', 'agent:mail', '2026-10-07')",
    intake_extractions: "insert into intake_extractions (id, intake_item_id, schema_id, fields, warnings, created_at) values ('x', 'i', 'intake_extraction', '[]', '[]', '2026-10-07')",
  };
  it.each(Object.keys(seed))('%s', (table) => {
    h.sqlite.exec(seed[table]!);
    expect(() => h.sqlite.prepare(`update ${table} set id = 'y' where id = 'x'`).run()).toThrow(`${table} is append-only`);
    expect(() => h.sqlite.prepare(`delete from ${table} where id = 'x'`).run()).toThrow(`${table} is append-only`);
    expect(h.sqlite.prepare(`select count(*) as n from ${table}`).get()).toEqual({ n: 1 });
  });
});

describe('agent job queue', () => {
  it('enqueue is idempotent on the idempotency key and fills defaults from the job type', () => {
    const a = insertAgentJob(h.db, { type: 'mail.triage', payload: { messageId: 'm1' }, idempotencyKey: 'mail.triage:m1', createdBy: 'system', now: T0 });
    const b = insertAgentJob(h.db, { type: 'mail.triage', payload: { messageId: 'OTHER' }, idempotencyKey: 'mail.triage:m1', createdBy: 'system', now: at(5) });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(b.job.payload).toEqual({ messageId: 'm1' });
    expect(a.job).toMatchObject({ agent: 'mail', lane: 'ai', mutates: true, priority: 1, status: 'queued', attempts: 0, maxAttempts: 3, depth: 0, runAfter: T0 });
    expect(a.job.correlationId).toBe(a.job.id);
    // Without a key every enqueue is a new job.
    const c = enqueueAgentJob(h.db, { type: 'mail.sync', payload: {}, createdBy: 'system', now: T0 });
    const d = enqueueAgentJob(h.db, { type: 'mail.sync', payload: {}, createdBy: 'system', now: T0 });
    expect(c.id).not.toBe(d.id);
    expect(listAgentJobs(h.db, { type: 'mail.triage' })).toHaveLength(1);
  });

  it('leases by priority, then run_after, only when due, within the priority gate, per lane', () => {
    const low = enqueueAgentJob(h.db, { type: 'case.review', payload: {}, priority: 5, runAfter: at(-30), createdBy: 'system', now: at(-30) });
    const highLate = enqueueAgentJob(h.db, { type: 'case.review', payload: {}, priority: 1, runAfter: at(-5), createdBy: 'system', now: at(-30) });
    const highEarly = enqueueAgentJob(h.db, { type: 'case.review', payload: {}, priority: 1, runAfter: at(-10), createdBy: 'system', now: at(-30) });
    const future = enqueueAgentJob(h.db, { type: 'case.review', payload: {}, priority: 0, runAfter: at(10), createdBy: 'system', now: at(-30) });
    enqueueAgentJob(h.db, { type: 'mail.sync', payload: {}, createdBy: 'system', now: at(-30) });
    expect(lease('ai')?.id).toBe(highEarly.id);
    expect(lease('ai')?.id).toBe(highLate.id);
    expect(lease('ai', { maxPriority: 3 })).toBeUndefined();
    const l = lease('ai');
    expect(l).toMatchObject({ id: low.id, status: 'leased', attempts: 1, leaseOwner: 'test', leaseUntil: at(1) });
    expect(lease('ai')).toBeUndefined();
    expect(getAgentJob(h.db, future.id)?.status).toBe('queued');
    expect(lease('ai', { now: at(10) })?.id).toBe(future.id);
    expect(lease('io')?.type).toBe('mail.sync');
  });

  it('holds a claim lock: no second claim-mutating job of the same claim while one is leased', () => {
    const m1 = enqueueAgentJob(h.db, { type: 'mail.ingest', claimId: 'c1', payload: {}, createdBy: 'system', now: at(-3) });
    const m2 = enqueueAgentJob(h.db, { type: 'intake.apply', claimId: 'c1', payload: {}, createdBy: 'system', now: at(-2) });
    const ro = enqueueAgentJob(h.db, { type: 'outbox.after_review', claimId: 'c1', payload: {}, createdBy: 'system', now: at(-1), priority: 3 });
    const other = enqueueAgentJob(h.db, { type: 'intake.apply', claimId: 'c2', payload: {}, createdBy: 'system', now: at(-1) });
    expect(m1.mutates).toBe(true);
    expect(ro.mutates).toBe(false);
    expect(lease('io')?.id).toBe(m1.id);
    // m2 (same claim, mutating) is skipped; the non-mutating job and the other claim's job can run.
    const next = [lease('io')?.id, lease('io')?.id].sort();
    expect(next).toEqual([ro.id, other.id].sort());
    expect(lease('io')).toBeUndefined();
    markAgentJobSucceeded(h.db, m1.id, { result: { ok: true }, now: T0 });
    expect(lease('io')?.id).toBe(m2.id);
  });

  it('skips paused agents and paused claims (list and claim_agent_state)', () => {
    const triage = enqueueAgentJob(h.db, { type: 'mail.triage', payload: {}, createdBy: 'system', now: at(-3) });
    const review = enqueueAgentJob(h.db, { type: 'case.review', claimId: 'c1', payload: {}, createdBy: 'system', now: at(-2) });
    const review2 = enqueueAgentJob(h.db, { type: 'case.review', claimId: 'c2', payload: {}, createdBy: 'system', now: at(-1) });
    pauseClaimAgents(h.db, 'c1', { actor: OWNER, reason: 'checking', now: T0 });
    expect(lease('ai', { pausedAgents: ['mail'], pausedClaims: ['c2'] })).toBeUndefined();
    expect(lease('ai', { pausedAgents: ['mail'] })?.id).toBe(review2.id);
    expect(lease('ai')?.id).toBe(triage.id);
    expect(lease('ai')).toBeUndefined();
    resumeClaimAgents(h.db, 'c1', { actor: OWNER, now: T0 });
    expect(lease('ai')?.id).toBe(review.id);
    expect(listAudit(h.db, { action: 'agents.pause' })).toHaveLength(1);
  });

  it('waitUsage does not use up the attempt; release puts it back when due', () => {
    enqueueAgentJob(h.db, { type: 'case.review', payload: {}, createdBy: 'system', now: T0 });
    const l = lease('ai')!;
    expect(l.attempts).toBe(1);
    const w = waitAgentJobUsage(h.db, l.id, { until: at(30), reason: 'five_hour limit', now: T0 });
    expect(w).toMatchObject({ status: 'waiting_usage', attempts: 0, runAfter: at(30) });
    expect(w.leaseOwner).toBeUndefined();
    expect(releaseWaitingUsageJobs(h.db, at(29))).toBe(0);
    expect(lease('ai', { now: at(31) })).toBeUndefined();
    expect(releaseWaitingUsageJobs(h.db, at(30))).toBe(1);
    expect(lease('ai', { now: at(31) })).toMatchObject({ id: l.id, attempts: 1 });
  });

  it('requeues expired leases (attempt used) and kills jobs with no attempts left', () => {
    const a = enqueueAgentJob(h.db, { type: 'case.review', payload: {}, createdBy: 'system', now: T0, maxAttempts: 2 });
    const b = enqueueAgentJob(h.db, { type: 'case.review', payload: {}, createdBy: 'system', now: T0, maxAttempts: 1, priority: 2 });
    lease('ai');
    lease('ai');
    expect(requeueExpiredAgentJobs(h.db, at(0.5))).toEqual([]);
    const affected = requeueExpiredAgentJobs(h.db, at(2));
    expect(affected.map((j) => [j.id, j.status]).sort()).toEqual([[a.id, 'queued'], [b.id, 'dead']].sort());
    expect(getAgentJob(h.db, a.id)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(getAgentJob(h.db, a.id)?.leaseUntil).toBeUndefined();
  });

  it('retry, fail, wait for the owner, resume, cancel; attempts are append-only rows', () => {
    const j = enqueueAgentJob(h.db, { type: 'draft.compose', payload: {}, createdBy: 'system', now: T0, maxAttempts: 2 });
    lease('ai');
    appendAgentJobAttempt(h.db, { jobId: j.id, attempt: 1, startedAt: T0, finishedAt: at(1), outcome: 'retry', error: 'flaky' });
    expect(retryAgentJobAt(h.db, j.id, { runAfter: at(5), error: 'flaky', now: at(1) })).toMatchObject({ status: 'queued', runAfter: at(5) });
    lease('ai', { now: at(5) });
    expect(retryAgentJobAt(h.db, j.id, { runAfter: at(10), error: 'flaky again', now: at(6) })).toMatchObject({ status: 'dead', error: 'flaky again' });
    expect(listAgentJobAttempts(h.db, j.id)).toHaveLength(1);

    const k = enqueueAgentJob(h.db, { type: 'case.review', payload: {}, createdBy: 'system', now: T0 });
    lease('ai');
    expect(waitAgentJobUser(h.db, k.id, { needsYouId: 'n1', now: T0 })).toMatchObject({ status: 'waiting_user', needsYouId: 'n1' });
    expect(resumeAgentJob(h.db, k.id, { now: at(1) })).toMatchObject({ status: 'queued', runAfter: at(1) });
    expect(cancelAgentJob(h.db, k.id, { reason: 'owner', now: at(2) })).toMatchObject({ status: 'cancelled', finishedAt: at(2) });
    expect(markAgentJobFailed(h.db, j.id, { error: 'x', deadLetter: true }).status).toBe('dead');
    expect(cancelAgentJob(h.db, j.id).status).toBe('dead');
  });
});

describe('agent runs and tool calls', () => {
  it('records a run, its tool calls (sequence + counter) and the outcome', () => {
    const r = startAgentRun(h.db, { id: 'run-1', jobId: 'j1', agent: 'mail', jobType: 'mail.reply', claimId: 'c1', driver: 'fake', model: 'claude-opus-5-5', effort: 'medium', promptVersion: 'pv', inputSha256: 'abc', startedAt: T0 });
    expect(r).toMatchObject({ id: 'run-1', toolCalls: 0 });
    appendAgentToolCall(h.db, { runId: 'run-1', tool: 'claim_brief', actionClass: 'read', decision: 'allowed', durationMs: 4, at: T0 });
    appendAgentToolCall(h.db, { runId: 'run-1', tool: 'email_draft', actionClass: 'draft', decision: 'allowed', ruleIds: ['read_draft'], inputRedacted: { to: ['h***@insurer.example'] }, at: T0 });
    expect(listAgentToolCalls(h.db, 'run-1').map((c) => [c.seq, c.tool])).toEqual([[1, 'claim_brief'], [2, 'email_draft']]);
    const done = finishAgentRun(h.db, 'run-1', { outcome: 'ok', endedAt: at(1), numTurns: 3, inputTokens: 1800, outputTokens: 240, result: { ok: true } });
    expect(done).toMatchObject({ outcome: 'ok', toolCalls: 2, numTurns: 3, result: { ok: true } });
    expect(getAgentRun(h.db, 'run-1')?.endedAt).toBe(at(1));
    expect(listAgentRuns(h.db, { claimId: 'c1' })).toHaveLength(1);
  });
});

describe('needs you', () => {
  const base = { kind: 'approve_send' as const, title: 'Approve the reply', summary: 'x', payload: { outboxId: 'o1' }, priority: 'normal' as const, createdBy: 'agent:mail' };

  it('dedupes on dedupe_key while open or snoozed, and allows a new item once resolved', () => {
    const a = createNeedsYouItem(h.db, { ...base, dedupeKey: 'approve_send:o1', now: T0 });
    const b = createNeedsYouItem(h.db, { ...base, title: 'again', dedupeKey: 'approve_send:o1', now: at(1) });
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, item: { id: a.item.id, title: 'Approve the reply' } });
    snoozeNeedsYou(h.db, a.item.id, { until: at(60), actor: 'courtesycars', now: at(2) });
    expect(createNeedsYouItem(h.db, { ...base, dedupeKey: 'approve_send:o1' }).created).toBe(false);
    resolveNeedsYou(h.db, a.item.id, { actor: 'courtesycars', optionId: 'approve', now: at(3) });
    const c = createNeedsYouItem(h.db, { ...base, dedupeKey: 'approve_send:o1', now: at(4) });
    expect(c.created).toBe(true);
    expect(c.item.id).not.toBe(a.item.id);
  });

  it('lists urgent first, counts by priority, logs every transition, wakes snoozed items', () => {
    createNeedsYouItem(h.db, { ...base, priority: 'low', now: T0 });
    const urgent = createNeedsYouItem(h.db, { ...base, kind: 'offer_decision', priority: 'urgent', now: at(1) }).item;
    const normal = createNeedsYouItem(h.db, { ...base, now: at(2) }).item;
    expect(listNeedsYou(h.db, { status: 'open' }).map((i) => i.priority)).toEqual(['urgent', 'normal', 'low']);
    expect(countNeedsYou(h.db)).toEqual({ total: 3, byPriority: { urgent: 1, high: 0, normal: 1, low: 1 } });
    snoozeNeedsYou(h.db, normal.id, { until: at(30), actor: 'courtesycars', now: at(3) });
    expect(countNeedsYou(h.db).total).toBe(2);
    expect(wakeSnoozedNeedsYou(h.db, at(29))).toHaveLength(0);
    expect(wakeSnoozedNeedsYou(h.db, at(30)).map((i) => i.id)).toEqual([normal.id]);
    const r = resolveNeedsYou(h.db, urgent.id, { actor: 'courtesycars', optionId: 'open_offer', note: 'will decide', now: at(4) });
    expect(r).toMatchObject({ status: 'resolved', resolvedBy: 'courtesycars', resolvedAt: at(4), resolution: { optionId: 'open_offer', note: 'will decide' } });
    expect(() => transitionNeedsYou(h.db, urgent.id, { to: 'open', actor: 'x' })).toThrow(/cannot move/);
    expect(listNeedsYouEvents(h.db, normal.id).map((e) => [e.fromStatus ?? null, e.toStatus, e.actor])).toEqual([
      [null, 'open', 'agent:mail'],
      ['open', 'snoozed', 'courtesycars'],
      ['snoozed', 'open', 'system'],
    ]);
  });
});

describe('audit run ids', () => {
  it('writes run_id and filters by run id and user id prefix', () => {
    appendAudit(h.db, { actor: { userId: 'agent:mail', ip: '127.0.0.1', runId: 'run-9' }, action: 'event.append', entity: 'claim_events', entityId: 'e1', at: T0 });
    appendAudit(h.db, { actor: { userId: 'agent:case_manager', runId: 'run-10' }, action: 'task.create', entity: 'tasks', entityId: 't1', at: T0 });
    appendAudit(h.db, { actor: { userId: 'courtesycars' }, action: 'claim.patch', entity: 'claims', entityId: 'c1', at: T0 });
    expect(h.sqlite.prepare("select run_id from audit_log where entity_id = 'e1'").get()).toEqual({ run_id: 'run-9' });
    expect(listAudit(h.db, { runId: 'run-9' }).map((a) => [a.userId, a.runId])).toEqual([['agent:mail', 'run-9']]);
    expect(listAudit(h.db, { userIdPrefix: 'agent:' })).toHaveLength(2);
    expect(listAudit(h.db, { userIdPrefix: 'agent_' })).toHaveLength(0);
    expect(listAudit(h.db, { entityId: 'c1' })[0]!.runId).toBeUndefined();
  });
});

describe('tasks, reviews, daily logs, notifications', () => {
  it('tasks: create, due, reschedule, complete', () => {
    const t = createTask(h.db, { claimId: 'c1', kind: 'chaser', title: 'Chase handling ref', dueAt: at(60), createdBy: 'agent:case_manager', sourceRunId: 'run-1', now: T0 });
    expect(listDueTasks(h.db, at(59))).toHaveLength(0);
    rescheduleTask(h.db, t.id, at(30));
    expect(listDueTasks(h.db, at(30)).map((x) => x.id)).toEqual([t.id]);
    expect(completeTask(h.db, t.id, OWNER, at(31))).toMatchObject({ status: 'done', completedBy: 'courtesycars' });
    expect(() => completeTask(h.db, t.id, OWNER)).toThrow(/already done/);
  });
  it('reviews: latestFor returns the highest loop', () => {
    const touches = { money: false, liability: false, settlement: false, legal: false, newCommitment: false };
    appendReview(h.db, { targetKind: 'outbox', targetId: 'o1', loop: 0, rules: { flags: [] }, facts: {}, verdict: 'repair', touches, now: T0 });
    const pass = appendReview(h.db, { targetKind: 'outbox', targetId: 'o1', loop: 1, rules: { flags: [] }, facts: {}, critic: { verdict: 'pass' }, verdict: 'pass', touches, runId: 'r2', now: at(1) });
    expect(latestReviewFor(h.db, { kind: 'outbox', id: 'o1' })).toMatchObject({ id: pass.id, verdict: 'pass', loop: 1, runId: 'r2', touches });
    expect(latestReviewFor(h.db, { kind: 'document', id: 'o1' })).toBeUndefined();
  });
  it('daily logs upsert by day', () => {
    upsertDailyLog(h.db, { day: '2026-10-07', log: { headline: 'one' }, compiledAt: T0 });
    upsertDailyLog(h.db, { day: '2026-10-07', log: { headline: 'two' }, compiledAt: at(5) });
    expect(getDailyLog(h.db, '2026-10-07')).toEqual({ day: '2026-10-07', compiledAt: at(5), log: { headline: 'two' } });
  });
  it('notifications: create, deliver, read', () => {
    const n = createNotification(h.db, { level: 'normal', title: 'Offer received on CCG-2026-00012', body: 'Open ClaimDesk', channels: ['in_app', 'toast'], now: T0 });
    appendNotificationDelivery(h.db, n.id, { channel: 'toast', at: T0, ok: true });
    expect(listNotifications(h.db, { unreadOnly: true })[0]).toMatchObject({ id: n.id, deliveries: [{ channel: 'toast', ok: true }] });
    markNotificationRead(h.db, n.id, at(1));
    expect(listNotifications(h.db, { unreadOnly: true })).toHaveLength(0);
  });
});

describe('settings, claim state, AI usage', () => {
  it('agent settings default from @ccguk/domain, merge patches and audit them', () => {
    const s = getAgentSettings(h.db);
    expect(s.autonomy).toEqual(DEFAULT_AUTONOMY);
    expect(s.ai.driver).toBe('off');
    expect(s.agents.enabled).toBe(false);
    const p = patchAgentSettings(h.db, { autonomy: { killSwitch: true, limits: { perHour: 5 } }, ai: { driver: 'subscription_cli' } }, OWNER, T0);
    expect(p.autonomy).toMatchObject({ killSwitch: true, limits: { perClaimPerDay: 3, perHour: 5, perDay: 100 }, holdMinutes: 10 });
    expect(getAgentSettings(h.db)).toMatchObject({ ai: { driver: 'subscription_cli', lanes: { ai: 1 } }, autonomy: { killSwitch: true }, updatedBy: 'courtesycars' });
    patchAgentSettings(h.db, { autonomy: { quietHours: null } }, OWNER, at(1));
    expect(getAgentSettings(h.db).autonomy.quietHours).toBeNull();
    expect(listAudit(h.db, { action: 'autonomy.settings' })).toHaveLength(2);
    expect(listAudit(h.db, { action: 'ai.settings' })).toHaveLength(1);
    // No change → no audit row.
    patchAgentSettings(h.db, { autonomy: { killSwitch: true } }, OWNER, at(2));
    expect(listAudit(h.db, { action: 'autonomy.settings' })).toHaveLength(2);
  });

  it('claim agent state: pause, review mark, daily run counter', () => {
    expect(getClaimAgentState(h.db, 'c1')).toEqual({ claimId: 'c1', paused: false, runsToday: 0 });
    pauseClaimAgents(h.db, 'c1', { actor: OWNER, now: T0 });
    expect(listPausedClaims(h.db)).toEqual(['c1']);
    markClaimReviewed(h.db, 'c1', { runId: 'r1', at: T0 });
    expect(getClaimAgentState(h.db, 'c1')).toMatchObject({ paused: true, lastReviewRunId: 'r1' });
    expect(countClaimRun(h.db, 'c1', '2026-10-07')).toBe(1);
    expect(countClaimRun(h.db, 'c1', '2026-10-07')).toBe(2);
    expect(claimRunsToday(h.db, 'c1', '2026-10-08')).toBe(0);
    expect(countClaimRun(h.db, 'c1', '2026-10-08')).toBe(1);
  });

  it('AI usage: snapshots, pause/unpause, daily cost', () => {
    expect(getAiUsageState(h.db)).toEqual({ driver: 'off', costTodayUsd: 0 });
    setAiUsageSnapshot(h.db, { driver: 'subscription_cli', fiveHour: { status: 'allowed', utilization: 0.4 }, now: T0 });
    const p = pauseAi(h.db, { until: at(30), reason: 'usage_limited five_hour', now: T0 });
    expect(p).toMatchObject({ driver: 'subscription_cli', pausedUntil: at(30), fiveHour: { utilization: 0.4 } });
    expect(isAiPaused(p, at(29))).toBe(true);
    expect(isAiPaused(p, at(30))).toBe(false);
    expect(unpauseAi(h.db, at(31)).pausedUntil).toBeUndefined();
    addAiCost(h.db, { usd: 1.5, day: '2026-10-07' });
    expect(addAiCost(h.db, { usd: 2, day: '2026-10-07' }).costTodayUsd).toBe(3.5);
    expect(addAiCost(h.db, { usd: 1, day: '2026-10-08' }).costTodayUsd).toBe(1);
  });
});
