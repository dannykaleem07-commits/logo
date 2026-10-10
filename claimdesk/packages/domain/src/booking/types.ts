// owned by ap-foundation (contracts); behaviour in reservation.ts / availability.ts / likeForLike.ts / periodCompliance.ts /
// projection.ts / delivery.ts / readiness.ts by ap-booking
/**
 * Fleet booking contracts (docs/SUPREME-AUTOPILOT.md §B): reservations (the fleet diary), readiness and damage, whole-
 * period compliance, availability search and ranking, delivery and collection movements. Pure types and constants
 * only. Periods are compared as epoch milliseconds (`block_start_ms` / `block_end_ms` in the database), never as text.
 */
import type { AllocationCheck } from '../fleet/allocate.js';
import type { ClientGroupSource, HirePricingGuide } from '../gta/pricing.js';
import type { Address, FleetUnit, FleetUse, ISODate, ISODateTime, Id, InsurancePolicy, Party, Pence, PenaltyNotice, Vehicle } from '../types.js';
import type { ClashFinding } from '../clash/types.js';
import type { DriverProfile, EligibilityOutcome } from '../eligibility/types.js';

// ---------------------------------------------------------------------------
// B.1 Reservations
// ---------------------------------------------------------------------------

export type ReservationStatus = 'held' | 'confirmed' | 'on_hire' | 'returned' | 'cancelled' | 'expired';
export const RESERVATION_STATUSES: readonly ReservationStatus[] = ['held', 'confirmed', 'on_hire', 'returned', 'cancelled', 'expired'];
/** Statuses that occupy the car for their period (a returned hire still occupied it — history clashes are real). */
export const BLOCKING_RESERVATION_STATUSES: readonly ReservationStatus[] = ['held', 'confirmed', 'on_hire', 'returned'];

export type ReservationSource = 'autopilot' | 'handler' | 'backfill';

export interface Reservation {
  id: Id;
  fleetUnitId: Id;
  claimId: Id;
  status: ReservationStatus;
  use: FleetUse;
  startAt: ISODateTime;
  /** Projected end (§B.6); moves as facts arrive; null only for back-filled open hires. */
  expectedEndAt: ISODateTime | null;
  /** Hire end (contractual), set at return. */
  endAt?: ISODateTime;
  /** Car physically back. */
  collectedAt?: ISODateTime;
  /** Held only. */
  holdExpiresAt?: ISODateTime;
  /** Main driver first; additional drivers after. */
  hirerPartyId: Id;
  driverPartyIds: Id[];
  /** Allocated at confirmation (CCG-H-NNNNNN, same sequence as hire_agreements). */
  agreementNumber?: string;
  hireAgreementId?: Id;
  hireOfferId?: Id;
  dailyRatePence: Pence;
  gtaGroup: string;
  clientGtaGroup?: string;
  pricingNote?: string;
  /** Required when the group is above like for like (clash GROUP_ABOVE_LFL). */
  substitutionReason?: string;
  /** Snapshot at hold time (why this car). */
  ranking?: AvailabilityCandidate;
  /** Clash findings recorded with the last write (JSON). */
  clashReport?: ClashFinding[];
  source: ReservationSource;
  /** A manager override let this period overlap another. */
  overlapOverrideAuditId?: Id;
  createdBy: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  cancelledReason?: string;
}

/** Allowed status moves (§B.1); `assertTransition` (booking/reservation.ts, ap-booking) throws RESERVATION_STATE otherwise. */
export const RESERVATION_TRANSITIONS: Readonly<Record<ReservationStatus, readonly ReservationStatus[]>> = {
  held: ['confirmed', 'cancelled', 'expired'],
  confirmed: ['on_hire', 'cancelled'],
  on_hire: ['returned'],
  returned: [],
  cancelled: [],
  expired: [],
};

/** Append-only history row (`fleet_reservation_events`). */
export interface ReservationEvent {
  id: Id;
  reservationId: Id;
  fromStatus?: ReservationStatus;
  toStatus: ReservationStatus;
  actor: string;
  reason?: string;
  data?: Record<string, unknown>;
  at: ISODateTime;
}

/** The occupied period of a reservation in epoch ms (null end = open). Computed by `occupiedPeriod` (ap-booking). */
export interface OccupiedPeriod {
  startMs: number;
  endMs: number | null;
}

// ---------------------------------------------------------------------------
// B.2 Readiness, damage and turnaround
// ---------------------------------------------------------------------------

