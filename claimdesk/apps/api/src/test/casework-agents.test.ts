// owned by casework
/**
 * The casework agents with the FakeDriver (docs/SUPREME-DESIGN.md §C.1, §C.2, §C.4, §D.1, §E.6): hand-off validation,
 * CUSTOM always asks, the loop guard, the per-claim AI budget (owner runs exempt), offer analysis that never decides,
 * research notes, the drafter, task.due / case.sweep, and the casework tools' policy (money / legal always ask).
 * All data is invented; no real model is ever called.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import { enqueueJob } from '../agent/core.js';
import { executeTool } from '../agent/dispatcher.js';
import type { JobRecord, RunContext } from '../agent/contracts.js';
import { PLAYBOOK_ACTION_CODES, templateAllowedFor, templateInfo, validateHandoff } from '../casework/handoffs.js';
import { CASE_MANAGER_TOOLS, CASE_REVIEW_SPEC, DRAFTER_SPEC, OFFER_ANALYSE_SPEC, RESEARCHER_SPEC, REVIEWER_SPEC } from '../casework/specs.js';
import { sameNeed, sweepCandidates } from '../casework/agents.js';
import { caseworkTools } from '../agent/tools/casework.js';
import { registryProblems } from '../agent/handlers/index.js';
import { queued, run, runJob, setUpMail } from './fixtures/mail/helpers.js';

const T0 = '2026-10-07T09:00:00.000Z';
let t: TestApp;
let ids: ReturnType<TestApp['ctx']['repos']['seedFileOne']>;
let claimId: string;

beforeEach(async () => {
  t = await createTestApp(T0, { config: { aiDriverOverride: 'fake' } });
  ids = t.ctx.repos.seedFileOne(t.ctx.db);
  claimId = ids.claimId;
  recomputeClocks(t.ctx, claimId);
});
afterEach(async () => {
  await t.close();
});

const review = (payload: Record<string, unknown>, extra: Partial<JobRecord> = {}) => {
  const job = enqueueJob(t.ctx, { type: 'case.review', payload: { claimId, ...payload }, claimId, idempotencyKey: `test:${randomUUID()}`, createdBy: 'test' });
  return runJob(t.ctx, { ...job, ...extra } as JobRecord);
};

describe('specs and registry', () => {
  it('match §A.6 / §B.4 and register without duplicates', () => {
    expect(CASE_REVIEW_SPEC).toMatchObject({ name: 'case_manager', jobType: 'case.review', resultSchemaId: 'case_review', defaults: { model: 'claude-opus-5-5', effort: 'medium', maxTurns: 16 } });
    expect(OFFER_ANALYSE_SPEC).toMatchObject({ name: 'case_manager', jobType: 'offer.analyse', defaults: { effort: 'high' } });
    expect(OFFER_ANALYSE_SPEC.tools).toEqual(expect.arrayContaining(['quantum_settlement', 'offer_recommend']));
    expect(DRAFTER_SPEC).toMatchObject({ name: 'drafter', resultSchemaId: 'drafter', defaults: { model: 'claude-opus-5-5', effort: 'medium', maxTurns: 16 } });
    expect(REVIEWER_SPEC).toMatchObject({ name: 'reviewer', jobType: 'review.check', tools: ['claim_brief', 'document_get', 'mail_thread_get', 'kb_entry', 'brain_search'], resultSchemaId: 'review_verdict', defaults: { model: 'claude-opus-5-5', effort: 'high', maxTurns: 6 } });
    expect(RESEARCHER_SPEC).toMatchObject({ name: 'researcher', defaults: { model: 'claude-sonnet-5-5', effort: 'medium' } });
    expect(CASE_MANAGER_TOOLS).not.toContain('claims_search');
    expect(CASE_MANAGER_TOOLS).not.toContain('email_draft');
    expect(registryProblems()).toEqual([]);
    expect(PLAYBOOK_ACTION_CODES).toEqual(expect.arrayContaining(['CHASER_7', 'SEND_NCAF', 'SEND_PAYMENT_PACK']));
  });
});

describe('hand-off validation (§C.4)', () => {
  it('templates exist and suit the recipient; codes are playbook codes; messages and offers belong to the claim', () => {
    expect(templateInfo(t.ctx, 'letter.chaser_7')).toMatchObject({ format: 'html', role: 'at_fault_insurer' });
    expect(templateInfo(t.ctx, 'letter.nope')).toBeUndefined();
    expect(templateAllowedFor(templateInfo(t.ctx, 'letter.client_update')!, 'at_fault_insurer')).toBe(false);
    const base = { to: 'drafter' as const, templateId: 'letter.chaser_7', emailKind: null, purpose: 'x', recipientPartyId: ids.insurerId, replyToMessageId: null, actionCode: 'CHASER_7', dueAt: null };
    expect(validateHandoff(t.ctx, claimId, base)).toMatchObject({ ok: true, job: { type: 'draft.compose' } });
    expect(validateHandoff(t.ctx, claimId, { ...base, recipientPartyId: ids.claimantId })).toMatchObject({ ok: false });
    expect(validateHandoff(t.ctx, claimId, { ...base, actionCode: 'NOT_A_CODE' })).toMatchObject({ ok: false });
    expect(validateHandoff(t.ctx, claimId, { ...base, actionCode: 'CUSTOM' })).toMatchObject({ ok: true, ask: true });
    expect(validateHandoff(t.ctx, claimId, { to: 'offer_analyst', offerId: ids.offerId })).toMatchObject({ ok: true, job: { type: 'offer.analyse', idempotencyKey: `offer.analyse:${ids.offerId}` } });
    expect(validateHandoff(t.ctx, claimId, { to: 'mail_reply', messageId: 'nope', plan: 'p', keyPoints: [] })).toMatchObject({ ok: false });
  });

  it('case.review: valid hand-offs become jobs, invalid ones are rejected with reasons, tasks and the review state are recorded', async () => {
    const r = await review({ reason: 'owner', marker: 'CW-HANDOFFS', insurerPartyId: ids.insurerId });
    expect(r.outcome.kind).toBe('done');
    const res = r.outcome.result as { accepted: Array<{ type: string; to: string }>; rejected: Array<{ to: string; reason: string }>; tasks: string[]; nextBestAction: { code: string } };
    expect(res.nextBestAction.code).toBe('CHASER_7');
    expect(res.accepted.map((a) => a.type).sort()).toEqual(['draft.compose', 'draft.compose', 'research.ask']);
    expect(res.rejected.map((x) => x.reason).join(' | ')).toMatch(/letter.no_such_template does not exist.*MADE_UP_CODE.*letter.client_update is for the client.*no-such-offer.*no-such-message/);
    expect(r.followUps.map((j) => j.type).sort()).toEqual(['draft.compose', 'draft.compose', 'research.ask']);
    const missing = r.followUps.find((j) => (j.payload as { missingInfo?: boolean }).missingInfo);
    expect(missing).toMatchObject({ claimId, payload: { emailKind: 'doc_request' } });
    expect(r.followUps.every((j) => j.correlationId === r.job.correlationId && j.depth === r.job.depth + 1)).toBe(true);
    expect(res.tasks).toHaveLength(1);
    expect(t.ctx.repos.getTask(t.ctx.db, res.tasks[0]!)).toMatchObject({ kind: 'payment_check', createdBy: 'agent:case_manager' });
    const state = t.ctx.repos.getClaimAgentState(t.ctx.db, claimId);
    expect(state.lastReviewAt).toBe(T0);
    expect(state.lastReviewRunId).toBeTruthy();
    // A second identical review does not duplicate the task.
    await review({ reason: 'owner', marker: 'CW-HANDOFFS', insurerPartyId: ids.insurerId });
    expect(t.ctx.repos.listTasks(t.ctx.db, { claimId, status: 'open' })).toHaveLength(1);
  });

  it('a CUSTOM action always goes to the owner first', async () => {
    const r = await review({ reason: 'owner', marker: 'CW-CUSTOM' });
    expect(r.followUps).toEqual([]);
    const res = r.outcome.result as { asked: string[] };
    expect(res.asked.length).toBeGreaterThan(0);
    expect(t.ctx.repos.getNeedsYouItem(t.ctx.db, res.asked[0]!)).toMatchObject({ kind: 'question', claimId });
  });

  it('the loop guard stops hand-offs past depth 6 and tells the owner', async () => {
    const r = await review({ reason: 'owner', marker: 'CW-RESEARCH-ONLY' }, { depth: 6 });
    expect(r.followUps).toEqual([]);
    expect((r.outcome.result as { rejected: Array<{ reason: string }> }).rejected[0]!.reason).toMatch(/loop guard/);
    expect(t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'failure', claimId }).map((n) => n.title)).toContain('Agents stopped a hand-off loop');
    const ok = await review({ reason: 'owner', marker: 'CW-RESEARCH-ONLY' }, { depth: 5 });
    expect(ok.followUps.map((j) => j.type)).toEqual(['research.ask']);
  });

  it('the per-claim AI budget stops automatic reviews; owner-triggered reviews are exempt', async () => {
    t.ctx.repos.patchAgentSettings(t.ctx.db, { ai: { perClaimRunsPerDay: 1 } }, { userId: 'owner' });
    expect((await review({ reason: 'sweep', marker: 'CW-RESEARCH-ONLY' })).outcome.result).toMatchObject({ nextBestAction: { code: 'SEND_PAYMENT_PACK' } });
    const second = await review({ reason: 'sweep', marker: 'CW-RESEARCH-ONLY' });
    expect(second.outcome.result).toMatchObject({ skipped: 'budget', used: 1, limit: 1 });
    expect(t.ctx.repos.listNeedsYou(t.ctx.db, { claimId }).some((n) => n.title.startsWith('Daily agent budget reached'))).toBe(true);
    expect((await review({ reason: 'owner', marker: 'CW-RESEARCH-ONLY' })).outcome.result).toMatchObject({ nextBestAction: { code: 'SEND_PAYMENT_PACK' } });
  });
});

describe('one Needs-you item per need', () => {
  it('sameNeed matches a custom step and a missing-information question about the same thing', () => {
    expect(sameNeed('Get the V5C from the client', 'V5C not on file V5C registration document')).toBe(true);
    expect(sameNeed('Chase the engineer for the report', 'V5C not on file V5C registration document')).toBe(false);
  });
});

describe('offer.analyse never decides (§D.1 settlement)', () => {
  it('the recommendation becomes the offer_decision card with code figures; no decision, reply or ledger row is written', async () => {
    const offerBefore = t.ctx.repos.requireOffer(t.ctx.db, ids.offerId);
    const ledgerBefore = t.ctx.repos.listLedger(t.ctx.db, claimId).length;
    t.ctx.repos.createNeedsYouItem(t.ctx.db, { kind: 'offer_decision', claimId, title: 'Offer recorded', summary: 's', payload: { recorded: true, offerId: ids.offerId }, priority: 'urgent', createdBy: 'agent:mail', dedupeKey: `offer_decision:${ids.offerId}` });
    const r = await run(t.ctx, 'offer.analyse', { offerId: ids.offerId, claimId }, { claimId });
    expect(r.outcome).toMatchObject({ kind: 'done', result: { recommendation: 'counter' } });
    const open = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'offer_decision', claimId, status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]!.recommendation).toMatchObject({ action: 'Counter-offer at £1,000.00', confidence: 0.72 });
    const payload = open[0]!.payload as { figures: Array<{ label: string; factId: string | null }>; assumptions: { note: string }; recommended: { action: string } };
    expect(payload.recommended.action).toBe('counter');
    expect(payload.figures.map((f) => f.label)).toEqual(expect.arrayContaining([expect.stringMatching(/^Offer/), 'Claimed (hire)', 'Outstanding (hire)']));
    expect(payload.assumptions.note).toMatch(/Assumptions, not facts/);
    expect(t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'offer_decision', claimId, status: 'superseded' })).toHaveLength(1);
    const offerAfter = t.ctx.repos.requireOffer(t.ctx.db, ids.offerId);
    expect(offerAfter.clientDecision).toBe(offerBefore.clientDecision);
    expect(offerAfter.replySentAt).toBe(offerBefore.replySentAt);
    expect(t.ctx.repos.listLedger(t.ctx.db, claimId)).toHaveLength(ledgerBefore);
    const agentWrites = t.ctx.repos.listAudit(t.ctx.db, {}).filter((a) => a.userId.startsWith('agent:') && /^(offer\.|ledger\.)/.test(a.action) && a.action !== 'offer.card_resolved');
    expect(agentWrites).toEqual([]);
    const calls = t.ctx.repos.listAgentToolCalls(t.ctx.db, (r.outcome.result as { runId: string }).runId);
    expect(calls.map((c) => `${c.tool}:${c.decision}`)).toEqual(['offer_recommend:asked']);
  });

  it('a model that forgets offer_recommend still produces the card (from its result)', async () => {
    const r = await run(t.ctx, 'offer.analyse', { offerId: ids.offerId, claimId, marker: 'CW-OFFER-NO-TOOL' }, { claimId });
    const ny = t.ctx.repos.getNeedsYouItem(t.ctx.db, (r.outcome.result as { needsYouId: string }).needsYouId)!;
    expect(ny).toMatchObject({ kind: 'offer_decision', recommendation: { action: 'Hold — gather more before deciding', confidence: 0.55 } });
  });
});

describe('research.ask, draft.compose, task.due, case.sweep', () => {
  it('"Ask the brain": the answer is saved as an approved claim note; a global question waits for approval', async () => {
    const res = await t.api<{ id: string }>('POST', `/claims/${claimId}/ask`, { question: 'CW-RESEARCH Is storage recoverable while the insurer delays?' });
    expect(res.status).toBe(202);
    const job = t.ctx.repos.getAgentJob(t.ctx.db, res.body.id)! as JobRecord;
    const r = await runJob(t.ctx, job);
    const m = t.ctx.repos.getMemoryItem(t.ctx.db, (r.outcome.result as { memoryId: string }).memoryId)!;
    expect(m).toMatchObject({ kind: 'research', scope: `claim:${claimId}`, status: 'approved' });
    expect(m.text).toContain('Sources: pack:synthetic-ccguk@1.0.0#storage-delay (unverified)');
    const g = await run(t.ctx, 'research.ask', { claimId, question: 'CW-RESEARCH general point', scope: 'global', askedBy: 'owner' }, { claimId });
    expect(t.ctx.repos.getMemoryItem(t.ctx.db, (g.outcome.result as { memoryId: string }).memoryId)).toMatchObject({ scope: 'global', status: 'proposed' });
    const brief = await t.api<{ notes: Array<{ id: string }> }>('GET', `/claims/${claimId}/brief`);
    expect(brief.body.notes.map((n) => n.id)).toContain(m.id);
  });

  it('draft.compose writes through the draft tools and sends the draft to review; nothing drafted → Needs-you', async () => {
    const r = await run(t.ctx, 'draft.compose', { claimId, templateId: 'letter.chaser_7', emailKind: null, purpose: 'Chase', recipientPartyId: null, replyToMessageId: null, actionCode: 'CHASER_7', dueAt: null }, { claimId });
    const drafts = (r.outcome.result as { drafts: Array<{ kind: string; id: string }> }).drafts;
    expect(drafts).toHaveLength(1);
    expect(t.ctx.repos.requireDocument(t.ctx.db, drafts[0]!.id)).toMatchObject({ status: 'draft', templateId: 'letter.chaser_7', createdBy: 'agent:drafter' });
    expect(queued(t.ctx, 'review.check').map((j) => (j.payload as { targetId: string }).targetId)).toContain(drafts[0]!.id);
    const none = await run(t.ctx, 'draft.compose', { claimId, templateId: null, emailKind: 'client_update', purpose: 'CW-NOTHING update', recipientPartyId: null, replyToMessageId: null, actionCode: null, dueAt: null }, { claimId });
    expect(t.ctx.repos.getNeedsYouItem(t.ctx.db, (none.outcome.result as { needsYouId: string }).needsYouId)).toMatchObject({ kind: 'missing_info' });
  });

  it('task.due queues a case review for a due task; case.sweep picks claims with near deadlines or no recent review', async () => {
    const task = t.ctx.repos.createTask(t.ctx.db, { claimId, kind: 'chaser', title: 'Chase', dueAt: '2026-10-07T08:00:00.000Z', createdBy: 'agent:case_manager' });
    const r = await run(t.ctx, 'task.due', { taskId: task.id });
    expect(r.followUps).toEqual([expect.objectContaining({ type: 'case.review', payload: { claimId, reason: 'task_due', taskId: task.id }, idempotencyKey: `case.review:${claimId}:task_due:${task.id}` })]);
    expect(sweepCandidates(t.ctx).map((c) => c.claimId)).toContain(claimId);
    const sweep = await run(t.ctx, 'case.sweep', { slot: 'am' });
    expect(sweep.followUps.map((j) => j.idempotencyKey)).toContain(`case.review:${claimId}:sweep:2026-10-07`);
    t.ctx.repos.markClaimReviewed(t.ctx.db, claimId, { at: T0 });
    const after = sweepCandidates(t.ctx).find((c) => c.claimId === claimId);
    expect(after?.reasons ?? []).not.toContain('no review for 7 days');
  });

  it('index.fts indexes an email / document / note for the claim corpus', async () => {
    const r = await run(t.ctx, 'draft.compose', { claimId, templateId: 'letter.chaser_7', emailKind: null, purpose: 'Chase', recipientPartyId: null, replyToMessageId: null, actionCode: 'CHASER_7', dueAt: null }, { claimId });
    const docId = (r.outcome.result as { drafts: Array<{ id: string }> }).drafts[0]!.id;
    const ix = await run(t.ctx, 'index.fts', { sourceKind: 'document', sourceId: docId });
    expect(ix.outcome.result).toEqual({ indexed: true });
    expect(t.ctx.repos.searchClaimDocs(t.ctx.db, { q: 'payment', claimId }).map((h) => h.sourceId)).toContain(docId);
    const sweep = await run(t.ctx, 'index.fts', { sourceKind: 'sweep' });
    expect(sweep.outcome.kind).toBe('done');
  });
});

describe('casework tools through the dispatcher', () => {
  const rc = (tools: string[]): RunContext => ({ runId: randomUUID(), jobId: 'job-test', agent: 'case_manager', claimScope: claimId, token: 'cdk_run_test', allowedTools: new Set(tools), runDir: t.ctx.config.agentRunsDir, correlationId: 'corr-test' });

  it('every tool has a strict schema and the read tools answer', async () => {
    for (const tool of caseworkTools) expect(tool.strictSchema).toMatchObject({ type: 'object', additionalProperties: false });
    const brief = await executeTool(t.ctx, rc(['claim_brief']), 'claim_brief', { claimId });
    expect(brief.ok).toBe(true);
    expect(brief.content).not.toContain('jane.doe@example.test');
    const q = await executeTool(t.ctx, rc(['quantum_settlement']), 'quantum_settlement', { claimId, offerPence: 100000, head: 'hire', offerId: null });
    expect(JSON.parse(q.content)).toMatchObject({ head: 'hire', offerPence: 100000, settlement: { recommendation: expect.any(String) } });
    const other = await executeTool(t.ctx, rc(['claim_brief']), 'claim_brief', { claimId: 'another-claim' });
    expect(JSON.parse(other.content).error.code).toBe('CLAIM_SCOPE');
  });

  it('task_schedule and memory_note are drafts; money and legal always ask the owner', async () => {
    await setUpMail(t.ctx);
    const task = await executeTool(t.ctx, rc(['task_schedule']), 'task_schedule', { claimId, kind: 'chaser', dueAt: '2026-10-14T09:00:00Z', note: 'Chase the insurer', actionCode: 'CHASER_7' });
    expect(JSON.parse(task.content)).toMatchObject({ taskId: expect.any(String) });
    const note = await executeTool(t.ctx, rc(['memory_note']), 'memory_note', { scope: `claim:${claimId}`, text: 'Insurer replies faster by email', basis: [] });
    expect(JSON.parse(note.content)).toMatchObject({ status: 'proposed' });
    const pay = await executeTool(t.ctx, rc(['payment_received_propose']), 'payment_received_propose', { claimId, head: 'hire', amountPence: 50000, receivedAt: '2026-10-06', sourceEvidenceId: ids.photoEvidenceId, reference: 'REM-1' });
    expect(JSON.parse(pay.content)).toMatchObject({ status: 'awaiting_owner' });
    expect(t.ctx.repos.getNeedsYouItem(t.ctx.db, pay.needsYouId!)).toMatchObject({ kind: 'money', payload: { entry: { kind: 'paid', amountPence: 50000 } } });
    const legal = await executeTool(t.ctx, rc(['legal_escalate']), 'legal_escalate', { claimId, matter: 'complaint', summary: 'The client wants to complain.', recommendation: 'Call the client', draftRefs: [] });
    expect(t.ctx.repos.getNeedsYouItem(t.ctx.db, legal.needsYouId!)).toMatchObject({ kind: 'legal_review' });
    expect(t.ctx.repos.listLedger(t.ctx.db, claimId).some((e) => e.amountPence === 50000)).toBe(false);
  });
});
