/**
 * React Query hooks over `api` (client.ts). Keys live in `qk` so every screen invalidates the same way.
 *
 * Conventions:
 *  - One hook per route; mutations invalidate the claim bundle + derived lists (clocks, gates, actions) since
 *    nearly every write changes a clock or a gate.
 *  - `enabled` guards on ids so a screen can render before its params resolve.
 *  - Dashboard aggregates come from /analytics/overview with a per-claim fallback (`useDashboardData`).
 */
import { useMutation, useQueries, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import type { Clock, ComplianceAlert, Id, ISODate, KbEntryType, PlaybookAction } from '@ccguk/domain';
import {
  api,
  type AnalyticsOverview,
  type ClaimListFilters,
  type ClaimSummary,
  type CreateClaimBody,
  type CreateDocumentBody,
  type CreateEventBody,
  type CreateLedgerBody,
  type DashboardAction,
  type DashboardClock,
  type DashboardDocument,
  type DebtorDaysSummary,
  type EvidenceUploadFields,
  type InterventionOfferInput,
  type PartyInput,
  type PenaltyTransitionBody,
  type Settings,
  type SignStartBody,
  type SignVerifyBody,
  type SupersedeDocumentBody,
  type VehicleInput
} from './client';
import { dueState } from '../lib/clocks';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const qk = {
  health: ['health'] as const,
  claims: (filters: ClaimListFilters = {}) => ['claims', filters] as const,
  claim: (id: Id) => ['claim', id] as const,
  clocks: (id: Id) => ['claim', id, 'clocks'] as const,
  gates: (id: Id) => ['claim', id, 'gates'] as const,
  actions: (id: Id) => ['claim', id, 'actions'] as const,
  acceptance: (id: Id) => ['claim', id, 'acceptance'] as const,
  ledger: (id: Id) => ['claim', id, 'ledger'] as const,
  events: (id: Id) => ['claim', id, 'events'] as const,
  offers: (id: Id) => ['claim', id, 'offers'] as const,
  hire: (id: Id) => ['claim', id, 'hire'] as const,
  storage: (id: Id) => ['claim', id, 'storage'] as const,
  recovery: (id: Id) => ['claim', id, 'recovery'] as const,
  estimate: (id: Id) => ['claim', id, 'estimate'] as const,
  pav: (id: Id) => ['claim', id, 'pav'] as const,
  report: (id: Id) => ['claim', id, 'engineer-report'] as const,
  party: (id: Id) => ['party', id] as const,
  parties: (q: Record<string, unknown> = {}) => ['parties', q] as const,
  connections: (id: Id) => ['party', id, 'connections'] as const,
  vehicle: (id: Id) => ['vehicle', id] as const,
  vehicles: (q: Record<string, unknown> = {}) => ['vehicles', q] as const,
  mileageConflicts: (id: Id) => ['vehicle', id, 'mileage-conflicts'] as const,
  evidence: (id: Id) => ['evidence', id] as const,
  templates: ['templates'] as const,
  document: (id: Id) => ['document', id] as const,
  fleet: ['fleet'] as const,
  fleetAlerts: ['fleet', 'alerts'] as const,
  penalties: ['fleet', 'penalties'] as const,
  directory: (q: string) => ['directory', q] as const,
  kbSearch: (q: Record<string, unknown>) => ['kb', 'search', q] as const,
  kbAdvise: (topic: string) => ['kb', 'advise', topic] as const,
  gtaRates: (date?: ISODate) => ['kb', 'gta-rates', date ?? 'today'] as const,
  watch: ['watch'] as const,
  analytics: (name: string) => ['analytics', name] as const,
  settings: ['settings'] as const
};

type QueryOpts<T> = Omit<UseQueryOptions<T, Error>, 'queryKey' | 'queryFn'>;

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export function useHealth() {
  return useQuery({ queryKey: qk.health, queryFn: ({ signal }) => api.health(signal), staleTime: 30_000, refetchInterval: 60_000, retry: 0 });
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export function useClaims(filters: ClaimListFilters = {}, opts: QueryOpts<ClaimSummary[]> = {}) {
  return useQuery({ queryKey: qk.claims(filters), queryFn: ({ signal }) => api.getClaims(filters, signal), staleTime: 15_000, ...opts });
}

export function useClaim(id: Id | undefined) {
  return useQuery({ queryKey: qk.claim(id ?? ''), queryFn: ({ signal }) => api.getClaim(id!, signal), enabled: Boolean(id) });
}

export function useClocks(id: Id | undefined) {
  return useQuery({ queryKey: qk.clocks(id ?? ''), queryFn: ({ signal }) => api.getClocks(id!, signal), enabled: Boolean(id), staleTime: 30_000 });
}
export function useGates(id: Id | undefined) {
  return useQuery({ queryKey: qk.gates(id ?? ''), queryFn: ({ signal }) => api.getGates(id!, signal), enabled: Boolean(id) });
}
export function useActions(id: Id | undefined) {
  return useQuery({ queryKey: qk.actions(id ?? ''), queryFn: ({ signal }) => api.getActions(id!, signal), enabled: Boolean(id), staleTime: 30_000 });
}
export function useAcceptance(id: Id | undefined) {
  return useQuery({ queryKey: qk.acceptance(id ?? ''), queryFn: ({ signal }) => api.getAcceptance(id!, signal), enabled: Boolean(id) });
}
export function useLedger(id: Id | undefined) {
  return useQuery({ queryKey: qk.ledger(id ?? ''), queryFn: ({ signal }) => api.getLedger(id!, signal), enabled: Boolean(id) });
}
export function useEvents(id: Id | undefined) {
  return useQuery({ queryKey: qk.events(id ?? ''), queryFn: ({ signal }) => api.getEvents(id!, signal), enabled: Boolean(id) });
}
export function useOffers(id: Id | undefined) {
  return useQuery({ queryKey: qk.offers(id ?? ''), queryFn: ({ signal }) => api.getOffers(id!, signal), enabled: Boolean(id) });
}
export function useHire(id: Id | undefined) {
  return useQuery({ queryKey: qk.hire(id ?? ''), queryFn: ({ signal }) => api.getHire(id!, signal), enabled: Boolean(id) });
}
export function useStorage(id: Id | undefined) {
  return useQuery({ queryKey: qk.storage(id ?? ''), queryFn: ({ signal }) => api.getStorage(id!, signal), enabled: Boolean(id) });
}
export function useRecovery(id: Id | undefined) {
  return useQuery({ queryKey: qk.recovery(id ?? ''), queryFn: ({ signal }) => api.getRecovery(id!, signal), enabled: Boolean(id) });
}
export function useEstimate(id: Id | undefined) {
  return useQuery({ queryKey: qk.estimate(id ?? ''), queryFn: ({ signal }) => api.getEstimate(id!, signal), enabled: Boolean(id) });
}
export function usePav(id: Id | undefined) {
  return useQuery({ queryKey: qk.pav(id ?? ''), queryFn: ({ signal }) => api.getPav(id!, signal), enabled: Boolean(id) });
}
export function useEngineerReport(id: Id | undefined) {
  return useQuery({ queryKey: qk.report(id ?? ''), queryFn: ({ signal }) => api.getEngineerReport(id!, signal), enabled: Boolean(id) });
}

/** Invalidate everything derived from one claim (bundle, clocks, gates, actions, lists, dashboard). */
export function useInvalidateClaim() {
  const qc = useQueryClient();
  return (claimId?: Id) => {
    if (claimId) void qc.invalidateQueries({ queryKey: ['claim', claimId] });
    void qc.invalidateQueries({ queryKey: ['claims'] });
    void qc.invalidateQueries({ queryKey: ['analytics'] });
  };
}

export function useCreateClaim() {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (body: CreateClaimBody) => api.createClaim(body), onSuccess: () => invalidate() });
}
export function useUpdateClaim(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (body: Parameters<typeof api.updateClaim>[1]) => api.updateClaim(claimId, body), onSuccess: () => invalidate(claimId) });
}
export function useSetClaimStatus(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (body: Parameters<typeof api.setClaimStatus>[1]) => api.setClaimStatus(claimId, body), onSuccess: () => invalidate(claimId) });
}
export function usePostEvent(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (body: CreateEventBody) => api.postEvent(claimId, body), onSuccess: () => invalidate(claimId) });
}
export function usePostLedger(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (body: CreateLedgerBody) => api.postLedger(claimId, body), onSuccess: () => invalidate(claimId) });
}
export function usePostOffer(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (body: InterventionOfferInput) => api.postOffer(claimId, body), onSuccess: () => invalidate(claimId) });
}
export function useUpdateOffer(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({
    mutationFn: ({ offerId, body }: { offerId: Id; body: Parameters<typeof api.updateOffer>[2] }) => api.updateOffer(claimId, offerId, body),
    onSuccess: () => invalidate(claimId)
  });
}
export function usePostHire(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (body: Parameters<typeof api.postHire>[1]) => api.postHire(claimId, body), onSuccess: () => invalidate(claimId) });
}
export function useEndHire(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({
    mutationFn: ({ hireId, body }: { hireId: Id; body: Parameters<typeof api.endHire>[2] }) => api.endHire(claimId, hireId, body),
    onSuccess: () => invalidate(claimId)
  });
}
export function usePostStorage(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (body: Parameters<typeof api.postStorage>[1]) => api.postStorage(claimId, body), onSuccess: () => invalidate(claimId) });
}
export function useEndStorage(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({
    mutationFn: ({ storageId, body }: { storageId: Id; body: Parameters<typeof api.endStorage>[2] }) => api.endStorage(claimId, storageId, body),
    onSuccess: () => invalidate(claimId)
  });
}
export function usePostRecovery(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (body: Parameters<typeof api.postRecovery>[1]) => api.postRecovery(claimId, body), onSuccess: () => invalidate(claimId) });
}
export function useUploadEvidence(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({
    mutationFn: ({ file, fields }: { file: File | Blob; fields: EvidenceUploadFields }) => api.uploadEvidence(claimId, file, fields),
    onSuccess: () => invalidate(claimId)
  });
}

