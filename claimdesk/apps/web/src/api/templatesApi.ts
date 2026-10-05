/**
 * DOCX template library and DOCX claim documents (docs/TEMPLATES-VEHICLES-DESKTOP.md §C.5, §C.9).
 *
 * The web cannot import @ccguk/documents (Node-only code), so the response types below are copies of the contract
 * in §A.6, §B.3, §B.6, §B.9 and §C.5. Keep them in step with the design document, not with the API source.
 *
 * Routes are called through the shared `request()` (JSON, cookies, 401 redirect). The two binary responses (the
 * test copy and the stored .docx) use `fetchBinary()` here, which keeps the same error shape (`ApiError`).
 */
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import type { Id } from '@ccguk/domain';
import { ApiError, asList, buildUrl, request, seg, type ClaimDocument } from './client';
import { qk, useInvalidateClaim } from './hooks';

// ---------------------------------------------------------------------------
// Scan and mapping types (§A.6, §B.3, §B.6)
// ---------------------------------------------------------------------------

export type SlotKind = 'cell' | 'inline' | 'line' | 'blank' | 'bracket' | 'token' | 'control' | 'mergefield' | 'checkbox' | 'choice' | 'block' | 'table' | 'paragraphs';
export type BlankPattern = 'date' | 'datetime' | 'time' | 'month-year' | 'money' | 'reference' | 'number' | 'percent' | 'eighths' | 'page-of' | 'text';

export interface DocxSlot {
  id: string;
  kind: SlotKind;
  part: string;
  parts?: string[];
  sectionPath: string[];
  sectionTitles: string[];
  qualifier?: string;
  qualifierTitle?: string;
  label: string;
  labelSlug: string;
  ordinal: number;
  sub?: string;
  preview: string;
  blank?: { pattern: BlankPattern; text: string; hasCurrency: boolean; prefix?: string; unit?: string };
  options?: Array<{ slug: string; label: string; checked: boolean; blank?: { pattern: BlankPattern; text: string } }>;
  columns?: Array<{ slug: string; label: string }>;
  rowCount?: number;
  fixedLead?: string;
  token?: { key: string; format?: string };
  signature: boolean;
  hint: boolean;
  widthTwips?: number;
  multiline: boolean;
  blockId?: string;
}

export interface DocxBlock {
  id: string;
  title: string;
  part: string;
  startIndex: number;
  endIndex: number;
}

export interface DocxOutlineItem {
  level: 1 | 2;
  title: string;
  slug: string;
}

export type FieldType = 'text' | 'multiline' | 'date' | 'datetime' | 'time' | 'money' | 'int' | 'bool' | 'choice' | 'list' | 'rows';
export type FillPolicy = 'auto' | 'auto-if-known' | 'suggest' | 'handler' | 'post-event' | 'signature' | 'never';
export type FormatName =
  | 'auto'
  | 'date-boxes'
  | 'date-compact'
  | 'date-long'
  | 'datetime-boxes'
  | 'datetime-compact'
  | 'time'
  | 'month-year-boxes'
  | 'money'
  | 'money-digits'
  | 'reg'
  | 'upper'
  | 'title'
  | 'ordinal'
  | 'miles'
  | 'int'
  | 'lines'
  | 'inline';
export type VerificationStatus = 'verified' | 'unverified' | 'failed' | 'stale';
export type SubjectKind = 'witness' | 'offer' | 'hire' | 'recipient';
export type DocxTemplateSource = 'builtin' | 'uploaded';
export type DocxTemplateKind = 'letter' | 'form' | 'agreement' | 'statement' | 'report' | 'notice';

export interface SlotSelector {
  id?: string;
  section?: string;
  qualifier?: string;
  label?: string;
  kind?: SlotKind;
  nth?: number;
  part?: 'header' | 'footer' | 'body';
}

/** One mapping entry. The web always writes `slot` as the exact slot id (PUT /docx-templates/:id/mapping). */
export interface MappingEntry {
  slot: SlotSelector | string;
  key?: string;
  policy?: FillPolicy;
  format?: FormatName;
  when?: string;
  onlyIf?: { key: string; equals?: string | boolean };
  required?: boolean;
  requiredBeforeSigning?: boolean;
  removeIfEmpty?: 'paragraph' | 'row';
  variants?: string[];
  label?: string;
  group?: string;
  note?: string;
}

