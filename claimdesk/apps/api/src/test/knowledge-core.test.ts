// owned by knowledge-core
/**
 * Knowledge Builder core (docs/SUPREME-KNOWLEDGE-BUILDER.md §4, §9, §10, §12.3, §14): the store decides with
 * decideKnowledge, records every change twice (knowledge_changes + audit_log), only a person approves or records a
 * check (store, route and DB), the learned pack versions and rolls back, the digest lists automatic learning with an
 * Undo, the kill switch holds proposals, and the gateway/runAgent wiring (knowledge block, usage hook, web refusal)
 * works. Every insurer, contact and figure here is invented; no model and no network are used.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JOB_TYPES, JOB_TYPE_INFO, KNOWLEDGE_JOB_TYPES, NEEDS_YOU_KINDS, type KnowledgeProposal } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { mintRunToken } from '../agent/principal.js';
import { enqueueJob } from '../agent/core.js';
import { resolveNeedsYouItem } from '../agent/needsYou.js';
import { getJobHandler, getNeedsYouResolver } from '../agent/handlers/index.js';
import { DEFAULT_SCHEDULES, runDueSchedules, seedSchedules } from '../agent/scheduler.js';
import { compileDailyLog } from '../agent/dailyLog.js';
import { runAgent } from '../agent/runAgent.js';
import { assemblePrompts } from '../ai/prompts.js';
import type { AgentSpec, JobRecord } from '../agent/contracts.js';
import { approveKnowledge, proposeKnowledge, recordCheck, activeLearnedRules } from '../knowledge/store.js';
import { publishLearnedPack } from '../knowledge/publish.js';
import { registerKnowledgeHooks } from '../knowledge/hooks.js';
import { getKnowledgeSettings } from '../knowledge/settings.js';

const NOW = '2026-10-10T10:00:00.000Z';
let t: TestApp;

beforeEach(async () => {
  t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake' } });
});
afterEach(async () => {
  await t.close();
});

const profile = (slug = 'example-insurer', n = 12): KnowledgeProposal => ({
  kind: 'insurer_profile',
  area: 'statistics',
  title: `${slug} — 12-month profile`,
  body: `Median 21 working days to pay (n=${n}).`,
  data: { insurerSlug: slug, window: '12m', minN: 3, computedAt: NOW, n: { claims: n, settled: n - 2 }, daysToPay: { medianWorkingDays: 21, p90WorkingDays: 40, n: n - 2 }, heads: {}, objections: [], docsRequested: [], gta: { subscriberClaims: 0, hirePaidAtGtaRatePct: null, firstNotificationDisputePct: null }, responseHours: { median: null, n: 0 }, chasersBeforePay: { median: null, n: 0 } },
  tags: [],
  scope: { kind: 'insurer', slug },
  business: ['ccguk'],
  useLimit: 'internal',
  origin: 'computed',
  confidence: 1,
  supportN: n,
  provenance: [{ kind: 'claim_stats', n, claimIds: [], computedAt: NOW, method: 'nearest-rank' }],
  createdBy: 'agent:supervisor',
});

const procedure = (title = 'Example Insurer portal uploads', over: Partial<KnowledgeProposal> = {}): KnowledgeProposal => ({
  kind: 'procedure',
  area: 'procedural',
  title,
  body: 'Upload the payment pack through the portal, then email the handler the portal reference.',
  data: { steps: ['Log in to the portal', 'Upload the pack', 'Email the portal reference'], forWhom: 'insurer', channel: 'portal', insurerSlug: 'example-insurer' },
  tags: ['portal'],
  scope: { kind: 'insurer', slug: 'example-insurer' },
  business: ['ccguk'],
  useLimit: 'internal',
  origin: 'observed',
  confidence: 0.9,
  supportN: 2,
  provenance: [],
  createdBy: 'agent:supervisor',
  ...over,
});

const legalPoint = (): KnowledgeProposal => ({
  kind: 'fact',
  area: 'legal',
  title: 'Invented point about notice periods',
  body: 'An invented legal point used only in tests.',
  data: { statement: 'An invented legal point used only in tests.', figure: null, asOf: null, benchmarkOnly: false, kbCheck: null, stat: null },
  tags: [],
  scope: { kind: 'global' },
  business: ['ccguk'],
  useLimit: 'outbound_ok',
  origin: 'researched',
  confidence: 0.9,
  supportN: 1,
  provenance: [{ kind: 'snapshot', snapshotId: 'snap-1', url: 'https://www.legislation.gov.uk/invented', fetchedAt: NOW, quote: 'invented quote', anchor: null, quoteMatch: 'exact' }],
  createdBy: 'agent:researcher',
});

const runPublish = async (createdBy = 'agent:supervisor') => {
  const job = enqueueJob(t.ctx, { type: 'knowledge.publish', payload: { reason: 'test' }, idempotencyKey: `test-publish-${Math.random()}`, createdBy });
  return getJobHandler('knowledge.publish')!.run({ ctx: t.ctx, job, payload: { reason: 'test' }, signal: new AbortController().signal, log: t.ctx.logger });
};
const changes = (action: string) => t.ctx.repos.listKnowledgeChanges(t.ctx.db, { action });
const audits = (action: string) => t.ctx.repos.listAudit(t.ctx.db, { action });

describe('registries and vocabulary', () => {
  it('the knowledge job types and schedules exist; core registers publish and the knowledge_review resolver', () => {
    const knowledgeJobs = JOB_TYPES.filter((j) => j.startsWith('knowledge.'));
    expect([...knowledgeJobs].sort()).toEqual(['knowledge.consolidate', 'knowledge.curate', 'knowledge.drift', 'knowledge.fetch', 'knowledge.gap_scan', 'knowledge.learn_stats', 'knowledge.observe', 'knowledge.publish', 'knowledge.replay', 'knowledge.replay_drafts', 'knowledge.research', 'knowledge.research_web', 'knowledge.watch']);
    expect([...KNOWLEDGE_JOB_TYPES].sort()).toEqual([...knowledgeJobs].sort());
    for (const j of knowledgeJobs) expect(JOB_TYPE_INFO[j].mutatesClaim, j).toBe(false); // no knowledge job takes the per-claim lock
    const publish = getJobHandler('knowledge.publish')!;
    expect(publish).toMatchObject({ lane: 'cpu', agent: 'supervisor', defaultPriority: 5, usesAi: false, mutatesClaim: false });
    expect(NEEDS_YOU_KINDS).toContain('knowledge_review');
    expect(getNeedsYouResolver('knowledge_review')).toBeDefined();
    const scheduled = new Set(DEFAULT_SCHEDULES.map((s) => s.jobType));
    for (const j of ['knowledge.observe', 'knowledge.consolidate', 'knowledge.learn_stats', 'knowledge.curate', 'knowledge.gap_scan', 'knowledge.watch', 'knowledge.publish', 'knowledge.replay', 'knowledge.drift'] as const) expect(scheduled.has(j), j).toBe(true);
    expect(seedSchedules(t.ctx).some((s) => s.id === 'knowledge.publish')).toBe(true);
  });

  it('the schedules of slices not built yet are advanced without a job; publish runs', () => {
    seedSchedules(t.ctx, '2026-10-09T00:00:00.000Z');
    const runs = runDueSchedules(t.ctx, NOW);
    const observe = runs.find((r) => r.scheduleId === 'knowledge.observe')!;
    expect(observe).toMatchObject({ jobs: [], skipped: 'no handler registered' });
    const publish = runs.find((r) => r.scheduleId === 'knowledge.publish')!;
    expect(publish.jobs[0]).toMatchObject({ type: 'knowledge.publish', idempotencyKey: 'knowledge.publish:nightly:2026-10-09' }); // the missed 02:30 slot of the 9th
  });
});

describe('proposeKnowledge', () => {
  it('auto-applies computed statistics (KN-14), records changes and audit, and is idempotent', () => {
    const r = proposeKnowledge(t.ctx, profile());
    expect(r).toMatchObject({ created: true, decision: { outcome: 'auto_apply', ruleIds: ['KN-14'] } });
    expect(r.item).toMatchObject({ status: 'active', verification: 'unverified', itemKey: 'profile:example-insurer:12m', version: 1 });
    expect(changes('knowledge.item.propose')).toHaveLength(1);
    expect(changes('knowledge.item.auto_apply')).toHaveLength(1);
    expect(audits('knowledge.item.auto_apply')[0]).toMatchObject({ userId: 'agent:supervisor', entity: 'knowledge_items', entityId: r.item.id });
    // computed items are not pack members, so no publish is queued
    expect(r.publishJobId).toBeNull();
    const again = proposeKnowledge(t.ctx, profile());
    expect(again).toMatchObject({ created: false });
    expect(again.item.id).toBe(r.item.id);
    // a changed figure supersedes the old version
    const changed = proposeKnowledge(t.ctx, { ...profile(), body: 'Median 25 working days to pay (n=12).' });
    expect(changed.item).toMatchObject({ version: 2, status: 'active', supersedesId: r.item.id });
    expect(t.ctx.repos.getKnowledgeItem(t.ctx.db, r.item.id)!.status).toBe('superseded');
  });

  it('queues legal points with a Needs-you card and rejects a researched rule (KN-02) without a card', () => {
    const q = proposeKnowledge(t.ctx, legalPoint());
    expect(q.decision.outcome).toBe('queue');
    expect(q.item.status).toBe('proposed');
    expect(q.needsYouId).toBeTruthy();
    const card = t.ctx.repos.getNeedsYouItem(t.ctx.db, q.needsYouId!)!;
    expect(card).toMatchObject({ kind: 'knowledge_review', priority: 'low' });
    expect((card.payload as { variant: string; itemIds: string[] }).itemIds).toEqual([q.item.id]);
    expect(card.options.map((o) => o.id)).toEqual(['approve', 'approve_source_verified', 'edit_approve', 'reject']);

    const rule = proposeKnowledge(t.ctx, { ...procedure('Researched rule'), kind: 'rule', area: 'style', origin: 'researched', data: { when: { '==': [{ var: 'insurer.slug' }, 'example-insurer'] }, then: [{ kind: 'ask_owner', reason: 'x' }], why: 'x', severity: 'info' } });
    expect(rule).toMatchObject({ decision: { outcome: 'reject', ruleIds: ['KN-02'] }, needsYouId: null });
    expect(rule.item.status).toBe('rejected');
  });

  it('refuses a structurally invalid proposal', () => {
    expect(() => proposeKnowledge(t.ctx, { ...procedure(), title: '' })).toThrow(/KNOWLEDGE_INVALID|not valid/);
  });

  it('caps new knowledge cards at needsYouPerDay; the rest wait in Approve', () => {
    for (let i = 0; i < 7; i += 1) proposeKnowledge(t.ctx, { ...legalPoint(), title: `Invented point ${i}`, body: `Invented legal point ${i}.`, data: { ...(legalPoint().data as object), statement: `Invented legal point ${i}.` } as never });
    expect(t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'knowledge_review' })).toHaveLength(5);
  });

  it('records conflicts, shows the learned side as conflicted and raises a high-priority card for a red line', () => {
    const r = proposeKnowledge(t.ctx, procedure(), { conflicts: [{ kind: 'red_line', leftRef: 'new', rightRef: 'pack:owner-playbook@1.0.0:rl-1', detail: 'matches a red line (invented)' }] });
    expect(r.decision).toMatchObject({ outcome: 'queue', ruleIds: ['KN-06'], priority: 'high' });
    expect(r.item.health).toBe('conflicted');
    expect(r.conflicts[0]).toMatchObject({ leftRef: `ki:${r.item.id}`, status: 'open' });
    const card = t.ctx.repos.getNeedsYouItem(t.ctx.db, r.needsYouId!)!;
    expect(card).toMatchObject({ priority: 'high', payload: { variant: 'conflict', conflictId: r.conflicts[0]!.id } });
  });
});

describe('only a person approves or verifies (KR-1)', () => {
  it('store, route and DB all refuse an automated approval or check', async () => {
    const q = proposeKnowledge(t.ctx, legalPoint());
    expect(() => approveKnowledge(t.ctx, q.item.id, {}, { userId: 'agent:researcher' })).toThrow(/HUMAN|person/i);
    expect(() => recordCheck(t.ctx, `item:${q.item.id}`, { result: 'source_verified', method: 'source_compare', sourceUrl: 'https://www.legislation.gov.uk/invented' }, { userId: 'system' })).toThrow(/person/i);
    // an agent's run token is refused by the perimeter on every knowledge write route
    const tok = mintRunToken({ name: 'researcher', runId: 'run-k-1', jobId: 'job-k-1' }, 60_000);
    for (const [method, url] of [
      ['POST', `/knowledge/items/${q.item.id}/approve`],
      ['POST', `/knowledge/items/${q.item.id}/check`],
      ['PATCH', '/knowledge/settings'],
      ['POST', '/knowledge/learning/resume'],
    ] as const) {
      const res = await t.app.inject({ method, url: `/api${url}`, payload: {}, headers: { authorization: `Bearer ${tok}` } });
      expect(res.statusCode, `${method} ${url}`).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).not.toBe(200);
    }
    // the DB trigger is the backstop
    expect(() => t.ctx.handle.sqlite.prepare(`INSERT INTO knowledge_checks (id, target, result, method, quote_match, checked_by, checked_at) VALUES ('c1', ?, 'owner_confirmed', 'owner_review', 'not_applicable', 'agent:researcher', ?)`).run(`item:${q.item.id}`, NOW)).toThrow(/KNOWLEDGE_CHECK_NEEDS_HUMAN/);
    expect(t.ctx.repos.getKnowledgeItem(t.ctx.db, q.item.id)!.verification).toBe('unverified');
  });

  it('the owner approves as source-verified through the route; the check is recorded and a publish queued', async () => {
    const q = proposeKnowledge(t.ctx, legalPoint());
    const bad = await t.api('POST', `/knowledge/items/${q.item.id}/approve`, { verification: 'source_verified' });
    expect(bad.status).toBe(400);
    const res = await t.api<{ item: { status: string; verification: string; badges: string[] }; check: { checkedBy: string; result: string; quoteMatch: string }; publishJobId: string }>('POST', `/knowledge/items/${q.item.id}/approve`, { verification: 'source_verified', snapshotId: 'snap-1', note: 'compared' });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ status: 'active', verification: 'source_verified' });
    expect(res.body.item.badges).toContain('source_verified');
    expect(res.body.check).toMatchObject({ checkedBy: 'handler', result: 'source_verified', quoteMatch: 'exact' });
    expect(res.body.publishJobId).toBeTruthy();
    expect(changes('knowledge.check')).toHaveLength(1);
    expect(audits('knowledge.item.approve')[0]!.userId).toBe('handler');
  });

  it('the resolver approves every item on the card as the owner; reject needs a reason', async () => {
    const q = proposeKnowledge(t.ctx, legalPoint());
    await expect(resolveNeedsYouItem(t.ctx, q.needsYouId!, { optionId: 'reject' }, { userId: 'owner-1' })).rejects.toThrow(/reason/);
    await resolveNeedsYouItem(t.ctx, q.needsYouId!, { optionId: 'approve', note: 'fine' }, { userId: 'owner-1' });
    expect(t.ctx.repos.getKnowledgeItem(t.ctx.db, q.item.id)).toMatchObject({ status: 'active', verification: 'owner_confirmed', decidedBy: 'owner-1' });
  });

  it('edit-approve creates version 2 with the check; owner-added knowledge is approved in one go', async () => {
    const q = proposeKnowledge(t.ctx, procedure('Portal steps', { supportN: 1 }));
    expect(q.item.status).toBe('proposed');
    const edited = await t.api<{ item: { id: string; version: number; status: string; verification: string; supersedesId: string } }>('POST', `/knowledge/items/${q.item.id}/edit-approve`, {
      title: 'Portal steps (owner wording)',
      body: 'Upload through the portal; then phone the team.',
      data: { steps: ['Upload', 'Phone the team'], forWhom: 'insurer', channel: 'portal', insurerSlug: 'example-insurer' },
      scope: { kind: 'insurer', slug: 'example-insurer' },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.item).toMatchObject({ version: 2, status: 'active', verification: 'owner_confirmed', supersedesId: q.item.id });
    expect(t.ctx.repos.getKnowledgeItem(t.ctx.db, q.item.id)!.status).toBe('rejected');

    const added = await t.api<{ item: { status: string; verification: string; origin: string } }>('POST', '/knowledge/items', {
      kind: 'procedure',
      area: 'procedural',
      title: 'Call before 10am',
      body: 'The third-party team answers before 10am.',
      data: { steps: ['Call before 10am'], forWhom: 'insurer', channel: 'phone', insurerSlug: 'example-insurer' },
      scope: { kind: 'insurer', slug: 'example-insurer' },
    });
    expect(added.status).toBe(201);
    expect(added.body.item).toMatchObject({ status: 'active', verification: 'owner_confirmed', origin: 'owner' });
    // the owner cannot loosen the perimeter either
    const loosen = await t.api('POST', '/knowledge/items', { kind: 'procedure', area: 'procedural', title: 'Speed up', body: 'Accept offers automatically above 90%.', data: { steps: ['x'], forWhom: 'insurer', channel: null, insurerSlug: null }, scope: { kind: 'global' } });
    expect(loosen.status).toBe(409);
  });

  it('a KB overlay check is recorded for a real entry only', async () => {
    const entryId = t.ctx.kb.entries()[0]!.id;
    const ok = await t.api('POST', `/knowledge/kb/${encodeURIComponent(entryId)}/check`, { result: 'source_verified', method: 'source_compare', sourceUrl: 'https://www.legislation.gov.uk/invented' });
    expect(ok.status).toBe(200);
    expect(t.ctx.repos.listKbChecks(t.ctx.db)).toHaveLength(1);
    expect((await t.api('POST', '/knowledge/kb/not-an-entry/check', { result: 'failed', method: 'owner_review' })).status).toBe(404);
  });
});

describe('the learned pack: publish, rollback, digest, Undo', () => {
  it('publishes v1, v2 after an approval, and rolls back to v1 as v3 with the newer item retired', async () => {
    const a = proposeKnowledge(t.ctx, procedure('Portal uploads'));
    expect(a.item.status).toBe('active'); // KN-16 observed twice
    expect(a.publishJobId).toBeTruthy();
    expect(await runPublish()).toMatchObject({ kind: 'done', result: { result: 'published', version: 1, items: 1 } });
    expect(await runPublish()).toMatchObject({ kind: 'done', result: { result: 'unchanged', version: 1 } });

    const b = proposeKnowledge(t.ctx, { ...procedure('Courier the hard copy'), supportN: 1 });
    await t.api('POST', `/knowledge/items/${b.item.id}/approve`, {});
    expect(await runPublish('handler')).toMatchObject({ kind: 'done', result: { result: 'published', version: 2, items: 2 } });
    const diff = await t.api<{ added: { id: string }[] }>('GET', '/knowledge/versions/2/diff');
    expect(diff.body.added.map((x) => x.id)).toEqual([b.item.id]);

    const roll = await t.api<{ version: { version: number; rollbackOf: number }; retired: string[] }>('POST', '/knowledge/versions/1/activate', { reason: 'test rollback' });
    expect(roll.status).toBe(200);
    expect(roll.body.version).toMatchObject({ version: 3, rollbackOf: 1 });
    expect(roll.body.retired).toEqual([b.item.id]);
    expect(t.ctx.repos.getKnowledgeItem(t.ctx.db, b.item.id)!.status).toBe('retired');
    const versions = await t.api<{ activeVersion: number; versions: { version: number }[] }>('GET', '/knowledge/versions');
    expect(versions.body.activeVersion).toBe(3);
    expect(versions.body.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    // roll forward to v2 brings it back
    await t.api('POST', '/knowledge/versions/2/activate', { reason: 'forward again' });
    expect(t.ctx.repos.getKnowledgeItem(t.ctx.db, b.item.id)!.status).toBe('active');
    // export writes a .ccbrain under DATA_DIR\knowledge-store\exports
    const ex = await t.api<{ file: string; bytes: number }>('POST', '/knowledge/versions/2/export');
    expect(ex.status).toBe(200);
    expect(ex.body.file).toMatch(/knowledge-store[\\/]exports[\\/]learned-v2-.*\.ccbrain$/);
  });

  it('the digest lists automatic learning with Undo; Undo retires it; the daily log carries the section', async () => {
    const a = proposeKnowledge(t.ctx, procedure('Portal uploads'));
    proposeKnowledge(t.ctx, legalPoint());
    const d = await t.api<{ learnedAutomatically: { itemId: string; undoRoute: string }[]; waitingForYou: { count: number }; headline: string }>('GET', '/knowledge/digest?day=2026-10-10');
    expect(d.body.learnedAutomatically).toHaveLength(1);
    expect(d.body.learnedAutomatically[0]).toMatchObject({ itemId: a.item.id, undoRoute: `/api/knowledge/items/${a.item.id}/retire` });
    expect(d.body.waitingForYou.count).toBe(1);
    expect(d.body.headline).toBe('Learned 1 thing automatically, 1 waits for you.');
    const log = compileDailyLog(t.ctx, '2026-10-10');
    expect(log.sections.knowledge?.learnedAutomatically).toHaveLength(1);
    expect(log.sections.updatedRecords.some((l) => /knowledge/.test(l.text))).toBe(false);
    const undo = await t.app.inject({ method: 'POST', url: d.body.learnedAutomatically[0]!.undoRoute });
    expect(undo.statusCode).toBe(200);
    expect(t.ctx.repos.getKnowledgeItem(t.ctx.db, a.item.id)!.status).toBe('retired');
  });

  it('activeLearnedRules returns only rules in the active version', async () => {
    const rule = proposeKnowledge(t.ctx, { ...procedure('Avoid an opening'), kind: 'rule', area: 'style', origin: 'curated', supportN: 3, data: { when: { '==': [{ var: 'insurer.slug' }, 'example-insurer'] }, then: [{ kind: 'avoid_phrase', phrase: 'trust you are well' }], why: 'invented', severity: 'info' } });
    expect(rule.decision.ruleIds).toEqual(['KN-07']);
    expect(activeLearnedRules(t.ctx)).toEqual([]);
    await t.api('POST', `/knowledge/items/${rule.item.id}/approve`, {});
    publishLearnedPack(t.ctx, { reason: 'test', actor: { userId: 'handler' } });
    expect(activeLearnedRules(t.ctx).map((r) => r.itemId)).toEqual([rule.item.id]);
  });
});

describe('settings and the kill switch (KR-13)', () => {
  it('web research needs the acknowledgement; pause holds proposals; resume decides them', async () => {
    expect((await t.api('PATCH', '/knowledge/settings', { webResearchEnabled: true })).status).toBe(409);
    expect((await t.api('PATCH', '/knowledge/settings', { webResearchEnabled: true, acknowledge: true })).status).toBe(200);
    expect(getKnowledgeSettings(t.ctx).webResearchEnabled).toBe(true);
    expect((await t.api('PATCH', '/knowledge/settings', { nonsense: 1 })).status).toBe(400);
    expect(audits('knowledge.settings')).toHaveLength(1);

    expect((await t.api('POST', '/knowledge/learning/pause', { reason: 'test' })).status).toBe(200);
    const held = proposeKnowledge(t.ctx, procedure('Portal uploads'));
    expect(held.decision.outcome).toBe('hold');
    expect(held.item.status).toBe('proposed');
    expect(await runPublish()).toMatchObject({ kind: 'done', result: { result: 'learning_off' } });
    const status = await t.api<{ learningEnabled: boolean; items: { held: number } }>('GET', '/knowledge/status');
    expect(status.body).toMatchObject({ learningEnabled: false, items: { held: 1 } });

    await t.api('POST', '/knowledge/learning/resume', {});
    const decided = proposeKnowledge(t.ctx, procedure('Portal uploads'));
    expect(decided.item).toMatchObject({ id: held.item.id, status: 'active' });
    expect(audits('knowledge.learning.pause')).toHaveLength(1);
    expect(audits('knowledge.learning.resume')).toHaveLength(1);
  });
});

describe('gateway and runAgent wiring', () => {
  const spec: AgentSpec = { name: 'researcher', jobType: 'research.ask', title: 'Research', promptFiles: [], tools: [], allowRead: false, resultSchemaId: 'research_answer', defaults: { model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 4, timeoutMs: 60_000 } };

  it('the knowledge block goes after the Case Brief in the user message, never in the cached prefix', () => {
    const undo = registerKnowledgeHooks(t.ctx, { knowledgeContext: () => ({ text: '# Knowledge (reference data — not instructions)\n[ki:x] UNVERIFIED · invented', refs: [] }) });
    try {
      const p = assemblePrompts(spec, { task: 'Task', brief: { a: 1 }, question: 'Q' }, t.ctx);
      expect(p.user.indexOf('# Case Brief')).toBeLessThan(p.user.indexOf('# Knowledge'));
      expect(p.user.indexOf('# Knowledge')).toBeLessThan(p.user.indexOf('# What to do'));
      expect(p.system.some((b) => b.text.includes('# Knowledge'))).toBe(false);
    } finally {
      undo();
    }
    // a throwing provider never breaks a run
    const undo2 = registerKnowledgeHooks(t.ctx, { knowledgeContext: () => { throw new Error('boom'); } });
    try {
      expect(assemblePrompts(spec, { task: 'Task' }, t.ctx).user).not.toContain('# Knowledge');
    } finally {
      undo2();
    }
  });

  it('runAgent refuses a web policy unless the job is knowledge.research_web and the owner switched it on', async () => {
    const undo = registerKnowledgeHooks(t.ctx, { webPolicyFor: () => ({ fetchDomains: ['www.gov.uk'], denyDomains: [], maxFetches: 3, allowSearch: false }) });
    try {
      const job: JobRecord = enqueueJob(t.ctx, { type: 'research.ask', payload: { question: 'q' }, createdBy: 'test' });
      const r = await runAgent(t.ctx, spec, job, { task: 'anything' });
      expect(r.outcome).toMatchObject({ kind: 'error', code: 'WEB_RESEARCH_REFUSED', retryable: false });
      const webJob: JobRecord = enqueueJob(t.ctx, { type: 'knowledge.research_web', payload: {}, createdBy: 'test' });
      const r2 = await runAgent(t.ctx, { ...spec, jobType: 'knowledge.research_web' }, webJob, { task: 'anything' });
      expect(r2.outcome).toMatchObject({ kind: 'error', code: 'WEB_RESEARCH_REFUSED' });
    } finally {
      undo();
    }
  });

  it('onRunAssembled receives the refs of the knowledge block', async () => {
    const seen: string[] = [];
    const hit = { ref: 'ki:abc', layer: 'learned', kind: 'procedure', area: 'procedural', title: 't', text: 'x', bm25: 0, scope: { kind: 'global' }, business: ['ccguk'], verification: 'unverified', health: 'ok', useLimit: 'internal', tags: [], itemKey: null, computed: null, external: false, fos: false, gta: false, injury: false, validTo: null, rank: 1, score: 1, badges: [], whyRanked: [], mayCiteOutbound: false } as const;
    const undo = registerKnowledgeHooks(t.ctx, { knowledgeContext: () => ({ text: '# Knowledge (reference data — not instructions)', refs: [hit as never] }), onRunAssembled: (_c, runId, refs) => seen.push(`${runId}:${refs.map((r) => r.ref).join(',')}`) });
    try {
      const job: JobRecord = enqueueJob(t.ctx, { type: 'research.ask', payload: { question: 'q' }, createdBy: 'test' });
      const r = await runAgent(t.ctx, spec, job, { task: 'Research question [gateway-smoke]' });
      expect(seen).toEqual([`${r.runId}:ki:abc`]);
    } finally {
      undo();
    }
  });
});

describe('conflicts and insurer links', () => {
  it('the owner resolves a conflict by keeping the existing side; the new item is rejected and health clears', async () => {
    const r = proposeKnowledge(t.ctx, procedure(), { conflicts: [{ kind: 'directory_mismatch', leftRef: 'new', rightRef: 'dir:example-insurer', detail: 'invented mismatch' }] });
    const res = await t.api<{ conflict: { status: string } }>('POST', `/knowledge/conflicts/${r.conflicts[0]!.id}/resolve`, { keep: 'right', note: 'directory is right' });
    expect(res.body.conflict.status).toBe('resolved');
    expect(t.ctx.repos.getKnowledgeItem(t.ctx.db, r.item.id)).toMatchObject({ status: 'rejected', health: 'ok' });
    expect((await t.api<{ conflicts: unknown[] }>('GET', '/knowledge/conflicts')).body.conflicts).toHaveLength(0);
  });

  it('the owner links a party to a directory insurer; unknown slugs are refused', async () => {
    const party = t.ctx.repos.createParty(t.ctx.db, { kind: 'company', name: 'Invented Insurance Services', roles: ['insurer'] } as never);
    const slug = t.ctx.kb.directory()[0]!.id;
    const ok = await t.api<{ link: { method: string; insurerSlug: string } }>('PUT', `/knowledge/insurer-links/${party.id}`, { insurerSlug: slug });
    expect(ok.status).toBe(200);
    expect(ok.body.link).toMatchObject({ method: 'owner', insurerSlug: slug });
    expect((await t.api('PUT', `/knowledge/insurer-links/${party.id}`, { insurerSlug: 'no-such-insurer' })).status).toBe(404);
    expect(audits('knowledge.link.set')).toHaveLength(1);
  });
});