// engineering
export function usePostEstimate(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (body: Parameters<typeof api.postEstimate>[1]) => api.postEstimate(claimId, body), onSuccess: () => invalidate(claimId) });
}
export function useImportEstimate(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (body: Parameters<typeof api.importEstimate>[1]) => api.importEstimate(claimId, body), onSuccess: () => invalidate(claimId) });
}
export function usePostPav(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (body: Parameters<typeof api.postPav>[1]) => api.postPav(claimId, body), onSuccess: () => invalidate(claimId) });
}
export function useAddComparable(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (body: Parameters<typeof api.addComparable>[1]) => api.addComparable(claimId, body), onSuccess: () => invalidate(claimId) });
}
export function useAssessPav(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (body?: Record<string, unknown>) => api.assessPav(claimId, body), onSuccess: () => invalidate(claimId) });
}
export function useApprovePav(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (pavId: Id) => api.approvePav(claimId, pavId), onSuccess: () => invalidate(claimId) });
}
export function usePostEngineerReport(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (body: Parameters<typeof api.postEngineerReport>[1]) => api.postEngineerReport(claimId, body), onSuccess: () => invalidate(claimId) });
}
/** Save the report: PATCH the current unissued report, or POST a new (supplementary) one when none / issued. */
export function useSaveEngineerReport(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({
    mutationFn: ({ body, reportId }: { body: Parameters<typeof api.postEngineerReport>[1]; reportId?: Id }) =>
      reportId ? api.updateEngineerReport(claimId, reportId, body) : api.postEngineerReport(claimId, body),
    onSuccess: () => invalidate(claimId)
  });
}
export function useIssueEngineerReport(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({
    mutationFn: ({ reportId, force }: { reportId: Id; force?: boolean }) => api.issueEngineerReport(claimId, reportId, force ? { force } : {}),
    onSuccess: () => invalidate(claimId)
  });
}
export function useAssessTotalLoss(claimId: Id) {
  return useMutation({ mutationFn: (body?: Record<string, unknown>) => api.assessTotalLoss(claimId, body) });
}
export function usePredictTotalLoss(claimId: Id) {
  return useMutation({ mutationFn: (body: Parameters<typeof api.predictTotalLoss>[1]) => api.predictTotalLoss(claimId, body) });
}