export interface MappingIssue {
  code: 'SELECTOR_NO_MATCH' | 'SELECTOR_AMBIGUOUS' | 'UNKNOWN_KEY' | 'KIND_MISMATCH' | 'POLICY_LAXER' | 'DUPLICATE_SLOT';
  entry: number;
  detail: string;
}

export interface TemplateWarning {
  code: 'LEGACY_DETAIL' | 'BANNED_PHRASE' | 'REGULATED_STATUS' | 'BRAND_CLAIM_IMAGE' | 'TRACKED_CHANGES' | 'COMMENTS' | 'LEGACY_FORM_FIELDS' | 'EXTERNAL_IMAGE' | 'EMBEDDED_OBJECT' | 'UNMAPPED_SLOTS' | 'SYNC_FAILED' | (string & {});
  message: string;
  excerpt?: string;
}

// ---------------------------------------------------------------------------
// Template library responses (§C.5)
// ---------------------------------------------------------------------------

export interface DocxTemplateVariant {
  id: string;
  label: string;
  default?: boolean;
}

export interface DocxTemplateSummary {
  id: string;
  format: 'docx';
  source: DocxTemplateSource;
  kind: string;
  title: string;
  description?: string;
  recipientRole?: string;
  fileName: string;
  fileVersion: number;
  mappingRevision: number;
  sha256: string;
  bytes: number;
  slotCount: number;
  mappedCount: number;
  ignoredCount: number;
  unmappedCount: number;
  warnings: TemplateWarning[];
  warningsAcknowledged: boolean;
  active: boolean;
  subjects: SubjectKind[];
  variants: DocxTemplateVariant[];
  updatedAt: string;
}

export type MappingOrigin = 'builtin' | 'saved' | 'suggested' | 'none';

export interface DocxTemplateMappingRow {
  slotId: string;
  key?: string;
  policy: FillPolicy;
  format?: FormatName;
  when?: string;
  required?: boolean;
  removeIfEmpty?: 'paragraph' | 'row';
  label?: string;
  origin: MappingOrigin;
  score?: number;
  ignored: boolean;
}

export interface DocxFieldDef {
  key: string;
  group: string;
  label: string;
  type: FieldType;
  policy: FillPolicy;
}

export interface DocxTemplateDetail extends DocxTemplateSummary {
  slots: DocxSlot[];
  blocks: DocxBlock[];
  outline: DocxOutlineItem[];
  mapping: DocxTemplateMappingRow[];
  mappingIssues: MappingIssue[];
  fields: DocxFieldDef[];
  /** POST /docx-templates/:id/file only: slot ids whose mapping survived the new version, and those that did not. */
  carriedOver?: string[];
  dropped?: string[];
}

export interface SaveMappingBody {
  entries: MappingEntry[];
  ignore?: string[];
}

export interface PatchDocxTemplateBody {
  title?: string;
  description?: string;
  active?: boolean;
  recipientRole?: string | null;
}

export interface UploadDocxTemplateFields {
  file: Blob;
  fileName?: string;
  title: string;
  kind: DocxTemplateKind | string;
  description?: string;
  recipientRole?: string;
}

// ---------------------------------------------------------------------------
// Values and generation (§B.9, §C.5)
// ---------------------------------------------------------------------------

/** Handler input for one slot: ISO date/datetime, pence, boolean, option slugs, rows, list items; null = leave blank. */
export type SlotInput = string | number | boolean | string[] | Array<Record<string, string>> | null;

export type PlanInputType = 'text' | 'multiline' | 'date' | 'datetime' | 'time' | 'money' | 'int' | 'checkbox' | 'choice' | 'rows' | 'paragraphs';
export type PlanOrigin = 'claim' | 'settings' | 'derived' | 'suggested' | 'handler' | 'none';

