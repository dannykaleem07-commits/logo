/**
 * Procedural low-poly vehicle bodies for the damage model. Pure data (no three.js): every body type is described by a
 * handful of stations (bumpers, axles, windscreen, roof, doors) and turned into flat polygons, wheels, boxes and beams,
 * each tagged with the zone it belongs to. The 3D viewport triangulates these; the 2D fallback projects the very same
 * parts orthographically, so both views always show the same zones. No external model files, nothing licensed.
 *
 * Axes (metres): x along the car, front = +x; y up from the ground; z across, right (O/S) = +z, left (N/S) = −z.
 */
import type { VehicleBodyType } from './zones';

export type Vec3 = [number, number, number];
type P2 = [number, number];

/** Base finish of a part when undamaged. */
export type Tone = 'body' | 'frame' | 'trim' | 'glass' | 'lamp' | 'soft' | 'tyre';

interface PartBase {
  zone: string | null; // null = non-interactive filler
  tone: Tone;
  /** Stacking: 0 filler, 1 panels, 2 overlays (glass, lamps, grilles), 3 details, 4 mirrors. −1 wheels. */
  layer: number;
}
export interface PolyPart extends PartBase {
  type: 'poly';
  pts: Vec3[];
  /** Rough outward direction; the true normal is oriented to agree with it. */
  facing: Vec3;
}
export interface WheelPart extends PartBase {
  type: 'wheel';
  zone: string;
  center: Vec3;
  radius: number;
  width: number;
}
export interface BoxPart extends PartBase {
  type: 'box';
  center: Vec3;
  size: Vec3;
}
export interface BeamPart extends PartBase {
  type: 'beam';
  a: Vec3;
  b: Vec3;
  thickness: number;
}
export type Part = PolyPart | WheelPart | BoxPart | BeamPart;

export interface VehicleModel {
  body: VehicleBodyType;
  parts: Part[];
  length: number;
  width: number;
  height: number;
  /** Zones with at least one visible part. Zones not in here (underbody, interior, hidden structure) are list-only. */
  zones: ReadonlySet<string>;
}

interface DoorSpec {
  zone: string;
  x0: number;
  x1: number;
  /** Van sliding door: runs up to the roof instead of the waist line. */
  tall?: boolean;
}
interface WindowSpec {
  zone: string | null;
  x0: number;
  x1: number;
}
interface Layout {
  L: number;
  W: number;
  roofW: number;
  sill: number;
  belt: number;
  roof: number;
  nose: number;
  bumperF: number;
  bumperR: number;
  noseSlope: number;
  tailSlope: number;
  wheelR: number;
  wheelFx: number;
  wheelRx: number;
  wsBase: number;
  wsTop: number;
  roofEnd: number;
  rear: 'hatch' | 'boot' | 'van' | 'bed';
  deckStart?: number;
  doors: DoorSpec[];
  windows: WindowSpec[];
  bedFloor?: number;
  roofRails?: boolean;
  archTrims?: boolean;
  softTop?: boolean;
  spoiler?: boolean;
  mirror?: Vec3;
  tyreW?: number;
}

