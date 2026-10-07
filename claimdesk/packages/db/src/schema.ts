/**
 * @ccguk/db — Drizzle (sqlite-core) schema.
 *
 * One table per entity in `@ccguk/domain` types.ts plus a few persistence-only tables
 * (claim_sequences, clocks cache, settings, audit_log, labour_library, directory_overrides, sessions).
 *
 * Conventions:
 *  - text primary keys (crypto.randomUUID()), ISO text for dates, integer pence for money
 *  - nested structures are JSON text columns typed with `$type<>()` so `$inferSelect` matches the domain
 *  - append-only tables (ledger_entries, claim_events, evidence, audit_log) are additionally protected by
 *    BEFORE UPDATE / BEFORE DELETE triggers in migration 0001
 *  - the cross-file registration rule (same registration on two claims) is a FLAG raised by the domain,
 *    not a database constraint — deliberately no unique index on claims (clientVehicleId, occurredAt)
 */
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  AccidentDetails,
  AdditionalDriver,
  Address,
  BankDetails,
  Claim,
  ClaimEvent,
  ClaimFlag,
  ClaimStatus,
  Clock,
  Comparable,
  CompanyWatch,
  ConsistencyReport,
  DocumentStatus,
  Estimate,
  EstimateLine,
  EstimateTotals,
  Evidence,
  EvidenceKind,
  EventType,
  ExifSummary,
  FleetUnit,
  FleetUse,
  FuelType,
  GeneratedDocument,
  GuidedShot,
  HeadOfLoss,
  HireAgreement,
  HireEndTrigger,
  InterventionOffer,
  LedgerKind,
  LiabilityPosition,
  LookupRecord,
  MotTest,
  OdometerReading,
  Party,
  PartyRole,
  PavSubject,
  PenaltyNotice,
  SalvageCategory,
  SignatureRecord,
  StorageRecord,
  TotalLossAssessment,
  Track,
  Transmission,
  UserRole,
  Vehicle,
  VehicleSpec,
  Verification,
} from '@ccguk/domain';
import type {
  AgentName,
  AgentsSettings,
  AiSettings,
  AutonomySettings,
  Basis,
  BrainPackKind,
  ChecklistState,
  JobStatus,
  JobType,
  Lane,
  MemoryKind,
  MemoryStatus,
  NeedsYouKind,
  NeedsYouOption,
  NeedsYouPriority,
  NeedsYouStatus,
  NotificationSettings,
  Recommendation,
  ReviewTargetKind,
  TaskStatus,
} from '@ccguk/domain';

// ---------------------------------------------------------------------------
// Persistence-only value types (no domain equivalent)
// ---------------------------------------------------------------------------

export interface RateCard {
  recoveryCalloutPence: number; // £90
  perMilePence: number; // £3 per loaded mile
  adminPence: number; // £25
  storageDailyPence: number; // £45/day
  engineerFeePence: number; // £285
  vatRate: number; // 0.2
}

export interface ApiKeysPresent {
  dvlaVes: boolean;
  dvsaMot: boolean;
  companiesHouse: boolean;
  gateway: boolean;
  esign: boolean;
}

// ---------------------------------------------------------------------------
// Users & parties
// ---------------------------------------------------------------------------

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    role: text('role').$type<UserRole>().notNull(),
    mfaEnabled: integer('mfa_enabled', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    /** Sign-in name, stored trimmed and lower-cased (case-insensitive unique). Null for staff who cannot sign in. */
    username: text('username'),
    /** "scrypt$N$r$p$saltB64$hashB64" — never a plain-text password (repos refuse anything else). */
    passwordHash: text('password_hash'),
    passwordChangedAt: text('password_changed_at'),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email), uniqueIndex('users_username_uq').on(t.username)],
);

/**
 * Signed-in sessions. `id` is the sha256 hex digest of the session token — the token itself is only ever held by the
 * browser (HttpOnly cookie). Rows expire (absolute `expires_at`) and are deleted on logout / password change, so this
 * table is NOT append-only.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    managerModeUntil: text('manager_mode_until'),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const parties = sqliteTable(
  'parties',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<Party['kind']>().notNull(),
    name: text('name').notNull(),
    tradingName: text('trading_name'),
    dateOfBirth: text('date_of_birth'),
    address: text('address', { mode: 'json' }).$type<Address>(),
    email: text('email'),
    phone: text('phone'),
    companyNumber: text('company_number'),
    vatRegistered: integer('vat_registered', { mode: 'boolean' }),
    drivingLicenceNumber: text('driving_licence_number'),
    bank: text('bank', { mode: 'json' }).$type<BankDetails>(),
    roles: text('roles', { mode: 'json' }).$type<PartyRole[]>().notNull(),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
    // normalised match keys for the linkage engine (maintained by the parties repo)
    phoneNormalised: text('phone_normalised'),
    emailNormalised: text('email_normalised'),
    postcodeNormalised: text('postcode_normalised'),
    bankKey: text('bank_key'),
  },
  (t) => [
    index('parties_name_idx').on(t.name),
    index('parties_phone_idx').on(t.phoneNormalised),
    index('parties_email_idx').on(t.emailNormalised),
    index('parties_postcode_idx').on(t.postcodeNormalised),
    index('parties_bank_idx').on(t.bankKey),
    index('parties_company_number_idx').on(t.companyNumber),
  ],
);

// ---------------------------------------------------------------------------
// Vehicles, fleet, policies, penalties
// ---------------------------------------------------------------------------

export const vehicles = sqliteTable(
  'vehicles',
  {
    id: text('id').primaryKey(),
    registration: text('registration').notNull(), // normalised: uppercase, no spaces
    vin: text('vin'),
    make: text('make').notNull(),
    model: text('model').notNull(),
    variant: text('variant'),
    bodyType: text('body_type'),
    yearOfManufacture: integer('year_of_manufacture'),
    monthOfFirstRegistration: text('month_of_first_registration'),
    fuelType: text('fuel_type').$type<FuelType>(),
    transmission: text('transmission').$type<Transmission>(),
    colour: text('colour'),
    engineCapacityCc: integer('engine_capacity_cc'),
    co2Gkm: integer('co2_gkm'),
    euroStatus: text('euro_status'),
    taxStatus: text('tax_status'),
    taxDueDate: text('tax_due_date'),
    motStatus: text('mot_status'),
    motExpiryDate: text('mot_expiry_date'),
    markedForExport: integer('marked_for_export', { mode: 'boolean' }),
    dateOfLastV5CIssued: text('date_of_last_v5c_issued'),
    motHistory: text('mot_history', { mode: 'json' }).$type<MotTest[]>(),
    odometer: text('odometer', { mode: 'json' }).$type<OdometerReading[]>().notNull(),
    gtaGroup: text('gta_group'),
    previousWriteOffCategory: text('previous_write_off_category').$type<SalvageCategory>(),
    ownership: text('ownership').$type<Vehicle['ownership']>().notNull(),
    lookups: text('lookups', { mode: 'json' }).$type<LookupRecord[]>().notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    /** Catalogue pick, segment, features and extras (TEMPLATES-VEHICLES-DESKTOP §D.10). Migration 0003. */
    spec: text('spec', { mode: 'json' }).$type<VehicleSpec>(),
  },
  (t) => [uniqueIndex('vehicles_registration_uq').on(t.registration), index('vehicles_vin_idx').on(t.vin)],
);

export const insurancePolicies = sqliteTable('insurance_policies', {
  id: text('id').primaryKey(),
  insurerName: text('insurer_name').notNull(),
  policyNumber: text('policy_number').notNull(),
  coveredUses: text('covered_uses', { mode: 'json' }).$type<FleetUse[]>().notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  evidenceId: text('evidence_id'),
  createdAt: text('created_at').notNull(),
});

