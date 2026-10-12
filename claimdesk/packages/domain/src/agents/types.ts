/**
 * ClaimDesk Supreme — shared agent vocabulary (docs/SUPREME-DESIGN.md §B.3, §B.4, §C.1–C.4, §C.7, §F.5, §G.2–G.4).
 * Pure types and constants only: every slice (gateway, runtime, mail, intake, casework) and the web app read these.
 * Keep them exactly as the design specifies — wave 2 codes against them.
 */
import type { RecipientRole } from '../consistency/checks.js';
import type { ISODateTime } from '../types.js';

export type { RecipientRole };

// ---------------------------------------------------------------------------
// Agents, job types, lanes (§C.1, §C.2, §C.3)
// ---------------------------------------------------------------------------

/** `autopilot` (SUPREME-AUTOPILOT §0.6) is the deterministic Autopilot principal: it never runs a model. */
export type AgentName = 'intake' | 'mail' | 'case_manager' | 'drafter' | 'reviewer' | 'researcher' | 'supervisor' | 'engineer' | 'calls' | 'critic' | 'judge' | 'autopilot';

export const AGENT_NAMES: readonly AgentName[] = ['intake', 'mail', 'case_manager', 'drafter', 'reviewer', 'researcher', 'supervisor', 'engineer', 'calls', 'critic', 'judge', 'autopilot'];

