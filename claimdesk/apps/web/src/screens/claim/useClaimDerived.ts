/**
 * Derived data for one claim: the dedicated route first (useClocks / useGates / useActions / useAcceptance), the
 * copy embedded in GET /claims/:id as the fallback. Nothing is recomputed in the browser.
 */
import type { CaseAcceptance, Clock, GateResult, PlaybookAction } from '@ccguk/domain';
import { useAcceptance, useActions, useClocks, useGates } from '../../api/hooks';
import { pickList, type ClaimView } from './claimFile';

export function useClaimClocks(view: ClaimView): { clocks: Clock[]; isLoading: boolean; error: unknown } {
  const q = useClocks(view.claim.id);
  return { clocks: pickList(q.data, view.clocks), isLoading: q.isLoading && !view.clocks?.length, error: q.error };
}

export function useClaimGates(view: ClaimView): { gates: GateResult[]; isLoading: boolean; error: unknown } {
  const q = useGates(view.claim.id);
  return { gates: pickList(q.data, view.gates), isLoading: q.isLoading && !view.gates?.length, error: q.error };
}

export function useClaimActions(view: ClaimView): { actions: PlaybookAction[]; isLoading: boolean; error: unknown } {
  const q = useActions(view.claim.id);
  return { actions: pickList(q.data, view.actions), isLoading: q.isLoading && !view.actions?.length, error: q.error };
}

export function useClaimAcceptance(view: ClaimView): { acceptance: CaseAcceptance | undefined; isLoading: boolean; error: unknown } {
  const q = useAcceptance(view.claim.id);
  return { acceptance: q.data ?? view.acceptance, isLoading: q.isLoading && !view.acceptance, error: q.error };
}
