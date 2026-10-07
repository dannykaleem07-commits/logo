// owned by mail
/**
 * Matching an email to a claim (docs/SUPREME-DESIGN.md §F.4): every signal and its exact weight, the insurer-reference
 * normaliser, UK registration formats (current, prefix, suffix, dateless), threading through our own sent Message-ID,
 * the thresholds (auto ≥ 90 and ≥ 30 ahead; 50–89 or a tie → which_claim with the top three; < 50 unmatched) and the
 * owner's which_claim answer filing the message (decided_by owner) and continuing triage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import { decideMatch, extractVrms, matchMessage, normaliseInsurerRef, MATCH_SCORES, type MatchCandidate, type MatchInput } from '../mail/match.js';
import { resolveNeedsYouItem } from '../agent/needsYou.js';
import { INSURER_EMAIL, eml, makeClaim, queued, run, setUpMail } from './fixtures/mail/helpers.js';

const T0 = '2026-10-07T09:00:00.000Z';
const OWNER = { userId: 'courtesycars' };

let t: TestApp;
let claimId: string;
let reference: string;
beforeEach(async () => {
  t = await createTestApp(T0);
  const ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  claimId = ids.claimId;
  reference = t.ctx.repos.requireClaim(t.ctx.db, claimId).reference;
  await setUpMail(t.ctx);
});
afterEach(async () => {
  await t.close();
});

const input = (o: Partial<MatchInput>): MatchInput => ({ text: '', attachmentNames: [], references: [], fromAddr: 'nobody@unrelated.example', ...o });
const scoreFor = (o: Partial<MatchInput>, id = claimId) => matchMessage(t.ctx, input(o)).candidates.find((c) => c.claimId === id);
const codes = (c: MatchCandidate | undefined) => (c?.signals ?? []).map((s) => s.code).sort();

describe('signals and weights', () => {
  it('our reference anywhere (subject, body, attachment name) scores +100 and auto-links', () => {
    expect(scoreFor({ subject: `Re: ${reference}` })).toMatchObject({ score: MATCH_SCORES.ourRef });
    expect(scoreFor({ text: `our ref ${reference.toLowerCase()}` })?.score).toBe(100);
    expect(scoreFor({ attachmentNames: [`${reference} invoice.pdf`] })?.score).toBe(100);
    expect(matchMessage(t.ctx, input({ subject: reference }))).toMatchObject({ decision: 'auto', claimId });
  });

  it('In-Reply-To / References to our sent email (outbox.smtp_message_id) scores +90 and auto-links', () => {
    const account = t.ctx.repos.getDefaultMailAccount(t.ctx.db)!;
    const o = t.ctx.repos.createOutbox(t.ctx.db, { claimId, accountId: account.id, kind: 'chaser', to: [INSURER_EMAIL], subject: 'Chaser', bodyText: 'x', createdBy: 'agent:mail' });
    t.ctx.repos.transitionOutbox(t.ctx.db, o.id, 'queued', 'courtesycars', 'approved');
    t.ctx.repos.transitionOutbox(t.ctx.db, o.id, 'sending', 'agent:mail', 'smtp');
    t.ctx.repos.transitionOutbox(t.ctx.db, o.id, 'sent', 'agent:mail', 'ok', { patch: { smtpMessageId: '<sent-123@ccguk-test.example>' } });
    expect(scoreFor({ inReplyTo: '<SENT-123@ccguk-test.example>' })).toMatchObject({ score: MATCH_SCORES.thread });
    expect(scoreFor({ references: ['<other@x>', '<sent-123@ccguk-test.example>'] })?.score).toBe(90);
    expect(matchMessage(t.ctx, input({ inReplyTo: '<sent-123@ccguk-test.example>' }))).toMatchObject({ decision: 'auto', claimId });
  });

  it('the insurer reference (normalised) scores +80, +10 more from the insurer’s domain', () => {
    expect(normaliseInsurerRef('exi / 2026 - 778899')).toBe('EXI2026778899');
    const c = scoreFor({ text: 'Your ref EXI 2026 778899 — we have received the documents.' });
    expect(c).toMatchObject({ score: MATCH_SCORES.insurerRef });
    expect(matchMessage(t.ctx, input({ text: 'ref EXI-2026-778899' })).decision).toBe('which_claim');
    const withDomain = scoreFor({ text: 'ref EXI/2026/778899', fromAddr: 'handler@example-insurer.test' });
    expect(codes(withDomain)).toEqual(['insurer_domain', 'insurer_ref']);
    expect(withDomain?.score).toBe(90);
    expect(matchMessage(t.ctx, input({ text: 'ref EXI/2026/778899', fromAddr: 'handler@example-insurer.test' }))).toMatchObject({ decision: 'auto', claimId });
  });

  it('a registration on the claim scores +50 (client or third-party vehicle) → which_claim', () => {
    expect(scoreFor({ text: 'Vehicle AB12 CDE was inspected.' })).toMatchObject({ score: MATCH_SCORES.vrm });
    expect(scoreFor({ text: 'Our insured’s van xy34zzz' })?.score).toBe(50);
    expect(matchMessage(t.ctx, input({ text: 'Vehicle AB12CDE' })).decision).toBe('which_claim');
  });

  it('client full name AND the accident date score +40 (name alone is only the surname +10)', () => {
    expect(scoreFor({ text: 'Our insured collided with Jane Doe on 08/08/2026 in Barking.' })).toMatchObject({ score: MATCH_SCORES.nameAndDate });
    expect(scoreFor({ text: 'Accident with Jane Doe on 8 August 2026.' })?.score).toBe(40);
    expect(codes(scoreFor({ text: 'Jane Doe called us.' }))).toEqual(['surname']);
    expect(scoreFor({ text: 'Mrs Doe called.' })).toMatchObject({ score: MATCH_SCORES.surname });
    expect(matchMessage(t.ctx, input({ text: 'Mrs Doe called.' })).decision).toBe('unmatched');
  });

  it('a sender who is a party on the claim scores +30 (unmatched on its own)', () => {
    expect(scoreFor({ fromAddr: 'Jane.Doe@example.test' })).toMatchObject({ score: MATCH_SCORES.senderParty });
    expect(matchMessage(t.ctx, input({ fromAddr: 'jane.doe@example.test' })).decision).toBe('unmatched');
    // sender + name/date = 70 → which_claim
    expect(matchMessage(t.ctx, input({ fromAddr: 'jane.doe@example.test', text: 'Jane Doe, accident 08/08/2026' }))).toMatchObject({ decision: 'which_claim', score: 70 });
  });

  it('older UK registration formats are recognised', () => {
    expect(extractVrms('prefix A123 BCD, suffix ABC 123D, dateless 1234 AB and AB 1234')).toEqual(expect.arrayContaining(['A123BCD', 'ABC123D', '1234AB', 'AB1234']));
    const old = makeClaim(t.ctx, { name: 'Invented Person', registration: 'ABC 123D' });
    expect(scoreFor({ text: 'the classic car ABC123D' }, old.id)).toMatchObject({ score: 50 });
  });
});

describe('thresholds', () => {
  const cand = (claimId: string, score: number): MatchCandidate => ({ claimId, reference: claimId, score, signals: [] });
  it('auto at ≥ 90 and ≥ 30 ahead; a near tie at the top asks; 50–89 asks; < 50 is unmatched', () => {
    expect(decideMatch([cand('a', 90)])).toMatchObject({ decision: 'auto', claimId: 'a' });
    expect(decideMatch([cand('a', 130), cand('b', 100)])).toMatchObject({ decision: 'auto', claimId: 'a' });
    expect(decideMatch([cand('a', 129), cand('b', 100)]).decision).toBe('which_claim');
    expect(decideMatch([cand('a', 89)]).decision).toBe('which_claim');
    expect(decideMatch([cand('a', 50)]).decision).toBe('which_claim');
    expect(decideMatch([cand('a', 49)]).decision).toBe('unmatched');
    expect(decideMatch([]).decision).toBe('unmatched');
    expect(decideMatch([cand('a', 60), cand('b', 55), cand('c', 52), cand('d', 51)]).candidates.map((c) => c.claimId)).toEqual(['a', 'b', 'c']);
  });
});

describe('which_claim', () => {
  it('a tie between two claims raises which_claim (top three); the owner’s choice files it as decided_by owner and triage follows', async () => {
    const other = makeClaim(t.ctx, { name: 'Invented Other', registration: 'AB12 CDE', insurerRef: 'ZZ-1' });
    // Both claims carry AB12 CDE (+50 each): a tie.
    const { mailbox } = { mailbox: (await import('../mail/transport.js')).fakeTransports(t.ctx).mailbox };
    mailbox.deliver(eml({ from: 'somebody@unrelated.example', subject: 'Vehicle AB12 CDE', body: 'Inspection booked.' }));
    await run(t.ctx, 'mail.sync', {});
    const [m] = t.ctx.repos.listMailMessages(t.ctx.db, {});
    expect(m).toMatchObject({ status: 'needs_match' });
    expect(m!.claimId).toBeUndefined();
    const [ny] = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'which_claim' });
    expect(ny!.options.map((o) => o.id).sort()).toEqual([`claim:${claimId}`, `claim:${other.id}`, 'none'].sort());
    // triage of a needs_match message is queued (classification only until the owner files it)
    expect(queued(t.ctx, 'mail.triage')).toHaveLength(1);

    await resolveNeedsYouItem(t.ctx, ny!.id, { optionId: `claim:${other.id}` }, OWNER);
    const filed = t.ctx.repos.requireMailMessage(t.ctx.db, m!.id);
    expect(filed).toMatchObject({ status: 'matched', claimId: other.id });
    expect(t.ctx.repos.latestMailMatch(t.ctx.db, m!.id)).toMatchObject({ decidedBy: 'owner', claimId: other.id });
    expect(t.ctx.repos.listMailMatches(t.ctx.db, m!.id)).toHaveLength(2);
    expect(t.ctx.repos.listEvidenceForClaim(t.ctx.db, other.id).some((e) => e.mime === 'message/rfc822')).toBe(true);
    expect(queued(t.ctx, 'mail.triage').some((j) => j.claimId === other.id)).toBe(true);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'mail.link' })[0]).toMatchObject({ userId: 'courtesycars' });
  });

  it('“none of these” records an owner decision with no claim and sends the email to intake', async () => {
    makeClaim(t.ctx, { name: 'Invented Other', registration: 'AB12 CDE' });
    const { fakeTransports } = await import('../mail/transport.js');
    fakeTransports(t.ctx).mailbox.deliver(eml({ from: 'somebody@unrelated.example', subject: 'AB12CDE' }));
    await run(t.ctx, 'mail.sync', {});
    const [ny] = t.ctx.repos.listNeedsYou(t.ctx.db, { kind: 'which_claim' });
    await resolveNeedsYouItem(t.ctx, ny!.id, { optionId: 'none' }, OWNER);
    const [m] = t.ctx.repos.listMailMessages(t.ctx.db, {});
    expect(m).toMatchObject({ status: 'unmatched' });
    expect(t.ctx.repos.latestMailMatch(t.ctx.db, m!.id)).toMatchObject({ decidedBy: 'owner' });
    expect(queued(t.ctx, 'intake.process')).toHaveLength(1);
  });
});
