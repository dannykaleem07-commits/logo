// owned by mail
/**
 * The outbox (docs/SUPREME-DESIGN.md §D.2, §D.3, §D.5, §F.6–§F.8): email_draft → reviewing → after_review → held with
 * Undo (toast) → release → FakeSmtp; the sent record exists only after SMTP accepted; SMTP failures retry 3× then fail
 * with Needs-you; quiet hours hold until 07:30; rate limits ask; the kill switch keeps held items held; an allow-listed
 * attached letter is approved automatically through §D.5 while an always-ask template goes to approve_send; owner
 * compose has a 30-second Undo and no review; repair loops are capped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import type { GeneratedDocument } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import { resolveNeedsYouItem } from '../agent/needsYou.js';
import { registerPlaceholderResolver } from '../ai/prompts.js';
import { createEmailDraft, recipientInfo } from '../mail/outbox.js';
import type { FakeMailbox, FakeSmtp } from '../mail/transport.js';
import { INSURER_EMAIL, MAILBOX, TOUCHES_NONE, eml, queued, run, runJob, setUpMail } from './fixtures/mail/helpers.js';

const CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (!process.env.CHROMIUM_PATH && existsSync(CHROMIUM)) process.env.CHROMIUM_PATH = CHROMIUM;

const T0 = '2026-10-07T09:00:00.000Z'; // 10:00 in London
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();
const OWNER = { userId: 'courtesycars' };

let t: TestApp;
let claimId: string;
let reference: string;
let mailbox: FakeMailbox;
let smtp: FakeSmtp;
let accountId: string;
let inboundId: string;

beforeEach(async () => {
  t = await createTestApp(T0, { config: { aiDriverOverride: 'fake' } });
  const ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  claimId = ids.claimId;
  reference = t.ctx.repos.requireClaim(t.ctx.db, claimId).reference;
  ({ mailbox, smtp, accountId } = await setUpMail(t.ctx));
  // A previous email to the insurer's handler on this claim (so it is not a first contact).
  const prior = t.ctx.repos.createOutbox(t.ctx.db, { claimId, accountId, kind: 'chaser', to: [INSURER_EMAIL], subject: 'Earlier', bodyText: 'x', createdBy: 'courtesycars', now: '2026-09-01T09:00:00.000Z' });
  t.ctx.repos.transitionOutbox(t.ctx.db, prior.id, 'queued', 'courtesycars', 'approved', { now: '2026-09-01T09:00:00.000Z' });
  t.ctx.repos.transitionOutbox(t.ctx.db, prior.id, 'sending', 'agent:mail', 'smtp', { now: '2026-09-01T09:00:00.000Z' });
  t.ctx.repos.transitionOutbox(t.ctx.db, prior.id, 'sent', 'agent:mail', 'ok', { patch: { smtpMessageId: '<prior@ccguk-test.example>' }, now: '2026-09-01T09:00:00.000Z' });
  // The inbound email we answer.
  mailbox.deliver(eml({ subject: `Your client — ${reference}`, messageId: '<inbound-1@example-insurer.test>', body: 'Please confirm you have our letter.' }));
  await run(t.ctx, 'mail.sync', {});
  inboundId = t.ctx.repos.listMailMessages(t.ctx.db, { direction: 'in' })[0]!.id;
});
afterEach(async () => {
  registerPlaceholderResolver(t.ctx, undefined);
  await t.close();
});

async function draftReply(plan = 'MAILFX-REPLY acknowledge the email'): Promise<string> {
  const r = await run(t.ctx, 'mail.reply', { claimId, messageId: inboundId, plan, keyPoints: [] }, { claimId });
  expect(r.outcome.kind, JSON.stringify(r.outcome)).toBe('done');
  const id = (r.outcome.result as { drafts: string[] }).drafts[0]!;
  expect(id).toBeTruthy();
  return id;
}

function review(outboxId: string, verdict: 'pass' | 'repair' | 'escalate' = 'pass', extra: { confidence?: number; touches?: Partial<typeof TOUCHES_NONE>; loop?: number; issues?: unknown[] } = {}) {
  return t.ctx.repos.appendReview(t.ctx.db, { targetKind: 'outbox', targetId: outboxId, claimId, loop: extra.loop ?? 0, rules: { issues: [] }, facts: { issues: [] }, critic: { confidence: extra.confidence ?? 0.95, issues: extra.issues ?? [] }, verdict, touches: { ...TOUCHES_NONE, ...extra.touches }, now: t.ctx.now() });
}

async function afterReview(outboxId: string, reviewId: string) {
  return (await run(t.ctx, 'outbox.after_review', { outboxId, reviewId })).outcome.result as { outcome: string; holdUntil?: string; needsYouId?: string; jobs: string[] };
}

const outbox = (id: string) => t.ctx.repos.requireOutbox(t.ctx.db, id);
const releaseJobs = () => queued(t.ctx, 'outbox.release');

describe('draft → review → hold → undo', () => {
  it('email_draft tags the subject, threads the reply and sends it to the reviewer; a pass review holds it with an Undo toast', async () => {
    const id = await draftReply();
    const o = outbox(id);
    expect(o).toMatchObject({ status: 'reviewing', kind: 'ack', claimId, toJson: [INSURER_EMAIL], subject: `Re: Your client [${reference}]`, inReplyTo: '<inbound-1@example-insurer.test>', createdBy: 'agent:mail' });
    expect(o.bodyText).toContain('Claims Team, Courtesy Cars Group UK Ltd');
    const [rc] = queued(t.ctx, 'review.check');
    expect(rc).toMatchObject({ claimId, payload: { targetKind: 'outbox', targetId: id, loop: 0 }, idempotencyKey: `review.check:outbox:${id}:0` });
    expect(recipientInfo(t.ctx, claimId, INSURER_EMAIL, id)).toMatchObject({ role: 'at_fault_insurer', verified: true, onClaim: true, firstContact: false });

    const res = await afterReview(id, review(id).id);
    expect(res).toMatchObject({ outcome: 'held', holdUntil: at(10) });
    expect(outbox(id)).toMatchObject({ status: 'held', holdUntil: at(10), policy: { outcome: 'auto_held', ruleIds: ['external_ok'] } });
    const [n] = t.ctx.repos.listNotifications(t.ctx.db, { limit: 5 });
    expect(n).toMatchObject({ title: 'Sending in 10 min — Undo', link: `/outbox?focus=${id}` });
    expect(n!.channels.join(' ')).toContain(`"undoOutboxId":"${id}"`);
    expect(releaseJobs().map((j) => j.runAfter)).toEqual([at(10)]);

    const undo = await t.api('POST', `/outbox/${id}/undo`);
    expect(undo.status).toBe(200);
    expect(outbox(id).status).toBe('cancelled');
    t.setNow(at(11));
    const rel = await runJob(t.ctx, releaseJobs()[0]!);
    expect(rel.outcome.result).toMatchObject({ outcome: 'skipped' });
    expect(smtp.sent).toHaveLength(0);
    expect(t.ctx.repos.listOutboxEvents(t.ctx.db, id).map((e) => `${e.toStatus}:${e.actor}`)).toEqual(['draft:agent:mail', 'reviewing:agent:mail', 'held:agent:mail', 'cancelled:handler']);
  });

  it('release after the hold: SMTP first, then the sent copy, Sent folder, email_out, audit — and Undo is impossible afterwards', async () => {
    const id = await draftReply();
    await afterReview(id, review(id).id);
    t.setNow(at(9));
    expect((await runJob(t.ctx, releaseJobs()[0]!)).outcome.result).toMatchObject({ outcome: 'deferred' });
    t.setNow(at(10));
    const [job] = releaseJobs();
    const r = await runJob(t.ctx, job!);
    expect(r.outcome.result).toMatchObject({ outcome: 'sent' });
    expect(smtp.sent).toHaveLength(1);
    const msg = smtp.sent[0]!;
    expect(msg.from).toBe(`"Claims Team, Courtesy Cars Group UK Ltd" <${MAILBOX}>`);
    expect(msg.messageId).toMatch(/^<[0-9a-f-]{36}@ccguk-test\.example>$/);
    expect(msg.inReplyTo).toBe('<inbound-1@example-insurer.test>');
    expect(msg.references).toEqual(['<inbound-1@example-insurer.test>']);
    expect(msg.raw.toString()).toContain('Claims Team, Courtesy Cars Group UK Ltd');
    const o = outbox(id);
    expect(o).toMatchObject({ status: 'sent', smtpMessageId: msg.messageId, attempts: 1 });
    expect(t.ctx.repos.requireEvidence(t.ctx.db, o.rawSentEvidenceId!)).toMatchObject({ claimId, mime: 'message/rfc822', kind: 'correspondence' });
    expect(mailbox.messages('Sent')).toHaveLength(1);
    expect(mailbox.messages('Sent')[0]!.flags).toEqual(['\\Seen']);
    const out = t.ctx.repos.listEvents(t.ctx.db, claimId).filter((e) => e.type === 'email_out');
    expect(out).toHaveLength(1);
    expect(out[0]!.evidenceIds).toEqual([o.rawSentEvidenceId]);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'email.send' })[0]).toMatchObject({ userId: 'agent:mail', entityId: id, after: { smtpMessageId: msg.messageId, automatic: true } });
    expect(t.ctx.repos.listMailMessages(t.ctx.db, { direction: 'out' })[0]).toMatchObject({ claimId, source: 'smtp', messageId: msg.messageId });
    const late = await t.api<{ error: { code: string } }>('POST', `/outbox/${id}/undo`);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OUTBOX_SENT');
  });
});

describe('SMTP failures', () => {
  it('nothing is recorded as sent until SMTP accepts; a failure retries with backoff', async () => {
    const id = await draftReply();
    await afterReview(id, review(id).id);
    t.setNow(at(10));
    smtp.failNext = 1;
    const r1 = await runJob(t.ctx, releaseJobs()[0]!);
    expect(r1.outcome.result).toMatchObject({ outcome: 'retrying' });
    expect(outbox(id)).toMatchObject({ status: 'queued', attempts: 1, lastError: 'fake SMTP is down' });
    expect(outbox(id).smtpMessageId).toBeUndefined();
    expect(outbox(id).rawSentEvidenceId).toBeUndefined();
    expect(t.ctx.repos.listEvents(t.ctx.db, claimId).filter((e) => e.type === 'email_out')).toHaveLength(0);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'email.send' })).toHaveLength(0);
    const [retry] = releaseJobs();
    expect(retry!.runAfter).toBe(at(11));
    t.setNow(at(11));
    expect((await runJob(t.ctx, retry!)).outcome.result).toMatchObject({ outcome: 'sent' });
    expect(outbox(id)).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('three failures → failed + Needs-you; nothing sent; the owner can retry', async () => {
    const id = await draftReply();
    await afterReview(id, review(id).id);
    smtp.failNext = 3;
    for (const min of [10, 11, 16]) {
      t.setNow(at(min));
      await runJob(t.ctx, releaseJobs()[0]!);
    }
    expect(outbox(id)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(smtp.sent).toHaveLength(0);
    const [ny] = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'failure' });
    expect(ny!.title).toMatch(/^Email not sent/);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'email.send' })).toHaveLength(0);
    const retry = await t.api('POST', `/outbox/${id}/retry`);
    expect(retry.status).toBe(200);
    await runJob(t.ctx, releaseJobs()[0]!);
    expect(outbox(id).status).toBe('sent');
  });
});

describe('policy at review time', () => {
  it('quiet hours hold until 07:30 London', async () => {
    t.setNow('2026-10-07T20:30:00.000Z'); // 21:30 BST
    const id = await draftReply();
    const res = await afterReview(id, review(id).id);
    expect(res).toMatchObject({ outcome: 'held', holdUntil: '2026-10-08T06:30:00.000Z' });
    expect((outbox(id).policy as { ruleIds: string[] }).ruleIds).toEqual(['quiet_hours']);
  });

  it('rate limits ask the owner; the owner’s edited approval sends at once (owner-approved sends skip the automatic limits)', async () => {
    for (let i = 0; i < 3; i++) {
      const o = t.ctx.repos.createOutbox(t.ctx.db, { claimId, accountId, kind: 'ack', to: [INSURER_EMAIL], subject: `auto ${i}`, bodyText: 'x', createdBy: 'agent:mail', now: T0 });
      t.ctx.repos.transitionOutbox(t.ctx.db, o.id, 'held', 'agent:mail', 'auto', { patch: { policy: { outcome: 'auto_held', ruleIds: ['external_ok'] }, holdUntil: at(60) }, now: T0 });
    }
    const id = await draftReply();
    const res = await afterReview(id, review(id).id);
    expect(res.outcome).toBe('asked');
    expect(outbox(id)).toMatchObject({ status: 'awaiting_approval', policy: { outcome: 'ask', ruleIds: ['rate_limits'] } });
    const [ny] = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'approve_send' });
    expect(ny!.payload).toMatchObject({ outboxId: id, email: { to: [INSURER_EMAIL] } });

    await resolveNeedsYouItem(t.ctx, ny!.id, { optionId: 'edit', edits: { bodyText: 'Thank you — noted on our file.\n\nClaims Team, Courtesy Cars Group UK Ltd' } }, OWNER);
    expect(outbox(id)).toMatchObject({ status: 'queued', approvedBy: 'courtesycars', bodyText: 'Thank you — noted on our file.\n\nClaims Team, Courtesy Cars Group UK Ltd' });
    const rel = releaseJobs().find((j) => (j.payload as { outboxId: string }).outboxId === id)!;
    expect(rel.runAfter).toBe(T0); // no hold after an owner approval
    await runJob(t.ctx, rel);
    expect(outbox(id).status).toBe('sent');
    expect(smtp.sent[0]!.text).toContain('noted on our file');
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'email.send' })[0]).toMatchObject({ userId: 'courtesycars' });
  });

  it('a review that touches money (or low confidence) asks; repair loops are capped at two', async () => {
    const id = await draftReply();
    expect((await afterReview(id, review(id, 'pass', { touches: { money: true } }).id)).outcome).toBe('asked');
    expect(outbox(id).policy).toMatchObject({ ruleIds: ['touches'] });

    const id2 = await draftReply();
    const r1 = await afterReview(id2, review(id2, 'repair', { issues: [{ code: 'TONE', severity: 'warn', message: 'too curt' }] }).id);
    expect(r1.outcome).toBe('repair');
    expect(outbox(id2).status).toBe('cancelled');
    const [reply1] = queued(t.ctx, 'mail.reply');
    expect(reply1!.payload).toMatchObject({ loop: 1, repairOf: id2, issues: [{ code: 'TONE' }] });
    const loop1 = await runJob(t.ctx, reply1!);
    const id3 = (loop1.outcome.result as { drafts: string[] }).drafts[0]!;
    expect(queued(t.ctx, 'review.check').some((j) => j.idempotencyKey === `review.check:outbox:${id3}:1`)).toBe(true);
    await afterReview(id3, review(id3, 'repair', { loop: 1 }).id);
    const [reply2] = queued(t.ctx, 'mail.reply');
    const id4 = ((await runJob(t.ctx, reply2!)).outcome.result as { drafts: string[] }).drafts[0]!;
    const last = await afterReview(id4, review(id4, 'repair', { loop: 2 }).id);
    expect(last.outcome).toBe('escalated');
    expect(outbox(id4).status).toBe('awaiting_approval');
    expect(queued(t.ctx, 'mail.reply')).toHaveLength(0);
  });
});

describe('release re-checks', () => {
  it('the kill switch keeps a held email held and checks again later', async () => {
    const id = await draftReply();
    await afterReview(id, review(id).id);
    t.ctx.repos.patchAgentSettings(t.ctx.db, { autonomy: { killSwitch: true } }, OWNER);
    t.setNow(at(10));
    const r = await runJob(t.ctx, releaseJobs()[0]!);
    expect(r.outcome.result).toMatchObject({ outcome: 'deferred', reason: 'kill switch' });
    expect(outbox(id).status).toBe('held');
    expect(releaseJobs()[0]!.runAfter).toBe(at(15));
    expect(smtp.sent).toHaveLength(0);
  });

  it('a claim paused after the hold started asks the owner instead of sending', async () => {
    const id = await draftReply();
    await afterReview(id, review(id).id);
    t.ctx.repos.pauseClaimAgents(t.ctx.db, claimId, { actor: OWNER, reason: 'checking', now: T0 });
    t.setNow(at(10));
    expect((await runJob(t.ctx, releaseJobs()[0]!)).outcome.result).toMatchObject({ outcome: 'asked' });
    expect(outbox(id).status).toBe('awaiting_approval');
  });
});

describe('attached documents (§D.5, §F.7)', () => {
  async function draftDocument(templateId: string, data?: Record<string, unknown>): Promise<GeneratedDocument> {
    const res = await t.api<GeneratedDocument>('POST', `/claims/${claimId}/documents`, { templateId, ...(data ? { data } : {}) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  }

  it('an allow-listed draft letter with its own pass review is approved by agent:mail, sent with the email and recorded as sent', async () => {
    const doc = await draftDocument('letter.chaser_7');
    t.ctx.repos.appendReview(t.ctx.db, { targetKind: 'document', targetId: doc.id, claimId, loop: 0, rules: {}, facts: {}, verdict: 'pass', touches: TOUCHES_NONE });
    const { outbox: o } = createEmailDraft(t.ctx, { claimId, kind: 'chaser', to: [INSURER_EMAIL], cc: [], subject: 'Chaser', bodyText: 'Please see the attached letter.\n\nClaims Team, Courtesy Cars Group UK Ltd', attach: [{ evidenceId: null, documentId: doc.id }], inReplyToMessageId: inboundId }, 'agent:mail', { loop: 0 });
    const res = await afterReview(o.id, review(o.id).id);
    expect(res.outcome).toBe('held');
    expect(t.ctx.repos.requireDocument(t.ctx.db, doc.id)).toMatchObject({ status: 'approved', approvedBy: 'agent:mail' });
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'document.approve.auto' })[0]).toMatchObject({ userId: 'agent:mail', entityId: doc.id });
    t.setNow(at(10));
    await runJob(t.ctx, releaseJobs()[0]!);
    expect(outbox(o.id).status).toBe('sent');
    expect(smtp.sent[0]!.attachments).toHaveLength(1);
    expect(smtp.sent[0]!.attachments[0]!.contentType).toBe('application/pdf');
    expect(t.ctx.repos.requireDocument(t.ctx.db, doc.id)).toMatchObject({ status: 'sent', sentVia: 'email' });
  });

  it('an always-ask template is never approved or sent automatically → approve_send', async () => {
    const doc = await draftDocument('letter.dsar', { authorityDate: '2026-10-01' });
    t.ctx.repos.appendReview(t.ctx.db, { targetKind: 'document', targetId: doc.id, claimId, loop: 0, rules: {}, facts: {}, verdict: 'pass', touches: TOUCHES_NONE });
    const { outbox: o } = createEmailDraft(t.ctx, { claimId, kind: 'reply_general', to: [INSURER_EMAIL], cc: [], subject: 'Request', bodyText: 'Attached.\n\nClaims Team, Courtesy Cars Group UK Ltd', attach: [{ evidenceId: null, documentId: doc.id }], inReplyToMessageId: null }, 'agent:mail', { loop: 0 });
    const res = await afterReview(o.id, review(o.id).id);
    expect(res.outcome).toBe('asked');
    expect(outbox(o.id).policy).toMatchObject({ outcome: 'ask', ruleIds: ['allowlist'] });
    expect(t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'approve_send' })).toHaveLength(1);
    expect(t.ctx.repos.requireDocument(t.ctx.db, doc.id).status).not.toBe('approved');
  });

  it('a bank statement is never attached automatically, and evidence from another claim is refused', async () => {
    const { storeEvidenceBuffer } = await import('../services/evidence.js');
    const bank = await storeEvidenceBuffer(t.ctx, Buffer.from('invented statement'), { claimId, filename: 'statement.pdf', mime: 'application/pdf', fields: { kind: 'bank_statement' }, actor: OWNER });
    const r = createEmailDraft(t.ctx, { claimId, kind: 'info_provided', to: [INSURER_EMAIL], cc: [], subject: 'Docs', bodyText: 'Attached.', attach: [{ evidenceId: bank.evidence.id, documentId: null }], inReplyToMessageId: null }, 'agent:mail', { loop: 0 });
    expect(r.attachmentsAllowed).toBe(false);
    expect((await afterReview(r.outbox.id, review(r.outbox.id).id)).outcome).toBe('asked');
    expect(outbox(r.outbox.id).policy).toMatchObject({ ruleIds: ['attachments'] });
    const other = await storeEvidenceBuffer(t.ctx, Buffer.from('other claim file'), { filename: 'x.pdf', mime: 'application/pdf', fields: { kind: 'photo' }, actor: OWNER });
    expect(() => createEmailDraft(t.ctx, { claimId, kind: 'info_provided', to: [INSURER_EMAIL], cc: [], subject: 'Docs', bodyText: 'Attached.', attach: [{ evidenceId: other.evidence.id, documentId: null }], inReplyToMessageId: null }, 'agent:mail', { loop: 0 })).toThrow(/not on claim/);
  });
});

describe('placeholders', () => {
  it('without a fact resolver a draft with {{fact:}} is refused; with one, code fills it', async () => {
    const r = await run(t.ctx, 'mail.reply', { claimId, messageId: inboundId, plan: 'MAILFX-FIGURES state the hire charges', keyPoints: [] }, { claimId });
    expect(r.outcome.result).toMatchObject({ drafts: 0 });
    const call = t.ctx.handle.sqlite.prepare("select decision, output_summary from agent_tool_calls where tool = 'email_draft'").get() as { decision: string; output_summary: string };
    expect(call.decision).toBe('error');
    expect(call.output_summary).toContain('PLACEHOLDERS_UNRESOLVED');
    expect(t.ctx.repos.listOutbox(t.ctx.db, { claimId, status: 'reviewing' })).toHaveLength(0);

    registerPlaceholderResolver(t.ctx, (_ctx, _claimId, text) => text.replace(/\{\{fact:ledger\.hire\.claimedPence\}\}/g, '£1,145.40'));
    const d = createEmailDraft(t.ctx, { claimId, kind: 'info_provided', to: [INSURER_EMAIL], cc: [], subject: 'Hire', bodyText: 'The hire charges are {{fact:ledger.hire.claimedPence}}.', attach: [], inReplyToMessageId: null }, 'agent:mail', { loop: 0 });
    expect(d.outbox.bodyText).toContain('£1,145.40');
  });
});

describe('owner compose', () => {
  it('sends after a 30-second Undo without a review', async () => {
    const res = await t.api<{ item: { id: string; status: string; holdUntil: string; approvedBy: string } }>('POST', '/outbox', { claimId, to: [INSURER_EMAIL], subject: 'From me', bodyText: 'Owner email.' });
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({ status: 'held', holdUntil: new Date(Date.parse(T0) + 30_000).toISOString(), approvedBy: 'handler' });
    expect(queued(t.ctx, 'review.check')).toHaveLength(0);
    t.setNow(new Date(Date.parse(T0) + 31_000).toISOString());
    await runJob(t.ctx, releaseJobs()[0]!);
    expect(outbox(res.body.item.id)).toMatchObject({ status: 'sent', subject: `From me [${reference}]` });
    expect(smtp.sent).toHaveLength(1);
  });

  it('“check before sending” goes to the reviewer first; a list of the outbox shows it', async () => {
    const res = await t.api<{ item: { id: string; status: string } }>('POST', '/outbox', { claimId, to: [INSURER_EMAIL], subject: 'Check me', bodyText: 'Please check.', checkBeforeSending: true });
    expect(res.body.item.status).toBe('reviewing');
    expect(queued(t.ctx, 'review.check')[0]!.payload).toMatchObject({ targetKind: 'outbox', targetId: res.body.item.id });
    const list = await t.api<{ items: Array<{ id: string }>; counts: Record<string, number> }>('GET', '/outbox?status=reviewing');
    expect(list.body.items.map((i) => i.id)).toEqual([res.body.item.id]);
    expect(list.body.counts.reviewing).toBe(1);
  });
});
