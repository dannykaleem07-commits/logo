// owned by ap-clash
/**
 * Clash and eligibility client (docs/SUPREME-AUTOPILOT.md §C, §F, §H.4). Web code never imports API code, so the HTTP
 * shapes of apps/api/src/routes/clashes.ts are declared here.
 *
 *   POST /clashes/check                     { claimId, fleetUnitId?, startAt?, expectedEndAt?, use?, … } → ClashCheckResult
 *   GET  /claims/:id/clashes[?all=1]        → { findings, counts }
 *   GET  /fleet/clashes?code&severity&unit&claim&status → { findings }
 *   POST /clashes/:id/acknowledge|resolve   { reason }  (human-only)
 *   GET/PUT /parties/:id/driver-profile
 *   GET/PUT /fleet/policies/:id/criteria    { criteria | null }
 *   GET/PUT /claims/:id/hire-needs
 *   GET  /claims/:id/eligibility, POST /claims/:id/eligibility/assess
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClashFindingRecord, ClashFinding, DriverCriteria, DriverProfile, EligibilityAssessmentRecord, EligibilitySummary, FleetUse, HireNeeds, InsurancePolicy } from '@ccguk/domain';
import { request, seg } from './client';

export type StoredFinding = ClashFindingRecord & { claimReference?: string; relatedClaims?: Array<{ id: string; reference: string }>; registration?: string };
/** A finding from a live check, with its stored id and status when it was persisted. */
export type CheckedFinding = ClashFinding & { id?: string; status?: ClashFindingRecord['status'] };

export interface ClashCheckBody {
  claimId: string;
  fleetUnitId?: string;
  startAt?: string;
  expectedEndAt?: string;
  use?: FleetUse;
  hirerPartyId?: string;
  driverPartyIds?: string[];
  excludeReservationId?: string;
  stage?: 'hold' | 'confirm' | 'handover';
  persist?: boolean;
}

export interface ClashCheckResult {
  findings: CheckedFinding[];
  blocks: string[];
  greenBlocking: string[];
}

export interface FleetClashFilters {
  code?: string;
  severity?: 'block' | 'warn' | 'info' | '';
  unit?: string;
  claim?: string;
  status?: 'active' | 'open' | 'acknowledged' | 'overridden' | 'resolved';
}

export interface DriverProfileView {
  partyId: string;
  name: string;
  dateOfBirth: string | null;
  drivingLicenceNumber: string | null;
  profile: DriverProfile | null;
}

export type DriverProfileBody = Omit<DriverProfile, 'partyId' | 'updatedBy' | 'updatedAt' | 'dvlaCheck'> & { dvlaCheck?: { checkedAt: string; summary: string; evidenceId?: string } | null };

export interface PolicyCriteriaView {
  policyId: string;
  criteria: DriverCriteria | null;
  defaults: DriverCriteria;
  builtIn: DriverCriteria;
  effective: DriverCriteria;
  source: 'policy' | 'settings_default';
  notice: string;
}

export interface EligibilityView {
  claimId: string;
  summary: EligibilitySummary;
  criteria: DriverCriteria;
  criteriaSource: 'policy' | 'settings_default';
  policyId: string | null;
  assessedAt: string | null;
  latest: Record<string, EligibilityAssessmentRecord | null>;
  notice: string;
}

export const clashApi = {
  check: (body: ClashCheckBody) => request<ClashCheckResult>('/clashes/check', { method: 'POST', body }),
  claim: (claimId: string, all = false) => request<{ findings: StoredFinding[]; counts: { block: number; warn: number; info: number } }>(`/claims/${seg(claimId)}/clashes`, { query: all ? { all: '1' } : undefined }),
  fleet: (f: FleetClashFilters = {}) =>
    request<{ findings: StoredFinding[] }>('/fleet/clashes', { query: { code: f.code || undefined, severity: f.severity || undefined, unit: f.unit || undefined, claim: f.claim || undefined, status: f.status || undefined } }),
  acknowledge: (id: string, reason: string) => request<{ finding: StoredFinding }>(`/clashes/${seg(id)}/acknowledge`, { method: 'POST', body: { reason } }),
  resolve: (id: string, reason: string) => request<{ finding: StoredFinding }>(`/clashes/${seg(id)}/resolve`, { method: 'POST', body: { reason } }),
  driverProfile: (partyId: string) => request<DriverProfileView>(`/parties/${seg(partyId)}/driver-profile`),
  saveDriverProfile: (partyId: string, body: DriverProfileBody) => request<{ profile: DriverProfile }>(`/parties/${seg(partyId)}/driver-profile`, { method: 'PUT', body }),
  policies: () => request<{ items: InsurancePolicy[] }>('/fleet/policies'),
  policyCriteria: (policyId: string) => request<PolicyCriteriaView>(`/fleet/policies/${seg(policyId)}/criteria`),
  savePolicyCriteria: (policyId: string, criteria: DriverCriteria | null) => request<{ policyId: string; criteria: DriverCriteria | null }>(`/fleet/policies/${seg(policyId)}/criteria`, { method: 'PUT', body: { criteria } }),
  hireNeeds: (claimId: string) => request<{ claimId: string; needs: HireNeeds | null; updatedBy: string | null; updatedAt: string | null }>(`/claims/${seg(claimId)}/hire-needs`),
  saveHireNeeds: (claimId: string, needs: Partial<HireNeeds>) => request<{ needs: HireNeeds }>(`/claims/${seg(claimId)}/hire-needs`, { method: 'PUT', body: needs }),
  /** Settings > Autopilot (the default driver criteria live in `eligibility.defaultCriteria`). */
  autopilotSettings: () => request<{ settings: { eligibility: { defaultCriteria: DriverCriteria; requireMeansBeforeOffer: boolean } } }>('/settings/autopilot'),
  saveDefaultCriteria: (criteria: DriverCriteria) => request<unknown>('/settings/autopilot', { method: 'PATCH', body: { eligibility: { defaultCriteria: criteria } } }),
  eligibility: (claimId: string) => request<EligibilityView>(`/claims/${seg(claimId)}/eligibility`),
  assess: (claimId: string) => request<{ summary: EligibilitySummary; written: unknown[] }>(`/claims/${seg(claimId)}/eligibility/assess`, { method: 'POST', body: {} }),
};