// ---------------------------------------------------------------------------
// Parties & vehicles
// ---------------------------------------------------------------------------

export function useParty(id: Id | undefined) {
  return useQuery({ queryKey: qk.party(id ?? ''), queryFn: ({ signal }) => api.getParty(id!, signal), enabled: Boolean(id) });
}
export function useParties(query: Parameters<typeof api.getParties>[0] = {}, opts: QueryOpts<Awaited<ReturnType<typeof api.getParties>>> = {}) {
  return useQuery({ queryKey: qk.parties(query), queryFn: ({ signal }) => api.getParties(query, signal), ...opts });
}
export function usePartyConnections(id: Id | undefined) {
  return useQuery({ queryKey: qk.connections(id ?? ''), queryFn: ({ signal }) => api.getPartyConnections(id!, signal), enabled: Boolean(id) });
}
export function useCreateParty() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: PartyInput) => api.createParty(body), onSuccess: () => void qc.invalidateQueries({ queryKey: ['parties'] }) });
}
export function useUpdateParty(id: Id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<PartyInput>) => api.updateParty(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.party(id) });
      void qc.invalidateQueries({ queryKey: ['parties'] });
      void qc.invalidateQueries({ queryKey: ['claim'] });
    }
  });
}
export function useVehicle(id: Id | undefined) {
  return useQuery({ queryKey: qk.vehicle(id ?? ''), queryFn: ({ signal }) => api.getVehicle(id!, signal), enabled: Boolean(id) });
}
export function useVehicles(query: Parameters<typeof api.getVehicles>[0] = {}, opts: QueryOpts<Awaited<ReturnType<typeof api.getVehicles>>> = {}) {
  return useQuery({ queryKey: qk.vehicles(query), queryFn: ({ signal }) => api.getVehicles(query, signal), ...opts });
}
export function useMileageConflicts(vehicleId: Id | undefined) {
  return useQuery({ queryKey: qk.mileageConflicts(vehicleId ?? ''), queryFn: ({ signal }) => api.getMileageConflicts(vehicleId!, signal), enabled: Boolean(vehicleId) });
}
/** Lookup is a mutation (it spends an API call and writes a LookupRecord). */
export function useVehicleLookup() {
  return useMutation({ mutationFn: (registration: string) => api.lookupVehicle(registration) });
}
export function useCreateVehicle() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: VehicleInput) => api.createVehicle(body), onSuccess: () => void qc.invalidateQueries({ queryKey: ['vehicles'] }) });
}
export function useAddOdometer(vehicleId: Id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.addOdometer>[1]) => api.addOdometer(vehicleId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.vehicle(vehicleId) });
      void qc.invalidateQueries({ queryKey: qk.mileageConflicts(vehicleId) });
      void qc.invalidateQueries({ queryKey: ['claim'] });
    }
  });
}

