/**
 * In-app update check (docs/V03-MANAGER-MODE-HIRE-PRICING.md §F.3). Web code never imports API code, so the HTTP
 * shape of `apps/api/src/services/updates.ts` is declared here.
 *
 *   GET /updates/check            → UpdateCheck (from the server's 1 h cache)
 *   GET /updates/check?force=1    → UpdateCheck (re-checked now; at most once a minute)
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';

export interface UpdateCheck {
  status: 'ok' | 'offline' | 'error' | 'disabled';
  current: string;
  latest?: string;
  updateAvailable: boolean;
  release?: { tag: string; name: string; publishedAt?: string; htmlUrl: string; notes?: string };
  download?: { name: string; url: string; size?: number; sha256?: string };
  checkedAt: string;
  message?: string;
}

/** Where every ClaimDesk Setup is published. */
export const RELEASES_PAGE_URL = 'https://github.com/dannykaleem07-commits/logo/releases';

export const updatesQk = { check: ['updates', 'check'] as const };

/** The side-bar notice re-asks every hour (the server caches a good answer for 1 h anyway). */
export const UPDATE_NOTICE_STALE_MS = 60 * 60 * 1000;
/** After an offline or failed check the notice asks again sooner (the server keeps such an answer for 5 minutes). */
export const UPDATE_NOTICE_RETRY_MS = 10 * 60 * 1000;

/** How long the side-bar waits before asking again: an hour after a good answer, 10 minutes after any other. */
export function updateRecheckMs(data: Pick<UpdateCheck, 'status'> | undefined): number | false {
  if (!data) return UPDATE_NOTICE_RETRY_MS;
  if (data.status === 'disabled') return false;
  return data.status === 'ok' ? UPDATE_NOTICE_STALE_MS : UPDATE_NOTICE_RETRY_MS;
}

const STATUSES = new Set(['ok', 'offline', 'error', 'disabled']);

/** Defensive read of the response: anything unexpected becomes an `error` result rather than a crash. */
export function normaliseUpdateCheck(raw: unknown): UpdateCheck {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<UpdateCheck>;
  const status = typeof r.status === 'string' && STATUSES.has(r.status) ? r.status : 'error';
  const out: UpdateCheck = {
    status,
    current: typeof r.current === 'string' ? r.current : '',
    updateAvailable: status === 'ok' && r.updateAvailable === true,
    checkedAt: typeof r.checkedAt === 'string' ? r.checkedAt : new Date().toISOString(),
  };
  if (typeof r.latest === 'string') out.latest = r.latest;
  if (r.release && typeof r.release === 'object' && typeof r.release.tag === 'string') out.release = r.release;
  if (r.download && typeof r.download === 'object' && typeof r.download.url === 'string' && /^https?:\/\//i.test(r.download.url)) out.download = r.download;
  if (typeof r.message === 'string') out.message = r.message;
  return out;
}

export async function getUpdateCheck(force = false, signal?: AbortSignal): Promise<UpdateCheck> {
  return normaliseUpdateCheck(await request<unknown>('/updates/check', { method: 'GET', query: force ? { force: 1 } : undefined, signal }));
}

/** The cached answer (Settings → Updates and the side-bar notice share it). */
export function useUpdateCheck(options: { staleTime?: number; enabled?: boolean; recheck?: boolean } = {}) {
  return useQuery({
    queryKey: updatesQk.check,
    queryFn: ({ signal }) => getUpdateCheck(false, signal),
    staleTime: options.staleTime ?? UPDATE_NOTICE_STALE_MS,
    ...(options.recheck ? { refetchInterval: (q: { state: { data?: UpdateCheck } }) => updateRecheckMs(q.state.data) } : {}),
    enabled: options.enabled ?? true,
    retry: 0,
    refetchOnWindowFocus: false,
  });
}

/** "Check now": asks the server to re-check and puts the answer in the shared cache. */
export function useCheckNow() {
  const qc = useQueryClient();
  return async (): Promise<UpdateCheck> => {
    const result = await getUpdateCheck(true);
    qc.setQueryData(updatesQk.check, result);
    return result;
  };
}
