/**
 * Small pure mesh toolkit for the parametric car (no three.js): triangle groups keyed by zone + tone, smooth-shaded
 * grids with per-region hard edges, shut lines along zone boundaries, a ray projector to drape overlays (lamps,
 * grilles, trims) onto the body, and a few primitives (superellipsoid, revolve, box).
 */
export type V3 = [number, number, number];
export type Tone =
  | 'body'
  | 'frame'
  | 'trim'
  | 'glass'
  | 'lamp'
  | 'soft'
  | 'tyre'
  | 'rearlamp'
  | 'chrome'
  | 'black'
  | 'rim'
  | 'liner'
  | 'redglow'
  | 'drl';

export interface MeshGroup {
  zone: string | null;
  tone: Tone;
  /** Draw order nudge for overlays (polygon offset units); 0 = body skin. */
  layer: number;
  positions: number[];
  normals: number[];
}

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export interface QuadClass {
  zone: string | null;
  tone: Tone;
  /** Smoothing group: normals are averaged only between quads of the same group. */
  group: number;
  /** Outward reference direction (orientation only). */
  hint: V3;
}

export class MeshBuilder {
  readonly groups = new Map<string, MeshGroup>();
  /** Shell triangles (body + cabin) for the projector: flat xyz triples + matching normals. */
  readonly shellPos: number[] = [];
  readonly shellNor: number[] = [];
  /** Shut lines: pairs of points. */
  readonly lines: number[] = [];
  triangles = 0;

  group(zone: string | null, tone: Tone, layer = 0): MeshGroup {
    const k = `${zone ?? '-'}|${tone}|${layer}`;
    let g = this.groups.get(k);
    if (!g) {
      g = { zone, tone, layer, positions: [], normals: [] };
      this.groups.set(k, g);
    }
    return g;
  }

  /** One triangle; winding is fixed to agree with the (averaged) vertex normals. */
  tri(zone: string | null, tone: Tone, a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3, layer = 0, shell = false): void {
    const gn = cross(sub(b, a), sub(c, a));
    const area2 = len(gn);
    if (area2 < 1e-10) return;
    const avg = add(add(na, nb), nc);
    if (dot(gn, avg) < 0) {
      [b, c] = [c, b];
      [nb, nc] = [nc, nb];
    }
    const g = this.group(zone, tone, layer);
    g.positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    g.normals.push(na[0], na[1], na[2], nb[0], nb[1], nb[2], nc[0], nc[1], nc[2]);
    if (shell) {
      this.shellPos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      this.shellNor.push(na[0], na[1], na[2], nb[0], nb[1], nb[2], nc[0], nc[1], nc[2]);
    }
    this.triangles++;
  }

