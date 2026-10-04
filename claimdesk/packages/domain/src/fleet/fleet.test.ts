import { describe, it, expect } from 'vitest';
import { complianceAlerts, phvEligibility, canAllocate, penaltyTransition, allowedPenaltyActions, liabilityTransferParticulars, s172ResponseData, TFL_ZEC_RULE, S172_DILIGENCE_CHECKLIST } from './index.js';
import { fleetUnit, fleetVehicle, policy, penalty, hire, party } from '../playbook/fixture.js';
import type { ComplianceAlert } from '../types.js';

const NOW = '2026-10-04T12:00:00+01:00';
const codes = (alerts: ComplianceAlert[]): string[] => alerts.map((a) => a.code);
const hirer = () =>
  party('p-claimant', 'Amir Hussain', { dateOfBirth: '1988-04-12', drivingLicenceNumber: 'HUSSA804128AH9IJ', address: { line1: '14 Barking Road', town: 'London', postcode: 'E6 3BP' } });

describe('complianceAlerts', () => {
  it('a compliant unit raises nothing; a disposed unit is skipped', () => {
    expect(complianceAlerts([{ unit: fleetUnit(), vehicle: fleetVehicle(), policy: policy() }], NOW)).toEqual([]);
    expect(complianceAlerts([{ unit: fleetUnit({ status: 'disposed', keeperAddressCurrent: false }), vehicle: fleetVehicle({ motExpiryDate: '2020-01-01' }), policy: undefined }], NOW)).toEqual([]);
  });

  it('MOT and tax: expired blocks, due within warnDays warns, SORN blocks, unknown is info', () => {
    const run = (v: Parameters<typeof fleetVehicle>[0], warnDays?: number) => complianceAlerts([{ unit: fleetUnit(), vehicle: fleetVehicle(v), policy: policy() }], NOW, warnDays ? { warnDays } : {});
    expect(run({ motExpiryDate: '2026-10-01' })[0]!).toMatchObject({ code: 'MOT_EXPIRED', severity: 'block', dueDate: '2026-10-01' });
    expect(run({ motExpiryDate: '2026-10-20' })[0]).toMatchObject({ code: 'MOT_DUE', severity: 'warn', dueDate: '2026-10-20' });
    expect(run({ motExpiryDate: '2026-10-20' }, 10)).toEqual([]); // 16 days away, 10-day window
    expect(run({ motExpiryDate: undefined, motStatus: 'Not valid' })[0]).toMatchObject({ code: 'MOT_EXPIRED', severity: 'block' });
    expect(run({ motExpiryDate: undefined, motStatus: undefined })[0]).toMatchObject({ code: 'MOT_DUE', severity: 'info' });
    expect(run({ taxStatus: 'SORN' })[0]).toMatchObject({ code: 'TAX_EXPIRED', severity: 'block' });
    expect(run({ taxDueDate: '2026-09-30' })[0]).toMatchObject({ code: 'TAX_EXPIRED', severity: 'block', dueDate: '2026-09-30' });
    expect(run({ taxDueDate: '2026-11-01' })[0]).toMatchObject({ code: 'TAX_DUE', severity: 'warn' });
  });

  it('insurance: missing, expired, not yet in force block; renewal within the window warns and cites the Insurance Act 2015', () => {
    const run = (p: ReturnType<typeof policy> | undefined) => complianceAlerts([{ unit: fleetUnit(), vehicle: fleetVehicle(), policy: p }], NOW);
    expect(run(undefined)[0]).toMatchObject({ code: 'INSURANCE_EXPIRED', severity: 'block' });
    expect(run(policy({ endDate: '2026-09-30' }))[0]).toMatchObject({ code: 'INSURANCE_EXPIRED', severity: 'block', dueDate: '2026-09-30' });
    expect(run(policy({ startDate: '2026-11-01' }))[0]!.message).toContain('not in force until 2026-11-01');
    const due = run(policy({ endDate: '2026-10-20' }))[0]!;
    expect(due).toMatchObject({ code: 'INSURANCE_DUE', severity: 'warn', dueDate: '2026-10-20' });
    expect(due.message).toContain('Insurance Act 2015');
  });

  it('USE_NOT_COVERED when the declared uses are not all covered by the policy (Collingwood: policy per use)', () => {
    const alerts = complianceAlerts([{ unit: fleetUnit({ declaredUses: ['credit_hire', 'self_drive'] }), vehicle: fleetVehicle(), policy: policy() }], NOW);
    expect(codes(alerts)).toEqual(['USE_NOT_COVERED']);
    expect(alerts[0]!.severity).toBe('block');
    expect(alerts[0]!.message).toContain('self_drive');
    expect(alerts[0]!.message).toContain('Collingwood');
  });

  it('service, keeper address and penalty deadlines', () => {
    const overdue = complianceAlerts([{ unit: fleetUnit({ serviceDueDate: '2026-09-01' }), vehicle: fleetVehicle(), policy: policy() }], NOW);
    expect(overdue[0]).toMatchObject({ code: 'SERVICE_DUE', severity: 'warn', dueDate: '2026-09-01' });
    expect(complianceAlerts([{ unit: fleetUnit({ serviceDueDate: '2026-10-20' }), vehicle: fleetVehicle(), policy: policy() }], NOW)[0]!.severity).toBe('info');
    const stale = complianceAlerts([{ unit: fleetUnit({ keeperAddressCurrent: false }), vehicle: fleetVehicle(), policy: policy() }], NOW);
    expect(stale[0]).toMatchObject({ code: 'KEEPER_ADDRESS_STALE', severity: 'warn' });
    expect(stale[0]!.message).toContain('Unit 4, Thames Road, IG11 0HZ');
    expect(stale[0]!.message).toContain('RENTX');
    const pen = complianceAlerts([{ unit: fleetUnit(), vehicle: fleetVehicle(), policy: policy() }], NOW, { penalties: [penalty()] });
    expect(pen.map((a) => [a.code, a.severity, a.dueDate])).toEqual([
      ['PENALTY_DEADLINE', 'warn', '2026-10-28'],
      ['PENALTY_DEADLINE', 'info', '2026-10-14'],
    ]);
    const late = complianceAlerts([{ unit: fleetUnit(), vehicle: fleetVehicle(), policy: policy() }], '2026-11-01T09:00:00+00:00', { penalties: [penalty()] });
    expect(late[0]).toMatchObject({ code: 'PENALTY_DEADLINE', severity: 'block' });
    expect(late[0]!.message).toContain('TE7/TE9');
    expect(complianceAlerts([{ unit: fleetUnit(), vehicle: fleetVehicle(), policy: policy() }], NOW, { penalties: [penalty({ stage: 'paid' })] })).toEqual([]);
  });

  it('PHV eligibility encodes the TfL ZEC rule as unverified data: neither current CCGUK unit qualifies', () => {
    expect(TFL_ZEC_RULE.verification.status).toBe('unverified');
    expect(TFL_ZEC_RULE.options).toEqual([
      { maxCo2Gkm: 50, minZeroEmissionRangeMiles: 10 },
      { maxCo2Gkm: 75, minZeroEmissionRangeMiles: 20 },
    ]);
    const petrolGolf = complianceAlerts([{ unit: fleetUnit({ phvLicensed: true }), vehicle: fleetVehicle(), policy: policy() }], NOW);
    expect(petrolGolf[0]).toMatchObject({ code: 'PHV_NOT_ELIGIBLE', severity: 'block' });
    expect(petrolGolf[0]!.message).toContain('exceeds the 75 g/km ceiling');
    expect(petrolGolf[0]!.message).toContain('verification: unverified');
    // not PHV-requested: no alert at all
    expect(complianceAlerts([{ unit: fleetUnit(), vehicle: fleetVehicle(), policy: policy() }], NOW)).toEqual([]);
    // pco declared use triggers the check too; plug-in hybrid at 40 g/km with unknown range is a warning
    const phev = complianceAlerts([{ unit: fleetUnit({ declaredUses: ['credit_hire', 'pco'] }), vehicle: fleetVehicle({ fuelType: 'plugin_hybrid', co2Gkm: 40 }), policy: policy({ coveredUses: ['credit_hire', 'pco'] }) }], NOW);
    expect(phev[0]).toMatchObject({ code: 'PHV_NOT_ELIGIBLE', severity: 'warn' });
    expect(phev[0]!.message).toContain('≥ 10 miles zero-emission range');
    // with the range known it is eligible → no alert
    expect(complianceAlerts([{ unit: fleetUnit({ phvLicensed: true }), vehicle: fleetVehicle({ fuelType: 'plugin_hybrid', co2Gkm: 40 }), policy: policy() }], NOW, { zeroEmissionRangeMilesByVehicleId: { 'v-fleet-1': 25 } })).toEqual([]);
  });

  it('phvEligibility branches', () => {
    expect(phvEligibility(fleetVehicle({ fuelType: 'electric', co2Gkm: 0 })).eligible).toBe(true);
    expect(phvEligibility(fleetVehicle({ co2Gkm: undefined })).eligible).toBe('unknown');
    expect(phvEligibility(fleetVehicle({ co2Gkm: 120 })).eligible).toBe(false);
    expect(phvEligibility(fleetVehicle({ fuelType: 'petrol', co2Gkm: 45 })).eligible).toBe(false); // no zero-emission range possible
    expect(phvEligibility(fleetVehicle({ fuelType: 'plugin_hybrid', co2Gkm: 60 }), 15).eligible).toBe(false); // needs ≥ 20 miles at 51–75 g/km
    expect(phvEligibility(fleetVehicle({ fuelType: 'plugin_hybrid', co2Gkm: 60 }), 25).eligible).toBe(true);
    expect(phvEligibility(fleetVehicle({ fuelType: 'plugin_hybrid', co2Gkm: 60, euroStatus: undefined }), 25).eligible).toBe('unknown');
    expect(phvEligibility(fleetVehicle({ fuelType: 'plugin_hybrid', co2Gkm: 60, euroStatus: 'EURO 5' }), 25).eligible).toBe(false);
  });
});

