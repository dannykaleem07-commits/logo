/**
 * Live-file archetype "File 1" (BLUEPRINT lessons a, c; §7 point 7): the £1,287-stated / £1,112-received file
 * with the £20.37/day intervention offer, the bank-validation refusal and a GTA payment pack.
 *
 * Numbers used (all from the brief):
 *   hire        £49.80/day  2026-08-10 → 2026-09-02 (23 days)   = £1,145.40
 *   storage     £45/day     2026-08-10 → 2026-08-20 (10 days)   = £450.00
 *   recovery    £90 + £3 × 12 loaded miles + £25 admin          = £151.00
 *   engineer    £285.00
 *   PAV         £6,500.00
 *   offer       £20.37/day on 2026-08-11 (declined, reply sent within 1 WD)
 *   NCAF sent   2026-08-11 · payment pack sent 2026-09-05 · £1,112.00 paid 2026-09-25
 */
import type { Db } from '../client.js';
import { createClaim } from '../repos/claims.js';
import { replaceClocks } from '../repos/clocks.js';
import { approveDocument, createDraft, markDocumentSent } from '../repos/documents.js';
import { createEngineerReport, createPav } from '../repos/engineering.js';
import { appendEvent } from '../repos/events.js';
import { insertEvidence } from '../repos/evidence.js';
import { createFleetUnit } from '../repos/fleet.js';
import { createHire, endHire } from '../repos/hire.js';
import { appendLedgerEntry } from '../repos/ledger.js';
import { createOffer, recordOfferDecision, recordOfferReply } from '../repos/offers.js';
import { createParty } from '../repos/parties.js';
import { createRecovery } from '../repos/recovery.js';
import { createStorage, endStorage } from '../repos/storage.js';
import { createUser } from '../repos/users.js';
import { upsertVehicle } from '../repos/vehicles.js';
import { chargeableDays } from '../util.js';

export const FILE_ONE = {
  hireDailyPence: 4980,
  hireStartAt: '2026-08-10T10:00:00.000Z',
  hireEndAt: '2026-09-02T10:00:00.000Z',
  hireDays: 23,
  hirePence: 23 * 4980, // 114540
  storageDailyPence: 4500,
  storageStartAt: '2026-08-10T12:00:00.000Z',
  storageEndAt: '2026-08-20T12:00:00.000Z',
  storageDays: 10,
  storagePence: 10 * 4500, // 45000
  recoveryCalloutPence: 9000,
  recoveryMiles: 12,
  recoveryPerMilePence: 300,
  recoveryAdminPence: 2500,
  recoveryPence: 9000 + 12 * 300 + 2500, // 15100
  engineerFeePence: 28500,
  pavPence: 650000,
  offerDailyPence: 2037,
  offerReceivedAt: '2026-08-11T09:15:00.000Z',
  ncafSentAt: '2026-08-11T11:30:00.000Z',
  packSentAt: '2026-09-05T15:00:00.000Z',
  paidPence: 111200,
  paidAt: '2026-09-25T00:00:00.000Z',
  statedInLetterPence: 128700, // the wrong figure the old letter asserted
} as const;

export interface FileOneIds {
  handlerId: string;
  approverId: string;
  claimantId: string;
  driverId: string;
  thirdPartyId: string;
  insurerId: string;
  engineerId: string;
  clientVehicleId: string;
  thirdPartyVehicleId: string;
  fleetVehicleId: string;
  fleetUnitId: string;
  claimId: string;
  hireId: string;
  storageId: string;
  recoveryId: string;
  offerId: string;
  pavId: string;
  reportId: string;
  ncafDocumentId: string;
  packDocumentId: string;
  photoEvidenceId: string;
  paidLedgerId: string;
}