  /**
   * Smooth grid P[i][j] (i along stations, j around the section). `cls(i, j)` classifies quad (i..i+1, j..j+1);
   * null = no quad. Zone boundaries between two 'body' quads get a shut line when `lines` is set.
   */
  grid(P: V3[][], cls: (i: number, j: number) => QuadClass | null, opts: { layer?: number; shell?: boolean; lines?: boolean; lineOffset?: number } = {}): void {
    const ni = P.length;
    const nj = P[0]?.length ?? 0;
    if (ni < 2 || nj < 2) return;
    const C: Array<Array<QuadClass | null>> = [];
    const N: Array<Array<V3 | null>> = [];
    for (let i = 0; i < ni - 1; i++) {
      C.push([]);
      N.push([]);
      for (let j = 0; j < nj - 1; j++) {
        const q = cls(i, j);
        C[i]!.push(q);
        if (!q) {
          N[i]!.push(null);
          continue;
        }
        const a = P[i]![j]!;
        const b = P[i + 1]![j]!;
        const c = P[i + 1]![j + 1]!;
        const d = P[i]![j + 1]!;
        let n = cross(sub(c, a), sub(d, b));
        if (dot(n, q.hint) < 0) n = scale(n, -1);
        N[i]!.push(n); // area-weighted
      }
    }
    // vertex normals per smoothing group
    const vn = new Map<string, V3>();
    const key = (i: number, j: number, g: number) => `${i},${j},${g}`;
    for (let i = 0; i < ni - 1; i++) {
      for (let j = 0; j < nj - 1; j++) {
        const q = C[i]![j];
        const n = N[i]![j];
        if (!q || !n) continue;
        for (const [vi, vj] of [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]] as const) {
          const k = key(vi, vj, q.group);
          const cur = vn.get(k);
          vn.set(k, cur ? add(cur, n) : n);
        }
      }
    }
    const nAt = (i: number, j: number, q: QuadClass): V3 => {
      const n = norm(vn.get(key(i, j, q.group)) ?? q.hint);
      return n[0] === 0 && n[1] === 0 && n[2] === 0 ? norm(q.hint) : n;
    };
    const layer = opts.layer ?? 0;
    for (let i = 0; i < ni - 1; i++) {
      for (let j = 0; j < nj - 1; j++) {
        const q = C[i]![j];
        if (!q) continue;
        const a = P[i]![j]!;
        const b = P[i + 1]![j]!;
        const c = P[i + 1]![j + 1]!;
        const d = P[i]![j + 1]!;
        const na = nAt(i, j, q);
        const nb = nAt(i + 1, j, q);
        const nc = nAt(i + 1, j + 1, q);
        const nd = nAt(i, j + 1, q);
        this.tri(q.zone, q.tone, a, b, c, na, nb, nc, layer, opts.shell);
        this.tri(q.zone, q.tone, a, c, d, na, nc, nd, layer, opts.shell);
      }
    }
    if (opts.lines) {
      const off = opts.lineOffset ?? 0.0025;
      const seg = (p: V3, q2: V3, n1: V3, n2: V3) => {
        const A = add(p, scale(n1, off));
        const B = add(q2, scale(n2, off));
        this.lines.push(A[0], A[1], A[2], B[0], B[1], B[2]);
      };
      const panel = (q: QuadClass | null | undefined): q is QuadClass => !!q && q.zone !== null && q.tone === 'body';
      for (let i = 0; i < ni - 1; i++) {
        for (let j = 0; j < nj - 1; j++) {
          const q = C[i]![j];
          if (!panel(q)) continue;
          const qi = i + 1 < ni - 1 ? C[i + 1]![j] : null;
          if (panel(qi) && qi.zone !== q.zone) seg(P[i + 1]![j]!, P[i + 1]![j + 1]!, nAt(i + 1, j, q), nAt(i + 1, j + 1, q));
          const qj = j + 1 < nj - 1 ? C[i]![j + 1] : null;
          if (panel(qj) && qj.zone !== q.zone) seg(P[i]![j + 1]!, P[i + 1]![j + 1]!, nAt(i, j + 1, q), nAt(i + 1, j + 1, q));
        }
      }
    }
  }

  /** An explicit shut line segment. */
  line(a: V3, b: V3): void {
    this.lines.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }
}

// ── ray caster (drapes overlays onto the shell) ──

export interface Hit {
  p: V3;
  n: V3;
}

/**
 * Casts rays parameterised by two coordinates (a, b) — e.g. (x, y) for a side view, (z, y) for a front view, or
 * (angle round a vertical axis, y) for lamps that wrap round a corner. Shell triangles are binned in (a, b) so each
 * cast only tests the few triangles under it.
 */