/** Phase 1 job types (§C.2). Phase 2/3 types are added by their foundation slices. */
export const JOB_TYPES = [
  'mail.sync',
  'mail.ingest',
  'mail.ingest_file',
  'mail.triage',
  'mail.reply',
  'outbox.after_review',
  'outbox.release',
  'document.after_review',
  'intake.process',
  'intake.extract',
  'intake.apply',
  'case.review',
  'offer.analyse',
  'draft.compose',
  'review.check',
  'research.ask',
  'case.sweep',
  'task.due',
  'notify.dispatch',
  'dailylog.compile',
  'clocks.refresh',
  'watch.poll',
  'index.fts',
  'brain.import',
  'retention.cleanup',
  // Autopilot (docs/SUPREME-AUTOPILOT.md §H.1)
  'autopilot.tick',
  'autopilot.sweep',
  'autopilot.judge',
  'hire_offer.parse_reply',
  'pack.prepare',
  'booking.expire_holds',
  'fleet.status_sync',
  'fleet.compliance_watch',
  'clash.check',
  'clash.sweep',
  'signing.chase',
  'signing.match_return',
  'movement.remind',
  // Knowledge Builder (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.1)
  'knowledge.observe',
  'knowledge.consolidate',
  'knowledge.learn_stats',
  'knowledge.curate',
  'knowledge.gap_scan',
  'knowledge.research',
  'knowledge.research_web',
  'knowledge.fetch',
  'knowledge.watch',
  'knowledge.publish',
  'knowledge.replay',
  'knowledge.replay_drafts',
  'knowledge.drift',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** The Autopilot job types (§H.1), each handled by its owning ap-* slice. */
export const AUTOPILOT_JOB_TYPES: readonly JobType[] = [
  'autopilot.tick',
  'autopilot.sweep',
  'autopilot.judge',
  'hire_offer.parse_reply',
  'pack.prepare',
  'booking.expire_holds',
  'fleet.status_sync',
  'fleet.compliance_watch',
  'clash.check',
  'clash.sweep',
  'signing.chase',
  'signing.match_return',
  'movement.remind',
];

/** The Knowledge Builder job types (KB §10.1), each handled by its owning knowledge-* slice. */
export const KNOWLEDGE_JOB_TYPES: readonly JobType[] = [
  'knowledge.observe',
  'knowledge.consolidate',
  'knowledge.learn_stats',
  'knowledge.curate',
  'knowledge.gap_scan',
  'knowledge.research',
  'knowledge.research_web',
  'knowledge.fetch',
  'knowledge.watch',
  'knowledge.publish',
  'knowledge.replay',
  'knowledge.replay_drafts',
  'knowledge.drift',
];

export const isJobType = (v: unknown): v is JobType => typeof v === 'string' && (JOB_TYPES as readonly string[]).includes(v);

export type Lane = 'ai' | 'io' | 'cpu';
export const LANES: readonly Lane[] = ['ai', 'io', 'cpu'];

export type JobStatus = 'queued' | 'leased' | 'waiting_usage' | 'waiting_user' | 'succeeded' | 'failed' | 'cancelled' | 'dead';
export const JOB_STATUSES: readonly JobStatus[] = ['queued', 'leased', 'waiting_usage', 'waiting_user', 'succeeded', 'failed', 'cancelled', 'dead'];

/** §C.2 table: lane, AI use, claim mutation and default priority per job type (handlers repeat these; tests compare). */
export interface JobTypeInfo {
  lane: Lane;
  usesAi: boolean | 'optional' | 'tier_c';
  mutatesClaim: boolean;
  defaultPriority: number;
  agent: AgentName | 'system';
}

export const JOB_TYPE_INFO: Readonly<Record<JobType, JobTypeInfo>> = {
  'mail.sync': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 2, agent: 'mail' },
  'mail.ingest': { lane: 'io', usesAi: false, mutatesClaim: true, defaultPriority: 2, agent: 'mail' },
  'mail.ingest_file': { lane: 'io', usesAi: false, mutatesClaim: true, defaultPriority: 3, agent: 'mail' },
  'mail.triage': { lane: 'ai', usesAi: true, mutatesClaim: true, defaultPriority: 1, agent: 'mail' },
  'mail.reply': { lane: 'ai', usesAi: true, mutatesClaim: true, defaultPriority: 2, agent: 'mail' },
  'outbox.after_review': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 1, agent: 'mail' },
  'outbox.release': { lane: 'io', usesAi: false, mutatesClaim: true, defaultPriority: 0, agent: 'mail' },
  'document.after_review': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 1, agent: 'reviewer' },
  'intake.process': { lane: 'cpu', usesAi: false, mutatesClaim: false, defaultPriority: 3, agent: 'intake' },
  'intake.extract': { lane: 'ai', usesAi: true, mutatesClaim: false, defaultPriority: 3, agent: 'intake' },
  'intake.apply': { lane: 'io', usesAi: false, mutatesClaim: true, defaultPriority: 3, agent: 'intake' },
  'case.review': { lane: 'ai', usesAi: true, mutatesClaim: true, defaultPriority: 1, agent: 'case_manager' },
  'offer.analyse': { lane: 'ai', usesAi: true, mutatesClaim: false, defaultPriority: 0, agent: 'case_manager' },
  'draft.compose': { lane: 'ai', usesAi: true, mutatesClaim: true, defaultPriority: 2, agent: 'drafter' },
  'review.check': { lane: 'ai', usesAi: 'tier_c', mutatesClaim: false, defaultPriority: 1, agent: 'reviewer' },
  'research.ask': { lane: 'ai', usesAi: true, mutatesClaim: true, defaultPriority: 4, agent: 'researcher' },
  'case.sweep': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 5, agent: 'case_manager' },
  'task.due': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 3, agent: 'case_manager' },
  'notify.dispatch': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 1, agent: 'supervisor' },
  'dailylog.compile': { lane: 'io', usesAi: 'optional', mutatesClaim: false, defaultPriority: 5, agent: 'supervisor' },
  'clocks.refresh': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 6, agent: 'supervisor' },
  'watch.poll': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 6, agent: 'supervisor' },
  'index.fts': { lane: 'cpu', usesAi: false, mutatesClaim: false, defaultPriority: 7, agent: 'researcher' },
  'brain.import': { lane: 'cpu', usesAi: false, mutatesClaim: false, defaultPriority: 4, agent: 'researcher' },
  'retention.cleanup': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 8, agent: 'supervisor' },
  // Autopilot (§H.1 of docs/SUPREME-AUTOPILOT.md)
  'autopilot.tick': { lane: 'io', usesAi: false, mutatesClaim: true, defaultPriority: 2, agent: 'autopilot' },
  'autopilot.sweep': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 4, agent: 'autopilot' },
  'autopilot.judge': { lane: 'ai', usesAi: true, mutatesClaim: false, defaultPriority: 2, agent: 'case_manager' },
  'hire_offer.parse_reply': { lane: 'ai', usesAi: true, mutatesClaim: false, defaultPriority: 1, agent: 'mail' },
  'pack.prepare': { lane: 'cpu', usesAi: false, mutatesClaim: true, defaultPriority: 3, agent: 'autopilot' },
  'booking.expire_holds': { lane: 'io', usesAi: false, mutatesClaim: true, defaultPriority: 1, agent: 'autopilot' },
  'fleet.status_sync': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 5, agent: 'autopilot' },
  'fleet.compliance_watch': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 5, agent: 'autopilot' },
  'clash.check': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 2, agent: 'autopilot' },
  'clash.sweep': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 6, agent: 'autopilot' },
  'signing.chase': { lane: 'io', usesAi: false, mutatesClaim: true, defaultPriority: 4, agent: 'autopilot' },
  'signing.match_return': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 3, agent: 'autopilot' },
  'movement.remind': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 4, agent: 'autopilot' },
  // Knowledge Builder (KB §10.1): no knowledge job mutates a claim, so none takes the per-claim lock
  'knowledge.observe': { lane: 'cpu', usesAi: false, mutatesClaim: false, defaultPriority: 6, agent: 'supervisor' },
  'knowledge.consolidate': { lane: 'cpu', usesAi: false, mutatesClaim: false, defaultPriority: 6, agent: 'supervisor' },
  'knowledge.learn_stats': { lane: 'cpu', usesAi: false, mutatesClaim: false, defaultPriority: 7, agent: 'supervisor' },
  'knowledge.curate': { lane: 'ai', usesAi: true, mutatesClaim: false, defaultPriority: 7, agent: 'researcher' },
  'knowledge.gap_scan': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 6, agent: 'supervisor' },
  'knowledge.research': { lane: 'ai', usesAi: true, mutatesClaim: false, defaultPriority: 6, agent: 'researcher' },
  'knowledge.research_web': { lane: 'ai', usesAi: true, mutatesClaim: false, defaultPriority: 7, agent: 'researcher' },
  'knowledge.fetch': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 6, agent: 'supervisor' },
  'knowledge.watch': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 7, agent: 'supervisor' },
  'knowledge.publish': { lane: 'cpu', usesAi: false, mutatesClaim: false, defaultPriority: 5, agent: 'supervisor' },
  'knowledge.replay': { lane: 'cpu', usesAi: false, mutatesClaim: false, defaultPriority: 6, agent: 'supervisor' },
  'knowledge.replay_drafts': { lane: 'ai', usesAi: true, mutatesClaim: false, defaultPriority: 8, agent: 'drafter' },
  'knowledge.drift': { lane: 'io', usesAi: false, mutatesClaim: false, defaultPriority: 7, agent: 'supervisor' },
};

