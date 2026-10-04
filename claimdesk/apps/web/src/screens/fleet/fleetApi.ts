/**
 * Fleet calls the route contract does not spell out. Kept beside the screen so the shared client stays the
 * contract's mirror; the integration stage can fold these into api/client.ts + api/hooks.ts.
 *
 * `PATCH /fleet/:id` exists in apps/api (routes/fleet.ts, `fleetUnitPatchBody`). There is deliberately no fallback
 * to POST /fleet: a 404 means the unit id is unknown, and re-posting would create a duplicate unit.
 *
 * Since docs/TEMPLATES-VEHICLES-DESKTOP.md §F.2 the PATCH applies vehicle changes too (updateVehicle + an unverified
 * LookupRecord + audit), so the `vehicle` patch is sent as built — it is no longer stripped.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Id } from '@ccguk/domain';
import { request, seg, type FleetUnitRow } from '../../api/client';
import type { DiffersFromVerifiedWarning } from '../../api/vehiclesApi';
import type { FleetUnitPatchBody } from './fleet';

export type FleetUnitPatchResult = FleetUnitRow & { warnings?: DiffersFromVerifiedWarning[] };

export function updateFleetUnit(id: Id, body: FleetUnitPatchBody): Promise<FleetUnitPatchResult> {
  return request<FleetUnitPatchResult>(`/fleet/${seg(id)}`, { method: 'PATCH', body });
}

export function useUpdateFleetUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: Id; body: FleetUnitPatchBody }) => updateFleetUnit(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fleet'] });
      void qc.invalidateQueries({ queryKey: ['vehicles'] });
      void qc.invalidateQueries({ queryKey: ['vehicle'] });
    }
  });
}