export type ReadinessKind = 'valet' | 'inspection' | 'service' | 'damage_repair' | 'mot' | 'tax' | 'tyres' | 'keys' | 'phv_licence' | 'other';
export const READINESS_KINDS: readonly ReadinessKind[] = ['valet', 'inspection', 'service', 'damage_repair', 'mot', 'tax', 'tyres', 'keys', 'phv_licence', 'other'];

export interface ReadinessTask {
  id: Id;
  fleetUnitId: Id;
  kind: ReadinessKind;
  status: 'open' | 'done' | 'cancelled';
  /** damage_repair (major/unroadworthy), mot, tax, phv_licence → true by default. */
  blocksHire: boolean;
  dueAt?: ISODateTime;
  /** When the car will be ready (estimate). */
  readyByAt?: ISODateTime;
  reservationId?: Id;
  damageId?: Id;
  note?: string;
  createdBy: string;
  createdAt: ISODateTime;
  doneBy?: string;
  doneAt?: ISODateTime;
}

export type DamageSeverity = 'cosmetic' | 'minor' | 'major' | 'unroadworthy';

export interface FleetDamage {
  id: Id;
  fleetUnitId: Id;
  panel: string;
  description: string;
  severity: DamageSeverity;
  foundAt: ISODateTime;
  foundBy: string;
  reservationId?: Id;
  movementId?: Id;
  evidenceIds: Id[];
  repairedAt?: ISODateTime;
  repairTaskId?: Id;
  chargeable: 'none' | 'hirer' | 'third_party' | 'tbc';
}

export type UnitReadiness = { state: 'ready' } | { state: 'ready_by'; at: ISODateTime; tasks: Id[] } | { state: 'not_ready'; blocking: Id[] };

// ---------------------------------------------------------------------------
// B.3 Locations
// ---------------------------------------------------------------------------

export interface FleetLocation {
  id: Id;
  name: string;
  address: Address | null;
  postcode: string | null;
  lat: number | null;
  lon: number | null;
  isDefault: boolean;
}

// ---------------------------------------------------------------------------
// B.4 Whole-period compliance
// ---------------------------------------------------------------------------

export type PeriodLapseKind = 'policy' | 'mot' | 'tax' | 'service' | 'phv_licence';

export interface PeriodAllocationCheck extends AllocationCheck {
  /** Dates inside [startAt, expectedEndAt) when something lapses (MOT, tax, policy, service, PHV licence). */
  lapses: Array<{ kind: PeriodLapseKind; date: ISODate; renewal?: string }>;
  /** Min days between expectedEnd and the next lapse (∞ → 365). */
  marginDays: number;
}

// ---------------------------------------------------------------------------
// B.5 Availability search and ranking
// ---------------------------------------------------------------------------

export type HireNeedsSource = 'intake_script' | 'intake_extract' | 'handler' | 'client_reply';

/** §F.3, stored per claim (`claim_hire_needs`). */
export interface HireNeeds {
  neededFrom: ISODateTime | null;
  deliveryAddress: Address | null;
  deliveryPostcode: string | null;
  seatsMin: number | null;
  automaticOnly: boolean;
  automaticPreferred: boolean;
  towbar: boolean;
  wheelchairAccessible: boolean;
  handControls: boolean;
  isofixCount: number;
  evOk: boolean | null;
  phvWork: boolean;
  largeBoot: boolean;
  occupation: string | null;
  journeys: string | null;
  dependants: string | null;
  otherVehicles: 'none' | 'available' | 'unknown';
  ownInsurerCourtesyCar: 'offered' | 'accepted' | 'not_offered' | 'unknown';
  clientCoverType: 'comprehensive' | 'tpft' | 'tpo' | 'unknown';
  clientWantsHire: boolean | null;
  notes: string | null;
  source: Record<string, HireNeedsSource>;
}

export interface LikeForLikeResult {
  /** 0..1. */
  score: number;
  group: { client: string | null; car: string; relation: 'same' | 'lower' | 'higher' | 'unknown'; clientRatePence: Pence | null; carRatePence: Pence | null };
  parts: { group: number; body: number; seats: number; transmission: number; fuel: number };
  /** "Same hire group as your own car (C2), automatic, 5 seats." */
  sentence: string;
}

