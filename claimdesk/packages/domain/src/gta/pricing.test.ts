import { describe, it, expect } from 'vitest';
import type { GtaRate } from '../types.js';
import { GTA_NON_SUBSCRIBER_NOTE } from './rates.js';
import { CLIENT_GROUP_MISSING, hirePricingGuide, type HirePricingGuideInput } from './pricing.js';

const v = (status: GtaRate['verification']['status']): GtaRate['verification'] => ({ status });
const rate = (group: string, pence: number, status: GtaRate['verification']['status'] = 'verified', period = '2026-27'): GtaRate => ({
  group,
  dailyRatePence: pence,
  period,
  effectiveFrom: '2026-07-01',
  effectiveTo: '2027-06-30',
  verification: v(status),
});
const RATES: GtaRate[] = [rate('S1', 4232), rate('M', 5666), rate('M2', 7468), rate('M1', 6549, 'unverified')];
const input = (over: Partial<HirePricingGuideInput> = {}): HirePricingGuideInput => ({
  date: '2026-10-05',
  fleetDailyRatePence: 7468,
  hireGroup: 'M2',
  clientGroup: 'S1',
  clientGroupSource: 'recorded',
  rates: RATES,
  ...over,
});

describe('hirePricingGuide', () => {
  it('higher group: M2 against S1 — difference, the exact sentence, three chips', () => {
    const g = hirePricingGuide(input());
    expect(g.hireCar).toEqual({ group: 'M2', dailyRatePence: 7468, period: '2026-27', verification: 'verified' });
    expect(g.clientCar).toMatchObject({ group: 'S1', dailyRatePence: 4232, source: 'recorded' });
    expect(g.differencePerDayPence).toBe(3236);
    expect(g.higherGroup).toBe(true);
    expect(g.fleetAboveLikeForLikePence).toBe(3236);
    expect(g.notices[0]).toBe(
      "Higher group than the damaged car: the car you are giving (M2, £74.68/day guide) is in a higher group than the client's damaged car (S1, £42.32/day guide). Like-for-like guide £42.32/day; difference £32.36/day.",
    );
    expect(g.notices[1]).toBe('Your fleet rate £74.68/day is £32.36/day above the like-for-like guide.');
    expect(g.notices).toHaveLength(2);
    expect(g.suggestions).toEqual([
      { id: 'fleet', label: 'Fleet rate', dailyRatePence: 7468 },
      { id: 'hire_guide', label: 'Car we give — guide', dailyRatePence: 7468 },
      { id: 'like_for_like', label: "Client's car — guide (like for like)", dailyRatePence: 4232 },
    ]);
    expect(g.note).toBe(GTA_NON_SUBSCRIBER_NOTE);
    expect(g.date).toBe('2026-10-05');
  });

  it('same group: no higher or lower notice, difference 0', () => {
    const g = hirePricingGuide(input({ hireGroup: 'S1', clientGroup: 'S1', fleetDailyRatePence: 4980 }));
    expect(g.differencePerDayPence).toBe(0);
    expect(g.higherGroup).toBe(false);
    expect(g.notices).toEqual(['Your fleet rate £49.80/day is £7.48/day above the like-for-like guide.']);
  });

  it('a fleet rate at or below the like-for-like guide gives no fleet notice', () => {
    expect(hirePricingGuide(input({ hireGroup: 'S1', clientGroup: 'S1', fleetDailyRatePence: 4232 })).notices).toEqual([]);
  });

  it('lower group: S1 against M — the lower-group sentence, not higherGroup', () => {
    const g = hirePricingGuide(input({ hireGroup: 'S1', clientGroup: 'M', fleetDailyRatePence: 4980 }));
    expect(g.differencePerDayPence).toBe(4232 - 5666);
    expect(g.higherGroup).toBe(false);
    expect(g.fleetAboveLikeForLikePence).toBe(4980 - 5666);
    expect(g.notices).toEqual([
      "Lower group than the damaged car: the car you are giving (S1, £42.32/day guide) is in a lower group than the client's damaged car (M, £56.66/day guide). Like-for-like guide £56.66/day; difference £14.34/day below it.",
    ]);
  });

  it('compares rates, never codes (M1 below M2 although both start with M; CP vs S families)', () => {
    expect(hirePricingGuide(input({ hireGroup: 'M1', clientGroup: 'M2' })).higherGroup).toBe(false);
    const cp = hirePricingGuide(input({ hireGroup: 'S1', clientGroup: 'CP1', rates: [...RATES, rate('CP1', 3000)] }));
    expect(cp.higherGroup).toBe(true);
  });

  it('no client group: no difference, the no-group sentence, two chips, source none', () => {
    const g = hirePricingGuide(input({ clientGroup: null, clientGroupSource: 'suggested' }));
    expect(g.clientCar).toEqual({ group: null, dailyRatePence: null, missingReason: CLIENT_GROUP_MISSING, source: 'none' });
    expect(g.differencePerDayPence).toBeNull();
    expect(g.higherGroup).toBe(false);
    expect(g.fleetAboveLikeForLikePence).toBeNull();
    expect(g.notices).toEqual([CLIENT_GROUP_MISSING]);
    expect(g.suggestions.map((s) => s.id)).toEqual(['fleet', 'hire_guide']);
  });

  it('UNGROUPED fleet car: no guide, the noBenchmarkRateReason sentence, fleet and like-for-like chips', () => {
    const g = hirePricingGuide(input({ hireGroup: 'UNGROUPED', fleetDailyRatePence: 4000 }));
    expect(g.hireCar.dailyRatePence).toBeNull();
    expect(g.hireCar.missingReason).toBe('No benchmark rate is loaded for group UNGROUPED on 2026-10-05 — add it in Settings → GTA benchmark rates.');
    expect(g.differencePerDayPence).toBeNull();
    expect(g.notices).toEqual([g.hireCar.missingReason]);
    expect(g.suggestions.map((s) => s.id)).toEqual(['fleet', 'like_for_like']);
  });

  it('a manual client group (lower-cased) is normalised and keeps its source', () => {
    const g = hirePricingGuide(input({ clientGroup: ' m ', clientGroupSource: 'manual' }));
    expect(g.clientCar).toMatchObject({ group: 'M', dailyRatePence: 5666, source: 'manual' });
    expect(g.differencePerDayPence).toBe(7468 - 5666);
  });

  it('an unverified rate is reported, never upgraded, after the other notices', () => {
    const g = hirePricingGuide(input({ hireGroup: 'M1', clientGroup: 'S1', fleetDailyRatePence: 6549 }));
    expect(g.hireCar.verification).toBe('unverified');
    expect(g.notices[g.notices.length - 1]).toBe('The guide rate for group M1 (period 2026-27) is unverified.');
    expect(g.notices[0]).toMatch(/^Higher group than the damaged car/);
  });

  it('a group with no rate on the date gives the missing-rate sentence for that date', () => {
    const g = hirePricingGuide(input({ date: '2026-05-01' }));
    expect(g.hireCar.dailyRatePence).toBeNull();
    expect(g.clientCar.dailyRatePence).toBeNull();
    expect(g.notices).toEqual([
      'No benchmark rate is loaded for group M2 on 2026-05-01 — add it in Settings → GTA benchmark rates.',
      'No benchmark rate is loaded for group S1 on 2026-05-01 — add it in Settings → GTA benchmark rates.',
    ]);
    expect(g.suggestions).toEqual([{ id: 'fleet', label: 'Fleet rate', dailyRatePence: 7468 }]);
  });
});
