/**
 * Test fixtures shared by the gta and clocks test suites. Not exported from the package.
 * Figures are the blueprint's own: £49.80/day Golf hire, £45/day storage, £90 + £3/mile + £25
 * recovery, S1 £42.32, £1,287 stated vs £1,112 received.
 */
import type {
  Claim,
  ClaimBundle,
  ClaimEvent,
  Evidence,
  EvidenceKind,
  EventType,
  GeneratedDocument,
  HireAgreement,
  ISODateTime,
  Party,
  RecoveryRecord,
  StorageRecord,
  Vehicle,
} from '../types.js';

let seq = 0;
const nextId = (prefix: string): string => `${prefix}_${String((seq += 1)).padStart(4, '0')}`;

export const CLAIM_ID = 'claim_test_1';

export function mkEvent(type: EventType, at: ISODateTime, extra: Partial<ClaimEvent> = {}): ClaimEvent {
  return {
    id: extra.id ?? nextId(`ev_${type}`),
    claimId: CLAIM_ID,
    type,
    at,
    recordedAt: extra.recordedAt ?? at,
    summary: extra.summary ?? type.replace(/_/g, ' '),
    evidenceIds: extra.evidenceIds ?? [],
    createdBy: 'system',
    ...(extra.data ? { data: extra.data } : {}),
    ...(extra.attributableTo ? { attributableTo: extra.attributableTo } : {}),
    ...(extra.documentId ? { documentId: extra.documentId } : {}),
  };
}

export function mkHire(overrides: Partial<HireAgreement> = {}): HireAgreement {
  return {
    id: overrides.id ?? nextId('hire'),
    claimId: CLAIM_ID,
    fleetUnitId: 'fleet_golf',
    agreementNumber: 'CCG-HA-0001',
    startAt: '2026-07-06T10:00:00+01:00',
    dailyRatePence: 4980,
    vatRate: 0.2,
    gtaGroup: 'M',
    excessPence: 25000,
    additionalDrivers: [],
    enforceability: { cca60fCompliant: true },
    ...overrides,
  };
}

export function mkStorage(overrides: Partial<StorageRecord> = {}): StorageRecord {
  return {
    id: overrides.id ?? nextId('storage'),
    claimId: CLAIM_ID,
    location: 'CCGUK yard',
    startAt: '2026-07-01T09:00:00+01:00',
    dailyRatePence: 4500,
    vatRate: 0.2,
    ...overrides,
  };
}

export function mkRecovery(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    id: overrides.id ?? nextId('recovery'),
    claimId: CLAIM_ID,
    at: '2026-07-01T08:00:00+01:00',
    fromLocation: 'A406',
    toLocation: 'CCGUK yard',
    calloutPence: 9000,
    loadedMiles: 12,
    perLoadedMilePence: 300,
    adminPence: 2500,
    vatRate: 0.2,
    evidenceIds: [],
    ...overrides,
  };
}

export function mkDoc(templateId: string, status: GeneratedDocument['status'] = 'approved', overrides: Partial<GeneratedDocument> = {}): GeneratedDocument {
  return {
    id: overrides.id ?? nextId('doc'),
    claimId: CLAIM_ID,
    templateId,
    templateVersion: '1.0.0',
    title: templateId,
    status,
    html: '<html></html>',
    sha256: 'deadbeef',
    createdAt: '2026-07-20T09:00:00+01:00',
    createdBy: 'system',
    dataSnapshot: {},
    ...overrides,
  };
}

export function mkEvidence(kind: EvidenceKind, overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: overrides.id ?? nextId('evi'),
    claimId: CLAIM_ID,
    kind,
    filename: overrides.filename ?? `${kind}.pdf`,
    mime: 'application/pdf',
    bytes: 1024,
    sha256: 'cafebabe',
    storagePath: `evidence/${kind}.pdf`,
    uploadedAt: '2026-07-20T09:00:00+01:00',
    uploadedBy: 'user_1',
    immutable: true,
    ...overrides,
  };
}

export function mkClaim(overrides: Partial<Claim> = {}, accident: Partial<Claim['accident']> = {}): Claim {
  return {
    id: CLAIM_ID,
    reference: 'CCG-2026-00012',
    status: 'hire_active',
    openedAt: '2026-07-01T09:30:00+01:00',
    accident: {
      occurredAt: '2026-07-01T07:45:00+01:00',
      location: 'A406 North Circular, London',
      circumstances: 'Third party changed lane into the client vehicle.',
      ...accident,
    },
    liability: 'unknown',
    claimantId: 'party_claimant',
    clientVehicleId: 'veh_client',
    thirdPartyIds: [],
    gtaSubscriber: false,
    linkedClaimIds: [],
    flags: [],
    createdAt: '2026-07-01T09:30:00+01:00',
    updatedAt: '2026-07-01T09:30:00+01:00',
    ...overrides,
  };
}

export const claimant: Party = {
  id: 'party_claimant',
  kind: 'individual',
  name: 'Test Claimant',
  roles: ['claimant'],
  createdAt: '2026-07-01T09:30:00+01:00',
};

export const vehicle: Vehicle = {
  id: 'veh_client',
  registration: 'AB12CDE',
  make: 'Volkswagen',
  model: 'Golf',
  engineCapacityCc: 1498,
  fuelType: 'petrol',
  bodyType: 'Hatchback',
  odometer: [],
  ownership: 'client',
  lookups: [],
  createdAt: '2026-07-01T09:30:00+01:00',
};

export function mkBundle(overrides: Partial<ClaimBundle> = {}, accident: Partial<Claim['accident']> = {}): ClaimBundle {
  return {
    claim: mkClaim({}, accident),
    claimant,
    vehicle,
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
    ...overrides,
  };
}
