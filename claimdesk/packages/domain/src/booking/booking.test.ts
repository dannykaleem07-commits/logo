// owned by ap-booking — docs/SUPREME-AUTOPILOT.md §J.1 (booking)
import { describe, expect, it } from 'vitest';
import type { FleetUnit, GtaRate, InsurancePolicy, Vehicle } from '../types.js';
import type { DriverCriteria, DriverEligibility } from '../eligibility/types.js';
import { DEFAULT_DRIVER_CRITERIA } from '../eligibility/types.js';
import { DEFAULT_AUTOPILOT_SETTINGS } from '../autopilot/settings.js';
import {
  assertTransition,
  blankHireNeeds,
  blockColumns,
  canAllocateForPeriod,
  candidateGreen,
  fleetStatusFromReservations,
  greenTest,
  holdExpired,
  likeForLike,
  normaliseWeights,
  occupiedPeriod,
  overlappingReservations,
  projectHirePeriod,
  proposeSlots,
  returnReadinessTasks,
  searchAvailability,
  unitReadiness,
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_RANKING_WEIGHTS,
  RESERVATION_TRANSITIONS,
  RESERVATION_STATUSES,
  type AvailabilityQuery,
  type FleetDamage,
  type Movement,
  type ReadinessTask,
  type Reservation,
  type UnitSnapshot,
} from './index.js';

const NOW = '2026-10-12T08:00:00.000Z'; // Monday 09:00 London (BST)
const ms = (iso: string): number => Date.parse(iso);

const verification = { status: 'verified' as const };
const rate = (group: string, pence: number): GtaRate => ({ group, dailyRatePence: pence, period: '2026-27', effectiveFrom: '2026-01-01', effectiveTo: '2027-12-31', verification });
const RATES: GtaRate[] = [rate('C2', 6000), rate('C1', 5600), rate('B1', 4000), rate('D1', 8000), rate('S1', 3000), rate('M', 9000), rate('CP1', 12000)];

