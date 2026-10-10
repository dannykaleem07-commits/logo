// owned by knowledge-ui
/**
 * Knowledge Builder client (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.3, §11). Every route of the four knowledge slices:
 * core (`routes/knowledge.ts`), learners (`routes/knowledgeLearning.ts`), research (`routes/knowledgeResearch.ts`) and
 * use (`routes/knowledgeUse.ts`). Shapes come from @ccguk/domain (knowledge/api.ts); the few response wrappers the
 * domain does not name (`{ insurers }`, `{ gaps, total }`, the gap timeline) are declared here. Web code never imports
 * API code.
 *
 * Routes a slice has not built yet answer 404: screens treat that as "not available yet" (`isNotBuilt`), never as an
 * error the owner must act on.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ActivateVersionBody,
  ApproveKnowledgeBody,
  ConflictsResponse,
  CorrectionClusterView,
  EditApproveKnowledgeBody,
  EvalRunView,
  ExportVersionResponse,
  GapKind,
  GapStatus,
  InsurerLink,
  InsurerProfileListRow,
  InsurerProfileView,
  KnowledgeAlarmView,
  KnowledgeArea,
  KnowledgeChange,
  KnowledgeCheck,
  KnowledgeConflict,
  KnowledgeDigest,
  KnowledgeGapView,
  KnowledgeItemDetail,
  KnowledgeItemMutationResponse,
  KnowledgeItemsQuery,
  KnowledgeItemsResponse,
  KnowledgeItemView,
  KnowledgePackVersion,
  KnowledgeQueueResponse,
  KnowledgeScope,
  KnowledgeSearchResponse,
  KnowledgeSettings,
  KnowledgeSettingsPatch,
  KnowledgeStatusResponse,
  KnowledgeUsedResponse,
  KnowledgeVersionDiff,
  KnowledgeVersionsResponse,
  KnowledgeWeekDigest,
  OwnerKnowledgeBody,
  RecordCheckBody,
  ReplayBody,
  ResolveConflictBody,
  SnapshotView,
  SourceView,
} from '@ccguk/domain';
import { isApiError, request, seg } from './client';

// ---------------------------------------------------------------------------
// Response wrappers the domain does not name
// ---------------------------------------------------------------------------

export interface GapTimelineChange {
  id: string;
  at: string;
  actor: string;
  action: string;
  reason: string | null;
  runId: string | null;
  jobId: string | null;
  needsYouId: string | null;
  after: unknown;
}
export interface GapTimelineRun {
  id: string;
  jobType: string;
  outcome: string | null;
  startedAt: string;
  endedAt: string | null;
  model: string | null;
}
export interface GapDetailResponse {
  gap: KnowledgeGapView;
  changes: GapTimelineChange[];
  runs: GapTimelineRun[];
  answers: KnowledgeItemView[];
  snapshots: SnapshotView[];
  lastSummary: string | null;
  ownerQuestion: string | null;
}
export interface SourcesResponse {
  sources: SourceView[];
  fclTransactionalLicence?: KnowledgeSettings['fclTransactionalLicence'];
}
export type SnapshotDiffOp = { op: 'eq' | 'ins' | 'del'; text: string };
export interface SnapshotDiffResponse {
  from: SnapshotView | null;
  to: SnapshotView;
  diff: SnapshotDiffOp[] | null;
  note?: string;
}
export interface ActivateVersionResponse {
  version: KnowledgePackVersion;
  retired: number | string[];
  reactivated: number | string[];
  skipped: unknown;
}
export interface UnlinkedParty {
  partyId: string;
  name: string;
  claims: number;
}
export interface InsurerLinksResponse {
  parties: UnlinkedParty[];
  links?: InsurerLink[];
}
export interface NewGapBody {
  kind: GapKind;
  question: string;
  scope?: KnowledgeScope;
  area?: KnowledgeArea;
  blocking?: boolean;
}
export interface NewSourceBody {
  domain: string;
  policy: 'code_fetch' | 'link_only' | 'deny';
  licence: string;
  note?: string;
  extractAllowed?: boolean;
}
export interface ChangesQuery {
  since?: string;
  until?: string;
  actor?: string;
  action?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body });

export const knowledgeApi = {
  // ----- core -----
  status: () => request<KnowledgeStatusResponse>('/knowledge/status'),
  items: (query: KnowledgeItemsQuery = {}) => request<KnowledgeItemsResponse>('/knowledge/items', { query: { ...query } }),
  item: (id: string) => request<KnowledgeItemDetail>(`/knowledge/items/${seg(id)}`),
  queue: () => request<KnowledgeQueueResponse>('/knowledge/queue'),
  approve: (id: string, body: ApproveKnowledgeBody = {}) => post<KnowledgeItemMutationResponse>(`/knowledge/items/${seg(id)}/approve`, body),
  editApprove: (id: string, body: EditApproveKnowledgeBody) => post<KnowledgeItemMutationResponse>(`/knowledge/items/${seg(id)}/edit-approve`, body),
  reject: (id: string, reason: string) => post<KnowledgeItemMutationResponse>(`/knowledge/items/${seg(id)}/reject`, { reason }),
  retire: (id: string, reason: string) => post<KnowledgeItemMutationResponse>(`/knowledge/items/${seg(id)}/retire`, { reason }),
  check: (id: string, body: RecordCheckBody) => post<{ item: KnowledgeItemView | null; check: KnowledgeCheck }>(`/knowledge/items/${seg(id)}/check`, body),
  addItem: (body: OwnerKnowledgeBody & { note?: string }) => post<KnowledgeItemMutationResponse>('/knowledge/items', body),
  kbCheck: (entryId: string, body: RecordCheckBody) => post<{ check: KnowledgeCheck }>(`/knowledge/kb/${seg(entryId)}/check`, body),
  versions: () => request<KnowledgeVersionsResponse>('/knowledge/versions'),
  versionDiff: (v: number, against?: number) => request<KnowledgeVersionDiff>(`/knowledge/versions/${seg(v)}/diff`, { query: { against } }),
  activateVersion: (v: number, body: ActivateVersionBody) => post<ActivateVersionResponse>(`/knowledge/versions/${seg(v)}/activate`, body),
  exportVersion: (v: number) => post<ExportVersionResponse>(`/knowledge/versions/${seg(v)}/export`),
  conflicts: (status: 'open' | 'resolved' | 'dismissed' | 'all' = 'open') => request<ConflictsResponse>('/knowledge/conflicts', { query: { status } }),
  resolveConflict: (id: string, body: ResolveConflictBody) => post<{ conflict: KnowledgeConflict }>(`/knowledge/conflicts/${seg(id)}/resolve`, body),
  changes: (q: ChangesQuery = {}) => request<{ changes: KnowledgeChange[] }>('/knowledge/changes', { query: { ...q } }),
  digest: (day?: string) => request<KnowledgeDigest>('/knowledge/digest', { query: { day } }),
  week: (end?: string) => request<KnowledgeWeekDigest>('/knowledge/digest/week', { query: { end } }),
  settings: () => request<KnowledgeSettings>('/knowledge/settings'),
  patchSettings: (patch: KnowledgeSettingsPatch) => request<KnowledgeSettings>('/knowledge/settings', { method: 'PATCH', body: patch }),
  pauseLearning: (reason?: string) => post<KnowledgeSettings>('/knowledge/learning/pause', reason ? { reason } : {}),
  resumeLearning: (reason?: string) => post<KnowledgeSettings>('/knowledge/learning/resume', reason ? { reason } : {}),
  setInsurerLink: (partyId: string, insurerSlug: string) => request<{ link: InsurerLink }>(`/knowledge/insurer-links/${seg(partyId)}`, { method: 'PUT', body: { insurerSlug } }),
  /** The daily log's Undo: retire through the digest line's `undoRoute` (an `/api/knowledge/items/:id/retire` path). */
  undo: (undoRoute: string, reason = 'Undo from the daily log') => post<KnowledgeItemMutationResponse>(undoRoute.replace(/^\/api(?=\/)/, ''), { reason }),

  // ----- learners -----
  insurers: () => request<{ insurers: InsurerProfileListRow[] }>('/knowledge/insurers'),
  insurer: (slug: string) => request<InsurerProfileView>(`/knowledge/insurers/${seg(slug)}`),
  insurerLinks: (unlinked = false) => request<InsurerLinksResponse>('/knowledge/insurer-links', { query: { unlinked: unlinked ? '1' : undefined } }),
  correctionClusters: () => request<{ clusters: CorrectionClusterView[] }>('/knowledge/corrections/clusters'),
  learnRun: (learner: 'observe' | 'consolidate' | 'learn_stats' | 'curate') => post<{ jobId: string; learner: string; status: string }>('/knowledge/learn/run', { learner }),

  // ----- research -----
  gaps: (q: { status?: GapStatus | ''; kind?: GapKind | ''; limit?: number } = {}) => request<{ gaps: KnowledgeGapView[]; total: number }>('/knowledge/gaps', { query: { status: q.status || undefined, kind: q.kind || undefined, limit: q.limit } }),
  gap: (id: string) => request<GapDetailResponse>(`/knowledge/gaps/${seg(id)}`),
  addGap: (body: NewGapBody) => post<{ gap: KnowledgeGapView; status: string }>('/knowledge/gaps', body),
  researchNow: (id: string) => post<{ gap: KnowledgeGapView; jobId: string }>(`/knowledge/gaps/${seg(id)}/research-now`),
  dismissGap: (id: string, reason: string) => post<{ gap: KnowledgeGapView }>(`/knowledge/gaps/${seg(id)}/dismiss`, { reason }),
  sources: () => request<SourcesResponse>('/knowledge/sources'),
  addSource: (body: NewSourceBody) => post<{ source: SourceView }>('/knowledge/sources', body),
  toggleSource: (domain: string, enabled: boolean, reason?: string) => request<{ source: SourceView }>(`/knowledge/sources/${seg(domain)}`, { method: 'PATCH', body: { enabled, ...(reason ? { reason } : {}) } }),
  fetchNow: (domain: string, url: string) => post<{ jobId: string; status: string }>(`/knowledge/sources/${seg(domain)}/fetch-now`, { url }),
  selftest: () => post<{ jobId: string; status: string }>('/knowledge/sources/selftest'),
  snapshots: (q: { url?: string; domain?: string; gapId?: string; limit?: number } = {}) => request<{ snapshots: SnapshotView[] }>('/knowledge/snapshots', { query: { ...q } }),
  snapshot: (id: string) => request<{ snapshot: SnapshotView }>(`/knowledge/snapshots/${seg(id)}`),
  snapshotDiff: (id: string, against?: string) => request<SnapshotDiffResponse>(`/knowledge/snapshots/${seg(id)}/diff`, { query: { against } }),

  // ----- use -----
  search: (q: { q: string; claimId?: string; agent?: string }) => request<KnowledgeSearchResponse>('/knowledge/search', { query: { ...q } }),
  used: (targetKind: KnowledgeUsedResponse['targetKind'], targetId: string) => request<KnowledgeUsedResponse>('/knowledge/used', { query: { targetKind, targetId } }),
  evalRuns: (q: { itemId?: string; mode?: EvalRunView['mode'] } = {}) => request<{ runs: EvalRunView[] }>('/knowledge/evals/runs', { query: { ...q } }),
  evalRun: (id: string) => request<{ run: EvalRunView } | EvalRunView>(`/knowledge/evals/runs/${seg(id)}`),
  replay: (body: ReplayBody) => post<{ jobId?: string; runId?: string }>('/knowledge/evals/replay', body),
  alarms: (status?: 'open' | 'acknowledged' | 'resolved' | 'all') => request<{ alarms: KnowledgeAlarmView[] }>('/knowledge/alarms', { query: { status } }),
  ackAlarm: (id: string) => post<{ alarm: KnowledgeAlarmView }>(`/knowledge/alarms/${seg(id)}/ack`),
};