describe('canAllocate', () => {
  it('allows the declared, covered use on an available, roadworthy unit', () => {
    expect(canAllocate(fleetUnit(), 'credit_hire', policy(), NOW, fleetVehicle())).toEqual({ ok: true, reasons: [], warnings: [] });
  });

  it('blocks self_drive on a credit-hire-only policy (Collingwood: one policy per use)', () => {
    const r = canAllocate(fleetUnit({ declaredUses: ['credit_hire', 'self_drive'] }), 'self_drive', policy(), NOW);
    expect(r.ok).toBe(false);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toContain('covers credit_hire only, not "self_drive"');
    expect(r.reasons[0]).toContain('Collingwood');
    // undeclared on the unit as well → two reasons
    expect(canAllocate(fleetUnit(), 'self_drive', policy(), NOW).reasons).toHaveLength(2);
  });

  it('blocks when there is no policy, the policy is out of date, the unit is not available, or MOT / tax has expired', () => {
    expect(canAllocate(fleetUnit(), 'credit_hire', undefined, NOW).reasons).toEqual(['No insurance policy is linked to the unit.']);
    expect(canAllocate(fleetUnit(), 'credit_hire', policy({ endDate: '2026-09-30' }), NOW).reasons[0]).toContain('expired 2026-09-30');
    expect(canAllocate(fleetUnit(), 'credit_hire', policy({ startDate: '2026-11-01' }), NOW).reasons[0]).toContain('not in force until');
    expect(canAllocate(fleetUnit({ status: 'on_hire' }), 'credit_hire', policy(), NOW).reasons).toEqual(['Unit is on hire, not available.']);
    expect(canAllocate(fleetUnit(), 'credit_hire', policy(), NOW, fleetVehicle({ motExpiryDate: '2026-10-01' })).reasons).toEqual(['MOT expired 2026-10-01.']);
    expect(canAllocate(fleetUnit(), 'credit_hire', policy(), NOW, fleetVehicle({ taxStatus: 'Untaxed' })).reasons).toEqual(['Tax status "Untaxed".']);
    expect(canAllocate(fleetUnit(), 'credit_hire', policy(), NOW, fleetVehicle({ taxDueDate: '2026-10-03' })).reasons).toEqual(['Vehicle tax expired 2026-10-03.']);
  });

  it('a stale keeper address and overdue service are warnings, not blocks', () => {
    const r = canAllocate(fleetUnit({ keeperAddressCurrent: false, serviceDueDate: '2026-09-01' }), 'credit_hire', policy(), NOW);
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toContain('old address');
  });
});