function vehicle(id: string, reg: string, extra: Partial<Vehicle> = {}): Vehicle {
  return {
    id,
    registration: reg,
    make: 'FORD',
    model: 'FOCUS',
    bodyType: 'Hatchback',
    fuelType: 'petrol',
    transmission: 'automatic',
    motExpiryDate: '2027-06-01',
    taxDueDate: '2027-06-01',
    odometer: [],
    ownership: 'fleet',
    lookups: [],
    createdAt: NOW,
    spec: { seats: 5, features: [], extras: [] },
    ...extra,
  };
}
function unit(id: string, vehicleId: string, extra: Partial<FleetUnit> = {}): FleetUnit {
  return { id, vehicleId, declaredUses: ['credit_hire'], policyId: 'pol-1', dailyRatePence: 5500, gtaGroup: 'C2', keeperAddressCurrent: true, status: 'available', ...extra };
}
function policy(extra: Partial<InsurancePolicy> = {}): InsurancePolicy {
  return { id: 'pol-1', insurerName: 'Fleet Insurer', policyNumber: 'FP-1', coveredUses: ['credit_hire'], startDate: '2026-01-01', endDate: '2027-01-01', ...extra };
}
function reservation(extra: Partial<Reservation> = {}): Reservation {
  return {
    id: 'r1',
    fleetUnitId: 'u-a',
    claimId: 'claim-other',
    status: 'held',
    use: 'credit_hire',
    startAt: '2026-10-13T09:00:00.000Z',
    expectedEndAt: '2026-10-20T09:00:00.000Z',
    hirerPartyId: 'p1',
    driverPartyIds: [],
    dailyRatePence: 5500,
    gtaGroup: 'C2',
    source: 'handler',
    createdBy: 'u',
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}
function snap(u: FleetUnit, v: Vehicle, extra: Partial<UnitSnapshot> = {}): UnitSnapshot {
  return { unit: u, vehicle: v, policies: [policy()], reservations: [], readiness: [], damage: [], penalties: [], location: null, ...extra };
}
function task(extra: Partial<ReadinessTask> = {}): ReadinessTask {
  return { id: 't1', fleetUnitId: 'u-a', kind: 'valet', status: 'open', blocksHire: false, createdBy: 'u', createdAt: NOW, ...extra };
}
const eligible = (): DriverEligibility => ({ partyId: 'p1', outcome: 'eligible', reasons: [], missing: [], criteriaSource: 'settings_default', automaticOnly: false });
const assessAs = (outcome: DriverEligibility['outcome']) => (): DriverEligibility => ({ ...eligible(), outcome, reasons: outcome === 'eligible' ? [] : [{ code: 'X', outcome, message: `${outcome} reason` }] });
const crit = (): DriverCriteria => DEFAULT_DRIVER_CRITERIA;

function query(extra: Partial<AvailabilityQuery> = {}): AvailabilityQuery {
  return {
    claimId: 'claim-1',
    use: 'credit_hire',
    startAt: '2026-10-13T09:00:00.000Z',
    expectedEndAt: '2026-10-27T09:00:00.000Z',
    needs: blankHireNeeds(),
    clientVehicle: { gtaGroup: 'C2', bodyType: 'Hatchback', fuelType: 'petrol', transmission: 'automatic', spec: { seats: 5, features: [], extras: [] } },
    clientGroup: 'C2',
    clientGroupSource: 'recorded',
    drivers: [{ partyId: 'p1', party: { name: 'Sam Client', dateOfBirth: '1990-01-01' } }],
    excludeReservationIds: [],
    limit: 10,
    ...extra,
  };
}
const ENV = { rates: RATES, weights: DEFAULT_RANKING_WEIGHTS, turnaroundMinutes: 120, clearWinnerGap: 8, criteria: crit, now: NOW, assessDriver: assessAs('eligible') };

// ---------------------------------------------------------------------------

describe('reservations: occupiedPeriod, transitions, block columns, fleet status', () => {
  it('occupiedPeriod for every status', () => {
    const base = reservation();
    expect(occupiedPeriod(base, NOW)).toEqual({ startMs: ms(base.startAt), endMs: ms(base.expectedEndAt!) });
    expect(occupiedPeriod({ ...base, status: 'confirmed' }, NOW).endMs).toBe(ms(base.expectedEndAt!));
    // on hire, overdue: occupies until now
    const late = '2026-10-25T12:00:00.000Z';
    expect(occupiedPeriod({ ...base, status: 'on_hire' }, late).endMs).toBe(ms(late));
    expect(occupiedPeriod({ ...base, status: 'on_hire' }, NOW).endMs).toBe(ms(base.expectedEndAt!));
    expect(occupiedPeriod({ ...base, status: 'on_hire', expectedEndAt: null }, NOW).endMs).toBeNull();
    // returned: collectedAt counts when later than the end
    const ret = { ...base, status: 'returned' as const, endAt: '2026-10-19T09:00:00.000Z', collectedAt: '2026-10-19T15:00:00.000Z' };
    expect(occupiedPeriod(ret, NOW).endMs).toBe(ms(ret.collectedAt));
    expect(occupiedPeriod({ ...ret, collectedAt: '2026-10-19T08:00:00.000Z' }, NOW).endMs).toBe(ms(ret.endAt));
    for (const s of ['cancelled', 'expired'] as const) {
      const p = occupiedPeriod({ ...base, status: s }, NOW);
      expect(p.endMs).toBe(p.startMs);
    }
    expect(blockColumns(ret)).toEqual({ blockStartMs: ms(ret.startAt), blockEndMs: ms(ret.collectedAt) });
    expect(blockColumns({ ...base, status: 'on_hire', expectedEndAt: null })).toEqual({ blockStartMs: ms(base.startAt), blockEndMs: null });
  });

  it('transitions table and assertTransition', () => {
    for (const from of RESERVATION_STATUSES) {
      for (const to of RESERVATION_STATUSES) {
        const ok = RESERVATION_TRANSITIONS[from].includes(to);
        if (ok) expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrowError(expect.objectContaining({ code: 'RESERVATION_STATE' }));
      }
    }
    expect(RESERVATION_TRANSITIONS.held).toEqual(['confirmed', 'cancelled', 'expired']);
    expect(RESERVATION_TRANSITIONS.on_hire).toEqual(['returned']);
  });

  it('overlap is half-open (touching periods pass); hold expiry', () => {
    const r = reservation();
    expect(overlappingReservations({ startAt: r.expectedEndAt!, endAt: '2026-10-30T09:00:00.000Z' }, [r], NOW)).toEqual([]);
    expect(overlappingReservations({ startAt: '2026-10-19T09:00:00.000Z', endAt: null }, [r], NOW)).toHaveLength(1);
    expect(overlappingReservations({ startAt: '2026-10-19T09:00:00.000Z', endAt: null }, [{ ...r, status: 'cancelled' }], NOW)).toEqual([]);
    expect(holdExpired({ status: 'held', holdExpiresAt: '2026-10-12T07:59:00.000Z' }, NOW)).toBe(true);
    expect(holdExpired({ status: 'held', holdExpiresAt: '2026-10-12T09:00:00.000Z' }, NOW)).toBe(false);
    expect(holdExpired({ status: 'confirmed', holdExpiresAt: '2026-10-12T07:00:00.000Z' }, NOW)).toBe(false);
  });

  it('fleet status follows on-hire reservations only (a future confirmed booking does not flip it)', () => {
    const future = reservation({ status: 'confirmed' });
    expect(fleetStatusFromReservations({ status: 'available' }, [future], NOW)).toBe('available');
    expect(fleetStatusFromReservations({ status: 'available' }, [reservation({ status: 'on_hire', startAt: '2026-10-10T09:00:00.000Z' })], NOW)).toBe('on_hire');
    expect(fleetStatusFromReservations({ status: 'on_hire' }, [reservation({ status: 'returned', startAt: '2026-10-01T09:00:00.000Z', endAt: '2026-10-05T09:00:00.000Z' })], NOW)).toBe('available');
    expect(fleetStatusFromReservations({ status: 'off_road' }, [reservation({ status: 'on_hire', startAt: '2026-10-10T09:00:00.000Z' })], NOW)).toBe('off_road');
  });
});

describe('readiness', () => {
  it('ready / ready_by / not_ready', () => {
    expect(unitReadiness([], [], NOW)).toEqual({ state: 'ready' });
    const valet = task({ readyByAt: '2026-10-12T10:00:00.000Z' });
    expect(unitReadiness([valet], [], NOW)).toMatchObject({ state: 'ready_by', at: '2026-10-12T10:00:00.000Z' });
    expect(unitReadiness([valet], [], '2026-10-12T10:00:00.000Z')).toEqual({ state: 'ready' });
    expect(unitReadiness([task({ kind: 'mot', blocksHire: true })], [], NOW)).toEqual({ state: 'not_ready', blocking: ['t1'] });
    const dmg: FleetDamage = { id: 'd1', fleetUnitId: 'u-a', panel: 'front bumper', description: 'split', severity: 'major', foundAt: NOW, foundBy: 'u', evidenceIds: [], chargeable: 'tbc' };
    expect(unitReadiness([], [dmg], NOW)).toEqual({ state: 'not_ready', blocking: ['d1'] });
    expect(unitReadiness([], [{ ...dmg, severity: 'cosmetic' }], NOW)).toEqual({ state: 'ready' });
    expect(unitReadiness([task({ id: 't2', kind: 'damage_repair', blocksHire: true, damageId: 'd1', readyByAt: '2026-10-14T09:00:00.000Z' })], [dmg], NOW)).toMatchObject({ state: 'ready_by' });
  });

  it('return creates valet + inspection after turnaround, damage repairs (major blocks, no estimate)', () => {
    const tasks = returnReadinessTasks('2026-10-12T10:00:00.000Z', 120, [{ severity: 'major', panel: 'door', description: 'dent' }, { severity: 'minor', panel: 'wing', description: 'scratch' }]);
    expect(tasks.map((t) => [t.kind, t.blocksHire, t.readyByAt ?? null])).toEqual([
      ['valet', false, '2026-10-12T12:00:00.000Z'],
      ['inspection', false, '2026-10-12T12:00:00.000Z'],
      ['damage_repair', true, null],
      ['damage_repair', false, '2026-10-12T12:00:00.000Z'],
    ]);
  });
});

describe('canAllocateForPeriod', () => {
  const v = vehicle('v-a', 'AB12CDE');
  const period = { startAt: '2026-10-13T09:00:00.000Z', expectedEndAt: '2026-10-27T09:00:00.000Z' };

  it('a compliant car passes with a margin', () => {
    const r = canAllocateForPeriod(unit('u-a', 'v-a'), 'credit_hire', [policy()], period, v, { now: NOW });
    expect(r.ok).toBe(true);
    expect(r.lapses).toEqual([]);
    expect(r.marginDays).toBeGreaterThan(30);
  });

  it('policy ending mid-period blocks POLICY_ENDS_IN_PERIOD; a recorded renewal chains', () => {
    const ending = policy({ endDate: '2026-10-20' });
    const r = canAllocateForPeriod(unit('u-a', 'v-a'), 'credit_hire', [ending], period, v, { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.blocks.map((b) => b.code)).toEqual(['POLICY_ENDS_IN_PERIOD']);
    expect(r.lapses).toEqual([{ kind: 'policy', date: '2026-10-21' }]);
    const renewal = policy({ id: 'pol-2', policyNumber: 'FP-2', startDate: '2026-10-21', endDate: '2027-10-20' });
    const chained = canAllocateForPeriod(unit('u-a', 'v-a'), 'credit_hire', [{ ...ending, renewsPolicyId: 'pol-2' }, renewal], period, v, { now: NOW });
    expect(chained.ok).toBe(true);
    // the reverse link (the renewal names the old policy) works too
    expect(canAllocateForPeriod(unit('u-a', 'v-a'), 'credit_hire', [ending, { ...renewal, renewsPolicyId: 'pol-1' }], period, v, { now: NOW }).ok).toBe(true);
    // a gap of a day breaks the chain
    expect(canAllocateForPeriod(unit('u-a', 'v-a'), 'credit_hire', [{ ...ending, renewsPolicyId: 'pol-2' }, { ...renewal, startDate: '2026-10-22' }], period, v, { now: NOW }).ok).toBe(false);
    // a renewal that does not cover the use does not count
    expect(canAllocateForPeriod(unit('u-a', 'v-a'), 'credit_hire', [{ ...ending, renewsPolicyId: 'pol-2' }, { ...renewal, coveredUses: ['self_drive'] }], period, v, { now: NOW }).ok).toBe(false);
  });

  it('policy not in force at the start, use not declared → blocks with codes', () => {
    const r = canAllocateForPeriod(unit('u-a', 'v-a', { declaredUses: ['self_drive'] }), 'credit_hire', [policy({ startDate: '2026-11-01' })], period, v, { now: NOW });
    expect(r.blocks.map((b) => b.code).sort()).toEqual(['POLICY_NOT_IN_FORCE', 'USE_NOT_DECLARED']);
  });

  it('MOT / tax lapsing in the period warn with lapses; MOT expired at the start blocks', () => {
    const r = canAllocateForPeriod(unit('u-a', 'v-a'), 'credit_hire', [policy()], period, { ...v, motExpiryDate: '2026-10-20', taxDueDate: '2026-10-22' }, { now: NOW });
    expect(r.ok).toBe(true);
    expect(r.warns.map((w) => w.code)).toEqual(['MOT_LAPSES_IN_PERIOD', 'TAX_LAPSES_IN_PERIOD']);
    expect(r.lapses.map((l) => l.kind)).toEqual(['mot', 'tax']);
    expect(r.marginDays).toBeLessThan(0);
    const expired = canAllocateForPeriod(unit('u-a', 'v-a'), 'credit_hire', [policy()], period, { ...v, motExpiryDate: '2026-10-01' }, { now: NOW });
    expect(expired.blocks.map((b) => b.code)).toEqual(['MOT_INVALID_AT_START']);
  });

  it('PHV: pco needs a licensed car with a licence for the whole period', () => {
    const pcoPolicy = [policy({ coveredUses: ['pco'] })];
    const pcoUnit = (x: Partial<FleetUnit>) => unit('u-a', 'v-a', { declaredUses: ['pco'], ...x });
    expect(canAllocateForPeriod(pcoUnit({ phvLicensed: false }), 'pco', pcoPolicy, period, v, { now: NOW }).blocks.map((b) => b.code)).toEqual(['PHV_LICENCE']);
    expect(canAllocateForPeriod(pcoUnit({ phvLicensed: true, phvLicenceExpiry: '2026-10-20' }), 'pco', pcoPolicy, period, v, { now: NOW }).blocks.map((b) => b.code)).toEqual(['PHV_LICENCE']);
    expect(canAllocateForPeriod(pcoUnit({ phvLicensed: true, phvLicenceExpiry: '2027-10-20' }), 'pco', pcoPolicy, period, v, { now: NOW }).ok).toBe(true);
  });
});

describe('likeForLike (rates, never codes)', () => {
  const car = (g: string, x: Partial<Vehicle> = {}) => ({ v: vehicle('v', 'AB12CDE', x), g });
  const client = query().clientVehicle;
  it('same group scores 1 on group; a sentence for the client', () => {
    const r = likeForLike(client, 'C2', car('C2').v, 'C2', RATES, '2026-10-13');
    expect(r.group.relation).toBe('same');
    expect(r.score).toBe(1);
    expect(r.sentence).toBe('Same hire group as your own car (C2), automatic, 5 seats, petrol.');
  });
  it('lower by ≤ 10 % → 0.8, by more → 0.5; higher → 0.4; unknown → 0.5', () => {
    expect(likeForLike(client, 'C2', car('C1').v, 'C1', RATES, '2026-10-13').parts.group).toBe(0.8);
    expect(likeForLike(client, 'C2', car('B1').v, 'B1', RATES, '2026-10-13').parts.group).toBe(0.5);
    const higher = likeForLike(client, 'C2', car('D1').v, 'D1', RATES, '2026-10-13');
    expect(higher.group.relation).toBe('higher');
    expect(higher.parts.group).toBe(0.4);
    expect(likeForLike(client, null, car('C2').v, 'C2', RATES, '2026-10-13').parts.group).toBe(0.5);
  });
  it('S vs M vs CP families compare by rate: CP1 is higher than M even though "C" < "M"', () => {
    const cp = likeForLike({ ...client!, gtaGroup: 'M' }, 'M', car('CP1').v, 'CP1', RATES, '2026-10-13');
    expect(cp.group.relation).toBe('higher');
    const s = likeForLike({ ...client!, gtaGroup: 'M' }, 'M', car('S1').v, 'S1', RATES, '2026-10-13');
    expect(s.group.relation).toBe('lower');
  });
  it('transmission, seats, fuel and body parts', () => {
    const manualClient = { ...client!, transmission: 'manual' as const };
    expect(likeForLike(manualClient, 'C2', car('C2').v, 'C2', RATES, '2026-10-13').parts.transmission).toBe(0.8);
    expect(likeForLike(client, 'C2', car('C2', { transmission: 'manual' }).v, 'C2', RATES, '2026-10-13').parts.transmission).toBe(0);
    expect(likeForLike({ ...client!, spec: { seats: 7, features: [], extras: [] } }, 'C2', car('C2').v, 'C2', RATES, '2026-10-13').parts.seats).toBe(0);
    expect(likeForLike({ ...client!, fuelType: 'hybrid' }, 'C2', car('C2').v, 'C2', RATES, '2026-10-13').parts.fuel).toBe(1);
    expect(likeForLike({ ...client!, fuelType: 'electric' }, 'C2', car('C2').v, 'C2', RATES, '2026-10-13').parts.fuel).toBe(0.5);
    expect(likeForLike(client, 'C2', car('C2', { bodyType: 'Estate' }).v, 'C2', RATES, '2026-10-13').parts.body).toBe(0.5);
    expect(likeForLike(client, 'C2', car('C2', { bodyType: 'Panel Van' }).v, 'C2', RATES, '2026-10-13').parts.body).toBe(0);
  });
});

describe('searchAvailability', () => {
  // e2e shape: A Focus auto C2; B same group manual; C SUV one group higher.
  const A = snap(unit('u-a', 'v-a', { currentMileage: 20000 }), vehicle('v-a', 'AA11AAA'));
  const B = snap(unit('u-b', 'v-b'), vehicle('v-b', 'BB22BBB', { transmission: 'manual' }));
  const C = snap(unit('u-c', 'v-c', { gtaGroup: 'D1', dailyRatePence: 7500 }), vehicle('v-c', 'CC33CCC', { bodyType: 'SUV', model: 'KUGA' }));

  it('code 78 excludes the manual car with the reason; the higher group ranks lower with GROUP_ABOVE_LFL; A green and a clear winner', () => {
    const q = query({ drivers: [{ partyId: 'p1', profile: { partyId: 'p1', licenceCountry: 'GB', licenceType: 'full', categories: ['B'], restrictionCodes: ['78'], points: 3, endorsements: [], disqualifications5y: 0, faultAccidents3y: 0, unspentConvictions: [], medicalConditionsDeclared: false, source: 'declared', updatedBy: 'u', updatedAt: NOW }, party: { name: 'Sam Client' } }] });
    const r = searchAvailability(q, [A, B, C], ENV);
    expect(r.ranked.map((c) => c.registration)).toEqual(['AA11 AAA', 'CC33 CCC']);
    expect(r.excluded).toEqual([{ fleetUnitId: 'u-b', registration: 'BB22 BBB', reasons: [{ code: 'NEED_AUTOMATIC', message: "manual gearbox; the driver's licence is automatic-only (code 78)" }] }]);
    expect(r.ranked[1]!.warnings.map((w) => w.code)).toContain('GROUP_ABOVE_LFL');
    expect(r.clearWinner).toBe(true);
    expect(r.green).toBe(true);
    expect(r.explanation[0]).toContain('AA11 AAA');
    expect(r.explanation[1]).toMatch(/^Clear winner/);
    expect(r.explanation.at(-1)).toContain("BB22 BBB — manual gearbox; the driver's licence is automatic-only (code 78)");
    expect(r.ranked[0]!.label).toBe('Ford Focus auto, 5 seats, petrol (C2)');
  });

  it('every exclusion reason is listed', () => {
    const other = reservation({ id: 'r-o', fleetUnitId: 'u-x', claimId: 'claim-9', status: 'confirmed' });
    const bad = snap(unit('u-x', 'v-x', { declaredUses: ['self_drive'] }), vehicle('v-x', 'XX11XXX', { transmission: 'manual', motExpiryDate: '2026-10-01', spec: { seats: 4, features: [], extras: [] } }), {
      reservations: [other],
      readiness: [task({ fleetUnitId: 'u-x', kind: 'mot', blocksHire: true })],
    });
    const needs = { ...blankHireNeeds(), automaticOnly: true, seatsMin: 5, towbar: true, wheelchairAccessible: true, handControls: true };
    const r = searchAvailability(query({ needs }), [bad], { ...ENV, assessDriver: assessAs('ineligible'), claimVehicleIds: ['v-x'] });
    const codes = r.excluded[0]!.reasons.map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['UNIT_IS_CLAIM_VEHICLE', 'USE_NOT_DECLARED', 'MOT_INVALID_AT_START', 'UNIT_DOUBLE_BOOKED', 'UNIT_NOT_READY', 'NEED_AUTOMATIC', 'NEED_SEATS', 'NEED_TOWBAR', 'NEED_WHEELCHAIR', 'NEED_HAND_CONTROLS', 'DRIVER_INELIGIBLE']));
    expect(r.ranked).toEqual([]);
    expect(r.green).toBe(false);
    expect(r.explanation[0]).toMatch(/^No car is available/);
    // disposed and off-road
    expect(searchAvailability(query(), [snap(unit('u-d', 'v-d', { status: 'disposed' }), vehicle('v-d', 'DD11DDD'))], ENV).excluded[0]!.reasons[0]!.code).toBe('UNIT_DISPOSED');
    expect(searchAvailability(query(), [snap(unit('u-d', 'v-d', { status: 'off_road' }), vehicle('v-d', 'DD11DDD'))], ENV).excluded[0]!.reasons[0]!.code).toBe('UNIT_OFF_ROAD');
    // off road but back before the start (a readiness estimate) is offered
    const back = snap(unit('u-d', 'v-d', { status: 'off_road' }), vehicle('v-d', 'DD11DDD'), { readiness: [task({ fleetUnitId: 'u-d', kind: 'service', readyByAt: '2026-10-12T17:00:00.000Z' })] });
    expect(searchAvailability(query(), [back], ENV).ranked).toHaveLength(1);
  });

  it('the claim own hold is ignored when re-searching; a touching booking does not exclude', () => {
    const own = reservation({ id: 'own', claimId: 'claim-x', startAt: '2026-10-13T09:00:00.000Z' });
    expect(searchAvailability(query({ excludeReservationIds: ['own'] }), [snap(A.unit, A.vehicle, { reservations: [own] })], ENV).ranked).toHaveLength(1);
    const before = reservation({ id: 'before', claimId: 'claim-x', startAt: '2026-10-01T09:00:00.000Z', expectedEndAt: '2026-10-13T09:00:00.000Z' });
    const r = searchAvailability(query(), [snap(A.unit, A.vehicle, { reservations: [before] })], ENV);
    expect(r.ranked).toHaveLength(1);
    expect(r.ranked[0]!.warnings.map((w) => w.code)).toContain('TURNAROUND_SHORT');
  });

  it('a refer keeps the car with a warning and is never green; unknown is never green', () => {
    const refer = searchAvailability(query(), [A], { ...ENV, assessDriver: assessAs('refer') });
    expect(refer.ranked).toHaveLength(1);
    expect(refer.ranked[0]!.driverOutcome).toBe('refer');
    expect(refer.ranked[0]!.warnings.map((w) => w.code)).toContain('DRIVER_REFERRAL');
    expect(refer.green).toBe(false);
    expect(searchAvailability(query(), [A], { ...ENV, assessDriver: assessAs('unknown') }).green).toBe(false);
  });

  it('weights are normalised; ties go to the earlier readyBy, then lower mileage, then registration', () => {
    expect(Object.values(normaliseWeights({ likeForLike: 70, needsFit: 30, readiness: 30, compliance: 20, cost: 40, location: 10 })).reduce((a, b) => a + b, 0)).toBeCloseTo(100);
    const twin = (id: string, reg: string, mileage?: number) => snap(unit(id, `v-${id}`, mileage === undefined ? {} : { currentMileage: mileage }), vehicle(`v-${id}`, reg));
    const r = searchAvailability(query(), [twin('z', 'ZZ11ZZZ', 5000), twin('y', 'YY11YYY', 9000), twin('x', 'XX11XXX')], ENV);
    expect(r.ranked.map((c) => c.registration)).toEqual(['ZZ11 ZZZ', 'YY11 YYY', 'XX11 XXX']);
    expect(r.clearWinner).toBe(false); // identical scores
    const sameMiles = searchAvailability(query(), [twin('b', 'BB11BBB', 100), twin('a', 'AA11AAA', 100)], ENV);
    expect(sameMiles.ranked.map((c) => c.registration)).toEqual(['AA11 AAA', 'BB11 BBB']);
    // a car ready later loses the tie
    const later = snap(unit('l', 'v-l', { currentMileage: 1 }), vehicle('v-l', 'LL11LLL'), { readiness: [task({ fleetUnitId: 'l', readyByAt: '2026-10-12T10:00:00.000Z' })] });
    const ready = searchAvailability(query(), [later, twin('n', 'NN11NNN', 99999)], ENV);
    expect(ready.ranked[0]!.registration).toBe('NN11 NNN');
  });

  it('only one car → clear winner; factor scores for cost, compliance and location', () => {
    const near = snap(A.unit, A.vehicle, { location: { id: 'l1', name: 'Depot', address: null, postcode: 'TW7 5NQ', lat: null, lon: null, isDefault: true } });
    const r = searchAvailability(query({ needs: { ...blankHireNeeds(), deliveryPostcode: 'TW7 4AB' } }), [near], ENV);
    expect(r.clearWinner).toBe(true);
    const c = r.ranked[0]!;
    expect(c.factors.location.score).toBe(1);
    expect(c.factors.cost.score).toBe(1); // 5500 ≤ C2 guide 6000
    expect(c.factors.compliance.score).toBe(1);
    expect(c.factors.likeForLike.weight).toBe(35);
    const dear = searchAvailability(query(), [snap(unit('u-a', 'v-a', { dailyRatePence: 6500 }), A.vehicle)], ENV).ranked[0]!;
    expect(dear.factors.cost.score).toBe(0.6);
  });
});