// ---------------------------------------------------------------------------
// Tools (§B.3, §B.4)
// ---------------------------------------------------------------------------

export type ActionClass = 'read' | 'draft' | 'internal' | 'external_send' | 'money' | 'settlement' | 'legal' | 'destructive';
export const ACTION_CLASSES: readonly ActionClass[] = ['read', 'draft', 'internal', 'external_send', 'money', 'settlement', 'legal', 'destructive'];

/** Phase 1 tool catalogue (§B.4). `ToolName` stays open so later slices can add tools without editing this file. */
export const PHASE1_TOOL_NAMES = [
  'claim_brief', 'claims_search', 'claim_get', 'claim_next_actions', 'claim_clocks', 'claim_gates', 'claim_acceptance', 'events_list', 'ledger_get',
  'offers_list', 'hire_get', 'storage_get', 'recovery_get', 'hire_pricing_guide', 'party_get', 'party_search', 'vehicle_get', 'vehicle_on_file',
  'evidence_list', 'evidence_read', 'documents_list', 'document_get', 'templates_list', 'docx_template_values', 'kb_search', 'kb_entry', 'kb_advise',
  'directory_search', 'directory_get', 'total_loss_assess', 'quantum_settlement', 'mail_thread_get', 'brain_search', 'memory_recall',
  'document_draft', 'docx_document_draft', 'email_draft', 'needs_you_create', 'task_schedule', 'memory_note',
  'event_append', 'claim_field_propose', 'evidence_attach', 'mail_link_claim', 'offer_record', 'directory_report_failed', 'directory_used_ok',
  'send_request', 'vehicle_lookup',
  'payment_received_propose', 'ledger_propose', 'offer_recommend', 'legal_escalate',
] as const;
export type Phase1ToolName = (typeof PHASE1_TOOL_NAMES)[number];
export type ToolName = Phase1ToolName | (string & {});

