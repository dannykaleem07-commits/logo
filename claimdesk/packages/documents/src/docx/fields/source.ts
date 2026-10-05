/**
 * The merge source (design doc §B.2): the plain object the API builds from the claim bundle and repo lookups and hands
 * to the resolvers. Pure data — no functions — so it can be snapshotted with a generated document.
 *
 * `sampleMergeSource()` is a deterministic, deliberately rich fixture (claim CCG-2026-00012) used by the tests, the
 * `docx:mappings` report and the templates screen's "test fill". It carries no bank details: bank details only ever
 * come from Settings and are never invented (§H, §L).
 */
import type {
  Claim,
  ClaimEvent,
  Clock,
  DocumentStatus,
  EngineerReport,
  Estimate,
  EventType,
  FleetUnit,
  GtaRate,
  HireAgreement,
  InsurancePolicy,
  InterventionOffer,
  ISODate,
  ISODateTime,
  LedgerEntry,
  Party,
  PavAssessment,
  Pence,
  RecoveryRecord,
  StorageRecord,
  Vehicle,
  Verification
} from '@ccguk/domain';
import { brand } from '../../brand.js';
import type { RecipientRole } from '../../common.js';

export interface MergeCompany {
  registeredName: string;
  tradingName: string;
  companyNumber: string;
  registeredOffice: string;
  caseHandlerPhone: string;
  officePhone: string;
  email: string;
  website: string;
  director: { name: string; role: string };
  vatNumber?: string;
  icoRegistration?: string;
  bank?: { accountName: string; bankName?: string; sortCode: string; accountNumber: string };
  rateCard: { recoveryCalloutPence: Pence; perMilePence: Pence; adminPence: Pence; storageDailyPence: Pence; engineerFeePence: Pence; vatRate: number };
}

export interface MergeUser {
  id: string;
  name: string;
  roleLabel: string;
  email?: string;
}

export interface MergeHead {
  head: string;
  label: string;
  claimedPence: Pence;
  invoicedPence: Pence;
  receivedPence: Pence;
  outstandingPence: Pence;
  invoiceReference?: string;
}

export interface MergeDocumentRef {
  id: string;
  templateId: string;
  canonicalTemplateId: string;
  title: string;
  status: DocumentStatus;
  createdAt: ISODateTime;
  approvedAt?: ISODateTime;
  sentAt?: ISODateTime;
  recipientPartyId?: string;
  signedAt?: ISODateTime;
  subjectPartyId?: string;
  /** Additive: name of the approver (doc.reviewedBy on re-generation). */
  approvedByName?: string;
}

export interface MergeEvidenceRef {
  id: string;
  kind: string;
  filename: string;
  description?: string;
  capturedAt?: ISODateTime;
  uploadedAt: ISODateTime;
  exif?: { make?: string; model?: string; dateTimeOriginal?: string };
  sourceUrl?: string;
  verification?: Verification;
  /** Additive: capture tags such as 'release' / 'return' (06 photograph log). */
  tags?: string[];
}

export interface MergeHire {
  agreement: HireAgreement;
  fleetUnit?: FleetUnit;
  vehicle?: Vehicle;
  policy?: InsurancePolicy;
}

export interface MergeRecipient {
  partyId?: string;
  role?: RecipientRole;
  name: string;
  addressLines: string[];
  attention?: string;
  email?: string;
  theirReference?: string;
}

export interface MergeSource {
  now: ISODateTime;
  timeZone: 'Europe/London';
  company: MergeCompany;
  user: MergeUser;
  caseHandler?: MergeUser;
  claim: Claim;
  claimant: Party;
  driver?: Party;
  keeper?: Party;
  vehicle: Vehicle;
  thirdPartyDrivers: Party[];
  thirdPartyVehicle?: Vehicle;
  atFaultInsurer?: Party;
  ownInsurer?: Party;
  witnesses: Party[];
  witness?: Party;
  exhibits: MergeEvidenceRef[];
  hire?: MergeHire;
  hires: HireAgreement[];
  storage: StorageRecord[];
  recovery: RecoveryRecord[];
  report?: EngineerReport;
  engineer?: Party;
  estimate?: Estimate;
  pav?: PavAssessment;
  offers: InterventionOffer[];
  offer?: InterventionOffer;
  events: ClaimEvent[];
  clocks: Clock[];
  ledger: LedgerEntry[];
  heads: MergeHead[];
  evidence: MergeEvidenceRef[];
  documents: MergeDocumentRef[];
  gtaRates: GtaRate[];
  recipient?: MergeRecipient;
  /** documentData deadline() — never before a running clock. */
  responseDeadline?: ISODate;
  /** Additive: the party with role recovery_agent, if any (recovery.agentName). */
  recoveryAgent?: Party;
  /** Additive: the document being re-generated (post-event fields: signed/sent/reviewed dates). */
  thisDocument?: MergeDocumentRef;
}

