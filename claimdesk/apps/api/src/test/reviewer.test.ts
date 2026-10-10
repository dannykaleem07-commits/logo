// owned by casework
/**
 * The reviewer (docs/SUPREME-DESIGN.md §C.5 step 5, §D.5, §E.3, §K.1.7): tier a (rules, guards, pack red lines,
 * sign-off, unresolved placeholders), tier b (FACT_UNSOURCED, citations: unverified warns, failed / unknown block),
 * tier c (the critic, FakeDriver), the append-only reviews row and its follow-up, the repair-loop cap, and
 * document.after_review (automatic approval only when allow-listed + zero flags + pass). All data is invented.
 */
import { strToU8, zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GeneratedDocument, KbEntry } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import { createEmailDraft } from '../mail/outbox.js';
import { enqueueJob } from '../agent/core.js';
import type { JobRecord } from '../agent/contracts.js';
import { resolveNeedsYouItem } from '../agent/needsYou.js';
import { combineVerdict, detTouches, factsTier, loadReviewTarget, rulesTier } from '../casework/review.js';
import { buildCaseBrief } from '../casework/caseBrief.js';
import { importPack, activatePack } from '../brain/packs.js';
import { INSURER_EMAIL, queued, runJob, setUpMail } from './fixtures/mail/helpers.js';

const T0 = '2026-10-07T09:00:00.000Z';
const SIGN = 'Claims Team, Courtesy Cars Group UK Ltd';
let t: TestApp;
let claimId: string;

const KB: KbEntry[] = [
  { id: 'kb-alpha', type: 'case', citation: 'Alpha v Beta [2020] EWCA Civ 1', title: 'Alpha v Beta', principle: 'Invented.', tags: [], topics: [], verification: { status: 'verified' } },
  { id: 'kb-gamma', type: 'case', citation: 'Gamma v Delta [2019] EWHC 2 (QB)', title: 'Gamma v Delta', principle: 'Invented.', tags: [], topics: [], verification: { status: 'unverified' } },
  { id: 'kb-epsilon', type: 'case', citation: 'Epsilon v Zeta [2018] EWCA Civ 3', title: 'Epsilon v Zeta', principle: 'Invented.', tags: [], topics: [], verification: { status: 'failed' } },
] as unknown as KbEntry[];

beforeEach(async () => {
  t = await createTestApp(T0, { config: { aiDriverOverride: 'fake' } });
  claimId = t.ctx.repos.seedFileOne(t.ctx.db).claimId;
  recomputeClocks(t.ctx, claimId);
  await setUpMail(t.ctx);
  t.ctx.kb.entries = () => KB;
});
afterEach(async () => {
  await t.close();
});

function email(body: string, extra: { kind?: 'chaser' | 'ack' | 'doc_request'; to?: string[] } = {}) {
  return createEmailDraft(t.ctx, { claimId, kind: extra.kind ?? 'ack', to: extra.to ?? [INSURER_EMAIL], cc: [], subject: 'Your claim', bodyText: body, attach: [], inReplyToMessageId: null }, 'agent:mail', { loop: 0 }).outbox;
}

async function reviewOutbox(outboxId: string) {
  const job = queued(t.ctx, 'review.check').find((j) => (j.payload as { targetId: string }).targetId === outboxId)!;
  expect(job).toBeDefined();
  const r = await runJob(t.ctx, job);
  return { r, review: t.ctx.repos.latestReviewFor(t.ctx.db, { kind: 'outbox', id: outboxId })! };
}

const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code);

describe('tier a — rules', () => {
  it('runs checkDraft, the guards, the sign-off check and flags unresolved placeholders', () => {
    const o = email('We confirm the position.');
    // mail refuses to store an email with an unresolvable placeholder; the reviewer still checks for one
    const target = loadReviewTarget(t.ctx, 'outbox', o.id);
    const a = rulesTier(t.ctx, { ...target, text: `${target.text} {{fact:not.a.fact}}` });
    expect(codes(a.issues)).toEqual(expect.arrayContaining(['SIGNOFF_MISSING', 'FACT_UNKNOWN']));
    expect(a.issues.find((i) => i.code === 'FACT_UNKNOWN')?.severity).toBe('block');
  });

  it('applies the red lines of every active pack', async () => {
    const dir = path.join(path.dirname(t.ctx.config.dataDir), 'packs-src');
    mkdirSync(dir, { recursive: true });
    const entries = strToU8(JSON.stringify({ id: 'no-threat', kind: 'redLine', title: 'No threats', pattern: 'issue proceedings', action: 'block', message: 'Never threaten proceedings', scope: 'all' }));
    const manifest = { schema: 'claimdesk.brainpack/1', id: 'reds', name: 'Reds', version: '1.0.0', business: ['ccguk'], files: { 'entries/r.jsonl': createHash('sha256').update(entries).digest('hex') } };
    const file = path.join(dir, 'reds.ccbrain');
    writeFileSync(file, zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'entries/r.jsonl': entries }));
    importPack(t.ctx, { kind: 'path', path: file }, { userId: 'owner' });
    activatePack(t.ctx, 'reds', {}, { userId: 'owner' });
    const o = email(`Unless you pay we will issue proceedings.\n\n${SIGN}`);
    const a = rulesTier(t.ctx, loadReviewTarget(t.ctx, 'outbox', o.id));
    expect(a.redLines).toEqual(['pack:reds@1.0.0#no-threat']);
    expect(a.issues.find((i) => i.code === 'RED_LINE')).toMatchObject({ severity: 'block' });
  });
});