export const fleetUnits = sqliteTable(
  'fleet_units',
  {
    id: text('id').primaryKey(),
    vehicleId: text('vehicle_id').notNull(),
    declaredUses: text('declared_uses', { mode: 'json' }).$type<FleetUse[]>().notNull(),
    policyId: text('policy_id'),
    dailyRatePence: integer('daily_rate_pence').notNull(),
    gtaGroup: text('gta_group').notNull(),
    keeperAddressOnV5C: text('keeper_address_on_v5c', { mode: 'json' }).$type<Address>(),
    keeperAddressCurrent: integer('keeper_address_current', { mode: 'boolean' }).notNull(),
    serviceDueDate: text('service_due_date'),
    status: text('status').$type<FleetUnit['status']>().notNull(),
    phvLicensed: integer('phv_licensed', { mode: 'boolean' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('fleet_units_vehicle_idx').on(t.vehicleId), index('fleet_units_status_idx').on(t.status)],
);

export const penaltyNotices = sqliteTable(
  'penalty_notices',
  {
    id: text('id').primaryKey(),
    fleetUnitId: text('fleet_unit_id').notNull(),
    kind: text('kind').$type<PenaltyNotice['kind']>().notNull(),
    issuer: text('issuer').notNull(),
    noticeNumber: text('notice_number').notNull(),
    contraventionAt: text('contravention_at').notNull(),
    receivedAt: text('received_at').notNull(),
    amountPence: integer('amount_pence').notNull(),
    discountDeadline: text('discount_deadline'),
    responseDeadline: text('response_deadline').notNull(),
    hireAgreementId: text('hire_agreement_id'),
    stage: text('stage').$type<PenaltyNotice['stage']>().notNull(),
    notes: text('notes'),
    documentIds: text('document_ids', { mode: 'json' }).$type<string[]>().notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('penalty_notices_fleet_unit_idx').on(t.fleetUnitId), index('penalty_notices_stage_idx').on(t.stage)],
);

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** Per-year counter behind the CCG-YYYY-NNNNN reference generator. */
export const claimSequences = sqliteTable('claim_sequences', {
  year: integer('year').primaryKey(),
  last: integer('last').notNull(),
});

export const claims = sqliteTable(
  'claims',
  {
    id: text('id').primaryKey(),
    reference: text('reference').notNull(),
    status: text('status').$type<ClaimStatus>().notNull(),
    openedAt: text('opened_at').notNull(),
    accident: text('accident', { mode: 'json' }).$type<AccidentDetails>().notNull(),
    liability: text('liability').$type<LiabilityPosition>().notNull(),
    liabilityScore: integer('liability_score'),
    claimantId: text('claimant_id').notNull(),
    driverId: text('driver_id'),
    clientVehicleId: text('client_vehicle_id').notNull(),
    thirdPartyIds: text('third_party_ids', { mode: 'json' }).$type<string[]>().notNull(),
    thirdPartyVehicleId: text('third_party_vehicle_id'),
    atFaultInsurerId: text('at_fault_insurer_id'),
    atFaultInsurerRef: text('at_fault_insurer_ref'),
    clientInsurerId: text('client_insurer_id'),
    clientPolicyNumber: text('client_policy_number'),
    handlerId: text('handler_id'),
    gtaSubscriber: integer('gta_subscriber', { mode: 'boolean' }).notNull().default(false),
    injuryReferral: text('injury_referral', { mode: 'json' }).$type<Claim['injuryReferral']>(),
    track: text('track').$type<Track>(),
    linkedClaimIds: text('linked_claim_ids', { mode: 'json' }).$type<string[]>().notNull(),
    flags: text('flags', { mode: 'json' }).$type<ClaimFlag[]>().notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('claims_reference_uq').on(t.reference),
    index('claims_status_idx').on(t.status),
    index('claims_claimant_idx').on(t.claimantId),
    index('claims_client_vehicle_idx').on(t.clientVehicleId),
    index('claims_third_party_vehicle_idx').on(t.thirdPartyVehicleId),
    index('claims_handler_idx').on(t.handlerId),
    index('claims_at_fault_insurer_idx').on(t.atFaultInsurerId),
    index('claims_opened_at_idx').on(t.openedAt),
  ],
);

// ---------------------------------------------------------------------------
// Ledger (append-only) and events (append-only)
// ---------------------------------------------------------------------------

export const ledgerEntries = sqliteTable(
  'ledger_entries',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    head: text('head').$type<HeadOfLoss>().notNull(),
    kind: text('kind').$type<LedgerKind>().notNull(),
    amountPence: integer('amount_pence').notNull(),
    vatPence: integer('vat_pence'),
    date: text('date').notNull(),
    description: text('description').notNull(),
    counterpartyId: text('counterparty_id'),
    reference: text('reference'),
    sourceDocumentId: text('source_document_id'),
    sourceEvidenceId: text('source_evidence_id'),
    supersedesId: text('supersedes_id'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('ledger_entries_claim_idx').on(t.claimId),
    index('ledger_entries_claim_head_kind_idx').on(t.claimId, t.head, t.kind),
    index('ledger_entries_supersedes_idx').on(t.supersedesId),
  ],
);

export const claimEvents = sqliteTable(
  'claim_events',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    type: text('type').$type<EventType>().notNull(),
    at: text('at').notNull(),
    recordedAt: text('recorded_at').notNull(),
    summary: text('summary').notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
    attributableTo: text('attributable_to').$type<ClaimEvent['attributableTo']>(),
    evidenceIds: text('evidence_ids', { mode: 'json' }).$type<string[]>().notNull(),
    documentId: text('document_id'),
    createdBy: text('created_by').notNull(),
  },
  (t) => [index('claim_events_claim_idx').on(t.claimId), index('claim_events_claim_at_idx').on(t.claimId, t.at), index('claim_events_type_idx').on(t.claimId, t.type)],
);

// ---------------------------------------------------------------------------
// Hire, storage, recovery
// ---------------------------------------------------------------------------

export const hireAgreements = sqliteTable(
  'hire_agreements',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    fleetUnitId: text('fleet_unit_id').notNull(),
    agreementNumber: text('agreement_number').notNull(),
    startAt: text('start_at').notNull(),
    endAt: text('end_at'),
    endTrigger: text('end_trigger').$type<HireEndTrigger>(),
    dailyRatePence: integer('daily_rate_pence').notNull(),
    vatRate: real('vat_rate').notNull(),
    gtaGroup: text('gta_group').notNull(),
    excessPence: integer('excess_pence').notNull(),
    excessWaiverDailyPence: integer('excess_waiver_daily_pence'),
    additionalDrivers: text('additional_drivers', { mode: 'json' }).$type<AdditionalDriver[]>().notNull(),
    deliveredAt: text('delivered_at'),
    collectedAt: text('collected_at'),
    odometerOut: integer('odometer_out'),
    odometerIn: integer('odometer_in'),
    signedAt: text('signed_at'),
    documentId: text('document_id'),
    enforceability: text('enforceability', { mode: 'json' }).$type<HireAgreement['enforceability']>().notNull(),
    needStatementEvidenceId: text('need_statement_evidence_id'),
    mitigationQuestionnaireDocumentId: text('mitigation_questionnaire_document_id'),
    statementOfMeansDocumentId: text('statement_of_means_document_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    clientGtaGroup: text('client_gta_group'),
    clientGtaDailyRatePence: integer('client_gta_daily_rate_pence'),
    hireGtaDailyRatePence: integer('hire_gta_daily_rate_pence'),
    fleetDailyRatePence: integer('fleet_daily_rate_pence'),
    pricingNote: text('pricing_note'),
  },
  (t) => [
    index('hire_agreements_claim_idx').on(t.claimId),
    index('hire_agreements_fleet_unit_idx').on(t.fleetUnitId),
    uniqueIndex('hire_agreements_number_uq').on(t.agreementNumber),
  ],
);

export const storageRecords = sqliteTable(
  'storage_records',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    location: text('location').notNull(),
    startAt: text('start_at').notNull(),
    endAt: text('end_at'),
    endTrigger: text('end_trigger').$type<StorageRecord['endTrigger']>(),
    dailyRatePence: integer('daily_rate_pence').notNull(),
    vatRate: real('vat_rate').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('storage_records_claim_idx').on(t.claimId)],
);

export const recoveryRecords = sqliteTable(
  'recovery_records',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    at: text('at').notNull(),
    fromLocation: text('from_location').notNull(),
    toLocation: text('to_location').notNull(),
    calloutPence: integer('callout_pence').notNull(),
    loadedMiles: real('loaded_miles').notNull(),
    perLoadedMilePence: integer('per_loaded_mile_pence').notNull(),
    adminPence: integer('admin_pence').notNull(),
    vatRate: real('vat_rate').notNull(),
    evidenceIds: text('evidence_ids', { mode: 'json' }).$type<string[]>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('recovery_records_claim_idx').on(t.claimId)],
);