// ---------------------------------------------------------------------------
// Documents & evidence
// ---------------------------------------------------------------------------

export function useTemplates() {
  return useQuery({ queryKey: qk.templates, queryFn: ({ signal }) => api.listTemplates(signal), staleTime: 5 * 60_000 });
}
export function useDocument(id: Id | undefined) {
  return useQuery({ queryKey: qk.document(id ?? ''), queryFn: ({ signal }) => api.getDocument(id!, signal), enabled: Boolean(id) });
}
export function useEvidence(id: Id | undefined) {
  return useQuery({ queryKey: qk.evidence(id ?? ''), queryFn: ({ signal }) => api.getEvidence(id!, signal), enabled: Boolean(id) });
}

function useInvalidateDocument() {
  const qc = useQueryClient();
  const invalidateClaim = useInvalidateClaim();
  return (docId: Id, claimId?: Id) => {
    void qc.invalidateQueries({ queryKey: qk.document(docId) });
    invalidateClaim(claimId);
  };
}

export function useCreateDocument(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: (body: CreateDocumentBody) => api.createDocument(claimId, body), onSuccess: () => invalidate(claimId) });
}
export function useClearFlag(docId: Id, claimId?: Id) {
  const invalidate = useInvalidateDocument();
  return useMutation({ mutationFn: (body: Parameters<typeof api.clearFlag>[1]) => api.clearFlag(docId, body), onSuccess: () => invalidate(docId, claimId) });
}
export function useApproveDocument(docId: Id, claimId?: Id) {
  const invalidate = useInvalidateDocument();
  return useMutation({ mutationFn: (body?: Parameters<typeof api.approveDocument>[1]) => api.approveDocument(docId, body), onSuccess: () => invalidate(docId, claimId) });
}
export function useSendDocument(docId: Id, claimId?: Id) {
  const invalidate = useInvalidateDocument();
  return useMutation({ mutationFn: (body: Parameters<typeof api.sendDocument>[1]) => api.sendDocument(docId, body), onSuccess: () => invalidate(docId, claimId) });
}
export function useStartSign(docId: Id) {
  return useMutation({ mutationFn: (body: SignStartBody) => api.startSign(docId, body) });
}
export function useVerifySign(docId: Id, claimId?: Id) {
  const invalidate = useInvalidateDocument();
  return useMutation({ mutationFn: (body: SignVerifyBody) => api.verifySign(docId, body), onSuccess: () => invalidate(docId, claimId) });
}
export function useSupersedeDocument(docId: Id, claimId?: Id) {
  const invalidate = useInvalidateDocument();
  return useMutation({ mutationFn: (body: SupersedeDocumentBody) => api.supersedeDocument(docId, body), onSuccess: () => invalidate(docId, claimId) });
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

export function useFleet() {
  return useQuery({ queryKey: qk.fleet, queryFn: ({ signal }) => api.getFleet(signal) });
}
export function useFleetAlerts(opts: QueryOpts<ComplianceAlert[]> = {}) {
  return useQuery({ queryKey: qk.fleetAlerts, queryFn: ({ signal }) => api.getFleetAlerts(signal), staleTime: 60_000, ...opts });
}
export function usePenalties() {
  return useQuery({ queryKey: qk.penalties, queryFn: ({ signal }) => api.getPenalties(signal) });
}
export function useCreateFleetUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createFleetUnit>[0]) => api.createFleetUnit(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['fleet'] })
  });
}
export function useAllocateCheck(unitId: Id) {
  return useMutation({ mutationFn: (body: Parameters<typeof api.allocateCheck>[1]) => api.allocateCheck(unitId, body) });
}
export function useCreatePenalty() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: Parameters<typeof api.createPenalty>[0]) => api.createPenalty(body), onSuccess: () => void qc.invalidateQueries({ queryKey: ['fleet'] }) });
}
export function useTransitionPenalty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: Id; body: PenaltyTransitionBody }) => api.transitionPenalty(id, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['fleet'] })
  });
}

