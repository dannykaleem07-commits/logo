/**
 * Human-only steps (docs/SUPREME-DESIGN.md §1.2, §B.2 rule 5, §D.5): the system and agents can never approve a
 * document (except the allow-listed automated path), sign, approve an estimate or PAV, issue an engineer report, verify
 * a directory entry or record an offer decision. The services refuse even when the perimeter is not in the way (an
 * `agent:*` user reached through header auth stands in for a perimeter bypass).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GeneratedDocument } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { approveDocument } from '../services/documents.js';
import { assertHuman, isAutomatedActor } from '../services/humanOnly.js';
import { recomputeClocks } from '../services/claimView.js';
import { HttpError } from '../errors.js';

interface ErrorBody {
  error: { code: string; message: string };
}

let t: TestApp;
let claimId: string;
beforeEach(async () => {
  t = await createTestApp('2026-10-07T09:00:00.000Z');
  const ids = t.ctx.repos.seedFileOne(t.ctx.db);
  recomputeClocks(t.ctx, ids.claimId);
  claimId = ids.claimId;
});
afterEach(async () => {
  await t.close();
});

const AGENT = { userId: 'agent:reviewer', ip: '127.0.0.1', runId: 'run-1' };
const TOUCHES = { money: false, liability: false, settlement: false, legal: false, newCommitment: false };

async function draftChaser(): Promise<GeneratedDocument> {
  const res = await t.api<GeneratedDocument>('POST', `/claims/${claimId}/documents`, { templateId: 'letter.chaser_7' });
  expect(res.status).toBe(201);
  return res.body;
}

async function expectHumanRequired(p: Promise<unknown>): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).code).toBe('HUMAN_REQUIRED');
  expect((err as HttpError).statusCode).toBe(409);
}

describe('isAutomatedActor / assertHuman', () => {
  it('treats system and agent:* as automated, people as human', () => {
    expect(isAutomatedActor({ userId: 'system' })).toBe(true);
    expect(isAutomatedActor({ userId: 'agent:mail' })).toBe(true);
    expect(isAutomatedActor({ userId: 'courtesycars' })).toBe(false);
    expect(isAutomatedActor({ userId: 'agentsmith' })).toBe(false);
    expect(() => assertHuman({ userId: 'agent:mail' }, 'do this')).toThrow(/A person must do this/);
    expect(() => assertHuman({ userId: 'handler' }, 'do this')).not.toThrow();
  });
});

describe('document approval', () => {
  it('an agent (or the system) cannot approve a document → HUMAN_REQUIRED', async () => {
    const doc = await draftChaser();
    await expectHumanRequired(approveDocument(t.ctx, doc.id, AGENT));
    await expectHumanRequired(approveDocument(t.ctx, doc.id, { userId: 'system' }));
    expect(t.ctx.repos.requireDocument(t.ctx.db, doc.id).status).toBe('draft');
  });

  it('automated approval needs an allow-listed template, zero open flags and a pass review of this document', async () => {
    const doc = await draftChaser();
    const open = (doc.consistency?.flags ?? []).filter((f) => (f.severity === 'block' || f.severity === 'warn') && !f.clearedAt);
    expect(open).toEqual([]);
    const other = await draftChaser();
    const repair = t.ctx.repos.appendReview(t.ctx.db, { targetKind: 'document', targetId: doc.id, claimId, loop: 0, rules: {}, facts: {}, verdict: 'repair', touches: TOUCHES });
    const passOther = t.ctx.repos.appendReview(t.ctx.db, { targetKind: 'document', targetId: other.id, claimId, loop: 0, rules: {}, facts: {}, verdict: 'pass', touches: TOUCHES });
    const outboxPass = t.ctx.repos.appendReview(t.ctx.db, { targetKind: 'outbox', targetId: doc.id, claimId, loop: 0, rules: {}, facts: {}, verdict: 'pass', touches: TOUCHES });
    const auto = (reviewId: string) => ({ automated: { reviewId, ruleIds: ['external_ok'] } });
    await expectHumanRequired(approveDocument(t.ctx, doc.id, AGENT, undefined, undefined, auto(repair.id)));
    await expectHumanRequired(approveDocument(t.ctx, doc.id, AGENT, undefined, undefined, auto(passOther.id)));
    await expectHumanRequired(approveDocument(t.ctx, doc.id, AGENT, undefined, undefined, auto(outboxPass.id)));
    await expectHumanRequired(approveDocument(t.ctx, doc.id, AGENT, undefined, undefined, auto('no-such-review')));

    const pass = t.ctx.repos.appendReview(t.ctx.db, { targetKind: 'document', targetId: doc.id, claimId, loop: 1, rules: {}, facts: {}, verdict: 'pass', touches: TOUCHES });
    // Not allow-listed any more → refused.
    t.ctx.repos.patchAgentSettings(t.ctx.db, { autonomy: { autoApproveTemplates: [] } }, { userId: 'courtesycars' });
    await expectHumanRequired(approveDocument(t.ctx, doc.id, AGENT, undefined, undefined, auto(pass.id)));
    t.ctx.repos.patchAgentSettings(t.ctx.db, { autonomy: { autoApproveTemplates: ['letter.chaser_7'] } }, { userId: 'courtesycars' });

    const approved = await approveDocument(t.ctx, doc.id, AGENT, undefined, undefined, auto(pass.id));
    expect(approved).toMatchObject({ status: 'approved', approvedBy: 'agent:reviewer' });
    const audit = t.ctx.repos.listAudit(t.ctx.db, { action: 'document.approve.auto' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: 'agent:reviewer', runId: 'run-1', entityId: doc.id, after: { reviewId: pass.id, ruleIds: ['external_ok'], templateId: 'letter.chaser_7' } });
  });

  it('a document with an open flag is never approved automatically', async () => {
    const wrong = await t.api<GeneratedDocument>('POST', `/claims/${claimId}/documents`, {
      templateId: 'letter.chaser_7',
      data: { insurerPosition: { statedAt: '2026-09-26', summary: 'You stated that £1,287 was received in full and final settlement.', response: ['The remittance received was £1,112.00.'] } },
    });
    expect(wrong.body.status).toBe('blocked');
    const pass = t.ctx.repos.appendReview(t.ctx.db, { targetKind: 'document', targetId: wrong.body.id, claimId, loop: 0, rules: {}, facts: {}, verdict: 'pass', touches: TOUCHES });
    await expectHumanRequired(approveDocument(t.ctx, wrong.body.id, AGENT, undefined, undefined, { automated: { reviewId: pass.id, ruleIds: [] } }));
    expect(t.ctx.repos.requireDocument(t.ctx.db, wrong.body.id).status).toBe('blocked');
  });

  it('a person still approves as before', async () => {
    const doc = await draftChaser();
    const res = await t.api<GeneratedDocument>('POST', `/documents/${doc.id}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.body.approvedBy).toBe('handler');
  });
});

describe('routes refuse automated actors even without the perimeter', () => {
  // A users row named like an agent, reached through header auth (tests only): no run token, so no perimeter.
  const H = { 'x-user-id': 'agent:mail' };
  beforeEach(() => {
    t.ctx.repos.createUser(t.ctx.db, { id: 'agent:mail', name: 'Impostor agent', email: 'agent@example.invalid', role: 'handler', mfaEnabled: false });
  });

  it('document approve and e-signature', async () => {
    const doc = await draftChaser();
    const approve = await t.api<ErrorBody>('POST', `/documents/${doc.id}/approve`, {}, H);
    expect([approve.status, approve.body.error.code]).toEqual([409, 'HUMAN_REQUIRED']);
    const party = t.ctx.repos.requireClaim(t.ctx.db, claimId).claimantId;
    const sign = await t.api<ErrorBody>('POST', `/documents/${doc.id}/sign/start`, { signerPartyId: party, contact: 'client@example.com', channel: 'email' }, H);
    expect([sign.status, sign.body.error.code]).toEqual([409, 'HUMAN_REQUIRED']);
    const verify = await t.api<ErrorBody>('POST', `/documents/${doc.id}/sign/verify`, { code: '123456' }, H);
    expect([verify.status, verify.body.error.code]).toEqual([409, 'HUMAN_REQUIRED']);
  });

  it('estimate approve, PAV approve, engineer report issue, directory verify', async () => {
    for (const url of [`/claims/${claimId}/estimate/e1/approve`, `/claims/${claimId}/pav/p1/approve`, `/claims/${claimId}/engineer-report/r1/issue`]) {
      const res = await t.api<ErrorBody>('POST', url, {}, H);
      expect([url, res.status, res.body.error.code]).toEqual([url, 409, 'HUMAN_REQUIRED']);
    }
    const verify = await t.api<ErrorBody>('PATCH', '/directory/any/verify', { sourceUrl: 'https://example.com', verifiedBy: 'agent:mail' }, H);
    expect([verify.status, verify.body.error.code]).toEqual([409, 'HUMAN_REQUIRED']);
  });

  it('offer decisions and replies → 403; other offer fields stay open', async () => {
    const offer = await t.api<{ offer: { id: string } }>('POST', `/claims/${claimId}/offers`, { receivedAt: '2026-10-06T10:00:00.000Z', channel: 'phone', offerorName: 'Example Insurance plc' });
    const url = `/claims/${claimId}/offers/${offer.body.offer.id}`;
    const decision = await t.api<ErrorBody>('PATCH', url, { clientDecision: 'accepted' }, H);
    expect([decision.status, decision.body.error.code]).toEqual([403, 'HUMAN_REQUIRED']);
    const reply = await t.api<ErrorBody>('PATCH', url, { replySentAt: '2026-10-07T08:00:00.000Z' }, H);
    expect(reply.status).toBe(403);
    expect((await t.api('PATCH', url, { suitable: false, suitabilityReasons: ['smaller car'] }, H)).status).toBe(200);
    expect((await t.api('PATCH', url, { clientDecision: 'declined', clientReasons: 'Unsuitable vehicle' })).status).toBe(200);
  });
});

describe('per-route body limit for estimate import', () => {
  it('accepts a body over the 2 MiB app limit on POST /claims/:id/estimate/import but not elsewhere', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024);
    const imp = await t.api<ErrorBody>('POST', `/claims/${claimId}/estimate/import`, { text: `PANEL REPAIR 1.0 hrs\n${big}` });
    expect(imp.status).not.toBe(413);
    const other = await t.api<ErrorBody>('POST', `/claims/${claimId}/events`, { type: 'note', at: '2026-10-07T08:00:00.000Z', summary: big });
    expect(other.status).toBe(413);
  });
});
