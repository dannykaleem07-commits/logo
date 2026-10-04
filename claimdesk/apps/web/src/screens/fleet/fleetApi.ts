/**
 * Fleet calls the route contract does not spell out. Kept beside the screen so the shared client stays the
 * contract's mirror; the integration stage can fold these into api/client.ts + api/hooks.ts.
 *
 * `PATCH /fleet/:id` exists in apps/api (routes/fleet.ts, `fleetUnitPatchBody`). There is deliberately no fallback
 * to POST /fleet: a 404 means the unit id is unknown, and re-posting would create a duplicate unit.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Id } from '@ccguk/domain';
import { request, seg, type FleetUnitRow } from '../../api/client';
import type { FleetUnitBody } from './fleet';

export function updateFleetUnit(id: Id, body: FleetUnitBody): Promise<FleetUnitRow> {
  // The patch schema takes the unit's own fields; vehicle details are edited on the vehicle (ignored here by the API).
  const { vehicle: _vehicle, ...unit } = body;
  return request<FleetUnitRow>(`/fleet/${seg(id)}`, { method: 'PATCH', body: unit });
}

export function useUpdateFleetUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: Id; body: FleetUnitBody }) => updateFleetUnit(id, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['fleet'] })
  });
}
