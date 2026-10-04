/**
 * ClaimDesk shared domain types.
 *
 * Conventions (do not break these — every package depends on them):
 *  - Money is always integer PENCE (`Pence`). Never floats of pounds.
 *  - Dates are ISO strings: `ISODate` = YYYY-MM-DD, `ISODateTime` = full ISO 8601 with offset/Z.
 *  - Every entity has a string `id` (UUID or ULID) assigned by the persistence layer.
 *  - The ledger, events and evidence are APPEND-ONLY. Corrections are new entries that reference the old one.
 *  - Anything the brief marks "verify" carries a `Verification` block; code must never upgrade it silently.
 */

export type Pence = number;
export type ISODate = string;
export type ISODateTime = string;
export type Id = string;

export interface Verification {
  status: 'verified' | 'unverified' | 'failed' | 'stale';
  sourceUrl?: string;
  sourceNote?: string;
  verifiedAt?: ISODate;
  verifiedBy?: string;
}

// ---------------------------------------------------------------------------
// Parties, users, addresses
// ---------------------------------------------------------------------------

export interface Address {
  line1: string;
  line2?: string;
  town?: string;
  county?: string;
  postcode: string;
  country?: string; // default GB
}

export type PartyRole =
  | 'claimant'
  | 'driver'
  | 'keeper'
  | 'third_party'
  | 'third_party_driver'
  | 'witness'
  | 'insurer'
  | 'broker'
  | 'engineer'
  | 'repairer'
  | 'recovery_agent'
  | 'storage_yard'
  | 'solicitor'
  | 'supplier'
  | 'salvage_buyer'
  | 'council'
  | 'police'
  | 'other';

export interface BankDetails {
  accountName: string; // must equal exact registered name for Confirmation of Payee
  sortCode: string;
  accountNumber: string;
  bankName?: string;
}

export interface Party {
  id: Id;
  kind: 'individual' | 'company' | 'public_body';
  name: string; // full legal name
  tradingName?: string;
  dateOfBirth?: ISODate;
  address?: Address;
  email?: string;
  phone?: string;
  companyNumber?: string; // Companies House number
  vatRegistered?: boolean;
  drivingLicenceNumber?: string;
  bank?: BankDetails;
  roles: PartyRole[];
  notes?: string;
  createdAt: ISODateTime;
}

