// owned by runtime
/**
 * Needs-you inbox client (docs/SUPREME-DESIGN.md §C.7, §L.1, §L.2). Web code never imports API code, so the HTTP
 * shapes of apps/api/src/routes/needsYou.ts are declared here.
 *
 *   GET  /needs-you?status=&kind=&claimId=&priority=   → { items, count }
 *   GET  /needs-you/count                              → NeedsYouCount (top-bar badge, polled every 15 s)
 *   GET  /needs-you/:id                                → NeedsYouDetail
 *   POST /needs-you/:id/resolve {optionId, edits?, note?}
 *   POST /needs-you/:id/snooze {minutes | until}
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NeedsYouKind, NeedsYouOption, NeedsYouPriority, Recommendation } from '@ccguk/domain';
import { request, seg } from './client';

export type NeedsYouStatus = 'open' | 'snoozed' | 'resolved' | 'expired' | 'superseded';

export interface NeedsYouItem {
  id: string;
  kind: NeedsYouKind;
  claimId?: string;
  claimReference?: string;
  title: string;
  summary: string;
  recommendation?: Recommendation;
  options: NeedsYouOption[];
  payload: unknown;
  priority: NeedsYouPriority;
  dueAt?: string;
  status: NeedsYouStatus;
  snoozedUntil?: string;
  resolution?: unknown;
  correlationId?: string;
  resumesJobId?: string;
  createdBy: string;
  createdAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

export interface NeedsYouEvent {
  id: string;
  fromStatus?: NeedsYouStatus;
  toStatus: NeedsYouStatus;
  actor: string;
  optionId?: string;
  note?: string;
  at: string;
}

export interface NeedsYouCount {
  total: number;
  urgent: number;
  byPriority: Record<NeedsYouPriority, number>;
  snoozed: number;
}

export interface NeedsYouDetail {
  item: NeedsYouItem;
  events: NeedsYouEvent[];
  resolverRegistered: boolean;
  resumesJob?: { id: string; type: string; status: string };
}

export interface NeedsYouFilters {
  status?: string;
  kind?: NeedsYouKind | '';
  claimId?: string;
}

export interface ResolveBody {
  optionId: string;
  edits?: unknown;
  note?: string;
}

export const needsYouApi = {
  list: (f: NeedsYouFilters = {}) => request<{ items: NeedsYouItem[]; count: NeedsYouCount }>('/needs-you', { query: { status: f.status, kind: f.kind || undefined, claimId: f.claimId } }),
  count: () => request<NeedsYouCount>('/needs-you/count'),
  get: (id: string) => request<NeedsYouDetail>(`/needs-you/${seg(id)}`),
  resolve: (id: string, body: ResolveBody) => request<{ item: NeedsYouItem; count: NeedsYouCount }>(`/needs-you/${seg(id)}/resolve`, { method: 'POST', body }),
  snooze: (id: string, minutes: number) => request<{ item: NeedsYouItem; count: NeedsYouCount }>(`/needs-you/${seg(id)}/snooze`, { method: 'POST', body: { minutes } }),
};

export const needsYouQk = {
  all: ['needs-you'] as const,
  list: (f: NeedsYouFilters) => ['needs-you', 'list', f] as const,
  count: ['needs-you', 'count'] as const,
  detail: (id: string) => ['needs-you', 'detail', id] as const,
};

/** The top-bar badge polls every 15 seconds (§L.1). */
export const NEEDS_YOU_POLL_MS = 15_000;

export function useNeedsYouCount() {
  return useQuery({ queryKey: needsYouQk.count, queryFn: needsYouApi.count, refetchInterval: NEEDS_YOU_POLL_MS, refetchIntervalInBackground: false, staleTime: 5_000, retry: false });
}

export function useNeedsYouList(f: NeedsYouFilters) {
  return useQuery({ queryKey: needsYouQk.list(f), queryFn: () => needsYouApi.list(f), refetchInterval: NEEDS_YOU_POLL_MS });
}

export function useNeedsYouDetail(id: string | undefined) {
  return useQuery({ queryKey: needsYouQk.detail(id ?? ''), queryFn: () => needsYouApi.get(id!), enabled: Boolean(id) });
}

export function useResolveNeedsYou() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ResolveBody }) => needsYouApi.resolve(id, body),
    onSettled: () => qc.invalidateQueries({ queryKey: needsYouQk.all }),
  });
}

export function useSnoozeNeedsYou() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, minutes }: { id: string; minutes: number }) => needsYouApi.snooze(id, minutes),
    onSettled: () => qc.invalidateQueries({ queryKey: needsYouQk.all }),
  });
}