/** A route the owning slice has not built yet (404 / 501): screens show "not available yet". */
export function isNotBuilt(e: unknown): boolean {
  if (!isApiError(e)) return false;
  if (e.status === 501) return true;
  // The API's not-found handler says "Route GET /api/… not found"; a missing record says "<entity> <id> not found".
  return e.status === 404 && /^Route [A-Z]+ /.test(e.message ?? '');
}

/** Runs list tolerant of `{ runs }` or a bare array. */
export function runsOf(res: unknown): EvalRunView[] {
  if (Array.isArray(res)) return res as EvalRunView[];
  const r = (res as { runs?: unknown } | null)?.runs;
  return Array.isArray(r) ? (r as EvalRunView[]) : [];
}

// ---------------------------------------------------------------------------
// Query keys and hooks
// ---------------------------------------------------------------------------

export const knowledgeQk = {
  all: ['knowledge'] as const,
  status: ['knowledge', 'status'] as const,
  items: (q: KnowledgeItemsQuery) => ['knowledge', 'items', q] as const,
  item: (id: string) => ['knowledge', 'item', id] as const,
  queue: ['knowledge', 'queue'] as const,
  versions: ['knowledge', 'versions'] as const,
  versionDiff: (v: number, against?: number) => ['knowledge', 'versions', v, 'diff', against ?? null] as const,
  conflicts: (status: string) => ['knowledge', 'conflicts', status] as const,
  changes: (q: ChangesQuery) => ['knowledge', 'changes', q] as const,
  digest: (day: string) => ['knowledge', 'digest', day] as const,
  week: (end: string) => ['knowledge', 'week', end] as const,
  settings: ['knowledge', 'settings'] as const,
  insurers: ['knowledge', 'insurers'] as const,
  insurer: (slug: string) => ['knowledge', 'insurer', slug] as const,
  insurerLinks: (unlinked: boolean) => ['knowledge', 'insurer-links', unlinked] as const,
  gaps: (status: string, kind: string) => ['knowledge', 'gaps', status, kind] as const,
  gap: (id: string) => ['knowledge', 'gap', id] as const,
  sources: ['knowledge', 'sources'] as const,
  snapshots: (domain: string) => ['knowledge', 'snapshots', domain] as const,
  snapshot: (id: string) => ['knowledge', 'snapshot', id] as const,
  snapshotDiff: (id: string) => ['knowledge', 'snapshot', id, 'diff'] as const,
  search: (q: string, claimId: string, agent: string) => ['knowledge', 'search', q, claimId, agent] as const,
  used: (kind: string, id: string) => ['knowledge', 'used', kind, id] as const,
  evalRuns: ['knowledge', 'evals', 'runs'] as const,
  evalRunsForItem: (itemId: string) => ['knowledge', 'evals', 'runs', 'item', itemId] as const,
  alarms: (status: string) => ['knowledge', 'alarms', status] as const,
};

