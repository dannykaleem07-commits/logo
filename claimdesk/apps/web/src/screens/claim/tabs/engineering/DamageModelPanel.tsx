import { useMemo } from 'react';
import type { ClaimView } from '../../claimFile';
import { Card } from '../../../../components/Card';
import { DamageModel3D, type DamageMap } from '../../../engineer/damage3d';
import type { VehicleIdentity } from '../../../engineer/damage3d/spec';

const NO_DAMAGE: DamageMap = {};

/**
 * The client vehicle on the 3D damage model (2D views without WebGL). The claim file holds no per-zone damage record
 * yet, so the model is a read-only view of the vehicle; the damage narrative stays in the engineer's report.
 */
export function DamageModelPanel({ view }: { view: ClaimView }) {
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
      <DamageModel3D bodyType={v.bodyType ?? ''} vehicle={vehicle} damage={NO_DAMAGE} />
    </Card>
  );
}