describe('green', () => {
  const candidate = { registration: 'AA11 AAA', driverOutcome: 'eligible' as const, warnings: [], likeForLike: { score: 1, group: { client: 'C2', car: 'C2', relation: 'same' as const, clientRatePence: 1, carRatePence: 1 }, parts: { group: 1, body: 1, seats: 1, transmission: 1, fuel: 1 }, sentence: '' } };
  const ok = { candidate, acceptance: { decision: 'accept', conditionsMet: true }, need: 'strong' as const, interventionUnanswered: false, clientWantsHire: true, clientEmail: { onFile: true, bounced: false }, claimPaused: false, autoOffersToday: 0, maxAutoOffersPerDay: 10 };
  it('all six criteria hold → green', () => {
    expect(greenTest(ok)).toEqual({ green: true, reasons: [] });
  });
  it('each failure gives a reason', () => {
    expect(greenTest({ ...ok, candidate: { ...candidate, likeForLike: { ...candidate.likeForLike, score: 0.7 } } }).reasons[0]).toContain('below 0.80');
    expect(greenTest({ ...ok, acceptance: { decision: 'accept_with_conditions', conditionsMet: false } }).green).toBe(false);
    expect(greenTest({ ...ok, acceptance: { decision: 'accept_with_conditions', conditionsMet: true } }).green).toBe(true);
    expect(greenTest({ ...ok, need: 'weak' }).green).toBe(false);
    expect(greenTest({ ...ok, interventionUnanswered: true }).green).toBe(false);
    expect(greenTest({ ...ok, clientWantsHire: null }).green).toBe(false);
    expect(greenTest({ ...ok, clientEmail: { onFile: true, bounced: true } }).green).toBe(false);
    expect(greenTest({ ...ok, claimPaused: true }).green).toBe(false);
    expect(greenTest({ ...ok, autoOffersToday: 10 }).green).toBe(false);
    expect(greenTest({ ...ok, candidate: null }).green).toBe(false);
  });
  it('a green-blocking warn stops green unless acknowledged; a plain warn does not', () => {
    const warn = { code: 'MOT_LAPSES_IN_PERIOD' as const, severity: 'warn' as const, overrideClass: 'B' as const, message: 'MOT lapses', related: { claimIds: [], reservationIds: [], hireIds: [], fleetUnitIds: [], partyIds: [] }, dedupeKey: 'k1' };
    expect(candidateGreen({ ...candidate, warnings: [warn] }).green).toBe(false);
    expect(candidateGreen({ ...candidate, warnings: [warn] }, { acknowledged: ['k1'] }).green).toBe(true);
    expect(candidateGreen({ ...candidate, warnings: [{ ...warn, code: 'TAX_LAPSES_IN_PERIOD' }] }).green).toBe(true);
  });
});