// ---------------------------------------------------------------------------
// Directory, KB, rates, watch
// ---------------------------------------------------------------------------

export function useDirectory(q: string, opts: QueryOpts<Awaited<ReturnType<typeof api.searchDirectory>>> = {}) {
  return useQuery({ queryKey: qk.directory(q), queryFn: ({ signal }) => api.searchDirectory(q, signal), staleTime: 60_000, ...opts });
}
export function useVerifyDirectoryEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.verifyDirectoryEntry>[1] }) => api.verifyDirectoryEntry(id, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['directory'] })
  });
}
export function useReportDirectoryFailed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.reportDirectoryFailed>[1] }) => api.reportDirectoryFailed(id, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['directory'] })
  });
}
export function useKbSearch(query: { q: string; type?: KbEntryType; topic?: string; limit?: number }, opts: QueryOpts<Awaited<ReturnType<typeof api.kbSearch>>> = {}) {
  return useQuery({ queryKey: qk.kbSearch(query), queryFn: ({ signal }) => api.kbSearch(query, signal), enabled: query.q.trim().length > 0, staleTime: 5 * 60_000, ...opts });
}
export function useKbAdvise(topic: string | undefined) {
  return useQuery({ queryKey: qk.kbAdvise(topic ?? ''), queryFn: ({ signal }) => api.kbAdvise(topic!, signal), enabled: Boolean(topic), staleTime: 5 * 60_000 });
}
export function useGtaRates(date?: ISODate) {
  return useQuery({ queryKey: qk.gtaRates(date), queryFn: ({ signal }) => api.gtaRates(date, signal), staleTime: 60 * 60_000 });
}
export function useWatch() {
  return useQuery({ queryKey: qk.watch, queryFn: ({ signal }) => api.getWatch(signal), staleTime: 60_000 });
}
export function useAddWatch() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: Parameters<typeof api.addWatch>[0]) => api.addWatch(body), onSuccess: () => void qc.invalidateQueries({ queryKey: qk.watch }) });
}
export function usePollWatch() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => api.pollWatch(), onSuccess: () => void qc.invalidateQueries({ queryKey: qk.watch }) });
}

