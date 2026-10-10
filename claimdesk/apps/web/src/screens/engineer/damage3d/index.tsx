/**
 * Public entry for the damage model. `DamageModel3D` here is a lazy wrapper: the component, its CSS and (only when
 * WebGL is used) three.js load in separate chunks, so importing this file does not grow the main bundle.
 *
 *   <DamageModel3D bodyType="hatchback" damage={map} onChange={setMap} />
 *
 * Routing is left to the integrator; `DamageModelDemoPage` (./DamageModelDemo) is a self-contained demo screen.
 */
import { lazy, Suspense } from 'react';
import type { DamageModel3DProps } from './DamageModel3D';

const Impl = lazy(() => import('./DamageModel3D'));

export function DamageModel3D(props: DamageModel3DProps) {
  return (
    <Suspense fallback={<div style={{ minHeight: props.height ?? 400, display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>Loading damage model…</div>}>
      <Impl {...props} />
    </Suspense>
  );
}

export const DamageModelDemoPage = lazy(() => import('./DamageModelDemo'));

export type { DamageModel3DProps } from './DamageModel3D';
export {
  damageReducer,
  damagedZones,
  damageSummary,
  describeDamage,
  zoneFill,
  SEVERITY_COLOURS,
  SEVERITY_LEGEND,
  type DamageAction,
  type DamageMap,
  type ZoneDamage
} from './damageModel';