export class Caster {
  private readonly bins = new Map<number, number[]>();
  constructor(
    private readonly pos: readonly number[],
    private readonly nor: readonly number[],
    private readonly toAB: (p: V3) => [number, number] | null,
    private readonly ray: (a: number, b: number) => { o: V3; d: V3 },
    private readonly cellA = 0.04,
    private readonly cellB = 0.04
  ) {
    const triCount = pos.length / 9;
    for (let t = 0; t < triCount; t++) {
      let a0 = Infinity;
      let a1 = -Infinity;
      let b0 = Infinity;
      let b1 = -Infinity;
      let ok = true;
      for (let k = 0; k < 3 && ok; k++) {
        const o = t * 9 + k * 3;
        const ab = toAB([pos[o]!, pos[o + 1]!, pos[o + 2]!]);
        if (!ab) {
          ok = false;
          break;
        }
        if (ab[0] < a0) a0 = ab[0];
        if (ab[0] > a1) a1 = ab[0];
        if (ab[1] < b0) b0 = ab[1];
        if (ab[1] > b1) b1 = ab[1];
      }
      if (!ok) continue;
      const ia0 = Math.floor(a0 / cellA);
      const ia1 = Math.floor(a1 / cellA);
      const ib0 = Math.floor(b0 / cellB);
      const ib1 = Math.floor(b1 / cellB);
      if ((ia1 - ia0 + 1) * (ib1 - ib0 + 1) > 400) continue; // degenerate wrap-round: not something we drape onto
      for (let ia = ia0; ia <= ia1; ia++) {
        for (let ib = ib0; ib <= ib1; ib++) {
          const k = ia * 100003 + ib;
          let list = this.bins.get(k);
          if (!list) this.bins.set(k, (list = []));
          list.push(t);
        }
      }
    }
  }

  /** Nearest surface hit for coordinates (a, b); the normal faces back along the ray. */
  cast(a: number, b: number): Hit | null {
    const list = this.bins.get(Math.floor(a / this.cellA) * 100003 + Math.floor(b / this.cellB));
    if (!list) return null;
    const { o: origin, d: D } = this.ray(a, b);
    let best = Infinity;
    let hit: Hit | null = null;
    const pos = this.pos;
    for (const t of list) {
      const o = t * 9;
      const p0: V3 = [pos[o]!, pos[o + 1]!, pos[o + 2]!];
      const e1: V3 = [pos[o + 3]! - p0[0], pos[o + 4]! - p0[1], pos[o + 5]! - p0[2]];
      const e2: V3 = [pos[o + 6]! - p0[0], pos[o + 7]! - p0[1], pos[o + 8]! - p0[2]];
      const h = cross(D, e2);
      const det = dot(e1, h);
      if (Math.abs(det) < 1e-12) continue;
      const f = 1 / det;
      const s = sub(origin, p0);
      const u = f * dot(s, h);
      if (u < -1e-6 || u > 1 + 1e-6) continue;
      const q = cross(s, e1);
      const v = f * dot(D, q);
      if (v < -1e-6 || u + v > 1 + 1e-6) continue;
      const tt = f * dot(e2, q);
      if (tt <= 1e-6 || tt >= best) continue;
      best = tt;
      const w = 1 - u - v;
      const nr = this.nor;
      let n: V3 = norm([
        nr[o]! * w + nr[o + 3]! * u + nr[o + 6]! * v,
        nr[o + 1]! * w + nr[o + 4]! * u + nr[o + 7]! * v,
        nr[o + 2]! * w + nr[o + 5]! * u + nr[o + 8]! * v
      ]);
      if (dot(n, D) > 0) n = scale(n, -1);
      hit = { p: add(origin, scale(D, tt)), n };
    }
    return hit;
  }
}

/**
 * Drape a patch onto the shell: `rows[i][j]` are (a, b) caster coordinates; hits are lifted by `offset` along the
 * surface normal. Quads with a missed corner are dropped. Returns the number of quads emitted.
 */
export function drape(mb: MeshBuilder, caster: Caster, rows: Array<Array<[number, number]>>, zone: string | null, tone: Tone, offset: number, layer: number): number {
  const P: Array<Array<Hit | null>> = rows.map((row) => row.map(([a, b]) => caster.cast(a, b)));
  let n = 0;
  for (let i = 0; i < P.length - 1; i++) {
    for (let j = 0; j < P[i]!.length - 1; j++) {
      const a = P[i]![j];
      const b = P[i + 1]![j];
      const c = P[i + 1]![j + 1];
      const d = P[i]![j + 1];
      if (!a || !b || !c || !d) continue;
      const lift = (h: Hit): V3 => add(h.p, scale(h.n, offset));
      mb.tri(zone, tone, lift(a), lift(b), lift(c), a.n, b.n, c.n, layer);
      mb.tri(zone, tone, lift(a), lift(c), lift(d), a.n, c.n, d.n, layer);
      n++;
    }
  }
  return n;
}

