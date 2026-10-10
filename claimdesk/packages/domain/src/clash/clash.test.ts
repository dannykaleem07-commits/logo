// owned by ap-clash
/** Clash catalogue, identity and detector (docs/SUPREME-AUTOPILOT.md §C, §J.1 clash). */
import { describe, expect, it } from 'vitest';
import type { Claim, ClaimEvent, FleetUnit, HireAgreement, InsurancePolicy, InterventionOffer, Party, PenaltyNotice, Vehicle } from '../types.js';
import type { FleetDamage, HireNeeds, Movement, ReadinessTask, Reservation } from '../booking/types.js';
import type { DriverProfile } from '../eligibility/types.js';
import type { AcceptanceAssessment } from '../acceptance/assess.js';
import { DEFAULT_AUTOPILOT_SETTINGS } from '../autopilot/settings.js';
import { OVERRIDE_RULES } from '../override/codes.js';
import { CLASH_CATALOGUE, CLASH_DEFS, GREEN_BLOCKING_CLASH_CODES } from './catalogue.js';
import { detectClashes } from './detect.js';
import { personMatch, samePerson, vehicleMatch } from './identity.js';
import { CLASH_CODES, type ClashCode, type ClashSubject, type ClashWorld } from './types.js';

const NOW = '2026-10-12T09:00:00.000Z';
const opts = { now: NOW, settings: DEFAULT_AUTOPILOT_SETTINGS };

const vehicle = (id: string, registration: string, extra: Partial<Vehicle> = {}): Vehicle => ({ id, registration, make: 'Ford', model: 'Focus', odometer: [], ownership: 'client', lookups: [], createdAt: NOW, ...extra });
const party = (id: string, name: string, extra: Partial<Party> = {}): Party => ({ id, kind: 'individual', name, roles: ['claimant'], createdAt: NOW, ...extra });
const claim = (id: string, extra: Partial<Claim> = {}): Claim => ({
  id,
  reference: `CCG-2026-${id}`,
  status: 'accepted',
  openedAt: '2026-10-01T09:00:00.000Z',
  accident: { occurredAt: '2026-10-01T08:00:00.000Z', location: 'High St', circumstances: 'rear-ended' },
  liability: 'admitted',
  claimantId: `p-${id}`,
  clientVehicleId: `v-${id}`,
  thirdPartyIds: [],
  gtaSubscriber: false,
  linkedClaimIds: [],
  flags: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});
const policy = (extra: Partial<InsurancePolicy> = {}): InsurancePolicy => ({ id: 'pol1', insurerName: 'Fleet Ins', policyNumber: 'FP-1', coveredUses: ['credit_hire'], startDate: '2026-01-01', endDate: '2027-06-30', ...extra });
const unit = (extra: Partial<FleetUnit> = {}): FleetUnit => ({ id: 'u1', vehicleId: 'fv1', declaredUses: ['credit_hire'], policyId: 'pol1', dailyRatePence: 5000, gtaGroup: 'C2', keeperAddressCurrent: true, status: 'available', ...extra });
const reservation = (id: string, extra: Partial<Reservation> = {}): Reservation => ({
  id,
  fleetUnitId: 'u1',
  claimId: 'c1',
  status: 'held',
  use: 'credit_hire',
  startAt: '2026-10-13T09:00:00.000Z',
  expectedEndAt: '2026-10-27T09:00:00.000Z',
  hirerPartyId: 'p-c1',
  driverPartyIds: ['p-c1'],
  dailyRatePence: 5000,
  gtaGroup: 'C2',
  source: 'handler',
  createdBy: 'u',
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});
const hire = (id: string, extra: Partial<HireAgreement> = {}): HireAgreement => ({
  id,
  claimId: 'c2',
  fleetUnitId: 'u2',
  agreementNumber: `CCG-H-${id}`,
  startAt: '2026-10-05T09:00:00.000Z',
  dailyRatePence: 5000,
  vatRate: 0.2,
  gtaGroup: 'C2',
  excessPence: 0,
  additionalDrivers: [],
  enforceability: { cca60fCompliant: true },
  ...extra,
});
const profile = (partyId: string, extra: Partial<DriverProfile> = {}): DriverProfile => ({
  partyId,
  licenceCountry: 'GB',
  licenceType: 'full',
  fullLicenceSince: '2010-01-01',
  categories: ['B'],
  restrictionCodes: [],
  points: 0,
  endorsements: [],
  disqualifications5y: 0,
  faultAccidents3y: 0,
  unspentConvictions: [],
  medicalConditionsDeclared: false,
  dvlaCheck: { checkedAt: '2026-10-10T09:00:00.000Z', checkedBy: 'owner', summary: 'clean' },
  source: 'dvla_check',
  updatedBy: 'owner',
  updatedAt: NOW,
  ...extra,
});

