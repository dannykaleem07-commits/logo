/**
 * Exact (licensed) 3D models for the damage view — the public surface for DamageModel3D.
 *
 *   import { useExactModel, ExactModelView } from './exact';
 *   const exact = useExactModel(vehicle);                 // light: no three.js in this import
 *   {exact.status === 'ready' ? <ExactModelView exact={exact} … /> : <ThreeViewport … />}
 *
 * `ExactModelView` here is a lazy wrapper (three.js + GLTFLoader load in their own chunk, only when a model exists).
 * The one-line switch inside DamageModel3D is left to the integrator (the true-3d slice owns that file).
 */
import { createElement, lazy, Suspense } from 'react';
import type { ExactModelViewProps } from './ExactModelView';

const Impl = lazy(() => import('./ExactModelView'));

export function ExactModelView(props: ExactModelViewProps) {
  return createElement(Suspense, { fallback: createElement('div', { className: 'dm3-loading' }, 'Loading licensed model…') }, createElement(Impl, props));
}

export type { ExactModelViewProps } from './ExactModelView';
export { useExactModel, clearExactModelCache, type ExactModelState, type ExactModelStatus, type UseExactModelOptions, type ExactModelFetcher } from './useExactModel';
export { matchQueryFor, type ExactModelVehicle } from './exactModel';
export { LICENCE_NOTICE, models3dApi, type Model3dView, type Model3dSummary, type Model3dMatch } from './exactApi';