export interface PlanRow {
  slotId: string;
  section: string;
  sectionTitle: string;
  label: string;
  kind: SlotKind;
  inputType: PlanInputType;
  options?: Array<{ value: string; label: string }>;
  multiple?: boolean;
  columns?: Array<{ id: string; label: string }>;
  key?: string;
  policy: FillPolicy;
  editable: boolean;
  value: SlotInput;
  display: string;
  origin: PlanOrigin;
  sourcePath?: string;
  verification?: VerificationStatus;
  needsConfirmation: boolean;
  confirmed: boolean;
  required: boolean;
  missing: boolean;
  note?: string;
  widthTwips?: number;
  preview: string;
}

export interface FillPlanIssue {
  code: string;
  severity: 'block' | 'warn';
  message: string;
  slotId?: string;
}

export interface DocxSubject {
  witnessPartyId?: string;
  offerId?: string;
  hireAgreementId?: string;
  recipientPartyId?: string;
  exhibitEvidenceIds?: string[];
}

export interface ClaimTemplateValues {
  template: DocxTemplateSummary;
  claimId: string;
  variant?: string;
  subjects: {
    witnesses?: Array<{ id: string; name: string }>;
    offers?: Array<{ id: string; label: string }>;
    hires?: Array<{ id: string; label: string }>;
    recipients?: Array<{ partyId?: string; role: string; label: string }>;
    exhibits?: Array<{ id: string; label: string }>;
  };
  groups: Array<{ section: string; title: string; rows: PlanRow[] }>;
  issues: FillPlanIssue[];
  summary: { fromClaim: number; toConfirm: number; toEnter: number; leftForSigning: number; leftAsPrinted: number };
}

export interface GenerateDocxBody {
  templateId: string;
  variant?: string;
  subject?: DocxSubject;
  values?: Record<string, SlotInput>;
  confirm?: string[];
}

/** The reproducibility record a DOCX document keeps in `dataSnapshot._docx` (§C.3). */
export interface DocxSnapshot {
  templateId: string;
  templateSha256: string;
  fileVersion: number;
  mappingRevision: number;
  scannerVersion: number;
  variant?: string;
  subject?: DocxSubject;
  inputs: Record<string, SlotInput>;
  confirm: string[];
  /** `label`: the row's label as shown in the values form (additive; older snapshots have none). */
  values: Array<{ slotId: string; key?: string; label?: string; display: string; origin: PlanOrigin; verification?: VerificationStatus }>;
  removedBlocks: string[];
  docxSha256: string;
}

// ---------------------------------------------------------------------------
// Converters (§A.11.1)
// ---------------------------------------------------------------------------

export type DocxConverterId = 'word' | 'libreoffice' | 'browser';
export type DocxConverterPreference = 'auto' | DocxConverterId;

export interface ConverterStatus {
  ok: boolean;
  detail?: string;
  path?: string;
}

