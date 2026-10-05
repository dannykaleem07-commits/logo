import { describe, expect, it } from 'vitest';
import type { FleetUnitRow } from '../../../api/client';
import type { HirePricingGuideResponse, HirePricingSnapshot } from '../../../api/hireApi';
import {
  benchmarkCaveat,
  clientSourceText,
  differenceText,
  fleetOptionLabel,
  fleetOptions,
  groupChoices,
  guideLineText,
  higherGroupNotice,
  likeForLikeText,
  noticeTone,
  pricingChips,
  pricingHeading,
  pricingNotices,
  snapshotSummary
} from './hirePricing';

const NOTE = 'GTA terms are an industry benchmark only. CCGUK is not a GTA subscriber; under GTA 2.7(j) the terms have no relevance in law for claims outside the GTA and cannot be cited in legal proceedings.';
const HIGHER =
  "Higher group than the damaged car: the car you are giving (M2, £74.68/day guide) is in a higher group than the client's damaged car (S1, £42.32/day guide). Like-for-like guide £42.32/day; difference £32.36/day.";
const FLEET_ABOVE = 'Your fleet rate £74.68/day is £32.36/day above the like-for-like guide.';

/** The higher-group case of §I.4: FL25 MXX (M2, £74.68) given to the owner of an S1 Vauxhall Astra (£42.32). */
const guide: HirePricingGuideResponse = {
  date: '2026-10-05',
  fleetDailyRatePence: 7468,
  hireCar: { group: 'M2', dailyRatePence: 7468, period: '2026-27', verification: 'verified' },
  clientCar: { group: 'S1', dailyRatePence: 4232, period: '2026-27', verification: 'verified', source: 'recorded' },
  differencePerDayPence: 3236,
  higherGroup: true,
  fleetAboveLikeForLikePence: 3236,
  notices: [HIGHER, FLEET_ABOVE],
  suggestions: [
    { id: 'fleet', label: 'Fleet rate', dailyRatePence: 7468 },
    { id: 'hire_guide', label: 'Car we give — guide', dailyRatePence: 7468 },
    { id: 'like_for_like', label: "Client's car — guide (like for like)", dailyRatePence: 4232 }
  ],
  note: NOTE,
  fleetUnit: { id: 'u1', registration: 'FL25 MXX', make: 'NISSAN', model: 'QASHQAI', status: 'available', gtaGroup: 'M2', dailyRatePence: 7468 },
  clientVehicle: { id: 'v1', registration: 'DK18 WRE', make: 'VAUXHALL', model: 'ASTRA', gtaGroup: 'S1' },
  clientSuggestion: { group: 'S1', confidence: 'high', basis: 'recorded', reason: 'Group recorded on the vehicle.', rate: null, note: '' },
  groupsOnDate: ['S1', 'S2', 'M', 'M2']
};

describe('pricing guide — higher-group case (M2 £74.68 against S1 £42.32)', () => {
  it('the difference is +£32.36 / day', () => {
    expect(differenceText(guide.differencePerDayPence)).toBe('+£32.36 / day');
    expect(differenceText(-500)).toBe('−£5.00 / day');
    expect(differenceText(0)).toBe('£0.00 / day');
    expect(differenceText(null)).toBe('—');
  });
  it('the three chips read as in the design and carry the rates', () => {
    expect(pricingChips(guide.suggestions)).toEqual([
      { id: 'fleet', label: 'Fleet rate £74.68', dailyRatePence: 7468 },
      { id: 'hire_guide', label: 'Car we give — guide £74.68', dailyRatePence: 7468 },
      { id: 'like_for_like', label: "Client's car — guide £42.32 (like for like)", dailyRatePence: 4232 }
    ]);
    expect(pricingChips(undefined)).toEqual([]);
  });
  it('the higher-group notice is amber; the others are information', () => {
    expect(noticeTone(HIGHER)).toBe('warn');
    expect(noticeTone(FLEET_ABOVE)).toBe('info');
    expect(noticeTone("The client's car has no GTA group yet — choose one to see the like-for-like guide.")).toBe('info');
    expect(pricingNotices([FLEET_ABOVE, HIGHER]).map((n) => n.tone)).toEqual(['warn', 'info']);
  });
  it('guide lines and the client group source', () => {
    expect(guideLineText(guide.hireCar)).toBe('Group M2 · GTA guide £74.68');
    expect(guideLineText(guide.clientCar)).toBe('Group S1 · GTA guide £42.32');
    expect(guideLineText({ group: 'UNGROUPED', dailyRatePence: null, missingReason: 'No benchmark rate is loaded for group UNGROUPED.' })).toBe('Group UNGROUPED · No benchmark rate is loaded for group UNGROUPED.');
    expect(clientSourceText('recorded')).toBe('group recorded on the car');
    expect(clientSourceText('none')).toBe('no group yet');
  });
  it('the benchmark caveat drops the clause citation (kept for the tooltip)', () => {
    const text = benchmarkCaveat(NOTE);
    expect(text).toBe('GTA terms are an industry benchmark only. CCGUK is not a GTA subscriber.');
    expect(text).not.toMatch(/2\.7/);
    expect(benchmarkCaveat(undefined)).toMatch(/benchmark/);
  });
  it('heading and group choices', () => {
    expect(pricingHeading('2026-10-05')).toBe('Pricing guide (hire starting 5 Oct 2026)');
    expect(groupChoices(guide)).toEqual(['S1', 'S2', 'M', 'M2']);
    expect(groupChoices({ groupsOnDate: ['S1'], clientCar: { ...guide.clientCar, group: 'CP2' } })).toEqual(['CP2', 'S1']);
  });
});

