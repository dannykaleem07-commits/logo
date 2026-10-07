/**
 * Queue runtime (docs/SUPREME-DESIGN.md §C.3, §C.4): lanes and concurrency, the per-claim lock, retries with backoff,
 * wait_usage without consuming an attempt, dead-letter → Needs-you, the hand-off loop guard and idempotent follow-ups.
 * Handlers are stubs — no model is ever called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { JobType, Lane } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import type { JobHandler, JobOutcome, JobRecord, JobContext } from '../agent/contracts.js';
import { enqueueJob } from '../agent/core.js';
import { startWorker, type Worker } from '../agent/worker.js';
import { openGates } from '../agent/queue.js';
import { systemJobHandlers } from '../agent/handlers/system.js';
import { laneLimits, retryDelayMs, RETRY_BASE_MS } from '../agent/budgets.js';

const T0 = '2026-10-05T09:00:00.000Z';

interface Deferred {
  promise: Promise<JobOutcome>;
  resolve(o: JobOutcome): void;
}
function deferred(): Deferred {
  let resolve!: (o: JobOutcome) => void;
  const promise = new Promise<JobOutcome>((r) => (resolve = r));
  return { promise, resolve };
}

type RunFn = (jc: JobContext<Record<string, unknown>>) => Promise<JobOutcome>;

function stub(type: JobType, lane: Lane, agent: JobHandler['agent'], run: RunFn, extra: Partial<JobHandler> = {}): JobHandler<Record<string, unknown>, unknown> {
  return { type, lane, agent, usesAi: lane === 'ai', mutatesClaim: false, payload: z.object({}).passthrough(), defaultPriority: 3, maxAttempts: 3, timeoutMs: 5_000, run, ...extra } as JobHandler<Record<string, unknown>, unknown>;
}

const done: RunFn = async () => ({ kind: 'done', result: { ok: true } });

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp(T0);
});
afterEach(async () => {
  await t.close();
});

const job = (id: string): JobRecord => t.ctx.repos.getAgentJob(t.ctx.db, id) as JobRecord;
const enqueue = (type: JobType, extra: Record<string, unknown> = {}): JobRecord => enqueueJob(t.ctx, { type, payload: {}, createdBy: 'test', ...extra });

describe('lanes and concurrency', () => {
  it('fills each lane up to its limit (ai 1 on the subscription, io 4, cpu 2)', async () => {
    const gates: Deferred[] = [];
    const block: RunFn = () => {
      const d = deferred();
      gates.push(d);
      return d.promise;
    };
    const w = startWorker(t.ctx, { owner: 'w1', handlers: [stub('case.review', 'ai', 'case_manager', block), stub('mail.sync', 'io', 'mail', block), stub('index.fts', 'cpu', 'researcher', block)] });
    for (let i = 0; i < 3; i++) enqueue('case.review', { idempotencyKey: `cr${i}` });
    for (let i = 0; i < 6; i++) enqueue('mail.sync', { idempotencyKey: `ms${i}` });
    for (let i = 0; i < 3; i++) enqueue('index.fts', { idempotencyKey: `fts${i}` });
    const started = w.fill(T0, openGates());
    const byLane = (l: Lane) => started.filter((j) => j.lane === l).length;
    expect(byLane('ai')).toBe(1);
    expect(byLane('io')).toBe(4);
    expect(byLane('cpu')).toBe(2);
    expect(w.running()).toHaveLength(7);
    // Nothing more fits until something finishes.
    expect(w.fill(T0, openGates())).toHaveLength(0);
    gates.forEach((g) => g.resolve({ kind: 'done', result: null }));
    await w.idle();
    expect(w.running()).toHaveLength(0);
  });

  it('uses 3 AI slots by default in API mode and honours a saved value', async () => {
    const s = t.ctx.repos.getAgentSettings(t.ctx.db);
    expect(laneLimits({ ...s, ai: { ...s.ai, driver: 'api_key' } }).lanes.ai).toBe(3);
    expect(laneLimits({ ...s, ai: { ...s.ai, driver: 'api_key', lanes: { ...s.ai.lanes, ai: 5 } } }).lanes.ai).toBe(5);
    expect(laneLimits({ ...s, ai: { ...s.ai, driver: 'api_key', lanes: { ...s.ai.lanes, ai: 9 } } }).lanes.ai).toBe(6);
    expect(laneLimits({ ...s, ai: { ...s.ai, driver: 'subscription_cli' } }).lanes.ai).toBe(1);
    expect(laneLimits({ ...s, ai: { ...s.ai, driver: 'subscription_cli', lanes: { ...s.ai.lanes, ai: 9 } } }).lanes.ai).toBe(3);
    expect(laneLimits({ ...s, ai: { ...s.ai, driver: 'api_key' } }).agentCaps).toEqual({});
    t.ctx.repos.patchAgentSettings(t.ctx.db, { ai: { driver: 'api_key' } }, { userId: 'test' });
    const block: RunFn = () => deferred().promise;
    const w = startWorker(t.ctx, { owner: 'w1', handlers: [stub('case.review', 'ai', 'case_manager', block)] });
    for (let i = 0; i < 4; i++) enqueue('case.review', { idempotencyKey: `cr${i}` });
    expect(w.fill(T0, openGates())).toHaveLength(3);
  });

  it('applies per-agent caps on the AI lane in subscription mode', async () => {
    t.ctx.repos.patchAgentSettings(t.ctx.db, { ai: { driver: 'subscription_cli', lanes: { ai: 3 } } }, { userId: 'test' });
    const block: RunFn = () => deferred().promise;
    const w = startWorker(t.ctx, { owner: 'w1', handlers: [stub('mail.triage', 'ai', 'mail', block), stub('case.review', 'ai', 'case_manager', block)] });
    enqueue('mail.triage', { idempotencyKey: 'a' });
    enqueue('mail.triage', { idempotencyKey: 'b' });
    enqueue('case.review', { idempotencyKey: 'c' });
    const started = w.fill(T0, openGates());
    expect(started.map((j) => j.type).sort()).toEqual(['case.review', 'mail.triage']);
  });

  it('respects the priority gate of a lane', async () => {
    const w = startWorker(t.ctx, { owner: 'w1', handlers: [stub('case.review', 'ai', 'case_manager', done)] });
    enqueue('case.review', { idempotencyKey: 'low', priority: 6 });
    const gates = openGates();
    gates.lanes.ai.maxPriority = 5;
    expect(await w.tick(T0, gates)).toHaveLength(0);
    gates.lanes.ai.maxPriority = 6;
    expect(await w.tick(T0, gates)).toHaveLength(1);
  });
});

describe('claim lock', () => {
  it('runs one claim-mutating job per claim at a time', async () => {
    const pending = new Map<string, Deferred>();
    const block: RunFn = ({ job: j }) => {
      const d = deferred();
      pending.set(j.id, d);
      return d.promise;
    };
    const w = startWorker(t.ctx, { owner: 'w1', handlers: [stub('mail.ingest', 'io', 'mail', block, { mutatesClaim: true }), stub('outbox.after_review', 'io', 'mail', block)] });
    const a1 = enqueue('mail.ingest', { claimId: 'claim-A', idempotencyKey: 'a1' });
    const a2 = enqueue('mail.ingest', { claimId: 'claim-A', idempotencyKey: 'a2' });
    const b1 = enqueue('mail.ingest', { claimId: 'claim-B', idempotencyKey: 'b1' });
    const nonMut = enqueue('outbox.after_review', { claimId: 'claim-A', idempotencyKey: 'n1' });
    const started = w.fill(T0, openGates()).map((j) => j.id);
    expect(started).toContain(a1.id);
    expect(started).toContain(b1.id);
    expect(started).toContain(nonMut.id);
    expect(started).not.toContain(a2.id);
    expect(w.fill(T0, openGates())).toHaveLength(0);
    pending.get(a1.id)!.resolve({ kind: 'done', result: null });
    await new Promise((r) => setTimeout(r, 10));
    expect(w.fill(T0, openGates()).map((j) => j.id)).toEqual([a2.id]);
    pending.forEach((p) => p.resolve({ kind: 'done', result: null }));
    await w.idle();
  });
});

describe('outcomes', () => {
  it('retries with exponential backoff and jitter, then dead-letters with a Needs-you failure', async () => {
    const w = startWorker(t.ctx, { owner: 'w1', random: () => 0.5, handlers: [stub('mail.sync', 'io', 'mail', async () => ({ kind: 'retry', afterMs: 0, reason: 'imap busy' }))] });
    const j = enqueue('mail.sync', { idempotencyKey: 'r', maxAttempts: 3 });
    await w.tick(T0);
    expect(job(j.id)).toMatchObject({ status: 'queued', attempts: 1, error: 'imap busy' });
    expect(job(j.id).runAfter).toBe(new Date(Date.parse(T0) + RETRY_BASE_MS).toISOString());
    // Not due yet.
    expect(await w.tick(T0)).toHaveLength(0);
    const t2 = job(j.id).runAfter;
    await w.tick(t2);
    expect(job(j.id).runAfter).toBe(new Date(Date.parse(T0) + 2 * RETRY_BASE_MS).toISOString());
    await w.tick(job(j.id).runAfter);
    expect(job(j.id).status).toBe('dead');
    const attempts = t.ctx.repos.listAgentJobAttempts(t.ctx.db, j.id);
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(attempts.every((a) => a.outcome === 'retry')).toBe(true);
    const items = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'failure' });
    expect(items).toHaveLength(1);
    expect(items[0]!.payload).toMatchObject({ jobId: j.id, type: 'mail.sync' });
    expect(items[0]!.options.map((o) => o.id)).toContain('retry');
  });

  it('backoff grows and never undercuts the handler hint', () => {
    expect(retryDelayMs(1, 0, () => 0.5)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(3, 0, () => 0.5)).toBe(4 * RETRY_BASE_MS);
    expect(retryDelayMs(1, 10 * 60_000, () => 0.5)).toBe(10 * 60_000);
    const lo = retryDelayMs(2, 0, () => 0);
    const hi = retryDelayMs(2, 0, () => 0.999);
    expect(lo).toBeLessThan(hi);
  });

  it('a thrown error and a timeout are retried as failed attempts', async () => {
    const w = startWorker(t.ctx, {
      owner: 'w1',
      random: () => 0.5,
      handlers: [
        stub('mail.sync', 'io', 'mail', async () => {
          throw new Error('boom');
        }),
        stub('index.fts', 'cpu', 'researcher', () => new Promise<JobOutcome>(() => undefined), { timeoutMs: 20 }),
      ],
    });
    const a = enqueue('mail.sync', { idempotencyKey: 'x' });
    const b = enqueue('index.fts', { idempotencyKey: 'y' });
    const res = await w.tick(T0);
    expect(res.map((r) => r.outcome).sort()).toEqual(['error', 'timeout']);
    expect(job(a.id)).toMatchObject({ status: 'queued', attempts: 1, error: 'boom' });
    expect(job(b.id).status).toBe('queued');
    expect(job(b.id).error).toMatch(/timed out/);
  });

  it('wait_usage returns the job without using an attempt and pauses the AI lane until reset + 2 min', async () => {
    const until = '2026-10-05T09:30:00.000Z';
    const w = startWorker(t.ctx, { owner: 'w1', handlers: [stub('case.review', 'ai', 'case_manager', async () => ({ kind: 'wait_usage', until }))] });
    const j = enqueue('case.review', { idempotencyKey: 'u', maxAttempts: 1 });
    await w.tick(T0);
    const after = job(j.id);
    expect(after.status).toBe('waiting_usage');
    expect(after.attempts).toBe(0);
    expect(after.runAfter).toBe('2026-10-05T09:32:00.000Z');
    expect(t.ctx.repos.getAiUsageState(t.ctx.db)).toMatchObject({ pausedUntil: '2026-10-05T09:32:00.000Z', pauseReason: 'usage_limited' });
    expect(t.ctx.repos.listAgentJobAttempts(t.ctx.db, j.id)[0]?.outcome).toBe('wait_usage');
    // Released when the time comes; maxAttempts 1 still allows the real attempt.
    expect(t.ctx.repos.releaseWaitingUsageJobs(t.ctx.db, '2026-10-05T09:32:00.000Z')).toBe(1);
    const w2 = startWorker(t.ctx, { owner: 'w2', handlers: [stub('case.review', 'ai', 'case_manager', done)] });
    await w2.tick('2026-10-05T09:32:00.000Z');
    expect(job(j.id).status).toBe('succeeded');
  });

  it('wait_user parks the job on the Needs-you item', async () => {
    const w = startWorker(t.ctx, { owner: 'w1', handlers: [stub('mail.reply', 'ai', 'mail', async () => ({ kind: 'wait_user', needsYouId: 'ny-1' }))] });
    const j = enqueue('mail.reply', { idempotencyKey: 'wu' });
    await w.tick(T0);
    expect(job(j.id)).toMatchObject({ status: 'waiting_user', needsYouId: 'ny-1' });
  });

  it('fail with deadLetter → dead + Needs-you failure; plain fail → failed without one', async () => {
    const w = startWorker(t.ctx, {
      owner: 'w1',
      handlers: [stub('mail.sync', 'io', 'mail', async () => ({ kind: 'fail', reason: 'mailbox gone', deadLetter: true })), stub('index.fts', 'cpu', 'researcher', async () => ({ kind: 'fail', reason: 'nothing to index' }))],
    });
    const a = enqueue('mail.sync', { idempotencyKey: 'f1' });
    const b = enqueue('index.fts', { idempotencyKey: 'f2' });
    await w.tick(T0);
    expect(job(a.id).status).toBe('dead');
    expect(job(b.id).status).toBe('failed');
    const items = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'failure' });
    expect(items.map((i) => (i.payload as { jobId: string }).jobId)).toEqual([a.id]);
    // A Needs-you item queues its notification.
    expect(t.ctx.repos.listAgentJobs(t.ctx.db, { type: 'notify.dispatch' })).toHaveLength(1);
  });

  it('an invalid payload is dead-lettered without running the handler', async () => {
    let ran = false;
    const h = stub('mail.sync', 'io', 'mail', async () => {
      ran = true;
      return { kind: 'done', result: null };
    });
    h.payload = z.object({ accountId: z.string() });
    const w = startWorker(t.ctx, { owner: 'w1', handlers: [h] });
    const j = enqueue('mail.sync', { idempotencyKey: 'bad' });
    await w.tick(T0);
    expect(ran).toBe(false);
    expect(job(j.id).status).toBe('dead');
  });
});

describe('follow-ups', () => {
  it('carry the correlation id and depth + 1, and are idempotent on their key', async () => {
    const w = startWorker(t.ctx, {
      owner: 'w1',
      handlers: [stub('mail.triage', 'ai', 'mail', async ({ job: j }) => ({ kind: 'done', result: null, followUps: [{ type: 'case.review', payload: { claimId: 'c1', reason: 'inbound' }, claimId: 'c1', idempotencyKey: 'case.review:c1:inbound:m1', createdBy: `agent:${j.agent}` }] }))],
    });
    const p1 = enqueue('mail.triage', { idempotencyKey: 'mail.triage:m1' });
    const p2 = enqueue('mail.triage', { idempotencyKey: 'mail.triage:m1-dup' });
    await w.tick(T0);
    await w.tick(T0);
    const children = t.ctx.repos.listAgentJobs(t.ctx.db, { type: 'case.review' });
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ parentJobId: p1.id, correlationId: p1.correlationId, depth: 1 });
    expect(job(p2.id).status).toBe('succeeded');
  });

  it('the loop guard stops a chain deeper than 6 and raises one Needs-you failure', async () => {
    let n = 0;
    const w = startWorker(t.ctx, {
      owner: 'w1',
      handlers: [...systemJobHandlers, stub('research.ask', 'ai', 'researcher', async () => ({ kind: 'done', result: null, followUps: [{ type: 'research.ask', payload: {}, idempotencyKey: `loop:${++n}`, createdBy: 'agent:researcher' }] }))],
    });
    const root = enqueue('research.ask', { idempotencyKey: 'loop:0' });
    for (let i = 0; i < 10; i++) await w.tick(T0);
    const chain = t.ctx.repos.listAgentJobs(t.ctx.db, { correlationId: root.correlationId, limit: 50 });
    const deepest = chain.reduce((m, j) => Math.max(m, j.depth), 0);
    expect(deepest).toBe(7);
    const stopped = chain.find((j) => j.depth === 7)!;
    expect(stopped.status).toBe('dead');
    expect(stopped.error).toMatch(/loop guard/);
    const items = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'failure' });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toMatch(/loop/i);
  });
});

describe('missing handler and kill switch', () => {
  it('a job type without a handler is stopped once with one Needs-you per type', async () => {
    const w: Worker = startWorker(t.ctx, { owner: 'w1', handlers: systemJobHandlers });
    enqueue('mail.sync', { idempotencyKey: 'n1' });
    enqueue('mail.sync', { idempotencyKey: 'n2' });
    await w.tick(T0);
    expect(t.ctx.repos.countAgentJobs(t.ctx.db, { status: 'dead' })).toBe(2);
    expect(t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'failure' })).toHaveLength(1);
  });

  it('kill switch: an outbox release is given back without using its attempt', async () => {
    let ran = false;
    const w = startWorker(t.ctx, {
      owner: 'w1',
      handlers: [
        stub('outbox.release', 'io', 'mail', async () => {
          ran = true;
          return { kind: 'done', result: null };
        }),
      ],
    });
    const j = enqueue('outbox.release', { idempotencyKey: 'rel' });
    const gates = openGates();
    gates.killSwitch = true;
    await w.tick(T0, gates);
    expect(ran).toBe(false);
    expect(job(j.id)).toMatchObject({ status: 'waiting_usage', attempts: 0 });
  });
});