/** Polling for the screen's counters (the agents keep learning while it is open). */
export const KNOWLEDGE_POLL_MS = 30_000;

const quiet = { retry: false as const };

export const useKnowledgeStatus = () => useQuery({ queryKey: knowledgeQk.status, queryFn: knowledgeApi.status, refetchInterval: KNOWLEDGE_POLL_MS, ...quiet });
export const useKnowledgeItems = (q: KnowledgeItemsQuery) => useQuery({ queryKey: knowledgeQk.items(q), queryFn: () => knowledgeApi.items(q), ...quiet });
export const useKnowledgeItem = (id: string | undefined) => useQuery({ queryKey: knowledgeQk.item(id ?? ''), queryFn: () => knowledgeApi.item(id!), enabled: Boolean(id), ...quiet });
export const useKnowledgeQueue = () => useQuery({ queryKey: knowledgeQk.queue, queryFn: knowledgeApi.queue, refetchInterval: KNOWLEDGE_POLL_MS, ...quiet });
export const useKnowledgeVersions = () => useQuery({ queryKey: knowledgeQk.versions, queryFn: knowledgeApi.versions, ...quiet });
export const useKnowledgeVersionDiff = (v: number | undefined, against?: number) => useQuery({ queryKey: knowledgeQk.versionDiff(v ?? 0, against), queryFn: () => knowledgeApi.versionDiff(v!, against), enabled: Boolean(v), ...quiet });
export const useKnowledgeConflicts = (status: 'open' | 'resolved' | 'dismissed' | 'all' = 'open') => useQuery({ queryKey: knowledgeQk.conflicts(status), queryFn: () => knowledgeApi.conflicts(status), ...quiet });
export const useKnowledgeChanges = (q: ChangesQuery) => useQuery({ queryKey: knowledgeQk.changes(q), queryFn: () => knowledgeApi.changes(q), ...quiet });
export const useKnowledgeDigest = (day: string) => useQuery({ queryKey: knowledgeQk.digest(day), queryFn: () => knowledgeApi.digest(day), ...quiet });
export const useKnowledgeWeek = (end: string) => useQuery({ queryKey: knowledgeQk.week(end), queryFn: () => knowledgeApi.week(end), ...quiet });
export const useKnowledgeSettings = () => useQuery({ queryKey: knowledgeQk.settings, queryFn: knowledgeApi.settings, ...quiet });
export const useInsurerProfiles = () => useQuery({ queryKey: knowledgeQk.insurers, queryFn: knowledgeApi.insurers, ...quiet });
export const useInsurerProfile = (slug: string | undefined) => useQuery({ queryKey: knowledgeQk.insurer(slug ?? ''), queryFn: () => knowledgeApi.insurer(slug!), enabled: Boolean(slug), ...quiet });
export const useInsurerLinks = (unlinked = false) => useQuery({ queryKey: knowledgeQk.insurerLinks(unlinked), queryFn: () => knowledgeApi.insurerLinks(unlinked), ...quiet });
export const useKnowledgeGaps = (status: GapStatus | '', kind: GapKind | '') => useQuery({ queryKey: knowledgeQk.gaps(status, kind), queryFn: () => knowledgeApi.gaps({ status, kind }), ...quiet });
export const useKnowledgeGap = (id: string | undefined) => useQuery({ queryKey: knowledgeQk.gap(id ?? ''), queryFn: () => knowledgeApi.gap(id!), enabled: Boolean(id), ...quiet });
export const useKnowledgeSources = () => useQuery({ queryKey: knowledgeQk.sources, queryFn: knowledgeApi.sources, ...quiet });
export const useKnowledgeSnapshots = (domain: string | undefined) => useQuery({ queryKey: knowledgeQk.snapshots(domain ?? ''), queryFn: () => knowledgeApi.snapshots({ domain, limit: 50 }), enabled: Boolean(domain), ...quiet });
export const useKnowledgeSnapshot = (id: string | undefined) => useQuery({ queryKey: knowledgeQk.snapshot(id ?? ''), queryFn: () => knowledgeApi.snapshot(id!), enabled: Boolean(id), ...quiet });
export const useKnowledgeSnapshotDiff = (id: string | undefined) => useQuery({ queryKey: knowledgeQk.snapshotDiff(id ?? ''), queryFn: () => knowledgeApi.snapshotDiff(id!), enabled: Boolean(id), ...quiet });
export const useKnowledgeSearch = (q: string, claimId: string, agent: string) =>
  useQuery({ queryKey: knowledgeQk.search(q, claimId, agent), queryFn: () => knowledgeApi.search({ q, ...(claimId ? { claimId } : {}), ...(agent ? { agent } : {}) }), enabled: q.trim().length >= 2, ...quiet });