// ---------------------------------------------------------------------------
// Analytics & settings
// ---------------------------------------------------------------------------

export function useAnalyticsOverview(opts: QueryOpts<AnalyticsOverview> = {}) {
  return useQuery({ queryKey: qk.analytics('overview'), queryFn: ({ signal }) => api.analyticsOverview(signal), staleTime: 30_000, refetchInterval: 120_000, ...opts });
}
export function useDebtorDays(opts: QueryOpts<DebtorDaysSummary> = {}) {
  return useQuery({ queryKey: qk.analytics('debtor-days'), queryFn: ({ signal }) => api.analyticsDebtorDays(signal), staleTime: 60_000, ...opts });
}
export function useReductions() {
  return useQuery({ queryKey: qk.analytics('reductions'), queryFn: ({ signal }) => api.analyticsReductions(signal), staleTime: 60_000 });
}
export function useCycleTimes() {
  return useQuery({ queryKey: qk.analytics('cycle-times'), queryFn: ({ signal }) => api.analyticsCycleTimes(signal), staleTime: 60_000 });
}
export function useInterventionsAnalytics() {
  return useQuery({ queryKey: qk.analytics('interventions'), queryFn: ({ signal }) => api.analyticsInterventions(signal), staleTime: 60_000 });
}
export function useUsers() {
  return useQuery({ queryKey: ['users'] as const, queryFn: ({ signal }) => api.getUsers(signal), staleTime: 10 * 60_000 });
}
/** Display name for a user id: the name when known, otherwise the id (never blank). */
export function useUserName(id: string | undefined): string | undefined {
  const q = useUsers();
  if (!id) return undefined;
  return q.data?.find((u) => u.id === id)?.name ?? id;
}
export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: ({ signal }) => api.getSettings(signal), staleTime: 5 * 60_000 });
}
export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: Partial<Settings>) => api.updateSettings(body), onSuccess: () => void qc.invalidateQueries({ queryKey: qk.settings }) });
}

// ---------------------------------------------------------------------------
// Dashboard composite (overview first, per-claim fallback)
// ---------------------------------------------------------------------------

export const OPEN_STATUSES = new Set(['fnol', 'triage', 'accepted', 'hire_active', 'repair', 'total_loss', 'payment_pack', 'chasing', 'disputed', 'complaint', 'pre_action', 'litigation']);

export interface DashboardData {
  overview: AnalyticsOverview | undefined;
  claims: ClaimSummary[];
  clocksOverdue: DashboardClock[];
  clocksToday: DashboardClock[];
  blockedDocuments: DashboardDocument[];
  nextActions: DashboardAction[];
  debtorDays: DebtorDaysSummary | undefined;
  fleetAlerts: ComplianceAlert[] | undefined;
  fleetAlertCount: number;
  isLoading: boolean;
  isFetchingFallback: boolean;
  errors: Error[];
  usingFallback: boolean;
}

const FALLBACK_CLAIM_LIMIT = 30;

/**
 * Everything the dashboard and the top-bar badges need. Uses /analytics/overview when it carries the aggregates;
 * otherwise walks the open claims (capped) for clocks and actions so the shell still works against a minimal API.
 */