describe('tier b — facts', () => {
  it('FACT_UNSOURCED for a typed figure, date or reference; facts and quoted figures pass', () => {
    const brief = buildCaseBrief(t.ctx, claimId, { mask: false });
    const typed = email(`The balance of £999.99 was due on 3 March 2026 under ref ABC/2026/999.\n\n${SIGN}`);
    const b1 = factsTier(t.ctx, loadReviewTarget(t.ctx, 'outbox', typed.id), brief);
    expect(b1.issues.filter((i) => i.code === 'FACT_UNSOURCED')).toHaveLength(3);
    expect(b1.issues.every((i) => i.severity === 'block')).toBe(true);
    const sourced = email(`Hire at ${brief.facts['hire.current.dailyRatePence']!.display} a day from ${brief.facts['hire.current.startAt']!.display}, our ref ${brief.reference}, your ref ${brief.facts['claim.atFaultInsurerRef']!.display}.\n\n${SIGN}`);
    expect(factsTier(t.ctx, loadReviewTarget(t.ctx, 'outbox', sourced.id), brief).issues).toEqual([]);
  });

  it('citations: verified pass, unverified warn, failed and unknown block', () => {
    const brief = buildCaseBrief(t.ctx, claimId, { mask: false });
    const o = email(`See Alpha v Beta [2020] EWCA Civ 1, Gamma v Delta [2019] EWHC 2 (QB), Epsilon v Zeta [2018] EWCA Civ 3 and Omega v Psi [2017] EWCA Civ 4.\n\n${SIGN}`);
    const b = factsTier(t.ctx, loadReviewTarget(t.ctx, 'outbox', o.id), brief);
    expect(b.issues.map((i) => `${i.code}:${i.severity}`).sort()).toEqual(['CITATION_FAILED:block', 'CITATION_UNKNOWN:block', 'UNVERIFIED_CITATION:warn']);
  });
});