export interface AvailabilityQuery {
  claimId: Id | null;
  use: FleetUse;
  startAt: ISODateTime;
  expectedEndAt: ISODateTime;
  needs: HireNeeds;
  clientVehicle: Pick<Vehicle, 'gtaGroup' | 'bodyType' | 'fuelType' | 'transmission' | 'spec'> | null;
  clientGroup: string | null;
  clientGroupSource: ClientGroupSource;
  drivers: Array<{ partyId: Id; profile?: DriverProfile; party: Pick<Party, 'dateOfBirth' | 'drivingLicenceNumber' | 'name'> }>;
  /** The claim's own hold when re-searching. */
  excludeReservationIds: Id[];
  /** Default 10. */
  limit: number;
}

export interface UnitSnapshot {
  unit: FleetUnit;
  vehicle: Vehicle;
  policies: InsurancePolicy[];
  reservations: Reservation[];
  readiness: ReadinessTask[];
  damage: FleetDamage[];
  penalties: PenaltyNotice[];
  location: FleetLocation | null;
}

export type RankFactor = 'likeForLike' | 'needsFit' | 'readiness' | 'compliance' | 'cost' | 'location';
export const RANK_FACTORS: readonly RankFactor[] = ['likeForLike', 'needsFit', 'readiness', 'compliance', 'cost', 'location'];
export type RankingWeights = Record<RankFactor, number>;
/** §B.5 / §L: like-for-like 35, cost 20, needs 15, readiness 15, compliance 10, location 5 (normalised to 100). */
export const DEFAULT_RANKING_WEIGHTS: RankingWeights = { likeForLike: 35, needsFit: 15, readiness: 15, compliance: 10, cost: 20, location: 5 };

export interface AvailabilityCandidate {
  fleetUnitId: Id;
  registration: string;
  /** "Ford Focus 1.0 auto, 5 seats, petrol (C2)". */
  label: string;
  /** 0..100. */
  score: number;
  factors: Record<RankFactor, { score: number; weight: number; note: string }>;
  likeForLike: LikeForLikeResult;
  /** hirePricingGuide() as today. */
  pricing: HirePricingGuide;
  readyBy: ISODateTime;
  marginDays: number;
  lapses: PeriodAllocationCheck['lapses'];
  /** warn/info findings for this car + period. */
  warnings: ClashFinding[];
  /** Against THIS car's policy criteria. */
  driverOutcome: EligibilityOutcome;
}

export interface ExcludedUnit {
  fleetUnitId: Id;
  registration: string;
  reasons: Array<{ code: string; message: string }>;
}

export interface AvailabilityResult {
  period: { startAt: ISODateTime; expectedEndAt: ISODateTime };
  use: FleetUse;
  ranked: AvailabilityCandidate[];
  excluded: ExcludedUnit[];
  /** ranked[0].score − ranked[1].score ≥ settings.green.clearWinnerGap; true when only one car ranks. */
  clearWinner: boolean;
  /** ranked[0] passes the green test (§D.1). */
  green: boolean;
  /** Plain English, most important first. */
  explanation: string[];
}

// ---------------------------------------------------------------------------
// B.8 Delivery and collection
// ---------------------------------------------------------------------------

/** Europe/London business hours. `days`: 1 = Monday … 7 = Sunday. */
export interface BusinessHours {
  days: number[];
  start: string;
  end: string;
  skipBankHolidays: boolean;
}

export type MovementKind = 'delivery' | 'collection' | 'swap_out' | 'swap_in' | 'transfer';
export type MovementStatus = 'planned' | 'confirmed' | 'done' | 'failed' | 'cancelled';

export interface Movement {
  id: Id;
  reservationId: Id;
  claimId: Id;
  fleetUnitId: Id;
  kind: MovementKind;
  windowStart: ISODateTime;
  windowEnd: ISODateTime;
  address: Address | null;
  postcode: string | null;
  assignedTo: string | null;
  status: MovementStatus;
  doneAt?: ISODateTime;
  odometer?: number;
  fuelEighths?: number;
  conditionDocumentId?: Id;
  evidenceIds: Id[];
  clientNotifiedAt?: ISODateTime;
  /** The booking_update email that told the client (commitment binding, §D.3). */
  noticeOutboxId?: Id;
  notes?: string;
}

export type DeliveryPartOfDay = 'morning' | 'afternoon' | 'evening';

export interface SlotWindow {
  windowStart: ISODateTime;
  windowEnd: ISODateTime;
}
