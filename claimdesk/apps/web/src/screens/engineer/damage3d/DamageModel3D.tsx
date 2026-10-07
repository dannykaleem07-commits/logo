/**
 * ClaimDesk's own vehicle damage model: a procedurally generated low-poly body per body type, one selectable zone per
 * part, coloured by severity. 3D (three.js, lazy chunk) with orbit controls and preset views; 2D SVG views when WebGL is
 * unavailable; an accessible list of damaged parts beside it. Controlled: `damage` in, `onChange` out.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type Ref } from 'react';
import { DamageSvg } from './DamageSvg';
import { vehicleModel } from './geometry';
import {
  SEVERITY_COLOURS,
  SEVERITY_LEGEND,
  damageReducer,
  damageSummary,
  damagedZones,
  describeDamage,
  resolveBody,
  type DamageAction,
  type DamageMap
} from './damageModel';
import {
  DAMAGE_SEVERITIES,
  DAMAGE_SEVERITY_LABELS,
  VEHICLE_BODY_LABELS,
  ZONE_AREA_LABELS,
  ZONE_OPERATION_LABELS,
  getZone,
  zonesByArea,
  type VehicleBodyType
} from './zones';
import type { ViewPreset } from './ThreeViewport';
import './damage3d.css';

const ThreeViewport = lazy(() => import('./ThreeViewport'));

export interface DamageModel3DProps {
  /** A body type, or any body description ("5 DOOR HATCHBACK", "Panel van") — normalised. */
  bodyType: VehicleBodyType | string;
  damage: DamageMap;
  onChange?: (next: DamageMap) => void;
  /** Allow editing. Defaults to true when `onChange` is given. */
  selectable?: boolean;
  /** Height of the model area in px (3D). Default 400. */
  height?: number;
  /** Always use the 2D views (print, tests, low-power devices). */
  forceFallback?: boolean;
  className?: string;
}