// ---------------------------------------------------------------------------
// Intervention register
// ---------------------------------------------------------------------------

export const interventionOffers = sqliteTable(
  'intervention_offers',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    receivedAt: text('received_at').notNull(),
    channel: text('channel').$type<InterventionOffer['channel']>().notNull(),
    offerorPartyId: text('offeror_party_id'),
    offerorName: text('offeror_name').notNull(),
    vehicleClassOffered: text('vehicle_class_offered'),
    dailyRatePence: integer('daily_rate_pence'),
    rateIncludesVat: integer('rate_includes_vat', { mode: 'boolean' }),
    terms: text('terms', { mode: 'json' }).$type<InterventionOffer['terms']>().notNull(),
    suitable: integer('suitable', { mode: 'boolean' }),
    suitabilityReasons: text('suitability_reasons', { mode: 'json' }).$type<string[]>().notNull(),
    clientDecision: text('client_decision').$type<InterventionOffer['clientDecision']>().notNull(),
    clientReasons: text('client_reasons'),
    clientDecisionAt: text('client_decision_at'),
    replySentAt: text('reply_sent_at'),
    replyDocumentId: text('reply_document_id'),
    evidenceIds: text('evidence_ids', { mode: 'json' }).$type<string[]>().notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('intervention_offers_claim_idx').on(t.claimId)],
);

// ---------------------------------------------------------------------------
// Clocks (materialised cache of `deriveClocks` output — optional, rebuilt by the API)
// ---------------------------------------------------------------------------

export const clocks = sqliteTable(
  'clocks',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    kind: text('kind').$type<Clock['kind']>().notNull(),
    label: text('label').notNull(),
    basis: text('basis').notNull(),
    startsAt: text('starts_at').notNull(),
    dueAt: text('due_at').notNull(),
    status: text('status').$type<Clock['status']>().notNull(),
    metAt: text('met_at'),
    stoppedAt: text('stopped_at'),
    stoppedReason: text('stopped_reason'),
    attributableTo: text('attributable_to').$type<Clock['attributableTo']>(),
    sourceEventId: text('source_event_id'),
    computedAt: text('computed_at').notNull(),
  },
  (t) => [index('clocks_claim_idx').on(t.claimId), index('clocks_due_idx').on(t.status, t.dueAt)],
);

// ---------------------------------------------------------------------------
// Evidence (append-only) and documents
// ---------------------------------------------------------------------------

export const evidence = sqliteTable(
  'evidence',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id'),
    kind: text('kind').$type<EvidenceKind>().notNull(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    storagePath: text('storage_path').notNull(),
    capturedAt: text('captured_at'),
    uploadedAt: text('uploaded_at').notNull(),
    uploadedBy: text('uploaded_by').notNull(),
    exif: text('exif', { mode: 'json' }).$type<ExifSummary>(),
    captureShot: text('capture_shot').$type<GuidedShot>(),
    sourceUrl: text('source_url'),
    description: text('description'),
  },
  (t) => [index('evidence_claim_idx').on(t.claimId), index('evidence_sha256_idx').on(t.sha256)],
);

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id'),
    templateId: text('template_id').notNull(),
    templateVersion: text('template_version').notNull(),
    title: text('title').notNull(),
    recipientPartyId: text('recipient_party_id'),
    status: text('status').$type<DocumentStatus>().notNull(),
    html: text('html').notNull(),
    pdfPath: text('pdf_path'),
    sha256: text('sha256').notNull(),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').notNull(),
    approvedAt: text('approved_at'),
    approvedBy: text('approved_by'),
    sentAt: text('sent_at'),
    sentVia: text('sent_via').$type<GeneratedDocument['sentVia']>(),
    supersedesId: text('supersedes_id'),
    reExecutedOn: text('re_executed_on'),
    consistency: text('consistency', { mode: 'json' }).$type<ConsistencyReport>(),
    signature: text('signature', { mode: 'json' }).$type<SignatureRecord>(),
    dataSnapshot: text('data_snapshot', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    updatedAt: text('updated_at').notNull(),
    /** 'docx' for documents filled from a Word template (migration 0004, TEMPLATES-VEHICLES-DESKTOP §C.3). */
    format: text('format').$type<'html' | 'docx'>().notNull().default('html'),
    /** DOCX documents: the filled .docx relative to DOCUMENTS_DIR. */
    docxPath: text('docx_path'),
    docxSha256: text('docx_sha256'),
    pdfConverter: text('pdf_converter').$type<'word' | 'libreoffice' | 'browser' | 'chromium-html'>(),
  },
  (t) => [
    index('documents_claim_idx').on(t.claimId),
    index('documents_template_idx').on(t.templateId),
    index('documents_status_idx').on(t.status),
    index('documents_supersedes_idx').on(t.supersedesId),
  ],
);