describe('projectHirePeriod', () => {
  const settings = { projection: DEFAULT_AUTOPILOT_SETTINGS.projection, booking: DEFAULT_AUTOPILOT_SETTINGS.booking };
  it('needed-from start; default 14 days', () => {
    const p = projectHirePeriod({}, { neededFrom: '2026-10-14T09:00:00.000Z' }, null, settings, NOW);
    expect(p.startAt).toBe('2026-10-14T09:00:00.000Z');
    expect(p.startBasis).toBe('needed_from');
    expect(p.endBasis).toBe('default');
    expect(Math.round((ms(p.expectedEndAt) - ms(p.startAt)) / 86_400_000)).toBe(14);
  });
  it('not driveable → next delivery slot (Monday 10:00 London when asked at 09:00); driveable → repair start or next business day', () => {
    const p = projectHirePeriod({}, null, { driveable: false, repairStartAt: null }, settings, NOW);
    expect(p.startAt).toBe('2026-10-12T09:00:00.000Z'); // 10:00 BST, first 2-hour grid window after 09:00
    const d = projectHirePeriod({}, null, { driveable: true, repairStartAt: '2026-10-20T08:00:00.000Z' }, settings, NOW);
    expect(d.startAt).toBe('2026-10-20T08:00:00.000Z');
    expect(projectHirePeriod({}, null, { driveable: true, repairStartAt: null }, settings, NOW).startAt).toBe('2026-10-13T08:00:00.000Z');
  });
  it('report repair days + 2 WD parts buffer; total loss 21 days; acceptance projection', () => {
    const rep = projectHirePeriod({ report: { repairDurationWorkingDays: 5 } }, { neededFrom: '2026-10-12T08:00:00.000Z' }, null, settings, NOW);
    expect(rep.endBasis).toBe('report');
    expect(rep.expectedEndAt).toBe('2026-10-21T08:00:00.000Z'); // Mon + 7 WD = Wed next week
    const tl = projectHirePeriod({ claim: { status: 'total_loss' } }, { neededFrom: '2026-10-12T08:00:00.000Z' }, null, settings, NOW);
    expect(tl.expectedEndAt).toBe('2026-11-02T09:00:00.000Z'); // 21 calendar days, London wall time kept across the clock change
    const acc = projectHirePeriod({ acceptanceHireDays: 10 }, { neededFrom: '2026-10-12T08:00:00.000Z' }, null, settings, NOW);
    expect(acc.endBasis).toBe('acceptance');
  });
});

