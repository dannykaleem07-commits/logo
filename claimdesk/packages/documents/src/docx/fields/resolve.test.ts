import { describe, expect, it } from 'vitest';
import { FIELD_DEFS } from './dictionary.js';
import { resolveField } from './resolve.js';
import { sampleMergeSource, type MergeSource } from './source.js';
import type { FieldValue } from './types.js';

const src = sampleMergeSource();
const r = (key: string, s: MergeSource = src): FieldValue | undefined => resolveField(key, s);
const v = (key: string, s: MergeSource = src): unknown => r(key, s)?.v;

describe('resolveField — rich sample (CCG-2026-00012)', () => {
  it('claim, client and company', () => {
    expect(r('claim.reference')).toEqual({ t: 'text', v: 'CCG-2026-00012' });
    expect(v('claimant.name')).toBe('Priya Patel');
    expect(v('claimant.fullName')).toBe('Priya Patel');
    expect(v('claimant.initialsSurname')).toBe('P. Patel');
    expect(r('claimant.dateOfBirth')).toEqual({ t: 'date', v: '1988-04-17' });
    expect(v('claimant.address')).toBe('12 High Street, Hounslow TW3 1AB');
    expect(v('claimant.addressNoPostcode')).toBe('12 High Street, Hounslow');
    expect(v('claimant.postcode')).toBe('TW3 1AB');
    expect(v('claimant.drivingLicenceNumber')).toBe('PATEL804178P99AB');
    expect(r('claimant.photoIdVerified')).toEqual({ t: 'bool', v: true });
    expect(v('company.registeredName')).toBe('Courtesy Cars Group UK Ltd');
    expect(v('company.number')).toBe('17430389');
    expect(v('handler.contact')).toBe('07425 475922 · claims@courtesycars.net');
    expect(r('company.bank.sortCode')).toBeUndefined(); // never invented
    expect(r('company.vatNumber')).toBeUndefined();
  });

  it('dates come from src.now in Europe/London', () => {
    expect(r('doc.date')).toEqual({ t: 'date', v: '2026-10-04' });
    const late = { ...sampleMergeSource(), now: '2026-10-04T23:30:00Z' }; // 00:30 BST on 5 October
    expect(r('doc.date', late)).toEqual({ t: 'date', v: '2026-10-05' });
    expect(r('accident.date')).toEqual({ t: 'date', v: '2026-08-09' });
    expect(r('accident.time')).toEqual({ t: 'time', v: '14:30' });
    expect(v('accident.dateTimeApprox')).toBe('9 August 2026, about 14:30');
    expect(r('claim.firstInstructedAt')).toEqual({ t: 'date', v: '2026-08-10' });
    expect(r('claim.retrospectiveAppointment')).toEqual({ t: 'bool', v: true });
    expect(r('claim.liability')).toEqual({ t: 'choice', v: ['admitted'] });
    expect(r('claim.liabilityDate')).toEqual({ t: 'date', v: '2026-08-20' });
    expect(r('claim.clientAuthoritySigned')).toEqual({ t: 'bool', v: true });
    expect(r('claim.clientAuthoritySignedOn')).toEqual({ t: 'date', v: '2026-08-10' });
  });

  it('client vehicle', () => {
    expect(v('vehicle.registration')).toBe('AB12 CDE');
    expect(v('vehicle.makeModel')).toBe('Volkswagen Golf Life 1.5 TSI');
    expect(v('vehicle.makeModelReg')).toBe('Volkswagen Golf Life 1.5 TSI — AB12 CDE');
    expect(v('vehicle.colour')).toBe('Blue');
    expect(r('vehicle.fuelType')).toEqual({ t: 'choice', v: ['petrol'] });
    expect(r('vehicle.transmission')).toEqual({ t: 'choice', v: ['manual'] });
    expect(v('vehicle.engineFuel')).toBe('1,498cc petrol');
    expect(r('vehicle.firstRegistered')).toEqual({ t: 'date', v: '2019-03', precision: 'month' });
    expect(r('vehicle.mileageAtAccident')).toEqual({ t: 'int', v: 45390, unit: 'miles' }); // accident_report on the day, not the later engineer reading
    expect(v('vehicle.yearMileage')).toBe('2019 / 45,390 miles');
    expect(v('vehicle.classDescription')).toBe('Group M hatchback');
    expect(r('vehicle.registeredKeeper')).toEqual({ t: 'choice', v: ['client'] });
    expect(v('vehicle.registeredKeeperName')).toBe('Priya Patel');
    expect(v('vehicle.panelsDamaged')).toBe('Rear bumper, boot lid and rear panel');
  });

  it('third party, witness and insurers', () => {
    expect(v('tp.driverName')).toBe('Mark Jones');
    expect(v('tp.driverAddress')).toBe('8 Station Road, Feltham TW13 4AA');
    expect(v('tp.vehicleRegistration')).toBe('CD34 EFG');
    expect(v('tp.vehicleMakeModelColour')).toBe('Ford Focus, Silver');
    expect(v('tp.policyNumber')).toBe('TPX-445566');
    expect(v('tpInsurer.name')).toBe('Example Insurance plc');
    expect(v('tpInsurer.claimRef')).toBe('EXI/778/2026');
    expect(r('tpInsurer.firstContactedOn')).toEqual({ t: 'date', v: '2026-08-10' });
    expect(v('ownInsurer.namePolicy')).toBe('Northern Example Insurance Ltd / POL-778812');
    expect(r('ownInsurer.claimRef')).toBeUndefined(); // handler only, never the policy number
    expect(r('accident.witnesses')).toEqual({ t: 'rows', v: [{ name: 'Sarah Lee', contact: '07700 900789' }] });
    expect(v('accident.accountTakenBy')).toBe('D. Kaleem');
    expect(r('accident.cctv.council.requestSentOn')).toEqual({ t: 'date', v: '2026-08-10' });
    expect(r('accident.cctv.doorbell.requestSentOn')).toBeUndefined();
    expect(v('witness.statementNumber')).toBe('1st');
    expect(v('witness.exhibitRefsList')).toBe('SL1');
    expect(r('witness.exhibits[0].capturedAt')).toEqual({ t: 'datetime', v: '2026-08-09T14:05:00+01:00' });
    expect(r('witness.relationshipToClaimant')).toBeUndefined(); // handler only, never assumed from notes
  });

  it('open hire with fleet unit, vehicle and a credit-hire policy', () => {
    expect(v('hire.agreementNumber')).toBe('CCG-H-000123');
    expect(r('hire.dailyRatePence')).toEqual({ t: 'money', v: 8900 });
    expect(v('hire.gtaGroup')).toBe('N');
    expect(r('hire.endDate')).toBeUndefined();
    expect(r('hire.returnedAt')).toBeUndefined();
    expect(r('hire.milesCovered')).toBeUndefined();
    expect(r('hire.releasedAt')).toEqual({ t: 'datetime', v: '2026-08-11T10:15:00Z' });
    expect(r('hire.collectionMethod')).toEqual({ t: 'choice', v: ['delivered'] });
    expect(r('hire.insuranceBasis')).toEqual({ t: 'choice', v: ['ccguk_arranged'] });
    expect(r('hire.cancellationInfoGiven')).toEqual({ t: 'choice', v: ['yes'] });
    expect(v('hireVehicle.registration')).toBe('EF56 GHK');
    expect(v('hireVehicle.insurerName')).toBe('Fleet Example Insurance Ltd');
    expect(r('hireVehicle.transmission')).toEqual({ t: 'choice', v: ['automatic'] });
    expect(v('hire.conditionReportRef')).toBe('Vehicle Handover & Condition Report d-06abcd');
    expect(r('hire.release.photoCount')).toEqual({ t: 'int', v: 2 });
    expect(r('hire.return.photoCount')).toBeUndefined();
  });

  it('GTA money carries its verification status', () => {
    expect(r('hire.gta.ownClassRatePence')).toEqual({ t: 'money', v: 6512, verification: 'verified' });
    expect(r('hire.gta.replacementClassRatePence')).toEqual({ t: 'money', v: 7120, verification: 'unverified' });
  });

  it('closed storage, recovery, engineer, payment', () => {
    expect(r('storage.endDate')).toEqual({ t: 'date', v: '2026-08-24' });
    expect(r('storage.days')).toEqual({ t: 'int', v: 15, unit: 'days' });
    expect(r('storage.netPence')).toEqual({ t: 'money', v: 67500 });
    expect(r('storage.facility')).toEqual({ t: 'choice', v: ['other'] });
    expect(r('storage.odometerOnEntry')).toEqual({ t: 'int', v: 45395, unit: 'miles' });
    expect(v('storage.currentLocation')).toBe('Secure compound, Unit 4, Silverdale Road, Hayes UB3 3BN'); // closed storage → latest recovery destination
    expect((r('storage.log')?.v as unknown[]).length).toBe(2);
    expect(r('recovery.netPence')).toEqual({ t: 'money', v: 15100 });
    expect(v('recovery.basisText')).toBe('£90 + 12 mi × £3 + £25');
    expect(v('recovery.agentName')).toBe('Courtesy Cars Group UK Ltd');
    expect(v('recovery.invoiceRef')).toBe('INV-REC-0012');
    expect(r('engineer.decision')).toEqual({ t: 'choice', v: ['repairable'] });
    expect(r('engineer.salvageCategory')).toEqual({ t: 'choice', v: ['na'] });
    expect(r('engineer.repairCostPence')).toEqual({ t: 'money', v: 245000 });
    expect(r('engineer.pavPence')).toEqual({ t: 'money', v: 1150000 });
    expect(r('engineer.reportSentToClientDate')).toEqual({ t: 'date', v: '2026-08-16' });
    expect(r('engineer.reportSentToInsurerDate')).toEqual({ t: 'date', v: '2026-08-17' });
    expect(r('payment.totalPence')).toEqual({ t: 'money', v: 15100 + 67500 + 28500 });
    expect(r('payment.directs.hire')).toEqual({ t: 'bool', v: true });
    expect(r('payment.directs.pav')).toBeUndefined();
  });

  it('two offers: the subject offer is used; reasons verbatim; chronology from quotes only', () => {
    expect(r('intervention.offerMade')).toEqual({ t: 'bool', v: true });
    expect(r('intervention.noOfferMade')).toBeUndefined();
    expect(r('intervention.channel')).toEqual({ t: 'choice', v: ['telephone'] });
    expect(v('intervention.offerorOrganisation')).toBe('Example Insurance plc');
    expect(r('intervention.clientDecision')).toEqual({ t: 'choice', v: ['declined'] });
    expect(v('intervention.clientReasons')).toBe('I work early shifts and cannot get to the depot 30 miles away.');
    expect(v('intervention.terms.mileageLimit')).toBe('100 miles per day');
    expect(r('intervention.chronology')).toEqual({ t: 'rows', v: [{ date: '18/08/2026', who: 'Example Insurance plc', text: '"We will not pay hire beyond 14 days."', daysLost: '' }] });
    const viaClient = { ...sampleMergeSource() };
    viaClient.offer = viaClient.offers[1];
    expect(r('intervention.channel', viaClient)).toBeUndefined();
    expect(r('intervention.madeTo', viaClient)).toEqual({ t: 'choice', v: ['client'] });
    expect(r('intervention.clientDecision', viaClient)).toBeUndefined(); // pending → none
  });

  it('clocks, recipient', () => {
    expect(r('clocks.chaser1.dueDate')).toEqual({ t: 'date', v: '2026-08-17' });
    expect(r('clocks.limitation.dueDate')).toEqual({ t: 'date', v: '2032-08-09' });
    expect(v('recipient.townPostcode')).toBe('Example Town EX1 1AA');
    expect(r('recipient.addressLines')).toEqual({ t: 'list', v: ['Claims Department', '1 Example Way'] });
    expect(v('recipient.salutation')).toBe('Sir or Madam');
    expect(v('doc.valediction')).toBe('faithfully');
  });

  it('never produces a stand-in value: no "unknown", "n/a", zero amounts or empty strings', () => {
    const empty = sampleMergeSource();
    empty.hire = undefined;
    empty.hires = [];
    empty.storage = [];
    empty.recovery = [];
    delete empty.report;
    delete empty.estimate;
    delete empty.pav;
    empty.offers = [];
    delete empty.offer;
    empty.events = [];
    empty.evidence = [];
    empty.documents = [];
    empty.clocks = [];
    empty.ledger = [];
    empty.heads = [];
    for (const s of [src, empty]) {
      for (const d of FIELD_DEFS) {
        const val = resolveField(d.key, s);
        if (!val) continue;
        if (val.t === 'text') {
          expect(val.v.trim(), d.key).not.toBe('');
          expect(/^(unknown|n\/a|not stated)$/i.test(val.v), d.key).toBe(false);
        }
      }
    }
    for (const k of ['storage.days', 'storage.netPence', 'hire.dailyRatePence', 'recovery.netPence', 'payment.totalPence', 'hire.release.photoCount', 'evidence.photoCount']) expect(resolveField(k, empty), k).toBeUndefined();
  });
});

