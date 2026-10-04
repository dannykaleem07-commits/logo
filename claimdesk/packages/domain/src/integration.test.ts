/**
 * Integration test for @ccguk/domain: one realistic File 1 bundle driven through the whole chain
 * deriveClocks → scheduleOfLoss → evaluateGates → nextActions → checkDraft, with the rate card, payment-pack,
 * late-payment, total-loss, acceptance and e-sign engines cross-checked against the same figures. Everything is
 * imported from the package barrel, so the test also proves the barrel resolves every documented name.
 *
 * Story (File 1 archetype — "£1,287 stated when £1,112 received / bank validation" — on a total-loss file):
 *   Sun 09 Aug 2026  accident on the A13; recovered 12 loaded miles to the yard (£90 + 12 × £3 + £25); storage starts
 *   Mon 10 Aug       FNOL, services agreed, Golf (S1) on hire at £49.80/day, engineer instructed
 *   Tue 11 Aug       NCAF sent (GTA 4.1 met); esure phones an intervention offer at £20.37/day; CCTV preservation request
 *   Wed 12 Aug       written reply declining the offer (1 WD met); inspection
 *   Wed 19 Aug       engineer's report: total loss, PAV £6,500, salvage £900 (Cat N bid); collect-or-pay notice
 *   Fri 21 Aug       salvage released to the claimant's buyer — storage ends at report + 48h (12 days); PAV offer received
 *   Wed 26 Aug       insurer pays PAV less retained salvage (£5,600) → GTA 4.14 off-hire within 5 WD (31 Aug bank holiday → Thu 3 Sep)
 *   Wed 02 Sep       hire ends (23 days)
 *   Sat 05 Sep       payment pack sent; chasers 11 and 18 Sep; 22 Sep "bank details could not be validated"; vendor pack 23 Sep
 *   Fri 25 Sep       £1,112.00 received against pack heads of £2,488.68
 *   Sun 04 Oct       now (day 29): chaser 3 and the DISP 1 complaint are overdue; a draft complaint says £1,287 was paid
 *
 * Hand-computed figures (integer pence):
 *   hire       23 × 4,980 = 114,540 net + 22,908 VAT = 137,448
 *   storage    12 × 4,500 =  54,000 net + 10,800 VAT =  64,800
 *   recovery   9,000 + 12 × 300 + 2,500 = 15,100 net + 3,020 VAT = 18,120
 *   engineer   28,500 (fee note, no VAT — the brief's figure)
 *   PAV        650,000 claimed, salvage credit −90,000, 560,000 paid 26 Aug → PAV position nil
 *   pack heads 137,448 + 64,800 + 18,120 + 28,500 = 248,868; £1,112.00 received → 137,668 outstanding
 *   schedule   claimed 808,868; paid 671,200; outstanding 137,668
 */
import { describe, expect, it } from 'vitest';
import * as domain from './index.js';
import {
  addWorkingDays,
  assessAcceptance,
  assessTotalLoss,
  calculateHire,
  checkDraft,
  clearFlag,
  deriveClocks,
  dueClocks,
  evaluateGates,
  latePaymentUplift,
  londonDate,
  nextActions,
  outstandingBalance,
  recoveryCharge,
  scheduleOfLoss,
  signatureDateChecks,
  storageCharge,
  validatePaymentPack,
  type Claim,
  type ClaimBundle,
  type ClaimEvent,
  type Clock,
  type ClockKind,
  type DraftContext,
  type EngineerReport,
  type Evidence,
  type GeneratedDocument,
  type HireAgreement,
  type InterventionOffer,
  type LedgerEntry,
  type Party,
  type PavAssessment,
  type RecoveryRecord,
  type StorageRecord,
  type TotalLossInput,
  type Vehicle,
} from './index.js';

// ---------------------------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------------------------

const CLAIM_ID = 'claim-f1';
const NOW = '2026-10-04T10:00:00+01:00';
const ACCIDENT_AT = '2026-08-09T14:30:00+01:00';
const FNOL_AT = '2026-08-10T09:00:00+01:00';
const HIRE_START = '2026-08-10T10:00:00+01:00';
const HIRE_END = '2026-09-02T10:00:00+01:00';
const STORAGE_START = '2026-08-09T17:00:00+01:00';
const STORAGE_END = '2026-08-21T12:00:00+01:00';
const REPORT_AT = '2026-08-19T12:00:00+01:00';
const TL_PAYMENT_AT = '2026-08-26T12:00:00+01:00';
const PACK_AT = '2026-09-05T10:00:00+01:00';

const HIRE_NET = 114_540;
const HIRE_VAT = 22_908;
const STORAGE_NET = 54_000;
const STORAGE_VAT = 10_800;
const RECOVERY_NET = 15_100;
const RECOVERY_VAT = 3_020;
const ENGINEER_FEE = 28_500;
const PAV = 650_000;
const SALVAGE = 90_000;
const TL_PAID = PAV - SALVAGE; // 560,000: PAV less the salvage the claimant kept
const REMITTANCE = 111_200; // £1,112.00 received 25 Sep
const PACK_GROSS = HIRE_NET + HIRE_VAT + STORAGE_NET + STORAGE_VAT + RECOVERY_NET + RECOVERY_VAT + ENGINEER_FEE; // 248,868
const OUTSTANDING = PACK_GROSS - REMITTANCE; // 137,668
const SCHEDULE_CLAIMED = PACK_GROSS + PAV - SALVAGE; // 808,868
const SCHEDULE_PAID = TL_PAID + REMITTANCE; // 671,200

const TL_INPUT: TotalLossInput = {
  repairNetPence: 585_000,
  repairWorkingDays: 10,
  hireDailyRatePence: 4_980,
  storageDailyRatePence: 4_500,
  pavPence: PAV,
  salvage: { pence: SALVAGE, source: 'bid', category: 'N' },
};

function party(id: string, name: string, extra: Partial<Party> = {}): Party {
  return { id, kind: 'individual', name, roles: ['claimant'], createdAt: FNOL_AT, ...extra };
}

function ev(type: ClaimEvent['type'], at: string, extra: Partial<ClaimEvent> = {}): ClaimEvent {
  return { id: `ev:${type}:${at}`, claimId: CLAIM_ID, type, at, recordedAt: at, summary: type.replace(/_/g, ' '), evidenceIds: [], createdBy: 'u-handler', ...extra };
}

function led(id: string, e: Pick<LedgerEntry, 'head' | 'kind' | 'amountPence' | 'date' | 'description'> & Partial<LedgerEntry>): LedgerEntry {
  return { id, claimId: CLAIM_ID, createdBy: 'u-handler', createdAt: `${e.date}T17:00:00+01:00`, ...e };
}

function evidence(id: string, kind: Evidence['kind'], extra: Partial<Evidence> = {}): Evidence {
  return {
    id,
    claimId: CLAIM_ID,
    kind,
    filename: `${id}.bin`,
    mime: 'application/octet-stream',
    bytes: 1,
    sha256: 'a'.repeat(64),
    storagePath: `evidence/${id}`,
    uploadedAt: '2026-08-10T12:00:00+01:00',
    uploadedBy: 'u-handler',
    immutable: true,
    ...extra,
  };
}