// ---------------------------------------------------------------------------
// Sample (deterministic)
// ---------------------------------------------------------------------------

const CREATED = '2026-08-10T09:00:00Z';

function party(id: string, name: string, roles: Party['roles'], extra: Partial<Party> = {}): Party {
  return { id, kind: 'individual', name, roles, createdAt: CREATED, ...extra };
}

function event(id: string, type: string, at: ISODateTime, extra: Partial<ClaimEvent> = {}): ClaimEvent {
  return { id, claimId: 'c-12', type: type as EventType, at, recordedAt: at, summary: type.replace(/_/g, ' '), evidenceIds: [], createdBy: 'system', ...extra };
}

function ledger(id: string, head: LedgerEntry['head'], kind: LedgerEntry['kind'], amountPence: Pence, date: ISODate, reference?: string): LedgerEntry {
  return { id, claimId: 'c-12', head, kind, amountPence, date, description: `${head} ${kind}`, createdBy: 'system', createdAt: `${date}T12:00:00Z`, ...(reference ? { reference } : {}) };
}

function clock(id: string, kind: Clock['kind'], startsAt: ISODateTime, dueAt: ISODateTime): Clock {
  return { id, claimId: 'c-12', kind, label: kind, basis: 'sample', startsAt, dueAt, status: 'running' };
}

