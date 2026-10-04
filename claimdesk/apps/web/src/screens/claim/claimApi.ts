/**
 * Claim-file routes the shared client does not cover yet. Built on the exported `request` so the error handling
 * and base path stay identical.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import type { Claim, Id } from '@ccguk/domain';
import { api, request, seg, type LabourSuggestionRow } from '../../api/client';
import { useInvalidateClaim } from '../../api/hooks';

export interface LabourSuggestionView {
  panel?: string;
  operation: string;
  suggestedHours: number | null;
  n: number;
  note: string;
}

export interface LabourSuggestQuery {
  make?: string;
  model?: string;
  panel?: string;
  operation: string;
}

/**
 * Pick the row for the requested operation (and panel when given) out of GET /engineering/labour-library/suggest.
 * The API groups by make/model/panel/operation and offers a median only once the group holds enough approved
 * observations; with no row the library simply has nothing for this operation yet. Pure; unit-tested.
 */
export function pickLabourSuggestion(rows: LabourSuggestionRow[], q: LabourSuggestQuery): LabourSuggestionView {
  const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();
  const matches = rows.filter((r) => norm(r.operation) === norm(q.operation) && (!q.panel || !r.panel || norm(r.panel) === norm(q.panel)));
  const row = matches.sort((a, b) => b.count - a.count)[0];
  if (!row) return { panel: q.panel, operation: q.operation, suggestedHours: null, n: 0, note: 'No approved CCGUK estimate holds this operation yet.' };
  return { panel: row.panel ?? q.panel, operation: row.operation ?? q.operation, suggestedHours: row.suggestedHours, n: row.count, note: row.note };
}

export const claimApi = {
  /** POST /claims/:id/flags/:code/clear — a person clears a claim flag with a reason (logged). */
  clearClaimFlag: (claimId: Id, code: string, reason: string) => request<Claim>(`/claims/${seg(claimId)}/flags/${seg(code)}/clear`, { method: 'POST', body: { reason } }),
  /** GET /engineering/labour-library/suggest — medians from CCGUK's own approved estimates (BLUEPRINT §4.5(c)). */
  labourSuggestion: async (q: LabourSuggestQuery, signal?: AbortSignal) => pickLabourSuggestion(await api.labourSuggest(q, signal), q)
};

export function useClearClaimFlag(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: ({ code, reason }: { code: string; reason: string }) => claimApi.clearClaimFlag(claimId, code, reason), onSuccess: () => invalidate(claimId) });
}

export function useLabourSuggestion(q: LabourSuggestQuery | null) {
  return useQuery({
    queryKey: ['engineering', 'labour-library', q] as const,
    queryFn: ({ signal }) => claimApi.labourSuggestion(q!, signal),
    enabled: Boolean(q && q.operation),
    retry: 0,
    staleTime: 5 * 60_000
  });
}