export const clashQk = {
  all: ['clashes'] as const,
  claim: (claimId: string) => ['clashes', 'claim', claimId] as const,
  fleet: (f: FleetClashFilters) => ['clashes', 'fleet', f] as const,
  check: (b: ClashCheckBody) => ['clashes', 'check', b] as const,
  profile: (partyId: string) => ['driver-profile', partyId] as const,
  policies: ['fleet', 'policies'] as const,
  criteria: (policyId: string) => ['policy-criteria', policyId] as const,
  eligibility: (claimId: string) => ['eligibility', claimId] as const,
};

export function useClaimClashes(claimId: string | undefined) {
  return useQuery({ queryKey: clashQk.claim(claimId ?? ''), queryFn: () => clashApi.claim(claimId!), enabled: Boolean(claimId), refetchInterval: 30_000 });
}

export function useFleetClashes(f: FleetClashFilters) {
  return useQuery({ queryKey: clashQk.fleet(f), queryFn: () => clashApi.fleet(f) });
}

/** Live check (booking dialog): read-only preview unless `persist` is set. */
export function useClashCheck(body: ClashCheckBody | undefined) {
  return useQuery({ queryKey: clashQk.check(body ?? { claimId: '' }), queryFn: () => clashApi.check(body!), enabled: Boolean(body?.claimId) });
}

export function useAcknowledgeClash() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => clashApi.acknowledge(id, reason), onSettled: () => qc.invalidateQueries({ queryKey: clashQk.all }) });
}

export function useResolveClash() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => clashApi.resolve(id, reason), onSettled: () => qc.invalidateQueries({ queryKey: clashQk.all }) });
}

export function useDriverProfile(partyId: string | undefined) {
  return useQuery({ queryKey: clashQk.profile(partyId ?? ''), queryFn: () => clashApi.driverProfile(partyId!), enabled: Boolean(partyId) });
}

export function useSaveDriverProfile(partyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DriverProfileBody) => clashApi.saveDriverProfile(partyId, body),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: clashQk.profile(partyId) });
      void qc.invalidateQueries({ queryKey: ['eligibility'] });
    },
  });
}

export function usePolicies() {
  return useQuery({ queryKey: clashQk.policies, queryFn: clashApi.policies });
}

export function usePolicyCriteria(policyId: string | undefined) {
  return useQuery({ queryKey: clashQk.criteria(policyId ?? ''), queryFn: () => clashApi.policyCriteria(policyId!), enabled: Boolean(policyId) });
}

export function useSavePolicyCriteria(policyId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (criteria: DriverCriteria | null) => clashApi.savePolicyCriteria(policyId, criteria), onSettled: () => qc.invalidateQueries({ queryKey: clashQk.criteria(policyId) }) });
}

export function useDefaultCriteria() {
  return useQuery({ queryKey: ['settings', 'autopilot', 'criteria'], queryFn: async () => (await clashApi.autopilotSettings()).settings.eligibility.defaultCriteria });
}

export function useSaveDefaultCriteria() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (criteria: DriverCriteria) => clashApi.saveDefaultCriteria(criteria), onSettled: () => qc.invalidateQueries({ queryKey: ['settings', 'autopilot'] }) });
}

export function useEligibility(claimId: string | undefined) {
  return useQuery({ queryKey: clashQk.eligibility(claimId ?? ''), queryFn: () => clashApi.eligibility(claimId!), enabled: Boolean(claimId) });
}
