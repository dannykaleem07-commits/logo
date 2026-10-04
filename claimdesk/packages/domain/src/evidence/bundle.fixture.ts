/**
 * Test fixture: a minimal but complete ClaimBundle built from the brief's live-file figures
 * (File 1: £1,287 stated vs £1,112 received; storage £45/day; Golf £49.80/day S1; offer £20.37/day).
 * Not part of the public API — imported by colocated tests only.
 */
import type {
  Claim,
  ClaimBundle,
  ClaimEvent,
  Clock,
  Evidence,
  GeneratedDocument,
  HireAgreement,
  InterventionOffer,
  LedgerEntry,
  Party,
  StorageRecord,
  Vehicle
} from '../types.js';

export const T0 = '2026-09-20T09:00:00Z'; // accident / FNOL day

export function fixtureParty(id: string, name: string, extra: Partial<Party> = {}): Party {
  return { id, kind: 'individual', name, roles: ['claimant'], createdAt: T0, ...extra };
}

export function fixtureVehicle(id: string, registration: string, extra: Partial<Vehicle> = {}): Vehicle {
  return {
    id,
    registration,
    make: 'Volkswagen',
    model: 'Golf',
    odometer: [],
    ownership: 'client',
    lookups: [],
    createdAt: T0,
    ...extra
  };
}

export function fixtureClaim(extra: Partial<Claim> = {}): Claim {
  return {
    id: 'claim-1',
    reference: 'CCG-2026-00012',
    status: 'payment_pack',
    openedAt: T0,
    accident: {
      occurredAt: T0,
      location: 'A13 Newham Way, London',
      circumstances: 'Client stationary in traffic in lane 1; third party changed lane from lane 2 and struck the offside rear quarter.',
      thirdPartyAccount: 'Third party says client moved into his lane.',
      highwayCodeRules: [133, 160],
      policeAttended: false,
      cctvAvailable: false,
      dashcamAvailable: false,
      independentWitness: false,
      injuries: false,
      roadworthyAfter: false,
      driveable: false
    },
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
    ...extra
  };
}

export function fixtureLedger(entries: Array<Partial<LedgerEntry> & Pick<LedgerEntry, 'head' | 'kind' | 'amountPence'>>): LedgerEntry[] {
  return entries.map((e, i) => ({
    id: `led-${i + 1}`,
    claimId: 'claim-1',
    date: '2026-10-01',
    description: `${e.kind} ${e.head}`,
    createdBy: 'system',
    createdAt: '2026-10-01T10:00:00Z',
    ...e
  }));
}

export function fixtureEvent(type: ClaimEvent['type'], at: string, extra: Partial<ClaimEvent> = {}): ClaimEvent {
  return { id: `ev-${type}-${at}`, claimId: 'claim-1', type, at, recordedAt: at, summary: type, evidenceIds: [], createdBy: 'system', ...extra };
}

export function fixtureHire(extra: Partial<HireAgreement> = {}): HireAgreement {
  return {
    id: 'hire-1',
    claimId: 'claim-1',
    fleetUnitId: 'fleet-1',
    agreementNumber: 'CH-0001',
    startAt: '2026-09-21T10:00:00Z',
    endAt: '2026-10-01T10:00:00Z',
    endTrigger: 'repair_complete_24h',
    dailyRatePence: 4980, // £49.80/day Golf
    vatRate: 0.2,
    gtaGroup: 'S1',
    excessPence: 0,
    additionalDrivers: [],
    deliveredAt: '2026-09-21T10:00:00Z',
    collectedAt: '2026-10-01T10:00:00Z',
    odometerOut: 12_400,
    odometerIn: 12_655,
    signedAt: '2026-09-21T10:30:00Z',
    enforceability: {
      cancellationInfoProvidedAt: '2026-09-21T10:05:00Z',
      schedule3FormProvidedAt: '2026-09-21T10:05:00Z',
      expressRequestToStartAt: '2026-09-21T10:20:00Z',
      cca60fCompliant: true
    },
    ...extra
  };
}

export function fixtureStorage(extra: Partial<StorageRecord> = {}): StorageRecord {
  return {
    id: 'sto-1',
    claimId: 'claim-1',
    location: 'CCGUK yard',
    startAt: '2026-09-20T14:00:00Z',
    endAt: '2026-09-26T12:00:00Z',
    endTrigger: 'report_issued',
    dailyRatePence: 4500, // £45/day
    vatRate: 0.2,
    ...extra
  };
}

export function fixtureOffer(extra: Partial<InterventionOffer> = {}): InterventionOffer {
  return {
    id: 'offer-1',
    claimId: 'claim-1',
    receivedAt: '2026-09-22T11:00:00Z',
    channel: 'phone',
    offerorName: 'esure',
    vehicleClassOffered: 'small hatchback',
    dailyRatePence: 2037, // £20.37/day (File 1)
    rateIncludesVat: true,
    terms: { excessPence: 50000, mileageLimitPerDay: 100 },
    suitable: false,
    suitabilityReasons: ['excess £500', 'no delivery'],
    clientDecision: 'declined',
    clientReasons: 'needs estate for work equipment',
    clientDecisionAt: '2026-09-22T15:00:00Z',
    replySentAt: '2026-09-23T09:00:00Z',
    evidenceIds: [],
    ...extra
  };
}

export function fixtureEvidence(id: string, kind: Evidence['kind'], extra: Partial<Evidence> = {}): Evidence {
  return {
    id,
    claimId: 'claim-1',
    kind,
    filename: `${id}.bin`,
    mime: 'application/octet-stream',
    bytes: 1,
    sha256: 'a'.repeat(64),
    storagePath: `evidence/${id}`,
    uploadedAt: '2026-09-21T12:00:00Z',
    uploadedBy: 'u-handler',
    immutable: true,
    ...extra
  };
}

