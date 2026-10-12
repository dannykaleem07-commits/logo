/**
 * Smart intake — case bundles (docs/SMART-INTAKE.md §4.1, §8.1). Contracts shared by the pure modules in this folder
 * and the API's bundle engine and view layer (apps/api/src/intake/bundles/**). Pure types and constants only.
 */
import type { DocType, FieldTarget } from '../../agents/types.js';

// ---------------------------------------------------------------------------
// Bundle field keys
// ---------------------------------------------------------------------------

export const BUNDLE_FIELD_KEYS = [
  'client.name', 'client.dateOfBirth', 'client.address', 'client.phone', 'client.email', 'client.drivingLicenceNumber',
  'driver.name', 'driver.dateOfBirth', 'driver.address', 'driver.phone', 'driver.drivingLicenceNumber',
  'vehicle.registration', 'vehicle.vin', 'vehicle.make', 'vehicle.model', 'vehicle.colour', 'vehicle.firstRegistered',
  'clientInsurer.name', 'clientInsurer.policyNumber',
  'tp.name', 'tp.phone', 'tp.address', 'tp.registration', 'tp.make', 'tp.model', 'tp.insurerName', 'tp.policyNumber', 'tp.insurerRef',
  'accident.occurredAt', 'accident.location', 'accident.postcode', 'accident.circumstances', 'accident.policeAttended',
  'accident.policeReference', 'accident.injuries', 'accident.driveable',
  'hire.needed', 'repairer.name', 'repairer.phone', 'engineer.name', 'engineer.reference',
] as const;
export type BundleFieldKey = (typeof BUNDLE_FIELD_KEYS)[number];

export const isBundleFieldKey = (v: unknown): v is BundleFieldKey => typeof v === 'string' && (BUNDLE_FIELD_KEYS as readonly string[]).includes(v);

/** BundleFieldKey ↔ FieldTarget (null = bundle-only key, used at register through CreateClaimBody / parties). */
export const BUNDLE_KEY_TARGET: Readonly<Record<BundleFieldKey, FieldTarget | null>> = {
  'client.name': 'party:client.name',
  'client.dateOfBirth': 'party:client.dateOfBirth',
  'client.address': 'party:client.address',
  'client.phone': 'party:client.phone',
  'client.email': 'party:client.email',
  'client.drivingLicenceNumber': 'party:client.drivingLicenceNumber',
  'driver.name': 'party:driver.name',
  'driver.dateOfBirth': 'party:driver.dateOfBirth',
  'driver.address': 'party:driver.address',
  'driver.phone': 'party:driver.phone',
  'driver.drivingLicenceNumber': 'party:driver.drivingLicenceNumber',
  'vehicle.registration': 'vehicle:client.registration',
  'vehicle.vin': 'vehicle:client.vin',
  'vehicle.make': 'vehicle:client.make',
  'vehicle.model': 'vehicle:client.model',
  'vehicle.colour': 'vehicle:client.colour',
  'vehicle.firstRegistered': 'vehicle:client.firstRegistered',
  'clientInsurer.name': 'claim.clientInsurerName',
  'clientInsurer.policyNumber': 'claim.clientPolicyNumber',
  'tp.name': 'party:third_party.name',
  'tp.phone': 'party:third_party.phone',
  'tp.address': 'party:third_party.address',
  'tp.registration': 'vehicle:third_party.registration',
  'tp.make': 'vehicle:third_party.make',
  'tp.model': 'vehicle:third_party.model',
  'tp.insurerName': 'claim.atFaultInsurerName',
  'tp.policyNumber': 'claim.thirdPartyPolicyNumber',
  'tp.insurerRef': 'claim.atFaultInsurerRef',
  'accident.occurredAt': 'claim.accident.occurredAt',
  'accident.location': 'claim.accident.location',
  'accident.postcode': 'claim.accident.postcode',
  'accident.circumstances': 'claim.accident.circumstances',
  'accident.policeAttended': null,
  'accident.policeReference': 'claim.accident.policeReference',
  'accident.injuries': 'claim.accident.injuries',
  'accident.driveable': null,
  'hire.needed': null,
  'repairer.name': null,
  'repairer.phone': null,
  'engineer.name': null,
  'engineer.reference': null,
};

const TARGET_KEY = new Map<string, BundleFieldKey>();
for (const [k, t] of Object.entries(BUNDLE_KEY_TARGET)) if (t) TARGET_KEY.set(t, k as BundleFieldKey);