/** Deterministic rich fixture: claim CCG-2026-00012 (see the module comment). Every call returns a fresh object. */
export function sampleMergeSource(): MergeSource {
  const user: MergeUser = { id: 'u-handler', name: 'D. Kaleem', roleLabel: 'Claims Manager', email: brand.company.claimsEmail };
  const claimant = party('p-claimant', 'Priya Patel', ['claimant', 'driver'], {
    dateOfBirth: '1988-04-17',
    address: { line1: '12 High Street', town: 'Hounslow', postcode: 'TW3 1AB' },
    phone: '07700 900123',
    email: 'priya.patel@example.com',
    drivingLicenceNumber: 'PATEL804178P99AB'
  });
  const tpDriver = party('p-tp', 'Mark Jones', ['third_party_driver'], {
    address: { line1: '8 Station Road', town: 'Feltham', postcode: 'TW13 4AA' },
    phone: '07700 900456'
  });
  const witness = party('p-wit', 'Sarah Lee', ['witness'], {
    dateOfBirth: '1979-11-02',
    address: { line1: '3 Bath Road', town: 'Hounslow', postcode: 'TW4 7AB' },
    phone: '07700 900789',
    email: 'sarah.lee@example.com',
    notes: 'Relationship to the claimant: none — passer-by'
  });
  const atFaultInsurer: Party = {
    id: 'p-tpins',
    kind: 'company',
    name: 'Example Insurance plc',
    address: { line1: '1 Example Way', town: 'Example Town', postcode: 'EX1 1AA' },
    email: 'claims@example-insurance.co.uk',
    roles: ['insurer'],
    createdAt: CREATED
  };
  const ownInsurer: Party = { id: 'p-ownins', kind: 'company', name: 'Northern Example Insurance Ltd', roles: ['insurer'], createdAt: CREATED };
  const engineer = party('p-eng', 'Alan Assessor', ['engineer']);

  const vehicle: Vehicle = {
    id: 'v-client',
    registration: 'AB12CDE',
    vin: 'WVWZZZCDZMW123456',
    make: 'Volkswagen',
    model: 'Golf',
    variant: 'Life 1.5 TSI',
    bodyType: 'hatchback',
    yearOfManufacture: 2019,
    monthOfFirstRegistration: '2019-03',
    fuelType: 'petrol',
    transmission: 'manual',
    colour: 'blue',
    engineCapacityCc: 1498,
    odometer: [
      { source: 'client', date: '2026-08-01', miles: 45210 },
      { source: 'accident_report', date: '2026-08-09', miles: 45390 },
      { source: 'collection', date: '2026-08-10', miles: 45395 },
      { source: 'engineer', date: '2026-08-14', miles: 45402 }
    ],
    gtaGroup: 'M',
    ownership: 'client',
    lookups: [],
    createdAt: CREATED
  };
  const tpVehicle: Vehicle = { id: 'v-tp', registration: 'CD34EFG', make: 'Ford', model: 'Focus', colour: 'silver', odometer: [], ownership: 'third_party', lookups: [], createdAt: CREATED };
  const hireVehicle: Vehicle = {
    id: 'v-hire',
    registration: 'EF56GHK',
    vin: 'SB1KZ3JE00E123456',
    make: 'Toyota',
    model: 'Corolla',
    variant: 'Icon 1.8 Hybrid',
    fuelType: 'hybrid',
    transmission: 'automatic',
    colour: 'white',
    engineCapacityCc: 1798,
    odometer: [],
    ownership: 'fleet',
    lookups: [],
    createdAt: CREATED
  };
  const policy: InsurancePolicy = { id: 'pol-1', insurerName: 'Fleet Example Insurance Ltd', policyNumber: 'FLT-2026-001', coveredUses: ['credit_hire', 'self_drive'], startDate: '2026-01-01', endDate: '2026-12-31' };
  const fleetUnit: FleetUnit = { id: 'fu-1', vehicleId: 'v-hire', declaredUses: ['credit_hire'], policyId: 'pol-1', dailyRatePence: 8900, gtaGroup: 'N', keeperAddressCurrent: true, status: 'on_hire' };
  const agreement: HireAgreement = {
    id: 'h-1',
    claimId: 'c-12',
    fleetUnitId: 'fu-1',
    agreementNumber: 'CCG-H-000123',
    startAt: '2026-08-11T09:00:00Z',
    dailyRatePence: 8900,
    vatRate: 0,
    gtaGroup: 'N',
    excessPence: 50000,
    additionalDrivers: [],
    deliveredAt: '2026-08-11T10:15:00Z',
    odometerOut: 12034,
    signedAt: '2026-08-11T09:20:00Z',
    enforceability: { cancellationInfoProvidedAt: '2026-08-11T09:10:00Z', cca60fCompliant: true }
  };
  const storageLocation = 'Secure compound, Unit 4, Silverdale Road, Hayes UB3 3BN';
  const claim: Claim = {
    id: 'c-12',
    reference: 'CCG-2026-00012',
    status: 'hire_active',
    openedAt: '2026-08-10T09:00:00Z',
    accident: {
      occurredAt: '2026-08-09T13:30:00Z',
      location: 'Junction of London Road and Bath Road, Hounslow',
      postcode: 'TW3 1JA',
      circumstances: 'I was stopped at the red light on London Road when the Ford behind me drove into the back of my car.',
      policeAttended: true,
      policeReference: 'MPS-2026-0815',
      injuries: false,
      airbagsDeployed: false,
      driveable: false
    },
    liability: 'admitted',
    claimantId: 'p-claimant',
    clientVehicleId: 'v-client',
    thirdPartyIds: ['p-tp', 'p-wit'],
    thirdPartyVehicleId: 'v-tp',
    atFaultInsurerId: 'p-tpins',
    atFaultInsurerRef: 'EXI/778/2026',
    clientInsurerId: 'p-ownins',
    clientPolicyNumber: 'POL-778812',
    handlerId: 'u-handler',
    gtaSubscriber: false,
    linkedClaimIds: [],
    flags: [],
    createdAt: CREATED,
    updatedAt: '2026-08-20T09:00:00Z'
  };
  const storage: StorageRecord = { id: 's-1', claimId: 'c-12', location: storageLocation, startAt: '2026-08-10T12:00:00Z', endAt: '2026-08-24T15:00:00Z', endTrigger: 'collected', dailyRatePence: 4500, vatRate: 0 };
  const recovery: RecoveryRecord = {
    id: 'r-1',
    claimId: 'c-12',
    at: '2026-08-10T11:00:00Z',
    fromLocation: 'London Road, Hounslow TW3 1JA',
    toLocation: storageLocation,
    calloutPence: 9000,
    loadedMiles: 12,
    perLoadedMilePence: 300,
    adminPence: 2500,
    vatRate: 0,
    evidenceIds: ['e-jobsheet']
  };
  const report: EngineerReport = {
    id: 'er-1',
    claimId: 'c-12',
    vehicleId: 'v-client',
    engineerPartyId: 'p-eng',
    engineerQualifications: 'IAEA',
    instructedBy: 'Courtesy Cars Group UK Ltd',
    instructedAt: '2026-08-12T09:00:00Z',
    inspectionAt: '2026-08-14T11:00:00Z',
    inspectionPlace: storageLocation,
    inspectionBasis: 'physical',
    odometerMiles: 45402,
    preAccidentCondition: 'Good, consistent with age and mileage',
    damageDescription: 'Rear bumper, boot lid and rear panel',
    consistentWithCircumstances: true,
    roadworthy: false,
    roadworthyReason: 'Rear light cluster broken',
    totalLoss: {
      repairNetPence: 245000,
      projectedRepairWorkingDays: 6,
      projectedHireDays: 10,
      hireDailyRatePence: 8900,
      projectedHirePence: 89000,
      projectedStoragePence: 0,
      pavPence: 1150000,
      salvagePence: 230000,
      salvageSource: 'bid',
      repairRouteCostPence: 334000,
      totalLossRouteCostPence: 920000,
      decision: 'repair',
      marginPence: 586000,
      notes: []
    },
    photoEvidenceIds: [],
    forCourt: false,
    feePence: 28500,
    issuedAt: '2026-08-15T16:00:00Z',
    documentId: 'd-report0001'
  };
  const estimate: Estimate = {
    id: 'est-1',
    claimId: 'c-12',
    vehicleId: 'v-client',
    lines: [],
    labourRatePence: 5500,
    paintRatePence: 5500,
    paintMaterialsMethod: 'per_hour',
    vatRate: 0.2,
    totals: { labourPence: 88000, partsPence: 101000, paintLabourPence: 33000, paintMaterialsPence: 23000, otherPence: 0, preExistingExcludedPence: 0, netPence: 245000, vatPence: 49000, grossPence: 294000, labourHours: 16, paintHours: 6 },
    createdAt: '2026-08-15T12:00:00Z'
  };
  const pav: PavAssessment = {
    id: 'pav-1',
    claimId: 'c-12',
    subject: { vehicleId: 'v-client', registration: 'AB12CDE', make: 'Volkswagen', model: 'Golf', year: 2019, odometerAtLoss: 45390, odometerBasis: 'reading', conditionGrade: 'good', conditionAdjustmentPct: 0 },
    comparables: [],
    perMilePence: 5,
    perMileSource: 'fallback_band',
    medianPence: 1150000,
    iqrLowPence: 1100000,
    iqrHighPence: 1200000,
    pavPence: 1150000,
    reasoning: 'Sample',
    createdAt: '2026-08-15T12:00:00Z'
  };
  const offer1: InterventionOffer = {
    id: 'o-1',
    claimId: 'c-12',
    receivedAt: '2026-08-12T10:00:00Z',
    channel: 'phone',
    offerorPartyId: 'p-tpins',
    offerorName: 'J. Brown',
    vehicleClassOffered: 'Group C',
    terms: { excessPence: 25000, mileageLimitPerDay: 100, durationStated: 'Until repairs are complete', otherTerms: 'Client to collect the car from the depot' },
    suitable: false,
    suitabilityReasons: ['Depot 30 miles away'],
    clientDecision: 'declined',
    clientReasons: 'I work early shifts and cannot get to the depot 30 miles away.',
    clientDecisionAt: '2026-08-12T13:00:00Z',
    replySentAt: '2026-08-12T15:00:00Z',
    evidenceIds: ['e-offer']
  };
  const offer2: InterventionOffer = { id: 'o-2', claimId: 'c-12', receivedAt: '2026-08-19T11:00:00Z', channel: 'via_client', offerorName: 'Example Insurance plc', terms: {}, suitabilityReasons: [], clientDecision: 'pending', evidenceIds: [] };
  const events: ClaimEvent[] = [
    event('ev-fnol', 'fnol', '2026-08-10T09:00:00Z', { recordedAt: '2026-08-10T09:05:00Z', createdBy: 'u-handler', data: { thirdPartyPolicyNumber: 'TPX-445566', services: ['recovery', 'storage', 'engineering', 'credit_hire'] } }),
    event('ev-services', 'services_agreed', '2026-08-10T09:30:00Z', { data: { services: ['recovery', 'storage', 'engineering', 'credit_hire'] } }),
    event('ev-ncaf', 'ncaf_sent', '2026-08-10T16:00:00Z', { data: { recipientPartyId: 'p-tpins' } }),
    event('ev-cctv', 'cctv_request_sent', '2026-08-10T14:00:00Z', { data: { source: 'council' } }),
    event('ev-sr1', 'storage_reason', '2026-08-10T12:00:00Z', { data: { from: '2026-08-10', to: '2026-08-15', reason: 'Awaiting engineer inspection', evidence: 'Engineer instruction 12/08/2026' } }),
    event('ev-sr2', 'storage_reason', '2026-08-16T09:00:00Z', { data: { from: '2026-08-16', to: '2026-08-24', reason: 'Awaiting repair authority from the insurer', evidence: 'Chaser emails' } }),
    event('ev-rep-client', 'letter_out', '2026-08-16T10:00:00Z', { documentId: 'd-report0001', data: { recipientPartyId: 'p-claimant' } }),
    event('ev-rep-ins', 'email_out', '2026-08-17T10:00:00Z', { documentId: 'd-report0001', data: { recipientPartyId: 'p-tpins' } }),
    event('ev-quote', 'email_in', '2026-08-18T11:20:00Z', { attributableTo: 'insurer', data: { quote: 'We will not pay hire beyond 14 days.', who: 'Example Insurance plc' } }),
    event('ev-liab', 'liability_admitted', '2026-08-20T09:00:00Z')
  ];
  const evidence: MergeEvidenceRef[] = [
    { id: 'e-licence', kind: 'licence', filename: 'licence-front.jpg', uploadedAt: '2026-08-10T09:10:00Z', verification: { status: 'verified', verifiedBy: 'u-handler', verifiedAt: '2026-08-10' } },
    { id: 'e-photo1', kind: 'photo', filename: 'rear-damage-1.jpg', uploadedAt: '2026-08-10T12:00:00Z', capturedAt: '2026-08-09T14:05:00Z', exif: { make: 'Apple', model: 'iPhone 13', dateTimeOriginal: '2026-08-09T14:05:00+01:00' } },
    { id: 'e-photo2', kind: 'photo', filename: 'rear-damage-2.jpg', uploadedAt: '2026-08-10T12:00:00Z' },
    { id: 'e-rel1', kind: 'photo', filename: 'release-front.jpg', uploadedAt: '2026-08-11T10:20:00Z', tags: ['release'] },
    { id: 'e-rel2', kind: 'photo', filename: 'release-rear.jpg', uploadedAt: '2026-08-11T10:21:00Z', tags: ['release'] },
    { id: 'e-offer', kind: 'correspondence', filename: 'Example Insurance offer 12-08-2026.pdf', uploadedAt: '2026-08-12T10:30:00Z' },
    { id: 'e-jobsheet', kind: 'document', filename: 'recovery-job-sheet.pdf', description: 'Recovery job sheet', uploadedAt: '2026-08-10T13:00:00Z' },
    { id: 'e-bank', kind: 'bank_statement', filename: 'bank-statement-july.pdf', uploadedAt: '2026-08-13T10:00:00Z' },
    { id: 'e-report', kind: 'engineer_report', filename: 'engineer-report.pdf', uploadedAt: '2026-08-15T16:30:00Z' },
    { id: 'e-invoice', kind: 'invoice', filename: 'INV-REC-0012.pdf', uploadedAt: '2026-08-25T10:00:00Z' }
  ];
  const documents: MergeDocumentRef[] = [
    { id: 'd-01signed', templateId: 'agreement.ccguk_01_customer_loa', canonicalTemplateId: 'agreement.ccguk_01_customer_loa', title: 'Customer Agreement & Letter of Authority', status: 'signed', createdAt: '2026-08-10T09:15:00Z', signedAt: '2026-08-10T09:40:00Z', recipientPartyId: 'p-claimant' },
    { id: 'd-02signed', templateId: 'agreement.ccguk_02_recovery_storage_engineering', canonicalTemplateId: 'agreement.ccguk_02_recovery_storage_engineering', title: 'Recovery, Storage & Engineering Pack', status: 'signed', createdAt: '2026-08-10T09:16:00Z', signedAt: '2026-08-10T09:45:00Z', recipientPartyId: 'p-claimant' },
    { id: 'd-06abcdef99', templateId: 'form.ccguk_06_handover_condition', canonicalTemplateId: 'form.ccguk_06_handover_condition', title: 'Vehicle Handover & Condition Report', status: 'signed', createdAt: '2026-08-11T10:00:00Z', signedAt: '2026-08-11T10:30:00Z' },
    { id: 'd-report0001', templateId: 'report.engineer', canonicalTemplateId: 'report.engineer', title: 'Engineer report', status: 'sent', createdAt: '2026-08-15T16:00:00Z', sentAt: '2026-08-16T10:00:00Z' }
  ];
  return {
    now: '2026-10-04T08:30:00Z',
    timeZone: 'Europe/London',
    company: {
      registeredName: brand.company.registeredName,
      tradingName: brand.company.tradingName,
      companyNumber: brand.company.companyNumber,
      registeredOffice: brand.company.registeredOffice,
      caseHandlerPhone: brand.company.caseHandlerPhone,
      officePhone: brand.company.officePhone,
      email: brand.company.claimsEmail,
      website: brand.company.website,
      director: { name: brand.company.director.name, role: brand.company.director.role },
      rateCard: { recoveryCalloutPence: 9000, perMilePence: 300, adminPence: 2500, storageDailyPence: 4500, engineerFeePence: 28500, vatRate: 0 }
    },
    user,
    caseHandler: { ...user },
    claim,
    claimant,
    vehicle,
    thirdPartyDrivers: [tpDriver],
    thirdPartyVehicle: tpVehicle,
    atFaultInsurer,
    ownInsurer,
    witnesses: [witness],
    witness,
    exhibits: [evidence[1]!],
    hire: { agreement, fleetUnit, vehicle: hireVehicle, policy },
    hires: [agreement],
    storage: [storage],
    recovery: [recovery],
    report,
    engineer,
    estimate,
    pav,
    offers: [offer1, offer2],
    offer: offer1,
    events,
    clocks: [
      clock('k-cctv', 'cctv_preservation', '2026-08-10T09:00:00Z', '2026-09-04T09:00:00Z'),
      clock('k-ch7', 'chaser_day_7', '2026-08-10T16:00:00Z', '2026-08-17T16:00:00Z'),
      clock('k-ch14', 'chaser_day_14', '2026-08-10T16:00:00Z', '2026-08-24T16:00:00Z'),
      clock('k-icobs', 'icobs_8_2_6_three_months', '2026-08-10T16:00:00Z', '2026-11-10T16:00:00Z'),
      clock('k-lim', 'limitation_tort_6y', '2026-08-09T13:30:00Z', '2032-08-09T13:30:00Z')
    ],
    ledger: [
      ledger('l-1', 'hire', 'claimed', 445000, '2026-09-30'),
      ledger('l-2', 'recovery', 'invoiced', 15100, '2026-08-25', 'INV-REC-0012'),
      ledger('l-3', 'storage', 'invoiced', 67500, '2026-08-25', 'INV-STO-0012'),
      ledger('l-4', 'engineer_fee', 'invoiced', 28500, '2026-08-25', 'INV-ENG-0012')
    ],
    heads: [
      { head: 'hire', label: 'Credit hire', claimedPence: 445000, invoicedPence: 0, receivedPence: 0, outstandingPence: 445000 },
      { head: 'recovery', label: 'Recovery', claimedPence: 15100, invoicedPence: 15100, receivedPence: 0, outstandingPence: 15100, invoiceReference: 'INV-REC-0012' },
      { head: 'storage', label: 'Storage', claimedPence: 67500, invoicedPence: 67500, receivedPence: 0, outstandingPence: 67500, invoiceReference: 'INV-STO-0012' },
      { head: 'engineer_fee', label: 'Engineer fee', claimedPence: 28500, invoicedPence: 28500, receivedPence: 0, outstandingPence: 28500, invoiceReference: 'INV-ENG-0012' }
    ],
    evidence,
    documents,
    gtaRates: [
      {
        group: 'M',
        description: 'Sample fixture group M',
        dailyRatePence: 6512,
        period: '2026-27',
        effectiveFrom: '2026-07-01',
        effectiveTo: '2027-06-30',
        verification: { status: 'verified', sourceUrl: 'https://example.invalid/sample-gta-rates', sourceNote: 'Sample fixture — not a real GTA figure', verifiedAt: '2026-07-02', verifiedBy: 'u-handler' }
      },
      { group: 'N', description: 'Sample fixture group N', dailyRatePence: 7120, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30', verification: { status: 'unverified', sourceNote: 'Sample fixture — not a real GTA figure' } }
    ],
    recipient: {
      partyId: 'p-tpins',
      role: 'at_fault_insurer',
      name: 'Example Insurance plc',
      attention: 'Third Party Claims Team',
      addressLines: ['Claims Department', '1 Example Way', 'Example Town EX1 1AA'],
      email: 'claims@example-insurance.co.uk',
      theirReference: 'EXI/778/2026'
    },
    responseDeadline: '2026-10-18'
  };
}