describe('penaltyTransition', () => {
  it("rejects 'appeal' before 'representations'", () => {
    const r = penaltyTransition(penalty(), 'appeal');
    expect(r).toMatchObject({ from: 'received', next: 'received', allowed: false });
    expect(r.reason).toContain('make representations first');
    expect(penaltyTransition(penalty({ stage: 'hirer_identified' }), 'appeal').allowed).toBe(false);
    expect(penaltyTransition(penalty({ stage: 'representations' }), 'appeal')).toMatchObject({ next: 'appeal', allowed: true });
    expect(penaltyTransition(penalty({ stage: 'representations' }), 'appeal', { rejectionReceived: false }).allowed).toBe(false);
  });

  it('the happy path: identify hirer → transfer liability → cancelled; a transfer needs a hire agreement first', () => {
    expect(penaltyTransition(penalty(), 'identify_hirer')).toMatchObject({ next: 'hirer_identified', allowed: true });
    expect(penaltyTransition(penalty({ hireAgreementId: undefined }), 'identify_hirer').reason).toContain('No hire agreement');
    expect(penaltyTransition(penalty({ hireAgreementId: undefined }), 'identify_hirer', { hireAgreementId: 'hire-1' }).allowed).toBe(true);
    expect(penaltyTransition(penalty(), 'transfer_liability').reason).toContain('after the hirer is identified');
    expect(penaltyTransition(penalty({ stage: 'hirer_identified' }), 'transfer_liability')).toMatchObject({ next: 'liability_transferred', allowed: true });
    expect(penaltyTransition(penalty({ stage: 'liability_transferred' }), 'cancel').next).toBe('cancelled');
    expect(penaltyTransition(penalty({ stage: 'liability_transferred' }), 'represent').next).toBe('representations');
    expect(penaltyTransition(penalty({ stage: 'hirer_identified' }), 'identify_hirer').allowed).toBe(false);
  });

  it('a s.172 nomination is allowed only when the hire records establish the driver (perimeter)', () => {
    const nip = penalty({ kind: 'nip_s172', stage: 'hirer_identified', issuer: 'Metropolitan Police' });
    const refused = penaltyTransition(nip, 'transfer_liability');
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain('s.172(4)');
    expect(refused.reason).toContain('never a nomination of someone who was not driving');
    expect(penaltyTransition(nip, 'transfer_liability', { driverConfirmedByRecords: false }).allowed).toBe(false);
    expect(penaltyTransition(nip, 'transfer_liability', { driverConfirmedByRecords: true })).toMatchObject({ next: 'liability_transferred', allowed: true });
  });

  it('terminal stages refuse everything; escalated allows TE7/TE9 representations with a warning; late steps warn, never backdate', () => {
    expect(penaltyTransition(penalty({ stage: 'paid' }), 'cancel').allowed).toBe(false);
    expect(penaltyTransition(penalty({ stage: 'cancelled' }), 'pay').reason).toContain('cancelled');
    const esc = penaltyTransition(penalty({ stage: 'escalated' }), 'represent');
    expect(esc).toMatchObject({ next: 'representations', allowed: true });
    expect(esc.warnings[0]).toContain('TE7/TE9');
    expect(penaltyTransition(penalty({ stage: 'escalated' }), 'appeal').allowed).toBe(false);
    const late = penaltyTransition(penalty(), 'represent', { now: '2026-11-01T09:00:00+00:00' });
    expect(late.allowed).toBe(true);
    expect(late.warnings[0]).toContain('2026-10-28 has passed');
    expect(late.warnings[0]).toContain('Perjury Act 1911 s.5');
    const pay = penaltyTransition(penalty(), 'pay', { now: '2026-10-20T09:00:00+01:00' });
    expect(pay.warnings[0]).toContain('discount period ended 2026-10-14');
    expect(penaltyTransition(penalty(), 'pay', { now: '2026-10-10T09:00:00+01:00' }).warnings).toEqual([]);
  });

  it('lists the allowed actions per stage', () => {
    expect(allowedPenaltyActions(penalty())).toEqual(['identify_hirer', 'represent', 'pay', 'cancel', 'escalate']);
    expect(allowedPenaltyActions(penalty({ stage: 'representations' }))).toEqual(['appeal', 'pay', 'cancel', 'escalate']);
    expect(allowedPenaltyActions(penalty({ stage: 'paid' }))).toEqual([]);
  });
});