const VIEW_BUTTONS: Array<{ id: ViewPreset; label: string }> = [
  { id: 'iso', label: '3/4' },
  { id: 'front', label: 'Front' },
  { id: 'rear', label: 'Rear' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
  { id: 'top', label: 'Top' }
];

export function detectWebGL(): boolean {
  try {
    if (typeof window === 'undefined' || typeof WebGLRenderingContext === 'undefined') return false;
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

interface Pop {
  zone: string;
  x: number;
  y: number;
}

export default function DamageModel3D({ bodyType, damage, onChange, selectable, height = 400, forceFallback = false, className = '' }: DamageModel3DProps) {
  const body = resolveBody(bodyType);
  const model = useMemo(() => vehicleModel(body), [body]);
  const editable = (selectable ?? !!onChange) && !!onChange;
  const [webgl, setWebgl] = useState<boolean>(() => !forceFallback && detectWebGL());
  const [mode, setMode] = useState<'3d' | '2d'>(webgl ? '3d' : '2d');
  const use3d = mode === '3d' && webgl && !forceFallback;
  const [view, setView] = useState<ViewPreset>('iso');
  const [viewNonce, setViewNonce] = useState(0);
  const [hover, setHover] = useState<{ zone: string; x: number; y: number } | null>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const dispatch = useCallback(
    (a: DamageAction) => {
      if (!onChange) return;
      const next = damageReducer(damage, a);
      if (next !== damage) onChange(next);
    },
    [damage, onChange]
  );

  const local = useCallback((clientX: number, clientY: number) => {
    const r = rootRef.current?.getBoundingClientRect();
    return r ? { x: clientX - r.left, y: clientY - r.top } : { x: 0, y: 0 };
  }, []);

  const onHover = useCallback(
    (zone: string | null, cx: number, cy: number) => {
      setHover((h) => {
        if (!zone) return h ? null : h;
        const p = local(cx, cy);
        return { zone, ...p };
      });
    },
    [local]
  );
  const openAt = useCallback(
    (zone: string, cx: number, cy: number) => {
      if (!editable) return;
      const p = local(cx, cy);
      setPop({ zone, ...p });
      setHover(null);
    },
    [editable, local]
  );

  // close the popover on Escape / outside click
  useEffect(() => {
    if (!pop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPop(null);
    };
    const onDown = (e: PointerEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setPop(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [pop]);
  useEffect(() => {
    if (pop) popRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"], button')?.focus();
  }, [pop?.zone]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = damagedZones(damage, body);
  const groups = useMemo(() => zonesByArea(body), [body]);
  const hidden = useCallback((id: string) => !model.zones.has(id), [model]);

  const fromElement = (el: HTMLElement, zone: string) => {
    const r = el.getBoundingClientRect();
    const p = local(r.left, r.bottom);
    setPop({ zone, x: p.x, y: p.y + 4 });
  };

  const onAddPart = (e: ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    if (!id) return;
    fromElement(e.target, id);
    e.target.value = '';
  };

  const highlighted = pop?.zone ?? null;

  return (
    <div ref={rootRef} className={`dm3 ${className}`.trim()}>
      <div className="dm3-stage">
        <div className="dm3-toolbar">
          {use3d ? (
            <div className="dm3-seg" role="group" aria-label="Camera view">
              {VIEW_BUTTONS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  aria-pressed={view === b.id}
                  onClick={() => {
                    setView(b.id);
                    setViewNonce((n) => n + 1);
                  }}
                >
                  {b.label}
                </button>
              ))}
            </div>
          ) : (
            <span className="dm3-muted">{VEHICLE_BODY_LABELS[body]} · 2D views</span>
          )}
          <div className="dm3-seg" role="group" aria-label="Model type">
            <button type="button" aria-pressed={use3d} disabled={!webgl || forceFallback} title={webgl ? undefined : '3D needs WebGL, which this browser has turned off'} onClick={() => setMode('3d')}>
              3D
            </button>
            <button type="button" aria-pressed={!use3d} onClick={() => setMode('2d')}>
              2D
            </button>
          </div>
        </div>

        <div className={`dm3-area ${use3d ? 'dm3-area-3d' : 'dm3-area-2d'}`} style={use3d ? { height } : undefined}>
          {use3d ? (
            <Suspense fallback={<div className="dm3-loading">Loading 3D model…</div>}>
              <ThreeViewport
                model={model}
                damage={damage}
                hovered={hover?.zone ?? null}
                selected={highlighted}
                view={view}
                viewNonce={viewNonce}
                onHover={onHover}
                onPick={openAt}
                onContextLost={() => {
                  setWebgl(false);
                  setMode('2d');
                }}
              />
            </Suspense>
          ) : (
            <DamageSvg model={model} damage={damage} hovered={hover?.zone ?? null} selected={highlighted} onHover={onHover} onPick={openAt} />
          )}
          <ul className="dm3-legend" aria-label="Severity colours">
            {SEVERITY_LEGEND.map((l) => (
              <li key={l.severity}>
                <span className="dm3-swatch" style={{ background: l.colour }} />
                {l.label}
              </li>
            ))}
          </ul>
          {hover && !pop && (
            <div className="dm3-tip" style={{ left: hover.x + 14, top: hover.y + 14 }} role="status">
              <strong>{getZone(hover.zone)?.label}</strong>
              <span>{damage[hover.zone]?.severity ? describeDamage(damage[hover.zone]!) : editable ? 'Click to mark damage' : 'No damage'}</span>
            </div>
          )}
        </div>
        <p className="dm3-hint">{use3d ? 'Drag to turn · scroll or pinch to zoom · ' : ''}{editable ? 'click a part to mark damage' : 'hover a part for details'}</p>
      </div>

      <aside className="dm3-panel" aria-label="Damaged parts">
        <div className="dm3-panel-head">
          <h4>Damage</h4>
          <span className="dm3-muted">{damageSummary(damage)}</span>
        </div>
        {rows.length === 0 ? (
          <p className="dm3-empty">{editable ? 'Nothing marked yet. Click a part on the model, or add one below.' : 'No damage recorded.'}</p>
        ) : (
          <ul className="dm3-rows">
            {rows.map(({ zone, damage: d, onBody }) => (
              <li key={zone.id} className={highlighted === zone.id ? 'is-active' : undefined} onMouseEnter={() => setHover(null)}>
                <span className="dm3-swatch" style={{ background: SEVERITY_COLOURS[d.severity] }} aria-hidden="true" />
                {editable ? (
                  <button type="button" className="dm3-row-main" onClick={(e) => fromElement(e.currentTarget, zone.id)} aria-label={`${zone.label}: ${describeDamage(d)}. Edit`}>
                    <span className="dm3-row-title">{zone.label}</span>
                    <span className="dm3-row-sub">
                      {describeDamage(d)}
                      {!onBody ? ' · not on this body' : hidden(zone.id) ? ' · not shown on model' : ''}
                    </span>
                  </button>
                ) : (
                  <span className="dm3-row-main">
                    <span className="dm3-row-title">{zone.label}</span>
                    <span className="dm3-row-sub">{describeDamage(d)}</span>
                  </span>
                )}
                {editable && (
                  <button type="button" className="dm3-x" aria-label={`Remove damage to ${zone.label}`} onClick={() => dispatch({ type: 'clear', zone: zone.id })}>
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {editable && (
          <div className="dm3-panel-foot">
            <label className="dm3-add">
                            <select className="select" defaultValue="" onChange={onAddPart} aria-label="Add a damaged part">
                <option value="">Add a part…</option>
                {groups.map((g) => (
                  <optgroup key={g.area} label={ZONE_AREA_LABELS[g.area]}>
                    {g.zones.map((z) => (
                      <option key={z.id} value={z.id}>
                        {z.label}
                        {hidden(z.id) ? ' (list only)' : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            {rows.length > 0 && (
              <button type="button" className="dm3-link" onClick={() => dispatch({ type: 'clearAll' })}>
                Clear all
              </button>
            )}
          </div>
        )}
      </aside>

      {pop && editable && <ZonePopover ref={popRef} pop={pop} damage={damage} dispatch={dispatch} onClose={() => setPop(null)} rootWidth={rootRef.current?.clientWidth ?? 0} />}
    </div>
  );
}

interface ZonePopoverProps {
  pop: Pop;
  damage: DamageMap;
  dispatch: (a: DamageAction) => void;
  onClose: () => void;
  rootWidth: number;
  ref?: Ref<HTMLDivElement>;
}

function ZonePopover({ pop, damage, dispatch, onClose, rootWidth, ref }: ZonePopoverProps) {
  const zone = getZone(pop.zone);
  if (!zone) return null;
  const d = damage[zone.id];
  const sev = d?.severity ?? 0;
  const W = 272;
  const left = Math.max(8, Math.min(pop.x + 8, (rootWidth || W + 16) - W - 8));
  return (
    <div ref={ref} className="dm3-pop" role="dialog" aria-label={`Damage to ${zone.label}`} style={{ left, top: pop.y + 8, width: W }}>
      <div className="dm3-pop-head">
        <div>
          <strong>{zone.label}</strong>
          <span className="dm3-muted">{ZONE_AREA_LABELS[zone.area]}</span>
        </div>
        <button type="button" className="dm3-x" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="dm3-pop-label">Severity</div>
      <div className="dm3-sev" role="group" aria-label="Severity">
        {DAMAGE_SEVERITIES.map((s) => (
          <button key={s} type="button" aria-pressed={sev === s} onClick={() => dispatch({ type: 'setSeverity', zone: zone.id, severity: s })}>
            <span className="dm3-swatch" style={{ background: SEVERITY_COLOURS[s] }} aria-hidden="true" />
            {DAMAGE_SEVERITY_LABELS[s]}
          </button>
        ))}
      </div>
      <div className="dm3-pop-label">Operation</div>
      <div className="dm3-ops" role="group" aria-label="Operation">
        {zone.operations.map((op) => (
          <button
            key={op}
            type="button"
            aria-pressed={d?.operation === op}
            disabled={sev === 0}
            onClick={() => dispatch({ type: 'setOperation', zone: zone.id, operation: d?.operation === op ? undefined : op })}
          >
            {ZONE_OPERATION_LABELS[op]}
          </button>
        ))}
      </div>
      {d?.source === 'ai' && (
        <div className="dm3-ai">
          <span>
            Suggested by AI{d.confidence !== undefined ? ` (${Math.round(d.confidence * 100)}% sure)` : ''}. Any change confirms it.
          </span>
          {sev > 0 && (
            <button type="button" className="dm3-link" onClick={() => dispatch({ type: 'confirm', zone: zone.id })}>
              Confirm
            </button>
          )}
        </div>
      )}
    </div>
  );
}
