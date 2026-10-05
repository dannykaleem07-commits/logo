/**
 * Manager mode and audit routes (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A.4.2, §A.8). Web code never imports API code,
 * so the HTTP shapes are declared here.
 *
 *   GET  /auth/manager-mode               → ManagerModeView
 *   POST /auth/manager-mode {on, why?}    → ManagerModeView (on:true is admin/approver only: 403 FORBIDDEN)
 *   GET  /auth/manager-mode/log?limit=50  → { items: ManagerLogEntry[] } newest first (admin/approver)
 *   GET  /claims/:id/audit                → { entries: AuditEntryView[] } newest first
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { asList, isApiError, request, seg } from './client';

export interface ManagerModeView {
  allowed: boolean;
  on: boolean;
  until?: string;
  idleMinutes: number;
  defaultReason: 'Manager override';
}

/** One `audit_log` row as the API returns it. */
export interface AuditEntryView {
  id: string;
  at: string;
  userId: string;
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

/** A row of `GET /auth/manager-mode/log`: an override or a manager-mode on/off row, with names resolved. */
export interface ManagerLogEntry extends AuditEntryView {
  userName?: string;
  claimReference?: string;
}

export const OFF_VIEW: ManagerModeView = { allowed: false, on: false, idleMinutes: 60, defaultReason: 'Manager override' };

export const managerQk = {
  mode: ['auth', 'manager-mode'] as const,
  log: (limit: number) => ['auth', 'manager-mode', 'log', limit] as const,
  claimAudit: (claimId: string) => ['claim', claimId, 'audit'] as const,
};

/** GET /auth/manager-mode. No session (401) → off and not allowed. */
export async function getManagerMode(signal?: AbortSignal): Promise<ManagerModeView> {
  try {
    return normaliseManagerMode(await request<unknown>('/auth/manager-mode', { method: 'GET', signal }));
  } catch (e) {
    if (isApiError(e) && e.status === 401) return OFF_VIEW;
    throw e;
  }
}

/** POST /auth/manager-mode `{ on, why? }` (also the heartbeat while on). */
export async function setManagerMode(on: boolean, why?: 'user' | 'idle'): Promise<ManagerModeView> {
  const body: { on: boolean; why?: 'user' | 'idle' } = { on };
  if (why) body.why = why;
  return normaliseManagerMode(await request<unknown>('/auth/manager-mode', { method: 'POST', body }));
}

/** GET /auth/manager-mode/log?limit= */
export async function getManagerLog(limit = 50, signal?: AbortSignal): Promise<ManagerLogEntry[]> {
  return asList<ManagerLogEntry>(await request<unknown>('/auth/manager-mode/log', { method: 'GET', query: { limit }, signal }));
}

/** GET /claims/:id/audit (newest first). */
export async function getClaimAudit(claimId: string, signal?: AbortSignal): Promise<AuditEntryView[]> {
  const rows = asList<AuditEntryView>(await request<unknown>(`/claims/${seg(claimId)}/audit`, { method: 'GET', signal }));
  return [...rows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** Defensive parse of a ManagerModeView (an unexpected body reads as off). */
export function normaliseManagerMode(raw: unknown): ManagerModeView {
  if (!raw || typeof raw !== 'object') return OFF_VIEW;
  const r = raw as Record<string, unknown>;
  const idle = typeof r.idleMinutes === 'number' && Number.isFinite(r.idleMinutes) && r.idleMinutes >= 1 ? Math.round(r.idleMinutes) : 60;
  const view: ManagerModeView = { allowed: r.allowed === true, on: r.on === true, idleMinutes: idle, defaultReason: 'Manager override' };
  if (typeof r.until === 'string' && r.until) view.until = r.until;
  return view;
}

/** Recent overrides and manager-mode on/off rows (Settings → Manager mode). */
export function useManagerLog(limit = 50, enabled = true) {
  return useQuery({ queryKey: managerQk.log(limit), queryFn: ({ signal }) => getManagerLog(limit, signal), enabled, staleTime: 15_000 });
}

/** A claim's audit trail (Flags tab). */
export function useClaimAudit(claimId: string | undefined) {
  return useQuery({ queryKey: managerQk.claimAudit(claimId ?? ''), queryFn: ({ signal }) => getClaimAudit(claimId!, signal), enabled: Boolean(claimId), staleTime: 15_000 });
}

/** The server's manager-mode view (the provider owns the polling; this reads the same cache entry). */
export function useManagerModeView(enabled = true) {
  return useQuery({ queryKey: managerQk.mode, queryFn: ({ signal }) => getManagerMode(signal), enabled, staleTime: 30_000 });
}

/** POST /auth/manager-mode; the result replaces the cached view. Screens normally use useManagerMode().turnOn/turnOff. */
export function useSetManagerMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ on, why }: { on: boolean; why?: 'user' | 'idle' }) => setManagerMode(on, why),
    onSuccess: (v) => qc.setQueryData(managerQk.mode, v)
  });
}
