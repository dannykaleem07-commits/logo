/**
 * Settlement-offer register (docs/SUPREME-AUTOPILOT.md §D.9): an insurer's offer to settle a head of loss is kept out of
 * the intervention register — no `intervention_reply_1wd` clock, the mitigation gate unchanged — and its decision is
 * the owner's only (route guard and perimeter).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock, GateResult, InterventionOffer, SettlementOffer } from '@ccguk/domain';
import { createTestApp, type TestApp } from './helpers.js';
import { recomputeClocks } from '../services/claimView.js';
import { mintRunToken, revokeRunToken } from '../agent/principal.js';

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

const OFFER = { head: 'hire', amountPence: 640000, receivedAt: '2026-10-06T10:00:00.000Z', channel: 'email', offerorName: 'Example Insurance plc', terms: 'Without prejudice, full and final.' };

const replyClocks = async () => (await t.api<{ clocks: Clock[] }>('GET', `/claims/${claimId}/clocks`)).body.clocks.filter((c) => c.kind === 'intervention_reply_1wd');
const mitigation = async () => (await t.api<{ gates: GateResult[] }>('GET', `/claims/${claimId}/gates`)).body.gates.find((g) => g.gate === 'mitigation');

describe('settlement-offer register', () => {
  it('records a settlement offer without touching the intervention register, its reply clock or the mitigation gate', async () => {
    const clocksBefore = await replyClocks();
    const gateBefore = await mitigation();
    const interventionBefore = t.ctx.repos.listOffers(t.ctx.db, claimId);

    const res = await t.api<{ offer: SettlementOffer }>('POST', `/claims/${claimId}/settlement-offers`, OFFER);
    expect(res.status).toBe(201);
    expect(res.body.offer).toMatchObject({ claimId, head: 'hire', amountPence: 640000, status: 'open', offerorName: 'Example Insurance plc', evidenceIds: [] });

    expect(t.ctx.repos.listOffers(t.ctx.db, claimId)).toEqual(interventionBefore);
    expect(await replyClocks()).toEqual(clocksBefore);
    expect(await mitigation()).toEqual(gateBefore);

    const events = t.ctx.repos.listEvents(t.ctx.db, claimId).filter((e) => e.type === 'settlement_offer_received');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ attributableTo: 'insurer', data: { settlementOfferId: res.body.offer.id, head: 'hire', amountPence: 640000 } });
    expect(t.ctx.repos.listEvents(t.ctx.db, claimId).filter((e) => e.type === 'intervention_offer' && e.data?.offerId === res.body.offer.id)).toEqual([]);

    // both registers are listed, each in its own key
    const list = await t.api<{ offers: InterventionOffer[]; settlementOffers: SettlementOffer[] }>('GET', `/claims/${claimId}/offers`);
    expect(list.body.offers.map((o) => o.id)).toEqual(interventionBefore.map((o) => o.id));
    expect(list.body.settlementOffers.map((o) => o.id)).toEqual([res.body.offer.id]);
    expect((await t.api<{ offers: SettlementOffer[] }>('GET', `/claims/${claimId}/settlement-offers`)).body.offers).toHaveLength(1);
    // and the claim bundle carries it
    expect((await t.api<{ settlementOffers: SettlementOffer[] }>('GET', `/claims/${claimId}`)).body.settlementOffers?.map((o) => o.id)).toEqual([res.body.offer.id]);
  });

  it('validates the body', async () => {
    expect((await t.api('POST', `/claims/${claimId}/settlement-offers`, { ...OFFER, head: 'lunch' })).status).toBe(400);
    expect((await t.api('POST', `/claims/${claimId}/settlement-offers`, { ...OFFER, amountPence: 12.5 })).status).toBe(400);
    expect((await t.api('POST', `/claims/${claimId}/settlement-offers`, { ...OFFER, amountPence: null, head: 'global' })).status).toBe(201);
  });

  it('the owner records the decision once; automated actors are refused by the route and by the perimeter', async () => {
    const created = await t.api<{ offer: SettlementOffer }>('POST', `/claims/${claimId}/settlement-offers`, OFFER);
    const url = `/claims/${claimId}/settlement-offers/${created.body.offer.id}`;

    // header auth as an agent-named user: no run token, so no perimeter — the route itself refuses
    t.ctx.repos.createUser(t.ctx.db, { id: 'agent:mail', name: 'Impostor agent', email: 'agent@example.invalid', role: 'handler', mfaEnabled: false });
    const H = { 'x-user-id': 'agent:mail' };
    const refused = await t.api<ErrorBody>('PATCH', url, { status: 'accepted' }, H);
    expect([refused.status, refused.body.error.code]).toEqual([403, 'HUMAN_REQUIRED']);
    expect((await t.api('PATCH', url, { evidenceIds: [] }, H)).status).toBe(200);

    // an agent run token: the perimeter refuses before the route
    const token = mintRunToken({ name: 'case_manager', runId: 'run-x', jobId: 'scripted', claimScope: claimId }, 60_000);
    try {
      const res = await t.app.inject({ method: 'PATCH', url: `/api/${url.slice(1)}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: JSON.stringify({ status: 'rejected' }) });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('AGENT_FORBIDDEN');
    } finally {
      revokeRunToken(token);
    }
    expect(t.ctx.repos.requireSettlementOffer(t.ctx.db, created.body.offer.id).status).toBe('open');

    const decided = await t.api<{ offer: SettlementOffer }>('PATCH', url, { status: 'accepted', decisionNote: 'Within the walk-away figure.' });
    expect(decided.status).toBe(200);
    expect(decided.body.offer).toMatchObject({ status: 'accepted', decisionNote: 'Within the walk-away figure.', decidedAt: '2026-10-07T09:00:00.000Z' });
    expect(decided.body.offer.decidedBy).toBeTruthy();
    expect((await t.api<ErrorBody>('PATCH', url, { status: 'rejected' })).body.error.code).toBe('ALREADY_DECIDED');
    expect((await t.api('PATCH', url, { decisionNote: 'no status' })).status).toBe(400);
  });
});