/** Inverse for per-file extractions: FieldTarget → BundleFieldKey (claimant/client both → client.*; any role's vehicle but the TP's → vehicle.*). */
export function bundleKeyForTarget(t: FieldTarget | string): BundleFieldKey | null {
  const direct = TARGET_KEY.get(t);
  if (direct) return direct;
  let m = /^party:claimant\.(\w+)$/.exec(t);
  if (m) return TARGET_KEY.get(`party:client.${m[1]}`) ?? null;
  m = /^vehicle:(claimant|driver)\.(\w+)$/.exec(t);
  if (m) return TARGET_KEY.get(`vehicle:client.${m[2]}`) ?? null;
  return null;
}

/** Key details needed to register (plus one of client.phone / client.email). */
export const KEY_FIELDS: readonly BundleFieldKey[] = ['client.name', 'vehicle.registration', 'accident.occurredAt', 'accident.location', 'accident.circumstances', 'tp.registration'];

/** Personal or sensitive details: always shown masked in the daily log and never auto-applied on an existing claim. */
export const SENSITIVE_BUNDLE_KEYS: ReadonlySet<BundleFieldKey> = new Set<BundleFieldKey>([
  'client.dateOfBirth', 'driver.dateOfBirth', 'client.drivingLicenceNumber', 'driver.drivingLicenceNumber', 'clientInsurer.policyNumber', 'tp.policyNumber',
  'accident.injuries', 'accident.circumstances',
]);

export type DraftSection = 'client' | 'driver' | 'vehicle' | 'third_party' | 'accident' | 'insurers' | 'hire_repair';

export interface BundleFieldMeta {
  label: string;
  section: DraftSection;
  /** Needed by POST /claims (FNOL) to open the claim. */
  required: boolean;
  /** Value kind (validators and comparisons). */
  kind: 'name' | 'date' | 'datetime' | 'address' | 'phone' | 'email' | 'licence' | 'vrm' | 'vin' | 'text' | 'month' | 'postcode' | 'ref' | 'bool' | 'yes_no';
}

export const BUNDLE_FIELD_META: Readonly<Record<BundleFieldKey, BundleFieldMeta>> = {
  'client.name': { label: 'Client name', section: 'client', required: true, kind: 'name' },
  'client.dateOfBirth': { label: 'Client date of birth', section: 'client', required: false, kind: 'date' },
  'client.address': { label: 'Client address', section: 'client', required: false, kind: 'address' },
  'client.phone': { label: 'Client phone', section: 'client', required: false, kind: 'phone' },
  'client.email': { label: 'Client email', section: 'client', required: false, kind: 'email' },
  'client.drivingLicenceNumber': { label: 'Client driving licence number', section: 'client', required: false, kind: 'licence' },
  'driver.name': { label: 'Driver name', section: 'driver', required: false, kind: 'name' },
  'driver.dateOfBirth': { label: 'Driver date of birth', section: 'driver', required: false, kind: 'date' },
  'driver.address': { label: 'Driver address', section: 'driver', required: false, kind: 'address' },
  'driver.phone': { label: 'Driver phone', section: 'driver', required: false, kind: 'phone' },
  'driver.drivingLicenceNumber': { label: 'Driver driving licence number', section: 'driver', required: false, kind: 'licence' },
  'vehicle.registration': { label: 'Client car registration', section: 'vehicle', required: true, kind: 'vrm' },
  'vehicle.vin': { label: 'Client car VIN', section: 'vehicle', required: false, kind: 'vin' },
  'vehicle.make': { label: 'Client car make', section: 'vehicle', required: false, kind: 'text' },
  'vehicle.model': { label: 'Client car model', section: 'vehicle', required: false, kind: 'text' },
  'vehicle.colour': { label: 'Client car colour', section: 'vehicle', required: false, kind: 'text' },
  'vehicle.firstRegistered': { label: 'Client car first registered', section: 'vehicle', required: false, kind: 'month' },
  'clientInsurer.name': { label: 'Client’s insurer', section: 'insurers', required: false, kind: 'text' },
  'clientInsurer.policyNumber': { label: 'Client’s policy number', section: 'insurers', required: false, kind: 'ref' },
  'tp.name': { label: 'Other driver name', section: 'third_party', required: false, kind: 'name' },
  'tp.phone': { label: 'Other driver phone', section: 'third_party', required: false, kind: 'phone' },
  'tp.address': { label: 'Other driver address', section: 'third_party', required: false, kind: 'address' },
  'tp.registration': { label: 'Other vehicle registration', section: 'third_party', required: true, kind: 'vrm' },
  'tp.make': { label: 'Other vehicle make', section: 'third_party', required: false, kind: 'text' },
  'tp.model': { label: 'Other vehicle model', section: 'third_party', required: false, kind: 'text' },
  'tp.insurerName': { label: 'Other side’s insurer', section: 'insurers', required: false, kind: 'text' },
  'tp.policyNumber': { label: 'Other side’s policy number', section: 'insurers', required: false, kind: 'ref' },
  'tp.insurerRef': { label: 'Other side’s insurer reference', section: 'insurers', required: false, kind: 'ref' },
  'accident.occurredAt': { label: 'Accident date and time', section: 'accident', required: true, kind: 'datetime' },
  'accident.location': { label: 'Accident location', section: 'accident', required: true, kind: 'text' },
  'accident.postcode': { label: 'Accident postcode', section: 'accident', required: false, kind: 'postcode' },
  'accident.circumstances': { label: 'What happened (client’s account)', section: 'accident', required: true, kind: 'text' },
  'accident.policeAttended': { label: 'Police attended', section: 'accident', required: false, kind: 'bool' },
  'accident.policeReference': { label: 'Police reference', section: 'accident', required: false, kind: 'ref' },
  'accident.injuries': { label: 'Anyone injured', section: 'accident', required: false, kind: 'bool' },
  'accident.driveable': { label: 'Car driveable after the accident', section: 'accident', required: false, kind: 'bool' },
  'hire.needed': { label: 'Replacement car needed', section: 'hire_repair', required: false, kind: 'yes_no' },
  'repairer.name': { label: 'Repairer', section: 'hire_repair', required: false, kind: 'text' },
  'repairer.phone': { label: 'Repairer phone', section: 'hire_repair', required: false, kind: 'phone' },
  'engineer.name': { label: 'Engineer', section: 'hire_repair', required: false, kind: 'text' },
  'engineer.reference': { label: 'Engineer reference', section: 'hire_repair', required: false, kind: 'ref' },
};

