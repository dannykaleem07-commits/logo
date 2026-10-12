// owned by intake-web
/**
 * Smart intake — case bundles client (docs/SMART-INTAKE.md §8, §11). Web code never imports API code and does not
 * depend on new @ccguk/domain exports, so every JSON shape of §8.1 is declared here (frozen contract, §17.3).
 *
 *   GET  /intake/bundles?status=open|done|cancelled|all&limit&offset   → { items: BundleSummary[], total }
 *   POST /intake/bundles {name}                                        → 201 BundleSummary
 *   GET  /intake/bundles/:id                                           → BundleDetail
 *   GET  /intake/bundles/:id/progress                                  → { bundle, files[] }   (cheap; polled every 3 s)
 *   PATCH /intake/bundles/:id {name}                                   → BundleSummary
 *   POST /intake/bundles/:id/files  multipart ≤ 10 `file` parts, or {uploadId} / {importId} / {evidenceId}
 *   POST …/files/:fileId/move {groupKey} · /exclude {excluded, reason?} · /unsplit · /file-copy
 *   POST …/fields {key, value, note?} · /witnesses {witnesses, answered}
 *   POST …/conflicts/:conflictId/choose {value} · /conflicts/accept-preselected
 *   POST …/confirm-new {note?} · /link-party {partyId} · /timeline/:proposalId {ticked} · /signals/:signalId/ack {note?}
 *   POST …/groups/:groupKey/split-off {name?} · /think-again · /register · /register/retry · /attach · /cancel · /reopen
 *   POST …/wizard-draft → NewClaimDraft          GET …/brief → CaseBriefView
 *   GET  /claims/:id/intake-brief → CaseBriefView (404 NO_INTAKE_BUNDLE)   GET /claims/:id/damage-zones
 *   GET/PATCH /settings/intake → IntakeSettingsView
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request, seg, isApiError } from './client';
import type { NewClaimDraft } from './intakeApi';

// ---------------------------------------------------------------------------
// §8.1 shared JSON types
// ---------------------------------------------------------------------------

export type BundleStatus = 'open' | 'reading' | 'reconciling' | 'ready' | 'needs_you' | 'registering' | 'registered' | 'attached' | 'cancelled';
export type Readiness = 'reading' | 'needs_review' | 'ready_to_register' | 'registered' | 'attached' | 'cancelled';
export type FileStage = 'stored' | 'reading' | 'splitting' | 'waiting_ai' | 'reading_ai' | 'read' | 'read_rules_only' | 'unpacked' | 'skipped' | 'failed';
export type WaitingReason = 'agents_off' | 'kill_switch' | 'usage' | 'sign_in';
export type ReasoningStatus = 'none' | 'queued' | 'waiting_ai' | 'done' | 'failed' | 'skipped';
export type CandidateEngine = 'ai' | 'rules' | 'exif' | 'plate' | 'owner' | 'name_hint' | 'ai_reasoning';
export type BundleFileRole = 'document' | 'pack' | 'segment' | 'attachment' | 'archive' | 'email';
export type GroupKind = 'main' | 'new_case' | 'existing_claim' | 'unsure' | 'excluded';
export type DraftSection = 'client' | 'driver' | 'vehicle' | 'third_party' | 'accident' | 'insurers' | 'hire_repair';
export type DraftFieldStatus = 'ok' | 'low_confidence' | 'conflict' | 'missing' | 'owner_set' | 'invalid';
export type DuplicateKind = 'same_file' | 'same_text' | 'near_photo' | 'near_text';
export type GroupAction = 'split_off' | 'attach' | 'exclude';

export interface Waiting {
  reason: WaitingReason;
  until?: string;
}

export interface Blocker {
  code: string;
  text: string;
  for: 'owner' | 'auto';
}

export interface BundleSummary {
  id: string;
  name: string;
  status: BundleStatus;
  readiness: Readiness;
  source: 'upload' | 'folder' | 'split';
  folderKey: string | null;
  parentBundleId: string | null;
  revision: number;
  computedRevision: number | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  fileCounts: { total: number; read: number; inProgress: number; waitingAi: number; failed: number; skipped: number; duplicates: number };
  groupCount: number;
  conflictsOpen: number;
  missingDocs: number;
  signals: { warn: number; info: number };
  reasoning: { status: ReasoningStatus; at: string | null; waiting: Waiting | null };
  autoRegister: { settingOn: boolean; eligible: boolean; blockers: Blocker[] };
  claim: { id: string; reference: string } | null;
  needsYouId: string | null;
  error: string | null;
}

export interface FieldSource {
  fileId: string;
  itemId: string;
  evidenceId: string;
  filename: string;
  docType: string | null;
  docTypeLabel: string | null;
  page: number | null;
  quote: string | null;
  confidence: number;
  engine: CandidateEngine;
  rank: number;
  label: string;
  quoteVerified: boolean | null;
}

export interface PhotoPlate {
  text: string;
  normalised: string;
  confidence: number;
  matches: 'client' | 'third_party' | null;
}

export interface BundleFileView {
  id: string;
  itemId: string;
  evidenceId: string;
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  addedAt: string;
  position: number;
  role: BundleFileRole;
  parentFileId: string | null;
  segment: { fromPage: number; toPage: number } | null;
  stage: FileStage;
  stageLabel: string;
  waiting: Waiting | null;
  error: string | null;
  docType: string | null;
  docTypeLabel: string | null;
  docTypeConfidence: number | null;
  docSide: 'front' | 'back' | null;
  documentDate: string | null;
  pages: number | null;
  summary: string | null;
  engine: 'ai' | 'rules' | null;
  groupKey: string;
  pinned: boolean;
  excluded: boolean;
  duplicate: { of: string; kind: DuplicateKind; similarity: number } | null;
  photo: {
    takenAt: string | null;
    gps: { lat: number; lon: number } | null;
    software: string | null;
    scene: string | null;
    plates: PhotoPlate[];
    zones: Array<{ zoneId: string; label: string; severity: 1 | 2 | 3; confidence: number }>;
  } | null;
  pdfMeta: { producer: string | null; creator: string | null; createdAt: string | null; modifiedAt: string | null; incrementalUpdates: number } | null;
  archive: { entries: number; skipped: Array<{ name: string; reason: string }> } | null;
  filed: { evidenceId: string; claimId: string; kind: string; at: string } | null;
  /** "/api/evidence/<evidenceId>/file" */
  fileUrl: string;
}

