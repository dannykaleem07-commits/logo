/**
 * Test fixture shared by the quantum, acceptance, playbook, intake and fleet tests: a ClaimBundle built
 * from the brief's live-file figures (File 1: £1,287 stated vs £1,112 received; Golf S1 £49.80/day;
 * storage £45/day; recovery £90 + £3/mile + £25; engineer fee £285; esure offer £20.37/day).
 * Not part of the public API — imported by colocated tests only.
 */
import type {
  AccidentDetails,
  Claim,
  ClaimBundle,
  ClaimEvent,
  Clock,
  Evidence,
  FleetUnit,
  GateResult,
  GeneratedDocument,
  HireAgreement,
  InsurancePolicy,
  InterventionOffer,
  LedgerEntry,
  Party,
  PenaltyNotice,
  StorageRecord,
  Vehicle,
} from '../types.js';

/** Accident / FNOL instant: Monday 21 September 2026, 09:00 London (BST). */
export const T0 = '2026-09-21T09:00:00+01:00';

export const FILE1_ACCIDENT: AccidentDetails = {
  occurredAt: T0,
  location: 'A13 Newham Way, London',
  postcode: 'E6 5LF',
  circumstances:
    'I was stationary in lane 1 in slow traffic. The other car moved across from lane 2 without indicating and hit the back corner of my car on the driver side.',
  thirdPartyAccount: 'Third party says client moved into his lane.',
  highwayCodeRules: [133, 160],
  policeAttended: false,
  cctvAvailable: false,
  dashcamAvailable: false,
  independentWitness: false,
  injuries: false,
  roadworthyAfter: false,
  driveable: false,
};

export function party(id: string, name: string, extra: Partial<Party> = {}): Party {
  return { id, kind: 'individual', name, roles: ['claimant'], createdAt: T0, ...extra };
}

export function vehicle(id: string, registration: string, extra: Partial<Vehicle> = {}): Vehicle {
  return { id, registration, make: 'Volkswagen', model: 'Golf', odometer: [], ownership: 'client', lookups: [], createdAt: T0, ...extra };
}

