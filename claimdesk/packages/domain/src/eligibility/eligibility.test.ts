// owned by ap-clash
/** Eligibility: driver criteria boundaries, need, means, roadworthiness, summary (docs/SUPREME-AUTOPILOT.md §F, §J.1). */
import { describe, expect, it } from 'vitest';
import type { ClaimBundle } from '../types.js';
import type { HireNeeds } from '../booking/types.js';
import { assessDriver, licenceNumberMismatches, worstOutcome } from './driver.js';
import { assessNeed, needLevel } from './need.js';
import { assessMeans } from './means.js';
import { assessRoadworthiness, clientCarOnDate } from './roadworthiness.js';
import { summariseEligibility } from './summary.js';
import { DEFAULT_DRIVER_CRITERIA, type DriverProfile } from './types.js';

const AT = '2026-10-12';
const C = DEFAULT_DRIVER_CRITERIA;
const prof = (extra: Partial<DriverProfile> = {}): DriverProfile => ({
  partyId: 'p1',
  licenceCountry: 'GB',
  licenceType: 'full',
  fullLicenceSince: '2014-01-01',
  categories: ['B'],
  restrictionCodes: [],
  points: 0,
  endorsements: [],
  disqualifications5y: 0,
  faultAccidents3y: 0,
  unspentConvictions: [],
  medicalConditionsDeclared: false,
  source: 'declared',
  updatedBy: 'o',
  updatedAt: '2026-10-01T00:00:00Z',
  ...extra,
});
/** Date of birth giving exactly `age` on AT. */
const dobForAge = (age: number): string => `${2026 - age}-10-12`;
const outcome = (extra: Partial<DriverProfile> = {}, dob = dobForAge(34)): string => assessDriver(prof(extra), { name: 'Amir Hussain', dateOfBirth: dob }, C, AT).outcome;