describe('hire card figures', () => {
  const snap: HirePricingSnapshot = {
    snapshot: true,
    agreedDailyRatePence: 7468,
    fleetDailyRatePence: 7468,
    hireGroup: 'M2',
    hireGtaDailyRatePence: 7468,
    clientGtaGroup: 'S1',
    clientGtaDailyRatePence: 4232,
    differencePerDayPence: 3236,
    higherGroup: true,
    notices: [HIGHER],
    note: NOTE
  };
  it('summary line and higher-group notice', () => {
    expect(snapshotSummary(snap)).toBe("Agreed £74.68/day · Car we give M2 guide £74.68 · Client's car S1 guide £42.32 · +£32.36/day");
    expect(higherGroupNotice(snap)).toBe(HIGHER);
    expect(higherGroupNotice({ ...snap, higherGroup: false })).toBeUndefined();
    expect(snapshotSummary({ ...snap, clientGtaGroup: null, clientGtaDailyRatePence: null, differencePerDayPence: null })).toBe("Agreed £74.68/day · Car we give M2 guide £74.68 · Client's car: no group");
  });
  it('like-for-like line: 7 days at S1 against the agreed M2 rate', () => {
    expect(likeForLikeText({ group: 'S1', hireAtGtaRatePence: 7 * 4232, differencePence: 7 * 3236 })).toBe('At the like-for-like guide (S1): £296.24, difference +£226.52');
    expect(likeForLikeText(undefined)).toBeUndefined();
  });
});

describe('fleet car select', () => {
  const unit = (over: Partial<FleetUnitRow>): FleetUnitRow =>
    ({ id: 'u', vehicleId: 'v', gtaGroup: 'S1', dailyRatePence: 4980, status: 'available', declaredUses: ['credit_hire'], registration: 'FL33 EET', vehicle: { make: 'VW', model: 'Golf' }, ...over }) as FleetUnitRow;
  it('labels read "FL33 EET · VW Golf · S1 · £49.80/day"', () => {
    expect(fleetOptionLabel(unit({}))).toBe('FL33 EET · VW Golf · S1 · £49.80/day');
    expect(fleetOptionLabel(unit({ registration: 'FL25 MXX', gtaGroup: 'M2', dailyRatePence: 7468, vehicle: { make: 'NISSAN', model: 'QASHQAI' } as FleetUnitRow['vehicle'] }))).toBe('FL25 MXX · Nissan Qashqai · M2 · £74.68/day');
    expect(fleetOptionLabel(unit({ status: 'on_hire' }))).toBe('FL33 EET · VW Golf · S1 · £49.80/day · on hire');
  });
  it('off road disabled unless manager mode; on hire selectable (the dates decide); disposed hidden', () => {
    const units = [unit({ id: 'a' }), unit({ id: 'b', status: 'on_hire' }), unit({ id: 'c', status: 'off_road' }), unit({ id: 'd', status: 'disposed' })];
    expect(fleetOptions(units, false).map((o) => [o.value, Boolean(o.disabled)])).toEqual([
      ['a', false],
      ['b', false],
      ['c', true]
    ]);
    const on = fleetOptions(units, true);
    expect(on.every((o) => !o.disabled)).toBe(true);
    expect(on.map((o) => o.label.split(' · ').pop())).toEqual(['£49.80/day', 'on hire', 'off road']);
  });
});
