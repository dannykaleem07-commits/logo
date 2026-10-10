// owned by knowledge-use
/**
 * Knowledge Builder — using knowledge (docs/SUPREME-KNOWLEDGE-BUILDER.md §4.5, §8, §12, §14 scenarios 1, 8, 9, 10):
 * retrieval into every agent's prompt (badges, perimeter filters, the kill switch), knowledge_usage rows, the reviewer's
 * outbound-knowledge check (internal leak, unconfirmed legal points, citations recorded on the draft), the KB
 * verification overlay (an owner check makes kb_search report verified; a changed source shows it stale), golden replay
 * (gate and nightly, written once and audited), drift alarms (rollback card, quarantine on a perimeter alarm), the
 * tools and the routes. Every insurer, claim and figure is invented; no model and no network are used.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KnowledgeProposal, RuleData } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { enqueueJob } from '../agent/core.js';
import { getJobHandler } from '../agent/handlers/index.js';
import { resolveNeedsYouItem } from '../agent/needsYou.js';
import { mintRunToken } from '../agent/principal.js';
import { assemblePrompts } from '../ai/prompts.js';
import type { AgentSpec, JobRecord, RunContext } from '../agent/contracts.js';
import { CASE_REVIEW_SPEC, DRAFTER_SPEC } from '../casework/specs.js';
import { rulesTier, type ReviewTarget } from '../casework/review.js';
import { getTool } from '../agent/tools/index.js';
import { proposeKnowledge, recordCheck } from '../knowledge/store.js';
import { publishLearnedPack } from '../knowledge/publish.js';
import { knowledgeHooks } from '../knowledge/hooks.js';
import { patchKnowledgeSettings, setLearningEnabled } from '../knowledge/settings.js';
import { reviewKnowledgeUse, markerRefs } from '../knowledge/use/review.js';
import { searchKnowledge } from '../knowledge/use/retrieve.js';

const NOW = '2026-10-10T10:00:00.000Z';
const OWNER = { userId: 'courtesycars' };
const SLUG = 'example-insurer';
let t: TestApp;

beforeEach(async () => {
  t = await createTestApp(NOW, { config: { aiDriverOverride: 'fake' } });
});
afterEach(async () => {
  await t.close();
});

let seq = 0;
function makeClaim(): { id: string; insurerPartyId: string } {
  seq += 1;
  const insurer = t.ctx.repos.createParty(t.ctx.db, { kind: 'company', name: `Example Insurance ${seq} plc`, roles: ['insurer'] } as never);
  const claimant = t.ctx.repos.createParty(t.ctx.db, { kind: 'individual', name: `Pat Example${seq}`, roles: ['claimant'] } as never);
  const vehicle = t.ctx.repos.upsertVehicle(t.ctx.db, { registration: `KU${String(10 + seq).slice(-2)}ABC`, make: 'Testmake', model: 'Alpha', ownership: 'client' } as never);
  const claim = t.ctx.repos.createClaim(t.ctx.db, {
    openedAt: '2026-05-01T09:00:00.000Z',
    accident: { occurredAt: '2026-04-20T10:00:00.000Z', location: 'Invented Road', circumstances: 'Invented test accident.' },
    liability: 'admitted',
    claimantId: claimant.id,
    clientVehicleId: vehicle.id,
    thirdPartyIds: [],
    atFaultInsurerId: insurer.id,
  } as never);
  t.ctx.repos.putInsurerLink(t.ctx.db, { partyId: insurer.id, insurerSlug: SLUG, method: 'owner', confidence: 1, decidedBy: OWNER.userId, decidedAt: NOW });
  return { id: claim.id, insurerPartyId: insurer.id };
}

const profile = (n = 14): KnowledgeProposal => ({
  kind: 'insurer_profile',
  area: 'statistics',
  title: `${SLUG} — 12-month profile`,
  body: 'This insurer pays the hire head in a median of 21 working days after the payment pack is sent.',
  data: { insurerSlug: SLUG, window: '12m', minN: 3, computedAt: '2026-10-06T01:30:00.000Z', n: { claims: n, settled: n - 2 }, daysToPay: { medianWorkingDays: 21, p90WorkingDays: 40, n: n - 2 }, heads: {}, objections: [], docsRequested: [], gta: { subscriberClaims: 0, hirePaidAtGtaRatePct: null, firstNotificationDisputePct: null }, responseHours: { median: null, n: 0 }, chasersBeforePay: { median: null, n: 0 } },
  tags: [],
  scope: { kind: 'insurer', slug: SLUG },
  business: ['ccguk'],
  useLimit: 'internal',
  origin: 'computed',
  confidence: 1,
  supportN: n,
  provenance: [{ kind: 'claim_stats', n, claimIds: [], computedAt: NOW, method: 'nearest-rank' }],
  createdBy: 'agent:supervisor',
});

const procedure = (over: Partial<KnowledgeProposal> = {}): KnowledgeProposal => ({
  kind: 'procedure',
  area: 'procedural',
  title: 'Payment pack portal upload for the example insurer',
  body: 'Upload the payment pack through the insurer portal, then email the handler the portal reference number.',
  data: { steps: ['Log in to the portal', 'Upload the payment pack', 'Email the portal reference'], forWhom: 'insurer', channel: 'portal', insurerSlug: SLUG },
  tags: ['portal'],
  scope: { kind: 'insurer', slug: SLUG },
  business: ['ccguk'],
  useLimit: 'internal',
  origin: 'observed',
  confidence: 0.9,
  supportN: 2,
  provenance: [],
  createdBy: 'agent:supervisor',
  ...over,
});

const rule = (title: string, data: RuleData): KnowledgeProposal => ({
  kind: 'rule',
  area: 'strategy',
  title,
  body: data.why,
  data,
  tags: [],
  scope: { kind: 'global' },
  business: ['ccguk'],
  useLimit: 'internal',
  origin: 'curated',
  confidence: 0.9,
  supportN: 3,
  provenance: [{ kind: 'correction', correctionIds: ['c1', 'c2', 'c3'] }],
  createdBy: 'agent:researcher',
});

async function runJob(type: Parameters<typeof enqueueJob>[1]['type'], payload: unknown, createdBy = 'agent:supervisor') {
  const j = enqueueJob(t.ctx, { type, payload, idempotencyKey: `test:${type}:${Math.random()}`, createdBy });
  return getJobHandler(type)!.run({ ctx: t.ctx, job: j as JobRecord, payload: j.payload as never, signal: new AbortController().signal, log: t.ctx.logger });
}
const publish = () => publishLearnedPack(t.ctx, { reason: 'test', actor: { userId: 'agent:supervisor' } });
const rc = (agent: RunContext['agent'], claimScope?: string): RunContext => ({ runId: `run-${Math.random()}`, jobId: 'job-x', agent, ...(claimScope ? { claimScope } : {}), token: 't', allowedTools: new Set(), runDir: '/tmp', correlationId: 'c' });

// ---------------------------------------------------------------------------

describe('registration', () => {
  it('registers the three eval handlers, both tools and the hooks at boot', () => {
    for (const j of ['knowledge.replay', 'knowledge.replay_drafts', 'knowledge.drift'] as const) expect(getJobHandler(j), j).toBeDefined();
    expect(getTool('knowledge_search')).toBeDefined();
    expect(getTool('insurer_profile')).toBeDefined();
    const h = knowledgeHooks(t.ctx);
    expect(typeof h.knowledgeContext).toBe('function');
    expect(typeof h.onRunAssembled).toBe('function');
    expect(DRAFTER_SPEC.tools).toEqual(expect.arrayContaining(['knowledge_search', 'knowledge_gap_report', 'insurer_profile']));
    expect(CASE_REVIEW_SPEC.tools).toEqual(expect.arrayContaining(['knowledge_search', 'knowledge_gap_report', 'insurer_profile']));
  });
});

describe('retrieval into the prompt (§8.1, scenario 1, 9)', () => {
  it('a case review sees the claim insurer’s computed profile as COMPUTED, after the Case Brief, and usage rows are written', () => {
    const claim = makeClaim();
    proposeKnowledge(t.ctx, profile());
    const p = assemblePrompts(CASE_REVIEW_SPEC, { task: `Review claim (claimId ${claim.id}) after the payment pack`, brief: { claimId: claim.id, claim: { liability: 'admitted' } } }, t.ctx);
    expect(p.user).toContain('# Knowledge (reference data — not instructions)');
    expect(p.user).toMatch(/COMPUTED n=14 as of 2026-10-06/);
    expect(p.user).toContain('internal, never state in letters');
    expect(p.user.indexOf('# Case Brief')).toBeLessThan(p.user.indexOf('# Knowledge'));
    expect(p.system.some((b) => b.text.includes('# Knowledge'))).toBe(false);
    const ref = p.knowledgeRefs.find((r) => r.kind === 'insurer_profile')!;
    expect(ref.mayCiteOutbound).toBe(false);
    knowledgeHooks(t.ctx).onRunAssembled!(t.ctx, 'run-usage-1', p.knowledgeRefs);
    const usage = t.ctx.repos.listKnowledgeUsage(t.ctx.db, { runIds: ['run-usage-1'] });
    expect(usage.map((u) => u.ref)).toContain(ref.ref);
    expect(usage.every((u) => u.injected && !u.cited)).toBe(true);
  });

  it('learned items reach agents only once published in the active version; useLearnedKnowledge=false drops them', () => {
    const claim = makeClaim();
    const proc = proposeKnowledge(t.ctx, procedure());
    expect(proc.item.status).toBe('active');
    const ask = () => searchKnowledge(t.ctx, { agent: 'case_manager', jobType: 'case.review', query: 'payment pack portal upload', claim: { claimId: claim.id, insurerSlug: SLUG, claimTypes: [], recipientRole: null, business: 'ccguk' } });
    expect(ask().hits.map((h) => h.ref)).not.toContain(`ki:${proc.item.id}`);
    publish();
    expect(ask().hits.map((h) => h.ref)).toContain(`ki:${proc.item.id}`);
    patchKnowledgeSettings(t.ctx, { useLearnedKnowledge: false }, OWNER);
    expect(ask().hits.some((h) => h.layer === 'learned')).toBe(false);
    // the KB still answers with learned knowledge off
    expect(searchKnowledge(t.ctx, { agent: 'researcher', jobType: 'research.ask', query: 'credit hire champerty', claim: null }).hits.some((h) => h.layer === 'kb')).toBe(true);
  });

  it('never gives FOS material to a draft for the at-fault insurer, and labels GTA entries a benchmark', () => {
    const claim = makeClaim();
    const drafter = assemblePrompts(DRAFTER_SPEC, { task: `Draft for claim (claimId ${claim.id}): reply about the Financial Ombudsman complaint and GTA timescales`, brief: { claimId: claim.id } }, t.ctx);
    expect(drafter.knowledgeRefs.some((r) => r.fos)).toBe(false);
    const researcher = searchKnowledge(t.ctx, { agent: 'researcher', jobType: 'research.ask', query: 'Financial Ombudsman complaint GTA timescales', claim: null });
    expect(researcher.hits.some((h) => h.fos)).toBe(true);
    const gta = researcher.hits.find((h) => h.gta);
    if (gta) expect(researcher.block).toContain('GTA BENCHMARK — not law');
  });

  it('mail triage gets no knowledge block', () => {
    const p = assemblePrompts({ ...CASE_REVIEW_SPEC, name: 'mail', jobType: 'mail.triage' } as AgentSpec, { task: 'Triage this email about the payment pack' }, t.ctx);
    expect(p.user).not.toContain('# Knowledge');
  });
});

describe('the reviewer checks outbound knowledge (§8.3, scenario 1)', () => {
  function seedDraftRun(targetId: string, refs: { ref: string; rank: number }[]) {
    const runId = `run-draft-${Math.random()}`;
    t.ctx.repos.appendAudit(t.ctx.db, { actor: { userId: 'agent:mail', runId }, action: 'outbox.draft', entity: 'outbox', entityId: targetId, after: {}, at: NOW });
    t.ctx.repos.insertKnowledgeUsage(t.ctx.db, refs.map((r) => ({ runId, claimId: null, ref: r.ref, badges: [], rank: r.rank, injected: true, cited: false, targetKind: null, targetId: null, at: NOW })));
    return runId;
  }

  it('blocks a draft that states the internal profile (KNOWLEDGE_INTERNAL_LEAK) through tier a', () => {
    const claim = makeClaim();
    const prof = proposeKnowledge(t.ctx, profile());
    seedDraftRun('ob-leak', [{ ref: `ki:${prof.item.id}`, rank: 1 }]);
    const target: ReviewTarget = { kind: 'outbox', id: 'ob-leak', claimId: claim.id, text: 'Dear Sirs,\nWe note this insurer pays the hire head in a median of 21 working days after the payment pack is sent.\nClaims Team, Courtesy Cars Group UK Ltd', freeText: '', templateId: 'email.chaser', recipientRole: 'at_fault_insurer', missingInfo: false };
    const { issues } = rulesTier(t.ctx, target);
    expect(issues.filter((i) => i.code === 'KNOWLEDGE_INTERNAL_LEAK').map((i) => i.severity)).toContain('block');
  });

  it('blocks an unconfirmed legal point the draft states, records it as cited, and shows it on /knowledge/used', async () => {
    const claim = makeClaim();
    const legal = proposeKnowledge(t.ctx, {
      kind: 'fact',
      area: 'legal',
      title: 'Invented notice rule',
      body: 'An insurer must acknowledge a notified claim in writing within an invented period of five working days.',
      data: { statement: 'An insurer must acknowledge a notified claim in writing within an invented period of five working days.', figure: null, asOf: null, benchmarkOnly: false, kbCheck: null, stat: null },
      tags: [],
      scope: { kind: 'global' },
      business: ['ccguk'],
      useLimit: 'outbound_ok',
      origin: 'owner',
      confidence: 1,
      supportN: 1,
      provenance: [{ kind: 'owner', userId: OWNER.userId, at: NOW, note: null }],
      createdBy: OWNER.userId,
    });
    // queued (legal area): the owner approves it as active but the verification stays as recorded by the check
    const id = legal.item.id;
    seedDraftRun('ob-legal', [{ ref: `ki:${id}`, rank: 1 }]);
    const text = 'Dear Sirs, an insurer must acknowledge a notified claim in writing within an invented period of five working days.';
    const r1 = reviewKnowledgeUse(t.ctx, { kind: 'outbox', id: 'ob-legal', claimId: claim.id, text, recipientRole: 'at_fault_insurer' });
    // not active yet → stated but unresolvable as a marker? It is not cited unless active; nothing flagged for an inactive basis item
    expect(r1.flags.filter((f) => f.code === 'KNOWLEDGE_LEGAL_UNCONFIRMED')).toEqual([]);
    // the explicit marker of an inactive item is an unknown ref
    expect(reviewKnowledgeUse(t.ctx, { kind: 'outbox', id: 'ob-legal-2', claimId: claim.id, text: `${text} {{cite:ki:${id}}}` }).flags.map((f) => f.code)).toContain('KNOWLEDGE_REF_UNKNOWN');
    expect(markerRefs(`x {{cite:ki:${id}}} y`)).toEqual([`ki:${id}`]);

    // the owner approves it (owner_confirmed): now citable
    t.ctx.handle.sqlite.prepare(`UPDATE knowledge_items SET status = 'active' WHERE id = ?`).run(id);
    const unconfirmed = reviewKnowledgeUse(t.ctx, { kind: 'outbox', id: 'ob-legal', claimId: claim.id, text, recipientRole: 'at_fault_insurer' });
    expect(unconfirmed.flags.map((f) => f.code)).toEqual(['KNOWLEDGE_LEGAL_UNCONFIRMED']);
    expect(unconfirmed.cited).toEqual([`ki:${id}`]);
    recordCheck(t.ctx, `item:${id}`, { result: 'owner_confirmed', method: 'owner_review' }, OWNER);
    expect(reviewKnowledgeUse(t.ctx, { kind: 'outbox', id: 'ob-legal', claimId: claim.id, text, recipientRole: 'at_fault_insurer' }).flags).toEqual([]);
    // cited once per target and ref (append-only)
    const cited = t.ctx.repos.listKnowledgeUsage(t.ctx.db, { targetKind: 'outbox', targetId: 'ob-legal', cited: true });
    expect(cited).toHaveLength(1);
    const used = await t.api<{ refs: { ref: string; cited: boolean }[] }>('GET', '/knowledge/used?targetKind=outbox&targetId=ob-legal');
    expect(used.status).toBe(200);
    expect(used.body.refs).toEqual([expect.objectContaining({ ref: `ki:${id}`, cited: true })]);
  });
});

describe('KB verification overlay (§4.5, scenario 8)', () => {
  it('an owner check makes kb_search report verified; a changed source then shows it stale', async () => {
    const entry = t.ctx.kb.entries().find((e) => e.id === 'giles-v-thompson-1994')!;
    expect(entry.verification.status).toBe('unverified');
    const before = await t.api<{ items: { id: string; verification: { status: string } }[] }>('GET', '/kb/search?q=Giles%20Thompson%20champertous');
    expect(before.body.items.find((i) => i.id === entry.id)?.verification.status).toBe('unverified');
    recordCheck(t.ctx, `kb:${entry.id}`, { result: 'source_verified', method: 'source_compare', sourceUrl: 'https://caselaw.example.test/invented' }, OWNER);
    const after = await t.api<{ items: { id: string; verification: { status: string } }[] }>('GET', '/kb/search?q=Giles%20Thompson%20champertous');
    expect(after.body.items.find((i) => i.id === entry.id)?.verification.status).toBe('verified');
    expect((await t.api<{ verification: { status: string } }>('GET', `/kb/entries/${entry.id}`)).body.verification.status).toBe('verified');
    // knowledge.watch opens a source_changed gap for kb:<id> → the overlay shows stale (display only)
    t.setNow('2026-10-11T10:00:00.000Z');
    t.ctx.handle.sqlite
      .prepare(`INSERT INTO knowledge_gaps (id, gap_key, kind, question, area, scope_kind, scope_value, origin, origin_ref, claim_ids, blocking, occurrences, priority, status, attempts, answer_item_ids, spend, raised_by, created_at, last_seen_at, updated_at) VALUES ('gap-1', 'kbv:giles', 'kb_verification', 'The source changed', 'legal', 'global', NULL, 'source_changed', ?, '[]', 0, 1, 6, 'open', 0, '[]', '{}', 'agent:supervisor', ?, ?, ?)`)
      .run(`kb:${entry.id}`, '2026-10-11T10:00:00.000Z', '2026-10-11T10:00:00.000Z', '2026-10-11T10:00:00.000Z');
    expect(t.ctx.kb.entries().find((e) => e.id === entry.id)!.verification.status).toBe('stale');
    // a "wrong" check excludes the entry
    recordCheck(t.ctx, `kb:${entry.id}`, { result: 'failed', method: 'owner_review', note: 'wrong citation' }, OWNER);
    expect(t.ctx.kb.entries().find((e) => e.id === entry.id)!.verification.status).toBe('failed');
  });
});

describe('golden replay (§12.1, scenario 3)', () => {
  const chaser: RuleData = { when: { '==': [{ var: 'insurer.slug' }, SLUG] }, then: [{ kind: 'prefer_step', actionCode: 'CHASER_7', note: 'chase at day 7' }], why: 'The owner always chases this insurer at day 7.', severity: 'info' };

  it('a queued rule gets a gate replay: inconclusive below minCases, written once and audited', async () => {
    const r = proposeKnowledge(t.ctx, rule('Chase the example insurer at day 7', chaser));
    expect(r.item.status).toBe('proposed');
    const out = await runJob('knowledge.replay', { mode: 'gate', itemIds: [r.item.id] });
    expect(out.kind).toBe('done');
    expect((out as { result: { verdict: string } }).result.verdict).toBe('inconclusive');
    const runs = t.ctx.repos.listEvalRuns(t.ctx.db, { itemId: r.item.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.mode).toBe('gate');
    expect(t.ctx.repos.listKnowledgeChanges(t.ctx.db, { action: 'knowledge.replay.run' }).some((c) => c.itemId === r.item.id)).toBe(true);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'knowledge.replay.run' }).length).toBeGreaterThan(0);
    // eval_runs is append-only
    expect(() => t.ctx.handle.sqlite.prepare(`UPDATE eval_runs SET verdict = 'no_worse'`).run()).toThrow();
    // route lists it (with the item filter)
    const list = await t.api<{ runs: { id: string; verdict: string }[] }>('GET', `/knowledge/evals/runs?itemId=${r.item.id}`);
    expect(list.body.runs.map((x) => x.id)).toEqual([runs[0]!.id]);
  });

  it('with enough frozen cases the gate is no_worse when following the rule was faster', async () => {
    for (let i = 0; i < 12; i++) {
      t.ctx.repos.insertEvalCase(t.ctx.db, { claimId: `claim-${i}`, decisionPoint: 'after_pack_sent', at: `2026-0${(i % 8) + 1}-01T09:00:00.000Z`, facts: { 'insurer.slug': SLUG }, historic: { actionCodes: i < 6 ? ['CHASER_7'] : [], steps: [] }, outcome: { workingDaysToPay: i < 6 ? 10 : 25, paidOfClaimedPct: 100 }, insurerSlug: SLUG, outcomeQuartile: null }, NOW);
    }
    const r = proposeKnowledge(t.ctx, rule('Chase the example insurer at day 7 (v2)', { ...chaser, why: 'Chasing at day 7 was followed by faster payment.' }));
    const out = await runJob('knowledge.replay', { mode: 'gate', itemIds: [r.item.id] });
    expect((out as { result: { verdict: string; casesAffected: number } }).result).toMatchObject({ verdict: 'no_worse', casesAffected: 12 });
    // frozen: inserting the same case again changes nothing
    expect(t.ctx.repos.insertEvalCase(t.ctx.db, { claimId: 'claim-0', decisionPoint: 'after_pack_sent', at: '2026-01-01T09:00:00.000Z', facts: {}, historic: { actionCodes: [], steps: [] }, outcome: { workingDaysToPay: 99, paidOfClaimedPct: 0 }, insurerSlug: SLUG, outcomeQuartile: null }, NOW).created).toBe(false);
    // nightly mode
    const nightly = await runJob('knowledge.replay', { mode: 'nightly' });
    expect((nightly as { result: { mode: string } }).result.mode).toBe('nightly');
  });

  it('draft replay is off by default and owner-triggered runs record an honest result', async () => {
    expect((await runJob('knowledge.replay_drafts', { mode: 'drafts' })) as unknown).toMatchObject({ kind: 'done', result: { result: 'disabled' } });
    const owner = await runJob('knowledge.replay_drafts', { mode: 'drafts' }, OWNER.userId);
    expect(owner).toMatchObject({ kind: 'done', result: { result: 'replayed', verdict: 'inconclusive', drafts: 0 } });
    // budget: one per week
    expect(await runJob('knowledge.replay_drafts', { mode: 'drafts' }, OWNER.userId)).toMatchObject({ kind: 'done', result: { result: 'budget' } });
  });

  it('the replay route is human-only', async () => {
    const tok = mintRunToken({ name: 'researcher', runId: 'run-u-1', jobId: 'job-u-1' }, 60_000);
    const res = await t.app.inject({ method: 'POST', url: '/api/knowledge/evals/replay', payload: { mode: 'nightly' }, headers: { authorization: `Bearer ${tok}` } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const ok = await t.api<{ jobId: string; type: string }>('POST', '/knowledge/evals/replay', { mode: 'nightly' });
    expect(ok.status).toBe(202);
    expect(ok.body.type).toBe('knowledge.replay');
  });
});

describe('drift alarms (§12.2, scenario 10)', () => {
  function review(at: string, verdict: 'pass' | 'repair', opts: { targetId?: string; rules?: unknown } = {}) {
    t.ctx.repos.appendReview(t.ctx.db, { targetKind: 'outbox', targetId: opts.targetId ?? `ob-${Math.random()}`, claimId: undefined, loop: 0, rules: opts.rules ?? { issues: [] }, facts: { issues: [] }, verdict, touches: { money: false, liability: false, settlement: false, legal: false, newCommitment: false }, now: at } as never);
  }

  it('a 20-point drop after v2 raises an alarm with a rollback card; rollback resolves it', async () => {
    proposeKnowledge(t.ctx, procedure());
    publish(); // v1
    proposeKnowledge(t.ctx, procedure({ title: 'Second invented procedure', body: 'Phone the team line before sending the second pack copy.' }));
    t.setNow('2026-10-12T09:00:00.000Z');
    publish(); // v2, activated 12 Oct
    for (let i = 0; i < 12; i++) review(`2026-10-0${(i % 9) + 1}T09:00:00.000Z`, 'pass'); // baseline 100%
    t.setNow('2026-10-20T09:00:00.000Z');
    for (let i = 0; i < 12; i++) review(`2026-10-1${(i % 7) + 3}T09:00:00.000Z`, i < 9 ? 'pass' : 'repair'); // 75%
    const out = (await runJob('knowledge.drift', {})) as { kind: string; result: { result: string; alarms: string[] } };
    expect(out.result.result).toBe('alarms');
    const alarm = t.ctx.repos.getKnowledgeAlarm(t.ctx.db, out.result.alarms[0]!)!;
    expect(alarm).toMatchObject({ metric: 'reviewer_first_pass_rate', severity: 'warn', status: 'open', packVersion: 2 });
    expect(t.ctx.repos.listKnowledgeChanges(t.ctx.db, { action: 'knowledge.alarm.raise' })).toHaveLength(1);
    const card = t.ctx.repos.getNeedsYouItem(t.ctx.db, alarm.needsYouId!)!;
    expect(card.payload).toMatchObject({ variant: 'alarm', alarmId: alarm.id, suggestedRollbackTo: 1 });
    expect(card.options.map((o) => o.id)).toEqual(['rollback', 'acknowledge']);
    // the same alarm is not raised twice
    expect(((await runJob('knowledge.drift', {})) as { result: { alarms: string[] } }).result.alarms).toEqual([]);
    await resolveNeedsYouItem(t.ctx, card.id, { optionId: 'rollback', note: 'roll back' }, OWNER);
    expect(t.ctx.repos.getKnowledgeAlarm(t.ctx.db, alarm.id)).toMatchObject({ status: 'resolved', resolvedBy: OWNER.userId });
    expect(t.ctx.repos.getKnowledgePackState(t.ctx.db).activeVersion).toBe(3);
    // GET /knowledge/alarms
    const list = await t.api<{ alarms: { id: string; status: string }[] }>('GET', '/knowledge/alarms?status=resolved');
    expect(list.body.alarms.map((a) => a.id)).toEqual([alarm.id]);
  });

  it('a perimeter block on a draft citing a learned item is severe and quarantines the item', async () => {
    const item = proposeKnowledge(t.ctx, procedure()).item;
    publish();
    t.setNow('2026-10-15T09:00:00.000Z');
    t.ctx.repos.insertKnowledgeUsage(t.ctx.db, [{ runId: 'run-p', claimId: null, ref: `ki:${item.id}`, badges: [], rank: 1, injected: true, cited: true, targetKind: 'outbox', targetId: 'ob-perim', at: '2026-10-14T09:00:00.000Z' }]);
    review('2026-10-14T09:00:00.000Z', 'repair', { targetId: 'ob-perim', rules: { issues: [{ code: 'FORUM_NOT_OPEN', severity: 'block', where: 'x', message: 'FOS to the at-fault insurer' }] } });
    const out = (await runJob('knowledge.drift', {})) as { result: { alarms: string[] } };
    const alarm = t.ctx.repos.getKnowledgeAlarm(t.ctx.db, out.result.alarms[0]!)!;
    expect(alarm.severity).toBe('severe');
    expect(alarm.actionTaken).toContain(`ki:${item.id}`);
    expect(t.ctx.repos.getKnowledgeItem(t.ctx.db, item.id)!.status).toBe('quarantined');
    expect(t.ctx.repos.getNeedsYouItem(t.ctx.db, alarm.needsYouId!)!.priority).toBe('high');
    // the owner acknowledges through the route
    const ack = await t.api<{ status: string }>('POST', `/knowledge/alarms/${alarm.id}/ack`, { note: 'seen' });
    expect(ack.body.status).toBe('acknowledged');
  });

  it('with learning paused every eval job finishes learning_off, but retrieval still works', async () => {
    setLearningEnabled(t.ctx, false, OWNER);
    for (const j of ['knowledge.drift', 'knowledge.replay', 'knowledge.replay_drafts'] as const) expect(await runJob(j, j === 'knowledge.replay' ? { mode: 'nightly' } : {}), j).toMatchObject({ kind: 'done', result: { result: 'learning_off' } });
    expect(searchKnowledge(t.ctx, { agent: 'researcher', jobType: 'research.ask', query: 'credit hire', claim: null }).hits.length).toBeGreaterThan(0);
  });
});

describe('tools and routes (§8.2, §10.3)', () => {
  it('knowledge_search returns badged hits and refuses another claim; insurer_profile masks contacts and labels statistics', async () => {
    const claim = makeClaim();
    proposeKnowledge(t.ctx, profile());
    proposeKnowledge(t.ctx, {
      kind: 'contact',
      area: 'contact',
      title: 'Third-party team handler',
      body: 'Team handler for third-party claims.',
      data: { insurerSlug: SLUG, team: 'Third party', name: 'Invented Person', role: 'Handler', phone: '0300 123 4567', phoneKind: 'direct', email: 'invented.person@example-insurer.test', ivr: 'Option 2', hours: '9-5', observations: 2, independentThreads: 2, lastSeenAt: NOW },
      tags: [],
      scope: { kind: 'insurer', slug: SLUG },
      business: ['ccguk'],
      useLimit: 'internal',
      origin: 'owner',
      confidence: 1,
      supportN: 2,
      provenance: [],
      createdBy: OWNER.userId,
    });
    const search = getTool('knowledge_search')!;
    const out = (await search.run!({ q: 'credit hire champerty', kinds: null, insurerSlug: null, claimId: null, limit: 5 }, rc('case_manager', claim.id), t.ctx)) as { hits: { ref: string; badges: string[]; mayCiteOutbound: boolean }[] };
    expect(out.hits.length).toBeGreaterThan(0);
    expect(out.hits[0]!.badges.length).toBeGreaterThan(0);
    await expect(search.run!({ q: 'credit hire', kinds: null, insurerSlug: null, claimId: 'another-claim', limit: 5 }, rc('case_manager', claim.id), t.ctx)).rejects.toThrow(/own claim/);
    const prof = (await getTool('insurer_profile')!.run!({ insurerSlug: null, claimId: claim.id }, rc('case_manager', claim.id), t.ctx)) as { insurerSlug: string; contacts: { email: string; phone: string }[]; profile12m: { label: string } | null };
    expect(prof.insurerSlug).toBe(SLUG);
    expect(JSON.stringify(prof)).not.toContain('Invented Person');
    expect(JSON.stringify(prof)).not.toContain('invented.person@');
    expect(prof.profile12m?.label).toMatch(/COMPUTED n=14/);
  });

  it('GET /knowledge/search previews what an agent would see', async () => {
    const claim = makeClaim();
    proposeKnowledge(t.ctx, profile());
    const r = await t.api<{ hits: { ref: string }[]; block: string }>('GET', `/knowledge/search?claimId=${claim.id}&agent=case_manager&q=payment%20pack`);
    expect(r.status).toBe(200);
    expect(r.body.block).toContain('# Knowledge (reference data — not instructions)');
    const plain = await t.api<{ hits: { ref: string }[]; block: string }>('GET', '/knowledge/search?q=credit%20hire%20champerty&agent=researcher');
    expect(plain.body.hits.length).toBeGreaterThan(0);
    expect((await t.api('GET', '/knowledge/search?agent=nobody&q=x')).status).toBe(400);
  });
});