describe('liabilityTransferParticulars', () => {
  it('a signed hire covering the contravention gives the complete Sch 2 particulars and the statement of liability', () => {
    const r = liabilityTransferParticulars(penalty(), hire(), hirer(), fleetUnit(), fleetVehicle());
    expect(r.complete).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.contraventionWithinHire).toBe(true);
    expect(r.particulars).toMatchObject({
      hirerFullName: 'Amir Hussain',
      hirerPermanentAddress: '14 Barking Road, London, E6 3BP',
      hirerDateOfBirth: '1988-04-12',
      hirerDrivingLicenceNumber: 'HUSSA804128AH9IJ',
      companyHirer: false,
      hireStartAt: '2026-09-22T10:00:00+01:00',
      hireEndAt: '2026-10-02T10:00:00+01:00',
      vehicleRegistration: 'LC21GLF',
      agreementNumber: 'CH-0001',
      noticeNumber: 'NW12345678',
      issuer: 'London Borough of Newham',
      hireFirm: { name: 'Courtesy Cars Group UK Ltd', companyNumber: '17430389' },
    });
    expect(r.statementOfLiability).toContain('I, Amir Hussain, of 14 Barking Road, London, E6 3BP');
    expect(r.statementOfLiability).toContain('Courtesy Cars Group UK Ltd (company 17430389)');
    expect(r.statementOfLiability).toContain('penalty charge notice NW12345678');
    expect(r.statementOfLiability).toContain('Road Traffic (Owner Liability) Regulations 2000');
    expect(r.basis.join(' ')).toContain('Sch 2');
    expect(r.basis.join(' ')).toContain('company hirers excepted');
  });

  it('lists every missing particular: unsigned agreement, no DOB / licence / address, contravention outside the hire, mismatched unit', () => {
    const bare = party('p-x', 'Jo Bloggs');
    const r = liabilityTransferParticulars(penalty({ contraventionAt: '2026-10-10T09:00:00+01:00' }), hire({ signedAt: undefined, fleetUnitId: 'fleet-9' }), bare, fleetUnit(), fleetVehicle());
    expect(r.complete).toBe(false);
    expect(r.contraventionWithinHire).toBe(false);
    expect(r.missing).toEqual([
      'hirer’s permanent address',
      'hirer’s date of birth',
      'hirer’s driving licence number',
      'signed hire agreement (London councils require the hirer’s signature on the agreement with these particulars)',
      'contravention at 2026-10-10T09:00:00+01:00 falls outside the hire period (2026-09-22T10:00:00+01:00 – 2026-10-02T10:00:00+01:00): liability cannot be transferred to this hirer',
      'hire agreement CH-0001 is for fleet unit fleet-9, not fleet-1',
    ]);
  });

  it('company hirers are excepted from date of birth and licence; open-ended hire is noted; NIPs are routed to s.172', () => {
    const co = party('p-co', 'Thames Logistics Ltd', { kind: 'company', companyNumber: '09876543', address: { line1: '1 Dock Road', postcode: 'E16 1AA' } });
    const r = liabilityTransferParticulars(penalty({ kind: 'nip_s172' }), hire({ endAt: undefined, collectedAt: undefined }), co, fleetUnit(), fleetVehicle());
    expect(r.complete).toBe(true);
    expect(r.particulars.companyHirer).toBe(true);
    expect(r.particulars.hirerCompanyNumber).toBe('09876543');
    expect(r.particulars.hireEndAt).toBeUndefined();
    expect(r.statementOfLiability).toContain('for and on behalf of Thames Logistics Ltd, company 09876543');
    expect(r.statementOfLiability).toContain('to continuing');
    expect(r.notes.some((n) => n.startsWith('Company hirer'))).toBe(true);
    expect(r.notes.some((n) => n.includes('continuing'))).toBe(true);
    expect(r.notes.some((n) => n.includes('s172ResponseData'))).toBe(true);
    expect(r.statementOfLiability).not.toContain('parking charge notice');
  });
});