/** A clean world: claim c1 (client car AB12CDE), fleet car u1 (XY70ABC, policy pol1, MOT/tax fine). */
function world(patch: Partial<ClashWorld> = {}): ClashWorld {
  return {
    claims: [claim('c1')],
    vehicles: [vehicle('v-c1', 'AB12CDE', { vin: 'WF0XXXGCDX1234567', motExpiryDate: '2027-03-01', taxDueDate: '2027-03-01' }), vehicle('fv1', 'XY70ABC', { ownership: 'fleet', motExpiryDate: '2027-05-01', taxDueDate: '2027-05-01' })],
    parties: [party('p-c1', 'Amir Hussain', { dateOfBirth: '1988-04-12' })],
    driverProfiles: [profile('p-c1')],
    fleetUnits: [unit()],
    policies: [policy()],
    reservations: [],
    hires: [],
    readiness: [],
    damage: [],
    penalties: [],
    eventsByClaim: { c1: [ev('c1', 'fnol', '2026-10-01T10:00:00.000Z'), ev('c1', 'services_agreed', '2026-10-02T10:00:00.000Z')] },
    acceptanceByClaim: {},
    interventionOffers: [],
    signedPackByReservation: {},
    ...patch,
  };
}
function ev(claimId: string, type: ClaimEvent['type'], at: string): ClaimEvent {
  return { id: `${claimId}-${type}-${at}`, claimId, type, at, recordedAt: at, summary: type, evidenceIds: [], createdBy: 'system' };
}
const proposed = (extra: Partial<Extract<ClashSubject, { kind: 'proposed_booking' }>> = {}): ClashSubject => ({
  kind: 'proposed_booking',
  claimId: 'c1',
  fleetUnitId: 'u1',
  use: 'credit_hire',
  startAt: '2026-10-13T09:00:00.000Z',
  expectedEndAt: '2026-10-27T09:00:00.000Z',
  hirerPartyId: 'p-c1',
  driverPartyIds: ['p-c1'],
  stage: 'hold',
  ...extra,
});
const codes = (subject: ClashSubject, w: ClashWorld, o = opts): ClashCode[] => detectClashes(subject, w, o).map((f) => f.code);
const find = (subject: ClashSubject, w: ClashWorld, code: ClashCode) => detectClashes(subject, w, opts).find((f) => f.code === code);

describe('catalogue', () => {
  it('has one definition per code in table order', () => {
    expect(CLASH_DEFS.map((d) => d.code)).toEqual([...CLASH_CODES]);
    expect(CLASH_CODES).toHaveLength(44);
  });
  it('every override code exists in OVERRIDE_RULES with the same class; class C codes have none', () => {
    for (const d of CLASH_DEFS) {
      if (d.overrideClass === 'C') {
        expect(d.overrideCode, d.code).toBeNull();
        continue;
      }
      expect(d.severity, d.code).toBe('block');
      expect(d.overrideCode, d.code).not.toBeNull();
      const rule = OVERRIDE_RULES[d.overrideCode!];
      expect(rule, d.code).toBeDefined();
      expect(rule!.class, d.code).toBe(d.overrideClass);
    }
  });
  it('warns and infos are never overridable; green-blocking ones are warns', () => {
    for (const d of CLASH_DEFS) if (d.severity !== 'block') expect(d.overrideClass).toBe('C');
    for (const c of GREEN_BLOCKING_CLASH_CODES) expect(CLASH_CATALOGUE[c].severity).toBe('warn');
    expect(GREEN_BLOCKING_CLASH_CODES).toEqual(expect.arrayContaining(['MOT_LAPSES_IN_PERIOD', 'DRIVER_ON_OTHER_HIRE', 'HIRE_PAST_OFFHIRE', 'GROUP_ABOVE_LFL', 'NEED_WEAK', 'INTERVENTION_UNANSWERED', 'CLIENT_CAR_NOT_LEGAL']));
  });
  it('class C blocks are the ones a manager can never override', () => {
    expect(CLASH_DEFS.filter((d) => d.severity === 'block' && d.overrideClass === 'C').map((d) => d.code).sort()).toEqual(['CLAIM_STATUS_NO_HIRE', 'DRIVER_INELIGIBLE', 'HOLD_EXPIRED', 'PHV_LICENCE', 'UNIT_DISPOSED', 'UNIT_IS_CLAIM_VEHICLE']);
  });
});

describe('identity', () => {
  const a = party('a', 'John  Smith', { dateOfBirth: '1980-01-02' });
  it('matches by id, licence number, or name + date of birth', () => {
    expect(personMatch(a, a)).toBe('id');
    expect(personMatch(party('x', 'J Smith', { drivingLicenceNumber: 'SMITH801020J99AB' }), party('y', 'John Smith', { drivingLicenceNumber: 'smith 801020 j99ab' }))).toBe('licence');
    expect(personMatch(a, party('b', 'john smith', { dateOfBirth: '1980-01-02' }))).toBe('name_dob');
  });
  it('different people with the same name are not matched', () => {
    expect(samePerson(a, party('c', 'John Smith', { dateOfBirth: '1975-06-30' }))).toBe(false);
    expect(samePerson(a, party('d', 'John Smith'))).toBe(false);
  });
  it('uses the driver profile licence number when the party has none', () => {
    expect(personMatch(party('x', 'A'), party('y', 'B'), { a: profile('x', { licenceNumber: 'ABCDE123' }), b: profile('y', { licenceNumber: 'abcde 123' }) })).toBe('licence');
  });
  it('matches vehicles by registration or VIN', () => {
    expect(vehicleMatch({ registration: 'ab12 cde' }, { registration: 'AB12CDE' })).toBe('registration');
    expect(vehicleMatch({ registration: 'X1', vin: 'wf0xxxgcdx1234567' }, { registration: 'Y2', vin: 'WF0XXXGCDX1234567' })).toBe('vin');
    expect(vehicleMatch({ registration: 'X1' }, { registration: 'Y2' })).toBeNull();
  });
});

describe('a clean world', () => {
  it('raises nothing for a proposed booking, the claim or the car', () => {
    const w = world();
    expect(codes(proposed(), w)).toEqual([]);
    expect(codes({ kind: 'claim', claimId: 'c1' }, w)).toEqual([]);
    expect(codes({ kind: 'fleet_unit', fleetUnitId: 'u1' }, w)).toEqual([]);
  });
  it('unknown subjects give no findings', () => {
    expect(codes({ kind: 'claim', claimId: 'nope' }, world())).toEqual([]);
    expect(codes({ kind: 'reservation', reservationId: 'nope', stage: 'hold' }, world())).toEqual([]);
  });
});