/**
 * Patch grid over a star-shaped 2D polygon: rings from the centroid out to the outline (edges subdivided).
 * Returns rows of 2D points: rows = rings (centre → outline), columns = around the outline (closed: last = first).
 */
export function polyPatch(poly: Array<[number, number]>, rings = 3, perEdge = 3): Array<Array<[number, number]>> {
  const outline: Array<[number, number]> = [];
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k]!;
    const q = poly[(k + 1) % poly.length]!;
    for (let s = 0; s < perEdge; s++) outline.push([lerp(p[0], q[0], s / perEdge), lerp(p[1], q[1], s / perEdge)]);
  }
  outline.push(outline[0]!);
  let cx = 0;
  let cy = 0;
  for (const p of poly) {
    cx += p[0];
    cy += p[1];
  }
  cx /= poly.length;
  cy /= poly.length;
  const rows: Array<Array<[number, number]>> = [];
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    rows.push(outline.map(([x, y]) => [cx + (x - cx) * t, cy + (y - cy) * t] as [number, number]));
  }
  return rows;
}

/** Superellipse outline (exponent 2 = ellipse, 4+ = rounded rectangle). */
export function superellipse(cx: number, cy: number, ra: number, rb: number, e = 4, n = 20): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out.push([cx + ra * Math.sign(c) * Math.pow(Math.abs(c), 2 / e), cy + rb * Math.sign(s) * Math.pow(Math.abs(s), 2 / e)]);
  }
  return out;
}

/** Rows of a band between two polylines (same length) — e.g. an arch trim between two arcs. */
export function bandPatch(inner: Array<[number, number]>, outer: Array<[number, number]>, rows = 2): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    out.push(inner.map((p, k) => [lerp(p[0], outer[k]![0], t), lerp(p[1], outer[k]![1], t)] as [number, number]));
  }
  return out;
}

/** Superellipsoid solid (rounded box when e is small): centre, half sizes, smooth normals. */
export function superellipsoid(mb: MeshBuilder, zone: string | null, tone: Tone, c: V3, r: V3, e = 0.3, nu = 16, nv = 10, layer = 0, xform?: (p: V3) => V3): void {
  const f = (w: number, m: number) => Math.sign(w) * Math.pow(Math.abs(w), m);
  const P: V3[][] = [];
  for (let i = 0; i <= nv; i++) {
    const v = -Math.PI / 2 + (Math.PI * i) / nv;
    const row: V3[] = [];
    for (let j = 0; j <= nu; j++) {
      const u = -Math.PI + (2 * Math.PI * j) / nu;
      const x = r[0] * f(Math.cos(v), e) * f(Math.cos(u), e);
      const y = r[1] * f(Math.sin(v), e);
      const z = r[2] * f(Math.cos(v), e) * f(Math.sin(u), e);
      let p: V3 = [c[0] + x, c[1] + y, c[2] + z];
      if (xform) p = xform(p);
      row.push(p);
    }
    P.push(row);
  }
  const ctr: V3 = xform ? xform(c) : c;
  mb.grid(P, (i, j) => {
    const a = P[i]![j]!;
    const b = P[i + 1]![j + 1]!;
    const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    return { zone, tone, group: 1, hint: sub(mid, ctr) };
  }, { layer });
}

/** Axis-aligned or oriented box with flat faces. */
export function box(mb: MeshBuilder, zone: string | null, tone: Tone, c: V3, half: V3, layer = 0, xform?: (p: V3) => V3): void {
  const corner = (a: number, b: number, d: number): V3 => {
    const p: V3 = [c[0] + a * half[0], c[1] + b * half[1], c[2] + d * half[2]];
    return xform ? xform(p) : p;
  };
  const center = xform ? xform(c) : c;
  const faces: Array<[V3, V3, V3, V3]> = [
    [corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(1, -1, 1)],
    [corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1)],
    [corner(-1, 1, -1), corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1)],
    [corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1)],
    [corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)],
    [corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1), corner(1, -1, -1)]
  ];
  for (const [a, b, cc, d] of faces) {
    let n = norm(cross(sub(cc, a), sub(d, b)));
    const mid = scale(add(add(a, b), add(cc, d)), 0.25);
    if (dot(n, sub(mid, center)) < 0) n = scale(n, -1);
    mb.tri(zone, tone, a, b, cc, n, n, n, layer);
    mb.tri(zone, tone, a, cc, d, n, n, n, layer);
  }
}