function doc(id: string, templateId: string, createdAt: string, status: GeneratedDocument['status'], extra: Partial<GeneratedDocument> = {}): GeneratedDocument {
  return { id, claimId: CLAIM_ID, templateId, templateVersion: '1.0.0', title: templateId, status, html: '', sha256: 'b'.repeat(64), createdAt, createdBy: 'u-handler', dataSnapshot: {}, ...extra };
}

function claim(): Claim {
  return {
    id: CLAIM_ID,
    reference: 'CCG-2026-00031',
    status: 'chasing',
    openedAt: FNOL_AT,
    accident: {
      occurredAt: ACCIDENT_AT,
      location: 'A13 Newham Way, London',
      postcode: 'E6 5LF',
      circumstances:
        'I was stationary in lane 1 in slow traffic. The other car moved across from lane 2 without indicating and hit the back corner of my car on the driver side.',
      thirdPartyAccount: 'Third party accepted he moved across without seeing the Golf.',
      highwayCodeRules: [133, 160],
      policeAttended: false,
      cctvAvailable: true,
      dashcamAvailable: false,
      independentWitness: false,
      injuries: false,
      roadworthyAfter: false,
      airbagsDeployed: false,
      driveable: false,
    },
    liability: 'admitted',
    claimantId: 'p-claimant',
    clientVehicleId: 'v-client',
    thirdPartyIds: ['p-tp'],
    thirdPartyVehicleId: 'v-tp',
    atFaultInsurerId: 'p-insurer',
    atFaultInsurerRef: 'ESR/2026/51890',
    gtaSubscriber: false,
    linkedClaimIds: [],
    flags: [],
    createdAt: FNOL_AT,
    updatedAt: NOW,
  };
}

function hire(): HireAgreement {
  return {
    id: 'hire-1',
    claimId: CLAIM_ID,
    fleetUnitId: 'fleet-golf-1',
    agreementNumber: 'CH-2026-0031',
    startAt: HIRE_START,
    endAt: HIRE_END,
    endTrigger: 'tl_payment_5wd',
    dailyRatePence: 4_980,
    vatRate: 0.2,
    gtaGroup: 'S1',
    excessPence: 0,
    additionalDrivers: [],
    deliveredAt: HIRE_START,
    collectedAt: HIRE_END,
    odometerOut: 12_400,
    odometerIn: 13_105,
    signedAt: '2026-08-10T10:30:00+01:00',
    documentId: 'doc-cha',
    enforceability: {
      cancellationInfoProvidedAt: '2026-08-10T10:05:00+01:00',
      schedule3FormProvidedAt: '2026-08-10T10:05:00+01:00',
      expressRequestToStartAt: '2026-08-10T10:20:00+01:00',
      expressRequestEvidenceId: 'ev-express-request',
      cca60fCompliant: true,
    },
    mitigationQuestionnaireDocumentId: 'doc-mq',
    statementOfMeansDocumentId: 'doc-means',
  };
}

function storage(): StorageRecord {
  return { id: 'sto-1', claimId: CLAIM_ID, location: 'CCGUK yard, Barking', startAt: STORAGE_START, endAt: STORAGE_END, endTrigger: 'salvage_released', dailyRatePence: 4_500, vatRate: 0.2 };
}

function recovery(): RecoveryRecord {
  return {
    id: 'rec-1',
    claimId: CLAIM_ID,
    at: '2026-08-09T16:00:00+01:00',
    fromLocation: 'A13 Newham Way, London',
    toLocation: 'CCGUK yard, Barking',
    calloutPence: 9_000,
    loadedMiles: 12,
    perLoadedMilePence: 300,
    adminPence: 2_500,
    vatRate: 0.2,
    evidenceIds: ['ev-recovery-sheet'],
  };
}

function offer(): InterventionOffer {
  return {
    id: 'offer-1',
    claimId: CLAIM_ID,
    receivedAt: '2026-08-11T11:00:00+01:00',
    channel: 'phone',
    offerorPartyId: 'p-insurer',
    offerorName: 'esure',
    vehicleClassOffered: 'small hatchback',
    dailyRatePence: 2_037, // £20.37/day (File 1)
    rateIncludesVat: true,
    terms: { excessPence: 50_000, mileageLimitPerDay: 100, deliveryIncluded: false, insuranceIncluded: true },
    suitable: false,
    suitabilityReasons: ['£500 excess against a nil-excess hire', 'no delivery to the claimant', '100 miles/day limit against a 70-mile commute'],
    clientDecision: 'declined',
    clientReasons: 'Needs the car for a 70-mile daily commute and to carry work tools; cannot fund a £500 excess.',
    clientDecisionAt: '2026-08-11T15:00:00+01:00',
    replySentAt: '2026-08-12T09:00:00+01:00',
    replyDocumentId: 'doc-intervention-reply',
    evidenceIds: ['ev-offer-call-note'],
  };
}

function pav(): PavAssessment {
  return {
    id: 'pav-1',
    claimId: CLAIM_ID,
    subject: {
      vehicleId: 'v-client',
      registration: 'AB12CDE',
      make: 'Volkswagen',
      model: 'Golf',
      trim: '1.5 TSI Match',
      year: 2018,
      fuelType: 'petrol',
      transmission: 'manual',
      odometerAtLoss: 61_240,
      odometerBasis: 'reading',
      conditionGrade: 'good',
      conditionAdjustmentPct: 0,
      serviceHistory: 'full',
      claimantPostcode: 'E6 3BP',
    },
    comparables: [],
    perMilePence: 7,
    perMileSource: 'fallback_band',
    medianPence: PAV,
    iqrLowPence: 630_000,
    iqrHighPence: 672_500,
    pavPence: PAV,
    reasoning: 'Median of five normalised retail comparables within 25 miles; condition adjustment nil.',
    approvedBy: 'u-engineer',
    approvedAt: REPORT_AT,
    createdAt: REPORT_AT,
  };
}

function report(): EngineerReport {
  return {
    id: 'rep-1',
    claimId: CLAIM_ID,
    vehicleId: 'v-client',
    engineerPartyId: 'p-engineer',
    engineerQualifications: 'IAEA, IMI Accredited Assessor',
    instructedBy: 'Courtesy Cars Group UK Ltd',
    instructedAt: '2026-08-10T11:00:00+01:00',
    inspectionAt: '2026-08-12T10:00:00+01:00',
    inspectionPlace: 'CCGUK yard, Barking',
    inspectionBasis: 'physical',
    odometerMiles: 61_240,
    preAccidentCondition: 'Good: full service history, two previous keepers, tyres 5–6 mm.',
    damageDescription: 'Offside rear quarter, rear door, rear bumper and boot floor displaced; offside rear wheel fouling the arch.',
    consistentWithCircumstances: true,
    roadworthy: false,
    roadworthyReason: 'Rear light cluster destroyed and offside rear wheel fouling the arch; boot floor displaced.',
    repairDurationWorkingDays: 10,
    totalLoss: assessTotalLoss(TL_INPUT),
    pavAssessmentId: 'pav-1',
    salvageCategory: 'N',
    salvageValuePence: SALVAGE,
    photoEvidenceIds: ['ev-odo-out'],
    forCourt: false,
    feePence: ENGINEER_FEE,
    issuedAt: REPORT_AT,
    documentId: 'doc-eng-report',
  };
}