const LAYOUTS: Record<VehicleBodyType, Layout> = {
  hatchback: {
    L: 4.1, W: 1.78, roofW: 1.4, sill: 0.24, belt: 0.96, roof: 1.46, nose: 0.8, bumperF: 0.56, bumperR: 0.6, noseSlope: 0.12, tailSlope: 0.06,
    wheelR: 0.32, wheelFx: 1.21, wheelRx: -1.35, wsBase: 0.62, wsTop: -0.12, roofEnd: -1.62, rear: 'hatch', spoiler: true,
    doors: [{ zone: 'front_door', x0: -0.3, x1: 0.6 }, { zone: 'rear_door', x0: -0.98, x1: -0.3 }],
    windows: [{ zone: 'front_door_glass', x0: -0.3, x1: 0.6 }, { zone: 'rear_door_glass', x0: -0.98, x1: -0.3 }, { zone: 'quarter_glass', x0: -2.1, x1: -0.98 }]
  },
  saloon: {
    L: 4.65, W: 1.82, roofW: 1.42, sill: 0.24, belt: 0.95, roof: 1.44, nose: 0.78, bumperF: 0.55, bumperR: 0.62, noseSlope: 0.12, tailSlope: 0.04,
    wheelR: 0.33, wheelFx: 1.425, wheelRx: -1.375, wsBase: 0.8, wsTop: 0.05, roofEnd: -1.05, rear: 'boot', deckStart: -1.55, spoiler: true,
    doors: [{ zone: 'front_door', x0: -0.2, x1: 0.78 }, { zone: 'rear_door', x0: -1.0, x1: -0.2 }],
    windows: [{ zone: 'front_door_glass', x0: -0.2, x1: 0.78 }, { zone: 'rear_door_glass', x0: -1.0, x1: -0.2 }, { zone: 'quarter_glass', x0: -2.0, x1: -1.0 }]
  },
  estate: {
    L: 4.7, W: 1.82, roofW: 1.42, sill: 0.24, belt: 0.96, roof: 1.48, nose: 0.78, bumperF: 0.55, bumperR: 0.6, noseSlope: 0.12, tailSlope: 0.05,
    wheelR: 0.33, wheelFx: 1.45, wheelRx: -1.35, wsBase: 0.82, wsTop: 0.07, roofEnd: -2.1, rear: 'hatch', roofRails: true, spoiler: true,
    doors: [{ zone: 'front_door', x0: -0.18, x1: 0.8 }, { zone: 'rear_door', x0: -0.98, x1: -0.18 }],
    windows: [{ zone: 'front_door_glass', x0: -0.18, x1: 0.8 }, { zone: 'rear_door_glass', x0: -0.98, x1: -0.18 }, { zone: 'quarter_glass', x0: -2.4, x1: -0.98 }]
  },
  coupe: {
    L: 4.45, W: 1.82, roofW: 1.36, sill: 0.22, belt: 0.92, roof: 1.36, nose: 0.74, bumperF: 0.52, bumperR: 0.6, noseSlope: 0.14, tailSlope: 0.05,
    wheelR: 0.33, wheelFx: 1.345, wheelRx: -1.325, wsBase: 0.62, wsTop: -0.2, roofEnd: -0.95, rear: 'boot', deckStart: -1.75, spoiler: true,
    doors: [{ zone: 'front_door', x0: -0.75, x1: 0.6 }],
    windows: [{ zone: 'front_door_glass', x0: -0.75, x1: 0.6 }, { zone: 'quarter_glass', x0: -2.0, x1: -0.75 }]
  },
  convertible: {
    L: 4.45, W: 1.82, roofW: 1.32, sill: 0.22, belt: 0.92, roof: 1.3, nose: 0.74, bumperF: 0.52, bumperR: 0.6, noseSlope: 0.14, tailSlope: 0.05,
    wheelR: 0.33, wheelFx: 1.345, wheelRx: -1.325, wsBase: 0.62, wsTop: -0.12, roofEnd: -0.95, rear: 'boot', deckStart: -1.65, softTop: true, spoiler: true,
    doors: [{ zone: 'front_door', x0: -0.75, x1: 0.6 }],
    windows: [{ zone: 'front_door_glass', x0: -0.75, x1: 0.6 }, { zone: 'quarter_glass', x0: -2.0, x1: -0.75 }]
  },
  suv: {
    L: 4.55, W: 1.88, roofW: 1.56, sill: 0.4, belt: 1.1, roof: 1.7, nose: 0.98, bumperF: 0.7, bumperR: 0.75, noseSlope: 0.1, tailSlope: 0.05,
    wheelR: 0.37, wheelFx: 1.395, wheelRx: -1.325, wsBase: 0.8, wsTop: 0.1, roofEnd: -1.95, rear: 'hatch', roofRails: true, archTrims: true, spoiler: true,
    doors: [{ zone: 'front_door', x0: -0.2, x1: 0.78 }, { zone: 'rear_door', x0: -0.9, x1: -0.2 }],
    windows: [{ zone: 'front_door_glass', x0: -0.2, x1: 0.78 }, { zone: 'rear_door_glass', x0: -0.9, x1: -0.2 }, { zone: 'quarter_glass', x0: -2.3, x1: -0.9 }],
    tyreW: 0.24
  },
  mpv: {
    L: 4.6, W: 1.85, roofW: 1.55, sill: 0.26, belt: 1.0, roof: 1.75, nose: 0.82, bumperF: 0.56, bumperR: 0.6, noseSlope: 0.16, tailSlope: 0.05,
    wheelR: 0.33, wheelFx: 1.4, wheelRx: -1.45, wsBase: 1.0, wsTop: 0.05, roofEnd: -2.05, rear: 'hatch', spoiler: true,
    doors: [{ zone: 'front_door', x0: -0.05, x1: 0.98 }, { zone: 'sliding_door', x0: -0.95, x1: -0.05 }],
    windows: [{ zone: 'front_door_glass', x0: -0.05, x1: 0.98 }, { zone: null, x0: -0.95, x1: -0.05 }, { zone: 'quarter_glass', x0: -2.3, x1: -0.95 }]
  },
  'panel-van': {
    L: 5.0, W: 1.95, roofW: 1.95, sill: 0.38, belt: 1.05, roof: 2.05, nose: 0.95, bumperF: 0.62, bumperR: 0.62, noseSlope: 0.25, tailSlope: 0,
    wheelR: 0.36, wheelFx: 1.65, wheelRx: -1.45, wsBase: 1.3, wsTop: 0.55, roofEnd: -2.43, rear: 'van',
    doors: [{ zone: 'front_door', x0: 0.25, x1: 1.22 }, { zone: 'sliding_door', x0: -0.85, x1: 0.25, tall: true }],
    windows: [{ zone: 'front_door_glass', x0: 0.25, x1: 1.22 }],
    mirror: [0.12, 0.26, 0.2],
    tyreW: 0.24
  },
  pickup: {
    L: 5.3, W: 1.86, roofW: 1.62, sill: 0.48, belt: 1.15, roof: 1.82, nose: 1.05, bumperF: 0.75, bumperR: 0.8, noseSlope: 0.08, tailSlope: 0,
    wheelR: 0.38, wheelFx: 1.75, wheelRx: -1.45, wsBase: 1.05, wsTop: 0.35, roofEnd: -0.95, rear: 'bed', bedFloor: 0.9, archTrims: true,
    doors: [{ zone: 'front_door', x0: 0.05, x1: 1.03 }, { zone: 'rear_door', x0: -0.93, x1: 0.05 }],
    windows: [{ zone: 'front_door_glass', x0: 0.05, x1: 1.03 }, { zone: 'rear_door_glass', x0: -0.93, x1: 0.05 }],
    tyreW: 0.26
  }
};

