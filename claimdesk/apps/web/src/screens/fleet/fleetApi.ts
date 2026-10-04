/**
 * Fleet calls the route contract does not spell out. Kept beside the screen so the shared client stays the
 * contract's mirror; the integration stage can fold these into api/client.ts + api/hooks.ts.
 *
 * TODO wire when @ccguk/api lands: confirm PATCH /fleet/:id exists (ARCHITECTURE lists GET/POST /fleet only).
 * Until then an edit falls back to POST /fleet with the unit id, which an API may treat as an upsert.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Id } from '@ccguk/domain';
import { api, isApiError, request, seg, type FleetUnitRow } from '../../api/client';
import type { FleetUnitBody } from './fleet';

export async function updateFleetUnit(id: Id, body: FleetUnitBody): Promise<FleetUnitRow> {
  try {
    return await request<FleetUnitRow>(`/fleet/${seg(id)}`, { method: 'PATCH', body });
  } catch (e) {
    if (isApiError(e) && (e.status === 404 || e.status === 405)) {
      return api.createFleetUnit({ ...body, id });
    }
    throw e;
  }
}

export function useUpdateFleetUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: Id; body: FleetUnitBody }) => updateFleetUnit(id, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['fleet'] })
  });
}