export interface BundleGroup {
  /** 'main' | 'case:B' | 'claim:<claimId>' | 'unsure' | 'excluded' */
  key: string;
  kind: GroupKind;
  label: string;
  claim: { id: string; reference: string; clientName: string | null; status: string } | null;
  fileIds: string[];
  reasons: Array<{ code: string; text: string; fileId?: string }>;
  confidence: number;
  suggestedName: string | null;
  warnings: string[];
  defaultAction: 'register' | 'attach' | 'split_off' | 'exclude' | 'decide';
}

export interface DraftAlternative {
  value: string;
  display: string;
  sources: FieldSource[];
}

export interface DraftField {
  key: string;
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
  alternatives: DraftAlternative[];
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
  key: string;
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

export interface ChecklistItem {
  id: string;
  label: string;
  status: 'have' | 'missing' | 'partial' | 'not_needed';
  why: string;
  fileIds: string[];
}

export interface TimelineProposal {
  id: string;
  at: string;
  precision: 'date' | 'datetime';
  eventType: string;
  eventLabel: string;
  class: 'record' | 'clock' | 'owner_only';
  summary: string;
  attributableTo: string;
  sources: FieldSource[];
  confidence: number;
  ticked: boolean;
  tickedBy: 'default' | 'owner';
  note: string | null;
}

export interface RiskSignal {
  id: string;
  code: string;
  severity: 'info' | 'warn';
  title: string;
  message: string;
  fileIds: string[];
  claims: Array<{ id: string; reference: string }>;
  basis: Array<{ fileId: string; page: number | null; quote: string | null }>;
  acknowledged: { by: string; at: string; note: string | null } | null;
}

export interface BundleDecisionView {
  id: string;
  kind: string;
  subject: string | null;
  before: unknown;
  after: unknown;
  note: string | null;
  actor: string;
  at: string;
}

/**
 * §8.1 declares `BundleDetail extends BundleSummary` while both carry `signals` (counts on the summary, the list on the
 * detail). The detail's `signals` is the list; the counts are derived from it (`signalCounts`). `normaliseDetail`
 * accepts either shape from the server.
 */
export interface BundleDetail extends Omit<BundleSummary, 'signals'> {
  files: BundleFileView[];
  groups: BundleGroup[];
  draft: {
    fields: DraftField[];
    witnesses: WitnessDraft[];
    witnessesAnswered: boolean;
    circumstances: { attribution: 'client' | 'police' | 'insurer' | 'witness' | 'owner' | 'other' | null; fromFileId: string | null };
    existingParty: { partyId: string; name: string; claims: Array<{ id: string; reference: string }>; how: 'licence' | 'name_dob' } | null;
  };
  conflicts: Conflict[];
  checklist: { caseKind: string; caseKindLabel: string; items: ChecklistItem[]; request: { to: string | null; subject: string; body: string } | null };
  timeline: TimelineProposal[];
  signals: RiskSignal[];
  liability: { score: number | null; band: string | null; reasons: string[]; statements: Array<{ text: string; party: string; source: FieldSource }>; note: string };
  register: { canRegister: boolean; blockers: Blocker[]; fnolWarnings: string[]; willDo: string[] };
  aiSummary: string | null;
  /** Newest 50. */
  decisions: BundleDecisionView[];
}

export interface CaseBriefView {
  claim: { id: string; reference: string; status: string; createdAt: string };
  bundle: { id: string; name: string } | null;
  generatedAt: string;
  summary: string;
  summarySource: 'ai' | 'template';
  facts: Array<{ label: string; value: string; source: string | null }>;
  liability: { position: string; score: number | null; band: string | null; reasons: string[]; statements: Array<{ text: string; source: string }>; note: string };
  missing: ChecklistItem[];
  request: { status: 'waiting_for_you' | 'sent' | 'not_prepared' | 'prepared_no_email'; outboxId: string | null; needsYouId: string | null; reason: string | null };
  callReminder: string | null;
  autopilot: { stopped: string | null; firstSteps: Array<{ id: string; title: string; mode: string; status: string; sentence: string }> };
  nextActions: Array<{ code: string; title: string; why: string; dueAt: string | null }>;
  signals: RiskSignal[];
  filed: { documents: number; photos: number; duplicatesSkipped: number; events: number; damageZones: number };
}

/** Settings > Intake (§4.17). Declared here: the web does not depend on new domain exports. */
export interface IntakeSettings {
  bundles: { autoRegister: boolean; autoRegisterMinConfidence: number; prepareMissingDocsRequest: boolean; quietSeconds: number; folderBundles: boolean; aiReasoningRunsPerBundlePerDay: number };
  split: { enabled: boolean; minPages: number };
  duplicates: { nearPhotoMaxDistance: number; nearTextMinJaccard: number };
  photos: { beforeAccidentToleranceHours: number; gpsOutlierKm: number };
  archives: { maxEntries: number; maxTotalBytes: number; maxDepth: number; maxRatio: number };
}

export type IntakeSettingsPatch = { [G in keyof IntakeSettings]?: Partial<IntakeSettings[G]> };

export interface IntakeSettingsView {
  settings: IntakeSettings;
  defaults: IntakeSettings;
}

export interface ProposalsOutcome {
  applied: number;
  pending: number;
  needsYouId: string | null;
}

export interface RequestOutcome {
  outboxId: string | null;
  needsYouId: string | null;
  reason: string | null;
}

export interface RegisterResult {
  claim: { id: string; reference: string };
  bundle: BundleSummary;
  filed: { evidence: number; duplicatesSkipped: number };
  events: number;
  proposals: ProposalsOutcome;
  request: RequestOutcome;
  splitOff: BundleSummary[];
  attached: Array<{ claimId: string; reference: string; files: number }>;
  brief: CaseBriefView;
  error: string | null;
}

export interface AttachResult {
  claim: { id: string; reference: string };
  bundle: BundleSummary;
  filed: { evidence: number; duplicatesSkipped: number };
  events: number;
  proposals: ProposalsOutcome;
  request: RequestOutcome;
}

export interface RegisterBody {
  acceptPreselected?: boolean;
  confirmNew?: boolean;
  timeline?: { tick: string[]; untick: string[] };
  requestMissingDocs?: boolean;
  groups?: Record<string, GroupAction>;
}

export interface AttachBody {
  claimId: string;
  groupKey?: string;
  apply?: string[];
}

export interface AddFilesResult {
  files: Array<{ fileId: string; itemId: string; filename: string; outcome: 'added' | 'already_in_bundle' }>;
  bundle: BundleSummary;
}

export interface BundleProgress {
  bundle: BundleSummary;
  files: Array<{ id: string; filename: string; stage: FileStage; stageLabel: string; waiting: Waiting | null }>;
}

export interface DamageZonesView {
  zones: Record<string, { severity: 0 | 1 | 2 | 3; confidence: number; source: 'ai'; evidenceIds: string[] }>;
  observations: Array<{ id: string; zoneId: string; severity: number; confidence: number; source: string; evidenceId: string | null; createdAt: string }>;
}

export type BundleListFilter = 'open' | 'done' | 'cancelled' | 'all';

// ---------------------------------------------------------------------------
// Client functions
// ---------------------------------------------------------------------------

const b = (id: string) => `/intake/bundles/${seg(id)}`;

/** Counts of unacknowledged-or-not signals by severity (the summary's `signals`). */
export function signalCounts(list: RiskSignal[]): { warn: number; info: number } {
  return { warn: list.filter((x) => x.severity === 'warn').length, info: list.filter((x) => x.severity === 'info').length };
}

/** Accept the detail defensively: lists default to [] (e.g. `signals` sent as counts), nested objects to empty ones. */
export function normaliseDetail(raw: unknown): BundleDetail {
  const d = (raw ?? {}) as Partial<BundleDetail> & Record<string, unknown>;
  const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const draft = (d.draft ?? {}) as Partial<BundleDetail['draft']>;
  const checklist = (d.checklist ?? {}) as Partial<BundleDetail['checklist']>;
  const register = (d.register ?? {}) as Partial<BundleDetail['register']>;
  const liability = (d.liability ?? {}) as Partial<BundleDetail['liability']>;
  return {
    ...(d as BundleDetail),
    files: list(d.files),
    groups: list(d.groups),
    draft: {
      fields: list(draft.fields),
      witnesses: list(draft.witnesses),
      witnessesAnswered: Boolean(draft.witnessesAnswered),
      circumstances: draft.circumstances ?? { attribution: null, fromFileId: null },
      existingParty: draft.existingParty ?? null,
    },
    conflicts: list(d.conflicts),
    checklist: { caseKind: checklist.caseKind ?? 'unknown', caseKindLabel: checklist.caseKindLabel ?? '', items: list(checklist.items), request: checklist.request ?? null },
    timeline: list(d.timeline),
    signals: list(d.signals),
    liability: { score: liability.score ?? null, band: liability.band ?? null, reasons: list(liability.reasons), statements: list(liability.statements), note: liability.note ?? '' },
    register: { canRegister: Boolean(register.canRegister), blockers: list(register.blockers), fnolWarnings: list(register.fnolWarnings), willDo: list(register.willDo) },
    aiSummary: d.aiSummary ?? null,
    decisions: list(d.decisions),
  };
}

const detail = async (p: Promise<unknown>): Promise<BundleDetail> => normaliseDetail(await p);

export const bundlesApi = {
  list: (status: BundleListFilter = 'open', opts: { limit?: number; offset?: number } = {}) =>
    request<{ items: BundleSummary[]; total: number }>('/intake/bundles', { query: { status, limit: opts.limit ?? 200, offset: opts.offset } }),
  create: (name: string) => request<BundleSummary>('/intake/bundles', { method: 'POST', body: { name: name.trim() } }),
  get: (id: string) => detail(request<unknown>(b(id))),
  progress: (id: string) => request<BundleProgress>(`${b(id)}/progress`),
  rename: (id: string, name: string) => request<BundleSummary>(b(id), { method: 'PATCH', body: { name: name.trim() } }),
  /** Up to 10 files in one multipart request (uploadQueue.ts batches them; the default transport there reports progress). */
  addFiles: (id: string, files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    return request<AddFilesResult>(`${b(id)}/files`, { method: 'POST', formData: fd });
  },
  addFromUpload: (id: string, uploadId: string) => request<AddFilesResult>(`${b(id)}/files`, { method: 'POST', body: { uploadId } }),
  addFromImport: (id: string, importId: string) => request<AddFilesResult>(`${b(id)}/files`, { method: 'POST', body: { importId } }),
  addFromEvidence: (id: string, evidenceId: string) => request<AddFilesResult>(`${b(id)}/files`, { method: 'POST', body: { evidenceId } }),
  moveFile: (id: string, fileId: string, groupKey: string) => detail(request<unknown>(`${b(id)}/files/${seg(fileId)}/move`, { method: 'POST', body: { groupKey } })),
  excludeFile: (id: string, fileId: string, excluded: boolean, reason?: string) =>
    detail(request<unknown>(`${b(id)}/files/${seg(fileId)}/exclude`, { method: 'POST', body: { excluded, ...(reason ? { reason } : {}) } })),
  unsplit: (id: string, fileId: string) => detail(request<unknown>(`${b(id)}/files/${seg(fileId)}/unsplit`, { method: 'POST', body: {} })),
  fileCopy: (id: string, fileId: string) => detail(request<unknown>(`${b(id)}/files/${seg(fileId)}/file-copy`, { method: 'POST', body: {} })),
  setField: (id: string, key: string, value: string | null, note?: string) => detail(request<unknown>(`${b(id)}/fields`, { method: 'POST', body: { key, value, ...(note ? { note } : {}) } })),
  setWitnesses: (id: string, witnesses: Array<{ name: string; phone?: string; relationship: string }>, answered: boolean) =>
    detail(request<unknown>(`${b(id)}/witnesses`, { method: 'POST', body: { witnesses, answered } })),
  chooseConflict: (id: string, conflictId: string, value: string) => detail(request<unknown>(`${b(id)}/conflicts/${seg(conflictId)}/choose`, { method: 'POST', body: { value } })),
  acceptPreselected: (id: string) => detail(request<unknown>(`${b(id)}/conflicts/accept-preselected`, { method: 'POST', body: {} })),
  confirmNew: (id: string, note?: string) => detail(request<unknown>(`${b(id)}/confirm-new`, { method: 'POST', body: note ? { note } : {} })),
  linkParty: (id: string, partyId: string | null) => detail(request<unknown>(`${b(id)}/link-party`, { method: 'POST', body: { partyId } })),
  tickTimeline: (id: string, proposalId: string, ticked: boolean) => detail(request<unknown>(`${b(id)}/timeline/${seg(proposalId)}`, { method: 'POST', body: { ticked } })),
  ackSignal: (id: string, signalId: string, note?: string) => detail(request<unknown>(`${b(id)}/signals/${seg(signalId)}/ack`, { method: 'POST', body: note ? { note } : {} })),
  splitOff: (id: string, groupKey: string, name?: string) =>
    request<{ bundle: BundleSummary; source: unknown }>(`${b(id)}/groups/${seg(groupKey)}/split-off`, { method: 'POST', body: name ? { name } : {} }).then((r) => ({ bundle: r.bundle, source: normaliseDetail(r.source) })),
  thinkAgain: (id: string) => request<BundleSummary>(`${b(id)}/think-again`, { method: 'POST', body: {} }),
  register: (id: string, body: RegisterBody = {}) => request<RegisterResult>(`${b(id)}/register`, { method: 'POST', body }),
  registerRetry: (id: string) => request<RegisterResult>(`${b(id)}/register/retry`, { method: 'POST', body: {} }),
  attach: (id: string, body: AttachBody) => request<AttachResult>(`${b(id)}/attach`, { method: 'POST', body }),
  cancel: (id: string, reason: string) => request<BundleSummary>(`${b(id)}/cancel`, { method: 'POST', body: { reason } }),
  reopen: (id: string) => request<BundleSummary>(`${b(id)}/reopen`, { method: 'POST', body: {} }),
  wizardDraft: (id: string) => request<NewClaimDraft>(`${b(id)}/wizard-draft`, { method: 'POST', body: {} }),
  brief: (id: string) => request<CaseBriefView>(`${b(id)}/brief`),
  claimBrief: (claimId: string) => request<CaseBriefView>(`/claims/${seg(claimId)}/intake-brief`),
  damageZones: (claimId: string) => request<DamageZonesView>(`/claims/${seg(claimId)}/damage-zones`),
  settings: () => request<IntakeSettingsView>('/settings/intake'),
  patchSettings: (patch: IntakeSettingsPatch) => request<IntakeSettingsView>('/settings/intake', { method: 'PATCH', body: patch }),
};

// ---------------------------------------------------------------------------
// Query keys and polling rules
// ---------------------------------------------------------------------------

export const bundleKeys = {
  all: ['intake-bundles'] as const,
  list: (f: BundleListFilter) => ['intake-bundles', 'list', f] as const,
  detail: (id: string) => ['intake-bundles', 'detail', id] as const,
  progress: (id: string) => ['intake-bundles', 'progress', id] as const,
  brief: (id: string) => ['intake-bundles', 'brief', id] as const,
  claimBrief: (claimId: string) => ['intake-bundles', 'claim-brief', claimId] as const,
  damageZones: (claimId: string) => ['intake-bundles', 'damage-zones', claimId] as const,
  settings: ['settings', 'intake'] as const,
};

/** The list polls every 4 s while any bundle is reading (§11.2), else every 30 s. */
export const LIST_POLL_MS = 4000;
/** The bundle page polls the cheap progress route every 3 s while anything is in progress (§11.4). */
export const PROGRESS_POLL_MS = 3000;

/** Server stages that are still moving (a file waiting only for the AI is not "in progress": it does not block). */
export const STAGES_IN_PROGRESS: ReadonlySet<FileStage> = new Set(['stored', 'reading', 'splitting', 'reading_ai']);

export function listRefetchMs(items: BundleSummary[] | undefined): number {
  return (items ?? []).some((i) => i.readiness === 'reading') ? LIST_POLL_MS : 30_000;
}

/** True while the bundle (or any of its files) is still being read — the page keeps polling `progress`. */
export function bundleInProgress(p: { bundle: Pick<BundleSummary, 'readiness' | 'status' | 'revision' | 'computedRevision'>; files: Array<{ stage: FileStage }> } | undefined): boolean {
  if (!p) return false;
  if (p.bundle.readiness === 'reading' || p.bundle.status === 'reconciling' || p.bundle.status === 'registering') return true;
  return p.files.some((f) => STAGES_IN_PROGRESS.has(f.stage));
}

/** The detail is stale when the progress shows a newer revision or a newer computed revision than the detail holds. */
export function detailIsStale(detail: Pick<BundleSummary, 'revision' | 'computedRevision'> | undefined, progress: Pick<BundleSummary, 'revision' | 'computedRevision'> | undefined): boolean {
  if (!detail || !progress) return false;
  return progress.revision !== detail.revision || (progress.computedRevision ?? -1) !== (detail.computedRevision ?? -1);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useBundles(filter: BundleListFilter) {
  return useQuery({ queryKey: bundleKeys.list(filter), queryFn: () => bundlesApi.list(filter), refetchInterval: (q) => listRefetchMs(q.state.data?.items) });
}

export function useBundle(id: string | undefined) {
  return useQuery({ queryKey: bundleKeys.detail(id ?? ''), queryFn: () => bundlesApi.get(id!), enabled: Boolean(id) });
}

export function useBundleProgress(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: bundleKeys.progress(id ?? ''),
    queryFn: () => bundlesApi.progress(id!),
    enabled: Boolean(id) && enabled,
    refetchInterval: (q) => (bundleInProgress(q.state.data) ? PROGRESS_POLL_MS : false),
  });
}