/** The File 1 bundle on 4 October 2026. Fresh object each call; `clocks` is empty until deriveClocks runs. */
export function file1TotalLossBundle(): ClaimBundle {
  const vehicle: Vehicle = {
    id: 'v-client',
    registration: 'AB12CDE',
    make: 'Volkswagen',
    model: 'Golf',
    variant: '1.5 TSI Match',
    yearOfManufacture: 2018,
    fuelType: 'petrol',
    transmission: 'manual',
    odometer: [{ source: 'engineer', date: '2026-08-12', miles: 61_240 }],
    gtaGroup: 'S1',
    ownership: 'client',
    lookups: [],
    createdAt: FNOL_AT,
  };
  const thirdPartyVehicle: Vehicle = { id: 'v-tp', registration: 'XY19ZZZ', make: 'Ford', model: 'Focus', odometer: [], ownership: 'third_party', lookups: [], createdAt: FNOL_AT };
  const signature = (signedAt: string) => ({
    signerPartyId: 'p-claimant',
    signerName: 'Amir Hussain',
    signerContact: 'amir@example.com',
    otpChannel: 'email' as const,
    otpVerifiedAt: signedAt,
    ipAddress: '203.0.113.9',
    userAgent: 'Mozilla/5.0',
    signedAt,
    documentSha256: 'b'.repeat(64),
    certificateId: `CERT-${signedAt.slice(0, 10)}`,
  });

  return {
    claim: claim(),
    claimant: party('p-claimant', 'Amir Hussain', {
      phone: '07700 900123',
      email: 'amir@example.com',
      dateOfBirth: '1988-04-12',
      drivingLicenceNumber: 'HUSSA804128AH9IJ',
      address: { line1: '14 Barking Road', town: 'London', postcode: 'E6 3BP' },
    }),
    vehicle,
    thirdParties: [party('p-tp', 'Daniel Okafor', { roles: ['third_party', 'third_party_driver'], phone: '07700 900456' })],
    thirdPartyVehicle,
    atFaultInsurer: party('p-insurer', 'esure Insurance Ltd', { kind: 'company', roles: ['insurer'], companyNumber: '02494086' }),
    events: [
      ev('recovery', '2026-08-09T16:00:00+01:00', { evidenceIds: ['ev-recovery-sheet'] }),
      ev('storage_started', STORAGE_START),
      ev('fnol', FNOL_AT),
      ev('services_agreed', '2026-08-10T09:30:00+01:00'),
      ev('hire_started', HIRE_START),
      ev('engineer_instructed', '2026-08-10T11:00:00+01:00'),
      ev('ncaf_sent', '2026-08-11T09:00:00+01:00', { documentId: 'doc-ncaf' }),
      ev('intervention_offer', '2026-08-11T11:00:00+01:00', { attributableTo: 'insurer', data: { offerId: 'offer-1' } }),
      ev('cctv_request_sent', '2026-08-11T12:00:00+01:00'),
      ev('intervention_reply_sent', '2026-08-12T09:00:00+01:00', { documentId: 'doc-intervention-reply', data: { offerId: 'offer-1' } }),
      ev('inspection', '2026-08-12T10:00:00+01:00'),
      ev('handling_ref_received', '2026-08-13T15:00:00+01:00', { attributableTo: 'insurer', data: { reference: 'ESR/2026/51890' } }),
      ev('report_issued', REPORT_AT, { documentId: 'doc-eng-report' }),
      ev('total_loss_confirmed', '2026-08-19T12:30:00+01:00'),
      ev('collect_or_pay_notice_sent', '2026-08-19T15:00:00+01:00', { documentId: 'doc-cop' }),
      ev('salvage_released', STORAGE_END),
      ev('storage_ended', STORAGE_END),
      ev('pav_offer_received', '2026-08-21T16:00:00+01:00', { attributableTo: 'insurer', data: { amountPence: PAV } }),
      ev('pav_agreed', '2026-08-24T10:00:00+01:00', { data: { amountPence: PAV } }),
      ev('tl_payment_received', TL_PAYMENT_AT, { attributableTo: 'insurer', data: { amountPence: TL_PAID } }),
      ev('hire_ended', HIRE_END),
      ev('payment_pack_sent', PACK_AT, { documentId: 'doc-pack' }),
      ev('chaser_sent', '2026-09-11T10:00:00+01:00', { documentId: 'doc-chaser-7', data: { chaser: 1 } }),
      ev('chaser_sent', '2026-09-18T10:00:00+01:00', { documentId: 'doc-chaser-14', data: { chaser: 2 } }),
      ev('email_in', '2026-09-22T11:00:00+01:00', { attributableTo: 'insurer', summary: 'esure: bank details could not be validated', data: { reason: 'bank_validation' } }),
      ev('letter_out', '2026-09-23T10:00:00+01:00', { documentId: 'doc-vendor', data: { kind: 'vendor_verification_pack' } }),
      ev('payment_received', '2026-09-25T12:00:00+01:00', { attributableTo: 'insurer', data: { amountPence: REMITTANCE, reference: 'REM-2026-0917' } }),
    ],
    ledger: [
      led('led-hire', { head: 'hire', kind: 'claimed', amountPence: HIRE_NET, vatPence: HIRE_VAT, date: '2026-09-02', description: 'Hire 23 days @ £49.80 (S1), 10 Aug–2 Sep 2026', sourceDocumentId: 'doc-inv-hire' }),
      led('led-storage', { head: 'storage', kind: 'claimed', amountPence: STORAGE_NET, vatPence: STORAGE_VAT, date: '2026-08-21', description: 'Storage 12 days @ £45.00, 9–21 Aug 2026', sourceDocumentId: 'doc-inv-storage' }),
      led('led-recovery', { head: 'recovery', kind: 'claimed', amountPence: RECOVERY_NET, vatPence: RECOVERY_VAT, date: '2026-08-09', description: 'Recovery £90 call-out + 12 loaded miles @ £3 + £25 admin', sourceDocumentId: 'doc-inv-recovery' }),
      led('led-engineer', { head: 'engineer_fee', kind: 'claimed', amountPence: ENGINEER_FEE, date: '2026-08-19', description: "Engineer's fee £285", sourceDocumentId: 'doc-inv-engineer' }),
      led('led-pav', { head: 'pav', kind: 'claimed', amountPence: PAV, date: '2026-08-19', description: 'Pre-accident value (report.pav)', sourceDocumentId: 'doc-pav-report' }),
      led('led-salvage', { head: 'salvage', kind: 'claimed', amountPence: SALVAGE, date: '2026-08-19', description: 'Salvage retained by claimant (Cat N bid)', sourceEvidenceId: 'ev-salvage-bid' }),
      led('led-tl-paid', { head: 'pav', kind: 'paid', amountPence: TL_PAID, date: '2026-08-26', description: 'Total-loss payment esure → claimant (PAV less salvage retained)', reference: 'ESR-TL-51890', counterpartyId: 'p-insurer' }),
      led('led-remittance', { head: 'hire', kind: 'paid', amountPence: REMITTANCE, date: '2026-09-25', description: 'Remittance esure £1,112.00 (unallocated on the advice; applied to hire)', reference: 'REM-2026-0917', counterpartyId: 'p-insurer' }),
    ],
    offers: [offer()],
    hire: [hire()],
    storage: [storage()],
    recovery: [recovery()],
    evidence: [
      evidence('ev-recovery-sheet', 'document', { description: 'Recovery job sheet 9 Aug 2026, 12 loaded miles', capturedAt: '2026-08-09T16:30:00+01:00' }),
      evidence('ev-odo-out', 'photo', { captureShot: 'odometer', capturedAt: '2026-08-10T10:10:00+01:00' }),
      evidence('ev-odo-in', 'photo', { captureShot: 'odometer', capturedAt: '2026-09-02T10:05:00+01:00' }),
      evidence('ev-express-request', 'document', { description: 'Express request to start within the cancellation period (reg 36)' }),
      evidence('ev-offer-call-note', 'call_recording', { description: 'esure intervention offer call 11 Aug 2026' }),
      evidence('ev-bhr-1', 'screenshot', { description: 'BHR comparator: Enterprise Ilford, VW Golf, 11 Aug 2026' }),
      evidence('ev-bank-1', 'bank_statement'),
      evidence('ev-bank-2', 'bank_statement'),
      evidence('ev-bank-3', 'bank_statement'),
      evidence('ev-payslip', 'payslip'),
      evidence('ev-cctv', 'cctv', { description: 'Council CCTV Newham Way camera 14 — footage received 18 Aug 2026' }),
      evidence('ev-salvage-bid', 'document', { description: 'Salvage bid £900 Cat N — Copart, 20 Aug 2026' }),
      evidence('ev-eng-report', 'engineer_report', { description: "Engineer's report issued 19 Aug 2026" }),
    ],
    documents: [
      doc('doc-cha', 'agreement.credit_hire', '2026-08-10T10:00:00+01:00', 'signed', { signature: signature('2026-08-10T10:30:00+01:00') }),
      doc('doc-need', 'form.statement_of_need', '2026-08-10T10:00:00+01:00', 'signed', { signature: signature('2026-08-10T10:35:00+01:00') }),
      doc('doc-means', 'form.statement_of_means', '2026-08-10T10:00:00+01:00', 'signed', { signature: signature('2026-08-10T10:40:00+01:00') }),
      doc('doc-ncaf', 'letter.ncaf', '2026-08-11T08:30:00+01:00', 'sent', { sentAt: '2026-08-11T09:00:00+01:00', sentVia: 'email' }),
      doc('doc-intervention-reply', 'letter.intervention_reply', '2026-08-12T08:30:00+01:00', 'sent', { sentAt: '2026-08-12T09:00:00+01:00', sentVia: 'email' }),
      doc('doc-mq', 'form.mitigation_questionnaire', '2026-08-12T11:00:00+01:00', 'signed', { signature: signature('2026-08-12T12:00:00+01:00') }),
      doc('doc-eng-report', 'report.engineer', REPORT_AT, 'approved', { approvedAt: REPORT_AT, approvedBy: 'u-engineer' }),
      doc('doc-pav-report', 'report.pav', REPORT_AT, 'approved', { approvedAt: REPORT_AT, approvedBy: 'u-engineer' }),
      doc('doc-cop', 'letter.collect_or_pay', '2026-08-19T14:00:00+01:00', 'sent', { sentAt: '2026-08-19T15:00:00+01:00', sentVia: 'email' }),
      doc('doc-hpv', 'form.hire_period_validation', '2026-09-02T11:00:00+01:00', 'signed', { signature: signature('2026-09-02T12:00:00+01:00') }),
      doc('doc-inv-hire', 'invoice.hire', '2026-09-02T12:00:00+01:00', 'sent', {
        sentAt: PACK_AT,
        dataSnapshot: { hire: { days: 23, dailyRatePence: 4_980, netPence: HIRE_NET, vatPence: HIRE_VAT, grossPence: HIRE_NET + HIRE_VAT } },
      }),
      doc('doc-inv-storage', 'invoice.storage', '2026-08-21T13:00:00+01:00', 'sent', {
        sentAt: PACK_AT,
        dataSnapshot: { storage: { days: 12, dailyRatePence: 4_500, netPence: STORAGE_NET, vatPence: STORAGE_VAT, grossPence: STORAGE_NET + STORAGE_VAT } },
      }),
      doc('doc-inv-recovery', 'invoice.recovery', '2026-08-10T12:00:00+01:00', 'sent', {
        sentAt: PACK_AT,
        dataSnapshot: { recovery: { calloutPence: 9_000, loadedMiles: 12, perLoadedMilePence: 300, adminPence: 2_500, netPence: RECOVERY_NET, vatPence: RECOVERY_VAT, grossPence: RECOVERY_NET + RECOVERY_VAT } },
      }),
      doc('doc-inv-engineer', 'invoice.engineer_fee', REPORT_AT, 'sent', { sentAt: PACK_AT, dataSnapshot: { engineerFee: { netPence: ENGINEER_FEE } } }),
      doc('doc-pack', 'pack.gta_payment', '2026-09-04T16:00:00+01:00', 'sent', { sentAt: PACK_AT, sentVia: 'email' }),
      doc('doc-chaser-7', 'letter.chaser_7', '2026-09-11T09:00:00+01:00', 'sent', { sentAt: '2026-09-11T10:00:00+01:00' }),
      doc('doc-chaser-14', 'letter.chaser_14', '2026-09-18T09:00:00+01:00', 'sent', { sentAt: '2026-09-18T10:00:00+01:00' }),
      doc('doc-vendor', 'letter.vendor_verification_pack', '2026-09-23T09:00:00+01:00', 'sent', { sentAt: '2026-09-23T10:00:00+01:00' }),
    ],
    clocks: [],
    pav: pav(),
    report: report(),
  };
}