// ---------------------------------------------------------------------------
// Readings (candidates) and provenance
// ---------------------------------------------------------------------------

export type CandidateEngine = 'ai' | 'rules' | 'exif' | 'plate' | 'owner' | 'name_hint' | 'ai_reasoning';
export const CANDIDATE_ENGINES: readonly CandidateEngine[] = ['ai', 'rules', 'exif', 'plate', 'owner', 'name_hint', 'ai_reasoning'];

export interface FieldSource {
  fileId: string;
  itemId: string;
  evidenceId: string;
  filename: string;
  docType: DocType | null;
  docTypeLabel: string | null;
  page: number | null;
  quote: string | null;
  confidence: number;
  engine: CandidateEngine;
  rank: number;
  /** "V5C, page 1" */
  label: string;
  /** The quote was found in the file's text (AI reasoning quotes are checked; others null). */
  quoteVerified: boolean | null;
}

export interface Candidate {
  key: BundleFieldKey;
  /** Normalised by the API (validators), so comparisons are on normalised values. */
  value: string;
  display: string;
  source: FieldSource;
  validatorOk: boolean;
  validatorMessage: string | null;
  /** The AI reasoning's explanation, shown next to a conflict's options (never decides one). */
  aiWhy?: string | null;
  /** Who wrote the source: a client-authored form, the police, an insurer … (accident.circumstances attribution). */
  authoredBy?: Attribution | null;
}

export type Attribution = 'client' | 'police' | 'insurer' | 'witness' | 'owner' | 'other';

/** A bundle file's role (an EML's attachments, a ZIP's entries and a pack's segments are children). */
export type BundleFileRole = 'document' | 'pack' | 'segment' | 'attachment' | 'archive' | 'email';

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export type GroupKind = 'main' | 'new_case' | 'existing_claim' | 'unsure' | 'excluded';
export type GroupReasonCode =
  | 'shared_ccg_ref' | 'shared_vin' | 'shared_vrm' | 'shared_insurer_ref' | 'shared_policy' | 'shared_licence'
  | 'shared_name_dob' | 'shared_phone' | 'shared_email' | 'shared_postcode' | 'shared_accident_date' | 'same_file_on_claim' | 'plate_in_photo'
  | 'photo_date_near_accident' | 'attachment_of' | 'segment_of' | 'only_case_in_upload' | 'name_hint' | 'moved_by_owner' | 'no_identifiers'
  | 'conflicting_identifiers' | 'matches_claim' | 'possible_claim_match' | 'duplicate_of' | 'ai_advice';
export interface GroupReason {
  code: GroupReasonCode;
  text: string;
  fileId?: string;
  key?: string;
}

