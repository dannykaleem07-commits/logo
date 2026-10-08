/**
 * The damage view on an imported, licensed model: same contract as the generated ThreeViewport (damage, hover,
 * selection, camera presets, zone picks) so DamageModel3D can swap one for the other:
 *
 *   const exact = useExactModel(vehicle);
 *   exact.status === 'ready'
 *     ? <ExactModelView exact={exact} damage={damage} hovered={…} selected={…} view={view} viewNonce={n} onHover={…} onPick={…} onLoadError={useGenerated} />
 *     : <ThreeViewport … />
 *
 * Parts map to zones through the model's saved zone map (automatic by name, corrected in Settings → 3D models).
 * Parts with no zone are shown but cannot be picked.
 */
import { useCallback, useMemo, useState } from 'react';
import type { ViewPreset } from '../ThreeViewport';
import type { DamageMap } from '../damageModel';
import type { Paint } from '../paint';
import ExactViewport from './ExactViewport';
import { damagePartStyle, MATCHED_ON_LABEL } from './exactModel';
import type { ExactModelState } from './useExactModel';
import './exact.css';

export interface ExactModelViewProps {
  exact: ExactModelState;
  damage: DamageMap;
  hovered: string | null;
  selected: string | null;
  view: ViewPreset;
  viewNonce: number;
  onHover: (zone: string | null, clientX: number, clientY: number) => void;
  onPick: (zone: string, clientX: number, clientY: number) => void;
  onContextLost?: () => void;
  /** The file could not be loaded: the caller should go back to the generated model. */
  onLoadError?: (message: string) => void;
  /** Override the vehicle's paint / registration from the hook. */
  paint?: Paint;
  registration?: string;
  /** Show the "licensed model" badge (default true). */
  showBadge?: boolean;
}

export default function ExactModelView(props: ExactModelViewProps) {
  const { exact, damage, hovered, selected } = props;
  const model = exact.model;
  const [progress, setProgress] = useState<number | null>(0);
  const [error, setError] = useState<string | null>(null);
  const zones = model?.zones ?? {};
  const styleFor = useCallback((key: string) => damagePartStyle(zones[key], damage, hovered, selected), [zones, damage, hovered, selected]);
  const styleKey = useMemo(() => `${hovered ?? ''}|${selected ?? ''}|${Object.entries(damage).map(([z, d]) => `${z}:${d.severity}`).join(',')}`, [damage, hovered, selected]);
  const onHoverPart = useCallback((key: string | null, x: number, y: number) => props.onHover(key ? (zones[key] ?? null) : null, x, y), [zones, props.onHover]); // eslint-disable-line react-hooks/exhaustive-deps
  const onPickPart = useCallback(
    (key: string, x: number, y: number) => {
      const z = zones[key];
      if (z) props.onPick(z, x, y);
    },
    [zones, props.onPick] // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (!model || !exact.url) return null;
  const a = model.assignment;
  return (
    <div className="dmx-wrap">
      <ExactViewport
        url={exact.url}
        record={model}
        styleFor={styleFor}
        styleKey={styleKey}
        view={props.view}
        viewNonce={props.viewNonce}
        paint={props.paint ?? exact.paint}
        {...((props.registration ?? exact.registration) ? { registration: props.registration ?? exact.registration } : {})}
        onHoverPart={onHoverPart}
        onPickPart={onPickPart}
        {...(props.onContextLost ? { onContextLost: props.onContextLost } : {})}
        onProgress={(f) => setProgress(f)}
        onLoaded={() => setProgress(null)}
        onError={(m) => {
          setError(m);
          setProgress(null);
          props.onLoadError?.(m);
        }}
      />
      {progress !== null && !error && (
        <div className="dmx-loading" role="status">
          Loading licensed model… {progress > 0 ? `${Math.round(progress * 100)}%` : ''}
        </div>
      )}
      {error && (
        <div className="dmx-loading dmx-error" role="alert">
          {error}
        </div>
      )}
      {(props.showBadge ?? true) && (
        <div className="dmx-badge" title={`${a.make} ${a.model}${a.generation ? ` ${a.generation}` : ''} — ${exact.matchedOn ? MATCHED_ON_LABEL[exact.matchedOn] : 'imported model'}. Imported under the owner's licence.`}>
          <span className="dmx-dot" aria-hidden="true" />
          Licensed model · {model.title}
        </div>
      )}
    </div>
  );
}