export interface DocxConvertersResponse {
  preference: DocxConverterPreference;
  order: DocxConverterId[];
  available: Record<DocxConverterId, ConverterStatus>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Stable cache key for the subject selection (order-independent for exhibits; empty parts dropped). */
export function subjectKey(subject: DocxSubject | undefined): string {
  if (!subject) return '';
  const parts: string[] = [];
  if (subject.witnessPartyId) parts.push(`w:${subject.witnessPartyId}`);
  if (subject.offerId) parts.push(`o:${subject.offerId}`);
  if (subject.hireAgreementId) parts.push(`h:${subject.hireAgreementId}`);
  if (subject.recipientPartyId) parts.push(`r:${subject.recipientPartyId}`);
  if (subject.exhibitEvidenceIds && subject.exhibitEvidenceIds.length) parts.push(`e:${[...subject.exhibitEvidenceIds].sort().join(',')}`);
  return parts.join('|');
}

/** The subject with empty parts removed; undefined when nothing is selected. */
export function cleanSubject(subject: DocxSubject | undefined): DocxSubject | undefined {
  if (!subject) return undefined;
  const out: DocxSubject = {};
  if (subject.witnessPartyId) out.witnessPartyId = subject.witnessPartyId;
  if (subject.offerId) out.offerId = subject.offerId;
  if (subject.hireAgreementId) out.hireAgreementId = subject.hireAgreementId;
  if (subject.recipientPartyId) out.recipientPartyId = subject.recipientPartyId;
  if (subject.exhibitEvidenceIds && subject.exhibitEvidenceIds.length) out.exhibitEvidenceIds = [...subject.exhibitEvidenceIds];
  return Object.keys(out).length ? out : undefined;
}

/** Query string for GET /claims/:id/docx-templates/:templateId/values. */
export function valuesQuery(variant: string | undefined, subject: DocxSubject | undefined): Record<string, string | undefined> {
  const s = cleanSubject(subject);
  return {
    variant: variant || undefined,
    witnessPartyId: s?.witnessPartyId,
    offerId: s?.offerId,
    hireAgreementId: s?.hireAgreementId,
    recipientPartyId: s?.recipientPartyId,
    exhibitEvidenceIds: s?.exhibitEvidenceIds?.join(',')
  };
}

export function buildUploadFormData(fields: UploadDocxTemplateFields): FormData {
  const fd = new FormData();
  // text parts first: multipart parsers that stream the file can then read the fields without buffering it
  fd.append('title', fields.title.trim());
  fd.append('kind', fields.kind);
  if (fields.description?.trim()) fd.append('description', fields.description.trim());
  if (fields.recipientRole) fd.append('recipientRole', fields.recipientRole);
  fd.append('file', fields.file, fields.fileName ?? (fields.file as File).name ?? 'template.docx');
  return fd;
}

// ---------------------------------------------------------------------------
// Transport for binary responses
// ---------------------------------------------------------------------------

async function errorFrom(res: Response, url: string): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* plain text body */
  }
  const err = (body as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
  if (err && typeof err.message === 'string') return new ApiError(res.status, err.code ?? `HTTP_${res.status}`, err.message, url, err.details);
  return new ApiError(res.status, `HTTP_${res.status}`, typeof body === 'string' && body ? body.slice(0, 300) : `${res.status} ${res.statusText || 'request failed'}`, url, body);
}

/** GET/POST returning a file. Same-origin cookies; a JSON error body becomes an `ApiError` like `request()`. */
export async function fetchBinary(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {}): Promise<{ blob: Blob; fileName?: string; sha256?: string }> {
  const url = buildUrl(path);
  const headers: Record<string, string> = { Accept: '*/*' };
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, signal: init.signal, credentials: 'same-origin' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', `Cannot reach the ClaimDesk API (${(e as Error).message})`, url);
  }
  if (!res.ok) throw await errorFrom(res, url);
  return { blob: await res.blob(), fileName: fileNameFromDisposition(res.headers.get('content-disposition')), sha256: res.headers.get('x-sha256') ?? undefined };
}

