import { useMemo } from 'react';
import type { ClaimView } from '../../claimFile';
import { Card } from '../../../../components/Card';
import { DamageModel3D, type DamageMap } from '../../../engineer/damage3d';
import type { VehicleIdentity } from '../../../engineer/damage3d/spec';
import { useClaimDamageZones, type DamageZonesView } from '../../../../api/bundlesApi';

const NO_DAMAGE: DamageMap = {};

/**
 * GET /claims/:id/damage-zones → the model's damage map (docs/SMART-INTAKE.md §11.5): every zone with a severity of 1–3
 * becomes an AI suggestion `{severity, confidence, source:'ai'}`. Anything unexpected (an older API, a malformed body)
 * gives no damage rather than an error.
 */
export function damageFromZones(view: DamageZonesView | null | undefined): DamageMap {
  const zones = view && typeof view === 'object' ? view.zones : undefined;
  if (!zones || typeof zones !== 'object') return NO_DAMAGE;
  const out: DamageMap = {};
  for (const [zoneId, z] of Object.entries(zones)) {
    const severity = Number(z?.severity);
    if (!Number.isInteger(severity) || severity < 1 || severity > 3) continue;
    out[zoneId] = { severity: severity as 1 | 2 | 3, confidence: typeof z.confidence === 'number' ? z.confidence : 0, source: 'ai' };
  }
  return Object.keys(out).length ? out : NO_DAMAGE;
}

/**
 * The client vehicle on the 3D damage model (2D views without WebGL), read-only. Damage recorded from photos and estimate
 * lines at intake (claim damage observations) is shown as AI suggestions; the narrative stays in the engineer's report.
 */
export function DamageModelPanel({ view }: { view: ClaimView }) {
  const zones = useClaimDamageZones(view.claim.id);
  const damage = useMemo(() => damageFromZones(zones.data), [zones.data]);
  const v = view.vehicle;
  const vehicle = useMemo<VehicleIdentity>(
    () => ({
      make: v.make,
      model: v.model,
      ...(v.bodyType ? { body: v.bodyType } : {}),
      ...(v.colour ? { colour: v.colour } : {}),
      ...(v.registration ? { registration: v.registration } : {}),
      ...(v.spec?.doors ? { doors: v.spec.doors } : {}),
      ...(v.yearOfManufacture ? { year: v.yearOfManufacture } : {})
    }),
    [v.make, v.model, v.bodyType, v.colour, v.registration, v.spec?.doors, v.yearOfManufacture]
  );
  return (
    <Card title="Damage model">
      <DamageModel3D bodyType={v.bodyType ?? ''} vehicle={vehicle} damage={damage} />
    </Card>
  );
}