describe('driver criteria boundaries (§F.2 defaults)', () => {
  it('ages 20/21/24/25/75/76/79/80', () => {
    expect(outcome({}, dobForAge(20))).toBe('ineligible');
    expect(outcome({}, dobForAge(21))).toBe('refer');
    expect(outcome({}, dobForAge(24))).toBe('refer');
    expect(outcome({}, dobForAge(25))).toBe('eligible');
    expect(outcome({}, dobForAge(75))).toBe('eligible');
    expect(outcome({}, dobForAge(76))).toBe('refer');
    expect(outcome({}, dobForAge(79))).toBe('refer');
    expect(outcome({}, dobForAge(80))).toBe('ineligible');
  });
  it('a birthday the day after the start still counts the younger age', () => {
    expect(outcome({}, '2001-10-13')).toBe('refer'); // 24 on AT
  });
  it('years with a full licence 0.9 / 1 / 2', () => {
    expect(outcome({ fullLicenceSince: '2025-11-20' })).toBe('ineligible');
    expect(outcome({ fullLicenceSince: '2025-10-12' })).toBe('refer');
    expect(outcome({ fullLicenceSince: '2024-10-11' })).toBe('eligible');
  });
  it('points 6 / 7 / 9 / 10', () => {
    expect(outcome({ points: 6 })).toBe('eligible');
    expect(outcome({ points: 7 })).toBe('refer');
    expect(outcome({ points: 9 })).toBe('refer');
    expect(outcome({ points: 10 })).toBe('ineligible');
  });
  it('each excluded endorsement prefix within 5 years is ineligible; outside the lookback it is not', () => {
    for (const code of ['DR10', 'IN10', 'UT50', 'CD40', 'CD50', 'CD60', 'CD70', 'CD80', 'CD90', 'DD40', 'BA10', 'AC10', 'TT99']) expect(outcome({ endorsements: [{ code, offenceDate: '2024-01-01', points: 0 }] }), code).toBe('ineligible');
    expect(outcome({ endorsements: [{ code: 'DR10', offenceDate: '2020-01-01', points: 0 }] })).toBe('eligible');
  });
  it('each refer prefix (CD1–CD3, MS) refers; ordinary SP codes count only through points', () => {
    for (const code of ['CD10', 'CD20', 'CD30', 'MS90']) expect(outcome({ endorsements: [{ code, offenceDate: '2024-01-01', points: 3 }] }), code).toBe('refer');
    expect(outcome({ points: 3, endorsements: [{ code: 'SP30', offenceDate: '2024-01-01', points: 3 }] })).toBe('eligible');
  });
  it('disqualification: current or within 5 years', () => {
    expect(outcome({ disqualifiedUntil: '2026-12-01' })).toBe('ineligible');
    expect(outcome({ disqualifiedUntil: '2023-01-01' })).toBe('ineligible');
    expect(outcome({ disqualifiedUntil: '2020-01-01', disqualifications5y: 0 })).toBe('eligible');
    expect(outcome({ disqualifications5y: 1 })).toBe('ineligible');
  });
  it('fault accidents in 3 years 1 / 2 / 3', () => {
    expect(outcome({ faultAccidents3y: 1 })).toBe('eligible');
    expect(outcome({ faultAccidents3y: 2 })).toBe('refer');
    expect(outcome({ faultAccidents3y: 3 })).toBe('ineligible');
  });
  it('countries: GB/NI/EU eligible, other refer; provisional never', () => {
    expect(outcome({ licenceCountry: 'NI' })).toBe('eligible');
    expect(outcome({ licenceCountry: 'EU_EEA' })).toBe('eligible');
    expect(outcome({ licenceCountry: 'OTHER' })).toBe('refer');
    expect(outcome({ licenceType: 'provisional' })).toBe('ineligible');
  });
  it('unspent convictions refer; an expired licence is ineligible', () => {
    expect(outcome({ unspentConvictions: ['theft'] })).toBe('refer');
    expect(outcome({ licenceExpiry: '2026-01-01' })).toBe('ineligible');
  });
  it('missing date of birth, licence type, full-licence date or points → unknown with missing', () => {
    const none = assessDriver(undefined, { name: 'A' }, C, AT);
    expect(none.outcome).toBe('unknown');
    expect(none.missing).toEqual(expect.arrayContaining(['date of birth', 'licence type', 'full licence date', 'penalty points']));
    expect(outcome({ points: null })).toBe('unknown');
    expect(outcome({ licenceType: 'unknown' })).toBe('unknown');
    expect(outcome({ fullLicenceSince: undefined as never })).toBe('unknown');
    // a worse reason still wins over missing facts
    expect(assessDriver(prof({ points: null }), { name: 'A', dateOfBirth: dobForAge(19) }, C, AT).outcome).toBe('ineligible');
  });
  it('restriction 78 → automatic only', () => {
    const e = assessDriver(prof({ restrictionCodes: ['78'] }), { name: 'A', dateOfBirth: dobForAge(34) }, C, AT);
    expect(e.automaticOnly).toBe(true);
    expect(e.outcome).toBe('eligible');
  });
  it('licence number cross-check against surname and date of birth → refer', () => {
    // HUSSA 8 04 12 8 AH 9IJ = Hussain, born 12 April 1988
    expect(licenceNumberMismatches('HUSSA804128AH9IJ', { name: 'Amir Hussain', dateOfBirth: '1988-04-12' })).toEqual([]);
    expect(licenceNumberMismatches('HUSSA804128AH9IJ', { name: 'Amir Smith', dateOfBirth: '1988-04-12' })).toHaveLength(1);
    const e = assessDriver(prof({ licenceNumber: 'HUSSA804128AH9IJ' }), { name: 'Amir Hussain', dateOfBirth: '1988-04-13' }, C, AT);
    expect(e.outcome).toBe('refer');
    expect(e.reasons.map((r) => r.code)).toContain('LICENCE_NUMBER_MISMATCH');
  });
  it('young-driver excess is reported only when the owner has set one', () => {
    expect(assessDriver(prof(), { name: 'A', dateOfBirth: dobForAge(22) }, C, AT).youngDriverExcessPence).toBeUndefined();
    expect(assessDriver(prof(), { name: 'A', dateOfBirth: dobForAge(22) }, { ...C, youngDriverExcessPence: 25000 }, AT).youngDriverExcessPence).toBe(25000);
  });
  it('worstOutcome ranks ineligible > refer > unknown > eligible', () => {
    expect(worstOutcome(['eligible', 'unknown'])).toBe('unknown');
    expect(worstOutcome(['unknown', 'refer'])).toBe('refer');
    expect(worstOutcome(['refer', 'ineligible', 'eligible'])).toBe('ineligible');
    expect(worstOutcome([])).toBe('eligible');
  });
});

