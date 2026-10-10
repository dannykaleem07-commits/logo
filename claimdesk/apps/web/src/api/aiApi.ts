/**
 * Settings > AI client (docs/SUPREME-DESIGN.md §A.7, §L.6, §N.6 gateway row). Web code never imports API code, so the
 * HTTP shapes of `apps/api/src/routes/ai.ts` are declared here.
 *
 *   GET    /ai/status             → AiStatus
 *   POST   /ai/check              → AiStatus (re-detects Claude Code, re-checks the sign-in; no model call)
 *   PATCH  /ai/settings           → AiStatus (admin; agentsEnabled only when the checklist is done and the driver is ready)
 *   PUT    /ai/token|/ai/api-key|/ai/fca-key  {value} → {name, present}   (the value is never returned)
 *   DELETE /ai/token|/ai/api-key  → {name, present:false}
 *   POST   /ai/open-setup-token   → {opened, instructions}  (Windows only; 501 elsewhere)
 *   POST   /ai/test-run           → {driver, outcome, …}     (refused while real AI is forbidden)
 *   POST   /ai/checklist          {item, done} → AiStatus
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';

export type AiDriverChoice = 'subscription_cli' | 'api_key' | 'off';
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AiQuality = 'standard' | 'economy' | 'best';
export type ChecklistItemId = 'training_opt_out' | 'subscription_terms' | 'mailbox_connected' | 'background_running';

export interface AiJobModel {
  model: string;
  effort: AiEffort;
  maxTurns: number;
  timeoutMs: number;
}

export interface RateLimitSnapshot {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  type?: string;
  utilization?: number;
  resetsAt?: string;
}

export interface AiSettings {
  driver: AiDriverChoice;
  quality: AiQuality;
  perJob: Record<string, Partial<AiJobModel>>;
  lanes: { ai: number; io: number; cpu: number };
  reservePercent: number;
  dailyUsdCap: number;
  prices: Record<string, { inputPerMTokUsd: number; outputPerMTokUsd: number; cacheReadPerMTokUsd: number }>;
  perClaimRunsPerDay: number;
  debugTranscripts: boolean;
}

export interface DriverHealth {
  kind: string;
  ready: boolean;
  problems: string[];
  cli?: { path?: string; version?: string; authMethod?: string; loggedIn?: boolean; minVersionOk: boolean };
  apiKeyPresent?: boolean;
}

export interface AiStatus {
  driver: { selected: AiDriverChoice | 'fake'; override: string | null; health: DriverHealth };
  cli: { path: string | null; version: string | null; minVersion: string; minVersionOk: boolean; authMethod: string | null; loggedIn: boolean | null; problems: string[]; checkedAt: string };
  secrets: { claudeToken: boolean; apiKey: boolean; fcaHandbookKey?: boolean };
  settings: AiSettings;
  jobModels: Array<{ jobType: string; agent: string; defaults: AiJobModel; effective: AiJobModel }>;
  agents: { enabled: boolean };
  checklist: Record<ChecklistItemId, { done: boolean; at: string | null; by: string | null }>;
  checklistComplete: boolean;
  usage: { driver: string; pausedUntil?: string; pauseReason?: string; fiveHour?: RateLimitSnapshot; sevenDay?: RateLimitSnapshot; costTodayUsd: number; costDay?: string; paused: boolean };
  canEnableAgents: boolean;
  blockers: string[];
  realAiForbidden: boolean;
  fakeAllowed: boolean;
  platform: string;
  notices: { terms: string; training: string; privacyUrl: string };
}

export interface AiSettingsPatch {
  driver?: AiDriverChoice;
  quality?: AiQuality;
  perJob?: Record<string, Partial<AiJobModel>>;
  lanes?: Partial<AiSettings['lanes']>;
  reservePercent?: number;
  dailyUsdCap?: number;
  perClaimRunsPerDay?: number;
  debugTranscripts?: boolean;
  agentsEnabled?: boolean;
}

export type SecretKind = 'token' | 'api-key' | 'fca-key';

export interface TestRunResult {
  driver: string;
  outcome: string;
  model?: string;
  message?: string;
  resetsAt?: string | null;
}

export const aiApi = {
  status: () => request<AiStatus>('/ai/status'),
  check: () => request<AiStatus>('/ai/check', { method: 'POST', body: {} }),
  patchSettings: (patch: AiSettingsPatch) => request<AiStatus>('/ai/settings', { method: 'PATCH', body: patch }),
  putSecret: (kind: SecretKind, value: string) => request<{ name: string; present: boolean }>(`/ai/${kind}`, { method: 'PUT', body: { value } }),
  deleteSecret: (kind: SecretKind) => request<{ name: string; present: boolean }>(`/ai/${kind}`, { method: 'DELETE' }),
  openSetupToken: () => request<{ opened: boolean; instructions: string }>('/ai/open-setup-token', { method: 'POST', body: {} }),
  testRun: () => request<TestRunResult>('/ai/test-run', { method: 'POST', body: {} }),
  setChecklist: (item: ChecklistItemId, done: boolean) => request<AiStatus>('/ai/checklist', { method: 'POST', body: { item, done } }),
};

export const aiQk = { status: ['ai', 'status'] as const };

export function useAiStatus() {
  return useQuery({ queryKey: aiQk.status, queryFn: () => aiApi.status(), staleTime: 30_000 });
}

/** A mutation that returns a fresh AiStatus (or invalidates it) so the page always shows the server's view. */
export function useAiMutation<A>(fn: (arg: A) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      if (data && typeof data === 'object' && 'driver' in data && 'checklist' in data) qc.setQueryData(aiQk.status, data);
      else void qc.invalidateQueries({ queryKey: aiQk.status });
    },
  });
}