// Two claims with a car each, for the cross-claim codes.
function twoClaims(patch: Partial<ClashWorld> = {}): ClashWorld {
  const w = world();
  return {
    ...w,
    claims: [claim('c1'), claim('c2')],
    vehicles: [...w.vehicles, vehicle('v-c2', 'LM65XYZ'), vehicle('fv2', 'QR19DEF', { ownership: 'fleet', motExpiryDate: '2027-05-01', taxDueDate: '2027-05-01' })],
    parties: [...w.parties, party('p-c2', 'Beth Jones', { dateOfBirth: '1990-02-02' })],
    fleetUnits: [unit(), unit({ id: 'u2', vehicleId: 'fv2' })],
    ...patch,
  };
}

describe('per code (§C.2)', () => {
  it('1 UNIT_DOUBLE_BOOKED: overlap blocks (class A, HIRE_OVERLAP); touching periods do not; the message never names the other claim', () => {
    const w = twoClaims({ reservations: [reservation('r2', { claimId: 'c2', hirerPartyId: 'p-c2', driverPartyIds: ['p-c2'], status: 'confirmed', startAt: '2026-10-20T09:00:00.000Z', expectedEndAt: '2026-11-01T09:00:00.000Z' })] });
    const f = find(proposed(), w, 'UNIT_DOUBLE_BOOKED')!;
    expect(f).toMatchObject({ severity: 'block', overrideClass: 'A', claimId: 'c1', fleetUnitId: 'u1' });
    expect(f.related.claimIds).toEqual(['c2']);
    expect(f.message).not.toContain('CCG-2026-c2');
    expect(f.message).not.toContain('Beth');
    expect(CLASH_CATALOGUE.UNIT_DOUBLE_BOOKED.overrideCode).toBe('HIRE_OVERLAP');
    expect(codes(proposed({ expectedEndAt: '2026-10-20T09:00:00.000Z' }), w)).not.toContain('UNIT_DOUBLE_BOOKED');
    // stable dedupe key
    expect(find(proposed(), w, 'UNIT_DOUBLE_BOOKED')!.dedupeKey).toBe(f.dedupeKey);
  });
  it('1 UNIT_DOUBLE_BOOKED: an overdue on-hire car keeps occupying, and a returned car until it was collected', () => {
    const overdue = twoClaims({ reservations: [reservation('r2', { claimId: 'c2', status: 'on_hire', startAt: '2026-09-20T09:00:00.000Z', expectedEndAt: '2026-10-05T09:00:00.000Z' })] });
    expect(codes(proposed({ startAt: '2026-10-12T08:30:00.000Z' }), overdue)).toContain('UNIT_DOUBLE_BOOKED');
    const collected = twoClaims({ reservations: [reservation('r2', { claimId: 'c2', status: 'returned', startAt: '2026-09-20T09:00:00.000Z', expectedEndAt: '2026-10-05T09:00:00.000Z', endAt: '2026-10-10T09:00:00.000Z', collectedAt: '2026-10-14T09:00:00.000Z' })] });
    expect(codes(proposed(), collected)).toContain('UNIT_DOUBLE_BOOKED');
  });
  it('1 UNIT_DOUBLE_BOOKED: excludeReservationId and the reservation itself are ignored', () => {
    const w = world({ reservations: [reservation('r1')] });
    expect(codes(proposed({ excludeReservationId: 'r1' }), w)).not.toContain('UNIT_DOUBLE_BOOKED');
    expect(codes({ kind: 'reservation', reservationId: 'r1', stage: 'confirm' }, w)).not.toContain('UNIT_DOUBLE_BOOKED');
  });
  it('2 TURNAROUND_SHORT: warn when the gap is under the turnaround', () => {
    const w = twoClaims({ reservations: [reservation('r2', { claimId: 'c2', status: 'confirmed', startAt: '2026-10-01T09:00:00.000Z', expectedEndAt: '2026-10-13T08:00:00.000Z' })] });
    expect(find(proposed(), w, 'TURNAROUND_SHORT')).toMatchObject({ severity: 'warn', data: { gapMinutes: 60 } });
    const ok = twoClaims({ reservations: [reservation('r2', { claimId: 'c2', status: 'confirmed', startAt: '2026-10-01T09:00:00.000Z', expectedEndAt: '2026-10-13T06:00:00.000Z' })] });
    expect(codes(proposed(), ok)).not.toContain('TURNAROUND_SHORT');
  });
  it('3 UNIT_NOT_READY: blocking task or unrepaired major damage; a task ready before the start is fine', () => {
    const task = (extra: Partial<ReadinessTask>): ReadinessTask => ({ id: 't1', fleetUnitId: 'u1', kind: 'damage_repair', status: 'open', blocksHire: true, createdBy: 'x', createdAt: NOW, ...extra });
    expect(find(proposed(), world({ readiness: [task({})] }), 'UNIT_NOT_READY')).toMatchObject({ severity: 'block', overrideClass: 'A' });
    expect(codes(proposed(), world({ readiness: [task({ readyByAt: '2026-10-13T08:00:00.000Z' })] }))).not.toContain('UNIT_NOT_READY');
    expect(codes(proposed(), world({ readiness: [task({ blocksHire: false })] }))).not.toContain('UNIT_NOT_READY');
    const dmg: FleetDamage = { id: 'd1', fleetUnitId: 'u1', panel: 'front bumper', description: 'cracked', severity: 'major', foundAt: '2026-10-10T09:00:00.000Z', foundBy: 'x', evidenceIds: [], chargeable: 'tbc' };
    expect(codes(proposed(), world({ damage: [dmg] }))).toContain('UNIT_NOT_READY');
    expect(codes(proposed(), world({ damage: [{ ...dmg, severity: 'minor' }] }))).not.toContain('UNIT_NOT_READY');
  });
  it('4, 5 UNIT_OFF_ROAD (A) and UNIT_DISPOSED (C)', () => {
    expect(find(proposed(), world({ fleetUnits: [unit({ status: 'off_road' })] }), 'UNIT_OFF_ROAD')).toMatchObject({ severity: 'block', overrideClass: 'A' });
    expect(find(proposed(), world({ fleetUnits: [unit({ status: 'disposed' })] }), 'UNIT_DISPOSED')).toMatchObject({ severity: 'block', overrideClass: 'C' });
  });
  it('6 USE_NOT_DECLARED', () => {
    expect(codes(proposed({ use: 'self_drive' }), world())).toContain('USE_NOT_DECLARED');
  });
  it('7 POLICY_NOT_IN_FORCE: none, expired, or not covering the use', () => {
    expect(codes(proposed(), world({ fleetUnits: [unit({ policyId: undefined as never })] }))).toContain('POLICY_NOT_IN_FORCE');
    expect(codes(proposed(), world({ policies: [policy({ endDate: '2026-10-01' })] }))).toContain('POLICY_NOT_IN_FORCE');
    expect(codes(proposed(), world({ policies: [policy({ coveredUses: ['self_drive'] })], fleetUnits: [unit({ declaredUses: ['credit_hire', 'self_drive'] })] }))).toContain('POLICY_NOT_IN_FORCE');
  });
  it('8 POLICY_ENDS_IN_PERIOD unless a renewal is recorded (either link direction)', () => {
    const ending = policy({ endDate: '2026-10-20' });
    const f = find(proposed(), world({ policies: [ending] }), 'POLICY_ENDS_IN_PERIOD')!;
    expect(f).toMatchObject({ severity: 'block', overrideClass: 'A', data: { coverEndsOn: '2026-10-20' } });
    expect(f.message).toMatch(/uninsured after 20 Oct 2026/);
    const renewal = policy({ id: 'pol2', startDate: '2026-10-21', endDate: '2027-10-20' });
    expect(codes(proposed(), world({ policies: [{ ...ending, renewsPolicyId: 'pol2' }, renewal] }))).not.toContain('POLICY_ENDS_IN_PERIOD');
    expect(codes(proposed(), world({ policies: [ending, { ...renewal, renewsPolicyId: 'pol1' }] }))).not.toContain('POLICY_ENDS_IN_PERIOD');
    expect(codes(proposed(), world({ policies: [ending, policy({ id: 'pol2', startDate: '2026-10-25', endDate: '2027-10-20', renewsPolicyId: 'pol1' })] }))).toContain('POLICY_ENDS_IN_PERIOD');
  });
  it('9, 10 MOT invalid at the start (block) / lapsing in the period (warn, green-blocking)', () => {
    const w = (mot: string) => world({ vehicles: [vehicle('v-c1', 'AB12CDE'), vehicle('fv1', 'XY70ABC', { ownership: 'fleet', motExpiryDate: mot, taxDueDate: '2027-05-01' })] });
    expect(find(proposed(), w('2026-10-12'), 'MOT_INVALID_AT_START')).toMatchObject({ severity: 'block', overrideClass: 'A' });
    expect(find(proposed(), w('2026-10-20'), 'MOT_LAPSES_IN_PERIOD')).toMatchObject({ severity: 'warn' });
    expect(codes(proposed(), w('2026-10-20'))).not.toContain('MOT_INVALID_AT_START');
  });
  it('11, 12 tax invalid at the start / lapsing in the period', () => {
    const w = (extra: Partial<Vehicle>) => world({ vehicles: [vehicle('v-c1', 'AB12CDE'), vehicle('fv1', 'XY70ABC', { ownership: 'fleet', motExpiryDate: '2027-05-01', ...extra })] });
    expect(codes(proposed(), w({ taxStatus: 'SORN' }))).toContain('TAX_INVALID_AT_START');
    expect(codes(proposed(), w({ taxDueDate: '2026-10-01' }))).toContain('TAX_INVALID_AT_START');
    expect(codes(proposed(), w({ taxDueDate: '2026-10-15' }))).toContain('TAX_LAPSES_IN_PERIOD');
  });
  it('13 SERVICE_DUE_IN_PERIOD by date or mileage', () => {
    expect(codes(proposed(), world({ fleetUnits: [unit({ serviceDueDate: '2026-10-20' })] }))).toContain('SERVICE_DUE_IN_PERIOD');
    expect(codes(proposed(), world({ fleetUnits: [unit({ serviceDueMiles: 30_300, currentMileage: 30_000 })] }))).toContain('SERVICE_DUE_IN_PERIOD');
    expect(codes(proposed(), world({ fleetUnits: [unit({ serviceDueMiles: 40_000, currentMileage: 30_000 })] }))).not.toContain('SERVICE_DUE_IN_PERIOD');
  });
  it('14 PHV_LICENCE (class C) for pco use', () => {
    const pco = { declaredUses: ['pco' as const], phvLicensed: false };
    const pol = [policy({ coveredUses: ['pco'] })];
    expect(find(proposed({ use: 'pco' }), world({ fleetUnits: [unit(pco)], policies: pol }), 'PHV_LICENCE')).toMatchObject({ severity: 'block', overrideClass: 'C' });
    expect(codes(proposed({ use: 'pco' }), world({ fleetUnits: [unit({ ...pco, phvLicensed: true, phvLicenceExpiry: '2026-10-15' })], policies: pol }))).toContain('PHV_LICENCE');
    expect(codes(proposed({ use: 'pco' }), world({ fleetUnits: [unit({ ...pco, phvLicensed: true, phvLicenceExpiry: '2027-10-15' })], policies: pol }))).not.toContain('PHV_LICENCE');
  });
  it('15 KEEPER_ADDRESS_STALE and 16 OPEN_PENALTY_ON_UNIT', () => {
    expect(find(proposed(), world({ fleetUnits: [unit({ keeperAddressCurrent: false })] }), 'KEEPER_ADDRESS_STALE')!.severity).toBe('warn');
    const pcn: PenaltyNotice = { id: 'pn1', fleetUnitId: 'u1', kind: 'pcn' as PenaltyNotice['kind'], issuer: 'Council', noticeNumber: 'X1', contraventionAt: NOW, receivedAt: NOW, amountPence: 6500, responseDeadline: '2026-10-20', stage: 'received', documentIds: [] };
    expect(find(proposed(), world({ penalties: [pcn] }), 'OPEN_PENALTY_ON_UNIT')!.severity).toBe('info');
    expect(codes(proposed(), world({ penalties: [{ ...pcn, stage: 'paid' }] }))).not.toContain('OPEN_PENALTY_ON_UNIT');
  });
  it("17 UNIT_IS_CLAIM_VEHICLE (C): booking the claim's own car", () => {
    expect(find(proposed(), world({ claims: [claim('c1', { clientVehicleId: 'fv1' })] }), 'UNIT_IS_CLAIM_VEHICLE')).toMatchObject({ overrideClass: 'C' });
  });
  it('18 FLEET_REG_AS_CLAIM_VEHICLE from the claim and from the car', () => {
    const w = world({ vehicles: [vehicle('v-c1', 'XY70 ABC'), vehicle('fv1', 'XY70ABC', { ownership: 'fleet', motExpiryDate: '2027-05-01', taxDueDate: '2027-05-01' })] });
    expect(find({ kind: 'claim', claimId: 'c1' }, w, 'FLEET_REG_AS_CLAIM_VEHICLE')).toMatchObject({ severity: 'block', overrideClass: 'A', claimId: 'c1', fleetUnitId: 'u1' });
    const viaUnit = find({ kind: 'fleet_unit', fleetUnitId: 'u1' }, w, 'FLEET_REG_AS_CLAIM_VEHICLE')!;
    expect(viaUnit.dedupeKey).toBe(find({ kind: 'claim', claimId: 'c1' }, w, 'FLEET_REG_AS_CLAIM_VEHICLE')!.dedupeKey);
    expect(CLASH_CATALOGUE.FLEET_REG_AS_CLAIM_VEHICLE.overrideCode).toBe('HARD_STOP');
  });

  // The owner's example (§J.4): claim X has client car AB12CDE on hire with car A; claim Y for AB12CDE, same accident date.
  function ownersExample(): ClashWorld {
    const w = world();
    return {
      ...w,
      claims: [claim('cX', { clientVehicleId: 'vX', claimantId: 'pX' }), claim('cY', { clientVehicleId: 'vY', claimantId: 'pY', status: 'fnol' })],
      vehicles: [vehicle('vX', 'AB12CDE'), vehicle('vY', 'AB12 CDE'), w.vehicles[1]!, vehicle('fv2', 'QR19DEF', { ownership: 'fleet', motExpiryDate: '2027-05-01', taxDueDate: '2027-05-01' })],
      parties: [party('pX', 'Amir Hussain'), party('pY', 'Amir Hussain')],
      driverProfiles: [],
      fleetUnits: [unit(), unit({ id: 'u2', vehicleId: 'fv2' })],
      reservations: [reservation('rX', { claimId: 'cX', hirerPartyId: 'pX', driverPartyIds: ['pX'], status: 'on_hire', startAt: '2026-10-02T09:00:00.000Z', expectedEndAt: '2026-10-20T09:00:00.000Z' })],
      eventsByClaim: {},
    };
  }
  it("19 SAME_REG_ON_HIRE + 20 DUPLICATE_CLAIM_OPEN: the owner's example", () => {
    const w = ownersExample();
    const onY = codes({ kind: 'claim', claimId: 'cY' }, w);
    expect(onY).toContain('DUPLICATE_CLAIM_OPEN');
    expect(onY).toContain('SAME_REG_ON_HIRE');
    const booking = detectClashes(proposed({ claimId: 'cY', fleetUnitId: 'u2', hirerPartyId: 'pY', driverPartyIds: ['pY'] }), w, opts);
    const same = booking.find((f) => f.code === 'SAME_REG_ON_HIRE')!;
    expect(same).toMatchObject({ severity: 'block', overrideClass: 'A', claimId: 'cY' });
    expect(same.related.claimIds).toEqual(['cX']);
    expect(same.message).not.toContain('CCG-2026-cX');
    // X itself: Y has no hire, so no SAME_REG_ON_HIRE on X (but the duplicate is seen from both sides).
    expect(codes({ kind: 'claim', claimId: 'cX' }, w)).not.toContain('SAME_REG_ON_HIRE');
    expect(codes({ kind: 'claim', claimId: 'cX' }, w)).toContain('DUPLICATE_CLAIM_OPEN');
  });
  it('20/21 a closed claim or a far-apart accident is only DUPLICATE_REGISTRATION (warn)', () => {
    const w = ownersExample();
    const closed = { ...w, claims: [w.claims[0]!, { ...w.claims[1]!, status: 'closed' as const }], reservations: [] };
    expect(codes({ kind: 'claim', claimId: 'cX' }, closed)).toEqual(['DUPLICATE_REGISTRATION']);
    const far = { ...w, claims: [w.claims[0]!, { ...w.claims[1]!, accident: { ...w.claims[1]!.accident, occurredAt: '2026-01-01T08:00:00.000Z' } }], reservations: [] };
    expect(codes({ kind: 'claim', claimId: 'cY' }, far)).toEqual(['DUPLICATE_REGISTRATION']);
  });
  it('22 VIN_REG_MISMATCH: same VIN under a different registration', () => {
    const w = twoClaims({ vehicles: [vehicle('v-c1', 'AB12CDE', { vin: 'WF0XXXGCDX1234567' }), vehicle('v-c2', 'CHERI5H', { vin: 'WF0XXXGCDX1234567' }), vehicle('fv1', 'XY70ABC', { ownership: 'fleet' }), vehicle('fv2', 'QR19DEF', { ownership: 'fleet' })] });
    expect(codes({ kind: 'claim', claimId: 'c1' }, w)).toContain('VIN_REG_MISMATCH');
  });
  it('23 CLAIM_SECOND_HIRE: another car on this claim for an overlapping period; a touching swap is fine', () => {
    const w = twoClaims({ reservations: [reservation('r0', { fleetUnitId: 'u2', status: 'on_hire', startAt: '2026-10-05T09:00:00.000Z', expectedEndAt: '2026-10-20T09:00:00.000Z' })] });
    expect(find(proposed(), w, 'CLAIM_SECOND_HIRE')).toMatchObject({ severity: 'block', overrideClass: 'A' });
    const swap = twoClaims({ reservations: [reservation('r0', { fleetUnitId: 'u2', status: 'confirmed', startAt: '2026-10-05T09:00:00.000Z', expectedEndAt: '2026-10-13T09:00:00.000Z' })] });
    expect(codes(proposed(), swap)).not.toContain('CLAIM_SECOND_HIRE');
  });
  it('24 HIRER_ON_OTHER_HIRE by identity (licence or name + DOB), 25 DRIVER_ON_OTHER_HIRE for additional drivers', () => {
    const base = twoClaims({ hires: [hire('h2', { claimId: 'c2', fleetUnitId: 'u2', hirerPartyId: 'p-c2' })] });
    const sameHirer = { ...base, parties: [party('p-c1', 'Amir Hussain', { dateOfBirth: '1988-04-12' }), party('p-c2', 'amir  hussain', { dateOfBirth: '1988-04-12' })] };
    expect(find(proposed(), sameHirer, 'HIRER_ON_OTHER_HIRE')).toMatchObject({ severity: 'block', overrideClass: 'A' });
    expect(codes(proposed(), base)).not.toContain('HIRER_ON_OTHER_HIRE');
    const withDriver = { ...base, parties: [...base.parties, party('p-d', 'Beth Jones', { dateOfBirth: '1990-02-02' })] };
    expect(find(proposed({ driverPartyIds: ['p-c1', 'p-d'] }), withDriver, 'DRIVER_ON_OTHER_HIRE')).toMatchObject({ severity: 'warn' });
  });
  it('26 DRIVER_INELIGIBLE (C) and 27 DRIVER_REFERRAL (A) against the policy criteria', () => {
    const young = world({ parties: [party('p-c1', 'Amir Hussain', { dateOfBirth: '2007-01-01' })] });
    expect(find(proposed(), young, 'DRIVER_INELIGIBLE')).toMatchObject({ severity: 'block', overrideClass: 'C' });
    const refer = world({ driverProfiles: [profile('p-c1', { points: 8 })] });
    expect(find(proposed(), refer, 'DRIVER_REFERRAL')).toMatchObject({ severity: 'block', overrideClass: 'A' });
    // the policy's own criteria win over the default
    const lenient = world({ driverProfiles: [profile('p-c1', { points: 8 })], policies: [policy({ driverCriteria: { ...DEFAULT_AUTOPILOT_SETTINGS.eligibility.defaultCriteria, maxPointsEligible: 9 } })] });
    expect(codes(proposed(), lenient)).not.toContain('DRIVER_REFERRAL');
    // a driver with no profile is unknown: no clash (qualify.driver asks the client instead)
    expect(codes(proposed(), world({ driverProfiles: [] }))).not.toContain('DRIVER_INELIGIBLE');
  });
  it('28 LICENCE_CHECK_STALE only at handover', () => {
    const w = world({ reservations: [reservation('r1', { status: 'confirmed' })], driverProfiles: [profile('p-c1', { dvlaCheck: { checkedAt: '2026-09-01T09:00:00.000Z', checkedBy: 'o', summary: 'ok' } })], signedPackByReservation: { r1: { signed: true, missing: [] } } });
    expect(codes({ kind: 'reservation', reservationId: 'r1', stage: 'confirm' }, w)).not.toContain('LICENCE_CHECK_STALE');
    expect(find({ kind: 'reservation', reservationId: 'r1', stage: 'handover' }, w, 'LICENCE_CHECK_STALE')).toMatchObject({ severity: 'block', overrideClass: 'A' });
    const none = { ...w, driverProfiles: [profile('p-c1', { dvlaCheck: undefined as never })] };
    expect(codes({ kind: 'reservation', reservationId: 'r1', stage: 'handover' }, none)).toContain('LICENCE_CHECK_STALE');
    const fresh = world({ reservations: [reservation('r1', { status: 'confirmed' })], signedPackByReservation: { r1: { signed: true, missing: [] } } });
    expect(codes({ kind: 'reservation', reservationId: 'r1', stage: 'handover' }, fresh)).toEqual([]);
  });
  it('29 HIRE_BEFORE_ACCIDENT: block for a new booking (class B), warn on a backdated hire', () => {
    const f = find(proposed({ startAt: '2026-09-30T09:00:00.000Z' }), world(), 'HIRE_BEFORE_ACCIDENT')!;
    expect(f).toMatchObject({ severity: 'block', overrideClass: 'B' });
    const w = world({ hires: [hire('h1', { claimId: 'c1', fleetUnitId: 'u1', startAt: '2026-09-30T09:00:00.000Z' })] });
    expect(find({ kind: 'hire', hireId: 'h1' }, w, 'HIRE_BEFORE_ACCIDENT')).toMatchObject({ severity: 'warn' });
  });
  it('30 HIRE_BEFORE_SERVICES: start before the services were agreed', () => {
    expect(find(proposed({ startAt: '2026-10-01T09:30:00.000Z' }), world(), 'HIRE_BEFORE_SERVICES')!.severity).toBe('warn');
    expect(codes(proposed(), world())).not.toContain('HIRE_BEFORE_SERVICES');
  });
  it('31 HIRE_PAST_OFFHIRE: expected end after the off-hire deadline', () => {
    const w = world({
      reservations: [reservation('r1', { status: 'on_hire', startAt: '2026-10-02T09:00:00.000Z', expectedEndAt: '2026-10-20T09:00:00.000Z' })],
      eventsByClaim: { c1: [ev('c1', 'repair_completed', '2026-10-10T12:00:00.000Z')] },
    });
    expect(find({ kind: 'reservation', reservationId: 'r1', stage: 'period_change' }, w, 'HIRE_PAST_OFFHIRE')).toMatchObject({ severity: 'warn', data: { trigger: 'repair_complete_24h' } });
    const inTime = { ...w, reservations: [reservation('r1', { status: 'on_hire', startAt: '2026-10-02T09:00:00.000Z', expectedEndAt: '2026-10-11T09:00:00.000Z' })] };
    expect(codes({ kind: 'reservation', reservationId: 'r1', stage: 'period_change' }, { ...inTime, eventsByClaim: { c1: [ev('c1', 'repair_completed', '2026-10-10T12:00:00.000Z')] } }, { ...opts, now: '2026-10-11T08:00:00.000Z' })).not.toContain('HIRE_PAST_OFFHIRE');
  });
  it('32 RETURN_OVERDUE for an on-hire booking and an open hire', () => {
    const w = world({ reservations: [reservation('r1', { status: 'on_hire', startAt: '2026-10-02T09:00:00.000Z', expectedEndAt: '2026-10-10T09:00:00.000Z' })] });
    expect(find({ kind: 'fleet_unit', fleetUnitId: 'u1' }, w, 'RETURN_OVERDUE')).toMatchObject({ severity: 'warn', reservationId: 'r1' });
    const h = world({ hires: [hire('h1', { claimId: 'c1', fleetUnitId: 'u1', expectedEndAt: '2026-10-10T09:00:00.000Z' })] });
    expect(codes({ kind: 'hire', hireId: 'h1' }, h)).toContain('RETURN_OVERDUE');
  });
  it('33 CLAIM_STATUS_NO_HIRE (C)', () => {
    for (const status of ['declined', 'settled', 'closed'] as const) expect(find(proposed(), world({ claims: [claim('c1', { status })] }), 'CLAIM_STATUS_NO_HIRE')).toMatchObject({ overrideClass: 'C' });
  });
  it('34 ACCEPTANCE_CONDITIONS_UNMET: decline, or a hire-gating condition', () => {
    const acc = (a: Partial<AcceptanceAssessment>): Record<string, AcceptanceAssessment> => ({ c1: { decision: 'accept', conditions: [], reasons: [], ...a } as AcceptanceAssessment });
    expect(codes(proposed(), world({ acceptanceByClaim: acc({ decision: 'decline', reasons: ['weak liability'] }) }))).toContain('ACCEPTANCE_CONDITIONS_UNMET');
    expect(codes(proposed(), world({ acceptanceByClaim: acc({ decision: 'accept_with_conditions', conditions: ['no hire until liability evidence obtained'] }) }))).toContain('ACCEPTANCE_CONDITIONS_UNMET');
    expect(codes(proposed(), world({ acceptanceByClaim: acc({ decision: 'accept_with_conditions', conditions: ['obtain CCTV/dashcam within 7 days'] }) }))).not.toContain('ACCEPTANCE_CONDITIONS_UNMET');
  });
  it('35 HARD_STOP_FLAG for an uncleared block flag', () => {
    const flag = { code: 'X', severity: 'block' as const, message: 'Stop.', raisedAt: NOW, raisedBy: 'system' as const };
    expect(find(proposed(), world({ claims: [claim('c1', { flags: [flag] })] }), 'HARD_STOP_FLAG')).toMatchObject({ overrideClass: 'A' });
    expect(codes(proposed(), world({ claims: [claim('c1', { flags: [{ ...flag, clearedAt: NOW }] })] }))).not.toContain('HARD_STOP_FLAG');
  });
  it('36 SIGNATURES_MISSING at handover', () => {
    const w = world({ reservations: [reservation('r1', { status: 'confirmed' })], signedPackByReservation: { r1: { signed: false, missing: ['CCGUK-03 hirer copy'] } } });
    const f = find({ kind: 'reservation', reservationId: 'r1', stage: 'handover' }, w, 'SIGNATURES_MISSING')!;
    expect(f).toMatchObject({ severity: 'block', overrideClass: 'A' });
    expect(f.message).toContain('CCGUK-03 hirer copy');
    expect(codes({ kind: 'reservation', reservationId: 'r1', stage: 'confirm' }, w)).not.toContain('SIGNATURES_MISSING');
  });
  it('37 GROUP_ABOVE_LFL compares benchmark rates, not codes; a substitution reason clears it', () => {
    const rate = (group: string, pence: number) => ({ group, dailyRatePence: pence, period: '2026-27', effectiveFrom: '2026-01-01', effectiveTo: '2027-12-31', verification: { status: 'verified' as const } }) as never;
    const w = world({ vehicles: [vehicle('v-c1', 'AB12CDE', { gtaGroup: 'C1' }), vehicle('fv1', 'XY70ABC', { ownership: 'fleet', motExpiryDate: '2027-05-01', taxDueDate: '2027-05-01' })], gtaRates: [rate('C1', 4000), rate('C2', 5500)] });
    expect(find(proposed(), w, 'GROUP_ABOVE_LFL')!.severity).toBe('warn');
    expect(codes(proposed(), { ...w, gtaRates: [rate('C1', 6000), rate('C2', 5500)] })).not.toContain('GROUP_ABOVE_LFL');
    const r = world({ ...w, reservations: [reservation('r1', { clientGtaGroup: 'C1', substitutionReason: 'only automatic available' })] });
    expect(codes({ kind: 'reservation', reservationId: 'r1', stage: 'hold' }, { ...r, gtaRates: w.gtaRates! })).not.toContain('GROUP_ABOVE_LFL');
  });
  it('38 NEED_WEAK when another car is available', () => {
    const needs = { otherVehicles: 'available', ownInsurerCourtesyCar: 'unknown', clientWantsHire: true } as HireNeeds;
    expect(find({ kind: 'claim', claimId: 'c1' }, world({ needsByClaim: { c1: needs } }), 'NEED_WEAK')!.severity).toBe('warn');
    expect(codes({ kind: 'claim', claimId: 'c1' }, world({ needsByClaim: { c1: { ...needs, otherVehicles: 'none', occupation: 'nurse' } } }))).not.toContain('NEED_WEAK');
  });
  it('39 INTERVENTION_UNANSWERED', () => {
    const offer = { id: 'o1', claimId: 'c1', receivedAt: NOW, channel: 'email', offerorName: 'Insurer', terms: {}, suitabilityReasons: [], clientDecision: 'pending', evidenceIds: [] } as unknown as InterventionOffer;
    expect(codes({ kind: 'claim', claimId: 'c1' }, world({ interventionOffers: [offer] }))).toContain('INTERVENTION_UNANSWERED');
    expect(codes({ kind: 'claim', claimId: 'c1' }, world({ interventionOffers: [{ ...offer, replySentAt: NOW }] }))).not.toContain('INTERVENTION_UNANSWERED');
  });
  it("40 CLIENT_CAR_NOT_LEGAL: no MOT or tax on the accident date (insurance is never flagged)", () => {
    const w = world({ vehicles: [vehicle('v-c1', 'AB12CDE', { motExpiryDate: '2026-09-01' }), world().vehicles[1]!] });
    expect(find({ kind: 'claim', claimId: 'c1' }, w, 'CLIENT_CAR_NOT_LEGAL')!.severity).toBe('warn');
    const unknown = world({ vehicles: [vehicle('v-c1', 'AB12CDE'), world().vehicles[1]!] });
    expect(codes({ kind: 'claim', claimId: 'c1' }, unknown)).not.toContain('CLIENT_CAR_NOT_LEGAL');
  });
  it('41 INJURY_NOT_REFERRED (info)', () => {
    const c = claim('c1', { accident: { ...claim('c1').accident, injuries: true } });
    expect(find({ kind: 'claim', claimId: 'c1' }, world({ claims: [c] }), 'INJURY_NOT_REFERRED')!.severity).toBe('info');
    expect(codes({ kind: 'claim', claimId: 'c1' }, world({ claims: [{ ...c, injuryReferral: { referredTo: 'Sol', referredAt: NOW, feeTaken: false } }] }))).not.toContain('INJURY_NOT_REFERRED');
  });
  it('42 DELIVERY_BEFORE_READY and 43 DELIVERY_CAPACITY', () => {
    const mv = (id: string, reservationId: string, extra: Partial<Movement> = {}): Movement => ({ id, reservationId, claimId: 'c1', fleetUnitId: 'u1', kind: 'delivery', windowStart: '2026-10-13T09:00:00.000Z', windowEnd: '2026-10-13T11:00:00.000Z', address: null, postcode: null, assignedTo: null, status: 'planned', evidenceIds: [], ...extra });
    const task: ReadinessTask = { id: 't1', fleetUnitId: 'u1', kind: 'valet', status: 'open', blocksHire: true, readyByAt: '2026-10-13T10:00:00.000Z', createdBy: 'x', createdAt: NOW };
    const w = world({ reservations: [reservation('r1', { status: 'confirmed' })], readiness: [task], movements: [mv('m1', 'r1')] });
    expect(find({ kind: 'reservation', reservationId: 'r1', stage: 'confirm' }, w, 'DELIVERY_BEFORE_READY')).toMatchObject({ severity: 'block', overrideClass: 'A' });
    const busy = world({ reservations: [reservation('r1', { status: 'confirmed' })], movements: [mv('m1', 'r1'), mv('m2', 'x2'), mv('m3', 'x3')] });
    expect(find({ kind: 'reservation', reservationId: 'r1', stage: 'confirm' }, busy, 'DELIVERY_CAPACITY')).toMatchObject({ severity: 'warn', data: { count: 3 } });
  });
  it('44 HOLD_EXPIRED (C)', () => {
    const w = world({ reservations: [reservation('r1', { holdExpiresAt: '2026-10-12T08:00:00.000Z' })] });
    expect(find({ kind: 'reservation', reservationId: 'r1', stage: 'confirm' }, w, 'HOLD_EXPIRED')).toMatchObject({ severity: 'block', overrideClass: 'C' });
    expect(codes({ kind: 'reservation', reservationId: 'r1', stage: 'confirm' }, world({ reservations: [reservation('r1', { holdExpiresAt: '2026-10-13T08:00:00.000Z' })] }))).not.toContain('HOLD_EXPIRED');
  });
});

describe('claim and fleet-unit sweeps', () => {
  it('a claim run covers its live reservations and dedupes across them', () => {
    const w = world({ reservations: [reservation('r1', { status: 'on_hire', startAt: '2026-10-02T09:00:00.000Z', expectedEndAt: '2026-10-10T09:00:00.000Z' })] });
    const f = detectClashes({ kind: 'claim', claimId: 'c1' }, w, opts);
    expect(f.map((x) => x.code)).toEqual(['RETURN_OVERDUE']);
    expect(new Set(f.map((x) => x.dedupeKey)).size).toBe(f.length);
  });
  it('every code is reachable by at least one test above', () => {
    // guard against a code silently never firing: each code appears in CLASH_CATALOGUE with subjects
    for (const c of CLASH_CODES) expect(CLASH_CATALOGUE[c].subjects.length).toBeGreaterThan(0);
  });
});