describe('resolveField — variants', () => {
  it('open storage → no end date, days, release time or net charge, and no total', () => {
    const s = sampleMergeSource();
    s.storage = [{ ...s.storage[0]!, endAt: undefined, endTrigger: undefined }];
    for (const k of ['storage.endDate', 'storage.releasedAt', 'storage.days', 'storage.netPence', 'payment.totalPence']) expect(resolveField(k, s), k).toBeUndefined();
    expect(resolveField('storage.startDate', s)).toEqual({ t: 'date', v: '2026-08-10' });
    expect(resolveField('storage.currentLocation', s)?.v).toBe('Secure compound, Unit 4, Silverdale Road, Hayes UB3 3BN');
  });

  it('a later odometer reading is ignored; no reading on/before the accident → undefined', () => {
    const s = sampleMergeSource();
    s.vehicle = { ...s.vehicle, odometer: [{ source: 'engineer', date: '2026-08-14', miles: 45402 }] };
    expect(resolveField('vehicle.mileageAtAccident', s)).toBeUndefined();
    expect(resolveField('vehicle.yearMileage', s)?.v).toBe('2019');
    s.vehicle = { ...s.vehicle, odometer: [{ source: 'mot', date: '2026-03-01', miles: 41000 }, { source: 'engineer', date: '2026-08-14', miles: 45402 }] };
    expect(resolveField('vehicle.mileageAtAccident', s)?.v).toBe(41000);
  });

  it('liability split → undefined; denied → disputed; unknown → awaited', () => {
    const s = sampleMergeSource();
    s.claim = { ...s.claim, liability: 'split' };
    expect(resolveField('claim.liability', s)).toBeUndefined();
    s.claim = { ...s.claim, liability: 'denied' };
    expect(resolveField('claim.liability', s)).toEqual({ t: 'choice', v: ['disputed'] });
    s.claim = { ...s.claim, liability: 'unknown' };
    expect(resolveField('claim.liability', s)).toEqual({ t: 'choice', v: ['awaited'] });
  });

  it('photoIdVerified is never false', () => {
    const s = sampleMergeSource();
    s.evidence = s.evidence.map((e) => (e.kind === 'licence' ? { ...e, verification: { status: 'unverified' as const } } : e));
    expect(resolveField('claimant.photoIdVerified', s)).toBeUndefined();
    s.evidence = [];
    expect(resolveField('claimant.photoIdVerified', s)).toBeUndefined();
  });

  it('tp.driverName ignores witnesses', () => {
    const s = sampleMergeSource();
    s.thirdPartyDrivers = [s.witnesses[0]!, ...s.thirdPartyDrivers];
    expect(resolveField('tp.driverName', s)?.v).toBe('Mark Jones');
    s.thirdPartyDrivers = [s.witnesses[0]!];
    expect(resolveField('tp.driverName', s)).toBeUndefined();
  });

  it('closed hire gives end and return; a future start is not "released"', () => {
    const s = sampleMergeSource();
    const agreement = { ...s.hire!.agreement, endAt: '2026-08-30T16:00:00Z', collectedAt: '2026-08-30T17:00:00Z', odometerIn: 13034 };
    s.hire = { ...s.hire!, agreement };
    expect(resolveField('hire.endDate', s)).toEqual({ t: 'date', v: '2026-08-30' });
    expect(resolveField('hire.returnedAt', s)).toEqual({ t: 'datetime', v: '2026-08-30T17:00:00Z' });
    expect(resolveField('hire.milesCovered', s)).toEqual({ t: 'int', v: 1000, unit: 'miles' });
    const future = sampleMergeSource();
    future.hire = { ...future.hire!, agreement: { ...future.hire!.agreement, startAt: '2026-10-10T09:00:00Z', deliveredAt: undefined } };
    expect(resolveField('hire.releasedAt', future)).toBeUndefined();
  });

  it('GTA rate lookup misses → undefined (never a stale period)', () => {
    const s = sampleMergeSource();
    s.gtaRates = [];
    expect(resolveField('hire.gta.ownClassRatePence', s)).toBeUndefined();
  });

  it('handler fields never resolve', () => {
    for (const d of FIELD_DEFS.filter((x) => x.policy === 'handler')) expect(resolveField(d.key, src), d.key).toBeUndefined();
  });
});