export function useDashboardData(now: Date = new Date()): DashboardData {
  const overview = useAnalyticsOverview({ retry: 1 });
  const claims = useClaims({ limit: 200 }, { retry: 1 });
  const debtor = useDebtorDays({ retry: 1, enabled: !overview.data?.debtorDays });
  const fleetAlerts = useFleetAlerts({ retry: 1, enabled: overview.data?.fleetAlerts === undefined });

  const ov = overview.data;
  const needClockFallback = overview.isFetched && !ov?.clocks;
  const needActionFallback = overview.isFetched && !ov?.nextActions;
  const openClaims = (claims.data ?? []).filter((c) => OPEN_STATUSES.has(c.status)).slice(0, FALLBACK_CLAIM_LIMIT);

  const clockQueries = useQueries({
    queries: openClaims.map((c) => ({
      queryKey: qk.clocks(c.id),
      queryFn: ({ signal }: { signal?: AbortSignal }) => api.getClocks(c.id, signal),
      enabled: needClockFallback,
      staleTime: 60_000,
      retry: 0
    }))
  });
  const actionQueries = useQueries({
    queries: openClaims.map((c) => ({
      queryKey: qk.actions(c.id),
      queryFn: ({ signal }: { signal?: AbortSignal }) => api.getActions(c.id, signal),
      enabled: needActionFallback,
      staleTime: 60_000,
      retry: 0
    }))
  });

  let clocksOverdue: DashboardClock[] = [];
  let clocksToday: DashboardClock[] = [];
  if (ov?.clocks) {
    clocksOverdue = ov.clocks.overdue ?? [];
    clocksToday = ov.clocks.dueToday ?? [];
  } else if (needClockFallback) {
    const all: DashboardClock[] = [];
    clockQueries.forEach((q, i) => {
      const claim = openClaims[i];
      for (const clock of q.data ?? []) all.push({ ...(clock as Clock), claimReference: claim?.reference, claimantName: claim?.claimantName });
    });
    clocksOverdue = all.filter((c) => dueState(c, now) === 'overdue');
    clocksToday = all.filter((c) => dueState(c, now) === 'today');
  }
  clocksOverdue.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  clocksToday.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));

  let nextActions: DashboardAction[] = [];
  if (ov?.nextActions) nextActions = ov.nextActions;
  else if (needActionFallback) {
    actionQueries.forEach((q, i) => {
      const claim = openClaims[i];
      for (const a of q.data ?? []) nextActions.push({ ...(a as PlaybookAction), claimId: claim?.id ?? '', claimReference: claim?.reference });
    });
  }
  const prioRank = { now: 0, today: 1, this_week: 2, scheduled: 3 } as const;
  nextActions.sort((a, b) => prioRank[a.priority] - prioRank[b.priority] || Date.parse(a.dueAt ?? '2999-01-01') - Date.parse(b.dueAt ?? '2999-01-01'));

  let blockedDocuments: DashboardDocument[] = ov?.blockedDocuments ?? [];
  if (!ov?.blockedDocuments) {
    // fallback: claims list rows may carry a blocked count only; synthesise one line per claim
    blockedDocuments = (claims.data ?? [])
      .filter((c) => (c.blockedDocuments ?? 0) > 0)
      .map((c) => ({ id: `claim:${c.id}`, claimId: c.id, claimReference: c.reference, templateId: '', title: `${c.blockedDocuments} blocked document${c.blockedDocuments === 1 ? '' : 's'}`, status: 'blocked' as const, createdAt: c.updatedAt }));
  }

  const fleetAlertList = Array.isArray(ov?.fleetAlerts) ? ov?.fleetAlerts : fleetAlerts.data;
  const fleetAlertCount = typeof ov?.fleetAlerts === 'number' ? ov.fleetAlerts : (fleetAlertList?.length ?? 0);

  const errors = [overview.error, claims.error, debtor.error, fleetAlerts.error].filter((e): e is Error => Boolean(e));
  const fallbackFetching = clockQueries.some((q) => q.isFetching) || actionQueries.some((q) => q.isFetching);

  return {
    overview: ov,
    claims: claims.data ?? [],
    clocksOverdue,
    clocksToday,
    blockedDocuments,
    nextActions,
    debtorDays: ov?.debtorDays ?? debtor.data,
    fleetAlerts: fleetAlertList,
    fleetAlertCount,
    isLoading: overview.isLoading || claims.isLoading,
    isFetchingFallback: fallbackFetching,
    errors,
    usingFallback: needClockFallback || needActionFallback
  };
}
