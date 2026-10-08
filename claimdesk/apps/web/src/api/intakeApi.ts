// owned by intake
/**
 * Intake client (docs/SUPREME-DESIGN.md §G, §L.8, §N.6). Web code never imports API code, so the HTTP shapes of
 * apps/api/src/routes/intake.ts are declared here.
 *
 *   POST /intake (multipart files + claimId, or {uploadId} / {importId} / {evidenceId})  → { items }
 *   GET  /intake?status=&claimId=  → { items, total }        GET /intake/:id → IntakeItemDetail
 *   POST /intake/:id/retry {from?, claimId?}
 *   POST /intake/new-claim-draft {itemIds} → NewClaimDraft   GET /intake/new-claim-draft/:id
 *   GET  /claims/:id/proposals?status=
 *   POST /proposals/apply {ids, values?}                     POST /proposals/reject {ids, reason}
 *
 * Files above the chunk threshold (64 MiB) go through the resumable upload with purpose `intake` (api/uploads.ts);
 * the finished upload is then handed to POST /intake as {uploadId}.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocType, ExtractedField, Id } from '@ccguk/domain';
import { request, seg } from './client';
import { getUploadLimits, planUpload, uploadInChunks } from './uploads';

export type IntakeStatus = 'queued' | 'normalising' | 'extracting' | 'proposed' | 'applied' | 'needs_you' | 'failed' | 'quota_wait' | 'skipped';
export type IntakeSource = 'upload' | 'email' | 'folder' | 'capture';
export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'superseded';
export type ProposalPolicy = 'auto' | 'confirm' | 'never';

export interface IntakeDocSummary {
  kind: 'pdf' | 'image' | 'docx' | 'email' | 'text' | 'heic' | 'skipped';
  sniffed: string;
  mime: string;
  extensionMatches: boolean;
  pages: number | null;
  scanned: boolean;
  textChars: number;
  textTruncated: boolean;
  email: { from?: string; to?: string; subject?: string; date?: string } | null;
  attachments: Array<{ filename: string; mime: string; bytes: number }>;
  skipReason: string | null;
  fingerprint: { templateId: string; title: string; score: number } | null;
  formTemplateId: string | null;
  newClaimDraftId: string | null;
}

export interface IntakeItemRow {
  id: Id;
  source: IntakeSource;
  evidenceId: Id;
  parentItemId?: Id;
  claimId?: Id;
  status: IntakeStatus;
  sniffedType?: string;
  docType?: DocType;
  docTypeConfidence?: number;
  docTypeLabel: string | null;
  pages?: number;
  error?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  claimReference: string | null;
  evidence: { id: Id; filename: string; mime: string; bytes: number; sha256: string; claimId: Id | null; uploadedAt: string } | null;
  doc: IntakeDocSummary | null;
  extraction: { id: Id; runId: string | null; summary: string | null; fields: number; warnings: string[]; createdAt: string } | null;
  proposals: { pending: number; applied: number; rejected: number; superseded: number };
  children: number;
}

export interface ProposalSource {
  intakeItemId?: Id;
  evidenceId?: Id;
  page?: number | null;
  quote?: string | null;
  label?: string | null;
  via?: 'extraction' | 'tool' | 'owner';
}

export interface Proposal {
  id: Id;
  claimId: Id;
  intakeItemId?: Id;
  target: string;
  label: string;
  currentValue?: string;
  proposedValue: string;
  confidence: number;
  sensitive: boolean;
  validator?: { validator?: { name: string; ok: boolean; message?: string }; policy?: { ruleIds: string[]; reasons: string[] }; decision?: { reason?: string; note?: string; error?: string } };
  source: ProposalSource;
  policyDecision: ProposalPolicy;
  status: ProposalStatus;
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
}

export interface IntakeExtractionView {
  id: Id;
  runId?: string;
  schemaId: string;
  fields: ExtractedField[];
  summary?: string;
  warnings: string[];
  createdAt: string;
}

export interface IntakeItemDetail extends IntakeItemRow {
  pageTexts: string[];
  extractions: IntakeExtractionView[];
  proposalList: Proposal[];
  childItems: IntakeItemRow[];
  parent: { id: Id; evidenceId: Id } | null;
  needsYou: Array<{ id: Id; kind: string; title: string }>;
}

export interface DraftSource {
  itemId: Id;
  evidenceId: Id;
  page: number | null;
  quote: string | null;
  confidence: number;
  docType: string | null;
  label: string;
}

interface DraftParty {
  kind: 'individual';
  name?: string;
  phone?: string;
  email?: string;
  dateOfBirth?: string;
  drivingLicenceNumber?: string;
  address?: { line1: string; line2?: string; town?: string; postcode: string };
  roles: string[];
}

export interface NewClaimDraftBody {
  claimant?: DraftParty;
  driver?: DraftParty;
  vehicle?: { registration?: string; vin?: string; make?: string; model?: string; monthOfFirstRegistration?: string; colour?: string; ownership: 'client' };
  accident?: { occurredAt?: string; location?: string };
  atFaultInsurerRef?: string;
  thirdParty?: { registration?: string; driverName?: string; insurerPolicyNumber?: string; contact?: string };
}

export interface NewClaimDraft {
  id: Id;
  createdAt: string;
  createdBy: string;
  itemIds: Id[];
  body: NewClaimDraftBody;
  sources: Record<string, DraftSource>;
  conflicts: Array<{ fieldPath: string; kept: string; other: string; otherSource: DraftSource }>;
  rejected: Array<{ fieldPath: string; value: string; reason: string; source: DraftSource }>;
  stillNeeded: string[];
}

export interface ApplyResult {
  proposalId: Id;
  ok: boolean;
  error?: { code: string; message: string };
}

export const intakeApi = {
  list: (f: { status?: string; claimId?: string } = {}) => request<{ items: IntakeItemRow[]; total: number }>('/intake', { query: { status: f.status || undefined, claimId: f.claimId || undefined, limit: 200 } }),
  get: (id: Id) => request<IntakeItemDetail>(`/intake/${seg(id)}`),
  uploadFiles: (files: File[], claimId?: Id) => {
    const fd = new FormData();
    if (claimId) fd.append('claimId', claimId);
    for (const f of files) fd.append('file', f, f.name);
    return request<{ items: IntakeItemRow[] }>('/intake', { method: 'POST', formData: fd });
  },
  fromUpload: (uploadId: string, claimId?: Id) => request<{ items: IntakeItemRow[] }>('/intake', { method: 'POST', body: { uploadId, ...(claimId ? { claimId } : {}) } }),
  fromImport: (importId: string, claimId?: Id) => request<{ items: IntakeItemRow[] }>('/intake', { method: 'POST', body: { importId, ...(claimId ? { claimId } : {}) } }),
  retry: (id: Id, body: { from?: 'process' | 'extract' | 'apply'; claimId?: Id } = {}) => request<{ item: IntakeItemRow; queued: string }>(`/intake/${seg(id)}/retry`, { method: 'POST', body }),
  newClaimDraft: (itemIds: Id[]) => request<NewClaimDraft>('/intake/new-claim-draft', { method: 'POST', body: { itemIds } }),
  getDraft: (id: Id) => request<NewClaimDraft>(`/intake/new-claim-draft/${seg(id)}`),
  claimProposals: (claimId: Id, status?: ProposalStatus) => request<{ items: Proposal[] }>(`/claims/${seg(claimId)}/proposals`, { query: { status } }),
  apply: (ids: Id[], values?: Record<Id, string>) => request<{ results: ApplyResult[]; proposals: Proposal[] }>('/proposals/apply', { method: 'POST', body: { ids, ...(values && Object.keys(values).length ? { values } : {}) } }),
  reject: (ids: Id[], reason: string) => request<{ rejected: number; proposals: Proposal[] }>('/proposals/reject', { method: 'POST', body: { ids, reason } }),
};

/**
 * Add files for intake: small files in one multipart POST; a file above the chunk threshold goes through the resumable
 * upload (purpose `intake`) and is then handed over by its upload id. Files above the server's limit are refused
 * with a message that points at the import folder.
 */