/** Run the first half of the chain: clocks derived from the chronology and written back onto the bundle. */
function withClocks(bundle: ClaimBundle, now: string): { bundle: ClaimBundle; clocks: Clock[] } {
  const clocks = deriveClocks(bundle, now);
  return { bundle: { ...bundle, clocks }, clocks };
}

function one(clocks: Clock[], kind: ClockKind): Clock {
  const found = clocks.filter((c) => c.kind === kind);
  expect(found, `expected exactly one ${kind} clock`).toHaveLength(1);
  return found[0]!;
}

/** The complaint draft a handler wrote on 4 October: it states £1,287.00 as received when the ledger has £1,112.00. */
function complaintLetter(paidStated: string): string {
  return `Courtesy Cars Group UK Ltd
Formal complaint — DISP 1

esure Insurance Ltd
Claims Complaints Team

Our ref: CCG-2026-00031
Your ref: ESR/2026/51890
Date: 4 October 2026

Dear Sirs

Formal complaint: Amir Hussain — AB12 CDE — accident 9 August 2026

We are instructed to correspond on behalf of Amir Hussain, the claimant. This letter is a formal complaint under DISP 1 about the handling of the above claim. We refer to our payment pack sent on 5 September 2026 and our reminders of 11 and 18 September 2026.

We acknowledge receipt of your payment of ${paidStated} received on 25 September 2026.

The hire charges of £1,374.48 (23 days of hire from 10 August 2026 to 2 September 2026 at £49.80 per day plus VAT), storage charges of £648.00 (12 days of storage at £45.00 per day plus VAT), the recovery charge of £181.20 and the engineer's fee of £285.00 were set out in the pack with the supporting documents.

Your intervention offer of 11 August 2026 at £20.37 per day was declined for the reasons given in our written reply of 12 August 2026, which is in the pack.

Taking account of the sum received, the amount now due to our customer on this file is £1,376.68.

Payment of a clean pack within one calendar month is the industry benchmark (GTA 6.7); ICOBS 8.1 requires claims to be handled promptly and fairly and ICOBS 8.2.6R requires a reasoned offer or reply within three months of notification. We ask you to investigate this complaint and pay the balance.

Please acknowledge this complaint promptly and provide your final response within eight weeks, as DISP 1.6 requires.

Yours faithfully

Courtesy Cars Group UK Ltd
`;
}