export function useBundleBrief(id: string | undefined, enabled: boolean) {
  return useQuery({ queryKey: bundleKeys.brief(id ?? ''), queryFn: () => bundlesApi.brief(id!), enabled: Boolean(id) && enabled, retry: false });
}

/** The claim's intake brief; a 404 (`NO_INTAKE_BUNDLE`) resolves to null so the card renders nothing. */
export function useClaimIntakeBrief(claimId: string | undefined) {
  return useQuery({
    queryKey: bundleKeys.claimBrief(claimId ?? ''),
    queryFn: async () => {
      try {
        return await bundlesApi.claimBrief(claimId!);
      } catch (e) {
        if (isApiError(e) && e.status === 404) return null;
        throw e;
      }
    },
    enabled: Boolean(claimId),
    retry: false,
    staleTime: 60_000,
  });
}

export function useClaimDamageZones(claimId: string | undefined) {
  return useQuery({ queryKey: bundleKeys.damageZones(claimId ?? ''), queryFn: () => bundlesApi.damageZones(claimId!), enabled: Boolean(claimId), retry: false, staleTime: 60_000 });
}

export function useIntakeSettings() {
  return useQuery({ queryKey: bundleKeys.settings, queryFn: bundlesApi.settings });
}

export function usePatchIntakeSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: IntakeSettingsPatch) => bundlesApi.patchSettings(patch),
    onSuccess: (view) => qc.setQueryData(bundleKeys.settings, view),
    onSettled: () => qc.invalidateQueries({ queryKey: bundleKeys.settings }),
  });
}