/** Autopilot tools (docs/SUPREME-AUTOPILOT.md §H.2), registered by their owning ap-* slices. */
export const AUTOPILOT_TOOL_NAMES = [
  'autopilot_plan', 'fleet_search', 'fleet_unit_get', 'fleet_calendar', 'bookings_list', 'clash_check', 'eligibility_get', 'hire_offers_list', 'signatures_list',
  'eligibility_assess', 'booking_hold', 'booking_release', 'booking_confirm', 'booking_update_period', 'movement_schedule', 'readiness_task_create',
  'hire_offer_prepare', 'hire_acceptance_record', 'claim_status_set', 'pack_prepare',
] as const;
export type AutopilotToolName = (typeof AUTOPILOT_TOOL_NAMES)[number];

/**
 * The deterministic `autopilot` principal's tool subset (§H.2): every Autopilot tool plus these existing ones. It never
 * runs a model; code builds every input (`actAsAutopilot`, apps/api/src/autopilot/act.ts).
 */
export const AUTOPILOT_PRINCIPAL_TOOLS: readonly ToolName[] = [
  ...AUTOPILOT_TOOL_NAMES,
  'email_draft', 'document_draft', 'docx_document_draft', 'event_append', 'send_request', 'ledger_propose', 'payment_received_propose', 'task_schedule',
  'needs_you_create', 'legal_escalate', 'vehicle_lookup', 'claim_brief', 'claim_get',
];

// ---------------------------------------------------------------------------
// Email (§F.5, §D.2)
// ---------------------------------------------------------------------------

export type EmailKind =
  | 'ack'
  | 'info_provided'
  | 'doc_request_fulfil'
  | 'doc_request'
  | 'chaser'
  | 'handling_ref_request'
  | 'ncaf_cover'
  | 'cctv_request'
  | 'client_update'
  | 'supplier_instruction'
  | 'reply_general'
  | 'offer_response'
  | 'complaint'
  | 'legal'
  // Autopilot (SUPREME-AUTOPILOT §0.6)
  | 'hire_offer'
  | 'booking_update'
  | 'signature_request'
  | 'insurer_notice';
export const EMAIL_KINDS: readonly EmailKind[] = [
  'ack', 'info_provided', 'doc_request_fulfil', 'doc_request', 'chaser', 'handling_ref_request', 'ncaf_cover', 'cctv_request', 'client_update', 'supplier_instruction', 'reply_general', 'offer_response', 'complaint', 'legal',
  'hire_offer', 'booking_update', 'signature_request', 'insurer_notice',
];

export type MailIntent =
  | 'offer_settlement'
  | 'offer_pav'
  | 'part36_offer'
  | 'interim_payment'
  | 'liability_admitted'
  | 'liability_denied'
  | 'liability_split'
  | 'request_documents'
  | 'request_information'
  | 'payment_remittance'
  | 'reduction_or_part_payment'
  | 'engineer_report'
  | 'inspection_arrangement'
  | 'repair_authority'
  | 'bodyshop_update'
  | 'chaser'
  | 'acknowledgement'
  | 'complaint'
  | 'final_response'
  | 'fraud_allegation'
  | 'solicitor_letter'
  | 'letter_before_claim'
  | 'court_document'
  | 'intervention_offer'
  | 'dsar_response'
  | 'client_message'
  | 'auto_reply'
  | 'bounce'
  | 'spam_phishing'
  | 'other';
export const MAIL_INTENTS: readonly MailIntent[] = [
  'offer_settlement', 'offer_pav', 'part36_offer', 'interim_payment', 'liability_admitted', 'liability_denied', 'liability_split', 'request_documents',
  'request_information', 'payment_remittance', 'reduction_or_part_payment', 'engineer_report', 'inspection_arrangement', 'repair_authority', 'bodyshop_update',
  'chaser', 'acknowledgement', 'complaint', 'final_response', 'fraud_allegation', 'solicitor_letter', 'letter_before_claim', 'court_document',
  'intervention_offer', 'dsar_response', 'client_message', 'auto_reply', 'bounce', 'spam_phishing', 'other',
];

// ---------------------------------------------------------------------------
// Needs-you, basis, recommendation (§C.7)
// ---------------------------------------------------------------------------

