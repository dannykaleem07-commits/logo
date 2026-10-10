// owned by ap-autopilot
/**
 * Autopilot client (docs/SUPREME-AUTOPILOT.md §H.4, §I.1, §I.8). Web code never imports API code, so the HTTP shapes
 * of apps/api/src/routes/autopilot.ts and autopilotSettings.ts are declared here.
 *
 *   GET  /claims/:id/autopilot                          { claimId, record, plan, catalogue, log, stopped }
 *   POST /claims/:id/autopilot/evaluate                 same, stored, a tick queued
 *   POST /claims/:id/autopilot/pause | resume           { reason } (human-only)
 *   POST /claims/:id/autopilot/steps/:stepId/:action    run | skip | ask | auto | done | snooze | clear
 *   GET  /claims/:id/hire-offers                        { offers }
 *   POST /hire-offers/:id/accept                        { how: 'phone' | 'in_person', note }
 *   POST /hire-offers/:id/withdraw                      { reason }
 *   GET/PATCH /settings/autopilot                       { settings, defaults, floors }
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AutopilotLogEntry, AutopilotPlan, AutopilotSettings, ClaimAutopilotRecord, HireOffer, StepMode } from '@ccguk/domain';
import { request, seg } from './client';

export interface CatalogueEntry {
  id: string;
  title: string;
  track: string;
  stage: string;
  performer: string;
  floor: StepMode;
  defaultMode: StepMode;
}

export interface AutopilotView {
  claimId: string;
  record: Omit<ClaimAutopilotRecord, 'plan'>;
  plan: AutopilotPlan;
  catalogue: CatalogueEntry[];
  log: AutopilotLogEntry[];
  stopped: string | null;
}

export type StepAction = 'run' | 'skip' | 'ask' | 'auto' | 'done' | 'snooze' | 'clear';
export type HireOfferView = HireOffer & { reservationStatus: string | null };

export interface AutopilotSettingsView {
  settings: AutopilotSettings;
  defaults: AutopilotSettings;
  floors: Array<{ id: string; floor: StepMode; reason: string | null }>;
}

/** A deep subset of AutopilotSettings; `stepModes[id] = null` clears the step back to its default. */
export type AutopilotSettingsPatch = { [K in keyof AutopilotSettings]?: K extends 'stepModes' ? Record<string, StepMode | null> : Partial<AutopilotSettings[K]> | AutopilotSettings[K] };

export const autopilotApi = {
  view: (claimId: string) => request<AutopilotView>(`/claims/${seg(claimId)}/autopilot`),
  evaluate: (claimId: string) => request<AutopilotView>(`/claims/${seg(claimId)}/autopilot/evaluate`, { method: 'POST', body: {} }),
  pause: (claimId: string, reason: string) => request<{ record: ClaimAutopilotRecord }>(`/claims/${seg(claimId)}/autopilot/pause`, { method: 'POST', body: { reason } }),
  resume: (claimId: string) => request<{ record: ClaimAutopilotRecord }>(`/claims/${seg(claimId)}/autopilot/resume`, { method: 'POST', body: {} }),
  step: (claimId: string, stepId: string, action: StepAction, body: { reason?: string; until?: string } = {}) =>
    request<{ record: ClaimAutopilotRecord; queuedTick: boolean }>(`/claims/${seg(claimId)}/autopilot/steps/${seg(stepId)}/${action}`, { method: 'POST', body }),
  offers: (claimId: string) => request<{ offers: HireOfferView[] }>(`/claims/${seg(claimId)}/hire-offers`),
  acceptByPhone: (offerId: string, how: 'phone' | 'in_person', note?: string) => request<{ offer: HireOffer }>(`/hire-offers/${seg(offerId)}/accept`, { method: 'POST', body: { how, ...(note ? { note } : {}) } }),
  withdraw: (offerId: string, reason: string) => request<{ offer: HireOffer }>(`/hire-offers/${seg(offerId)}/withdraw`, { method: 'POST', body: { reason } }),
  settings: () => request<AutopilotSettingsView>('/settings/autopilot'),
  patchSettings: (patch: AutopilotSettingsPatch) => request<{ settings: AutopilotSettings }>('/settings/autopilot', { method: 'PATCH', body: patch }),
};

export const autopilotQk = {
  view: (claimId: string) => ['autopilot', 'view', claimId] as const,
  offers: (claimId: string) => ['autopilot', 'offers', claimId] as const,
  settings: ['settings', 'autopilot'] as const,
};

/** The claim's plan, polled every 15 seconds (§I.1). */
export function useAutopilotView(claimId: string | undefined) {
  return useQuery({ queryKey: autopilotQk.view(claimId ?? ''), queryFn: () => autopilotApi.view(claimId!), enabled: Boolean(claimId), refetchInterval: 15_000 });
}

export function useHireOffers(claimId: string | undefined) {
  return useQuery({ queryKey: autopilotQk.offers(claimId ?? ''), queryFn: () => autopilotApi.offers(claimId!), enabled: Boolean(claimId), refetchInterval: 30_000 });
}

function invalidateClaim(qc: ReturnType<typeof useQueryClient>, claimId: string) {
  void qc.invalidateQueries({ queryKey: autopilotQk.view(claimId) });
  void qc.invalidateQueries({ queryKey: autopilotQk.offers(claimId) });
}

export function usePauseAutopilot(claimId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (reason: string) => autopilotApi.pause(claimId, reason), onSettled: () => invalidateClaim(qc, claimId) });
}

export function useResumeAutopilot(claimId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => autopilotApi.resume(claimId), onSettled: () => invalidateClaim(qc, claimId) });
}

export function useStepAction(claimId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ stepId, action, reason, until }: { stepId: string; action: StepAction; reason?: string; until?: string }) => autopilotApi.step(claimId, stepId, action, { ...(reason ? { reason } : {}), ...(until ? { until } : {}) }),
    onSettled: () => invalidateClaim(qc, claimId),
  });
}

export function useAcceptByPhone(claimId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ offerId, how, note }: { offerId: string; how: 'phone' | 'in_person'; note?: string }) => autopilotApi.acceptByPhone(offerId, how, note), onSettled: () => invalidateClaim(qc, claimId) });
}

export function useAutopilotSettings() {
  return useQuery({ queryKey: autopilotQk.settings, queryFn: autopilotApi.settings });
}

export function usePatchAutopilotSettings() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (patch: AutopilotSettingsPatch) => autopilotApi.patchSettings(patch), onSettled: () => qc.invalidateQueries({ queryKey: autopilotQk.settings }) });
}