export interface BundleGroup {
  /** 'main' | 'case:B' | 'claim:<claimId>' | 'unsure' | 'excluded' */
  key: string;
  kind: GroupKind;
  label: string;
  claim: { id: string; reference: string; clientName: string | null; status: string } | null;
  fileIds: string[];
  reasons: GroupReason[];
  confidence: number;
  suggestedName: string | null;
  warnings: string[];
  defaultAction: 'register' | 'attach' | 'split_off' | 'exclude' | 'decide';
}
/** The grouping step's output (same JSON as the view). */
export type BundleGroupComputed = BundleGroup;

// ---------------------------------------------------------------------------
// Draft, conflicts, witnesses
// ---------------------------------------------------------------------------

export type DraftFieldStatus = 'ok' | 'low_confidence' | 'conflict' | 'missing' | 'owner_set' | 'invalid';

export interface DraftField {
  key: BundleFieldKey;
  label: string;
  section: DraftSection;
  value: string | null;
  display: string | null;
  confidence: number;
  sensitive: boolean;
  required: boolean;
  keyField: boolean;
  status: DraftFieldStatus;
  validator: { ok: boolean; message: string | null };
  source: FieldSource | null;
  alternatives: Array<{ value: string; display: string; sources: FieldSource[] }>;
  conflictId: string | null;
  note: string | null;
}

export interface ConflictOption {
  value: string;
  display: string;
  sources: FieldSource[];
  rank: number;
  preselected: boolean;
  aiWhy: string | null;
}