describe('proposeSlots', () => {
  const base = { businessHours: DEFAULT_BUSINESS_HOURS, windowMinutes: 120, leadMinutes: 120, existing: [] as Movement[], maxPerWindow: 2 };
  it('2-hour windows inside business hours, after the lead time and the ready time', () => {
    const slots = proposeSlots({ ...base, earliest: NOW, readyBy: NOW }, 3);
    // Monday 09:00 London + 2 h lead = 11:00 → first grid window 12:00–14:00 London (11:00Z)
    expect(slots[0]).toEqual({ windowStart: '2026-10-12T11:00:00.000Z', windowEnd: '2026-10-12T13:00:00.000Z' });
    expect(slots).toHaveLength(3);
    const late = proposeSlots({ ...base, earliest: NOW, readyBy: '2026-10-12T15:30:00.000Z' }, 1);
    expect(late[0]!.windowStart).toBe('2026-10-13T07:00:00.000Z'); // next morning 08:00 London
  });
  it('skips Sundays and bank holidays', () => {
    const sat = '2026-12-26T15:00:00.000Z'; // Saturday 26 Dec (Boxing Day; substitute bank holiday Mon 28 Dec)
    const s = proposeSlots({ ...base, earliest: sat, readyBy: sat, leadMinutes: 0 }, 1)[0]!;
    expect(s.windowStart).toBe('2026-12-29T08:00:00.000Z'); // Tue 29 Dec 08:00 GMT
  });
  it('capacity: a window with maxPerWindow movements is skipped', () => {
    const mv = (id: string): Movement => ({ id, reservationId: 'r', claimId: 'c', fleetUnitId: 'u', kind: 'delivery', windowStart: '2026-10-12T11:00:00.000Z', windowEnd: '2026-10-12T13:00:00.000Z', address: null, postcode: null, assignedTo: null, status: 'planned', evidenceIds: [] });
    const s = proposeSlots({ ...base, earliest: NOW, readyBy: NOW, existing: [mv('1'), mv('2')] }, 1)[0]!;
    expect(s.windowStart).toBe('2026-10-12T13:00:00.000Z');
  });
  it('preferred part of day and date come first', () => {
    const s = proposeSlots({ ...base, earliest: NOW, readyBy: NOW, preferred: { date: '2026-10-13', part: 'afternoon' } }, 2);
    expect(s.map((x) => x.windowStart)).toEqual(['2026-10-13T11:00:00.000Z', '2026-10-13T13:00:00.000Z']);
    const morning = proposeSlots({ ...base, earliest: NOW, readyBy: NOW, preferred: { date: null, part: 'morning' } }, 1);
    expect(morning[0]!.windowStart).toBe('2026-10-13T07:00:00.000Z');
  });
});
