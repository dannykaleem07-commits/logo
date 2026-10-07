/**
 * Needs-you (docs/SUPREME-DESIGN.md §C.7, §D.4): the resolver runs as the signed-in owner, resolution is audited as
 * the owner, edits become correction proposals through the casework callback, the waiting job resumes, and snooze
 * wakes up again. No model is involved.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { createNeedsYou, enqueueJob } from '../agent/core.js';
import { resolveNeedsYouItem, type CorrectionInput } from '../agent/needsYou.js';
import { getTool } from '../agent/tools/index.js';
import { strictSchemaProblems } from '@ccguk/domain';
import type { RunContext } from '../agent/contracts.js';

const T0 = '2026-10-05T09:00:00.000Z';
const OWNER = 'owner-1';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp(T0);
  t.ctx.repos.createUser(t.ctx.db, { id: OWNER, name: 'Owner', email: 'owner@ccguk.local', role: 'admin', mfaEnabled: false });
});
afterEach(async () => {
  await t.close();
});

const asOwner = { 'x-user-id': OWNER };

describe('resolve', () => {
  it('runs the kind resolver as the signed-in owner and audits the owner', async () => {
    const dead = enqueueJob(t.ctx, { type: 'mail.sync', payload: {}, createdBy: 'test', idempotencyKey: 'd1' });
    t.ctx.repos.markAgentJobFailed(t.ctx.db, dead.id, { error: 'boom', deadLetter: true, now: T0 });
    const item = createNeedsYou(t.ctx, {
      kind: 'failure',
      title: 'An agent job failed',
      summary: 'boom',
      options: [
        { id: 'retry', label: 'Retry', tone: 'primary' },
        { id: 'dismiss', label: 'Dismiss', tone: 'neutral' },
      ],
      payload: { jobId: dead.id },
      priority: 'high',
      createdBy: 'agent:supervisor',
    });
    const res = await t.api<{ item: { status: string; resolvedBy: string } }>('POST', `/needs-you/${item.id}/resolve`, { optionId: 'retry', note: 'try again' }, asOwner);
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ status: 'resolved', resolvedBy: OWNER });
    // The resolver's own effect, written as the owner.
    expect(t.ctx.repos.getAgentJob(t.ctx.db, dead.id)).toMatchObject({ status: 'queued', attempts: 0 });
    const retry = t.ctx.repos.listAudit(t.ctx.db, { action: 'agents.job.retry' });
    expect(retry[0]!.userId).toBe(OWNER);
    const resolve = t.ctx.repos.listAudit(t.ctx.db, { action: 'needs_you.resolve' });
    expect(resolve).toHaveLength(1);
    expect(resolve[0]!.userId).toBe(OWNER);
    expect(resolve[0]!.after).toMatchObject({ needsYouId: item.id, optionId: 'retry', note: 'try again' });
    const events = t.ctx.repos.listNeedsYouEvents(t.ctx.db, item.id);
    expect(events.map((e) => [e.toStatus, e.actor])).toEqual([
      ['open', 'agent:supervisor'],
      ['resolved', OWNER],
    ]);
    // Already resolved → 409.
    const again = await t.api('POST', `/needs-you/${item.id}/resolve`, { optionId: 'retry' }, asOwner);
    expect(again.status).toBe(409);
  });

  it('refuses agents and the system, unknown options and a missing reason', async () => {
    const item = createNeedsYou(t.ctx, {
      kind: 'question',
      title: 'Which address?',
      summary: 'Two addresses on file',
      options: [
        { id: 'answer', label: 'Answer', tone: 'primary', requiresReason: true },
        { id: 'dismiss', label: 'Dismiss', tone: 'neutral' },
      ],
      payload: {},
      priority: 'normal',
      createdBy: 'agent:case_manager',
    });
    await expect(resolveNeedsYouItem(t.ctx, item.id, { optionId: 'dismiss' }, { userId: 'agent:case_manager' })).rejects.toMatchObject({ code: 'HUMAN_REQUIRED' });
    await expect(resolveNeedsYouItem(t.ctx, item.id, { optionId: 'dismiss' }, { userId: 'system' })).rejects.toMatchObject({ code: 'HUMAN_REQUIRED' });
    expect((await t.api('POST', `/needs-you/${item.id}/resolve`, { optionId: 'nope' }, asOwner)).status).toBe(400);
    expect((await t.api('POST', `/needs-you/${item.id}/resolve`, { optionId: 'answer' }, asOwner)).status).toBe(400);
    expect((await t.api('POST', `/needs-you/${item.id}/resolve`, { optionId: 'answer', note: 'Use the Reading one' }, asOwner)).status).toBe(200);
  });

  it('re-queues the job waiting for the owner and records edits as a correction proposal', async () => {
    const corrections: CorrectionInput[] = [];
    (t.ctx.services as { recordCorrection?: (ctx: unknown, c: CorrectionInput) => void }).recordCorrection = (_ctx, c) => corrections.push(c);
    const waiting = enqueueJob(t.ctx, { type: 'case.review', payload: { claimId: 'c1' }, claimId: 'c1', createdBy: 'test', idempotencyKey: 'w1' });
    const item = createNeedsYou(t.ctx, {
      kind: 'question',
      claimId: 'c1',
      title: 'Confirm the hire end date',
      summary: 'Is it 12 October?',
      options: [{ id: 'answer', label: 'Answer', tone: 'primary' }],
      payload: { proposed: { hireEnd: '2026-10-12' } },
      priority: 'normal',
      createdBy: 'agent:case_manager',
      resumesJobId: waiting.id,
    });
    t.ctx.repos.leaseAgentJob(t.ctx.db, { lane: 'ai', maxPriority: 99, now: T0, owner: 'w', leaseMs: 60_000 });
    t.ctx.repos.waitAgentJobUser(t.ctx.db, waiting.id, { needsYouId: item.id, now: T0 });
    expect(t.ctx.repos.getAgentJob(t.ctx.db, waiting.id)?.status).toBe('waiting_user');
    const res = await t.api('POST', `/needs-you/${item.id}/resolve`, { optionId: 'answer', edits: { hireEnd: '2026-10-14' }, note: 'It ended on the 14th' }, asOwner);
    expect(res.status).toBe(200);
    expect(t.ctx.repos.getAgentJob(t.ctx.db, waiting.id)?.status).toBe('queued');
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({ needsYouId: item.id, kind: 'question', claimId: 'c1', before: { proposed: { hireEnd: '2026-10-12' } }, after: { hireEnd: '2026-10-14' }, actor: { userId: OWNER } });
    const audit = t.ctx.repos.listAudit(t.ctx.db, { action: 'needs_you.resolve' })[0]!;
    expect(audit.after).toMatchObject({ edited: true, correctionRecorded: true, resumedJobs: [waiting.id] });
    expect(t.ctx.repos.getNeedsYouItem(t.ctx.db, item.id)?.resolution).toMatchObject({ optionId: 'answer', edits: { hireEnd: '2026-10-14' } });
  });
});

describe('snooze and listing', () => {
  it('snoozes, hides from the badge, and wakes when the time comes', async () => {
    const item = createNeedsYou(t.ctx, { kind: 'question', title: 'Q', summary: 'S', payload: {}, priority: 'urgent', createdBy: 'agent:case_manager' });
    let count = await t.api<{ total: number; urgent: number }>('GET', '/needs-you/count');
    expect(count.body).toMatchObject({ total: 1, urgent: 1 });
    const res = await t.api<{ item: { status: string; snoozedUntil: string } }>('POST', `/needs-you/${item.id}/snooze`, { minutes: 60 }, asOwner);
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ status: 'snoozed', snoozedUntil: '2026-10-05T10:00:00.000Z' });
    count = await t.api('GET', '/needs-you/count');
    expect(count.body).toMatchObject({ total: 0, urgent: 0 });
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'needs_you.snooze' })[0]!.userId).toBe(OWNER);
    t.ctx.repos.wakeSnoozedNeedsYou(t.ctx.db, '2026-10-05T10:00:00.000Z');
    expect(t.ctx.repos.getNeedsYouItem(t.ctx.db, item.id)?.status).toBe('open');
    expect((await t.api('POST', `/needs-you/${item.id}/snooze`, { minutes: 0 }, asOwner)).status).toBe(400);
  });

  it('lists open items urgent first with the claim reference, and returns detail with events', async () => {
    createNeedsYou(t.ctx, { kind: 'question', title: 'Low', summary: 'S', payload: {}, priority: 'low', createdBy: 'agent:x' });
    const urgent = createNeedsYou(t.ctx, { kind: 'spoof_warning', title: 'Urgent', summary: 'S', payload: {}, priority: 'urgent', createdBy: 'agent:mail' });
    const list = await t.api<{ items: Array<{ id: string; priority: string }>; count: { total: number } }>('GET', '/needs-you');
    expect(list.body.items[0]!.id).toBe(urgent.id);
    expect(list.body.count.total).toBe(2);
    const filtered = await t.api<{ items: unknown[] }>('GET', '/needs-you?kind=spoof_warning');
    expect(filtered.body.items).toHaveLength(1);
    const detail = await t.api<{ item: { id: string }; events: unknown[]; resolverRegistered: boolean }>('GET', `/needs-you/${urgent.id}`);
    expect(detail.body.item.id).toBe(urgent.id);
    expect(detail.body.events).toHaveLength(1);
    expect((await t.api('GET', '/needs-you/does-not-exist')).status).toBe(404);
  });
});

describe('needs_you_create tool', () => {
  it('is a strict draft-class tool that creates an item as agent:<name>, deduplicated per run chain', async () => {
    const tool = getTool('needs_you_create')!;
    expect(tool.class).toBe('draft');
    expect(strictSchemaProblems(tool.strictSchema)).toEqual([]);
    const rc: RunContext = { runId: 'run-1', jobId: 'job-1', agent: 'case_manager', claimScope: 'claim-9', token: 'x', allowedTools: new Set(['needs_you_create']), runDir: '/tmp/none', correlationId: 'corr-1' };
    const input = tool.input.parse({ kind: 'missing_info', title: 'V5C needed', summary: 'The insurer asked for the V5C; it is not on file.', recommendation: null, draftRefs: [{ kind: 'outbox', id: 'ob-1' }], priority: 'high', dueAt: null });
    const out = await tool.run!(input, rc, t.ctx);
    expect(out).toMatchObject({ status: 'created' });
    const again = await tool.run!(input, rc, t.ctx);
    expect(again).toMatchObject({ status: 'existing', needsYouId: (out as { needsYouId: string }).needsYouId });
    const item = t.ctx.repos.getNeedsYouItem(t.ctx.db, (out as { needsYouId: string }).needsYouId)!;
    expect(item).toMatchObject({ kind: 'missing_info', claimId: 'claim-9', createdBy: 'agent:case_manager', correlationId: 'corr-1', priority: 'high' });
    expect(item.options.map((o) => o.id)).toEqual(['approve', 'edit', 'reject']);
    expect(tool.describe(input, rc, t.ctx)).toMatchObject({ class: 'draft', kind: 'needs_you.missing_info', claimId: 'claim-9' });
    // Kinds owned by other slices' resolvers cannot be raised through this tool.
    expect(tool.input.safeParse({ ...input, kind: 'approve_send' }).success).toBe(false);
  });
});