const needs = (extra: Partial<HireNeeds> = {}): HireNeeds => ({
  neededFrom: null,
  deliveryAddress: null,
  deliveryPostcode: null,
  seatsMin: null,
  automaticOnly: false,
  automaticPreferred: false,
  towbar: false,
  wheelchairAccessible: false,
  handControls: false,
  isofixCount: 0,
  evOk: null,
  phvWork: false,
  largeBoot: false,
  occupation: null,
  journeys: null,
  dependants: null,
  otherVehicles: 'none',
  ownInsurerCourtesyCar: 'not_offered',
  clientCoverType: 'unknown',
  clientWantsHire: true,
  notes: null,
  source: {},
  ...extra,
});

function bundle(extra: Partial<ClaimBundle> = {}, accident: Record<string, unknown> = {}): ClaimBundle {
  return {
    claim: { id: 'c1', reference: 'R', status: 'fnol', openedAt: '2026-10-01T00:00:00Z', accident: { occurredAt: '2026-10-01T08:00:00Z', location: 'x', circumstances: 'y', ...accident }, liability: 'admitted', claimantId: 'p1', clientVehicleId: 'v1', thirdPartyIds: [], gtaSubscriber: false, linkedClaimIds: [], flags: [], createdAt: '', updatedAt: '' },
    claimant: { id: 'p1', kind: 'individual', name: 'A', roles: [], createdAt: '' },
    vehicle: { id: 'v1', registration: 'AB12CDE', make: 'F', model: 'F', odometer: [], ownership: 'client', lookups: [], createdAt: '' },
    thirdParties: [],
    events: [],
    ledger: [],
    offers: [],
    hire: [],
    storage: [],
    recovery: [],
    evidence: [],
    documents: [],
    clocks: [],
    ...extra,
  } as ClaimBundle;
}

describe('need (§F.3)', () => {
  it('levels', () => {
    expect(needLevel(null).level).toBe('unknown');
    expect(needLevel(needs({ clientWantsHire: false })).level).toBe('none');
    expect(needLevel(needs({ otherVehicles: 'available', occupation: 'nurse' })).level).toBe('weak');
    expect(needLevel(needs({ ownInsurerCourtesyCar: 'accepted' })).level).toBe('weak');
    expect(needLevel(needs({ occupation: 'care worker' })).level).toBe('strong');
    expect(needLevel(needs({ phvWork: true })).level).toBe('strong');
    expect(needLevel(needs({ journeys: 'visits family at weekends' })).level).toBe('moderate');
    expect(needLevel(needs({ otherVehicles: 'unknown', occupation: 'nurse' })).level).toBe('unknown');
    expect(needLevel(needs()).level).toBe('unknown');
  });
  it('phvWork → pco; restriction 78 → automatic only', () => {
    const n = assessNeed(needs({ phvWork: true }), bundle(), { partyId: 'p', outcome: 'eligible', reasons: [], missing: [], criteriaSource: 'settings_default', automaticOnly: true });
    expect(n.use).toBe('pco');
    expect(n.automaticOnly).toBe(true);
  });
});

