/**
 * @ccguk/db — Drizzle (sqlite-core) schema.
 *
 * One table per entity in `@ccguk/domain` types.ts plus a few persistence-only tables
 * (claim_sequences, clocks cache, settings, audit_log, labour_library, directory_overrides).
 *
 * Conventions:
 *  - text primary keys (crypto.randomUUID()), ISO text for dates, integer pence for money
 *  - nested structures are JSON text columns typed with `$type<>()` so `$inferSelect` matches the domain
 *  - append-only tables (ledger_entries, claim_events, evidence, audit_log) are additionally protected by
 *    BEFORE UPDATE / BEFORE DELETE triggers in migration 0001
 *  - the cross-file registration rule (same registration on two claims) is a FLAG raised by the domain,
 *    not a database constraint — deliberately no unique index on claims (clientVehicleId, occurredAt)
 */
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
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
  Verification,
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
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
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
  },
  (t) => [index('audit_log_entity_idx').on(t.entity, t.entityId), index('audit_log_at_idx').on(t.at), index('audit_log_user_idx').on(t.userId)],
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