/** Seed File 1 into a migrated database. Returns the ids created. */
export function seedFileOne(db: Db): FileOneIds {
  const handler = createUser(db, { name: 'Handler One', email: 'handler@example.test', role: 'handler', mfaEnabled: true });
  const approver = createUser(db, { name: 'Approver One', email: 'approver@example.test', role: 'approver', mfaEnabled: true });

  const claimant = createParty(db, {
    kind: 'individual',
    name: 'Jane Doe',
    dateOfBirth: '1988-04-02',
    address: { line1: '1 Example Street', town: 'London', postcode: 'E1 6AN' },
    email: 'jane.doe@example.test',
    phone: '07700 900123',
    roles: ['claimant', 'driver'],
    createdAt: '2026-08-10T09:00:00.000Z',
  });
  const thirdParty = createParty(db, {
    kind: 'individual',
    name: 'John Smith',
    phone: '07700 900456',
    roles: ['third_party', 'third_party_driver'],
    createdAt: '2026-08-10T09:05:00.000Z',
  });
  const insurer = createParty(db, {
    kind: 'company',
    name: 'Example Insurance Ltd',
    companyNumber: '00000001',
    email: 'thirdparty.claims@example-insurer.test',
    roles: ['insurer'],
    createdAt: '2026-08-10T09:06:00.000Z',
  });
  const engineer = createParty(db, {
    kind: 'individual',
    name: 'I. Engineer',
    roles: ['engineer'],
    createdAt: '2026-08-10T09:07:00.000Z',
  });

  const clientVehicle = upsertVehicle(db, {
    registration: 'AB12 CDE',
    make: 'VOLKSWAGEN',
    model: 'GOLF',
    variant: '1.5 TSI Life',
    yearOfManufacture: 2019,
    fuelType: 'petrol',
    transmission: 'manual',
    colour: 'GREY',
    gtaGroup: 'S1',
    ownership: 'client',
    odometer: [
      { source: 'mot', date: '2026-03-14', miles: 48210 },
      { source: 'accident_report', date: '2026-08-08', miles: 49980 },
    ],
    createdAt: '2026-08-10T09:10:00.000Z',
  });
  const thirdPartyVehicle = upsertVehicle(db, { registration: 'XY34 ZZZ', make: 'FORD', model: 'TRANSIT', ownership: 'third_party', createdAt: '2026-08-10T09:11:00.000Z' });
  const fleetVehicle = upsertVehicle(db, { registration: 'FL33 EET', make: 'VOLKSWAGEN', model: 'GOLF', gtaGroup: 'S1', ownership: 'fleet', createdAt: '2026-01-05T09:00:00.000Z' });
  const fleetUnit = createFleetUnit(db, { vehicleId: fleetVehicle.id, declaredUses: ['credit_hire'], dailyRatePence: FILE_ONE.hireDailyPence, gtaGroup: 'S1', keeperAddressCurrent: true });

  const claim = createClaim(db, {
    openedAt: '2026-08-10T09:30:00.000Z',
    accident: {
      occurredAt: '2026-08-08T14:30:00.000Z',
      location: 'A13 Alfred’s Way, Barking',
      postcode: 'IG11 0AA',
      circumstances: 'Client stationary in traffic; third-party van struck the rear of the client vehicle.',
      policeAttended: false,
      cctvAvailable: true,
      dashcamAvailable: false,
      independentWitness: false,
      injuries: false,
      roadworthyAfter: false,
      driveable: false,
    },
    liability: 'admitted',
    claimantId: claimant.id,
    driverId: claimant.id,
    clientVehicleId: clientVehicle.id,
    thirdPartyIds: [thirdParty.id],
    thirdPartyVehicleId: thirdPartyVehicle.id,
    atFaultInsurerId: insurer.id,
    atFaultInsurerRef: 'EXI/2026/778899',
    handlerId: handler.id,
    status: 'chasing',
  });
  const claimId = claim.id;

  // Chronology (inserted deliberately out of order to prove ordering is by `at`)
  const ev = (type: Parameters<typeof appendEvent>[1]['type'], at: string, summary: string, data?: Record<string, unknown>) =>
    appendEvent(db, { claimId, type, at, summary, data, createdBy: handler.id, attributableTo: 'ccguk' });
  ev('payment_pack_sent', FILE_ONE.packSentAt, 'GTA payment pack sent to Example Insurance Ltd');
  ev('fnol', '2026-08-10T09:30:00.000Z', 'FNOL by phone; recording disclosure given');
  ev('services_agreed', '2026-08-10T09:45:00.000Z', 'Credit hire, recovery and storage agreed');
  ev('recovery', '2026-08-10T11:00:00.000Z', 'Recovered from A13 to CCGUK yard (12 loaded miles)');
  ev('storage_started', FILE_ONE.storageStartAt, 'Storage started at CCGUK yard');
  ev('hire_started', FILE_ONE.hireStartAt, 'Hire started — VW Golf FL33 EET at £49.80/day');
  ev('ncaf_sent', FILE_ONE.ncafSentAt, 'New Claim Advice Form sent (GTA 4.1 — within 1 WD of services agreed)');
  ev('intervention_offer', FILE_ONE.offerReceivedAt, 'Insurer offered a courtesy car at £20.37/day by phone', { dailyRatePence: FILE_ONE.offerDailyPence });
  ev('intervention_reply_sent', '2026-08-12T09:00:00.000Z', 'Written reply to intervention offer sent (within 1 WD)');
  ev('engineer_instructed', '2026-08-12T10:00:00.000Z', 'Independent engineer instructed');
  ev('inspection', '2026-08-14T13:00:00.000Z', 'Physical inspection at CCGUK yard');
  ev('report_issued', '2026-08-18T16:00:00.000Z', 'Engineer’s report issued — total loss, PAV £6,500');
  ev('total_loss_confirmed', '2026-08-18T16:00:00.000Z', 'Total loss confirmed');
  ev('storage_ended', FILE_ONE.storageEndAt, 'Vehicle collected by salvage agent');
  ev('hire_ended', FILE_ONE.hireEndAt, 'Hire ended — replacement purchased');
  ev('payment_received', FILE_ONE.paidAt, '£1,112.00 received from Example Insurance Ltd (remittance EXI-REM-5531)', { amountPence: FILE_ONE.paidPence });

  const hire = createHire(db, {
    claimId,
    fleetUnitId: fleetUnit.id,
    agreementNumber: 'CCG-H-000101',
    startAt: FILE_ONE.hireStartAt,
    dailyRatePence: FILE_ONE.hireDailyPence,
    vatRate: 0.2,
    gtaGroup: 'S1',
    excessPence: 25000,
    deliveredAt: FILE_ONE.hireStartAt,
    odometerOut: 31200,
    signedAt: '2026-08-10T10:05:00.000Z',
    enforceability: {
      cancellationInfoProvidedAt: '2026-08-10T10:05:00.000Z',
      schedule3FormProvidedAt: '2026-08-10T10:05:00.000Z',
      expressRequestToStartAt: '2026-08-10T10:05:00.000Z',
      cca60fCompliant: true,
    },
  });
  endHire(db, hire.id, { endAt: FILE_ONE.hireEndAt, endTrigger: 'replacement_purchased', collectedAt: FILE_ONE.hireEndAt, odometerIn: 31890 });

  const storage = createStorage(db, { claimId, location: 'CCGUK yard', startAt: FILE_ONE.storageStartAt, dailyRatePence: FILE_ONE.storageDailyPence, vatRate: 0.2 });
  endStorage(db, storage.id, { endAt: FILE_ONE.storageEndAt, endTrigger: 'salvage_released' });

  const recovery = createRecovery(db, {
    claimId,
    at: '2026-08-10T11:00:00.000Z',
    fromLocation: 'A13 Alfred’s Way, Barking',
    toLocation: 'CCGUK yard',
    calloutPence: FILE_ONE.recoveryCalloutPence,
    loadedMiles: FILE_ONE.recoveryMiles,
    perLoadedMilePence: FILE_ONE.recoveryPerMilePence,
    adminPence: FILE_ONE.recoveryAdminPence,
    vatRate: 0.2,
  });

  const offer = createOffer(db, {
    claimId,
    receivedAt: FILE_ONE.offerReceivedAt,
    channel: 'phone',
    offerorPartyId: insurer.id,
    offerorName: 'Example Insurance Ltd',
    vehicleClassOffered: 'small hatchback',
    dailyRatePence: FILE_ONE.offerDailyPence,
    rateIncludesVat: true,
    terms: { excessPence: 75000, deliveryIncluded: false, insuranceIncluded: true, durationStated: 'until repairs complete' },
  });
  recordOfferDecision(db, offer.id, { clientDecision: 'declined', clientReasons: 'Vehicle class smaller than own car; £750 excess; no delivery; hire already in place.', clientDecisionAt: '2026-08-11T15:00:00.000Z', suitable: false, suitabilityReasons: ['class', 'excess', 'delivery'] });
  recordOfferReply(db, offer.id, { replySentAt: '2026-08-12T09:00:00.000Z' });

  const photo = insertEvidence(db, {
    claimId,
    kind: 'photo',
    filename: 'front_left.jpg',
    mime: 'image/jpeg',
    bytes: 2_348_112,
    sha256: 'a3f1c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    storagePath: `evidence/${claimId}/front_left.jpg`,
    capturedAt: '2026-08-10T11:20:00.000Z',
    uploadedAt: '2026-08-10T11:25:00.000Z',
    uploadedBy: handler.id,
    captureShot: 'front_left',
    exif: { dateTimeOriginal: '2026-08-10T11:20:00.000Z', make: 'Apple', model: 'iPhone 15' },
  });

  const pav = createPav(db, {
    claimId,
    subject: { vehicleId: clientVehicle.id, registration: 'AB12CDE', make: 'VOLKSWAGEN', model: 'GOLF', trim: '1.5 TSI Life', year: 2019, fuelType: 'petrol', transmission: 'manual', odometerAtLoss: 49980, odometerBasis: 'reading', conditionGrade: 'good', conditionAdjustmentPct: 0, serviceHistory: 'full', claimantPostcode: 'E1 6AN' },
    comparables: [
      { id: 'c1', capturedAt: '2026-08-15T10:00:00.000Z', source: 'Auto Trader', pricePence: 629500, mileage: 52000, year: 2019, make: 'VOLKSWAGEN', model: 'GOLF', seller: 'dealer', normalisedPricePence: 641000 },
      { id: 'c2', capturedAt: '2026-08-15T10:05:00.000Z', source: 'Auto Trader', pricePence: 659900, mileage: 47500, year: 2019, make: 'VOLKSWAGEN', model: 'GOLF', seller: 'dealer', normalisedPricePence: 650000 },
      { id: 'c3', capturedAt: '2026-08-15T10:10:00.000Z', source: 'dealer site', pricePence: 679000, mileage: 44000, year: 2020, make: 'VOLKSWAGEN', model: 'GOLF', seller: 'dealer', normalisedPricePence: 659000 },
    ],
    perMilePence: 6,
    perMileSource: 'regression',
    medianPence: FILE_ONE.pavPence,
    iqrLowPence: 641000,
    iqrHighPence: 659000,
    pavPence: FILE_ONE.pavPence,
    reasoning: 'Three retail comparables within year ±1 and mileage ±25%, normalised at 6p/mile; median £6,500.',
    approvedBy: engineer.id,
    approvedAt: '2026-08-18T15:00:00.000Z',
    createdAt: '2026-08-18T14:00:00.000Z',
  });

  const report = createEngineerReport(db, {
    claimId,
    vehicleId: clientVehicle.id,
    engineerPartyId: engineer.id,
    engineerQualifications: 'IAEA, IMI',
    instructedBy: 'Courtesy Cars Group UK Ltd',
    instructedAt: '2026-08-12T10:00:00.000Z',
    inspectionAt: '2026-08-14T13:00:00.000Z',
    inspectionPlace: 'CCGUK yard',
    inspectionBasis: 'physical',
    odometerMiles: 49980,
    preAccidentCondition: 'Good; full service history.',
    damageDescription: 'Rear-end impact; boot floor and rear chassis legs deformed.',
    consistentWithCircumstances: true,
    roadworthy: false,
    roadworthyReason: 'Rear structural deformation; lights inoperative.',
    pavAssessmentId: pav.id,
    salvageCategory: 'S',
    salvageValuePence: 120000,
    forCourt: false,
    feePence: FILE_ONE.engineerFeePence,
    issuedAt: '2026-08-18T16:00:00.000Z',
    createdAt: '2026-08-18T16:00:00.000Z',
  });

  // Ledger — our position per head, then what was paid
  const led = (head: Parameters<typeof appendLedgerEntry>[1]['head'], kind: Parameters<typeof appendLedgerEntry>[1]['kind'], amountPence: number, date: string, description: string, extra: Partial<Parameters<typeof appendLedgerEntry>[1]> = {}) =>
    appendLedgerEntry(db, { claimId, head, kind, amountPence, date, description, createdBy: handler.id, ...extra });
  led('recovery', 'claimed', FILE_ONE.recoveryPence, '2026-08-10', 'Recovery: £90 call-out + 12 loaded miles × £3 + £25 admin', { vatPence: 3020 });
  led('storage', 'claimed', FILE_ONE.storagePence, '2026-08-20', `Storage ${FILE_ONE.storageDays} days × £45`, { vatPence: 9000 });
  led('engineer_fee', 'claimed', FILE_ONE.engineerFeePence, '2026-08-18', 'Engineer’s report fee', { vatPence: 5700 });
  led('pav', 'claimed', FILE_ONE.pavPence, '2026-08-18', 'Pre-accident value (total loss)');
  led('hire', 'claimed', FILE_ONE.hirePence, '2026-09-02', `Credit hire ${chargeableDays(FILE_ONE.hireStartAt, FILE_ONE.hireEndAt)} days × £49.80`, { vatPence: 22908 });
  led('hire', 'invoiced', FILE_ONE.hirePence, '2026-09-05', 'Hire invoice INV-H-000101', { vatPence: 22908, reference: 'INV-H-000101' });
  const paid = led('hire', 'paid', FILE_ONE.paidPence, '2026-09-25', '£1,112.00 received — remittance EXI-REM-5531 (prior letter wrongly stated £1,287)', { reference: 'EXI-REM-5531', counterpartyId: insurer.id });

  // Documents: NCAF (sent day 1) and the payment pack (sent 5 Sep)
  const ncaf = createDraft(db, {
    claimId,
    templateId: 'letter.ncaf',
    templateVersion: '1.0.0',
    title: 'New Claim Advice Form — CCG ref ' + claim.reference,
    recipientPartyId: insurer.id,
    html: '<html><body><h1>New Claim Advice Form</h1><p>Hire commenced 10 August 2026 at £49.80 per day (industry benchmark GTA group S1).</p></body></html>',
    sha256: '1111111111111111111111111111111111111111111111111111111111111111',
    dataSnapshot: { hireStartAt: FILE_ONE.hireStartAt, dailyRatePence: FILE_ONE.hireDailyPence },
    createdBy: handler.id,
    createdAt: '2026-08-11T11:00:00.000Z',
    consistency: { checkedAt: '2026-08-11T11:05:00.000Z', flags: [], blocked: false },
  });
  approveDocument(db, ncaf.id, { userId: approver.id }, '2026-08-11T11:20:00.000Z');
  markDocumentSent(db, ncaf.id, { userId: handler.id }, { sentVia: 'email', sentAt: FILE_ONE.ncafSentAt });

  const pack = createDraft(db, {
    claimId,
    templateId: 'pack.gta_payment',
    templateVersion: '1.0.0',
    title: 'GTA payment pack — ' + claim.reference,
    recipientPartyId: insurer.id,
    html: '<html><body><h1>Payment pack</h1><p>Hire £1,145.40; storage £450.00; recovery £151.00; engineer £285.00; PAV £6,500.00.</p></body></html>',
    sha256: '2222222222222222222222222222222222222222222222222222222222222222',
    dataSnapshot: { hirePence: FILE_ONE.hirePence, storagePence: FILE_ONE.storagePence, recoveryPence: FILE_ONE.recoveryPence, engineerFeePence: FILE_ONE.engineerFeePence, pavPence: FILE_ONE.pavPence },
    createdBy: handler.id,
    createdAt: '2026-09-05T14:00:00.000Z',
    consistency: { checkedAt: '2026-09-05T14:05:00.000Z', flags: [], blocked: false },
  });
  approveDocument(db, pack.id, { userId: approver.id }, '2026-09-05T14:30:00.000Z');
  markDocumentSent(db, pack.id, { userId: handler.id }, { sentVia: 'email', sentAt: FILE_ONE.packSentAt });

  // Materialised clocks (normally produced by @ccguk/domain deriveClocks; one representative row here)
  replaceClocks(
    db,
    claimId,
    [
      {
        kind: 'gta_6_7_settlement_1_month',
        label: 'Settlement within one calendar month of clean pack (benchmark)',
        basis: 'GTA 6.7 (industry benchmark — CCGUK is not a subscriber)',
        startsAt: FILE_ONE.packSentAt,
        dueAt: '2026-10-05T15:00:00.000Z',
        status: 'running',
        attributableTo: 'insurer',
      },
    ],
    '2026-09-05T15:01:00.000Z',
  );

  return {
    handlerId: handler.id,
    approverId: approver.id,
    claimantId: claimant.id,
    driverId: claimant.id,
    thirdPartyId: thirdParty.id,
    insurerId: insurer.id,
    engineerId: engineer.id,
    clientVehicleId: clientVehicle.id,
    thirdPartyVehicleId: thirdPartyVehicle.id,
    fleetVehicleId: fleetVehicle.id,
    fleetUnitId: fleetUnit.id,
    claimId,
    hireId: hire.id,
    storageId: storage.id,
    recoveryId: recovery.id,
    offerId: offer.id,
    pavId: pav.id,
    reportId: report.id,
    ncafDocumentId: ncaf.id,
    packDocumentId: pack.id,
    photoEvidenceId: photo.id,
    paidLedgerId: paid.id,
  };
}