/** `attachment; filename="CCG-2026-00012 Witness Statement.docx"` (or RFC 5987 `filename*=UTF-8''…`) → the name. */
export function fileNameFromDisposition(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain parameter */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  const name = plain?.[2] ?? plain?.[1];
  return name ? name.trim().replace(/^"|"$/g, '') : undefined;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const templatesApi = {
  listDocxTemplates: async (opts: { includeInactive?: boolean } = {}, signal?: AbortSignal) =>
    asList<DocxTemplateSummary>(await request<unknown>('/docx-templates', { method: 'GET', query: { includeInactive: opts.includeInactive ? 'true' : undefined }, signal })),
  uploadDocxTemplate: (fields: UploadDocxTemplateFields) => request<DocxTemplateDetail>('/docx-templates', { method: 'POST', formData: buildUploadFormData(fields) }),
  getDocxTemplate: (id: string, signal?: AbortSignal) => request<DocxTemplateDetail>(`/docx-templates/${seg(id)}`, { method: 'GET', signal }),
  patchDocxTemplate: (id: string, body: PatchDocxTemplateBody) => request<DocxTemplateSummary>(`/docx-templates/${seg(id)}`, { method: 'PATCH', body }),
  acknowledgeDocxTemplate: (id: string) => request<DocxTemplateSummary>(`/docx-templates/${seg(id)}/acknowledge`, { method: 'POST', body: {} }),
  saveDocxMapping: (id: string, body: SaveMappingBody) => request<DocxTemplateDetail>(`/docx-templates/${seg(id)}/mapping`, { method: 'PUT', body }),
  resetDocxMapping: (id: string) => request<DocxTemplateDetail>(`/docx-templates/${seg(id)}/mapping`, { method: 'DELETE' }),
  replaceDocxTemplateFile: (id: string, file: Blob, fileName?: string) => {
    const fd = new FormData();
    fd.append('file', file, fileName ?? (file as File).name ?? 'template.docx');
    return request<DocxTemplateDetail>(`/docx-templates/${seg(id)}/file`, { method: 'POST', formData: fd });
  },
  /** POST /docx-templates/:id/test-fill → a filled .docx that is not stored (sample data when no claim). */
  testFillDocxTemplate: (id: string, body: { claimId?: string; variant?: string } = {}) => fetchBinary(`/docx-templates/${seg(id)}/test-fill`, { method: 'POST', body }),
  getClaimTemplateValues: (claimId: Id, templateId: string, variant?: string, subject?: DocxSubject, signal?: AbortSignal) =>
    request<ClaimTemplateValues>(`/claims/${seg(claimId)}/docx-templates/${seg(templateId)}/values`, { method: 'GET', query: valuesQuery(variant, subject), signal }),
  generateDocxDocument: (claimId: Id, body: GenerateDocxBody) => request<ClaimDocument>(`/claims/${seg(claimId)}/docx-documents`, { method: 'POST', body }),
  getDocxConverters: (refresh = false, signal?: AbortSignal) => request<DocxConvertersResponse>('/docx-converters', { method: 'GET', query: { refresh: refresh ? 'true' : undefined }, signal }),
  /** The stored .docx as bytes (for the in-app preview). */
  fetchDocumentDocx: async (docId: Id, signal?: AbortSignal): Promise<ArrayBuffer> => (await fetchBinary(`/documents/${seg(docId)}/docx`, { signal })).blob.arrayBuffer(),
  documentDocxUrl: (docId: Id) => buildUrl(`/documents/${seg(docId)}/docx`),
  documentLetterheadDocxUrl: (docId: Id) => buildUrl(`/documents/${seg(docId)}/letterhead.docx`),
  docxTemplateFileUrl: (id: string) => buildUrl(`/docx-templates/${seg(id)}/file`)
};

// ---------------------------------------------------------------------------
// React Query
// ---------------------------------------------------------------------------

export const docxKeys = {
  templates: ['docx-templates'] as const,
  template: (id: string) => ['docx-template', id] as const,
  values: (claimId: Id, templateId: string, variant: string | undefined, subject: string) => ['docx-values', claimId, templateId, variant ?? '', subject] as const,
  converters: ['docx-converters'] as const
};

type QueryOpts<T> = Omit<UseQueryOptions<T, Error>, 'queryKey' | 'queryFn'>;

/** Every template (inactive ones too: the settings screen toggles them; the fill dialog filters). */
export function useDocxTemplates(opts: QueryOpts<DocxTemplateSummary[]> = {}) {
  return useQuery({ queryKey: docxKeys.templates, queryFn: ({ signal }) => templatesApi.listDocxTemplates({ includeInactive: true }, signal), staleTime: 60_000, ...opts });
}

export function useDocxTemplate(id: string | undefined) {
  return useQuery({ queryKey: docxKeys.template(id ?? ''), queryFn: ({ signal }) => templatesApi.getDocxTemplate(id!, signal), enabled: Boolean(id) });
}

/** Options shared by the hook and tests so the cache key cannot drift. */
export function docxValuesQueryOptions(claimId: Id, templateId: string, variant: string | undefined, subject: DocxSubject | undefined) {
  return {
    queryKey: docxKeys.values(claimId, templateId, variant, subjectKey(subject)),
    queryFn: ({ signal }: { signal?: AbortSignal }) => templatesApi.getClaimTemplateValues(claimId, templateId, variant, cleanSubject(subject), signal)
  };
}

export function useDocxValues(claimId: Id, templateId: string | undefined, variant: string | undefined, subject: DocxSubject | undefined, opts: { enabled?: boolean } = {}) {
  // fresh for 30 s so moving from "Choose" to "Check the values" does not read the claim twice; "Refresh from claim" re-reads
  return useQuery({ ...docxValuesQueryOptions(claimId, templateId ?? '', variant, subject), enabled: Boolean(templateId) && (opts.enabled ?? true), staleTime: 30_000, refetchOnWindowFocus: false });
}

export function useDocxConverters() {
  return useQuery({ queryKey: docxKeys.converters, queryFn: ({ signal }) => templatesApi.getDocxConverters(false, signal), staleTime: 5 * 60_000 });
}

/** GET /docx-converters?refresh=true (detects Word and LibreOffice again) and stores the answer under the same key. */
export function useRefreshDocxConverters() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => templatesApi.getDocxConverters(true), onSuccess: (res) => qc.setQueryData(docxKeys.converters, res) });
}

