/**
 * Orthographic projection of the procedural vehicle onto the five 2D views used by the SVG fallback (and print).
 * Painter's order: layer first (filler under panels under glass/lamps under details), then far-to-near.
 */
import { outwardNormal, type Part, type Tone, type Vec3, type VehicleModel } from './geometry';

export type ViewName = 'left' | 'top' | 'right' | 'front' | 'rear';

export const VIEW_LABELS: Record<ViewName, string> = {
  left: 'Left side (N/S)',
  right: 'Right side (O/S)',
  top: 'Top',
  front: 'Front',
  rear: 'Rear'
};

interface ViewBasis {
  fwd: Vec3; // camera look direction
  right: Vec3; // screen +x
  up: Vec3; // screen up (SVG y is flipped)
  side: boolean;
}

const VIEWS: Record<ViewName, ViewBasis> = {
  left: { fwd: [0, 0, 1], right: [-1, 0, 0], up: [0, 1, 0], side: true },
  right: { fwd: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], side: true },
  top: { fwd: [0, -1, 0], right: [1, 0, 0], up: [0, 0, -1], side: false },
  front: { fwd: [-1, 0, 0], right: [0, 0, -1], up: [0, 1, 0], side: false },
  rear: { fwd: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0], side: false }
};

export interface Shape2D {
  key: string;
  zone: string | null;
  tone: Tone;
  layer: number;
  depth: number;
  kind: 'path' | 'circle' | 'line';
  d?: string;
  cx?: number;
  cy?: number;
  r?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  strokeWidth?: number;
}

export interface Projection {
  view: ViewName;
  shapes: Shape2D[];
  /** viewBox in projected units (centimetres). */
  minX: number;
  minY: number;
  width: number;
  height: number;
}

const S = 100; // metres → centimetres, keeps path numbers short
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const r1 = (n: number) => Math.round(n * 10) / 10;

export function projectModel(model: VehicleModel, view: ViewName): Projection {
  const v = VIEWS[view];
  const px = (p: Vec3): [number, number] => [r1(dot(p, v.right) * S), r1(-dot(p, v.up) * S)];
  const shapes: Shape2D[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  // in side views, details on the far side are hidden behind the body
  const farSide = (c: Vec3) => v.side && dot(c, v.fwd) > 0.2;

  model.parts.forEach((part: Part, i) => {
    const key = `${view}-${i}`;
    if (part.type === 'poly') {
      const n = outwardNormal(part);
      if (dot(n, v.fwd) > -0.25) return; // facing away or edge-on
      const pts = part.pts.map(px);
      pts.forEach(([x, y]) => grow(x, y));
      const depth = part.pts.reduce((a, p) => a + dot(p, v.fwd), 0) / part.pts.length;
      shapes.push({ key, zone: part.zone, tone: part.tone, layer: part.layer, depth, kind: 'path', d: `M${pts.map(([x, y]) => `${x} ${y}`).join('L')}Z` });
    } else if (part.type === 'wheel') {
      if (view === 'top' || farSide(part.center)) return;
      const depth = dot(part.center, v.fwd);
      if (v.side) {
        const [cx, cy] = px(part.center);
        const r = r1(part.radius * S);
        grow(cx - r, cy - r);
        grow(cx + r, cy + r);
        shapes.push({ key, zone: part.zone, tone: 'tyre', layer: part.layer, depth, kind: 'circle', cx, cy, r });
      } else {
        const box = boxPath(part.center, [part.radius * 2, part.radius * 2, part.width], px);
        box.pts.forEach(([x, y]) => grow(x, y));
        shapes.push({ key, zone: part.zone, tone: 'tyre', layer: part.layer, depth, kind: 'path', d: box.d });
      }
    } else if (part.type === 'box') {
      if (farSide(part.center)) return;
      const box = boxPath(part.center, part.size, px);
      box.pts.forEach(([x, y]) => grow(x, y));
      shapes.push({ key, zone: part.zone, tone: part.tone, layer: part.layer, depth: dot(part.center, v.fwd), kind: 'path', d: box.d });
    } else {
      const mid: Vec3 = [(part.a[0] + part.b[0]) / 2, (part.a[1] + part.b[1]) / 2, (part.a[2] + part.b[2]) / 2];
      if (farSide(mid)) return;
      const [x1, y1] = px(part.a);
      const [x2, y2] = px(part.b);
      if (Math.hypot(x2 - x1, y2 - y1) < 1) return; // seen end-on
      grow(x1, y1);
      grow(x2, y2);
      shapes.push({ key, zone: part.zone, tone: part.tone, layer: part.layer, depth: dot(mid, v.fwd), kind: 'line', x1, y1, x2, y2, strokeWidth: r1(part.thickness * S) });
    }
  });

  shapes.sort((a, b) => a.layer - b.layer || b.depth - a.depth);
  if (!shapes.length) return { view, shapes, minX: 0, minY: 0, width: 1, height: 1 };
  const pad = 8;
  return { view, shapes, minX: minX - pad, minY: minY - pad, width: maxX - minX + 2 * pad, height: maxY - minY + 2 * pad };
}

function boxPath(c: Vec3, size: Vec3, px: (p: Vec3) => [number, number]): { d: string; pts: Array<[number, number]> } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const [x, y] = px([c[0] + (sx * size[0]) / 2, c[1] + (sy * size[1]) / 2, c[2] + (sz * size[2]) / 2]);
    xs.push(x);
    ys.push(y);
  }
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const pts: Array<[number, number]> = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return { d: `M${x0} ${y0}L${x1} ${y0}L${x1} ${y1}L${x0} ${y1}Z`, pts };
}