const C = 0.09; // vertical corner chamfer
const BP = 0.07; // bumper protrusion
const WRAP = 0.3; // bumper wrap-round length along the sides
const SILL_H = 0.08;
const GAP = 0.012; // panel shut-line gap

// ── 2D polygon helpers ──

function signedArea(poly: P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Sutherland–Hodgman: keep the part of `poly` where a·x + b·y + c ≥ 0. */
function clipHalf(poly: P2[], a: number, b: number, c: number): P2[] {
  const out: P2[] = [];
  const f = (p: P2) => a * p[0] + b * p[1] + c;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const fp = f(p);
    const fq = f(q);
    if (fp >= 0) out.push(p);
    if (fp >= 0 !== fq >= 0) {
      const t = fp / (fp - fq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

export function clipXRange(poly: P2[], x0: number, x1: number): P2[] {
  return clipHalf(clipHalf(poly, 1, 0, -x0), -1, 0, x1);
}

/** Shrink a convex polygon by `d` on every edge. */
export function insetConvex(poly: P2[], d: number): P2[] {
  if (poly.length < 3) return [];
  const ccw = signedArea(poly) > 0;
  let out = poly;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const nx = (ccw ? -dy : dy) / len;
    const ny = (ccw ? dx : -dx) / len;
    out = clipHalf(out, nx, ny, -(nx * p[0] + ny * p[1]) - d);
    if (out.length < 3) return [];
  }
  return out;
}

// ── builder ──

export function buildVehicle(body: VehicleBodyType): VehicleModel {
  const g = LAYOUTS[body];
  const { L, W, roofW, sill, belt, roof, nose, bumperF, bumperR, wheelR } = g;
  const xF = L / 2;
  const xR = -L / 2;
  const hw = W / 2;
  const parts: Part[] = [];
  const topR = g.rear === 'van' ? roof : belt; // top of the rear face

  const fx = (y: number) => (y < bumperF ? xF : xF - BP - (g.noseSlope * (y - bumperF)) / (nose - bumperF));
  const rx = (y: number) => (y < bumperR ? xR : xR + BP + (g.tailSlope * (y - bumperR)) / (topR - bumperR));
  const zSide = (y: number) => (y <= belt ? hw : hw - ((W - roofW) / 2) * Math.min(1, (y - belt) / (roof - belt)));
  const sideZone = (base: string | null, s: number) => (base ? `${base}_${s < 0 ? 'l' : 'r'}` : null);

  const poly = (zone: string | null, tone: Tone, layer: number, pts: Vec3[], facing: Vec3) => {
    if (pts.length >= 3) parts.push({ type: 'poly', zone, tone, layer, pts, facing });
  };
  const side = (s: number, zone: string | null, tone: Tone, layer: number, pts: P2[]) =>
    poly(zone, tone, layer, pts.map(([x, y]) => [x, y, s * zSide(y)] as Vec3), [0, 0, s]);
  /** A quad on the front face (x follows the nose slope), z0..z1 × y0..y1. */
  const frontQuad = (zone: string | null, tone: Tone, layer: number, z0: number, z1: number, y0: number, y1: number) =>
    poly(zone, tone, layer, [[fx(y0), y0, z0], [fx(y0), y0, z1], [fx(y1), y1, z1], [fx(y1), y1, z0]], [1, 0, 0]);
  const rearQuad = (zone: string | null, tone: Tone, layer: number, z0: number, z1: number, y0: number, y1: number) =>
    poly(zone, tone, layer, [[rx(y0), y0, z0], [rx(y0), y0, z1], [rx(y1), y1, z1], [rx(y1), y1, z0]], [-1, 0, 0]);
  const frontChamfer = (zone: string | null, tone: Tone, layer: number, s: number, y0: number, y1: number) =>
    poly(zone, tone, layer, [[fx(y0), y0, s * (hw - C)], [fx(y0) - C, y0, s * hw], [fx(y1) - C, y1, s * hw], [fx(y1), y1, s * (hw - C)]], [1, 0, s]);
  const rearChamfer = (zone: string | null, tone: Tone, layer: number, s: number, y0: number, y1: number) =>
    poly(zone, tone, layer, [[rx(y0), y0, s * (hw - C)], [rx(y0) + C, y0, s * hw], [rx(y1) + C, y1, s * hw], [rx(y1), y1, s * (hw - C)]], [-1, 0, s]);

  // wheel arch cut-out along the sill line, left → right over the top
  const archR = wheelR + 0.04;
  const arc = (wx: number, r: number, n = 10): P2[] => {
    const t0 = Math.asin(Math.max(-1, Math.min(1, (sill - wheelR) / r)));
    const pts: P2[] = [];
    for (let i = 0; i <= n; i++) {
      const th = Math.PI - t0 + ((2 * t0 - Math.PI) * i) / n;
      pts.push([wx + r * Math.cos(th), wheelR + r * Math.sin(th)]);
    }
    return pts;
  };

  // ── front end ──
  const fBumper = 'front_bumper';
  poly(fBumper, 'body', 1, [[xF, sill, -(hw - C)], [xF, sill, hw - C], [xF, bumperF, hw - C], [xF, bumperF, -(hw - C)]], [1, 0, 0]);
  poly(
    fBumper,
    'body',
    1,
    [[xF - BP - C, bumperF, -hw], [xF - C, bumperF, -hw], [xF, bumperF, -(hw - C)], [xF, bumperF, hw - C], [xF - C, bumperF, hw], [xF - BP - C, bumperF, hw], [xF - BP, bumperF, hw - C], [xF - BP, bumperF, -(hw - C)]],
    [0, 1, 0]
  );
  const bumpH = bumperF - sill;
  const lgY0 = sill + 0.06;
  const lgY1 = sill + Math.max(0.12, bumpH * 0.42);
  poly('front_lower_grille', 'trim', 2, [[xF, lgY0, -W * 0.24], [xF, lgY0, W * 0.24], [xF, lgY1, W * 0.24], [xF, lgY1, -W * 0.24]], [1, 0, 0]);
  const radarY = (lgY0 + lgY1) / 2;
  poly('front_radar', 'frame', 3, [[xF, radarY - 0.035, -0.06], [xF, radarY - 0.035, 0.06], [xF, radarY + 0.035, 0.06], [xF, radarY + 0.035, -0.06]], [1, 0, 0]);
  const sensorY = bumperF - 0.07;
  for (const zc of [-W * 0.36, -W * 0.16, W * 0.16, W * 0.36]) {
    poly('front_parking_sensors', 'frame', 3, [[xF, sensorY - 0.018, zc - 0.018], [xF, sensorY - 0.018, zc + 0.018], [xF, sensorY + 0.018, zc + 0.018], [xF, sensorY + 0.018, zc - 0.018]], [1, 0, 0]);
  }
  const fogY0 = sill + 0.07;
  for (const s of [-1, 1]) {
    poly(fBumper, 'body', 1, [[xF, sill, s * (hw - C)], [xF - C, sill, s * hw], [xF - C, bumperF, s * hw], [xF, bumperF, s * (hw - C)]], [1, 0, s]);
    poly(fBumper, 'body', 1, [[xF - C, sill, s * hw], [xF - WRAP, sill, s * hw], [xF - WRAP, bumperF, s * hw], [xF - C, bumperF, s * hw]], [0, 0, s]);
    poly(sideZone('fog_lamp', s), 'lamp', 2, [[xF, fogY0, s * W * 0.3], [xF, fogY0, s * W * 0.39], [xF, fogY0 + 0.07, s * W * 0.39], [xF, fogY0 + 0.07, s * W * 0.3]], [1, 0, 0]);
  }
  // face above the bumper: filler, headlamps (wrapping round the corner), grille
  frontQuad(null, 'body', 0, -(hw - C), hw - C, bumperF, nose);
  const hlW = W * 0.17;
  const hlY0 = nose - Math.min(0.17, (nose - bumperF) * 0.6);
  const hlY1 = nose - 0.015;
  for (const s of [-1, 1]) {
    frontChamfer(null, 'body', 0, s, bumperF, nose);
    frontQuad(sideZone('headlamp', s), 'lamp', 2, s * (hw - C - hlW), s * (hw - C), hlY0, hlY1);
    frontChamfer(sideZone('headlamp', s), 'lamp', 2, s, hlY0, hlY1);
  }
  const grilleHalf = Math.min(hw - C - hlW - 0.05, W * 0.25);
  frontQuad('grille', 'trim', 2, -grilleHalf, grilleHalf, bumperF + 0.03, nose - 0.035);

  // bonnet: full-width filler (wing tops) + bonnet panel between the shut lines
  const xn = fx(nose);
  poly(null, 'body', 0, [[g.wsBase, belt, -hw], [g.wsBase, belt, hw], [xn - C, nose, hw], [xn, nose, hw - C], [xn, nose, -(hw - C)], [xn - C, nose, -hw]], [0.2, 1, 0]);
  poly('bonnet', 'body', 1, [[g.wsBase, belt, -(hw - C)], [g.wsBase, belt, hw - C], [xn, nose, hw - C], [xn, nose, -(hw - C)]], [0.2, 1, 0]);

  // windscreen: frame + glass
  const slope = (b: [number, number, number], t: [number, number, number]) => ({
    at: (u: number, v: number): Vec3 => {
      const x = b[0] + (t[0] - b[0]) * v;
      const y = b[1] + (t[1] - b[1]) * v;
      const h = b[2] + (t[2] - b[2]) * v;
      return [x, y, u * h];
    },
    half: (v: number) => b[2] + (t[2] - b[2]) * v
  });
  const quadOn = (sl: ReturnType<typeof slope>, v0: number, v1: number, inset: number, w?: number): Vec3[] => {
    const h0 = w ?? sl.half(v0) - inset;
    const h1 = w ?? sl.half(v1) - inset;
    const p = (v: number, z: number): Vec3 => {
      const q = sl.at(0, v);
      return [q[0], q[1], z];
    };
    return [p(v0, -h0), p(v0, h0), p(v1, h1), p(v1, -h1)];
  };
  const ws = slope([g.wsBase, belt, hw], [g.wsTop, roof, roofW / 2]);
  poly(null, 'frame', 0, quadOn(ws, 0, 1, 0), [1, 1, 0]);
  poly('windscreen', 'glass', 2, quadOn(ws, 0.04, 0.95, 0.05), [1, 1, 0]);

  // ── roof ──
  const roofZone = g.softTop ? 'soft_top' : 'roof';
  const roofTone: Tone = g.softTop ? 'soft' : 'body';
  if (g.rear === 'van') {
    const xe = rx(roof);
    poly(roofZone, roofTone, 1, [[g.wsTop, roof, -roofW / 2], [g.wsTop, roof, roofW / 2], [xe + C, roof, roofW / 2], [xe, roof, roofW / 2 - C], [xe, roof, -(roofW / 2 - C)], [xe + C, roof, -roofW / 2]], [0, 1, 0]);
  } else {
    poly(roofZone, roofTone, 1, [[g.wsTop, roof, -roofW / 2], [g.wsTop, roof, roofW / 2], [g.roofEnd, roof, roofW / 2], [g.roofEnd, roof, -roofW / 2]], [0, 1, 0]);
  }
  if (g.roofRails) {
    for (const s of [-1, 1]) {
      const z = s * (roofW / 2 - 0.08);
      parts.push({ type: 'beam', zone: sideZone('roof_rail', s), tone: 'trim', layer: 3, a: [g.roofEnd + 0.1, roof + 0.05, z], b: [g.wsTop - 0.12, roof + 0.05, z], thickness: 0.045 });
    }
  }

  // ── rear end ──
  const rBumper = 'rear_bumper';
  poly(rBumper, 'body', 1, [[xR, sill, -(hw - C)], [xR, sill, hw - C], [xR, bumperR, hw - C], [xR, bumperR, -(hw - C)]], [-1, 0, 0]);
  poly(
    rBumper,
    'body',
    1,
    [[xR + BP + C, bumperR, -hw], [xR + C, bumperR, -hw], [xR, bumperR, -(hw - C)], [xR, bumperR, hw - C], [xR + C, bumperR, hw], [xR + BP + C, bumperR, hw], [xR + BP, bumperR, hw - C], [xR + BP, bumperR, -(hw - C)]],
    [0, 1, 0]
  );
  const rSensorY = bumperR - 0.07;
  for (const zc of [-W * 0.36, -W * 0.16, W * 0.16, W * 0.36]) {
    poly('rear_parking_sensors', 'frame', 3, [[xR, rSensorY - 0.018, zc - 0.018], [xR, rSensorY - 0.018, zc + 0.018], [xR, rSensorY + 0.018, zc + 0.018], [xR, rSensorY + 0.018, zc - 0.018]], [-1, 0, 0]);
  }
  for (const s of [-1, 1]) {
    poly(rBumper, 'body', 1, [[xR, sill, s * (hw - C)], [xR + C, sill, s * hw], [xR + C, bumperR, s * hw], [xR, bumperR, s * (hw - C)]], [-1, 0, s]);
    poly(rBumper, 'body', 1, [[xR + C, sill, s * hw], [xR + WRAP, sill, s * hw], [xR + WRAP, bumperR, s * hw], [xR + C, bumperR, s * hw]], [0, 0, s]);
    rearChamfer(null, 'body', 0, s, bumperR, topR);
  }
  rearQuad(null, 'body', 0, -(hw - C), hw - C, bumperR, topR);
  // rear lamps
  const lampSpec =
    g.rear === 'van'
      ? { w: 0.09, y0: bumperR + 0.05, y1: bumperR + 0.6 }
      : g.rear === 'bed'
        ? { w: 0.1, y0: bumperR + 0.06, y1: belt - 0.06 }
        : { w: W * 0.15, y0: topR - Math.min(0.2, (topR - bumperR) * 0.6), y1: topR - 0.02 };
  for (const s of [-1, 1]) {
    rearQuad(sideZone('rear_lamp', s), 'lamp', 2, s * (hw - C - lampSpec.w), s * (hw - C), lampSpec.y0, lampSpec.y1);
    rearChamfer(sideZone('rear_lamp', s), 'lamp', 2, s, lampSpec.y0, lampSpec.y1);
  }
  const camY = bumperR + 0.07;
  rearQuad('reversing_camera', 'frame', 3, -0.035, 0.035, camY - 0.025, camY + 0.025);
  const xrb = rx(belt);

  if (g.rear === 'hatch') {
    const half = hw - C - lampSpec.w - 0.02;
    rearQuad('tailgate', 'body', 1, -half, half, bumperR + 0.03, belt);
    const sl = slope([xrb, belt, hw - C], [g.roofEnd, roof, roofW / 2]);
    poly('tailgate', 'body', 1, quadOn(sl, 0, 1, 0), [-1, 0.5, 0]);
    poly('rear_screen', 'glass', 2, quadOn(sl, 0.14, 0.86, 0.07), [-1, 0.5, 0]);
    poly('high_level_brake_lamp', 'lamp', 3, quadOn(sl, 0.9, 0.96, 0, 0.18), [-1, 0.5, 0]);
    for (const s of [-1, 1]) poly(null, 'body', 0, [[xrb, belt, s * (hw - C)], [xrb + C, belt, s * hw], [g.roofEnd, roof, (s * roofW) / 2]], [-1, 0.3, s]);
    if (g.spoiler) parts.push({ type: 'box', zone: 'spoiler', tone: 'body', layer: 3, center: [g.roofEnd - 0.01, roof + 0.02, 0], size: [0.14, 0.03, roofW - 0.16] });
  } else if (g.rear === 'boot') {
    const ds = g.deckStart!;
    const half = hw - C - lampSpec.w - 0.02;
    rearQuad('boot_lid', 'body', 1, -half, half, bumperR + 0.1, belt);
    poly(null, 'body', 0, [[ds, belt, -hw], [ds, belt, hw], [xrb + C, belt, hw], [xrb, belt, hw - C], [xrb, belt, -(hw - C)], [xrb + C, belt, -hw]], [0, 1, 0]);
    poly('boot_lid', 'body', 1, [[ds, belt, -(hw - C)], [ds, belt, hw - C], [xrb, belt, hw - C], [xrb, belt, -(hw - C)]], [0, 1, 0]);
    const sl = slope([ds, belt, hw], [g.roofEnd, roof, roofW / 2]);
    if (g.softTop) {
      poly('soft_top', 'soft', 1, quadOn(sl, 0, 1, 0), [-1, 1, 0]);
      poly('high_level_brake_lamp', 'lamp', 3, [[xrb + 0.06, belt, -0.16], [xrb + 0.06, belt, 0.16], [xrb + 0.1, belt, 0.16], [xrb + 0.1, belt, -0.16]], [0, 1, 0]);
    } else {
      poly(null, 'frame', 0, quadOn(sl, 0, 1, 0), [-1, 1, 0]);
      poly('rear_screen', 'glass', 2, quadOn(sl, 0.06, 0.92, 0.13), [-1, 1, 0]);
      poly('high_level_brake_lamp', 'lamp', 3, quadOn(sl, 0.07, 0.12, 0, 0.16), [-1, 1, 0]);
    }
    if (g.spoiler) parts.push({ type: 'box', zone: 'spoiler', tone: 'body', layer: 3, center: [xrb + 0.06, belt + 0.02, 0], size: [0.1, 0.03, W - 2 * C - 0.12] });
  } else if (g.rear === 'van') {
    const half = hw - C - 0.1;
    rearQuad('rear_load_door_l', 'body', 1, -half, -0.006, bumperR + 0.03, roof - 0.07);
    rearQuad('rear_load_door_r', 'body', 1, 0.006, half, bumperR + 0.03, roof - 0.07);
    rearQuad('high_level_brake_lamp', 'lamp', 3, -0.14, 0.14, roof - 0.06, roof - 0.025);
  } else {
    // pick-up load bed
    const xb0 = xR + BP;
    const xb1 = g.roofEnd - 0.04;
    const inner = hw - 0.06;
    const bf = g.bedFloor!;
    rearQuad('load_bed_tailgate', 'body', 1, -(hw - C - 0.12), hw - C - 0.12, bumperR + 0.03, belt - 0.02);
    poly('load_bed_tailgate', 'body', 1, [[xb0, belt, -(hw - C)], [xb0, belt, hw - C], [xb0 + 0.05, belt, hw - C], [xb0 + 0.05, belt, -(hw - C)]], [0, 1, 0]);
    poly('load_bed_floor', 'trim', 1, [[xb0 + 0.05, bf, -inner], [xb0 + 0.05, bf, inner], [xb1, bf, inner], [xb1, bf, -inner]], [0, 1, 0]);
    poly(null, 'frame', 0, [[xb0 + 0.05, bf, -inner], [xb0 + 0.05, bf, inner], [xb0 + 0.05, belt, inner], [xb0 + 0.05, belt, -inner]], [1, 0, 0]);
    poly(null, 'frame', 0, [[xb1, bf, -inner], [xb1, bf, inner], [xb1, belt, inner], [xb1, belt, -inner]], [-1, 0, 0]);
    poly(null, 'body', 0, [[xb1, belt, -hw], [xb1, belt, hw], [g.roofEnd, belt, hw], [g.roofEnd, belt, -hw]], [0, 1, 0]);
    for (const s of [-1, 1]) {
      poly(null, 'frame', 0, [[xb0 + 0.05, bf, s * inner], [xb1, bf, s * inner], [xb1, belt, s * inner], [xb0 + 0.05, belt, s * inner]], [0, 0, -s]);
      poly(sideZone('load_bed_side', s), 'body', 1, [[xb0 + C, belt, s * hw], [xb1, belt, s * hw], [xb1, belt, s * inner], [xb0 + 0.05, belt, s * inner], [xb0 + 0.05, belt, s * (hw - C)]], [0, 1, 0]);
    }
    // cab back wall with its rear screen
    const cb = g.roofEnd;
    poly(null, 'body', 0, [[cb, belt, -hw], [cb, belt, hw], [cb, roof, roofW / 2], [cb, roof, -roofW / 2]], [-1, 0, 0]);
    poly('rear_screen', 'glass', 2, [[cb, belt + 0.1, -W * 0.27], [cb, belt + 0.1, W * 0.27], [cb, roof - 0.08, W * 0.25], [cb, roof - 0.08, -W * 0.25]], [-1, 0, 0]);
    poly('high_level_brake_lamp', 'lamp', 3, [[cb, roof - 0.06, -0.13], [cb, roof - 0.06, 0.13], [cb, roof - 0.025, 0.13], [cb, roof - 0.025, -0.13]], [-1, 0, 0]);
  }

  // ── sides ──
  const doorX0 = Math.min(...g.doors.map((d) => d.x0));
  const doorX1 = Math.max(...g.doors.map((d) => d.x1));
  const front = g.doors.find((d) => d.zone === 'front_door')!;
  const bX = front.x0; // B-pillar
  const xrTop = g.rear === 'van' ? rx(roof) : xrb;
  const rearBodyZone = g.rear === 'van' ? 'load_side_panel' : g.rear === 'bed' ? 'load_bed_side' : 'quarter_panel';
  const rearBodyX1 = g.rear === 'bed' ? g.roofEnd - 0.04 : doorX0;
  const rearBodyTop = g.rear === 'van' ? roof : belt;

  let greenhouse: P2[];
  if (g.rear === 'hatch') greenhouse = [[g.wsBase, belt], [g.wsTop, roof], [g.roofEnd, roof], [xrb + C, belt]];
  else if (g.rear === 'boot') greenhouse = [[g.wsBase, belt], [g.wsTop, roof], [g.roofEnd, roof], [g.deckStart!, belt]];
  else greenhouse = [[g.wsBase, belt], [g.wsTop, roof], [g.rear === 'van' ? bX : g.roofEnd, roof], [g.rear === 'van' ? bX : g.roofEnd, belt]];

  for (const s of [-1, 1]) {
    // front wing with its wheel arch
    side(s, sideZone('front_wing', s), 'body', 1, [
      [front.x1, sill],
      ...arc(g.wheelFx, archR),
      [xF - WRAP, sill],
      [xF - WRAP, bumperF],
      [xF - BP - C, bumperF],
      [xn - C, nose],
      [g.wsBase, belt],
      [front.x1, belt]
    ]);
    // rear body side (quarter / load side / bed side)
    side(s, sideZone(rearBodyZone, s), 'body', 1, [
      [xR + WRAP, sill],
      ...arc(g.wheelRx, archR),
      [rearBodyX1, sill],
      [rearBodyX1, rearBodyTop],
      [xrTop + C, rearBodyTop],
      [xR + BP + C, bumperR],
      [xR + WRAP, bumperR]
    ]);
    if (g.rear === 'bed') side(s, null, 'body', 0, [[rearBodyX1, sill], [doorX0, sill], [doorX0, belt], [rearBodyX1, belt]]);
    // doors and sill
    for (const d of g.doors) {
      const top = d.tall ? roof - 0.08 : belt;
      side(s, sideZone(d.zone, s), 'body', 1, [[d.x0 + GAP, sill + SILL_H], [d.x1 - GAP, sill + SILL_H], [d.x1 - GAP, top], [d.x0 + GAP, top]]);
    }
    side(s, sideZone('sill', s), 'body', 1, [[doorX0, sill], [doorX1, sill], [doorX1, sill + SILL_H], [doorX0, sill + SILL_H]]);
    // greenhouse frame, glass, pillars
    side(s, null, 'frame', 0, greenhouse);
    if (g.rear === 'van') side(s, null, 'body', 0, [[xrTop + C, belt], [bX, belt], [bX, roof], [xrTop + C, roof]]);
    for (const w of g.windows) {
      const glass = insetConvex(clipXRange(greenhouse, w.x0, w.x1), 0.035);
      if (glass.length >= 3) side(s, sideZone(w.zone, s), 'glass', 2, glass);
    }
    parts.push({ type: 'beam', zone: sideZone('a_pillar', s), tone: 'frame', layer: 3, a: [g.wsBase, belt, s * hw], b: [g.wsTop, roof, (s * roofW) / 2], thickness: 0.055 });
    parts.push({ type: 'beam', zone: sideZone('b_pillar', s), tone: 'frame', layer: 3, a: [bX, belt, s * zSide(belt)], b: [bX, roof, s * zSide(roof)], thickness: 0.06 });
    // mirror
    const ms = g.mirror ?? [0.12, 0.1, 0.17];
    parts.push({ type: 'box', zone: sideZone('door_mirror', s), tone: 'body', layer: 4, center: [g.wsBase - 0.1, belt + 0.04 + ms[1] / 2, s * (hw + ms[2] / 2)], size: ms });
    // arch trims
    if (g.archTrims) {
      for (const wx of [g.wheelFx, g.wheelRx]) {
        const outer = arc(wx, archR + 0.07);
        const inner = arc(wx, archR).reverse();
        side(s, sideZone('wheel_arch_trim', s), 'trim', 2, [...outer, ...inner]);
      }
    }
    // wheels
    const tw = g.tyreW ?? 0.22;
    for (const [wx, fr] of [[g.wheelFx, 'f'], [g.wheelRx, 'r']] as const) {
      parts.push({ type: 'wheel', zone: `wheel_${fr}${s < 0 ? 'l' : 'r'}`, tone: 'tyre', layer: -1, center: [wx, wheelR, s * (hw - 0.03 - tw / 2)], radius: wheelR, width: tw });
    }
  }

  const zones = new Set<string>();
  for (const p of parts) if (p.zone) zones.add(p.zone);
  return { body, parts, length: L, width: W + 2 * (g.mirror ?? [0, 0, 0.17])[2], height: roof + (g.roofRails ? 0.07 : 0), zones };
}

const CACHE = new Map<VehicleBodyType, VehicleModel>();
export function vehicleModel(body: VehicleBodyType): VehicleModel {
  let m = CACHE.get(body);
  if (!m) {
    m = buildVehicle(body);
    CACHE.set(body, m);
  }
  return m;
}

// ── vector helpers shared with the projector and the viewport ──

export function polyNormal(pts: readonly Vec3[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** Unit normal of a polygon part, oriented to agree with its `facing` hint. */
export function outwardNormal(part: PolyPart): Vec3 {
  const n = polyNormal(part.pts);
  const d = n[0] * part.facing[0] + n[1] * part.facing[1] + n[2] * part.facing[2];
  return d < 0 ? [-n[0], -n[1], -n[2]] : n;
}