function useInvalidateTemplate() {
  const qc = useQueryClient();
  return (id?: string) => {
    void qc.invalidateQueries({ queryKey: docxKeys.templates });
    if (id) void qc.invalidateQueries({ queryKey: docxKeys.template(id) });
    void qc.invalidateQueries({ queryKey: ['docx-values'] });
  };
}

export function useUploadDocxTemplate() {
  const invalidate = useInvalidateTemplate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fields: UploadDocxTemplateFields) => templatesApi.uploadDocxTemplate(fields),
    onSuccess: (detail) => {
      qc.setQueryData(docxKeys.template(detail.id), detail);
      invalidate();
    }
  });
}

export function usePatchDocxTemplate(id: string) {
  const invalidate = useInvalidateTemplate();
  return useMutation({ mutationFn: (body: PatchDocxTemplateBody) => templatesApi.patchDocxTemplate(id, body), onSuccess: () => invalidate(id) });
}

/** PATCH for any row of the list (the Active toggle). */
export function useSetDocxTemplateActive() {
  const invalidate = useInvalidateTemplate();
  return useMutation({ mutationFn: ({ id, active }: { id: string; active: boolean }) => templatesApi.patchDocxTemplate(id, { active }), onSuccess: (_d, v) => invalidate(v.id) });
}

export function useAcknowledgeDocxTemplate(id: string) {
  const invalidate = useInvalidateTemplate();
  return useMutation({ mutationFn: () => templatesApi.acknowledgeDocxTemplate(id), onSuccess: () => invalidate(id) });
}

export function useSaveDocxMapping(id: string) {
  const invalidate = useInvalidateTemplate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveMappingBody) => templatesApi.saveDocxMapping(id, body),
    onSuccess: (detail) => {
      qc.setQueryData(docxKeys.template(id), detail);
      invalidate(id);
    }
  });
}

export function useResetDocxMapping(id: string) {
  const invalidate = useInvalidateTemplate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => templatesApi.resetDocxMapping(id),
    onSuccess: (detail) => {
      qc.setQueryData(docxKeys.template(id), detail);
      invalidate(id);
    }
  });
}

export function useReplaceDocxTemplateFile(id: string) {
  const invalidate = useInvalidateTemplate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, fileName }: { file: Blob; fileName?: string }) => templatesApi.replaceDocxTemplateFile(id, file, fileName),
    onSuccess: (detail) => {
      qc.setQueryData(docxKeys.template(id), detail);
      invalidate(id);
    }
  });
}

export function useTestFillDocxTemplate(id: string) {
  return useMutation({ mutationFn: (body: { claimId?: string; variant?: string }) => templatesApi.testFillDocxTemplate(id, body) });
}

/** POST /claims/:id/docx-documents; then the claim's documents (bundle, lists, dashboard) are re-read. */
export function useGenerateDocxDocument(claimId: Id) {
  const invalidateClaim = useInvalidateClaim();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GenerateDocxBody) => templatesApi.generateDocxDocument(claimId, body),
    onSuccess: (doc) => {
      qc.setQueryData(qk.document(doc.id), doc);
      void qc.invalidateQueries({ queryKey: ['docx-values', claimId] });
      invalidateClaim(claimId);
    }
  });
}

/** Save a Blob as a file through a temporary object URL (browser only). */
export function saveBlob(blob: Blob, fileName: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