export type NeedsYouKind =
  | 'approve_send'
  | 'approve_document'
  | 'missing_info'
  | 'confirm_fields'
  | 'offer_decision'
  | 'money'
  | 'legal_review'
  | 'which_claim'
  | 'new_claim'
  | 'override_needed'
  | 'question'
  | 'spoof_warning'
  | 'ai_paused'
  | 'setup'
  | 'failure'
  // Autopilot (SUPREME-AUTOPILOT §0.6, §H.3)
  | 'choose_car'
  | 'approve_pack'
  | 'confirm_signed'
  | 'clash_review'
  | 'eligibility_review'
  | 'autopilot_step'
  // Knowledge Builder (KB §9.3)
  | 'knowledge_review';
export const NEEDS_YOU_KINDS: readonly NeedsYouKind[] = [
  'approve_send', 'approve_document', 'missing_info', 'confirm_fields', 'offer_decision', 'money', 'legal_review', 'which_claim', 'new_claim', 'override_needed', 'question', 'spoof_warning', 'ai_paused', 'setup', 'failure',
  'choose_car', 'approve_pack', 'confirm_signed', 'clash_review', 'eligibility_review', 'autopilot_step',
  'knowledge_review',
];
/** The Autopilot Needs-you kinds (§H.3), each resolved by its owning ap-* slice. */
export const AUTOPILOT_NEEDS_YOU_KINDS: readonly NeedsYouKind[] = ['choose_car', 'approve_pack', 'confirm_signed', 'clash_review', 'eligibility_review', 'autopilot_step'];

export type NeedsYouPriority = 'urgent' | 'high' | 'normal' | 'low';
export const NEEDS_YOU_PRIORITIES: readonly NeedsYouPriority[] = ['urgent', 'high', 'normal', 'low'];
export type NeedsYouStatus = 'open' | 'snoozed' | 'resolved' | 'expired' | 'superseded';

/** `knowledge` (KB §3.5): a learned item (`ki:<id>`) the result relied on. */
export type BasisKind = 'fact' | 'kb' | 'pack' | 'rule' | 'event' | 'evidence' | 'memory' | 'message' | 'knowledge';
export const BASIS_KINDS: readonly BasisKind[] = ['fact', 'kb', 'pack', 'rule', 'event', 'evidence', 'memory', 'message', 'knowledge'];
export interface Basis {
  kind: BasisKind;
  id: string;
  label: string | null;
}

export interface Recommendation {
  action: string;
  why: string;
  confidence: number;
  basis: Basis[];
  dissent?: string;
}

export interface NeedsYouOption {
  id: string;
  label: string;
  tone: 'primary' | 'danger' | 'neutral';
  requiresEdit?: boolean;
  requiresReason?: boolean;
}

/** A prepared draft a Needs-you item or handoff points at (§B.4 `needs_you_create`, `legal_escalate`). */
export interface DraftRef {
  kind: 'outbox' | 'document' | 'docx' | 'proposal' | 'task' | 'memory';
  id: string;
}

// ---------------------------------------------------------------------------
// Hand-offs (§C.4) and tasks
// ---------------------------------------------------------------------------

export type Handoff =
  | { to: 'mail_reply'; messageId: string; plan: string; keyPoints: string[] }
  | {
      to: 'drafter';
      templateId: string | null;
      emailKind: EmailKind | null;
      purpose: string;
      recipientPartyId: string | null;
      replyToMessageId: string | null;
      actionCode: string | null;
      dueAt: string | null;
    }
  | { to: 'researcher'; question: string }
  | { to: 'offer_analyst'; offerId: string };

/** Loop guard (§C.4): follow-ups deeper than this stop with Needs-you `failure`. */
export const MAX_HANDOFF_DEPTH = 6;
/** Max repair loops per draft (§C.4). */
export const MAX_REPAIR_LOOPS = 2;
/** Default per-claim AI budget, runs per day (§C.4; owner-triggered runs exempt). */
export const DEFAULT_CLAIM_RUNS_PER_DAY = 8;
/** Action code a case review may use for something outside the playbook — always asks (§C.4). */
export const CUSTOM_ACTION_CODE = 'CUSTOM';

export type TaskKind = 'follow_up' | 'chaser' | 'deadline' | 'review' | 'call' | 'payment_check' | 'document' | 'other';
export const TASK_KINDS: readonly TaskKind[] = ['follow_up', 'chaser', 'deadline', 'review', 'call', 'payment_check', 'document', 'other'];
export type TaskStatus = 'open' | 'done' | 'cancelled';

// ---------------------------------------------------------------------------
// Intake (§G.2, §G.4)
// ---------------------------------------------------------------------------