// ── 2D polygon helpers (outlines draped onto the body: windows, lamps) ──

type P2 = [number, number];

function signedArea2(poly: readonly P2[]): number {
  let a = 0;
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k]!;
    const q = poly[(k + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Drop points closer than `eps` to the previous one (closed polygon). */
export function dedupePoly(poly: readonly P2[], eps = 0.004): P2[] {
  const out: P2[] = [];
  for (const p of poly) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > eps) out.push(p);
  }
  while (out.length > 2 && Math.hypot(out[0]![0] - out[out.length - 1]![0], out[0]![1] - out[out.length - 1]![1]) <= eps) out.pop();
  return out;
}

/**
 * Round every corner of a closed polygon with an arc of radius `r`, limited to 45% of the adjacent edges so short
 * (already-curved) runs are left alone. Nearly straight vertices are kept as they are.
 */
export function filletPoly(poly: readonly P2[], r: number, seg = 4): P2[] {
  const n = poly.length;
  if (n < 3 || r <= 0) return poly.slice();
  const out: P2[] = [];
  for (let k = 0; k < n; k++) {
    const p = poly[k]!;
    const a = poly[(k + n - 1) % n]!;
    const b = poly[(k + 1) % n]!;
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    if (la < 1e-6 || lb < 1e-6) continue;
    const u: P2 = [(a[0] - p[0]) / la, (a[1] - p[1]) / la];
    const v: P2 = [(b[0] - p[0]) / lb, (b[1] - p[1]) / lb];
    const cos = clamp(u[0] * v[0] + u[1] * v[1], -1, 1);
    const th = Math.acos(cos); // interior angle between the two edges
    if (th > Math.PI - 0.12) {
      out.push(p);
      continue;
    }
    let t = r / Math.tan(th / 2);
    t = Math.min(t, 0.45 * la, 0.45 * lb);
    const rr = t * Math.tan(th / 2);
    const p0: P2 = [p[0] + u[0] * t, p[1] + u[1] * t];
    const p1: P2 = [p[0] + v[0] * t, p[1] + v[1] * t];
    const bis = norm([u[0] + v[0], u[1] + v[1], 0]);
    const dc = rr / Math.sin(th / 2);
    const c: P2 = [p[0] + bis[0] * dc, p[1] + bis[1] * dc];
    const a0 = Math.atan2(p0[1] - c[1], p0[0] - c[0]);
    const a1 = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
    let da = a1 - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    for (let i = 0; i <= seg; i++) {
      const ang = a0 + (da * i) / seg;
      out.push([c[0] + rr * Math.cos(ang), c[1] + rr * Math.sin(ang)]);
    }
  }
  return dedupePoly(out, 0.0015);
}

/** Offset a closed, roughly convex polygon outward by `d` (negative = inward), along the averaged edge normals. */
export function offsetPoly(poly: readonly P2[], d: number): P2[] {
  const n = poly.length;
  if (n < 3) return poly.slice();
  const ccw = signedArea2(poly) > 0;
  const edgeN = (p: P2, q: P2): P2 => {
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const l = Math.hypot(ex, ey) || 1;
    return ccw ? [ey / l, -ex / l] : [-ey / l, ex / l];
  };
  return poly.map((p, k) => {
    const a = poly[(k + n - 1) % n]!;
    const b = poly[(k + 1) % n]!;
    const n1 = edgeN(a, p);
    const n2 = edgeN(p, b);
    const m = norm([n1[0] + n2[0], n1[1] + n2[1], 0]);
    const cosHalf = Math.max(0.35, m[0] * n1[0] + m[1] * n1[1]);
    return [p[0] + (m[0] * d) / cosHalf, p[1] + (m[1] * d) / cosHalf] as P2;
  });
}
