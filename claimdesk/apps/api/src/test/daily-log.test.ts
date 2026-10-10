/**
 * Daily log (docs/SUPREME-DESIGN.md §J.2): a fixture day with agent audit rows, runs, an automatic send, Needs-you
 * items, a done task and clocks → counts, sections and a deterministic headline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, FNOL, type TestApp } from './helpers.js';
import { compileDailyLog, dailyHeadline, londonDayBounds } from '../agent/dailyLog.js';
import { createNeedsYou } from '../agent/core.js';

const DAY = '2026-10-05';
const T = (hhmm: string): string => `2026-10-05T${hhmm}:00.000Z`; // UTC (BST = +1)

let t: TestApp;
let claimId: string;
let reference: string;
beforeEach(async () => {
  t = await createTestApp('2026-10-05T17:30:00.000Z');
  const res = await t.api<{ claim: { id: string; reference: string } }>('POST', '/claims', FNOL);
  claimId = res.body.claim.id;
  reference = res.body.claim.reference;
});
afterEach(async () => {
  await t.close();
});

function fixtureDay(): void {
  const { repos, db, handle } = t.ctx;
  // Agent writes (and one the day before, which must not count).
  repos.appendAudit(db, { actor: { userId: 'agent:mail', runId: 'run-mail' }, action: 'agent.policy', entity: 'outbox', entityId: 'ob-1', after: { tool: 'send_request', outcome: 'auto_held', ruleIds: ['external_ok'], reasons: ['allow-listed ack to a verified handler'] }, at: T('10:00') });
  repos.appendAudit(db, { actor: { userId: 'agent:mail', runId: 'run-mail' }, action: 'event.append', entity: 'events', entityId: 'ev-1', after: { claimId, type: 'email_in' }, at: T('10:01') });
  repos.appendAudit(db, { actor: { userId: 'agent:drafter', runId: 'run-draft' }, action: 'document.create', entity: 'documents', entityId: 'doc-1', after: { claimId, templateId: 'letter.chaser_7' }, at: T('11:00') });
  repos.appendAudit(db, { actor: { userId: 'agent:intake', runId: 'run-intake' }, action: 'proposal.apply', entity: 'vehicles', entityId: 'veh-1', after: { claimId, target: 'vehicle:client.vin' }, at: T('12:00') });
  repos.appendAudit(db, { actor: { userId: 'agent:case_manager', runId: 'run-cm' }, action: 'agent.tool.denied', entity: 'agent_tool_calls', entityId: 'tc-1', after: { tool: 'offer_decide', rule: 'money_settlement', message: 'agents never decide offers' }, at: T('13:00') });
  repos.appendAudit(db, { actor: { userId: 'agent:mail' }, action: 'event.append', entity: 'events', entityId: 'ev-old', after: { claimId }, at: '2026-10-04T22:30:00.000Z' });
  repos.appendAudit(db, { actor: { userId: 'handler' }, action: 'event.append', entity: 'events', entityId: 'ev-human', after: { claimId }, at: T('14:00') });
  // Runs: one ok, one usage-limited.
  repos.startAgentRun(db, { id: 'run-mail', jobId: 'j1', agent: 'mail', jobType: 'mail.reply', claimId, driver: 'fake', model: 'claude-opus-5-5', effort: 'medium', promptVersion: 'v1', inputSha256: 'x', startedAt: T('09:59') });
  repos.finishAgentRun(db, 'run-mail', { outcome: 'ok', endedAt: T('10:02'), rateLimit: { status: 'allowed', type: 'five_hour', utilization: 0.42 }, costUsd: 0 });
  repos.startAgentRun(db, { id: 'run-cm', jobId: 'j2', agent: 'case_manager', jobType: 'case.review', claimId, driver: 'fake', model: 'claude-opus-5-5', effort: 'medium', promptVersion: 'v1', inputSha256: 'y', startedAt: T('12:59') });
  repos.finishAgentRun(db, 'run-cm', { outcome: 'usage_limited', endedAt: T('13:01'), error: 'five-hour window' });
  // Outbox: an automatic send (held then sent) and an undone one.
  const ins = handle.sqlite.prepare(
    `INSERT INTO outbox (id, claim_id, account_id, kind, to_json, cc_json, bcc_json, subject, body_text, attachments_json, policy, status, created_by, created_at, updated_at)
     VALUES (@id, @claimId, 'acc', @kind, @to, '[]', '[]', 'Re: claim', 'Thank you', '[]', @policy, @status, 'agent:mail', @at, @at)`,
  );
  ins.run({ id: 'ob-1', claimId, kind: 'ack', to: JSON.stringify(['handler@insurer.example']), policy: JSON.stringify({ outcome: 'auto_held', ruleIds: ['external_ok'], reasons: ['allow-listed'] }), status: 'sent', at: T('10:00') });
  ins.run({ id: 'ob-2', claimId, kind: 'chaser', to: JSON.stringify(['handler@insurer.example']), policy: JSON.stringify({ outcome: 'auto_held', ruleIds: ['external_ok'], reasons: [] }), status: 'cancelled', at: T('15:00') });
  const ev = handle.sqlite.prepare(`INSERT INTO outbox_events (id, outbox_id, from_status, to_status, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  ev.run('e1', 'ob-1', 'draft', 'held', 'agent:mail', null, T('10:00'));
  ev.run('e2', 'ob-1', 'held', 'sent', 'agent:mail', null, T('10:10'));
  ev.run('e3', 'ob-2', 'held', 'cancelled', 'handler', 'undo', T('15:05'));
  // Needs-you: one resolved today, one still open.
  const resolved = createNeedsYou(t.ctx, { kind: 'question', claimId, title: 'Which address?', summary: 's', payload: {}, priority: 'normal', createdBy: 'agent:case_manager' });
  repos.resolveNeedsYou(db, resolved.id, { actor: 'handler', optionId: 'answer', now: T('16:00') });
  createNeedsYou(t.ctx, { kind: 'missing_info', claimId, title: 'V5C needed', summary: 's', payload: {}, priority: 'high', createdBy: 'agent:mail' });
  // A task done today.
  const task = repos.createTask(db, { claimId, kind: 'chaser', title: 'Chase insurer', dueAt: T('09:00'), createdBy: 'agent:case_manager', now: T('08:00') });
  repos.completeTask(db, task.id, { userId: 'handler' }, T('11:30'));
  // Clocks: one met today, one due tomorrow morning.
  repos.replaceClocks(db, claimId, [
    { kind: 'gta_4_1_ncaf_1wd', label: 'NCAF within 1 working day', basis: 'GTA 4.1', startsAt: '2026-10-04T09:00:00+01:00', dueAt: '2026-10-05T17:00:00+01:00', status: 'met', metAt: '2026-10-05T11:00:00+01:00' },
    { kind: 'chaser_day_7', label: 'Chaser 1 (day 7)', basis: 'CCGUK playbook', startsAt: '2026-09-29T09:00:00+01:00', dueAt: '2026-10-06T10:00:00+01:00', status: 'running' },
    { kind: 'chaser_day_14', label: 'Chaser 2 (day 14)', basis: 'CCGUK playbook', startsAt: '2026-09-29T09:00:00+01:00', dueAt: '2026-10-20T10:00:00+01:00', status: 'running' },
  ]);
  // Usage pause 13:01–13:31 UTC.
  repos.appendAudit(db, { actor: { userId: 'agent:supervisor' }, action: 'ai.pause', entity: 'ai_usage_state', entityId: 'default', after: { until: T('13:31'), reason: 'usage_limited' }, at: T('13:01') });
}

describe('daily log', () => {
  it('London day bounds follow BST/GMT', () => {
    expect(londonDayBounds('2026-10-05')).toEqual({ start: '2026-10-04T23:00:00.000Z', end: '2026-10-05T23:00:00.000Z' });
    expect(londonDayBounds('2026-10-25')).toEqual({ start: '2026-10-24T23:00:00.000Z', end: '2026-10-26T00:00:00.000Z' });
  });

  it('counts and sections for a fixture day', () => {
    fixtureDay();
    const log = compileDailyLog(t.ctx, DAY);
    expect(log.day).toBe(DAY);
    expect(log.counts).toMatchObject({
      emailsSent: 1,
      autoSent: 1,
      undone: 1,
      drafts: 1,
      fieldsPrefilled: 1,
      needsYouResolved: 1,
      tasksDone: 1,
      deadlinesMet: 1,
      deadlinesAtRisk: 1,
      aiRuns: 2,
      aiFailures: 1,
      usagePausedMinutes: 30,
    });
    expect(log.counts.needsYouOpened).toBeGreaterThanOrEqual(2);
    expect(log.sections.sentAutomatically).toHaveLength(1);
    expect(log.sections.sentAutomatically[0]).toMatchObject({ claimId, reference, agent: 'mail', ruleIds: ['external_ok'], link: '/outbox/ob-1' });
    expect(log.sections.sentAutomatically[0]!.text).toMatch(/handler@insurer\.example/);
    // Only agent rows from this day; policy/tool rows are not "updated records"; the human row is excluded.
    const updated = log.sections.updatedRecords;
    expect(updated.map((u) => u.agent).sort()).toEqual(['drafter', 'intake', 'mail']);
    expect(updated.find((u) => u.agent === 'mail')).toMatchObject({ ruleIds: ['external_ok'], why: 'allow-listed ack to a verified handler', reference });
    expect(updated.find((u) => u.agent === 'mail')!.text).toBe(`chronology event on ${reference}`);
    expect(log.sections.waitingForYou.map((w) => w.text)).toContain('V5C needed');
    expect(log.sections.deadlines.map((d) => d.text)).toEqual(['Met: NCAF within 1 working day', 'Due soon: Chaser 1 (day 7)']);
    const problems = log.sections.problems.map((p) => p.text);
    expect(problems).toEqual(expect.arrayContaining(['case.review run ended: usage_limited', 'Refused: offer_decide']));
    expect(log.sections.usage).toMatchObject({ fiveHourPeak: 0.42 });
    expect(log.headline).toBe(dailyHeadline(log.counts, log.sections.waitingForYou.length));
    expect(log.headline).toMatch(/sent 1 email automatically \(1 undone\)/);
    expect(log.headline).toMatch(/1 item needs you/);
  });

  it('is stored by the compile route and served by GET /daily-log', async () => {
    fixtureDay();
    const compiled = await t.api<{ stored: boolean; log: { counts: { autoSent: number } } }>('POST', '/daily-log/compile', { day: DAY });
    expect(compiled.status).toBe(200);
    expect(compiled.body.stored).toBe(true);
    const got = await t.api<{ stored: boolean; log: { counts: { autoSent: number } } }>('GET', `/daily-log?day=${DAY}`);
    expect(got.body).toMatchObject({ stored: true, log: { counts: { autoSent: 1 } } });
    const days = await t.api<{ items: Array<{ day: string }> }>('GET', '/daily-log/days');
    expect(days.body.items.map((d) => d.day)).toEqual([DAY]);
    // A day with nothing stored is compiled on the fly (not stored).
    const other = await t.api<{ stored: boolean; log: { headline: string } }>('GET', '/daily-log?day=2026-10-01');
    expect(other.body.stored).toBe(false);
    expect(other.body.log.headline).toMatch(/nothing to do automatically/);
  });
});
