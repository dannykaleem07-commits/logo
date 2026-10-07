/**
 * 2D fallback (no WebGL, print, tests): the same procedural parts projected onto side / top / front / rear views.
 */
import { memo, useMemo, type MouseEvent } from 'react';
import { projectModel, VIEW_LABELS, type Projection, type Shape2D, type ViewName } from './project';
import type { VehicleModel } from './geometry';
import { HOVER_COLOUR, TONE_COLOURS, zoneFill, type DamageMap } from './damageModel';
import { getZone } from './zones';

export interface DamageSvgProps {
  model: VehicleModel;
  damage: DamageMap;
  hovered: string | null;
  selected: string | null;
  onHover: (zone: string | null, clientX: number, clientY: number) => void;
  onPick: (zone: string, clientX: number, clientY: number) => void;
}

const EDGE = '#6b7a8f';

export function DamageSvg({ model, damage, hovered, selected, onHover, onPick }: DamageSvgProps) {
  const views = useMemo(() => {
    const p = (v: ViewName) => projectModel(model, v);
    return { left: p('left'), right: p('right'), top: p('top'), front: p('front'), rear: p('rear') };
  }, [model]);
  const common = { damage, hovered, selected, onHover, onPick };
  return (
    <div className="dm3-svg-grid" data-testid="damage-2d">
      <ViewSvg proj={views.left} {...common} />
      <ViewSvg proj={views.right} {...common} />
      <ViewSvg proj={views.top} {...common} />
      <div className="dm3-svg-ends">
        <ViewSvg proj={views.front} {...common} />
        <ViewSvg proj={views.rear} {...common} />
      </div>
    </div>
  );
}

interface ViewSvgProps extends Omit<DamageSvgProps, 'model'> {
  proj: Projection;
}

const ViewSvg = memo(function ViewSvg({ proj, damage, hovered, selected, onHover, onPick }: ViewSvgProps) {
  const label = VIEW_LABELS[proj.view];
  return (
    <figure className="dm3-view">
      <svg viewBox={`${proj.minX} ${proj.minY} ${proj.width} ${proj.height}`} role="img" aria-label={`${label} view`} preserveAspectRatio="xMidYMid meet">
        {proj.shapes.map((s) => (
          <ShapeEl key={s.key} s={s} damage={damage} hot={s.zone !== null && (s.zone === hovered || s.zone === selected)} onHover={onHover} onPick={onPick} />
        ))}
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  );
});

function ShapeEl({ s, damage, hot, onHover, onPick }: { s: Shape2D; damage: DamageMap; hot: boolean; onHover: DamageSvgProps['onHover']; onPick: DamageSvgProps['onPick'] }) {
  const zone = s.zone;
  const fill = zoneFill(s.tone, zone ? damage[zone] : undefined);
  const handlers = zone
    ? {
        className: 'dm3-zone',
        'data-zone': zone,
        onClick: (e: MouseEvent) => onPick(zone, e.clientX, e.clientY),
        onMouseEnter: (e: MouseEvent) => onHover(zone, e.clientX, e.clientY),
        onMouseMove: (e: MouseEvent) => onHover(zone, e.clientX, e.clientY),
        onMouseLeave: () => onHover(null, 0, 0)
      }
    : { className: 'dm3-fill' };
  const title = zone ? <title>{getZone(zone)?.label ?? zone}</title> : null;
  const stroke = hot ? HOVER_COLOUR : EDGE;
  const sw = hot ? 2 : 0.75;
  if (s.kind === 'circle') {
    const rimFill = zone && damage[zone]?.severity ? fill : TONE_COLOURS.frame;
    return (
      <g {...handlers}>
        {title}
        <circle cx={s.cx} cy={s.cy} r={s.r} fill={fill} stroke={stroke} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
        <circle cx={s.cx} cy={s.cy} r={(s.r ?? 0) * 0.6} fill={rimFill} stroke={stroke} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
      </g>
    );
  }
  if (s.kind === 'line') {
    return (
      <g {...handlers}>
        {title}
        <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={hot ? HOVER_COLOUR : EDGE} strokeWidth={(s.strokeWidth ?? 4) + 1.5} strokeLinecap="round" />
        <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={fill} strokeWidth={s.strokeWidth} strokeLinecap="round" />
      </g>
    );
  }
  return (
    <path d={s.d} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" vectorEffect="non-scaling-stroke" {...handlers}>
      {title}
    </path>
  );
}