function draftContext(bundle: ClaimBundle, templateId: string): DraftContext {
  return {
    bundle,
    priorOutgoing: bundle.documents,
    draftCreatedAt: NOW,
    now: NOW,
    templateId,
    addWorkingDays: (date, n) => londonDate(addWorkingDays(date, n)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

describe('integration — the barrel resolves every export named in docs/ARCHITECTURE.md', () => {
  const documented = [
    // calendar
    'addWorkingDays', 'addCalendarMonths', 'workingDaysBetween', 'isWorkingDay', 'endOfWorkingDay',
    // clocks
    'deriveClocks', 'clockDefinitions',
    // gta
    'gtaRate', 'mapGtaGroup', 'calculateHire', 'offHireDeadline', 'monitoringDiary', 'latePaymentUplift', 'validatePaymentPack',
    // consistency
    'checkDraft', 'extractAmounts', 'extractDates', 'legacyCheck', 'bannedPhraseCheck',
    // vehicle
    'normaliseRegistration', 'mileageConflicts', 'projectOdometer', 'crossFileRegistrationCheck',
    // linkage
    'findConnections', 'witnessIndependence',
    // evidence
    'evaluateGates', 'guidedShotList', 'sha256Hex',
    // esign
    'generateOtp', 'verifyOtp', 'buildCertificate', 'signatureDateChecks',
    // pav
    'assessPav', 'normaliseComparables', 'regressPerMile', 'pavReasoning',
    // estimate
    'computeTotals', 'reconcile', 'LabourLibrary', 'parseEstimateText',
    // totalloss
    'assessTotalLoss', 'predictTotalLoss', 'salvageCategories',
    // quantum
    'scheduleOfLoss', 'interest', 'courtFee', 'allocateTrack', 'settlementArithmetic',
    // acceptance
    'scoreLiability', 'assessAcceptance',
    // playbook
    'nextActions',
    // intake
    'validateFnol', 'intakeScript', 'routeInjury',
    // fleet
    'complianceAlerts', 'canAllocate', 'penaltyTransition', 'liabilityTransferParticulars',
    // money
    'formatGBP', 'parseGBP', 'vatOn',
  ] as const;

  it.each(documented)('%s is exported', (name) => {
    expect((domain as Record<string, unknown>)[name]).toBeDefined();
  });

  it('LabourLibrary exposes add and median as the contract names them', () => {
    const lib = new domain.LabourLibrary();
    expect(typeof lib.add).toBe('function');
    expect(typeof lib.median).toBe('function');
  });
});

describe('integration — rate card figures reproduce the ledger (File 1 fixture)', () => {
  const b = file1TotalLossBundle();

  it('hire: 23 days × £49.80 = £1,145.40 net, £1,374.48 gross, benchmarked against S1 £42.32 as a benchmark only', () => {
    const calc = calculateHire(b.hire[0]!);
    expect(calc).toMatchObject({ days: 23, dailyRatePence: 4_980, netPence: HIRE_NET, vatPence: HIRE_VAT, grossPence: HIRE_NET + HIRE_VAT });
    expect(calc.benchmark).toMatchObject({ group: 'S1', gtaDailyRatePence: 4_232, hireAtGtaRatePence: 23 * 4_232, differencePence: HIRE_NET - 23 * 4_232 });
    expect(calc.benchmark!.note).toMatch(/benchmark/i);
    expect(calc.benchmark!.note).toMatch(/not a GTA subscriber/);
    const line = b.ledger.find((e) => e.id === 'led-hire')!;
    expect(line.amountPence + (line.vatPence ?? 0)).toBe(calc.grossPence);
  });

  it('storage: 9 Aug 17:00 → 21 Aug 12:00 is 12 chargeable days × £45 = £540 net, £648 gross', () => {
    const calc = storageCharge(b.storage[0]!);
    expect(calc).toMatchObject({ days: 12, dailyRatePence: 4_500, netPence: STORAGE_NET, vatPence: STORAGE_VAT, grossPence: STORAGE_NET + STORAGE_VAT });
    const line = b.ledger.find((e) => e.id === 'led-storage')!;
    expect(line.amountPence + (line.vatPence ?? 0)).toBe(calc.grossPence);
  });

  it('recovery: £90 + 12 × £3 + £25 = £151 net, £181.20 gross', () => {
    const calc = recoveryCharge(b.recovery[0]!);
    expect(calc).toMatchObject({ calloutPence: 9_000, mileagePence: 3_600, adminPence: 2_500, netPence: RECOVERY_NET, vatPence: RECOVERY_VAT, grossPence: RECOVERY_NET + RECOVERY_VAT });
    const line = b.ledger.find((e) => e.id === 'led-recovery')!;
    expect(line.amountPence + (line.vatPence ?? 0)).toBe(calc.grossPence);
  });

  it('the four pack heads total £2,488.68 and £1,112.00 received leaves £1,376.68', () => {
    expect(PACK_GROSS).toBe(248_868);
    expect(OUTSTANDING).toBe(137_668);
  });
});

describe('integration — deriveClocks on the File 1 chronology at 4 October 2026', () => {
  const { clocks } = withClocks(file1TotalLossBundle(), NOW);

  it('GTA 4.1 / 4.2 / 3.6 and ICOBS 8.2.6 were all met in time', () => {
    expect(one(clocks, 'gta_4_1_ncaf_1wd')).toMatchObject({ status: 'met', dueAt: '2026-08-11T09:30:00+01:00', metAt: '2026-08-11T09:00:00+01:00' });
    expect(one(clocks, 'gta_4_2_handling_ref_5wd')).toMatchObject({ status: 'met', dueAt: '2026-08-18T09:00:00+01:00', metAt: '2026-08-13T15:00:00+01:00' });
    expect(one(clocks, 'gta_3_6_first_notification_5wd').status).toBe('met');
    const icobs = one(clocks, 'icobs_8_2_6_three_months');
    expect(icobs.status).toBe('met');
    expect(londonDate(icobs.dueAt)).toBe('2026-11-11');
    expect(icobs.metAt).toBe('2026-08-21T16:00:00+01:00'); // the PAV offer is the insurer's first reasoned reply
  });

  it('the intervention offer was answered within one working day (lesson c)', () => {
    const reply = one(clocks, 'intervention_reply_1wd');
    expect(reply).toMatchObject({ status: 'met', startsAt: '2026-08-11T11:00:00+01:00', dueAt: '2026-08-12T11:00:00+01:00', metAt: '2026-08-12T09:00:00+01:00' });
    expect(reply.label).toContain('esure');
  });

  it('off-hire ran 5 WD from the total-loss payment, skipping the 31 August bank holiday (GTA 4.14), and was met', () => {
    const offHire = one(clocks, 'gta_4_14_offhire_tl_payment_5wd');
    expect(offHire).toMatchObject({ status: 'met', startsAt: TL_PAYMENT_AT, dueAt: '2026-09-03T12:00:00+01:00', metAt: HIRE_END });
    expect(clocks.some((c) => c.kind === 'gta_4_8_offhire_repair_24h')).toBe(false); // no repair on a total loss
    expect(clocks.some((c) => c.kind === 'gta_4_11_monitoring_5wd')).toBe(false);
    const auth = one(clocks, 'gta_4_10_authorisation_check_3wd');
    expect(auth.status).toBe('stopped');
    expect(auth.stoppedReason).toMatch(/total loss/i);
  });

  it('storage: the collect-or-pay notice went within report + 48h (live File 2 cap)', () => {
    const s = one(clocks, 'storage_report_plus_48h');
    expect(s).toMatchObject({ status: 'met', startsAt: REPORT_AT, dueAt: '2026-08-21T12:00:00+01:00', metAt: '2026-08-19T15:00:00+01:00' });
  });

  it('the chaser clocks exist off the payment pack: 7 and 14 met, 21 breached, complaint at day 28 breached', () => {
    const packEventId = `ev:payment_pack_sent:${PACK_AT}`;
    const c7 = one(clocks, 'chaser_day_7');
    const c14 = one(clocks, 'chaser_day_14');
    const c21 = one(clocks, 'chaser_day_21');
    const c28 = one(clocks, 'complaint_day_28');
    for (const c of [c7, c14, c21, c28]) {
      expect(c.sourceEventId).toBe(packEventId);
      expect(c.startsAt).toBe(PACK_AT);
      expect(c.attributableTo).toBe('ccguk');
    }
    expect(c7).toMatchObject({ status: 'met', dueAt: '2026-09-12T10:00:00+01:00', metAt: '2026-09-11T10:00:00+01:00' });
    expect(c14).toMatchObject({ status: 'met', dueAt: '2026-09-19T10:00:00+01:00', metAt: '2026-09-18T10:00:00+01:00' });
    expect(c21).toMatchObject({ status: 'breached', dueAt: '2026-09-26T10:00:00+01:00' });
    expect(c21.metAt).toBeUndefined();
    expect(c28).toMatchObject({ status: 'breached', dueAt: '2026-10-03T10:00:00+01:00' });
  });

  it('GTA 6.7 one month is still running; the 6.8.6 late-payment tiers start at 00:00 on day 31 and day 61 (benchmark only)', () => {
    expect(one(clocks, 'gta_6_7_settlement_1_month')).toMatchObject({ status: 'running', dueAt: '2026-10-05T10:00:00+01:00' });
    const t10 = one(clocks, 'gta_6_8_late_payment_10pc_day31');
    const t20 = one(clocks, 'gta_6_8_late_payment_20pc_day61');
    expect(t10).toMatchObject({ status: 'running', dueAt: '2026-10-06T00:00:00+01:00' });
    expect(t20).toMatchObject({ status: 'running', dueAt: '2026-11-05T00:00:00+00:00' });
    expect(t10.basis).toMatch(/benchmark/i);
    expect(t20.basis).toMatch(/benchmark/i);
  });

  it('CCTV preservation was requested in time; limitation runs from the accident and from the signed agreement', () => {
    expect(one(clocks, 'cctv_preservation')).toMatchObject({ status: 'met', metAt: '2026-08-11T12:00:00+01:00' });
    const tort = one(clocks, 'limitation_tort_6y');
    expect(tort.status).toBe('running');
    expect(londonDate(tort.dueAt)).toBe('2032-08-09');
    expect(one(clocks, 'limitation_contract_6y').status).toBe('running');
    expect(clocks.some((c) => c.kind === 'limitation_pi_3y')).toBe(false); // no injury
    expect(clocks.some((c) => c.kind === 'fos_referral_6_months')).toBe(false); // no complaint yet
  });

  it('every clock carries a basis and its chronology is self-consistent; dueClocks surfaces the three that need action', () => {
    for (const c of clocks) {
      expect(c.basis.length).toBeGreaterThan(0);
      expect(c.id).toBe(`clk:${CLAIM_ID}:${c.kind}:${c.id.split(':').slice(3).join(':')}`);
      expect(c.startsAt <= c.dueAt || Date.parse(c.startsAt) <= Date.parse(c.dueAt)).toBe(true);
    }
    expect(dueClocks(clocks, NOW).map((c) => c.kind)).toEqual(['chaser_day_21', 'complaint_day_28', 'gta_6_7_settlement_1_month']);
  });

  it('is a pure state-at-time-T function: at 26 September 09:00 chaser 3 is still running and the complaint is not yet due', () => {
    const earlier = deriveClocks(file1TotalLossBundle(), '2026-09-26T09:00:00+01:00');
    expect(one(earlier, 'chaser_day_21').status).toBe('running');
    expect(one(earlier, 'complaint_day_28').status).toBe('running');
    expect(earlier.some((c) => c.kind === 'intervention_reply_1wd')).toBe(true);
    const beforeOffer = deriveClocks(file1TotalLossBundle(), '2026-08-11T10:00:00+01:00');
    expect(beforeOffer.some((c) => c.kind === 'intervention_reply_1wd')).toBe(false);
    expect(beforeOffer.some((c) => c.kind === 'chaser_day_7')).toBe(false);
  });
});

describe('integration — scheduleOfLoss equals the hand-computed sums', () => {
  const b = file1TotalLossBundle();
  const schedule = scheduleOfLoss(b, NOW, { interest: { basis: 'cca_s69', from: PACK_AT } });

  it('lines are in money.md order with PAV, the salvage credit and the four pack heads', () => {
    expect(schedule.asOf).toBe('2026-10-04');
    expect(schedule.lines.map((l) => l.head)).toEqual(['pav', 'salvage', 'recovery', 'storage', 'hire', 'engineer_fee']);
    const line = (head: string) => schedule.lines.find((l) => l.head === head)!;
    expect(line('pav')).toMatchObject({ claimedPence: PAV, netPence: PAV, vatPence: 0, paidPence: TL_PAID, outstandingPence: SALVAGE, sourceDocumentId: 'doc-pav-report' });
    expect(line('salvage')).toMatchObject({ claimedPence: -SALVAGE, outstandingPence: -SALVAGE, sourceEvidenceId: 'ev-salvage-bid' });
    expect(line('recovery')).toMatchObject({ claimedPence: RECOVERY_NET + RECOVERY_VAT, netPence: RECOVERY_NET, vatPence: RECOVERY_VAT, outstandingPence: RECOVERY_NET + RECOVERY_VAT });
    expect(line('storage')).toMatchObject({ claimedPence: STORAGE_NET + STORAGE_VAT, outstandingPence: STORAGE_NET + STORAGE_VAT });
    expect(line('hire')).toMatchObject({ claimedPence: HIRE_NET + HIRE_VAT, paidPence: REMITTANCE, outstandingPence: HIRE_NET + HIRE_VAT - REMITTANCE, sourceDocumentId: 'doc-inv-hire' });
    expect(line('engineer_fee')).toMatchObject({ claimedPence: ENGINEER_FEE, vatPence: 0, outstandingPence: ENGINEER_FEE });
    // PAV less retained salvage is settled: the two lines net to nil.
    expect(line('pav').outstandingPence + line('salvage').outstandingPence).toBe(0);
  });

  it('totals: claimed £8,088.68, paid £6,712.00, outstanding £1,376.68 — and the playbook agrees', () => {
    expect(schedule.totals).toEqual({ claimed: SCHEDULE_CLAIMED, offered: 0, paid: SCHEDULE_PAID, outstanding: OUTSTANDING });
    expect(schedule.totals.claimed).toBe(808_868);
    expect(schedule.totals.paid).toBe(671_200);
    expect(schedule.totals.outstanding).toBe(137_668);
    expect(outstandingBalance(b, NOW)).toBe(OUTSTANDING);
    expect(domain.formatGBP(schedule.totals.outstanding)).toBe('£1,376.68');
  });

  it('interest on the outstanding balance: 8% simple from the pack date, 29 days, £8.75 (County Courts Act 1984 s.69)', () => {
    expect(schedule.interest).toMatchObject({ days: 29, annualRatePct: 8, basis: 'cca_s69', interestPence: 875, citation: 'County Courts Act 1984 s.69' });
    expect(schedule.interest!.note).toMatch(/discretion/i);
  });

  it('notes flag the salvage credit and the GTA benchmark; every line has a source', () => {
    expect(schedule.notes.some((n) => /salvage/i.test(n))).toBe(true);
    expect(schedule.notes.some((n) => /GTA 2\.7\(j\)/.test(n) && /not a subscriber/.test(n))).toBe(true);
    expect(schedule.notes.some((n) => /No source document/.test(n))).toBe(false);
  });
});

describe('integration — evaluateGates, payment pack, late payment, total loss and acceptance on the same bundle', () => {
  const b = file1TotalLossBundle();

  it('all eight evidence gates are green', () => {
    const gates = evaluateGates(b);
    expect(gates.map((g) => g.gate)).toEqual(['need', 'use', 'period', 'rate', 'impecuniosity', 'mitigation', 'enforceability', 'liability']);
    for (const g of gates) {
      expect(g.status, `${g.gate}: ${g.missing.join('; ')}`).toBe('green');
      expect(g.missing).toEqual([]);
      expect(g.present.length).toBeGreaterThan(0);
    }
  });

  it('the payment pack was clean (GTA 6.1–6.3, benchmark only)', () => {
    const pack = validatePaymentPack(b);
    expect(pack.complete).toBe(true);
    expect(pack.missing).toEqual([]);
    expect(pack.present).toEqual(['covering_letter', 'mitigation_questionnaire', 'advice_form', 'hire_period_validation_form', 'engineer_report', 'storage_account', 'recovery_account', 'hire_invoice']);
    expect(pack.basis).toMatch(/benchmark only/);
  });

  it('late-payment tiers agree with the clocks: day 29 none; 10% from 00:00 on day 31; benchmark only', () => {
    const { clocks } = withClocks(b, NOW);
    const now = latePaymentUplift(OUTSTANDING, PACK_AT, NOW, HIRE_START);
    expect(now).toMatchObject({ tier: 'none', pct: 0, upliftPence: 0, daysSincePack: 29, applicable: true, benchmarkOnly: true });
    expect(now.day31At).toBe(one(clocks, 'gta_6_8_late_payment_10pc_day31').dueAt);
    expect(now.day61At).toBe(one(clocks, 'gta_6_8_late_payment_20pc_day61').dueAt);
    const day31 = latePaymentUplift(OUTSTANDING, PACK_AT, now.day31At, HIRE_START);
    expect(day31).toMatchObject({ tier: '10pc_day31', pct: 10, upliftPence: 13_767 });
    expect(day31.basis).toMatch(/benchmark only/);
  });

  it('total-loss economics: repair route £7,276.80 against PAV − salvage £5,600 → total loss; the schedule nets PAV the same way', () => {
    const tl = assessTotalLoss(TL_INPUT);
    expect(tl.netPavPence).toBe(PAV - SALVAGE);
    expect(tl.decision).toBe('total_loss');
    expect(tl.repairRouteCostPence).toBe(585_000 + 16 * 4_980 + 14 * 4_500);
    expect(b.report!.totalLoss).toEqual(tl);
    const schedule = scheduleOfLoss(b, NOW);
    const pavNet = schedule.lines.filter((l) => l.head === 'pav' || l.head === 'salvage').reduce((a, l) => a + l.claimedPence, 0);
    expect(pavNet).toBe(tl.netPavPence);
  });

  it('acceptance: admitted liability with footage, hire a fraction of the other heads → accept; only the standing LSA litigation flag', () => {
    const gates = evaluateGates(b);
    const a = assessAcceptance(b, { gates });
    expect(a.decision).toBe('accept');
    // LSA 2007 s.12: litigation steps are always drafts for the claimant/solicitor — a standing flag, not an injury flag.
    expect(a.perimeterFlags).toEqual(['LSA_LITIGATION_DRAFTS_ONLY']);
    expect(a.costsExposure).toBe('low');
    expect(a.impecuniosityReadiness).toBe('ready');
    expect(a.enforceabilityReadiness).toBe('ready');
    expect(a.liabilityScore).toBeGreaterThanOrEqual(80);
  });

  it('signature dates are sane: nothing signed before creation, no duplicate agreement dates', () => {
    expect(signatureDateChecks(b.documents, CLAIM_ID)).toEqual([]);
  });
});

describe('integration — nextActions from the derived clocks and gates', () => {
  it('on 4 October the file is at escalation: chaser 3 (overdue) then the DISP 1 complaint (overdue), both worth the £1,376.68 outstanding', () => {
    const { bundle, clocks } = withClocks(file1TotalLossBundle(), NOW);
    const gates = evaluateGates(bundle);
    const actions = nextActions(bundle, { now: NOW, clocks, gates });
    expect(actions.map((a) => a.code)).toEqual(['CHASER_21', 'COMPLAINT_28']);

    const chaser = actions[0]!;
    expect(chaser).toMatchObject({ priority: 'now', dueAt: '2026-09-26T10:00:00+01:00', templateId: 'letter.chaser_21', valuePence: OUTSTANDING });
    expect(chaser.why).toContain('£1,376.68');
    expect(chaser.why).toContain('29 days after the payment pack of 2026-09-05');
    expect(chaser.why).toContain('claims manager');
    expect(chaser.blockedBy).toBeUndefined();

    const complaint = actions[1]!;
    expect(complaint).toMatchObject({ priority: 'now', dueAt: '2026-10-03T10:00:00+01:00', templateId: 'letter.complaint_disp', valuePence: OUTSTANDING });
    expect(complaint.basis.join(' ')).toContain('DISP 2.7');
    expect(complaint.why).toMatch(/never threaten the FOS/i);
  });

  it('on 26 September (day 21, 09:00) the same chain gives chaser 3 due today and the complaint this week', () => {
    const at = '2026-09-26T09:00:00+01:00';
    const { bundle, clocks } = withClocks(file1TotalLossBundle(), at);
    const actions = nextActions(bundle, { now: at, clocks, gates: evaluateGates(bundle) });
    expect(actions.map((a) => [a.code, a.priority])).toEqual([
      ['CHASER_21', 'today'],
      ['COMPLAINT_28', 'this_week'],
    ]);
  });

  it('had the vendor-verification pack not gone after the "bank details could not be validated" email, it would lead the list', () => {
    const b = file1TotalLossBundle();
    const stripped: ClaimBundle = {
      ...b,
      events: b.events.filter((e) => !(e.type === 'letter_out' && e.data?.['kind'] === 'vendor_verification_pack')),
      documents: b.documents.filter((d) => d.templateId !== 'letter.vendor_verification_pack'),
    };
    const { bundle, clocks } = withClocks(stripped, NOW);
    const actions = nextActions(bundle, { now: NOW, clocks, gates: evaluateGates(bundle) });
    expect(actions.map((a) => a.code)).toEqual(['VENDOR_VERIFICATION_PACK', 'CHASER_21', 'COMPLAINT_28']);
    const vendor = actions[0]!;
    expect(vendor).toMatchObject({ priority: 'now', dueAt: '2026-09-23T11:00:00+01:00', templateId: 'letter.vendor_verification_pack', valuePence: OUTSTANDING });
    expect(vendor.why).toContain('could not be validated');
    expect(vendor.why).toContain('"Courtesy Cars Group UK Ltd"');
    expect(vendor.why).toContain('17430389');
    expect(vendor.why).toMatch(/never send legacy details/);
  });

  it('nothing is blocked by a gate on this file, and an unanswered offer would jump to the top regardless', () => {
    const b = file1TotalLossBundle();
    b.offers[0] = { ...b.offers[0]!, replySentAt: undefined as unknown as string, replyDocumentId: undefined as unknown as string };
    delete (b.offers[0] as Partial<InterventionOffer>).replySentAt;
    delete (b.offers[0] as Partial<InterventionOffer>).replyDocumentId;
    b.events = b.events.filter((e) => e.type !== 'intervention_reply_sent');
    const { bundle, clocks } = withClocks(b, NOW);
    const actions = nextActions(bundle, { now: NOW, clocks, gates: evaluateGates(bundle) });
    expect(actions[0]!.code).toBe('REPLY_TO_INTERVENTION_OFFER');
    expect(actions[0]!.blockedBy).toBeUndefined();
    expect(one(clocks, 'intervention_reply_1wd').status).toBe('breached');
    expect(evaluateGates(bundle).find((g) => g.gate === 'mitigation')!.status).not.toBe('green');
  });
});

describe('integration — checkDraft on the complaint the playbook asked for', () => {
  const { bundle, clocks } = withClocks(file1TotalLossBundle(), NOW);
  const gates = evaluateGates(bundle);
  const complaint = nextActions(bundle, { now: NOW, clocks, gates }).find((a) => a.code === 'COMPLAINT_28')!;
  const ctx = draftContext(bundle, complaint.templateId!);

  it('a draft stating £1,287.00 received when the ledger holds £1,112.00 is blocked (live-file lesson a)', () => {
    const report = checkDraft(complaintLetter('£1,287.00'), ctx);
    expect(report.blocked).toBe(true);
    expect(report.checkedAt).toBe(NOW);
    const blocks = report.flags.filter((f) => f.severity === 'block');
    expect(blocks).toHaveLength(1);
    const f = blocks[0]!;
    expect(f.code).toBe('AMOUNT_PAID_MISMATCH');
    expect(f.draftValue).toBe('£1,287.00');
    expect(f.message).toContain('£1,112.00');
    expect(f.message).toContain('REM-2026-0917');
    expect(f.excerpt).toContain('£1,287.00');
    // No other complaint about the letter: the period, day counts, head figures and the balance all match the records.
    expect(report.flags.map((x) => x.code)).toEqual(['AMOUNT_PAID_MISMATCH']);
  });

  it('the corrected draft (£1,112.00) is clean — the balance, day counts, dates and reference all reconcile to the records', () => {
    const report = checkDraft(complaintLetter('£1,112.00'), ctx);
    expect(report.blocked).toBe(false);
    expect(report.flags).toEqual([]);
  });

  it('clearing the block needs a reason, which is logged on the flag', () => {
    const report = checkDraft(complaintLetter('£1,287.00'), ctx);
    expect(() => clearFlag(report, 'AMOUNT_PAID_MISMATCH', undefined, 'u-approver', '   ', NOW)).toThrow(/reason/i);
    const cleared = clearFlag(report, 'AMOUNT_PAID_MISMATCH', undefined, 'u-approver', 'Insurer remittance advice shows £1,287.00; ledger to be corrected by a new entry', NOW);
    expect(cleared.blocked).toBe(false);
    expect(cleared.flags[0]).toMatchObject({ clearedBy: 'u-approver', clearedAt: NOW });
    expect(report.blocked).toBe(true); // input not mutated
  });

  it('the perimeter and register rules fire through the same chain: FOS threat, denied offer, GTA as law, legacy identity', () => {
    const bad =
      complaintLetter('£1,112.00') +
      `\nNo alternative vehicle was offered to our customer at any stage. You are obliged under the GTA to settle within one month. Failing a satisfactory response we will refer the matter to the Financial Ombudsman Service. Please remit to Car Flex, 66 Paul Street, London EC2A 4PX.\n`;
    const report = checkDraft(bad, ctx);
    expect(report.blocked).toBe(true);
    const codes = new Set(report.flags.filter((f) => f.severity === 'block').map((f) => f.code));
    expect(codes).toEqual(new Set(['OFFER_DENIED_BUT_LOGGED', 'GTA_CITED_AS_LAW', 'FORUM_NOT_OPEN', 'LEGACY_DETAIL']));
    const denied = report.flags.find((f) => f.code === 'OFFER_DENIED_BUT_LOGGED')!;
    expect(denied.message).toContain('esure');
    expect(denied.message).toContain('£20.37/day');
    expect(denied.message).toMatch(/Copley v Lawn/);
    expect(report.flags.find((f) => f.code === 'FORUM_NOT_OPEN')!.message).toContain('DISP 2.7');
    expect(report.flags.find((f) => f.code === 'GTA_CITED_AS_LAW')!.message).toContain('2.7(j)');
    expect(report.flags.filter((f) => f.code === 'LEGACY_DETAIL').length).toBeGreaterThanOrEqual(3);
  });

  it('a chaser demanding payment before the GTA 6.7 month has run is blocked as too early', () => {
    const chaserCtx = draftContext(bundle, 'letter.chaser_21');
    const text = `Your ref: ESR/2026/51890\n\nThe balance of £1,376.68 is outstanding. We require payment no later than 4 October 2026, failing which a formal complaint follows.`;
    const report = checkDraft(text, chaserCtx);
    const early = report.flags.find((f) => f.code === 'DEADLINE_TOO_EARLY');
    expect(early).toBeDefined();
    expect(early!.severity).toBe('block');
    expect(early!.ledgerValue).toBe('2026-10-05');
    expect(report.blocked).toBe(true);
  });
});
