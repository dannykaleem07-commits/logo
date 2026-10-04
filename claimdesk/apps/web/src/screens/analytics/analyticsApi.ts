/**
 * Date-ranged analytics queries. The shared client's analytics calls take no parameters (ARCHITECTURE lists the
 * routes without a query); these pass `from`/`to` through so the screen's range filter works the day the API
 * honours it, and is harmless (ignored) until then. Keys stay under ['analytics', …] so useInvalidateClaim()
 * refreshes them after every write.
 *
 * TODO wire when @ccguk/api lands: move into api/client.ts + api/hooks.ts once the query shape is agreed.
 */
import { useQuery } from '@tanstack/react-query';
import { request, type AnalyticsOverview, type CycleTimesAnalytics, type DebtorDaysSummary, type InterventionsAnalytics, type ReductionsAnalytics } from '../../api/client';
import type { DateRange } from './analytics';

function ranged<T>(path: string, range: DateRange, signal?: AbortSignal) {
  return request<T>(path, { method: 'GET', query: { from: range.from, to: range.to }, signal });
}

export function useOverviewRange(range: DateRange) {
  return useQuery({ queryKey: ['analytics', 'overview', range], queryFn: ({ signal }) => ranged<AnalyticsOverview>('/analytics/overview', range, signal), staleTime: 30_000 });
}
export function useDebtorDaysRange(range: DateRange) {
  return useQuery({ queryKey: ['analytics', 'debtor-days', range], queryFn: ({ signal }) => ranged<DebtorDaysSummary>('/analytics/debtor-days', range, signal), staleTime: 60_000 });
}
export function useReductionsRange(range: DateRange) {
  return useQuery({ queryKey: ['analytics', 'reductions', range], queryFn: ({ signal }) => ranged<ReductionsAnalytics>('/analytics/reductions', range, signal), staleTime: 60_000 });
}
export function useCycleTimesRange(range: DateRange) {
  return useQuery({ queryKey: ['analytics', 'cycle-times', range], queryFn: ({ signal }) => ranged<CycleTimesAnalytics>('/analytics/cycle-times', range, signal), staleTime: 60_000 });
}
export function useInterventionsRange(range: DateRange) {
  return useQuery({ queryKey: ['analytics', 'interventions', range], queryFn: ({ signal }) => ranged<InterventionsAnalytics>('/analytics/interventions', range, signal), staleTime: 60_000 });
}