/**
 * Mutations on one bundle. Every decision route answers with the fresh BundleDetail, which replaces the cached detail
 * at once (no flicker, no refetch race); lists and progress are invalidated.
 */
export function useBundleMutations(id: string) {
  const qc = useQueryClient();
  const setDetail = (d: BundleDetail) => {
    qc.setQueryData(bundleKeys.detail(id), d);
    void qc.invalidateQueries({ queryKey: ['intake-bundles', 'list'] });
    void qc.invalidateQueries({ queryKey: bundleKeys.progress(id) });
  };
  const refresh = () => qc.invalidateQueries({ queryKey: bundleKeys.all });
  const detailMutation = <V,>(fn: (v: V) => Promise<BundleDetail>) => useMutation({ mutationFn: fn, onSuccess: setDetail });
  return {
    move: detailMutation((v: { fileId: string; groupKey: string }) => bundlesApi.moveFile(id, v.fileId, v.groupKey)),
    exclude: detailMutation((v: { fileId: string; excluded: boolean; reason?: string }) => bundlesApi.excludeFile(id, v.fileId, v.excluded, v.reason)),
    unsplit: detailMutation((fileId: string) => bundlesApi.unsplit(id, fileId)),
    fileCopy: detailMutation((fileId: string) => bundlesApi.fileCopy(id, fileId)),
    setField: detailMutation((v: { key: string; value: string | null; note?: string }) => bundlesApi.setField(id, v.key, v.value, v.note)),
    setWitnesses: detailMutation((v: { witnesses: Array<{ name: string; phone?: string; relationship: string }>; answered: boolean }) => bundlesApi.setWitnesses(id, v.witnesses, v.answered)),
    choose: detailMutation((v: { conflictId: string; value: string }) => bundlesApi.chooseConflict(id, v.conflictId, v.value)),
    acceptPreselected: detailMutation((_: void) => bundlesApi.acceptPreselected(id)),
    confirmNew: detailMutation((note?: string) => bundlesApi.confirmNew(id, note)),
    linkParty: detailMutation((partyId: string | null) => bundlesApi.linkParty(id, partyId)),
    tick: detailMutation((v: { proposalId: string; ticked: boolean }) => bundlesApi.tickTimeline(id, v.proposalId, v.ticked)),
    ack: detailMutation((v: { signalId: string; note?: string }) => bundlesApi.ackSignal(id, v.signalId, v.note)),
    splitOff: useMutation({
      mutationFn: (v: { groupKey: string; name?: string }) => bundlesApi.splitOff(id, v.groupKey, v.name),
      onSuccess: (r) => setDetail(r.source),
    }),
    rename: useMutation({ mutationFn: (name: string) => bundlesApi.rename(id, name), onSuccess: () => void refresh() }),
    thinkAgain: useMutation({ mutationFn: () => bundlesApi.thinkAgain(id), onSuccess: () => void refresh() }),
    register: useMutation({ mutationFn: (body: RegisterBody) => bundlesApi.register(id, body), onSettled: () => void refresh() }),
    registerRetry: useMutation({ mutationFn: () => bundlesApi.registerRetry(id), onSettled: () => void refresh() }),
    attach: useMutation({ mutationFn: (body: AttachBody) => bundlesApi.attach(id, body), onSettled: () => void refresh() }),
    cancel: useMutation({ mutationFn: (reason: string) => bundlesApi.cancel(id, reason), onSettled: () => void refresh() }),
    reopen: useMutation({ mutationFn: () => bundlesApi.reopen(id), onSettled: () => void refresh() }),
    wizardDraft: useMutation({ mutationFn: () => bundlesApi.wizardDraft(id) }),
    refresh,
  };
}