export const useKnowledgeUsed = (kind: KnowledgeUsedResponse['targetKind'], id: string | undefined) => useQuery({ queryKey: knowledgeQk.used(kind, id ?? ''), queryFn: () => knowledgeApi.used(kind, id!), enabled: Boolean(id), ...quiet });
export const useEvalRuns = () => useQuery({ queryKey: knowledgeQk.evalRuns, queryFn: async () => runsOf(await knowledgeApi.evalRuns()), ...quiet });
/** Gate replay runs for one item (server-side `itemId` filter). Polls while none has finished: approval waits for it (§12.1). */
export const useReplayRunsForItem = (itemId: string, enabled = true) =>
  useQuery({
    queryKey: knowledgeQk.evalRunsForItem(itemId),
    queryFn: async () => runsOf(await knowledgeApi.evalRuns({ itemId, mode: 'gate' })),
    enabled,
    refetchInterval: (query) => ((query.state.data as EvalRunView[] | undefined)?.length ? false : 15_000),
    ...quiet,
  });
export const useKnowledgeAlarms = (status: 'open' | 'acknowledged' | 'resolved' | 'all' = 'open') => useQuery({ queryKey: knowledgeQk.alarms(status), queryFn: () => knowledgeApi.alarms(status), ...quiet });

/** Any knowledge write: invalidates every knowledge query and the Needs-you inbox (cards close when items are decided). */
export function useKnowledgeMutation<A, R>(fn: (arg: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: knowledgeQk.all });
      void qc.invalidateQueries({ queryKey: ['needs-you'] });
      void qc.invalidateQueries({ queryKey: ['daily-log'] });
    },
  });
}
