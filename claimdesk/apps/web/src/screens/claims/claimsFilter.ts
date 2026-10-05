/** Pure client-side filtering for the claims list (mirrors the server filters; unit-tested). */
import type { ClaimStatus } from '@ccguk/domain';
import type { ClaimSummary } from '../../api/client';
import type { SelectOption } from '../../components/Form';

export interface ClaimsFilterState {
  q: string;
  status: ClaimStatus | '';
  handler: string;
  insurer: string;
}

function norm(s: string | undefined | null): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, '');
}

export function matchesSearch(c: Pick<ClaimSummary, 'reference' | 'claimantName' | 'registration' | 'insurerName' | 'atFaultInsurerRef'>, q: string): boolean {
  const term = norm(q);
  if (!term) return true;
  return [c.reference, c.claimantName, c.registration, c.insurerName, c.atFaultInsurerRef].some((v) => norm(v).includes(term));
}

export function filterClaims(claims: ClaimSummary[], f: ClaimsFilterState): ClaimSummary[] {
  return claims.filter(
    (c) =>
      matchesSearch(c, f.q) &&
      (!f.status || c.status === f.status) &&
      (!f.handler || c.handlerId === f.handler || c.handlerName === f.handler) &&
      (!f.insurer || c.atFaultInsurerId === f.insurer || c.insurerName === f.insurer)
  );
}

/** Distinct (id → label) options from a list; falls back to the id as label; sorted by label. */
export function distinctOptions<T>(rows: T[], id: (r: T) => string | undefined, label: (r: T) => string | undefined): SelectOption[] {
  const map = new Map<string, string>();
  for (const r of rows) {
    const k = id(r) ?? label(r);
    if (!k) continue;
    if (!map.has(k)) map.set(k, label(r) ?? k);
  }
  return [...map.entries()].map(([value, l]) => ({ value, label: l })).sort((a, b) => a.label.localeCompare(b.label));
}

/** How many of the three drop-down filters (status, handler, insurer) are set — the Filters toggle shows it. */
export function activeFilterCount(f: Pick<ClaimsFilterState, 'status' | 'handler' | 'insurer'>): number {
  return [f.status, f.handler, f.insurer].filter(Boolean).length;
}

/** Handler filter options: names from the list rows (GET /claims sends `handlerName`), never a bare user id when a name is known. */
export function handlerOptions(rows: ClaimSummary[]): SelectOption[] {
  const named = new Map<string, string>();
  for (const r of rows) if (r.handlerId && r.handlerName) named.set(r.handlerId, r.handlerName);
  return distinctOptions(rows, (c) => c.handlerId, (c) => (c.handlerId ? named.get(c.handlerId) : undefined) ?? c.handlerName ?? (c.handlerId ? 'Unnamed handler' : undefined));
}