export type DocType =
  | 'v5c'
  | 'driving_licence'
  | 'insurance_certificate'
  | 'police_report'
  | 'fnol_form'
  | 'insurer_letter'
  | 'engineer_report'
  | 'bodyshop_estimate'
  | 'audatex_estimate'
  | 'invoice'
  | 'damage_photo'
  | 'vehicle_photo_other'
  | 'signed_ccguk_form'
  | 'bank_statement'
  | 'payslip'
  | 'mot_certificate'
  | 'correspondence'
  | 'other';
export const DOC_TYPES: readonly DocType[] = [
  'v5c', 'driving_licence', 'insurance_certificate', 'police_report', 'fnol_form', 'insurer_letter', 'engineer_report', 'bodyshop_estimate', 'audatex_estimate',
  'invoice', 'damage_photo', 'vehicle_photo_other', 'signed_ccguk_form', 'bank_statement', 'payslip', 'mot_certificate', 'correspondence', 'other',
];

export type FieldRole = 'client' | 'third_party' | 'claimant' | 'driver';
export const FIELD_ROLES: readonly FieldRole[] = ['client', 'third_party', 'claimant', 'driver'];
export type ClaimFieldTarget = 'claim.accident.occurredAt' | 'claim.accident.location' | 'claim.atFaultInsurerRef' | 'claim.thirdPartyPolicyNumber';
export type VehicleField = 'vin' | 'registration' | 'make' | 'model' | 'firstRegistered' | 'colour';
export type PartyField = 'name' | 'address' | 'phone' | 'email' | 'dateOfBirth' | 'drivingLicenceNumber';
export const VEHICLE_FIELDS: readonly VehicleField[] = ['vin', 'registration', 'make', 'model', 'firstRegistered', 'colour'];
export const PARTY_FIELDS: readonly PartyField[] = ['name', 'address', 'phone', 'email', 'dateOfBirth', 'drivingLicenceNumber'];

/** Closed set of fields intake may propose (§G.4); `intake/targets.ts` maps each to its route and sensitivity. */
export type FieldTarget = ClaimFieldTarget | `vehicle:${FieldRole}.${VehicleField}` | `party:${FieldRole}.${PartyField}`;

export const FIELD_TARGETS: readonly FieldTarget[] = [
  'claim.accident.occurredAt',
  'claim.accident.location',
  'claim.atFaultInsurerRef',
  'claim.thirdPartyPolicyNumber',
  ...FIELD_ROLES.flatMap((r) => VEHICLE_FIELDS.map((f) => `vehicle:${r}.${f}` as FieldTarget)),
  ...FIELD_ROLES.flatMap((r) => PARTY_FIELDS.map((f) => `party:${r}.${f}` as FieldTarget)),
];
export const isFieldTarget = (v: unknown): v is FieldTarget => typeof v === 'string' && (FIELD_TARGETS as readonly string[]).includes(v);

/** Fields that always need the owner's confirmation (§G.2 step 5): DOB, licence number, policy number. */
export const SENSITIVE_FIELD_TARGETS: ReadonlySet<FieldTarget> = new Set<FieldTarget>([
  'claim.thirdPartyPolicyNumber',
  ...FIELD_ROLES.flatMap((r) => [`party:${r}.dateOfBirth` as FieldTarget, `party:${r}.drivingLicenceNumber` as FieldTarget]),
]);

// ---------------------------------------------------------------------------
// Brain (§E.5)
// ---------------------------------------------------------------------------

export type BrainPackKind = 'ccguk' | 'playbook' | 'learned' | 'other';
export type BrainEntryKind = 'knowledge' | 'strategy' | 'letterStyle' | 'redLine' | 'checklist' | 'snippet' | 'rule' | 'escalationLadder' | 'deadlineDef' | 'pricing' | 'decisionTable';
export const BRAIN_ENTRY_KINDS: readonly BrainEntryKind[] = ['knowledge', 'strategy', 'letterStyle', 'redLine', 'checklist', 'snippet', 'rule', 'escalationLadder', 'deadlineDef', 'pricing', 'decisionTable'];
export type MemoryKind = 'note' | 'correction' | 'outcome' | 'preference' | 'research';
export type MemoryStatus = 'proposed' | 'approved' | 'retired';

/** Review targets (§N.1 `reviews.target_kind`). */
export type ReviewTargetKind = 'outbox' | 'document' | 'docx';

