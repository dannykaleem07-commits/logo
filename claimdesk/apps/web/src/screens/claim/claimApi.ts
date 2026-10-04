/**
 * Claim-file routes the shared client does not cover yet. Built on the exported `request` so the error handling
 * and base path stay identical. TODO wire when @ccguk/api lands: fold these into api/client.ts.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import type { Claim, Id } from '@ccguk/domain';
import { request, seg } from '../../api/client';
import { useInvalidateClaim } from '../../api/hooks';

export interface LabourSuggestionView {
  panel?: string;
  operation: string;
  suggestedHours: number | null;
  n: number;
  note: string;
}

export const claimApi = {
  /** POST /claims/:id/flags/:code/clear — a person clears a claim flag with a reason (logged). */
  clearClaimFlag: (claimId: Id, code: string, reason: string) => request<Claim>(`/claims/${seg(claimId)}/flags/${seg(code)}/clear`, { method: 'POST', body: { reason } }),
  /**
   * GET /claims/:id/estimate/labour-library?panel=&operation= — medians from CCGUK's own approved estimates
   * (@ccguk/domain estimate.LabourLibrary). Not in the route contract yet: a 404 is shown as "no library data".
   */
  labourSuggestion: (claimId: Id, q: { panel?: string; operation: string }, signal?: AbortSignal) =>
    request<LabourSuggestionView>(`/claims/${seg(claimId)}/estimate/labour-library`, { method: 'GET', query: q, signal })
};

export function useClearClaimFlag(claimId: Id) {
  const invalidate = useInvalidateClaim();
  return useMutation({ mutationFn: ({ code, reason }: { code: string; reason: string }) => claimApi.clearClaimFlag(claimId, code, reason), onSuccess: () => invalidate(claimId) });
}

export function useLabourSuggestion(claimId: Id, q: { panel?: string; operation: string } | null) {
  return useQuery({
    queryKey: ['claim', claimId, 'labour-library', q] as const,
    queryFn: ({ signal }) => claimApi.labourSuggestion(claimId, q!, signal),
    enabled: Boolean(q && q.operation),
    retry: 0,
    staleTime: 5 * 60_000
  });
}