export const signatures = sqliteTable(
  'signatures',
  {
    id: text('id').primaryKey(), // == SignatureRecord.certificateId
    documentId: text('document_id').notNull(),
    signerPartyId: text('signer_party_id').notNull(),
    signerName: text('signer_name').notNull(),
    signerContact: text('signer_contact').notNull(),
    otpChannel: text('otp_channel').$type<SignatureRecord['otpChannel']>().notNull(),
    otpVerifiedAt: text('otp_verified_at').notNull(),
    ipAddress: text('ip_address').notNull(),
    userAgent: text('user_agent').notNull(),
    signedAt: text('signed_at').notNull(),
    documentSha256: text('document_sha256').notNull(),
    certificatePdfPath: text('certificate_pdf_path'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('signatures_document_idx').on(t.documentId), index('signatures_signer_idx').on(t.signerPartyId)],
);

// ---------------------------------------------------------------------------
// Engineering: PAV, estimates, reports
// ---------------------------------------------------------------------------

export const pavAssessments = sqliteTable(
  'pav_assessments',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    subject: text('subject', { mode: 'json' }).$type<PavSubject>().notNull(),
    comparables: text('comparables', { mode: 'json' }).$type<Comparable[]>().notNull(),
    perMilePence: real('per_mile_pence').notNull(),
    perMileSource: text('per_mile_source').$type<'regression' | 'fallback_band'>().notNull(),
    medianPence: integer('median_pence').notNull(),
    iqrLowPence: integer('iqr_low_pence').notNull(),
    iqrHighPence: integer('iqr_high_pence').notNull(),
    tradeGuidePence: integer('trade_guide_pence'),
    tradeGuideSource: text('trade_guide_source'),
    pavPence: integer('pav_pence').notNull(),
    overrideReason: text('override_reason'),
    reasoning: text('reasoning').notNull(),
    approvedBy: text('approved_by'),
    approvedAt: text('approved_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('pav_assessments_claim_idx').on(t.claimId)],
);

export const estimates = sqliteTable(
  'estimates',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    vehicleId: text('vehicle_id').notNull(),
    lines: text('lines', { mode: 'json' }).$type<EstimateLine[]>().notNull(),
    labourRatePence: integer('labour_rate_pence').notNull(),
    paintRatePence: integer('paint_rate_pence').notNull(),
    paintMaterialsMethod: text('paint_materials_method').$type<Estimate['paintMaterialsMethod']>().notNull(),
    paintMaterialsPerHourPence: integer('paint_materials_per_hour_pence'),
    vatRate: real('vat_rate').notNull(),
    importedFromEvidenceId: text('imported_from_evidence_id'),
    importedTotalPence: integer('imported_total_pence'),
    reconciled: integer('reconciled', { mode: 'boolean' }),
    totals: text('totals', { mode: 'json' }).$type<EstimateTotals>().notNull(),
    createdAt: text('created_at').notNull(),
    approvedBy: text('approved_by'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('estimates_claim_idx').on(t.claimId), index('estimates_vehicle_idx').on(t.vehicleId)],
);

export const engineerReports = sqliteTable(
  'engineer_reports',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    vehicleId: text('vehicle_id').notNull(),
    engineerPartyId: text('engineer_party_id').notNull(),
    engineerQualifications: text('engineer_qualifications').notNull(),
    instructedBy: text('instructed_by').notNull(),
    instructedAt: text('instructed_at').notNull(),
    inspectionAt: text('inspection_at'),
    inspectionPlace: text('inspection_place'),
    inspectionBasis: text('inspection_basis').$type<'physical' | 'desktop'>().notNull(),
    inspectionConditions: text('inspection_conditions'),
    odometerMiles: integer('odometer_miles'),
    preAccidentCondition: text('pre_accident_condition').notNull(),
    damageDescription: text('damage_description').notNull(),
    consistentWithCircumstances: integer('consistent_with_circumstances', { mode: 'boolean' }).notNull(),
    consistencyNote: text('consistency_note'),
    repairMethod: text('repair_method'),
    estimateId: text('estimate_id'),
    roadworthy: integer('roadworthy', { mode: 'boolean' }).notNull(),
    roadworthyReason: text('roadworthy_reason').notNull(),
    repairDurationWorkingDays: integer('repair_duration_working_days'),
    totalLoss: text('total_loss', { mode: 'json' }).$type<TotalLossAssessment>(),
    pavAssessmentId: text('pav_assessment_id'),
    salvageCategory: text('salvage_category').$type<SalvageCategory>(),
    salvageValuePence: integer('salvage_value_pence'),
    adasNotes: text('adas_notes'),
    evNotes: text('ev_notes'),
    diagnosticFaultCodes: text('diagnostic_fault_codes', { mode: 'json' }).$type<string[]>(),
    photoEvidenceIds: text('photo_evidence_ids', { mode: 'json' }).$type<string[]>().notNull(),
    forCourt: integer('for_court', { mode: 'boolean' }).notNull(),
    feePence: integer('fee_pence').notNull(),
    issuedAt: text('issued_at'),
    documentId: text('document_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('engineer_reports_claim_idx').on(t.claimId)],
);

// ---------------------------------------------------------------------------
// Counterparty monitoring, directory overrides, settings, audit, labour library
// ---------------------------------------------------------------------------

export const companyWatch = sqliteTable(
  'company_watch',
  {
    companyNumber: text('company_number').primaryKey(),
    name: text('name').notNull(),
    role: text('role').$type<CompanyWatch['role']>().notNull(),
    lastPolledAt: text('last_polled_at'),
    status: text('status'),
    accountsOverdue: integer('accounts_overdue', { mode: 'boolean' }),
    confirmationStatementOverdue: integer('confirmation_statement_overdue', { mode: 'boolean' }),
    gazetteNotices: text('gazette_notices', { mode: 'json' }).$type<CompanyWatch['gazetteNotices']>().notNull(),
    officerChanges: text('officer_changes', { mode: 'json' }).$type<CompanyWatch['officerChanges']>().notNull(),
    riskLevel: text('risk_level').$type<CompanyWatch['riskLevel']>().notNull(),
    riskReasons: text('risk_reasons', { mode: 'json' }).$type<string[]>().notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('company_watch_risk_idx').on(t.riskLevel)],
);

/** Human edits layered on top of the read-only KB insurer directory JSON (`@ccguk/kb`). */
export const directoryOverrides = sqliteTable('directory_overrides', {
  id: text('id').primaryKey(), // InsurerDirectoryEntry.id (slug)
  verification: text('verification', { mode: 'json' }).$type<Verification>(),
  lastUsedOk: text('last_used_ok'),
  lastFailed: text('last_failed'),
  notes: text('notes'),
  updatedAt: text('updated_at').notNull(),
  updatedBy: text('updated_by').notNull(),
});

/** Single row keyed 'default'. */
export const settings = sqliteTable('settings', {
  id: text('id').primaryKey(),
  companyName: text('company_name').notNull(),
  companyNumber: text('company_number'),
  registeredOffice: text('registered_office', { mode: 'json' }).$type<Address>(),
  vatNumber: text('vat_number'),
  bank: text('bank', { mode: 'json' }).$type<BankDetails>(),
  icoRegistration: text('ico_registration'),
  rateCard: text('rate_card', { mode: 'json' }).$type<RateCard>().notNull(),
  apiKeysPresent: text('api_keys_present', { mode: 'json' }).$type<ApiKeysPresent>().notNull(),
  updatedAt: text('updated_at').notNull(),
  managerModeIdleMinutes: integer('manager_mode_idle_minutes'),
});

/** Append-only. */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    at: text('at').notNull(),
    userId: text('user_id').notNull(), // user id or 'system'
    action: text('action').notNull(), // e.g. 'claim.status', 'document.approve'
    entity: text('entity').notNull(), // table / aggregate name
    entityId: text('entity_id').notNull(),
    before: text('before', { mode: 'json' }).$type<unknown>(),
    after: text('after', { mode: 'json' }).$type<unknown>(),
    ip: text('ip'),
    /** agent_runs.id when an agent principal acted (migration 0008, SUPREME §B.1). */
    runId: text('run_id'),
  },
  (t) => [index('audit_log_entity_idx').on(t.entity, t.entityId), index('audit_log_at_idx').on(t.at), index('audit_log_user_idx').on(t.userId), index('audit_log_run_idx').on(t.runId)],
);

/** In-house labour-time library built from CCGUK's own approved estimates (BLUEPRINT §4.5(c)). */
export const labourLibrary = sqliteTable(
  'labour_library',
  {
    id: text('id').primaryKey(),
    make: text('make').notNull(),
    model: text('model').notNull(),
    panel: text('panel').notNull(),
    operation: text('operation').notNull(),
    hours: real('hours').notNull(),
    ratePence: integer('rate_pence'),
    source: text('source').$type<'approved_estimate' | 'manual'>().notNull(),
    estimateId: text('estimate_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('labour_library_lookup_idx').on(t.make, t.model, t.panel, t.operation)],
);

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
export type PartyRow = typeof parties.$inferSelect;
export type PartyInsert = typeof parties.$inferInsert;
export type VehicleRow = typeof vehicles.$inferSelect;
export type VehicleInsert = typeof vehicles.$inferInsert;
export type InsurancePolicyRow = typeof insurancePolicies.$inferSelect;
export type InsurancePolicyInsert = typeof insurancePolicies.$inferInsert;
export type FleetUnitRow = typeof fleetUnits.$inferSelect;
export type FleetUnitInsert = typeof fleetUnits.$inferInsert;
export type PenaltyNoticeRow = typeof penaltyNotices.$inferSelect;
export type PenaltyNoticeInsert = typeof penaltyNotices.$inferInsert;
export type ClaimSequenceRow = typeof claimSequences.$inferSelect;
export type ClaimRow = typeof claims.$inferSelect;
export type ClaimInsert = typeof claims.$inferInsert;
export type LedgerEntryRow = typeof ledgerEntries.$inferSelect;
export type LedgerEntryInsert = typeof ledgerEntries.$inferInsert;
export type ClaimEventRow = typeof claimEvents.$inferSelect;
export type ClaimEventInsert = typeof claimEvents.$inferInsert;
export type HireAgreementRow = typeof hireAgreements.$inferSelect;
export type HireAgreementInsert = typeof hireAgreements.$inferInsert;
export type StorageRecordRow = typeof storageRecords.$inferSelect;
export type StorageRecordInsert = typeof storageRecords.$inferInsert;
export type RecoveryRecordRow = typeof recoveryRecords.$inferSelect;
export type RecoveryRecordInsert = typeof recoveryRecords.$inferInsert;
export type InterventionOfferRow = typeof interventionOffers.$inferSelect;
export type InterventionOfferInsert = typeof interventionOffers.$inferInsert;
export type ClockRow = typeof clocks.$inferSelect;
export type ClockInsert = typeof clocks.$inferInsert;
export type EvidenceRow = typeof evidence.$inferSelect;
export type EvidenceInsert = typeof evidence.$inferInsert;
export type DocumentRow = typeof documents.$inferSelect;
export type DocumentInsert = typeof documents.$inferInsert;
export type SignatureRow = typeof signatures.$inferSelect;
export type SignatureInsert = typeof signatures.$inferInsert;
export type PavAssessmentRow = typeof pavAssessments.$inferSelect;
export type PavAssessmentInsert = typeof pavAssessments.$inferInsert;
export type EstimateRow = typeof estimates.$inferSelect;
export type EstimateInsert = typeof estimates.$inferInsert;
export type EngineerReportRow = typeof engineerReports.$inferSelect;
export type EngineerReportInsert = typeof engineerReports.$inferInsert;
export type CompanyWatchRow = typeof companyWatch.$inferSelect;
export type CompanyWatchInsert = typeof companyWatch.$inferInsert;
export type DirectoryOverrideRow = typeof directoryOverrides.$inferSelect;
export type DirectoryOverrideInsert = typeof directoryOverrides.$inferInsert;
export type SettingsRow = typeof settings.$inferSelect;
export type SettingsInsert = typeof settings.$inferInsert;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;
export type LabourLibraryRow = typeof labourLibrary.$inferSelect;
export type LabourLibraryInsert = typeof labourLibrary.$inferInsert;

// Compile-time guards: domain-typed rows must stay structurally compatible with the domain entities.
// (Unused helpers evaluated by tsc only.)
type _AssertAssignable<_T extends U, U> = true;
type _Checks = [
  _AssertAssignable<Required<Evidence>['kind'], EvidenceRow['kind']>,
  _AssertAssignable<Required<Claim>['status'], ClaimRow['status']>,
];

// ---------------------------------------------------------------------------
// Vehicle catalogue additions and GTA benchmark rates (migration 0003, TEMPLATES-VEHICLES-DESKTOP §D.7, §F.3)
// ---------------------------------------------------------------------------

/**
 * Manual GTA benchmark rates layered over the KB file: a row replaces the KB row with the same (group, period), or hides
 * it (`suppressed`, daily rate NULL). GTA rates are an industry benchmark only — CCGUK is not a GTA subscriber.
 */
export const gtaRates = sqliteTable(
  'gta_rates',
  {
    id: text('id').primaryKey(),
    groupCode: text('group_code').notNull(),
    description: text('description'),
    /** NULL only for a suppress row. */
    dailyRatePence: integer('daily_rate_pence'),
    /** 'YYYY-YY'. */
    period: text('period').notNull(),
    effectiveFrom: text('effective_from').notNull(),
    effectiveTo: text('effective_to').notNull(),
    verification: text('verification', { mode: 'json' }).$type<Verification>().notNull(),
    suppressed: integer('suppressed', { mode: 'boolean' }).notNull().default(false),
    note: text('note'),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').notNull(),
    updatedAt: text('updated_at').notNull(),
    updatedBy: text('updated_by').notNull(),
  },
  (t) => [uniqueIndex('gta_rates_group_period_uq').on(t.groupCode, t.period)],
);

/** Segment → GTA group overrides of packages/kb/data/gta-segment-defaults.json. */
export const gtaSegmentDefaults = sqliteTable('gta_segment_defaults', {
  segment: text('segment').primaryKey(),
  groupCode: text('group_code').notNull(),
  updatedAt: text('updated_at').notNull(),
  updatedBy: text('updated_by').notNull(),
});

/** User additions to the shipped vehicle catalogue (soft-deleted). */
export const vehicleCatalogueCustom = sqliteTable(
  'vehicle_catalogue_custom',
  {
    id: text('id').primaryKey(),
    level: text('level').$type<'make' | 'model' | 'generation' | 'trim' | 'engine'>().notNull(),
    make: text('make').notNull(),
    makeSlug: text('make_slug').notNull(),
    model: text('model'),
    modelSlug: text('model_slug'),
    generationId: text('generation_id'),
    /** The new entry's display name / engine label. */
    name: text('name').notNull(),
    /** Partial CatalogueModel | CatalogueGeneration | CatalogueTrim | CatalogueEngine. */
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    segment: text('segment'),
    gtaGroup: text('gta_group'),
    /** true = adjusts segment/gta_group of a shipped model/generation/trim (no new entry). */
    overridesBuiltin: integer('overrides_builtin', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').notNull(),
    deletedAt: text('deleted_at'),
    deletedBy: text('deleted_by'),
  },
  (t) => [index('vehicle_catalogue_custom_make_idx').on(t.makeSlug, t.modelSlug)],
);

export type GtaRateRow = typeof gtaRates.$inferSelect;
export type GtaRateInsert = typeof gtaRates.$inferInsert;
export type GtaSegmentDefaultRow = typeof gtaSegmentDefaults.$inferSelect;
export type VehicleCatalogueCustomRow = typeof vehicleCatalogueCustom.$inferSelect;
export type VehicleCatalogueCustomInsert = typeof vehicleCatalogueCustom.$inferInsert;

// ---------------------------------------------------------------------------
// Word template library (migration 0004, TEMPLATES-VEHICLES-DESKTOP §C.3)
// ---------------------------------------------------------------------------

/**
 * Built-in (shipped .docx assets; the row caches the scan and holds a mapping override layer) and uploaded Word
 * templates (files under TEMPLATES_DIR, path relative to it). Uploaded files are immutable: a replacement adds a new
 * file and bumps `file_version`.
 */
export const documentTemplates = sqliteTable(
  'document_templates',
  {
    id: text('id').primaryKey(),
    source: text('source').$type<'builtin' | 'uploaded'>().notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    recipientRole: text('recipient_role'),
    fileName: text('file_name').notNull(),
    /** Uploads: relative to TEMPLATES_DIR; built-ins: NULL. */
    filePath: text('file_path'),
    sha256: text('sha256').notNull(),
    bytes: integer('bytes').notNull(),
    fileVersion: integer('file_version').notNull().default(1),
    mappingRevision: integer('mapping_revision').notNull().default(0),
    scanVersion: integer('scan_version').notNull(),
    /** JSON DocxScan without `text`. */
    scan: text('scan', { mode: 'json' }).$type<unknown>().notNull(),
    /** JSON TemplateMapping (uploads) | override layer (built-ins) | NULL. */
    mapping: text('mapping', { mode: 'json' }).$type<unknown>(),
    warnings: text('warnings', { mode: 'json' }).$type<unknown[]>().notNull().default([]),
    warningsAcknowledgedAt: text('warnings_acknowledged_at'),
    warningsAcknowledgedBy: text('warnings_acknowledged_by'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').notNull(),
    updatedAt: text('updated_at').notNull(),
    updatedBy: text('updated_by').notNull(),
  },
  (t) => [index('document_templates_source_idx').on(t.source), index('document_templates_sha_idx').on(t.sha256)],
);

export type DocumentTemplateDbRow = typeof documentTemplates.$inferSelect;
export type DocumentTemplateDbInsert = typeof documentTemplates.$inferInsert;

// ---------------------------------------------------------------------------
// ClaimDesk Supreme phase 1 (migrations 0008–0011, docs/SUPREME-DESIGN.md §N.1–N.4)
// FTS5 virtual tables (brain_fts, search_docs) are created in SQL and read with raw SQL — not declared here.
// ---------------------------------------------------------------------------

/** Durable agent job queue (§C.3). Leasing is a single UPDATE … RETURNING in repos/agentJobs.ts. */
export const agentJobs = sqliteTable(
  'agent_jobs',
  {
    id: text('id').primaryKey(),
    type: text('type').$type<JobType>().notNull(),
    agent: text('agent').$type<AgentName | 'system'>().notNull(),
    claimId: text('claim_id'),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    status: text('status').$type<JobStatus>().notNull(),
    lane: text('lane').$type<Lane>().notNull(),
    mutates: integer('mutates', { mode: 'boolean' }).notNull().default(false),
    priority: integer('priority').notNull().default(5),
    runAfter: text('run_after').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    leaseOwner: text('lease_owner'),
    leaseUntil: text('lease_until'),
    idempotencyKey: text('idempotency_key'),
    parentJobId: text('parent_job_id'),
    correlationId: text('correlation_id').notNull(),
    depth: integer('depth').notNull().default(0),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    error: text('error'),
    needsYouId: text('needs_you_id'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [index('agent_jobs_ready_idx').on(t.status, t.lane, t.priority, t.runAfter), index('agent_jobs_claim_idx').on(t.claimId, t.status), index('agent_jobs_corr_idx').on(t.correlationId)],
);

/** One row per attempt (append-only). */
export const agentJobAttempts = sqliteTable(
  'agent_job_attempts',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    attempt: integer('attempt').notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    outcome: text('outcome').notNull(),
    error: text('error'),
    runId: text('run_id'),
  },
  (t) => [index('agent_job_attempts_job_idx').on(t.jobId, t.attempt)],
);

export const agentSchedules = sqliteTable('agent_schedules', {
  id: text('id').primaryKey(),
  jobType: text('job_type').$type<JobType>().notNull(),
  payload: text('payload', { mode: 'json' }).$type<unknown>().notNull().default({}),
  everyMinutes: integer('every_minutes'),
  /** HH:MM Europe/London. */
  atLocal: text('at_local'),
  /** JSON array of ISO weekdays (1 = Monday … 7 = Sunday), null = every day. */
  weekdays: text('weekdays', { mode: 'json' }).$type<number[]>(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  nextRunAt: text('next_run_at').notNull(),
  lastRunAt: text('last_run_at'),
  lastJobId: text('last_job_id'),
  updatedAt: text('updated_at').notNull(),
});

export type AgentRunOutcome = 'ok' | 'usage_limited' | 'auth_failed' | 'refused' | 'invalid_output' | 'timeout' | 'error' | 'cancelled';

export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    agent: text('agent').$type<AgentName>().notNull(),
    jobType: text('job_type').$type<JobType>().notNull(),
    claimId: text('claim_id'),
    driver: text('driver').notNull(),
    model: text('model').notNull(),
    effort: text('effort').notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputSha256: text('input_sha256').notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    outcome: text('outcome').$type<AgentRunOutcome>(),
    numTurns: integer('num_turns'),
    toolCalls: integer('tool_calls').notNull().default(0),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    costUsd: real('cost_usd'),
    rateLimit: text('rate_limit', { mode: 'json' }).$type<unknown>(),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    error: text('error'),
  },
  (t) => [index('agent_runs_claim_idx').on(t.claimId, t.startedAt), index('agent_runs_agent_idx').on(t.agent, t.startedAt), index('agent_runs_job_idx').on(t.jobId)],
);

export type ToolCallDecision = 'allowed' | 'asked' | 'denied' | 'invalid' | 'error';

/** Append-only. */
export const agentToolCalls = sqliteTable(
  'agent_tool_calls',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    tool: text('tool').notNull(),
    actionClass: text('action_class').notNull(),
    decision: text('decision').$type<ToolCallDecision>().notNull(),
    ruleIds: text('rule_ids', { mode: 'json' }).$type<string[]>(),
    inputRedacted: text('input_redacted', { mode: 'json' }).$type<unknown>(),
    outputSummary: text('output_summary'),
    httpStatus: integer('http_status'),
    needsYouId: text('needs_you_id'),
    durationMs: integer('duration_ms'),
    at: text('at').notNull(),
  },
  (t) => [index('agent_tool_calls_run_idx').on(t.runId, t.seq)],
);

/** One row (id 'default'): usage-window pause and the latest rate-limit snapshots (§A.5). */
export const aiUsageState = sqliteTable('ai_usage_state', {
  id: text('id').primaryKey(),
  driver: text('driver').notNull(),
  pausedUntil: text('paused_until'),
  pauseReason: text('pause_reason'),
  fiveHour: text('five_hour', { mode: 'json' }).$type<unknown>(),
  sevenDay: text('seven_day', { mode: 'json' }).$type<unknown>(),
  costTodayUsd: real('cost_today_usd').notNull().default(0),
  costDay: text('cost_day'),
  updatedAt: text('updated_at').notNull(),
});

/** One row (id 'default'); every JSON column is merged over the @ccguk/domain defaults on read. */
export const agentSettings = sqliteTable('agent_settings', {
  id: text('id').primaryKey(),
  ai: text('ai', { mode: 'json' }).$type<Partial<AiSettings>>().notNull(),
  autonomy: text('autonomy', { mode: 'json' }).$type<Partial<AutonomySettings>>().notNull(),
  notifications: text('notifications', { mode: 'json' }).$type<Partial<NotificationSettings>>().notNull(),
  agents: text('agents', { mode: 'json' }).$type<Partial<AgentsSettings>>().notNull(),
  checklist: text('checklist', { mode: 'json' }).$type<Partial<ChecklistState>>().notNull(),
  updatedAt: text('updated_at').notNull(),
  updatedBy: text('updated_by').notNull(),
});

export const claimAgentState = sqliteTable('claim_agent_state', {
  claimId: text('claim_id').primaryKey(),
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  pausedBy: text('paused_by'),
  pausedReason: text('paused_reason'),
  pausedAt: text('paused_at'),
  lastReviewAt: text('last_review_at'),
  lastReviewRunId: text('last_review_run_id'),
  nextReviewAt: text('next_review_at'),
  runsToday: integer('runs_today').notNull().default(0),
  runsDay: text('runs_day'),
});

export const needsYou = sqliteTable(
  'needs_you',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<NeedsYouKind>().notNull(),
    claimId: text('claim_id'),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    recommendation: text('recommendation', { mode: 'json' }).$type<Recommendation>(),
    options: text('options', { mode: 'json' }).$type<NeedsYouOption[]>().notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    priority: text('priority').$type<NeedsYouPriority>().notNull(),
    dueAt: text('due_at'),
    status: text('status').$type<NeedsYouStatus>().notNull(),
    snoozedUntil: text('snoozed_until'),
    resolution: text('resolution', { mode: 'json' }).$type<unknown>(),
    dedupeKey: text('dedupe_key'),
    correlationId: text('correlation_id'),
    resumesJobId: text('resumes_job_id'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    resolvedBy: text('resolved_by'),
    resolvedAt: text('resolved_at'),
  },
  (t) => [index('needs_you_open_idx').on(t.status, t.priority, t.createdAt), index('needs_you_claim_idx').on(t.claimId, t.status)],
);

/** Append-only. */
export const needsYouEvents = sqliteTable(
  'needs_you_events',
  {
    id: text('id').primaryKey(),
    needsYouId: text('needs_you_id').notNull(),
    fromStatus: text('from_status').$type<NeedsYouStatus>(),
    toStatus: text('to_status').$type<NeedsYouStatus>().notNull(),
    actor: text('actor').notNull(),
    optionId: text('option_id'),
    note: text('note'),
    at: text('at').notNull(),
  },
  (t) => [index('needs_you_events_item_idx').on(t.needsYouId, t.at)],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    note: text('note'),
    actionCode: text('action_code'),
    dueAt: text('due_at').notNull(),
    status: text('status').$type<TaskStatus>().notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    completedBy: text('completed_by'),
    completedAt: text('completed_at'),
    sourceRunId: text('source_run_id'),
  },
  (t) => [index('tasks_due_idx').on(t.status, t.dueAt), index('tasks_claim_idx').on(t.claimId, t.status)],
);

export interface ReviewTouchesJson {
  money: boolean;
  liability: boolean;
  settlement: boolean;
  legal: boolean;
  newCommitment: boolean;
}

/** Append-only: every review pass of a draft (§C.5 step 5). */
export const reviews = sqliteTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    targetKind: text('target_kind').$type<ReviewTargetKind>().notNull(),
    targetId: text('target_id').notNull(),
    claimId: text('claim_id'),
    loop: integer('loop').notNull(),
    rules: text('rules', { mode: 'json' }).$type<unknown>().notNull(),
    facts: text('facts', { mode: 'json' }).$type<unknown>().notNull(),
    critic: text('critic', { mode: 'json' }).$type<unknown>(),
    verdict: text('verdict').$type<'pass' | 'repair' | 'escalate'>().notNull(),
    touches: text('touches', { mode: 'json' }).$type<ReviewTouchesJson>().notNull(),
    runId: text('run_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('reviews_target_idx').on(t.targetKind, t.targetId, t.createdAt)],
);

export interface NotificationDelivery {
  channel: string;
  at: string;
  ok: boolean;
  error?: string;
}

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    needsYouId: text('needs_you_id'),
    level: text('level').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    link: text('link'),
    channels: text('channels', { mode: 'json' }).$type<string[]>().notNull(),
    deliveries: text('deliveries', { mode: 'json' }).$type<NotificationDelivery[]>().notNull().default([]),
    createdAt: text('created_at').notNull(),
    readAt: text('read_at'),
  },
  (t) => [index('notifications_created_idx').on(t.createdAt)],
);

export const dailyLogs = sqliteTable('daily_logs', {
  day: text('day').primaryKey(),
  compiledAt: text('compiled_at').notNull(),
  log: text('log', { mode: 'json' }).$type<unknown>().notNull(),
  emailedAt: text('emailed_at'),
});

// --- 0009 mail ---------------------------------------------------------------

export const mailAccounts = sqliteTable('mail_accounts', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  imapHost: text('imap_host').notNull(),
  imapPort: integer('imap_port').notNull(),
  imapTls: integer('imap_tls', { mode: 'boolean' }).notNull(),
  smtpHost: text('smtp_host').notNull(),
  smtpPort: integer('smtp_port').notNull(),
  smtpSecurity: text('smtp_security').$type<'tls' | 'starttls'>().notNull(),
  username: text('username').notNull(),
  /** Name of the DPAPI secret holding the password — never the password. */
  secretRef: text('secret_ref').notNull(),
  fromName: text('from_name').notNull().default('Claims Team, Courtesy Cars Group UK Ltd'),
  fromAddress: text('from_address').notNull(),
  signatureText: text('signature_text'),
  signatureHtml: text('signature_html'),
  processedFolder: text('processed_folder').notNull().default('ClaimDesk-Processed'),
  quarantineFolder: text('quarantine_folder').notNull().default('ClaimDesk-Quarantine'),
  moveAfterIngest: integer('move_after_ingest', { mode: 'boolean' }).notNull().default(true),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const mailFolderState = sqliteTable(
  'mail_folder_state',
  {
    accountId: text('account_id').notNull(),
    folder: text('folder').notNull(),
    uidvalidity: integer('uidvalidity'),
    lastUid: integer('last_uid').notNull().default(0),
    highestModseq: text('highest_modseq'),
    lastSyncAt: text('last_sync_at'),
    lastError: text('last_error'),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.folder] })],
);