describe('s172ResponseData', () => {
  const nip = (extra: Parameters<typeof penalty>[0] = {}) =>
    penalty({ kind: 'nip_s172', issuer: 'Metropolitan Police', noticeNumber: 'MET/NIP/5566', contraventionAt: '2026-09-25T14:12:00+01:00', receivedAt: '2026-10-01T09:00:00+01:00', responseDeadline: '2026-10-28', ...extra });

  it('sole permitted driver on a covering hire → driver identified from the records, 28-day deadline, NIP served within 14 days', () => {
    const r = s172ResponseData(nip(), hire(), hirer());
    expect(r.route).toBe('driver_identified');
    expect(r.deadline).toBe('2026-10-28');
    expect(r.deadlineBasis).toContain('s.172(7)');
    expect(r.nipServiceDays).toBe(6);
    expect(r.nipServedWithin14Days).toBe(true);
    expect(r.driver).toMatchObject({ name: 'Amir Hussain', address: '14 Barking Road, London, E6 3BP', dateOfBirth: '1988-04-12', drivingLicenceNumber: 'HUSSA804128AH9IJ', partyId: 'p-claimant' });
    expect(r.hireAgreement).toEqual({ agreementNumber: 'CH-0001', startAt: '2026-09-22T10:00:00+01:00', endAt: '2026-10-02T10:00:00+01:00', permittedDrivers: 1 });
    expect(r.missing).toEqual([]);
    expect(r.statement).toContain('identify the driver as Amir Hussain');
    expect(r.statement).toContain('Courtesy Cars Group UK Ltd (company 17430389)');
    expect(r.neverNominate).toContain('perverting the course of justice');
    expect(r.basis.join(' ')).toContain('s.172(4)');
  });

  it('several permitted drivers → the hirer is named as the person in possession (s.172(2)(b)); a driver identified from the records can be named; a stranger is never nominated', () => {
    const h = hire({ additionalDrivers: [{ partyId: 'p-add', evidenceIds: [] }] });
    const r = s172ResponseData(nip(), h, hirer());
    expect(r.route).toBe('hirer_identified');
    expect(r.driver).toBeUndefined();
    expect(r.hireAgreement!.permittedDrivers).toBe(2);
    expect(r.missing[0]).toContain('2 permitted drivers');
    expect(r.statement).toContain('s.172(2)(b)');
    const add = party('p-add', 'Bilal Khan', { address: { line1: '2 Green Street', postcode: 'E7 8JB' }, dateOfBirth: '1990-01-02', drivingLicenceNumber: 'KHAN9001025BK9AB' });
    const named = s172ResponseData(nip(), h, hirer(), { driver: add });
    expect(named.route).toBe('driver_identified');
    expect(named.driver!.name).toBe('Bilal Khan');
    expect(named.basisOfKnowledge).toContain('additional driver');
    expect(named.missing).toEqual([]);
    const stranger = s172ResponseData(nip(), h, hirer(), { driver: party('p-x', 'Someone Else') });
    expect(stranger.route).toBe('hirer_identified');
    expect(stranger.missing[0]).toContain('do not nominate');
  });

  it('no covering hire → the s.172(4) reasonable-diligence checklist, never a name', () => {
    const none = s172ResponseData(nip());
    expect(none.route).toBe('reasonable_diligence');
    expect(none.diligenceChecklist).toEqual(S172_DILIGENCE_CHECKLIST);
    expect(none.diligenceChecklist).toHaveLength(8);
    expect(none.missing).toEqual(['a hire agreement covering the date and time of the offence']);
    expect(none.statement).toContain('s.172(4)');
    expect(none.statement).toContain('does not name any person');
    expect(none.driver).toBeUndefined();
    const after = s172ResponseData(nip({ contraventionAt: '2026-10-10T09:00:00+01:00', receivedAt: '2026-10-12T09:00:00+01:00' }), hire(), hirer(), { recordsChecked: ['hire register', 'key log'] });
    expect(after.route).toBe('reasonable_diligence');
    expect(after.missing[0]).toContain('does not cover 2026-10-10T09:00:00+01:00');
    expect(after.statement).toContain('Having checked hire register, key log');
  });

  it('a NIP received more than 14 days after the offence flags the s.1 RTOA 1988 service check', () => {
    const r = s172ResponseData(nip({ receivedAt: '2026-10-15T09:00:00+01:00' }), hire(), hirer());
    expect(r.nipServiceDays).toBe(20);
    expect(r.nipServedWithin14Days).toBe(false);
    expect(r.missing[0]).toContain('s.1 RTOA 1988');
    expect(r.route).toBe('driver_identified'); // the service point is raised alongside the response, not instead of it
  });
});