export function claim(extra: Partial<Claim> = {}): Claim {
  return {
    id: 'claim-1',
    reference: 'CCG-2026-00012',
    status: 'accepted',
    openedAt: T0,
    accident: FILE1_ACCIDENT,
    liability: 'disputed',
    claimantId: 'p-claimant',
    clientVehicleId: 'v-client',
    thirdPartyIds: ['p-tp'],
    thirdPartyVehicleId: 'v-tp',
    atFaultInsurerId: 'p-insurer',
    atFaultInsurerRef: 'ESR/2026/44871',
    gtaSubscriber: false,
    linkedClaimIds: [],
    flags: [],
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

export function ledger(entries: Array<Partial<LedgerEntry> & Pick<LedgerEntry, 'head' | 'kind' | 'amountPence'>>): LedgerEntry[] {
  return entries.map((e, i) => ({
    id: `led-${i + 1}`,
    claimId: 'claim-1',
    date: '2026-10-01',
    description: `${e.kind} ${e.head}`,
    createdBy: 'system',
    createdAt: '2026-10-01T10:00:00+01:00',
    ...e,
  }));
}

export function event(type: ClaimEvent['type'], at: string, extra: Partial<ClaimEvent> = {}): ClaimEvent {
  return { id: `ev-${type}-${at}`, claimId: 'claim-1', type, at, recordedAt: at, summary: type, evidenceIds: [], createdBy: 'system', ...extra };
}

export function hire(extra: Partial<HireAgreement> = {}): HireAgreement {
  return {
    id: 'hire-1',
    claimId: 'claim-1',
    fleetUnitId: 'fleet-1',
    agreementNumber: 'CH-0001',
    startAt: '2026-09-22T10:00:00+01:00',
    endAt: '2026-10-02T10:00:00+01:00',
    endTrigger: 'repair_complete_24h',
    dailyRatePence: 4980, // £49.80/day Golf
    vatRate: 0.2,
    gtaGroup: 'S1',
    excessPence: 0,
    additionalDrivers: [],
    deliveredAt: '2026-09-22T10:00:00+01:00',
    collectedAt: '2026-10-02T10:00:00+01:00',
    odometerOut: 12_400,
    odometerIn: 12_655,
    signedAt: '2026-09-22T10:30:00+01:00',
    enforceability: {
      cancellationInfoProvidedAt: '2026-09-22T10:05:00+01:00',
      schedule3FormProvidedAt: '2026-09-22T10:05:00+01:00',
      expressRequestToStartAt: '2026-09-22T10:20:00+01:00',
      cca60fCompliant: true,
    },
    ...extra,
  };
}

export function storage(extra: Partial<StorageRecord> = {}): StorageRecord {
  return {
    id: 'sto-1',
    claimId: 'claim-1',
    location: 'CCGUK yard',
    startAt: '2026-09-21T14:00:00+01:00',
    endAt: '2026-09-27T12:00:00+01:00',
    endTrigger: 'report_issued',
    dailyRatePence: 4500, // £45/day
    vatRate: 0.2,
    ...extra,
  };
}

export function offer(extra: Partial<InterventionOffer> = {}): InterventionOffer {
  return {
    id: 'offer-1',
    claimId: 'claim-1',
    receivedAt: '2026-09-23T11:00:00+01:00',
    channel: 'phone',
    offerorName: 'esure',
    vehicleClassOffered: 'small hatchback',
    dailyRatePence: 2037, // £20.37/day (File 1)
    rateIncludesVat: true,
    terms: { excessPence: 50_000, mileageLimitPerDay: 100 },
    suitable: false,
    suitabilityReasons: ['excess £500', 'no delivery'],
    clientDecision: 'declined',
    clientReasons: 'needs estate for work equipment',
    clientDecisionAt: '2026-09-23T15:00:00+01:00',
    replySentAt: '2026-09-24T09:00:00+01:00',
    evidenceIds: [],
    ...extra,
  };
}

export function evidence(id: string, kind: Evidence['kind'], extra: Partial<Evidence> = {}): Evidence {
  return {
    id,
    claimId: 'claim-1',
    kind,
    filename: `${id}.bin`,
    mime: 'application/octet-stream',
    bytes: 1,
    sha256: 'a'.repeat(64),
    storagePath: `evidence/${id}`,
    uploadedAt: '2026-09-22T12:00:00+01:00',
    uploadedBy: 'u-handler',
    immutable: true,
    ...extra,
  };
}

export function document(id: string, templateId: string, extra: Partial<GeneratedDocument> = {}): GeneratedDocument {
  return {
    id,
    claimId: 'claim-1',
    templateId,
    templateVersion: '1.0.0',
    title: templateId,
    status: 'signed',
    html: '',
    sha256: 'b'.repeat(64),
    createdAt: '2026-09-22T10:00:00+01:00',
    createdBy: 'u-handler',
    dataSnapshot: {},
    ...extra,
  };
}

export function clock(kind: Clock['kind'], startsAt: string, dueAt: string, extra: Partial<Clock> = {}): Clock {
  return { id: `clk:claim-1:${kind}:${extra.sourceEventId ?? 'claim'}`, claimId: 'claim-1', kind, label: kind, basis: kind, startsAt, dueAt, status: 'running', ...extra };
}

export function gate(g: GateResult['gate'], status: GateResult['status'] = 'green', missing: string[] = []): GateResult {
  return { gate: g, status, missing, present: status === 'green' ? ['all items'] : [] };
}

export const ALL_GATES: GateResult['gate'][] = ['need', 'use', 'period', 'rate', 'impecuniosity', 'mitigation', 'enforceability', 'liability'];
export function greenGates(): GateResult[] {
  return ALL_GATES.map((g) => gate(g));
}

/** File 1 ledger: £1,344.60 claimed in four heads, £1,112.00 received → £232.60 outstanding on hire. */
export function file1Ledger(): LedgerEntry[] {
  return ledger([
    { head: 'hire', kind: 'claimed', amountPence: 49_800, vatPence: 9_960, description: 'Hire 10 days @ £49.80', sourceDocumentId: 'doc-hire-invoice' },
    { head: 'storage', kind: 'claimed', amountPence: 27_000, vatPence: 5_400, description: 'Storage 6 days @ £45', sourceDocumentId: 'doc-storage-invoice' },
    { head: 'recovery', kind: 'claimed', amountPence: 11_500, vatPence: 2_300, description: 'Recovery £90 + 0 miles + £25', sourceDocumentId: 'doc-recovery-invoice' },
    { head: 'engineer_fee', kind: 'claimed', amountPence: 28_500, description: 'Engineer fee £285', sourceDocumentId: 'doc-engineer-invoice' },
    { head: 'storage', kind: 'paid', amountPence: 32_400, date: '2026-10-05', description: 'Remittance esure', reference: 'REM-77' },
    { head: 'recovery', kind: 'paid', amountPence: 13_800, date: '2026-10-05', description: 'Remittance esure', reference: 'REM-77' },
    { head: 'engineer_fee', kind: 'paid', amountPence: 28_500, date: '2026-10-05', description: 'Remittance esure', reference: 'REM-77' },
    { head: 'hire', kind: 'paid', amountPence: 36_500, date: '2026-10-05', description: 'Remittance esure (part)', reference: 'REM-77' },
  ]);
}

/** A complete File 1 bundle: hire ended, every gate satisfiable, offer answered in time. */
export function file1Bundle(extra: Partial<ClaimBundle> = {}): ClaimBundle {
  return {
    claim: claim({ accident: { ...FILE1_ACCIDENT, cctvAvailable: true, policeReference: 'CAD 1234/210926' } }),
    claimant: party('p-claimant', 'Amir Hussain', { phone: '07700 900123', email: 'amir@example.com', dateOfBirth: '1988-04-12', drivingLicenceNumber: 'HUSSA804128AH9IJ', address: { line1: '14 Barking Road', town: 'London', postcode: 'E6 3BP' } }),
    vehicle: vehicle('v-client', 'AB12CDE'),
    thirdParties: [party('p-tp', 'Third Party', { roles: ['third_party'] })],
    thirdPartyVehicle: vehicle('v-tp', 'XY19ZZZ', { ownership: 'third_party', make: 'Ford', model: 'Focus' }),
    atFaultInsurer: party('p-insurer', 'esure Insurance Ltd', { kind: 'company', roles: ['insurer'] }),
    events: [
      event('fnol', T0),
      event('services_agreed', '2026-09-21T11:00:00+01:00'),
      event('ncaf_sent', '2026-09-21T16:00:00+01:00'),
      event('handling_ref_received', '2026-09-23T12:00:00+01:00'),
      event('engineer_instructed', '2026-09-22T09:00:00+01:00'),
      event('hire_started', '2026-09-22T10:00:00+01:00'),
      event('inspection', '2026-09-24T10:00:00+01:00'),
      event('report_issued', '2026-09-25T12:00:00+01:00'),
      event('repair_authorised', '2026-09-28T12:00:00+01:00'),
      event('repair_completed', '2026-10-01T15:00:00+01:00'),
      event('hire_ended', '2026-10-02T10:00:00+01:00'),
    ],
    ledger: file1Ledger(),
    offers: [offer()],
    hire: [hire()],
    storage: [storage()],
    recovery: [],
    evidence: [
      evidence('ev-odo-out', 'photo', { captureShot: 'odometer', capturedAt: '2026-09-22T10:10:00+01:00' }),
      evidence('ev-odo-in', 'photo', { captureShot: 'odometer', capturedAt: '2026-10-02T10:05:00+01:00' }),
      evidence('ev-bhr-1', 'screenshot', { description: 'BHR comparator: Enterprise Ilford, VW Golf, 23 Sep 2026' }),
      evidence('ev-bank-1', 'bank_statement'),
      evidence('ev-bank-2', 'bank_statement'),
      evidence('ev-bank-3', 'bank_statement'),
      evidence('ev-payslip', 'payslip'),
      evidence('ev-cctv', 'cctv', { description: 'Council CCTV Newham Way camera 14' }),
    ],
    documents: [
      document('doc-need', 'form.statement_of_need'),
      document('doc-means', 'form.statement_of_means'),
      document('doc-mq', 'form.mitigation_questionnaire'),
      document('doc-cha', 'agreement.credit_hire'),
    ],
    clocks: [],
    ...extra,
  };
}

/** Day 0: FNOL just taken, nothing else on the file. */
export function day0Bundle(extra: Partial<ClaimBundle> = {}): ClaimBundle {
  return file1Bundle({
    claim: claim({ status: 'fnol' }),
    events: [event('fnol', T0)],
    ledger: [],
    offers: [],
    hire: [],
    storage: [],
    evidence: [],
    documents: [],
    ...extra,
  });
}

/** File 3 archetype: lane-merge liability dispute, no independent evidence, hire dwarfing the other heads. */
export function file3Bundle(): ClaimBundle {
  const accident: AccidentDetails = {
    occurredAt: T0,
    location: 'A406 North Circular Road, slip road merge, London',
    circumstances:
      'We were both merging from the slip road onto the North Circular. I was slightly ahead and he came up the inside and we touched along the side of both cars as the lanes merged.',
    thirdPartyAccount: 'Third party says client cut across him while he was already in the lane.',
    policeAttended: false,
    cctvAvailable: false,
    dashcamAvailable: false,
    independentWitness: false,
    injuries: false,
    roadworthyAfter: true,
    driveable: true,
  };
  return file1Bundle({
    claim: claim({ status: 'triage', accident, liability: 'disputed' }),
    events: [event('fnol', T0)],
    ledger: ledger([
      { head: 'repair', kind: 'claimed', amountPence: 60_000, vatPence: 12_000, description: 'Repair estimate £720 gross' },
      { head: 'hire', kind: 'claimed', amountPence: 360_000, vatPence: 72_000, description: 'Projected hire 72 days @ £50' },
    ]),
    offers: [],
    hire: [hire({ endAt: undefined, collectedAt: undefined, odometerIn: undefined, signedAt: undefined, enforceability: { cca60fCompliant: false } })],
    storage: [],
    evidence: [],
    documents: [],
  });
}

// --- Fleet fixtures ------------------------------------------------------------------------------

export function fleetUnit(extra: Partial<FleetUnit> = {}): FleetUnit {
  return {
    id: 'fleet-1',
    vehicleId: 'v-fleet-1',
    declaredUses: ['credit_hire'],
    policyId: 'pol-1',
    dailyRatePence: 4980,
    gtaGroup: 'S1',
    keeperAddressOnV5C: { line1: 'Unit 4, Thames Road', town: 'Barking', postcode: 'IG11 0HZ' },
    keeperAddressCurrent: true,
    serviceDueDate: '2027-03-01',
    status: 'available',
    ...extra,
  };
}

export function fleetVehicle(extra: Partial<Vehicle> = {}): Vehicle {
  return vehicle('v-fleet-1', 'LC21GLF', {
    ownership: 'fleet',
    fuelType: 'petrol',
    co2Gkm: 125,
    euroStatus: 'EURO 6 AD',
    taxStatus: 'Taxed',
    taxDueDate: '2027-02-01',
    motStatus: 'Valid',
    motExpiryDate: '2027-05-14',
    ...extra,
  });
}

export function policy(extra: Partial<InsurancePolicy> = {}): InsurancePolicy {
  return {
    id: 'pol-1',
    insurerName: 'Collingwood Insurance',
    policyNumber: 'CW-CH-001',
    coveredUses: ['credit_hire'],
    startDate: '2026-04-01',
    endDate: '2027-03-31',
    ...extra,
  };
}

export function penalty(extra: Partial<PenaltyNotice> = {}): PenaltyNotice {
  return {
    id: 'pcn-1',
    fleetUnitId: 'fleet-1',
    kind: 'pcn_council',
    issuer: 'London Borough of Newham',
    noticeNumber: 'NW12345678',
    contraventionAt: '2026-09-25T14:12:00+01:00',
    receivedAt: '2026-10-01T09:00:00+01:00',
    amountPence: 13_000,
    discountDeadline: '2026-10-14',
    responseDeadline: '2026-10-28',
    hireAgreementId: 'hire-1',
    stage: 'received',
    documentIds: [],
    ...extra,
  };
}