export interface Conflict {
  id: string;
  key: BundleFieldKey;
  label: string;
  status: 'open' | 'resolved';
  options: ConflictOption[];
  why: string;
  chosenValue: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

export interface WitnessDraft {
  name: string;
  phone: string | null;
  relationship: string | null;
  source: FieldSource | null;
}

/** An owner (or agent) decision as the pure modules see it (append-only rows → this view). */
export interface DecisionView {
  id: string;
  kind: string;
  subject: string | null;
  before: unknown;
  after: unknown;
  note: string | null;
  actor: string;
  at: string;
}

// ---------------------------------------------------------------------------
// Checklist, timeline, signals, registrability
// ---------------------------------------------------------------------------

export type CaseKind = 'non_fault_credit_hire' | 'non_fault_repair_only' | 'total_loss' | 'untraced' | 'unknown';
export const CASE_KIND_LABELS: Readonly<Record<CaseKind, string>> = {
  non_fault_credit_hire: 'Non-fault claim with a replacement car (credit hire)',
  non_fault_repair_only: 'Non-fault claim, repair only',
  total_loss: 'Non-fault claim, car likely a write-off',
  untraced: 'Other driver not traced (MIB untraced route)',
  unknown: 'Not clear yet',
};

export interface ChecklistItem {
  id: string;
  label: string;
  status: 'have' | 'missing' | 'partial' | 'not_needed';
  why: string;
  fileIds: string[];
}

export type TimelineClass = 'record' | 'clock' | 'owner_only';
export interface TimelineProposal {
  id: string;
  at: string;
  precision: 'date' | 'datetime';
  eventType: string;
  eventLabel: string;
  class: TimelineClass;
  summary: string;
  attributableTo: string;
  sources: FieldSource[];
  confidence: number;
  ticked: boolean;
  tickedBy: 'default' | 'owner';
  note: string | null;
}

export type RiskSeverity = 'info' | 'warn';
export type RiskSignalCode =
  | 'PHOTO_BEFORE_ACCIDENT' | 'PHOTO_LONG_AFTER' | 'PHOTO_GPS_OUTLIER' | 'PHOTO_EDITED_SOFTWARE' | 'PHOTO_ON_OTHER_CLAIM'
  | 'PLATE_NOT_ON_CASE' | 'DOC_DATED_BEFORE_ACCIDENT' | 'KEEPER_AFTER_ACCIDENT' | 'INSURANCE_NOT_IN_FORCE' | 'LICENCE_EXPIRED'
  | 'MOT_EXPIRED' | 'ACCIDENT_IN_FUTURE' | 'VEHICLE_ON_OTHER_CLAIM' | 'FLEET_VEHICLE_AS_CLIENT' | 'CONTACT_ON_OTHER_CLAIM'
  | 'DUPLICATE_CLAIMANT' | 'PDF_EDITED_AFTER_CREATION' | 'PDF_EDITOR_PRODUCER' | 'PDF_INCREMENTAL_UPDATES' | 'FILE_TYPE_MISMATCH'
  | 'INSTRUCTIONS_IN_DOCUMENT';
export const RISK_SIGNAL_CODES: readonly RiskSignalCode[] = [
  'PHOTO_BEFORE_ACCIDENT', 'PHOTO_LONG_AFTER', 'PHOTO_GPS_OUTLIER', 'PHOTO_EDITED_SOFTWARE', 'PHOTO_ON_OTHER_CLAIM',
  'PLATE_NOT_ON_CASE', 'DOC_DATED_BEFORE_ACCIDENT', 'KEEPER_AFTER_ACCIDENT', 'INSURANCE_NOT_IN_FORCE', 'LICENCE_EXPIRED',
  'MOT_EXPIRED', 'ACCIDENT_IN_FUTURE', 'VEHICLE_ON_OTHER_CLAIM', 'FLEET_VEHICLE_AS_CLIENT', 'CONTACT_ON_OTHER_CLAIM',
  'DUPLICATE_CLAIMANT', 'PDF_EDITED_AFTER_CREATION', 'PDF_EDITOR_PRODUCER', 'PDF_INCREMENTAL_UPDATES', 'FILE_TYPE_MISMATCH',
  'INSTRUCTIONS_IN_DOCUMENT',
];

export interface RiskSignal {
  id: string;
  code: RiskSignalCode;
  severity: RiskSeverity;
  title: string;
  message: string;
  fileIds: string[];
  claims: Array<{ id: string; reference: string }>;
  basis: Array<{ fileId: string; page: number | null; quote: string | null }>;
  acknowledged: { by: string; at: string; note: string | null } | null;
}

/** Words never used in any intake signal, blocker, brief or log line (owner rule: signals only, never accusations). */
export const BANNED_INTAKE_WORDS = /fraud|fraudulent|fake|forg|dishonest|\blie\b|lying|scam|suspicious|staged/i;

export interface Blocker {
  code: string;
  text: string;
  for: 'owner' | 'auto';
}

export type PhotoScene = 'damage' | 'vehicle_whole' | 'number_plate' | 'document' | 'scene' | 'other';
export const PHOTO_SCENES: readonly PhotoScene[] = ['damage', 'vehicle_whole', 'number_plate', 'document', 'scene', 'other'];

/** PDF metadata read by the normaliser (pdfjs getMetadata + `%%EOF` count). */
export interface PdfMeta {
  producer: string | null;
  creator: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  /** Number of incremental saves after the first (`%%EOF` markers − 1, never below 0). */
  incrementalUpdates: number;
}

// ---------------------------------------------------------------------------
// Computed bundle state (stored as JSON on intake_bundles.computed; recomputable)
// ---------------------------------------------------------------------------

export interface FileComputed {
  fileId: string;
  groupKey: string;
  pinned: boolean;
  excluded: boolean;
  duplicate: { of: string; kind: 'same_file' | 'same_text' | 'near_photo' | 'near_text'; similarity: number } | null;
  docType: DocType | null;
  docSide: 'front' | 'back' | null;
  documentDate: string | null;
  engine: 'ai' | 'rules' | null;
  photo: {
    takenAt: string | null;
    gps: { lat: number; lon: number } | null;
    software: string | null;
    scene: PhotoScene | null;
    plates: Array<{ text: string; normalised: string; confidence: number; matches: 'client' | 'third_party' | null }>;
    zones: Array<{ zoneId: string; label: string; severity: 1 | 2 | 3; confidence: number }>;
  } | null;
}

export interface LiabilityPreview {
  score: number | null;
  band: string | null;
  reasons: string[];
  statements: Array<{ text: string; party: string; source: FieldSource }>;
  note: string;
}

export interface BundleComputed {
  revision: number;
  computedAt: string;
  files: Record<string, FileComputed>;
  groups: BundleGroup[];
  draft: {
    fields: DraftField[];
    witnesses: WitnessDraft[];
    witnessesAnswered: boolean;
    circumstances: { attribution: Attribution | null; fromFileId: string | null };
    existingParty: { partyId: string; name: string; claims: Array<{ id: string; reference: string }>; how: 'licence' | 'name_dob' } | null;
  };
  conflicts: Conflict[];
  checklist: { caseKind: CaseKind; caseKindLabel: string; items: ChecklistItem[]; request: { to: string | null; subject: string; body: string } | null };
  timeline: TimelineProposal[];
  signals: RiskSignal[];
  liability: LiabilityPreview;
  register: { canRegister: boolean; blockers: Blocker[]; fnolWarnings: string[]; willDo: string[] };
  auto: { eligible: boolean; blockers: Blocker[] };
  aiSummary: string | null;
  /** Main-group fileset hash (what the AI reasoning ran over). */
  fileset: string;
  warnings: string[];
}
