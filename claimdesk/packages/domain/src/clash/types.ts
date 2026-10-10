// owned by ap-foundation (contracts); catalogue.ts / detect.ts / identity.ts by ap-clash
/**
 * Clash detection contracts (docs/SUPREME-AUTOPILOT.md §C.1): the 44 codes of §C.2 in table order, subjects,
 * definitions and findings. `detectClashes(subject, world, opts)` is pure; the API assembles the world.
 */
import type { AcceptanceAssessment } from '../acceptance/assess.js';
import type { Claim, ClaimEvent, FleetUnit, FleetUse, GtaRate, HireAgreement, ISODateTime, Id, InsurancePolicy, InterventionOffer, Party, PenaltyNotice, Vehicle } from '../types.js';
import type { FleetDamage, HireNeeds, Movement, ReadinessTask, Reservation } from '../booking/types.js';
import type { DriverProfile } from '../eligibility/types.js';

/** The 44 codes of §C.2, in table order. */
export const CLASH_CODES = [
  'UNIT_DOUBLE_BOOKED',
  'TURNAROUND_SHORT',
  'UNIT_NOT_READY',
  'UNIT_OFF_ROAD',
  'UNIT_DISPOSED',
  'USE_NOT_DECLARED',
  'POLICY_NOT_IN_FORCE',
  'POLICY_ENDS_IN_PERIOD',
  'MOT_INVALID_AT_START',
  'MOT_LAPSES_IN_PERIOD',
  'TAX_INVALID_AT_START',
  'TAX_LAPSES_IN_PERIOD',
  'SERVICE_DUE_IN_PERIOD',
  'PHV_LICENCE',
  'KEEPER_ADDRESS_STALE',
  'OPEN_PENALTY_ON_UNIT',
  'UNIT_IS_CLAIM_VEHICLE',
  'FLEET_REG_AS_CLAIM_VEHICLE',
  'SAME_REG_ON_HIRE',
  'DUPLICATE_CLAIM_OPEN',
  'DUPLICATE_REGISTRATION',
  'VIN_REG_MISMATCH',
  'CLAIM_SECOND_HIRE',
  'HIRER_ON_OTHER_HIRE',
  'DRIVER_ON_OTHER_HIRE',
  'DRIVER_INELIGIBLE',
  'DRIVER_REFERRAL',
  'LICENCE_CHECK_STALE',
  'HIRE_BEFORE_ACCIDENT',
  'HIRE_BEFORE_SERVICES',
  'HIRE_PAST_OFFHIRE',
  'RETURN_OVERDUE',
  'CLAIM_STATUS_NO_HIRE',
  'ACCEPTANCE_CONDITIONS_UNMET',
  'HARD_STOP_FLAG',
  'SIGNATURES_MISSING',
  'GROUP_ABOVE_LFL',
  'NEED_WEAK',
  'INTERVENTION_UNANSWERED',
  'CLIENT_CAR_NOT_LEGAL',
  'INJURY_NOT_REFERRED',
  'DELIVERY_BEFORE_READY',
  'DELIVERY_CAPACITY',
  'HOLD_EXPIRED',
] as const;
export type ClashCode = (typeof CLASH_CODES)[number];
export const isClashCode = (v: unknown): v is ClashCode => typeof v === 'string' && (CLASH_CODES as readonly string[]).includes(v);

export type ClashSeverity = 'block' | 'warn' | 'info';
/** A manager override + reason + audit; B relaxed in manager mode; C never. */
export type ClashOverrideClass = 'A' | 'B' | 'C';

export type ClashStage = 'hold' | 'confirm' | 'handover';

export type ClashSubject =
  | {
      kind: 'proposed_booking';
      claimId: Id;
      fleetUnitId: Id;
      use: FleetUse;
      startAt: ISODateTime;
      expectedEndAt: ISODateTime;
      hirerPartyId: Id;
      driverPartyIds: Id[];
      excludeReservationId?: Id;
      stage: ClashStage;
    }
  | { kind: 'reservation'; reservationId: Id; stage: ClashStage | 'return' | 'period_change' }
  | { kind: 'hire'; hireId: Id }
  | { kind: 'claim'; claimId: Id }
  | { kind: 'fleet_unit'; fleetUnitId: Id };
export type ClashSubjectKind = ClashSubject['kind'];

export interface ClashDef {
  code: ClashCode;
  severity: ClashSeverity;
  overrideClass: ClashOverrideClass;
  /** OVERRIDE_RULES code used by gate.refuse (§C.4); null for warn/info and class C. */
  overrideCode: string | null;
  label: string;
  basis: string;
  /** Where it is checked. */
  subjects: ClashSubjectKind[];
  /** A warn that still stops the autopilot acting alone (→ confirm). */
  greenBlocking: boolean;
}

export interface ClashFinding {
  code: ClashCode;
  severity: ClashSeverity;
  overrideClass: ClashOverrideClass;
  message: string;
  claimId?: Id;
  fleetUnitId?: Id;
  reservationId?: Id;
  hireId?: Id;
  related: { claimIds: Id[]; reservationIds: Id[]; hireIds: Id[]; fleetUnitIds: Id[]; partyIds: Id[] };
  /** code + sorted subject ids — stable across runs. */
  dedupeKey: string;
  data?: Record<string, unknown>;
}

/** The rows detectClashes needs, assembled by the API for the subject's time window. */
export interface ClashWorld {
  claims: Claim[];
  vehicles: Vehicle[];
  parties: Party[];
  driverProfiles: DriverProfile[];
  fleetUnits: FleetUnit[];
  policies: InsurancePolicy[];
  reservations: Reservation[];
  hires: HireAgreement[];
  readiness: ReadinessTask[];
  damage: FleetDamage[];
  penalties: PenaltyNotice[];
  eventsByClaim: Record<Id, ClaimEvent[]>;
  acceptanceByClaim: Record<Id, AcceptanceAssessment>;
  interventionOffers: InterventionOffer[];
  signedPackByReservation: Record<Id, { signed: boolean; missing: string[] }>;
  // Optional additions by ap-clash (additive; absent → the codes that need them do not fire):
  /** Hire needs per claim (`claim_hire_needs`) — NEED_WEAK. */
  needsByClaim?: Record<Id, HireNeeds | null>;
  /** Delivery / collection movements of the reservations in the window — DELIVERY_BEFORE_READY, DELIVERY_CAPACITY. */
  movements?: Movement[];
  /** GTA benchmark rates (groups are compared by benchmark daily rate, never by code) — GROUP_ABOVE_LFL. */
  gtaRates?: GtaRate[];
}

/** Persisted finding status (`clash_findings.status`). */
export type ClashFindingStatus = 'open' | 'acknowledged' | 'overridden' | 'resolved';

/** A stored finding (`clash_findings` row). */
export interface ClashFindingRecord extends ClashFinding {
  id: Id;
  status: ClashFindingStatus;
  firstSeenAt: ISODateTime;
  lastSeenAt: ISODateTime;
  resolvedAt?: ISODateTime;
  resolvedBy?: string;
  resolutionNote?: string;
  overrideAuditId?: Id;
}