export function fixtureDocument(id: string, templateId: string, extra: Partial<GeneratedDocument> = {}): GeneratedDocument {
  return {
    id,
    claimId: 'claim-1',
    templateId,
    templateVersion: '1.0.0',
    title: templateId,
    status: 'signed',
    html: '',
    sha256: 'b'.repeat(64),
    createdAt: '2026-09-21T10:00:00Z',
    createdBy: 'u-handler',
    dataSnapshot: {},
    ...extra
  };
}

export function fixtureClock(kind: Clock['kind'], startsAt: string, dueAt: string, extra: Partial<Clock> = {}): Clock {
  return { id: `clk-${kind}`, claimId: 'claim-1', kind, label: kind, basis: kind, startsAt, dueAt, status: 'running', ...extra };
}

/** A "green file": every gate satisfied. Tests knock items out to exercise amber/red. */
export function greenBundle(): ClaimBundle {
  const claim = fixtureClaim({ accident: { ...fixtureClaim().accident, cctvAvailable: true, policeReference: 'CAD 1234/200926' } });
  return {
    claim,
    claimant: fixtureParty('p-claimant', 'Amir Hussain', { phone: '07700 900123', email: 'amir@example.com' }),
    vehicle: fixtureVehicle('v-client', 'AB12CDE'),
    thirdParties: [fixtureParty('p-tp', 'Third Party', { roles: ['third_party'] })],
    thirdPartyVehicle: fixtureVehicle('v-tp', 'XY19ZZZ', { ownership: 'third_party', make: 'Ford', model: 'Focus' }),
    atFaultInsurer: fixtureParty('p-insurer', 'esure Insurance Ltd', { kind: 'company', roles: ['insurer'] }),
    events: [
      fixtureEvent('fnol', T0),
      fixtureEvent('engineer_instructed', '2026-09-21T09:00:00Z'),
      fixtureEvent('inspection', '2026-09-23T10:00:00Z'),
      fixtureEvent('report_issued', '2026-09-24T12:00:00Z'),
      fixtureEvent('repair_authorised', '2026-09-25T12:00:00Z')
    ],
    ledger: fixtureLedger([
      { head: 'hire', kind: 'claimed', amountPence: 49_800, vatPence: 9_960, description: 'Hire 10 days @ £49.80' },
      { head: 'storage', kind: 'claimed', amountPence: 27_000, vatPence: 5_400, description: 'Storage 6 days @ £45' },
      { head: 'recovery', kind: 'claimed', amountPence: 11_500, vatPence: 2_300, description: 'Recovery £90 + 0 miles + £25' },
      { head: 'engineer_fee', kind: 'claimed', amountPence: 28_500, description: 'Engineer fee £285' },
      { head: 'storage', kind: 'paid', amountPence: 111_200, description: 'Remittance esure', reference: 'REM-77' }
    ]),
    offers: [fixtureOffer()],
    hire: [fixtureHire()],
    storage: [fixtureStorage()],
    recovery: [],
    evidence: [
      fixtureEvidence('ev-odo-out', 'photo', { captureShot: 'odometer', capturedAt: '2026-09-21T10:10:00Z' }),
      fixtureEvidence('ev-odo-in', 'photo', { captureShot: 'odometer', capturedAt: '2026-10-01T10:05:00Z' }),
      fixtureEvidence('ev-bhr-1', 'screenshot', { description: 'BHR comparator: Enterprise Ilford, VW Golf, 22 Sep 2026' }),
      fixtureEvidence('ev-bank-1', 'bank_statement'),
      fixtureEvidence('ev-bank-2', 'bank_statement'),
      fixtureEvidence('ev-bank-3', 'bank_statement'),
      fixtureEvidence('ev-payslip', 'payslip'),
      fixtureEvidence('ev-cctv', 'cctv', { description: 'Council CCTV Newham Way camera 14' })
    ],
    documents: [
      fixtureDocument('doc-need', 'form.statement_of_need'),
      fixtureDocument('doc-means', 'form.statement_of_means'),
      fixtureDocument('doc-mq', 'form.mitigation_questionnaire'),
      fixtureDocument('doc-cha', 'agreement.credit_hire', {
        signature: {
          signerPartyId: 'p-claimant',
          signerName: 'Amir Hussain',
          signerContact: 'amir@example.com',
          otpChannel: 'email',
          otpVerifiedAt: '2026-09-21T10:29:00Z',
          ipAddress: '203.0.113.9',
          userAgent: 'Mozilla/5.0',
          signedAt: '2026-09-21T10:30:00Z',
          documentSha256: 'b'.repeat(64),
          certificateId: 'CERT-1'
        }
      })
    ],
    clocks: [],
    report: {
      id: 'rep-1',
      claimId: 'claim-1',
      vehicleId: 'v-client',
      engineerPartyId: 'p-eng',
      engineerQualifications: 'IAEA',
      instructedBy: 'CCGUK',
      instructedAt: '2026-09-21T09:00:00Z',
      inspectionAt: '2026-09-23T10:00:00Z',
      inspectionBasis: 'physical',
      preAccidentCondition: 'good',
      damageDescription: 'offside rear quarter',
      consistentWithCircumstances: true,
      roadworthy: false,
      roadworthyReason: 'Rear light cluster destroyed and offside rear wheel fouling the arch.',
      repairDurationWorkingDays: 6,
      photoEvidenceIds: [],
      forCourt: false,
      feePence: 28_500,
      issuedAt: '2026-09-24T12:00:00Z'
    }
  };
}