describe('review.check — tiers together', () => {
  it('blocking det issues → repair without running the critic; the row is append-only', async () => {
    const o = email(`The balance of £999.99 is due.\n\n${SIGN}`);
    const { r, review } = await reviewOutbox(o.id);
    expect(r.outcome.result).toMatchObject({ verdict: 'repair', critic: 'skipped' });
    expect(review).toMatchObject({ verdict: 'repair', loop: 0, targetKind: 'outbox' });
    expect(review.critic).toBeUndefined();
    expect(r.followUps.map((j) => j.type)).toEqual(['outbox.after_review']);
    expect(r.followUps[0]!.payload).toEqual({ outboxId: o.id, reviewId: review.id });
    expect(() => t.ctx.handle.sqlite.prepare('UPDATE reviews SET verdict = ? WHERE id = ?').run('pass', review.id)).toThrow();
  });

  it('a clean draft goes to the critic (separate run) → pass; touches come from code and critic', async () => {
    const o = email(`Thank you for your email, which we have noted.\n\n${SIGN}`);
    const { r, review } = await reviewOutbox(o.id);
    expect(r.outcome.result).toMatchObject({ verdict: 'pass', critic: 'ran' });
    expect(review.runId).toBeTruthy();
    expect(review.critic).toMatchObject({ verdict: 'pass', confidence: 0.95 });
    expect(review.touches).toEqual({ money: false, liability: false, settlement: false, legal: false, newCommitment: false });
    const run = t.ctx.repos.getAgentRun(t.ctx.db, review.runId!)!;
    expect(run).toMatchObject({ agent: 'reviewer', jobType: 'review.check', model: 'claude-opus-5-5', effort: 'high' });
    expect(detTouches('We will pay you £10 and accept your offer.')).toMatchObject({ money: true, settlement: true, newCommitment: true });
  });

  it('the critic can ask for a repair; the repair loop is capped at 2 then escalates', async () => {
    const o = email(`CW-CRITIC-REPAIR Please send it.\n\n${SIGN}`);
    const { review } = await reviewOutbox(o.id);
    expect(review.verdict).toBe('repair');
    expect(combineVerdict('repair', undefined, 2)).toBe('escalate');
    expect(combineVerdict('pass', 'repair', 1)).toBe('repair');
    expect(combineVerdict('pass', 'escalate', 0)).toBe('escalate');
    const late = email(`The balance of £999.99 is due.\n\n${SIGN}`);
    const job = queued(t.ctx, 'review.check').find((j) => (j.payload as { targetId: string }).targetId === late.id)!;
    const r = await runJob(t.ctx, { ...job, payload: { ...(job.payload as object), loop: 2 } } as JobRecord);
    expect(r.outcome.result).toMatchObject({ verdict: 'escalate' });
  });

  it('a draft prepared for missing information is marked so the policy asks (missing_info)', async () => {
    const parent = enqueueJob(t.ctx, { type: 'draft.compose', payload: { claimId, templateId: null, emailKind: 'doc_request', purpose: 'V5C', recipientPartyId: null, replyToMessageId: null, actionCode: null, dueAt: null, missingInfo: true }, claimId, idempotencyKey: 'test:parent', createdBy: 'test' });
    const o = createEmailDraft(t.ctx, { claimId, kind: 'chaser', to: ['jane.doe@example.test'], cc: [], subject: 'V5C', bodyText: `Please send us your V5C.\n\n${SIGN}`, attach: [], inReplyToMessageId: null }, 'agent:drafter', { loop: 0, jobId: parent.id, parentJobId: parent.id }).outbox;
    const { review } = await reviewOutbox(o.id);
    expect((review.rules as { missingInfo: boolean; issues: Array<{ code: string }> }).missingInfo).toBe(true);
    expect(codes((review.rules as { issues: Array<{ code: string }> }).issues)).toContain('MISSING_INFO_REQUEST');
  });
});

describe('document.after_review (§D.5)', () => {
  async function draftAndReview(): Promise<{ doc: GeneratedDocument; after: Awaited<ReturnType<typeof runJob>> }> {
    const res = await t.api<GeneratedDocument>('POST', `/claims/${claimId}/documents`, { templateId: 'letter.chaser_7' });
    expect(res.status).toBe(201);
    const rj = enqueueJob(t.ctx, { type: 'review.check', payload: { targetKind: 'document', targetId: res.body.id, loop: 0 }, claimId, idempotencyKey: `review.check:document:${res.body.id}:0`, createdBy: 'agent:drafter' });
    const r = await runJob(t.ctx, rj);
    expect(r.outcome.result).toMatchObject({ verdict: 'pass', critic: 'ran' });
    const [after] = r.followUps;
    expect(after!.type).toBe('document.after_review');
    return { doc: res.body, after: await runJob(t.ctx, after!) };
  }

  it('allow-listed template + zero flags + pass → approved automatically and audited', async () => {
    const { doc, after } = await draftAndReview();
    expect(after.outcome.result).toMatchObject({ outcome: 'approved' });
    expect(t.ctx.repos.requireDocument(t.ctx.db, doc.id)).toMatchObject({ status: 'approved', approvedBy: 'agent:reviewer' });
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'document.approve.auto' })).toHaveLength(1);
  });

  it('not allow-listed → Needs-you approve_document; the owner approves through the resolver', async () => {
    t.ctx.repos.patchAgentSettings(t.ctx.db, { autonomy: { autoApproveTemplates: [] } }, { userId: 'owner' });
    const { doc, after } = await draftAndReview();
    expect(after.outcome.result).toMatchObject({ outcome: 'asked' });
    expect(t.ctx.repos.requireDocument(t.ctx.db, doc.id).status).toBe('draft');
    const ny = t.ctx.repos.getNeedsYouItem(t.ctx.db, (after.outcome.result as { needsYouId: string }).needsYouId)!;
    expect(ny).toMatchObject({ kind: 'approve_document', claimId });
    expect(ny.summary).toMatch(/not allow-listed/);
    await resolveNeedsYouItem(t.ctx, ny.id, { optionId: 'approve' }, { userId: 'handler' });
    expect(t.ctx.repos.requireDocument(t.ctx.db, doc.id)).toMatchObject({ status: 'approved', approvedBy: 'handler' });
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'document.approve.auto' })).toHaveLength(0);
  });
});
