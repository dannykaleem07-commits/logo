import { describe, expect, it } from 'vitest';
import type { Clock, InterventionOffer } from '@ccguk/domain';
import { decisionBodyFrom, emptyOfferForm, offerBodyFrom, offerFormFrom, replyClockForOffer, replyState } from './offers';

const now = '2026-10-04T12:00:00.000Z';

const offer: InterventionOffer = {
  id: 'o1',
  claimId: 'c1',
  receivedAt: '2026-10-01T09:30:00.000Z',
  channel: 'phone',
  offerorName: 'esure',
  vehicleClassOffered: 'small hatchback',
  dailyRatePence: 2037,
  rateIncludesVat: false,
  terms: { excessPence: 25000, mileageLimitPerDay: 100, deliveryIncluded: true },
  suitable: false,
  suitabilityReasons: ['Not like-for-like: client needs an estate for work'],
  clientDecision: 'pending',
  evidenceIds: []
};

describe('offer form ⇄ body', () => {
  it('round-trips an offer and keeps the rate in pence', () => {
    const form = offerFormFrom(offer);
    expect(form.dailyRatePence).toBe(2037);
    expect(form.mileageLimitPerDay).toBe('100');
    const r = offerBodyFrom(form, now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body).toMatchObject({ receivedAt: offer.receivedAt, channel: 'phone', offerorName: 'esure', dailyRatePence: 2037, rateIncludesVat: false, clientDecision: 'pending' });
      expect(r.body.terms).toEqual({ excessPence: 25000, mileageLimitPerDay: 100, deliveryIncluded: true, insuranceIncluded: undefined, durationStated: undefined, otherTerms: undefined });
      expect(r.body.suitabilityReasons).toEqual(['Not like-for-like: client needs an estate for work']);
    }
  });
  it('insists on what / who / when and a reason when unsuitable', () => {
    const r = offerBodyFrom({ ...emptyOfferForm(now), receivedAt: '', offerorName: '', suitable: false }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['offerorName', 'receivedAt', 'suitabilityReasons', 'vehicleClassOffered']);
  });
  it("records the client's decision only with reasons and a time", () => {
    expect(decisionBodyFrom({ clientDecision: 'declined', clientReasons: '', clientDecisionAt: '' }).ok).toBe(false);
    expect(decisionBodyFrom({ clientDecision: 'declined', clientReasons: 'Needs a van for work', clientDecisionAt: now })).toEqual({ ok: true, body: { clientDecision: 'declined', clientReasons: 'Needs a van for work', clientDecisionAt: now } });
  });
});

describe('reply clock', () => {
  const clock: Clock = { id: 'k1', claimId: 'c1', kind: 'intervention_reply_1wd', label: 'Reply', basis: 'written reply within 1 WD', startsAt: '2026-10-01T09:30:00.000Z', dueAt: '2026-10-02T17:00:00.000Z', status: 'running', sourceEventId: 'ev9' };
  it('pairs by start instant or source event', () => {
    expect(replyClockForOffer([clock], offer)?.id).toBe('k1');
    expect(replyClockForOffer([clock], { receivedAt: '2026-10-03T09:30:00.000Z' }, 'ev9')?.id).toBe('k1');
    expect(replyClockForOffer([clock], { receivedAt: '2026-10-03T09:30:00.000Z' })).toBeUndefined();
  });
  it('states the reply position plainly', () => {
    expect(replyState(offer, clock, now)).toBe('overdue');
    expect(replyState(offer, clock, '2026-10-02T09:00:00Z')).toBe('due');
    expect(replyState(offer, undefined, now)).toBe('none');
    expect(replyState({ replySentAt: '2026-10-02T12:00:00Z' }, clock, now)).toBe('sent');
    expect(replyState({ replySentAt: '2026-10-03T12:00:00Z' }, clock, now)).toBe('late');
  });
});