export type UserRole = 'handler' | 'approver' | 'engineer' | 'admin';
export interface User {
  id: Id;
  name: string;
  email: string;
  role: UserRole;
  mfaEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Vehicles, fleet, lookups
// ---------------------------------------------------------------------------

export type FuelType = 'petrol' | 'diesel' | 'hybrid' | 'plugin_hybrid' | 'electric' | 'lpg' | 'other';
export type Transmission = 'manual' | 'automatic' | 'unknown';
export type OdometerSource =
  | 'mot'
  | 'accident_report'
  | 'handover'
  | 'collection'
  | 'engineer'
  | 'photo'
  | 'v5c'
  | 'client'
  | 'manual';

export interface OdometerReading {
  source: OdometerSource;
  date: ISODate;
  miles: number;
  evidenceId?: Id;
  note?: string;
}

/** ABI Code of Practice for the Categorisation of Motorised Vehicle Salvage (28 May 2025). */
export type SalvageCategory = 'A' | 'B' | 'S' | 'N';

export interface MotTest {
  completedDate: ISODate;
  result: 'PASSED' | 'FAILED' | 'PRS' | 'ABANDONED' | 'UNKNOWN';
  expiryDate?: ISODate;
  odometerMiles?: number;
  odometerUnit?: 'mi' | 'km';
  testNumber?: string;
  defects: Array<{ type: 'ADVISORY' | 'MINOR' | 'MAJOR' | 'DANGEROUS' | 'FAIL' | 'PRS' | 'USER ENTERED' | string; text: string; dangerous?: boolean }>;
}

export type LookupProvider = 'dvla_ves' | 'dvsa_mot' | 'companies_house' | 'gateway' | 'manual';

export interface LookupRecord<T = unknown> {
  id: Id;
  provider: LookupProvider;
  kind: 'vehicle' | 'mot' | 'company' | 'valuation' | 'provenance' | 'spec';
  requestedAt: ISODateTime;
  requestedBy: Id;
  registration?: string;
  costPence?: Pence;
  raw: T; // provider payload exactly as received (or as keyed in)
  verification: Verification; // manual entries are 'unverified' until a document backs them
}

export interface Vehicle {
  id: Id;
  registration: string; // normalised: uppercase, no spaces
  vin?: string;
  make: string;
  model: string;
  variant?: string;
  bodyType?: string;
  yearOfManufacture?: number;
  monthOfFirstRegistration?: string; // YYYY-MM
  fuelType?: FuelType;
  transmission?: Transmission;
  colour?: string;
  engineCapacityCc?: number;
  co2Gkm?: number;
  euroStatus?: string;
  taxStatus?: string;
  taxDueDate?: ISODate;
  motStatus?: string;
  motExpiryDate?: ISODate;
  markedForExport?: boolean;
  dateOfLastV5CIssued?: ISODate;
  motHistory?: MotTest[];
  odometer: OdometerReading[];
  gtaGroup?: string; // e.g. 'S1','M','M1','CP1'
  previousWriteOffCategory?: SalvageCategory;
  ownership: 'client' | 'third_party' | 'fleet' | 'other';
  lookups: LookupRecord[];
  createdAt: ISODateTime;
}

export type FleetUse = 'credit_hire' | 'self_drive' | 'pco';

export interface InsurancePolicy {
  id: Id;
  insurerName: string;
  policyNumber: string;
  coveredUses: FleetUse[];
  startDate: ISODate;
  endDate: ISODate;
  evidenceId?: Id;
}

export interface FleetUnit {
  id: Id;
  vehicleId: Id;
  declaredUses: FleetUse[];
  policyId?: Id;
  dailyRatePence: Pence;
  gtaGroup: string;
  keeperAddressOnV5C?: Address;
  keeperAddressCurrent: boolean;
  serviceDueDate?: ISODate;
  status: 'available' | 'on_hire' | 'off_road' | 'disposed';
  phvLicensed?: boolean;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export type ClaimStatus =
  | 'fnol'
  | 'triage'
  | 'declined'
  | 'accepted'
  | 'hire_active'
  | 'repair'
  | 'total_loss'
  | 'payment_pack'
  | 'chasing'
  | 'disputed'
  | 'complaint'
  | 'pre_action'
  | 'litigation'
  | 'settled'
  | 'closed';

export type LiabilityPosition = 'admitted' | 'denied' | 'split' | 'unknown' | 'disputed';
export type Track = 'small_claims' | 'fast' | 'intermediate' | 'multi';

export interface AccidentDetails {
  occurredAt: ISODateTime;
  location: string;
  postcode?: string;
  circumstances: string; // client's account, taken cold, verbatim
  thirdPartyAccount?: string;
  highwayCodeRules?: number[];
  policeAttended?: boolean;
  policeReference?: string;
  cctvAvailable?: boolean;
  dashcamAvailable?: boolean;
  independentWitness?: boolean;
  injuries?: boolean;
  roadworthyAfter?: boolean;
  airbagsDeployed?: boolean;
  driveable?: boolean;
}

export interface Claim {
  id: Id;
  reference: string; // e.g. CCG-2026-00012
  status: ClaimStatus;
  openedAt: ISODateTime;
  accident: AccidentDetails;
  liability: LiabilityPosition;
  liabilityScore?: number; // 0..100
  claimantId: Id;
  driverId?: Id;
  clientVehicleId: Id;
  thirdPartyIds: Id[];
  thirdPartyVehicleId?: Id;
  atFaultInsurerId?: Id;
  atFaultInsurerRef?: string;
  clientInsurerId?: Id;
  clientPolicyNumber?: string;
  handlerId?: Id;
  gtaSubscriber: boolean; // CCGUK is not a subscriber; GTA used as benchmark
  injuryReferral?: { referredTo: string; referredAt: ISODateTime; feeTaken: false };
  track?: Track;
  linkedClaimIds: Id[]; // same registration / connected files
  flags: ClaimFlag[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ClaimFlag {
  code: string; // e.g. 'DUPLICATE_REGISTRATION', 'NON_INDEPENDENT_WITNESS', 'LEGACY_DETAIL'
  severity: 'info' | 'warn' | 'block';
  message: string;
  raisedAt: ISODateTime;
  raisedBy: 'system' | Id;
  clearedAt?: ISODateTime;
  clearedBy?: Id;
  clearedReason?: string;
}

// ---------------------------------------------------------------------------
// Ledger (single source of truth for money)
// ---------------------------------------------------------------------------

export type HeadOfLoss =
  | 'hire'
  | 'recovery'
  | 'storage'
  | 'engineer_fee'
  | 'pav'
  | 'repair'
  | 'salvage' // credit (negative) when retained
  | 'excess'
  | 'loss_of_use'
  | 'diminution'
  | 'personal_effects'
  | 'loss_of_earnings'
  | 'travel'
  | 'misc'
  | 'interest'
  | 'court_fee'
  | 'fixed_costs';

export type LedgerKind =
  | 'claimed' // our position
  | 'invoiced'
  | 'offered' // insurer's offer
  | 'reduced' // insurer reduction with reason
  | 'paid' // cleared funds received
  | 'interim_paid'
  | 'written_off'
  | 'adjustment';

export interface LedgerEntry {
  id: Id;
  claimId: Id;
  head: HeadOfLoss;
  kind: LedgerKind;
  amountPence: Pence; // positive; sign is implied by kind except 'adjustment'
  vatPence?: Pence;
  date: ISODate;
  description: string;
  counterpartyId?: Id;
  reference?: string; // insurer ref, invoice number, remittance ref
  sourceDocumentId?: Id;
  sourceEvidenceId?: Id;
  supersedesId?: Id;
  createdBy: Id | 'system';
  createdAt: ISODateTime;
}

// ---------------------------------------------------------------------------
// Events (the dated chronology — wins period arguments)
// ---------------------------------------------------------------------------

export type EventType =
  | 'fnol'
  | 'services_agreed'
  | 'ncaf_sent' // New Claim Advice Form (GTA 4.1)
  | 'handling_ref_received' // GTA 4.2
  | 'first_notification_dispute' // GTA 3.6
  | 'engineer_instructed'
  | 'inspection'
  | 'report_issued'
  | 'estimate_received'
  | 'repair_authorised'
  | 'parts_ordered'
  | 'parts_arrived'
  | 'repair_started'
  | 'repair_delay'
  | 'repair_completed'
  | 'vehicle_returned'
  | 'hire_started'
  | 'hire_ended'
  | 'storage_started'
  | 'storage_ended'
  | 'recovery'
  | 'collect_or_pay_notice_sent'
  | 'total_loss_confirmed'
  | 'pav_offer_received'
  | 'pav_agreed'
  | 'tl_payment_received'
  | 'cash_in_lieu_received'
  | 'insurer_termination_notice'
  | 'intervention_offer'
  | 'intervention_reply_sent'
  | 'payment_pack_sent'
  | 'payment_received'
  | 'reduction_received'
  | 'chaser_sent'
  | 'complaint_sent'
  | 'final_response_received'
  | 'dsar_sent'
  | 'dsar_response'
  | 'cctv_request_sent'
  | 'letter_before_claim_sent'
  | 'part36_sent'
  | 'part36_received'
  | 'proceedings_issued'
  | 'defence_received'
  | 'judgment'
  | 'settled'
  | 'vehicle_collected'
  | 'salvage_released'
  | 'pcn_received'
  | 'nip_received'
  | 's172_response_sent'
  | 'pcn_liability_transferred'
  | 'call'
  | 'email_in'
  | 'email_out'
  | 'letter_in'
  | 'letter_out'
  | 'note';

export interface ClaimEvent {
  id: Id;
  claimId: Id;
  type: EventType;
  at: ISODateTime; // when it happened
  recordedAt: ISODateTime; // when we logged it (never earlier than `at`'s creation)
  summary: string;
  data?: Record<string, unknown>;
  attributableTo?: 'insurer' | 'client' | 'ccguk' | 'repairer' | 'engineer' | 'third_party' | 'none';
  evidenceIds: Id[];
  documentId?: Id;
  createdBy: Id | 'system';
}

// ---------------------------------------------------------------------------
// Hire, storage, recovery
// ---------------------------------------------------------------------------

export interface AdditionalDriver {
  partyId: Id;
  nonStandardRisk?: boolean; // GTA 5.4: £5.50/day capped £110 when evidenced
  evidenceIds: Id[];
}

export interface HireAgreement {
  id: Id;
  claimId: Id;
  fleetUnitId: Id;
  agreementNumber: string;
  startAt: ISODateTime;
  endAt?: ISODateTime;
  endTrigger?: HireEndTrigger;
  dailyRatePence: Pence;
  vatRate: number; // e.g. 0.2
  gtaGroup: string;
  excessPence: Pence;
  excessWaiverDailyPence?: Pence;
  additionalDrivers: AdditionalDriver[];
  deliveredAt?: ISODateTime;
  collectedAt?: ISODateTime;
  odometerOut?: number;
  odometerIn?: number;
  signedAt?: ISODateTime;
  documentId?: Id;
  // Enforceability (W v Veolia / Dimond v Lovell risk)
  enforceability: {
    cancellationInfoProvidedAt?: ISODateTime; // CCR 2013 Sch 2 info
    schedule3FormProvidedAt?: ISODateTime; // CCR 2013 Sch 3 cancellation form
    expressRequestToStartAt?: ISODateTime; // reg 36
    expressRequestEvidenceId?: Id;
    cca60fCompliant: boolean; // ≤12 payments within 12 months, no interest/charges
    notes?: string;
  };
  needStatementEvidenceId?: Id;
  mitigationQuestionnaireDocumentId?: Id;
  statementOfMeansDocumentId?: Id;
}

export type HireEndTrigger =
  | 'repair_complete_24h' // GTA 4.8
  | 'tl_payment_5wd' // GTA 4.14
  | 'insurer_termination_1wd' // GTA 4.9
  | 'cash_in_lieu' // GTA 4.7
  | 'client_returned'
  | 'replacement_purchased'
  | 'manual';

export interface StorageRecord {
  id: Id;
  claimId: Id;
  location: string;
  startAt: ISODateTime;
  endAt?: ISODateTime;
  endTrigger?: 'report_issued' | 'total_loss_confirmed' | 'payment_received' | 'collected' | 'salvage_released' | 'manual';
  dailyRatePence: Pence; // £45/day default
  vatRate: number;
}

export interface RecoveryRecord {
  id: Id;
  claimId: Id;
  at: ISODateTime;
  fromLocation: string;
  toLocation: string;
  calloutPence: Pence; // £90
  loadedMiles: number;
  perLoadedMilePence: Pence; // £3
  adminPence: Pence; // £25
  vatRate: number;
  evidenceIds: Id[];
}

// ---------------------------------------------------------------------------
// Intervention and mitigation register
// ---------------------------------------------------------------------------

export interface InterventionOffer {
  id: Id;
  claimId: Id;
  receivedAt: ISODateTime;
  channel: 'phone' | 'email' | 'letter' | 'sms' | 'whatsapp' | 'portal' | 'via_client';
  offerorPartyId?: Id;
  offerorName: string;
  vehicleClassOffered?: string;
  dailyRatePence?: Pence;
  rateIncludesVat?: boolean;
  terms: {
    excessPence?: Pence;
    mileageLimitPerDay?: number;
    deliveryIncluded?: boolean;
    insuranceIncluded?: boolean;
    durationStated?: string;
    otherTerms?: string;
  };
  suitable?: boolean;
  suitabilityReasons: string[];
  clientDecision: 'pending' | 'accepted' | 'declined';
  clientReasons?: string;
  clientDecisionAt?: ISODateTime;
  replySentAt?: ISODateTime; // must be within 1 working day
  replyDocumentId?: Id;
  evidenceIds: Id[];
}

// ---------------------------------------------------------------------------
// Clocks
// ---------------------------------------------------------------------------

export type ClockKind =
  | 'gta_4_1_ncaf_1wd'
  | 'gta_4_2_handling_ref_5wd'
  | 'gta_3_6_first_notification_5wd'
  | 'gta_4_8_offhire_repair_24h'
  | 'gta_4_9_termination_1wd'
  | 'gta_4_14_offhire_tl_payment_5wd'
  | 'gta_4_10_authorisation_check_3wd'
  | 'gta_4_11_monitoring_5wd'
  | 'gta_6_7_settlement_1_month'
  | 'gta_6_8_late_payment_10pc_day31'
  | 'gta_6_8_late_payment_20pc_day61'
  | 'intervention_reply_1wd'
  | 'storage_report_plus_48h'
  | 'icobs_8_2_6_three_months'
  | 'chaser_day_7'
  | 'chaser_day_14'
  | 'chaser_day_21'
  | 'complaint_day_28'
  | 'disp_final_response_8_weeks'
  | 'fos_referral_6_months'
  | 'dsar_1_month'
  | 'cctv_preservation'
  | 'nip_14_days'
  | 's172_28_days'
  | 'pcn_discount_14_days'
  | 'pcn_representations_28_days'
  | 'pcn_appeal_28_days'
  | 'limitation_tort_6y'
  | 'limitation_contract_6y'
  | 'limitation_pi_3y'
  | 'part36_relevant_period_21_days'
  | 'default_judgment_14_days'
  | 'custom';

export interface Clock {
  id: Id;
  claimId: Id;
  kind: ClockKind;
  label: string;
  basis: string; // citation, e.g. 'GTA 4.1 (16 March 2026 wording)'
  startsAt: ISODateTime;
  dueAt: ISODateTime;
  status: 'running' | 'met' | 'breached' | 'stopped' | 'not_applicable';
  metAt?: ISODateTime;
  stoppedAt?: ISODateTime;
  stoppedReason?: string;
  attributableTo?: 'insurer' | 'ccguk' | 'client' | 'court' | 'other';
  sourceEventId?: Id;
}

// ---------------------------------------------------------------------------
// Evidence & documents (tamper-evident)
// ---------------------------------------------------------------------------

export type EvidenceKind =
  | 'photo'
  | 'video'
  | 'audio'
  | 'document'
  | 'pdf'
  | 'screenshot'
  | 'advert'
  | 'bank_statement'
  | 'payslip'
  | 'licence'
  | 'v5c'
  | 'mot_certificate'
  | 'insurance_certificate'
  | 'estimate'
  | 'invoice'
  | 'engineer_report'
  | 'correspondence'
  | 'call_recording'
  | 'cctv'
  | 'dashcam'
  | 'witness_statement'
  | 'other';

export interface ExifSummary {
  dateTimeOriginal?: ISODateTime;
  make?: string;
  model?: string;
  software?: string;
  gps?: { lat: number; lon: number; altitude?: number };
  orientation?: number;
  widthPx?: number;
  heightPx?: number;
}

export interface Evidence {
  id: Id;
  claimId?: Id;
  kind: EvidenceKind;
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  storagePath: string; // relative path in write-once store
  capturedAt?: ISODateTime; // from EXIF or stated
  uploadedAt: ISODateTime;
  uploadedBy: Id;
  exif?: ExifSummary;
  captureShot?: GuidedShot; // for guided capture
  sourceUrl?: string; // comparables, screenshots
  description?: string;
  immutable: true;
}

export type GuidedShot =
  | 'front_left'
  | 'front_right'
  | 'rear_left'
  | 'rear_right'
  | 'damage_close_1'
  | 'damage_close_2'
  | 'damage_close_3'
  | 'odometer'
  | 'vin_plate'
  | 'tyre_fl'
  | 'tyre_fr'
  | 'tyre_rl'
  | 'tyre_rr'
  | 'interior'
  | 'number_plate';

export type DocumentStatus = 'draft' | 'blocked' | 'approved' | 'sent' | 'signed' | 'superseded' | 'void';

export interface GeneratedDocument {
  id: Id;
  claimId?: Id;
  templateId: string; // e.g. 'letter.ncaf', 'invoice.hire', 'report.engineer'
  templateVersion: string; // immutable semver of the template
  title: string;
  recipientPartyId?: Id;
  status: DocumentStatus;
  html: string;
  pdfPath?: string;
  sha256: string; // of the rendered PDF (or HTML if no PDF yet)
  createdAt: ISODateTime;
  createdBy: Id | 'system';
  approvedAt?: ISODateTime;
  approvedBy?: Id;
  sentAt?: ISODateTime;
  sentVia?: 'email' | 'post' | 'portal' | 'whatsapp' | 'hand';
  supersedesId?: Id;
  reExecutedOn?: ISODate;
  consistency?: ConsistencyReport;
  signature?: SignatureRecord;
  dataSnapshot: Record<string, unknown>; // exact ledger/event data the template rendered from
}

export interface SignatureRecord {
  signerPartyId: Id;
  signerName: string;
  signerContact: string; // email or phone used for OTP
  otpChannel: 'email' | 'sms';
  otpVerifiedAt: ISODateTime;
  ipAddress: string;
  userAgent: string;
  signedAt: ISODateTime;
  documentSha256: string;
  certificateId: Id;
  certificatePdfPath?: string;
}

// ---------------------------------------------------------------------------
// Position-consistency engine
// ---------------------------------------------------------------------------

export type ConsistencyCode =
  | 'AMOUNT_PAID_MISMATCH'
  | 'AMOUNT_CLAIMED_MISMATCH'
  | 'DEADLINE_TOO_EARLY'
  | 'DEADLINE_MISMATCH'
  | 'OFFER_DENIED_BUT_LOGGED'
  | 'STORAGE_END_MISMATCH'
  | 'HIRE_PERIOD_MISMATCH'
  | 'PAYEE_MISMATCH'
  | 'DATE_BEFORE_CREATION'
  | 'DUPLICATE_SIGNATURE_DATE'
  | 'CONTRADICTS_PRIOR_LETTER'
  | 'LEGACY_DETAIL'
  | 'BANNED_PHRASE'
  | 'REGULATED_STATUS_IMPLIED'
  | 'UNVERIFIED_CITATION'
  | 'FORUM_NOT_OPEN'
  | 'GTA_CITED_AS_LAW'
  | 'UNKNOWN_REFERENCE';

export interface ConsistencyFlag {
  code: ConsistencyCode;
  severity: 'block' | 'warn' | 'info';
  message: string;
  draftValue?: string;
  ledgerValue?: string;
  excerpt?: string; // the offending text
  clearedBy?: Id;
  clearedReason?: string;
  clearedAt?: ISODateTime;
}

export interface ConsistencyReport {
  checkedAt: ISODateTime;
  flags: ConsistencyFlag[];
  blocked: boolean; // true if any uncleared 'block'
}

// ---------------------------------------------------------------------------
// Valuation (PAV), estimating, total loss
// ---------------------------------------------------------------------------

export interface Comparable {
  id: Id;
  evidenceId?: Id; // the saved advert PDF/screenshot
  url?: string;
  capturedAt: ISODateTime;
  source: string; // 'Auto Trader', 'dealer site', etc. — captured manually, never scraped
  pricePence: Pence;
  priceOnApplication?: boolean;
  mileage: number;
  year: number;
  make: string;
  model: string;
  trim?: string;
  fuelType?: FuelType;
  transmission?: Transmission;
  seller: 'dealer' | 'private' | 'unknown';
  distanceMiles?: number;
  writeOffCategory?: SalvageCategory;
  exFleet?: boolean;
  optionsAdjustmentPence?: Pence;
  // computed
  normalisedPricePence?: Pence;
  excluded?: boolean;
  exclusionReason?: string;
}

export interface PavSubject {
  vehicleId: Id;
  registration: string;
  make: string;
  model: string;
  trim?: string;
  year: number;
  fuelType?: FuelType;
  transmission?: Transmission;
  odometerAtLoss: number;
  odometerBasis: 'reading' | 'projected_from_mot';
  conditionGrade: 'excellent' | 'good' | 'average' | 'poor';
  conditionAdjustmentPct: number; // -10..+10, engineer's call
  serviceHistory?: 'full' | 'partial' | 'none' | 'unknown';
  exFleet?: boolean;
  previousWriteOffCategory?: SalvageCategory;
  claimantPostcode?: string;
  vatRegisteredClaimant?: boolean;
}

export interface PavAssessment {
  id: Id;
  claimId: Id;
  subject: PavSubject;
  comparables: Comparable[];
  perMilePence: number; // factor used
  perMileSource: 'regression' | 'fallback_band';
  medianPence: Pence;
  iqrLowPence: Pence;
  iqrHighPence: Pence;
  tradeGuidePence?: Pence;
  tradeGuideSource?: string;
  pavPence: Pence; // the figure we assert (median unless engineer overrides with reason)
  overrideReason?: string;
  reasoning: string; // generated paragraph, engineer-approved
  approvedBy?: Id;
  approvedAt?: ISODateTime;
  createdAt: ISODateTime;
}

export type EstimateLineKind = 'labour' | 'part' | 'paint' | 'materials' | 'adas' | 'diagnostic' | 'sundry' | 'specialist';

export interface EstimateLine {
  id: Id;
  kind: EstimateLineKind;
  operation: string; // 'Replace', 'Repair', 'Refinish', 'Blend', 'Strip/Refit', 'Calibrate'
  panel?: string; // 'Front bumper', 'Bonnet', 'NSF wing'
  description: string;
  partNumber?: string;
  partSource?: 'oem' | 'aftermarket' | 'green' | 'unknown';
  quantity: number;
  unitPence?: Pence; // parts/sundry
  hours?: number; // labour/paint
  ratePence?: Pence; // per hour
  materialsPence?: Pence;
  source: 'manual' | 'import' | 'library' | 'vision_suggestion';
  confirmedByEngineer: boolean;
  preExisting?: boolean; // separated explicitly, never claimed
  note?: string;
}

export interface Estimate {
  id: Id;
  claimId: Id;
  vehicleId: Id;
  lines: EstimateLine[];
  labourRatePence: Pence;
  paintRatePence: Pence;
  paintMaterialsMethod: 'per_hour' | 'paint_system' | 'fixed';
  paintMaterialsPerHourPence?: Pence;
  vatRate: number;
  importedFromEvidenceId?: Id;
  importedTotalPence?: Pence; // for reconciliation
  reconciled?: boolean;
  totals: EstimateTotals;
  createdAt: ISODateTime;
  approvedBy?: Id;
}

export interface EstimateTotals {
  labourPence: Pence;
  partsPence: Pence;
  paintLabourPence: Pence;
  paintMaterialsPence: Pence;
  otherPence: Pence;
  preExistingExcludedPence: Pence;
  netPence: Pence;
  vatPence: Pence;
  grossPence: Pence;
  labourHours: number;
  paintHours: number;
}

export interface TotalLossAssessment {
  repairNetPence: Pence;
  projectedRepairWorkingDays: number;
  projectedHireDays: number;
  hireDailyRatePence: Pence;
  projectedHirePence: Pence;
  projectedStoragePence: Pence;
  pavPence: Pence;
  salvagePence: Pence; // actual bid or offer; never a fixed %
  salvageSource: 'bid' | 'offer' | 'estimate';
  salvageCategory?: SalvageCategory;
  repairRouteCostPence: Pence; // repair + hire + storage
  totalLossRouteCostPence: Pence; // pav - salvage (+ hire to payment)
  decision: 'repair' | 'total_loss' | 'borderline';
  marginPence: Pence;
  notes: string[];
}

export interface TotalLossPredictionInput {
  vehicleAgeYears: number;
  pavBandPence: Pence; // rough PAV
  roughRepairPence?: Pence;
  damageZones: Array<'front' | 'rear' | 'nearside' | 'offside' | 'roof' | 'underside' | 'multiple'>;
  airbagsDeployed: boolean;
  structuralIndicators: Array<'wheel_displaced' | 'suspension' | 'pillar' | 'chassis_leg' | 'floor' | 'roof_rail' | 'none'>;
  driveable: boolean;
  fluidLeaks?: boolean;
  isEvOrHybrid?: boolean;
}

export interface TotalLossPrediction {
  probability: number; // 0..1
  band: 'low' | 'medium' | 'high';
  factors: Array<{ factor: string; weight: number; note: string }>;
  calibrated: boolean; // false until ≥100 outcomes
}

export interface EngineerReport {
  id: Id;
  claimId: Id;
  vehicleId: Id;
  engineerPartyId: Id;
  engineerQualifications: string; // IAEA / IMI etc.
  instructedBy: string;
  instructedAt: ISODateTime;
  inspectionAt?: ISODateTime;
  inspectionPlace?: string;
  inspectionBasis: 'physical' | 'desktop';
  inspectionConditions?: string;
  odometerMiles?: number;
  preAccidentCondition: string;
  damageDescription: string;
  consistentWithCircumstances: boolean;
  consistencyNote?: string;
  repairMethod?: string;
  estimateId?: Id;
  roadworthy: boolean;
  roadworthyReason: string;
  repairDurationWorkingDays?: number;
  totalLoss?: TotalLossAssessment;
  pavAssessmentId?: Id;
  salvageCategory?: SalvageCategory;
  salvageValuePence?: Pence;
  adasNotes?: string;
  evNotes?: string;
  diagnosticFaultCodes?: string[];
  photoEvidenceIds: Id[];
  forCourt: boolean; // adds CPR 35 / PD 35 declarations
  feePence: Pence; // e.g. £285
  issuedAt?: ISODateTime;
  documentId?: Id;
}

// ---------------------------------------------------------------------------
// Case acceptance, playbook, evidence gates
// ---------------------------------------------------------------------------

export type EvidenceGate = 'need' | 'use' | 'period' | 'rate' | 'impecuniosity' | 'mitigation' | 'enforceability' | 'liability';

export interface GateResult {
  gate: EvidenceGate;
  status: 'green' | 'amber' | 'red';
  missing: string[];
  present: string[];
}

export interface CaseAcceptance {
  liabilityScore: number; // 0..100
  costsExposure: 'low' | 'medium' | 'high'; // Tescher / Kindertons non-party costs risk
  hireToOtherHeadsRatio?: number;
  impecuniosityReadiness: 'ready' | 'partial' | 'none';
  enforceabilityReadiness: 'ready' | 'partial' | 'none';
  perimeterFlags: string[]; // injury → refer out; FCA/LSA
  decision: 'accept' | 'accept_with_conditions' | 'decline';
  conditions: string[];
  reasons: string[];
}

export interface PlaybookAction {
  code: string; // e.g. 'SEND_NCAF', 'REQUEST_CCTV', 'SEND_PAYMENT_PACK', 'CHASER_7'
  title: string;
  why: string; // one sentence, cites basis
  basis: string[]; // citations
  dueAt?: ISODateTime;
  priority: 'now' | 'today' | 'this_week' | 'scheduled';
  templateId?: string; // document to generate
  blockedBy?: string[]; // gate names or action codes
  valuePence?: Pence; // what it is worth / protects (money.md discipline)
}

// ---------------------------------------------------------------------------
// Directory, knowledge base, rates (content types live in @ccguk/kb but are shared)
// ---------------------------------------------------------------------------

export interface InsurerDirectoryEntry {
  id: string; // slug
  name: string;
  brands: string[];
  group?: string;
  thirdPartyClaimsPhone?: string;
  thirdPartyIvrPath?: string; // 'Option 2 → Option 3 (third party)'
  policyholderClaimsPhone?: string;
  claimsEmail?: string;
  thirdPartyEmail?: string;
  complaintsEmail?: string;
  postalAddress?: string;
  portalUrl?: string;
  openingHours?: string;
  notes?: string;
  copycatDomains: string[];
  copycatNumbers: string[];
  verification: Verification;
  lastUsedOk?: ISODate;
  lastFailed?: ISODate;
}

export interface GtaRate {
  group: string; // 'S1','M','M1','CP1'...
  description?: string;
  dailyRatePence: Pence; // ex VAT
  period: string; // '2026-27'
  effectiveFrom: ISODate;
  effectiveTo: ISODate;
  verification: Verification;
}

export type KbEntryType = 'case' | 'statute' | 'cpr' | 'practice_direction' | 'gta' | 'fca_handbook' | 'fos' | 'guidance' | 'code_of_practice' | 'fee';

export interface KbEntry {
  id: string;
  type: KbEntryType;
  citation: string;
  title: string;
  principle: string; // 1–3 sentences
  text?: string; // longer extract where licence permits (link otherwise)
  tags: string[];
  topics: string[]; // 'credit_hire','impecuniosity','bhr','mitigation','pav','costs','enforceability','interest','limitation','pcn','nip','dsar','complaints','salvage','fleet'
  url?: string;
  verification: Verification;
  licence?: 'OGL' | 'Open Justice Licence' | 'link_only' | 'quote_only';
}

// ---------------------------------------------------------------------------
// Fleet compliance / PCN / NIP
// ---------------------------------------------------------------------------

export type PenaltyKind = 'pcn_council' | 'pcn_private' | 'nip_s172' | 'fpn' | 'congestion_ulez' | 'dart_charge';

export interface PenaltyNotice {
  id: Id;
  fleetUnitId: Id;
  kind: PenaltyKind;
  issuer: string;
  noticeNumber: string;
  contraventionAt: ISODateTime;
  receivedAt: ISODateTime;
  amountPence: Pence;
  discountDeadline?: ISODate;
  responseDeadline: ISODate;
  hireAgreementId?: Id; // who had the car
  stage: 'received' | 'hirer_identified' | 'liability_transferred' | 'representations' | 'appeal' | 'paid' | 'cancelled' | 'escalated';
  notes?: string;
  documentIds: Id[];
}

export interface ComplianceAlert {
  fleetUnitId: Id;
  code: 'MOT_DUE' | 'MOT_EXPIRED' | 'TAX_DUE' | 'TAX_EXPIRED' | 'INSURANCE_DUE' | 'INSURANCE_EXPIRED' | 'SERVICE_DUE' | 'KEEPER_ADDRESS_STALE' | 'USE_NOT_COVERED' | 'PENALTY_DEADLINE' | 'PHV_NOT_ELIGIBLE';
  severity: 'info' | 'warn' | 'block';
  message: string;
  dueDate?: ISODate;
}

// ---------------------------------------------------------------------------
// Counterparty monitoring
// ---------------------------------------------------------------------------

export interface CompanyWatch {
  companyNumber: string;
  name: string;
  role: 'supplier' | 'insurer' | 'repairer' | 'engineer' | 'client' | 'other';
  lastPolledAt?: ISODateTime;
  status?: string; // 'active', 'dissolved', 'liquidation', 'active-proposal-to-strike-off'
  accountsOverdue?: boolean;
  confirmationStatementOverdue?: boolean;
  gazetteNotices: Array<{ date: ISODate; type: string; note: string }>;
  officerChanges: Array<{ date: ISODate; note: string }>;
  riskLevel: 'low' | 'medium' | 'high';
  riskReasons: string[];
}

// ---------------------------------------------------------------------------
// Claim bundle — the plain object every engine reads from (assembled by the API)
// ---------------------------------------------------------------------------

export interface ClaimBundle {
  claim: Claim;
  claimant: Party;
  driver?: Party;
  vehicle: Vehicle;
  thirdParties: Party[];
  thirdPartyVehicle?: Vehicle;
  atFaultInsurer?: Party;
  events: ClaimEvent[];
  ledger: LedgerEntry[];
  offers: InterventionOffer[];
  hire: HireAgreement[];
  storage: StorageRecord[];
  recovery: RecoveryRecord[];
  evidence: Evidence[];
  documents: GeneratedDocument[];
  clocks: Clock[];
  pav?: PavAssessment;
  estimate?: Estimate;
  report?: EngineerReport;
  flags?: ClaimFlag[];
}