export type MailMessageStatus = 'new' | 'matched' | 'needs_match' | 'unmatched' | 'quarantined' | 'processed' | 'ignored';

export const mailMessages = sqliteTable(
  'mail_messages',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    folder: text('folder'),
    uid: integer('uid'),
    uidvalidity: integer('uidvalidity'),
    messageId: text('message_id'),
    messageIdNorm: text('message_id_norm'),
    inReplyTo: text('in_reply_to'),
    referencesJson: text('references_json', { mode: 'json' }).$type<string[]>(),
    threadKey: text('thread_key').notNull(),
    direction: text('direction').$type<'in' | 'out'>().notNull(),
    fromAddr: text('from_addr'),
    fromName: text('from_name'),
    replyTo: text('reply_to'),
    toJson: text('to_json', { mode: 'json' }).$type<string[]>().notNull(),
    ccJson: text('cc_json', { mode: 'json' }).$type<string[]>().notNull(),
    subject: text('subject'),
    sentAt: text('sent_at'),
    receivedAt: text('received_at').notNull(),
    rawEvidenceId: text('raw_evidence_id').notNull(),
    rawSha256: text('raw_sha256').notNull(),
    bodyText: text('body_text'),
    hasAttachments: integer('has_attachments', { mode: 'boolean' }).notNull().default(false),
    authJson: text('auth_json', { mode: 'json' }).$type<unknown>(),
    spoofSuspect: integer('spoof_suspect', { mode: 'boolean' }).notNull().default(false),
    status: text('status').$type<MailMessageStatus>().notNull(),
    claimId: text('claim_id'),
    source: text('source').$type<'imap' | 'file' | 'smtp'>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('mail_messages_raw_uq').on(t.accountId, t.rawSha256),
    index('mail_messages_claim_idx').on(t.claimId, t.receivedAt),
    index('mail_messages_thread_idx').on(t.threadKey),
    index('mail_messages_msgid_idx').on(t.messageIdNorm),
  ],
);