describe('means (§F.4)', () => {
  it('impecunious only when the evidence is ready; otherwise the basic-hire-rate warning', () => {
    const m = assessMeans(bundle(), []);
    expect(m.basis).toBe('unknown');
    expect(m.warning).toMatch(/Dimond v Lovell/);
    const ready = assessMeans(bundle(), [{ gate: 'impecuniosity', status: 'green', missing: [], present: ['x'] } as never]);
    expect(ready).toMatchObject({ basis: 'impecunious', readiness: 'ready', warning: null });
  });
});

describe('roadworthiness (§F.5)', () => {
  it('not driveable → hire from now; driveable → from the repair start', () => {
    expect(assessRoadworthiness(bundle({}, { driveable: false }), null).hireFrom).toBe('now');
    const d = assessRoadworthiness(bundle({ events: [{ id: 'e', claimId: 'c1', type: 'repair_started', at: '2026-10-20T09:00:00Z', recordedAt: '', summary: '', evidenceIds: [], createdBy: 'system' }] }, { driveable: true }), null);
    expect(d).toMatchObject({ hireFrom: 'repair_start', repairStartAt: '2026-10-20T09:00:00Z' });
    expect(assessRoadworthiness(bundle(), null).hireFrom).toBe('unknown');
  });
  it("client's car MOT/tax on the accident date", () => {
    expect(clientCarOnDate({ motExpiryDate: '2026-09-01', taxDueDate: '2027-01-01' }, '2026-10-01T08:00:00Z')).toEqual({ mot: 'expired', tax: 'valid' });
    expect(clientCarOnDate({ motHistory: [{ completedDate: '2025-11-01', expiryDate: '2026-10-31', result: 'PASSED', defects: [] }] }, '2026-10-01T08:00:00Z').mot).toBe('valid');
    expect(clientCarOnDate({}, '2026-10-01T08:00:00Z')).toEqual({ mot: 'unknown', tax: 'unknown' });
  });
});

describe('summary (§F.7)', () => {
  const driver = (o: 'eligible' | 'refer' | 'unknown' | 'ineligible') => ({ partyId: 'p', outcome: o, reasons: [], missing: o === 'unknown' ? ['points'] : [], criteriaSource: 'settings_default' as const, automaticOnly: false });
  const need = (level: 'strong' | 'weak' | 'unknown' | 'none') => ({ level, reasons: [], missing: [], mitigationRisks: [], automaticOnly: false, use: 'credit_hire' as const });
  const means = { basis: 'unknown' as const, readiness: 'none' as const, missing: [], warning: 'w' };
  const road = { driveable: false, hireFrom: 'now' as const, repairStartAt: null, clientCarOnAccidentDate: { mot: 'valid' as const, tax: 'valid' as const }, warnings: [] };
  const injury = { referralNeeded: false, referred: false };
  it('green only with eligible drivers and strong/moderate need', () => {
    expect(summariseEligibility({ driver: driver('eligible'), additionalDrivers: [], need: need('strong'), means, roadworthiness: road, injury, requireMeansBeforeOffer: false })).toMatchObject({ overall: 'eligible', green: true });
    expect(summariseEligibility({ driver: driver('eligible'), additionalDrivers: [driver('refer')], need: need('strong'), means, roadworthiness: road, injury, requireMeansBeforeOffer: false })).toMatchObject({ overall: 'refer', green: false });
    expect(summariseEligibility({ driver: driver('eligible'), additionalDrivers: [], need: need('weak'), means, roadworthiness: road, injury, requireMeansBeforeOffer: false })).toMatchObject({ overall: 'eligible', green: false });
    expect(summariseEligibility({ driver: driver('eligible'), additionalDrivers: [], need: need('none'), means, roadworthiness: road, injury, requireMeansBeforeOffer: false }).overall).toBe('ineligible');
    expect(summariseEligibility({ driver: driver('eligible'), additionalDrivers: [], need: need('strong'), means, roadworthiness: road, injury, requireMeansBeforeOffer: true })).toMatchObject({ overall: 'unknown', green: false });
  });
});
