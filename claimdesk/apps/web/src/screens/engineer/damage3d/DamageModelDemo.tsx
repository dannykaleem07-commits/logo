/**
 * Demo screen for the damage model (not routed yet — the integrator can mount it, e.g. at /engineer/damage-model).
 * Body type switcher, sample AI + user damage, and the resulting JSON.
 */
import { useState } from 'react';
import DamageModel3D from './DamageModel3D';
import type { DamageMap } from './damageModel';
import { VEHICLE_BODY_LABELS, VEHICLE_BODY_TYPES, type VehicleBodyType } from './zones';

export const DEMO_DAMAGE: Record<'front' | 'side' | 'rear', DamageMap> = {
  front: {
    front_bumper: { severity: 3, operation: 'replace', source: 'user' },
    bonnet: { severity: 2, operation: 'repair', source: 'user' },
    headlamp_r: { severity: 3, operation: 'replace', source: 'ai', confidence: 0.86 },
    front_wing_r: { severity: 1, operation: 'repair', source: 'ai', confidence: 0.64 },
    grille: { severity: 2, operation: 'replace', source: 'user' }
  },
  side: {
    front_door_l: { severity: 3, operation: 'replace', source: 'user' },
    rear_door_l: { severity: 2, operation: 'repair', source: 'user' },
    sill_l: { severity: 1, operation: 'repair', source: 'ai', confidence: 0.71 },
    door_mirror_l: { severity: 2, operation: 'replace', source: 'user' },
    wheel_fl: { severity: 1, operation: 'repair', source: 'user' },
    front_door_glass_l: { severity: 3, operation: 'replace', source: 'user' }
  },
  rear: {
    rear_bumper: { severity: 3, operation: 'replace', source: 'user' },
    rear_lamp_l: { severity: 2, operation: 'replace', source: 'user' },
    rear_parking_sensors: { severity: 2, operation: 'replace', source: 'ai', confidence: 0.58 },
    rear_panel: { severity: 2, operation: 'repair', source: 'user' }
  }
};

export default function DamageModelDemo({ initialBody = 'hatchback', initialDamage }: { initialBody?: VehicleBodyType; initialDamage?: DamageMap }) {
  const [body, setBody] = useState<VehicleBodyType>(initialBody);
  const [damage, setDamage] = useState<DamageMap>(initialDamage ?? { ...DEMO_DAMAGE.front, ...DEMO_DAMAGE.side });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label htmlFor="dm3-demo-body" style={{ fontWeight: 600 }}>
          Body
        </label>
        <select id="dm3-demo-body" className="select" value={body} onChange={(e) => setBody(e.target.value as VehicleBodyType)} style={{ width: 'auto' }}>
          {VEHICLE_BODY_TYPES.map((b) => (
            <option key={b} value={b}>
              {VEHICLE_BODY_LABELS[b]}
            </option>
          ))}
        </select>
        {(['front', 'side', 'rear'] as const).map((k) => (
          <button key={k} type="button" className="btn btn-sm btn-secondary" onClick={() => setDamage((d) => ({ ...d, ...DEMO_DAMAGE[k] }))}>
            Add {k} hit
          </button>
        ))}
      </div>
      <DamageModel3D bodyType={body} damage={damage} onChange={setDamage} />
      <details>
        <summary>Damage data</summary>
        <pre style={{ fontSize: 12 }}>{JSON.stringify(damage, null, 2)}</pre>
      </details>
    </div>
  );
}