export const mailAttachments = sqliteTable(
  'mail_attachments',
  {
    id: text('id').primaryKey(),
    mailMessageId: text('mail_message_id').notNull(),
    evidenceId: text('evidence_id').notNull(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    contentId: text('content_id'),
    inline: integer('inline', { mode: 'boolean' }).notNull().default(false),
    intakeItemId: text('intake_item_id'),
  },
  (t) => [index('mail_attachments_message_idx').on(t.mailMessageId)],
);

/** Append-only. */
export const mailMatches = sqliteTable(
  'mail_matches',
  {
    id: text('id').primaryKey(),
    mailMessageId: text('mail_message_id').notNull(),
    claimId: text('claim_id'),
    score: integer('score').notNull(),
    signals: text('signals', { mode: 'json' }).$type<unknown>().notNull(),
    decidedBy: text('decided_by').$type<'auto' | 'agent' | 'owner'>().notNull(),
    decidedAt: text('decided_at').notNull(),
    supersededBy: text('superseded_by'),
  },
  (t) => [index('mail_matches_message_idx').on(t.mailMessageId, t.decidedAt)],
);

/** Append-only. */
export const mailClassifications = sqliteTable(
  'mail_classifications',
  {
    id: text('id').primaryKey(),
    mailMessageId: text('mail_message_id').notNull(),
    runId: text('run_id'),
    driver: text('driver'),
    model: text('model'),
    promptVersion: text('prompt_version'),
    intent: text('intent').notNull(),
    secondary: text('secondary', { mode: 'json' }).$type<string[]>().notNull(),
    confidence: real('confidence').notNull(),
    extracted: text('extracted', { mode: 'json' }).$type<unknown>().notNull(),
    summary: text('summary').notNull(),
    injection: text('injection', { mode: 'json' }).$type<unknown>().notNull(),
    deterministic: text('deterministic', { mode: 'json' }).$type<unknown>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('mail_classifications_message_idx').on(t.mailMessageId, t.createdAt)],
);

export type OutboxStatus = 'draft' | 'reviewing' | 'awaiting_approval' | 'held' | 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';

export const outbox = sqliteTable(
  'outbox',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id'),
    accountId: text('account_id').notNull(),
    kind: text('kind').notNull(),
    toJson: text('to_json', { mode: 'json' }).$type<string[]>().notNull(),
    ccJson: text('cc_json', { mode: 'json' }).$type<string[]>().notNull(),
    bccJson: text('bcc_json', { mode: 'json' }).$type<string[]>().notNull(),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    bodyHtml: text('body_html'),
    attachmentsJson: text('attachments_json', { mode: 'json' }).$type<unknown[]>().notNull(),
    inReplyTo: text('in_reply_to'),
    referencesJson: text('references_json', { mode: 'json' }).$type<string[]>(),
    threadKey: text('thread_key'),
    policy: text('policy', { mode: 'json' }).$type<unknown>(),
    reviewId: text('review_id'),
    confidence: real('confidence'),
    status: text('status').$type<OutboxStatus>().notNull(),
    holdUntil: text('hold_until'),
    approvedBy: text('approved_by'),
    approvedAt: text('approved_at'),
    smtpMessageId: text('smtp_message_id'),
    rawSentEvidenceId: text('raw_sent_evidence_id'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('outbox_status_idx').on(t.status, t.holdUntil), index('outbox_claim_idx').on(t.claimId, t.createdAt)],
);

/** Append-only. */
export const outboxEvents = sqliteTable(
  'outbox_events',
  {
    id: text('id').primaryKey(),
    outboxId: text('outbox_id').notNull(),
    fromStatus: text('from_status').$type<OutboxStatus>(),
    toStatus: text('to_status').$type<OutboxStatus>().notNull(),
    actor: text('actor').notNull(),
    reason: text('reason'),
    at: text('at').notNull(),
  },
  (t) => [index('outbox_events_outbox_idx').on(t.outboxId, t.at)],
);

// --- 0010 intake -------------------------------------------------------------

export type IntakeItemStatus = 'queued' | 'normalising' | 'extracting' | 'proposed' | 'applied' | 'needs_you' | 'failed' | 'quota_wait' | 'skipped';

export const intakeItems = sqliteTable(
  'intake_items',
  {
    id: text('id').primaryKey(),
    source: text('source').$type<'upload' | 'email' | 'folder' | 'capture'>().notNull(),
    evidenceId: text('evidence_id').notNull(),
    parentItemId: text('parent_item_id'),
    claimId: text('claim_id'),
    status: text('status').$type<IntakeItemStatus>().notNull(),
    sniffedType: text('sniffed_type'),
    docType: text('doc_type'),
    docTypeConfidence: real('doc_type_confidence'),
    pages: integer('pages'),
    textSha256: text('text_sha256'),
    normalised: text('normalised', { mode: 'json' }).$type<unknown>(),
    error: text('error'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('intake_items_claim_idx').on(t.claimId, t.createdAt), index('intake_items_status_idx').on(t.status, t.createdAt)],
);

/** Append-only. */
export const intakeExtractions = sqliteTable(
  'intake_extractions',
  {
    id: text('id').primaryKey(),
    intakeItemId: text('intake_item_id').notNull(),
    runId: text('run_id'),
    schemaId: text('schema_id').notNull(),
    fields: text('fields', { mode: 'json' }).$type<unknown>().notNull(),
    summary: text('summary'),
    warnings: text('warnings', { mode: 'json' }).$type<string[]>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('intake_extractions_item_idx').on(t.intakeItemId, t.createdAt)],
);

export const claimUpdateProposals = sqliteTable(
  'claim_update_proposals',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    intakeItemId: text('intake_item_id'),
    target: text('target').notNull(),
    currentValue: text('current_value'),
    proposedValue: text('proposed_value').notNull(),
    confidence: real('confidence').notNull(),
    sensitive: integer('sensitive', { mode: 'boolean' }).notNull(),
    validator: text('validator', { mode: 'json' }).$type<unknown>(),
    source: text('source', { mode: 'json' }).$type<unknown>().notNull(),
    policyDecision: text('policy_decision').$type<'auto' | 'confirm' | 'never'>().notNull(),
    status: text('status').$type<'pending' | 'applied' | 'rejected' | 'superseded'>().notNull(),
    decidedBy: text('decided_by'),
    decidedAt: text('decided_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('proposals_claim_idx').on(t.claimId, t.status)],
);

// --- 0011 brain --------------------------------------------------------------

export const brainPacks = sqliteTable('brain_packs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').$type<BrainPackKind>().notNull(),
  activeVersion: text('active_version'),
  business: text('business', { mode: 'json' }).$type<string[]>().notNull(),
  precedence: integer('precedence').notNull(),
  useForCcguk: integer('use_for_ccguk', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const brainPackVersions = sqliteTable(
  'brain_pack_versions',
  {
    packId: text('pack_id').notNull(),
    version: text('version').notNull(),
    sha256: text('sha256').notNull(),
    source: text('source').notNull(),
    storagePath: text('storage_path').notNull(),
    manifest: text('manifest', { mode: 'json' }).$type<unknown>().notNull(),
    entries: integer('entries').notNull(),
    importedBy: text('imported_by').notNull(),
    importedAt: text('imported_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.packId, t.version] })],
);

/** Content table of the external-content FTS5 index `brain_fts` (sync triggers in 0011). */
export const brainEntries = sqliteTable(
  'brain_entries',
  {
    rowidKey: integer('rowid_key').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    packId: text('pack_id').notNull(),
    version: text('version').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    tags: text('tags').notNull(),
    business: text('business', { mode: 'json' }).$type<string[]>().notNull(),
    data: text('data', { mode: 'json' }).$type<unknown>().notNull(),
    verification: text('verification'),
  },
  (t) => [uniqueIndex('brain_entries_uq').on(t.packId, t.version, t.id)],
);

export const memoryItems = sqliteTable(
  'memory_items',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<MemoryKind>().notNull(),
    scope: text('scope').notNull(),
    text: text('text').notNull(),
    basis: text('basis', { mode: 'json' }).$type<Basis[]>().notNull(),
    data: text('data', { mode: 'json' }).$type<unknown>(),
    status: text('status').$type<MemoryStatus>().notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    decidedBy: text('decided_by'),
    decidedAt: text('decided_at'),
  },
  (t) => [index('memory_scope_idx').on(t.scope, t.status)],
);

export type AgentJobRow = typeof agentJobs.$inferSelect;
export type AgentJobInsert = typeof agentJobs.$inferInsert;
export type AgentJobAttemptRow = typeof agentJobAttempts.$inferSelect;
export type AgentJobAttemptInsert = typeof agentJobAttempts.$inferInsert;
export type AgentScheduleRow = typeof agentSchedules.$inferSelect;
export type AgentScheduleInsert = typeof agentSchedules.$inferInsert;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type AgentRunInsert = typeof agentRuns.$inferInsert;
export type AgentToolCallRow = typeof agentToolCalls.$inferSelect;
export type AgentToolCallInsert = typeof agentToolCalls.$inferInsert;
export type AiUsageStateRow = typeof aiUsageState.$inferSelect;
export type AiUsageStateInsert = typeof aiUsageState.$inferInsert;
export type AgentSettingsRow = typeof agentSettings.$inferSelect;
export type AgentSettingsInsert = typeof agentSettings.$inferInsert;
export type ClaimAgentStateRow = typeof claimAgentState.$inferSelect;
export type ClaimAgentStateInsert = typeof claimAgentState.$inferInsert;
export type NeedsYouRow = typeof needsYou.$inferSelect;
export type NeedsYouInsert = typeof needsYou.$inferInsert;
export type NeedsYouEventRow = typeof needsYouEvents.$inferSelect;
export type NeedsYouEventInsert = typeof needsYouEvents.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskInsert = typeof tasks.$inferInsert;
export type ReviewRow = typeof reviews.$inferSelect;
export type ReviewInsert = typeof reviews.$inferInsert;
export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationInsert = typeof notifications.$inferInsert;
export type DailyLogRow = typeof dailyLogs.$inferSelect;
export type DailyLogInsert = typeof dailyLogs.$inferInsert;
export type MailAccountRow = typeof mailAccounts.$inferSelect;
export type MailAccountInsert = typeof mailAccounts.$inferInsert;
export type MailFolderStateRow = typeof mailFolderState.$inferSelect;
export type MailFolderStateInsert = typeof mailFolderState.$inferInsert;
export type MailMessageRow = typeof mailMessages.$inferSelect;
export type MailMessageInsert = typeof mailMessages.$inferInsert;
export type MailAttachmentRow = typeof mailAttachments.$inferSelect;
export type MailAttachmentInsert = typeof mailAttachments.$inferInsert;
export type MailMatchRow = typeof mailMatches.$inferSelect;
export type MailMatchInsert = typeof mailMatches.$inferInsert;
export type MailClassificationRow = typeof mailClassifications.$inferSelect;
export type MailClassificationInsert = typeof mailClassifications.$inferInsert;
export type OutboxRow = typeof outbox.$inferSelect;
export type OutboxInsert = typeof outbox.$inferInsert;
export type OutboxEventRow = typeof outboxEvents.$inferSelect;
export type OutboxEventInsert = typeof outboxEvents.$inferInsert;
export type IntakeItemRow = typeof intakeItems.$inferSelect;
export type IntakeItemInsert = typeof intakeItems.$inferInsert;
export type IntakeExtractionRow = typeof intakeExtractions.$inferSelect;
export type IntakeExtractionInsert = typeof intakeExtractions.$inferInsert;
export type ClaimUpdateProposalRow = typeof claimUpdateProposals.$inferSelect;
export type ClaimUpdateProposalInsert = typeof claimUpdateProposals.$inferInsert;
export type BrainPackRow = typeof brainPacks.$inferSelect;
export type BrainPackInsert = typeof brainPacks.$inferInsert;
export type BrainPackVersionRow = typeof brainPackVersions.$inferSelect;
export type BrainPackVersionInsert = typeof brainPackVersions.$inferInsert;
export type BrainEntryRow = typeof brainEntries.$inferSelect;
export type BrainEntryInsert = typeof brainEntries.$inferInsert;
export type MemoryItemRow = typeof memoryItems.$inferSelect;
export type MemoryItemInsert = typeof memoryItems.$inferInsert;