export async function addIntakeFiles(files: File[], opts: { claimId?: Id; onProgress?: (name: string, sent: number, total: number) => void; signal?: AbortSignal } = {}): Promise<{ items: IntakeItemRow[]; refused: string[] }> {
  const limits = await getUploadLimits(opts.signal);
  const small: File[] = [];
  const items: IntakeItemRow[] = [];
  const refused: string[] = [];
  for (const f of files) {
    const plan = planUpload(f.size, limits);
    if (plan.mode === 'too-large') refused.push(`${f.name}: ${plan.message}`);
    else if (plan.mode === 'chunked') {
      const r = await uploadInChunks(f, { purpose: 'intake', ...(opts.claimId ? { claimId: opts.claimId } : {}), onProgress: (sent, total) => opts.onProgress?.(f.name, sent, total), ...(opts.signal ? { signal: opts.signal } : {}) });
      items.push(...(await intakeApi.fromUpload(r.uploadId, opts.claimId)).items);
    } else small.push(f);
  }
  if (small.length) items.push(...(await intakeApi.uploadFiles(small, opts.claimId)).items);
  return { items, refused };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const intakeKeys = {
  all: ['intake'] as const,
  list: (f: { status?: string; claimId?: string }) => ['intake', 'list', f] as const,
  item: (id: Id) => ['intake', 'item', id] as const,
  draft: (id: Id) => ['intake', 'draft', id] as const,
};

/** Items still moving through the pipeline (the list refreshes while any are). */
export const IN_PROGRESS: ReadonlySet<IntakeStatus> = new Set(['queued', 'normalising', 'extracting']);

export function useIntakeList(f: { status?: string; claimId?: string } = {}) {
  return useQuery({
    queryKey: intakeKeys.list(f),
    queryFn: () => intakeApi.list(f),
    refetchInterval: (q) => ((q.state.data?.items ?? []).some((i) => IN_PROGRESS.has(i.status)) ? 4000 : 30_000),
  });
}

export function useIntakeItem(id: Id | undefined) {
  return useQuery({
    queryKey: intakeKeys.item(id ?? ''),
    queryFn: () => intakeApi.get(id!),
    enabled: Boolean(id),
    refetchInterval: (q) => (q.state.data && IN_PROGRESS.has(q.state.data.status) ? 4000 : false),
  });
}

export function useIntakeDraft(id: Id | undefined) {
  return useQuery({ queryKey: intakeKeys.draft(id ?? ''), queryFn: () => intakeApi.getDraft(id!), enabled: Boolean(id), staleTime: Infinity });
}

export function useIntakeMutations() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: intakeKeys.all });
  return {
    apply: useMutation({ mutationFn: (v: { ids: Id[]; values?: Record<Id, string> }) => intakeApi.apply(v.ids, v.values), onSuccess: refresh }),
    reject: useMutation({ mutationFn: (v: { ids: Id[]; reason: string }) => intakeApi.reject(v.ids, v.reason), onSuccess: refresh }),
    retry: useMutation({ mutationFn: (v: { id: Id; from?: 'process' | 'extract' | 'apply'; claimId?: Id }) => intakeApi.retry(v.id, { ...(v.from ? { from: v.from } : {}), ...(v.claimId ? { claimId: v.claimId } : {}) }), onSuccess: refresh }),
    newClaimDraft: useMutation({ mutationFn: (itemIds: Id[]) => intakeApi.newClaimDraft(itemIds) }),
    refresh,
  };
}
