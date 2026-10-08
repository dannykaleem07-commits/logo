/**
 * Parametric car body for the 3D damage model, built from a CarSpec (real dimensions → stations):
 *
 *  - body tub: a smooth loft of cross-sections along the car (sill, tumble-in, shoulder crease, rounded wing tops,
 *    crowned bonnet/deck), plan-view rounded corners, raked front and rear faces closed by bulged caps, and true wheel
 *    arches cut into the section (with dark wheel-well liners);
 *  - cabin: a second loft sitting on the beltline — windscreen at the real rake, roof with taper, and the rear slope
 *    per silhouette (hatch tailgate, saloon/fastback backlight, vertical van/pick-up back) — with the side glass, pillars
 *    and frames classified per door/window cut so the daylight openings match the door count;
 *  - details draped onto the body with a ray projector: headlamps and rear lamps per lamp style, grille per grille
 *    style, lower grille, fogs, sensors, radar, camera, arch trims, door handles; plus wheels and tyres at the real
 *    diameter / wheelbase / track, mirrors, roof rails, spoiler, pick-up bed, high roof, number plate placements.
 *
 * Every damage zone is its own triangle group (zone id → mesh) aligned to the body; shut lines are drawn along zone
 * boundaries. Pure data (no three.js), so it is unit-tested in node and only the viewport turns it into BufferGeometry.
 */
import { zoneAppliesToBody } from './zones';
import type { CarSpec } from './spec';
import {
  MeshBuilder,
  Caster,
  add,
  bandPatch,
  box,
  clamp,
  drape,
  lerp,
  norm,
  polyPatch,
  scale,
  smooth,
  sub,
  superellipse,
  superellipsoid,
  type MeshGroup,
  type QuadClass,
  type Tone,
  type V3
} from './meshKit';

export type { MeshGroup, Tone, V3 };

export interface PlatePlacement {
  kind: 'front' | 'rear';
  /** The panel the plate is fixed to (picking the plate selects it). */
  zone: string | null;
  center: V3;
  normal: V3;
  up: V3;
  width: number;
  height: number;
}

export interface CarMesh {
  groups: MeshGroup[];
  /** Shut lines as segment pairs (x,y,z,x,y,z…). */
  lines: number[];
  plates: PlatePlacement[];
  zones: Set<string>;
  triangles: number;
  bounds: { min: V3; max: V3 };
  spec: CarSpec;
}

const PLATE_W = 0.52;
const PLATE_H = 0.111;

type Region = 'bottom' | 'wellWall' | 'wellRoof' | 'botCorner' | 'side' | 'topCorner' | 'top';
// half-loop layout of the tub (vertex indices); segment j lies between vertex j and j+1
const TUB_SIDE_N = 15;
const TUB_REGION: Region[] = (() => {
  const r: Region[] = [];
  r.push('bottom', 'bottom'); // 0-1
  r.push('wellWall'); // 2
  r.push('wellRoof', 'wellRoof'); // 3-4
  r.push('botCorner', 'botCorner'); // 5-6
  for (let k = 0; k < TUB_SIDE_N - 1; k++) r.push('side'); // 7..20
  r.push('topCorner', 'topCorner', 'topCorner'); // 21-23
  for (let k = 0; k < 5; k++) r.push('top'); // 24-28
  return r;
})();
const CAB_GLASS_SEGS = 6;
const CAB_SIDE_N = CAB_GLASS_SEGS + 3; // vertices on the cabin side: belt, glass bottom, glass rows, glass top, frame top
type CabRegion = 'side' | 'corner' | 'top';
const CAB_REGION: CabRegion[] = [...Array(CAB_SIDE_N - 1).fill('side'), 'corner', 'corner', 'corner', 'corner', 'top', 'top', 'top', 'top', 'top'] as CabRegion[];

export function buildCarMesh(spec: CarSpec): CarMesh {
  const s = spec;
  const body = s.body;
  const mb = new MeshBuilder();
  const hw = s.W / 2;
  const fo = s.xF - s.axleF;
  const ro = s.axleR - s.xR;
  const isVan = s.profile === 'van' || s.profile === 'van-high-roof';
  const blunt = isVan || s.profile === 'pickup' || s.profile === 'suv-boxy';
  // unpainted lower bumpers: SUV / pick-up cladding, van bumpers
  const lowBlack = s.cladding || isVan;
  const lowBand = isVan ? 0.24 : 0.1;
  const rxF = Math.min(s.cornerF[0], fo - s.archR - 0.06);
  const dzF = s.cornerF[1];
  const rxR = Math.max(0.03, Math.min(s.cornerR[0], ro - s.archR - 0.06));
  const dzR = s.cornerR[1];
  const zoneOk = (id: string | null): string | null => (id && zoneAppliesToBody(id, body) ? id : null);
  const sided = (base: string, side: number) => zoneOk(`${base}_${side < 0 ? 'l' : 'r'}`);
  const rearBodyBase = body === 'panel-van' ? 'load_side_panel' : body === 'pickup' ? 'load_bed_side' : 'quarter_panel';
  const rearOpening = (side: number): string | null =>
    body === 'panel-van' ? sided('rear_load_door', side) : body === 'pickup' ? 'load_bed_tailgate' : zoneOk('tailgate') ?? zoneOk('boot_lid');
  const frontDoor = s.doors[0]!;
  const doorFront = frontDoor.x1;
  const lastDoorX0 = Math.min(...s.doors.map((d) => d.x0));
  const doorAt = (x: number) => s.doors.find((d) => x >= d.x0 && x <= d.x1);

  // ── body tub shape functions (xb = station position before the end-face rake) ──
  const hwPlan = (xb: number) => {
    let h = hw;
    if (xb > s.xF - rxF) {
      const u = clamp((xb - (s.xF - rxF)) / rxF, 0, 1);
      h -= dzF * (1 - Math.sqrt(1 - u * u));
    }
    if (xb < s.xR + rxR) {
      const u = clamp((s.xR + rxR - xb) / rxR, 0, 1);
      h -= dzR * (1 - Math.sqrt(1 - u * u));
    }
    return h;
  };
  // beltline: rises gently toward the rear, with a kick over the rear door / C-pillar on cars
  const kick = isVan || s.profile === 'pickup' || s.profile === 'suv-boxy' ? 0 : s.profile === 'suv-coupe' ? 0.07 : 0.03;
  const beltY = (xb: number) => s.belt + s.beltRise * clamp((s.cowlX - xb) / (s.cowlX - s.xR), 0, 1) + kick * smooth(lastDoorX0 + 0.25, lastDoorX0 - 0.3, xb);
  const cowlY = s.belt - 0.012;
  const topEdge = (xb: number) => {
    if (xb >= s.cowlX) {
      const t = clamp((xb - s.cowlX) / (s.xF - s.cowlX), 0, 1);
      return cowlY - (cowlY - s.nose) * Math.pow(t, blunt ? 1.05 : 1.45);
    }
    if (s.bed && xb < s.bed.x0) return s.bed.floor;
    let y = beltY(xb);
    if (s.rear === 'boot' && xb < s.cabinRearX) y += 0.03 * smooth(s.cabinRearX, s.cabinRearX - 0.2, xb) - 0.03 * smooth(s.xR + 0.16, s.xR, xb);
    return y;
  };
  const fA = s.axleF + s.archR;
  const rA = s.axleR - s.archR;
  const botY = (xb: number) => {
    if (xb > fA) return s.gc + s.frontLift * Math.pow(clamp((xb - fA) / (s.xF - fA), 0, 1), 1.4);
    if (xb < rA) return s.gc + s.rearLift * Math.pow(clamp((rA - xb) / (rA - s.xR), 0, 1), 1.4);
    return s.gc;
  };
  const archTop = (xb: number): number | null => {
    for (const ax of [s.axleF, s.axleR]) {
      const dx = xb - ax;
      if (Math.abs(dx) < s.archR) return s.wheelR + Math.sqrt(s.archR * s.archR - dx * dx);
    }
    return null;
  };
  const rtAt = (xb: number) => {
    if (s.bed && xb < s.bed.x0) return 0.014;
    if (isVan) return lerp(0.014, 0.05, smooth(s.cowlX - 0.05, s.cowlX + 0.1, xb));
    const under = 0.06;
    const bonnet = 0.085;
    return lerp(under, bonnet, smooth(s.cowlX - 0.05, s.cowlX + 0.15, xb));
  };
  const tuckIn = isVan ? 0.018 : 0.045;
  const shoulderIn = isVan ? 0.004 : 0.022;
  const yCrease = s.belt - (isVan ? 0.2 : 0.11);
  const crease = isVan ? 0.004 : 0.009;
  const zSide = (xb: number, y: number, yt: number) => {
    let z = hwPlan(xb);
    const t = clamp((y - s.gc) / 0.28, 0, 1);
    z -= tuckIn * (1 - t) * (1 - t);
    const u = clamp((y - (yt - 0.16)) / 0.16, 0, 1);
    z -= shoulderIn * u * u;
    const endFade = smooth(s.xR + 0.02, s.xR + 0.3, xb) * smooth(s.xF - 0.02, s.xF - 0.35, xb);
    z += crease * endFade * (Math.exp(-(((y - yCrease) / 0.03) ** 2)) - 1); // crease peak = the body's full width
    return z;
  };
  // front/rear face rake (x setback by height), blended in over the overhang ahead of/behind the arches
  const peakF = s.bumperTopF - 0.1;
  const ybF = s.gc + s.frontLift;
  const setbackF = (y: number) =>
    y <= peakF ? 0.05 * ((peakF - y) / Math.max(0.05, peakF - ybF)) ** 2 : s.noseSetback * Math.pow(clamp((y - peakF) / (s.nose - peakF), 0, 1), 1.6);
  const peakR = s.bumperTopR - 0.08;
  const ybR = s.gc + s.rearLift;
  const yRearTop = topEdge(s.xR);
  const setbackR = (y: number) =>
    y <= peakR ? 0.04 * ((peakR - y) / Math.max(0.05, peakR - ybR)) ** 2 : s.tailLean * clamp((y - peakR) / Math.max(0.05, yRearTop - peakR), 0, 1.4);
  const warpLenF = Math.max(0.12, fo - s.archR - 0.03);
  const warpLenR = Math.max(0.1, ro - s.archR - 0.03);
  // the end caps bulge forward/back by these amounts at the centre, so the face edges sit that much inside xF/xR
  const bulgeF = isVan ? 0.012 : 0.035;
  const bulgeR = isVan ? 0.006 : 0.022;
  const warpX = (xb: number, y: number) =>
    xb - smooth(s.xF - warpLenF, s.xF, xb) * (setbackF(y) + bulgeF) + smooth(s.xR + warpLenR, s.xR, xb) * (setbackR(y) + bulgeR);

  // ── stations ──
  const stations: number[] = [];
  const push = (x: number) => {
    if (x >= s.xR - 1e-9 && x <= s.xF + 1e-9) stations.push(x);
  };
  for (let k = 0; k <= 9; k++) push(s.xF - rxF + rxF * Math.sin(((k / 9) * Math.PI) / 2));
  for (let k = 0; k <= 9; k++) push(s.xR + rxR - rxR * Math.sin(((k / 9) * Math.PI) / 2));
  for (const ax of [s.axleF, s.axleR]) {
    for (let k = 0; k <= 16; k++) push(ax + s.archR * Math.cos((k / 16) * Math.PI));
    push(ax + s.archR + 0.01);
    push(ax - s.archR - 0.01);
  }
  for (const d of s.doors) {
    push(d.x0);
    push(d.x1);
  }
  push(s.cowlX);
  push(s.cabinRearX);
  if (s.bed) {
    push(s.bed.x0);
    push(s.bed.x0 - 0.008);
  }
  for (let x = s.xR; x <= s.xF; x += 0.085) push(x);
  stations.sort((a, b) => a - b);
  const st: number[] = [];
  for (const x of stations) if (!st.length || x - st[st.length - 1]! > 0.004) st.push(x);
  if (st[st.length - 1]! < s.xF - 1e-6) st.push(s.xF);

  // ── tub half-loop at a station ──
  const sideKnotsAbs = [s.sillTop, s.bumperTopR, s.bumperTopF, yCrease - 0.035, yCrease, yCrease + 0.035].sort((a, b) => a - b);
  interface LoopPt {
    y: number;
    z: number;
  }
  const tubLoop = (xb: number): LoopPt[] => {
    const yb = botY(xb);
    const yt = topEdge(xb);
    const rt = rtAt(xb);
    const at = archTop(xb);
    const yA = Math.max(yb, at ?? yb);
    const rb = at !== null ? 0.022 : 0.045;
    const zsb = zSide(xb, yA + rb, yt);
    const zWell = Math.min(s.wheelZ - s.tyreW / 2 - 0.045, zsb - rb - 0.02);
    const pts: LoopPt[] = [];
    pts.push({ y: yb, z: 0 }, { y: yb, z: zWell * 0.5 }, { y: yb, z: zWell }); // 0-2
    pts.push({ y: yA, z: zWell }); // 3
    pts.push({ y: yA, z: lerp(zWell, zsb - rb, 0.5) }, { y: yA, z: zsb - rb }); // 4-5
    const bc = { y: yA + rb, z: zsb - rb };
    pts.push({ y: bc.y - rb * Math.cos(Math.PI / 4), z: bc.z + rb * Math.sin(Math.PI / 4) }); // 6
    // side: knots clamped into [yA + rb, yt − rt] with mid-points between
    const lo = yA + rb;
    const hi = Math.max(lo, yt - rt);
    const knots = [lo, ...sideKnotsAbs.map((k) => clamp(k, lo, hi)), hi].sort((a, b) => a - b);
    const ys: number[] = [];
    for (let k = 0; k < knots.length - 1; k++) {
      ys.push(knots[k]!, (knots[k]! + knots[k + 1]!) / 2);
    }
    ys.push(hi);
    // 8 knots → 15 side points
    for (const y of ys) pts.push({ y, z: zSide(xb, y, yt) }); // 7..21
    const zst = zSide(xb, hi, yt);
    for (const a of [30, 60, 90]) {
      const r = (a * Math.PI) / 180;
      pts.push({ y: yt - rt + rt * Math.sin(r), z: zst - rt + rt * Math.cos(r) }); // 22-24
    }
    const z0 = zst - rt;
    const crown = xb >= s.cowlX ? 0.03 : 0.018;
    for (let k = 1; k <= 5; k++) {
      const z = z0 * (1 - k / 5);
      pts.push({ y: yt + crown * (1 - (z / Math.max(z0, 1e-6)) ** 2), z }); // 25-29
    }
    return pts;
  };

  const tubSection = st.map((xb) => tubLoop(xb));
  const tubVert = (i: number, j: number, side: number): V3 => {
    const p = tubSection[i]![j]!;
    return [warpX(st[i]!, p.y), p.y, side * p.z];
  };
  // zone of the hidden tub top under the cabin etc.
  const tubTopZone = (xm: number, side: number): { zone: string | null; tone: Tone } => {
    if (xm >= s.cowlX - 0.004) return { zone: 'bonnet', tone: 'body' };
    if (s.bed && xm < s.bed.x0) return { zone: zoneOk('load_bed_floor'), tone: 'black' };
    if (xm > s.cabinRearX) return { zone: null, tone: 'body' };
    if (s.rear === 'boot' || s.rear === 'hatch') return { zone: rearOpening(side), tone: 'body' };
    return { zone: null, tone: 'body' };
  };
  const sideZone = (xm: number, ym: number, side: number): { zone: string | null; tone: Tone } => {
    const black = s.cladding;
    if (xm > fA - s.archR * 0.02 && ym < s.bumperTopF) return { zone: 'front_bumper', tone: lowBlack && ym < botY(xm) + lowBand ? 'black' : 'body' };
    if (xm < rA + s.archR * 0.02 && ym < s.bumperTopR) return { zone: 'rear_bumper', tone: lowBlack && ym < botY(xm) + lowBand ? 'black' : 'body' };
    if (ym < s.sillTop && xm > s.axleR + s.archR * 0.9 && xm < s.axleF - s.archR * 0.9) return { zone: sided('sill', side), tone: black ? 'black' : 'body' };
    if (xm > doorFront) return { zone: sided('front_wing', side), tone: 'body' };
    const d = doorAt(xm);
    if (d) return { zone: sided(d.zone, side), tone: 'body' };
    return { zone: sided(rearBodyBase, side), tone: 'body' };
  };

  const tubClass = (side: number) => (i: number, j: number): QuadClass | null => {
    const region = TUB_REGION[j]!;
    const a = tubSection[i]![j]!;
    const b = tubSection[i + 1]![j + 1]!;
    const xm = (st[i]! + st[i + 1]!) / 2;
    const ym = (a.y + b.y) / 2;
    const zs = side;
    switch (region) {
      case 'bottom':
        return { zone: null, tone: 'liner', group: 2, hint: [0, -1, 0] };
      case 'wellWall':
        return { zone: null, tone: 'liner', group: 3, hint: [0, 0, zs] };
      case 'wellRoof':
        return { zone: null, tone: 'liner', group: 4, hint: [0, -1, 0] };
      case 'top': {
        const t = tubTopZone(xm, side);
        return { ...t, group: 1, hint: [0, 1, 0] };
      }
      case 'topCorner': {
        let zone: string | null;
        if (xm >= s.cowlX) zone = xm > fA && ym < s.bumperTopF ? 'front_bumper' : sided('front_wing', side);
        else if (s.bed && xm < s.bed.x0) zone = sided(rearBodyBase, side);
        else if (doorAt(xm)) zone = sided(doorAt(xm)!.zone, side);
        else if (xm > doorFront) zone = sided('front_wing', side);
        else zone = sided(rearBodyBase, side);
        return { zone, tone: 'body', group: 1, hint: [0, 1, zs] };
      }
      default: {
        const zt = sideZone(xm, ym, side);
        return { ...zt, group: 1, hint: region === 'botCorner' ? [0, -1, zs] : [0, 0, zs] };
      }
    }
  };

  for (const side of [1, -1]) {
    const P: V3[][] = st.map((_, i) => tubSection[i]!.map((__, j) => tubVert(i, j, side)));
    mb.grid(P, tubClass(side), { shell: true, lines: true });
  }

  // ── end caps (front / rear faces) ──
  const capGrid = (iStation: number, side: number, targets: (zEdge: number) => number[], bulge: number, dirX: number): V3[][] => {
    const loop = tubSection[iStation]!;
    const xb = st[iStation]!;
    const zMax = Math.max(...loop.map((p) => p.z));
    const t = targets(zMax);
    return t.map((tz, k) =>
      loop.map((p) => {
        const z = k === 0 ? p.z : Math.min(p.z, tz);
        const rel = p.z > 1e-6 ? z / p.z : 0;
        const x = warpX(xb, p.y) + dirX * bulge * (1 - rel * rel) * clamp(p.z / zMax, 0, 1);
        return [x, p.y, side * z] as V3;
      })
    );
  };
  const tailHalf = isVan ? hw - dzR - 0.13 : body === 'pickup' ? hw - 0.12 : hw - dzR - 0.15;
  for (const side of [1, -1]) {
    const iF = st.length - 1;
    const PF = capGrid(iF, side, (zE) => [zE, zE * 0.8, zE * 0.55, zE * 0.3, zE * 0.1, 0], bulgeF, 1);
    mb.grid(
      PF,
      (k, j) => {
        const region = TUB_REGION[j]!;
        if (region === 'bottom' || region === 'wellRoof' || region === 'wellWall') return { zone: null, tone: 'liner', group: 2, hint: [1, -0.3, 0] };
        const ym = (PF[k]![j]![1] + PF[k + 1]![j + 1]![1]) / 2;
        const zone = ym < s.bumperTopF || ym < s.nose - 0.07 ? 'front_bumper' : 'bonnet';
        const tone: Tone = lowBlack && ym < botY(s.xF) + lowBand ? 'black' : 'body';
        return { zone, tone, group: 5, hint: [1, 0, 0] };
      },
      { shell: true, lines: true }
    );
    const PR = capGrid(0, side, (zE) => [zE, Math.min(zE - 0.01, tailHalf), tailHalf * 0.66, tailHalf * 0.33, 0], bulgeR, -1);
    mb.grid(
      PR,
      (k, j) => {
        const region = TUB_REGION[j]!;
        if (region === 'bottom' || region === 'wellRoof' || region === 'wellWall') return { zone: null, tone: 'liner', group: 2, hint: [-1, -0.3, 0] };
        const a = PR[k]![j]!;
        const b = PR[k + 1]![j + 1]!;
        const ym = (a[1] + b[1]) / 2;
        const zm = Math.abs((a[2] + b[2]) / 2);
        let zone: string | null;
        let tone: Tone = 'body';
        if (ym < s.bumperTopR) {
          zone = 'rear_bumper';
          if (lowBlack && ym < botY(s.xR) + lowBand) tone = 'black';
        } else if (zm < tailHalf) zone = rearOpening(side);
        else zone = sided(rearBodyBase, side);
        return { zone, tone, group: 5, hint: [-1, 0, 0] };
      },
      { shell: true, lines: true }
    );
  }

  // ── cabin ──
  const xRearFaceTop = warpX(s.xR, topEdge(s.xR));
  const cabinRearX = s.cabinCap && isVan ? Math.max(s.cabinRearX, xRearFaceTop) : Math.max(s.cabinRearX, xRearFaceTop + 0.004);
  const roofEndX = s.cabinCap ? cabinRearX : Math.max(s.roofEndX, cabinRearX + 0.12);
  const roofArc = s.roofArc;
  const roofEdge = (xb: number) => {
    const u = clamp((s.wsTopX - xb) / Math.max(0.1, s.wsTopX - roofEndX), 0, 1);
    let y = s.roofY - roofArc * (2 * u - 0.8) ** 2 - (0.025 + 0.16 * s.roofTaper) * u * u * (isVan || s.profile === 'pickup' ? 0 : 1);
    if (s.highRoof) y = lerp(s.highRoof.lowY, s.roofY, smooth(s.wsTopX + 0.02, s.highRoof.x, xb));
    return y;
  };
  const cabY0 = (xb: number) => topEdge(xb) - 0.003;
  const glassSlopeP = s.rear === 'boot' ? 1.35 : s.profile === 'fastback' ? 1.3 : 1.15;
  const cabR = (xb: number) => {
    const y0 = cabY0(xb);
    if (xb >= s.wsTopX) {
      const t = clamp((s.cowlX - xb) / (s.cowlX - s.wsTopX), 0, 1);
      const top = s.highRoof ? s.highRoof.lowY : roofEdge(s.wsTopX);
      return Math.max(y0, cowlY + (top - cowlY) * t + 0.018 * Math.sin(Math.PI * t));
    }
    if (!s.cabinCap && xb < roofEndX) {
      const t = clamp((roofEndX - xb) / (roofEndX - cabinRearX), 0, 1);
      const top = roofEdge(roofEndX);
      return y0 + (top - y0) * (1 - Math.pow(t, glassSlopeP));
    }
    return roofEdge(xb);
  };
  const cabInset = (xb: number) => Math.max(s.inset, rtAt(xb) + 0.002);
  const cabHWB = (xb: number) => {
    const yt = topEdge(xb);
    return zSide(xb, yt - rtAt(xb), yt) - cabInset(xb);
  };
  const cabHWR = (xb: number) => {
    const hwB = cabHWB(xb);
    let base = s.roofHW * (1 - 0.22 * s.roofTaper * clamp((s.wsTopX - xb) / Math.max(0.1, s.wsTopX - roofEndX), 0, 1));
    if (xb > s.wsTopX) base = lerp(s.roofHW, hwB - 0.01, clamp((xb - s.wsTopX) / (s.cowlX - s.wsTopX), 0, 1));
    else if (!s.cabinCap && xb < roofEndX) {
      const t = clamp((roofEndX - xb) / (roofEndX - cabinRearX), 0, 1);
      base = lerp(base, hwB - 0.01, Math.pow(t, 2));
    }
    return base;
  };
  // the rearmost side window's back edge leans forward with the C/D-pillar
  const rearWin = s.windows.reduce<(typeof s.windows)[number] | undefined>((m, w) => (!m || w.x0 < m.x0 ? w : m), undefined);
  const pillarLean = isVan || s.profile === 'pickup' ? 0 : s.profile === 'estate' || s.profile === 'mpv' || s.profile === 'suv-boxy' ? 0.3 : s.rear === 'boot' ? 0.7 : 0.95;
  const cabStations: number[] = [];
  const cpush = (x: number) => {
    if (x >= cabinRearX - 1e-9 && x <= s.cowlX + 1e-9) cabStations.push(x);
  };
  for (let k = 0; k <= 12; k++) cpush(lerp(s.wsTopX, s.cowlX, k / 12));
  if (!s.cabinCap) for (let k = 0; k <= 16; k++) cpush(lerp(cabinRearX, roofEndX, 1 - Math.pow(1 - k / 16, 1.4)));
  for (let x = cabinRearX; x <= s.cowlX; x += 0.08) cpush(x);
  for (const w of s.windows) {
    cpush(w.x0);
    cpush(w.x1);
  }
  for (const d of s.doors) {
    cpush(d.x0);
    cpush(d.x1);
  }
  if (rearWin) for (let x = rearWin.x0; x < Math.min(rearWin.x1, rearWin.x0 + 0.45); x += 0.022) cpush(x);
  cpush(s.bPillarX - 0.045);
  cpush(s.bPillarX + 0.045);
  cpush(s.wsTopX);
  cpush(roofEndX);
  cpush(roofEndX - 0.025);
  if (s.highRoof) for (let k = 0; k <= 6; k++) cpush(lerp(s.highRoof.x, s.wsTopX - 0.05, k / 6));
  // rear screen bottom edge on a sloping back
  let glassBottomX = cabinRearX;
  if (!s.cabinCap) {
    let lo = cabinRearX;
    let hi = roofEndX;
    for (let k = 0; k < 30; k++) {
      const m = (lo + hi) / 2;
      if (cabR(m) - cabY0(m) > 0.075) hi = m;
      else lo = m;
    }
    glassBottomX = hi;
    cpush(glassBottomX);
  }
  cabStations.sort((a, b) => a - b);
  const cs: number[] = [];
  for (const x of cabStations) if (!cs.length || x - cs[cs.length - 1]! > 0.004) cs.push(x);

  interface CabPt {
    y: number;
    z: number;
  }
  const cabLoop = (xb: number): CabPt[] => {
    const y0 = cabY0(xb);
    const R = cabR(xb);
    const h = Math.max(0, R - y0);
    const rc = Math.min(isVan ? 0.06 : 0.05, 0.42 * h);
    const hwB = cabHWB(xb);
    let hwr = Math.min(cabHWR(xb), hwB - rc * 0.35);
    hwr = Math.max(hwr, 0.15);
    const hs = Math.max(0, R - rc - y0);
    const fb = hs > 1e-4 ? Math.min(0.03 / hs, 0.45) : 0.45;
    const ft = hs > 1e-4 ? Math.max(1 - 0.02 / hs, fb) : 0.55;
    const fr = [0, ...Array.from({ length: CAB_GLASS_SEGS + 1 }, (_, k) => fb + ((ft - fb) * k) / CAB_GLASS_SEGS), 1];
    const z1 = Math.min(hwB, hwr + rc);
    const pts: CabPt[] = fr.map((f) => ({ y: y0 + hs * f, z: lerp(hwB, z1, f) + 0.012 * Math.sin(Math.PI * f) * Math.min(1, hs / 0.3) }));
    for (const a of [22.5, 45, 67.5, 90]) {
      const r = (a * Math.PI) / 180;
      pts.push({ y: R - rc + rc * Math.sin(r), z: hwr + (z1 - hwr) * Math.cos(r) });
    }
    const crown = s.crown * Math.min(1, h / 0.2);
    for (let k = 1; k <= 5; k++) {
      const z = hwr * (1 - k / 5);
      pts.push({ y: R + crown * (1 - (z / hwr) ** 2), z });
    }
    return pts;
  };
  const cabSection = cs.map(cabLoop);
  const windowAt = (x: number, y = 0, y0 = 0) =>
    s.windows.find((w) => {
      const x0 = w === rearWin ? Math.min(w.x0 + pillarLean * Math.max(0, y - y0), w.x1 - 0.08) : w.x0;
      return x >= x0 && x <= w.x1;
    });
  const roofZone = s.softTop ? zoneOk('soft_top') : zoneOk('roof');
  const roofTone: Tone = s.softTop ? 'soft' : 'body';
  const cabXC = (s.wsTopX + roofEndX) / 2;
  const cabClass = (side: number) => (i: number, j: number): QuadClass | null => {
    const region = CAB_REGION[j]!;
    const xm = (cs[i]! + cs[i + 1]!) / 2;
    const a = cabSection[i]![j]!;
    const b = cabSection[i + 1]![j + 1]!;
    const ym = (a.y + b.y) / 2;
    const hint: V3 = region === 'side' ? [0, 0, side] : region === 'corner' ? [0, 1, side] : [xm - cabXC, 0.5, 0];
    const rearSlope = !s.cabinCap && xm < roofEndX;
    if (region === 'top') {
      if (xm > s.wsTopX) return { zone: 'windscreen', tone: 'glass', group: 1, hint };
      if (rearSlope) {
        if (s.softTop) return { zone: roofZone, tone: roofTone, group: 1, hint };
        if (xm > glassBottomX && xm < roofEndX - 0.025) return { zone: zoneOk('rear_screen'), tone: 'glass', group: 1, hint };
        return { zone: s.rear === 'hatch' ? rearOpening(side) : s.rear === 'boot' ? rearOpening(side) : null, tone: 'body', group: 1, hint };
      }
      return { zone: roofZone, tone: roofTone, group: 1, hint };
    }
    if (region === 'corner') {
      if (xm > s.wsTopX) return { zone: sided('a_pillar', side), tone: 'body', group: 1, hint };
      if (rearSlope) return { zone: s.softTop ? roofZone : s.rear === 'hatch' ? rearOpening(side) : sided(rearBodyBase, side), tone: s.softTop ? roofTone : 'body', group: 1, hint };
      return { zone: roofZone, tone: roofTone, group: 1, hint };
    }
    // side
    const glassRow = j >= 1 && j <= CAB_GLASS_SEGS;
    const w = windowAt(xm, ym, cabY0(xm));
    if (glassRow && w) return { zone: w.zone ? sided(w.zone, side) : null, tone: 'glass', group: 1, hint };
    if (s.softTop && ym > cabY0(xm) + 0.05 && rearSlope) return { zone: roofZone, tone: roofTone, group: 1, hint };
    if (xm > doorFront) return { zone: sided('a_pillar', side), tone: 'body', group: 1, hint };
    const d = doorAt(xm);
    if (!isVan && Math.abs(xm - s.bPillarX) < 0.045 && s.doors.length > 1) return { zone: sided('b_pillar', side), tone: 'black', group: 1, hint };
    if (d) {
      if (isVan) return { zone: sided(d.zone, side), tone: d.tall || glassRow || j === 0 ? 'body' : 'body', group: 1, hint };
      return { zone: sided(d.zone, side), tone: j === 0 || j === CAB_SIDE_N - 2 || glassRow ? 'black' : 'body', group: 1, hint };
    }
    if (!isVan && Math.abs(xm - s.bPillarX) < 0.045) return { zone: sided('b_pillar', side), tone: 'black', group: 1, hint };
    return { zone: sided(rearBodyBase, side), tone: 'body', group: 1, hint };
  };
  for (const side of [1, -1]) {
    const P: V3[][] = cs.map((x, i) => cabSection[i]!.map((p) => [x, p.y, side * p.z] as V3));
    mb.grid(P, cabClass(side), { shell: true, lines: true });
    if (s.cabinCap) {
      const loop = P[0]!;
      const zE = cabSection[0]![0]!.z;
      const tg = [Infinity, zE * 0.9, zE * 0.6, zE * 0.3, 0];
      const PC: V3[][] = tg.map((t) => loop.map((p) => [p[0], p[1], side * Math.min(Math.abs(p[2]), t)] as V3));
      mb.grid(
        PC,
        (k, j) => {
          const a = PC[k]![j]!;
          const b = PC[k + 1]![j + 1]!;
          const zm = Math.abs((a[2] + b[2]) / 2);
          if (isVan) return { zone: zm < tailHalf ? rearOpening(side) : sided(rearBodyBase, side), tone: 'body', group: 6, hint: [-1, 0, 0] };
          // pick-up cab back: the rear screen between the outer columns, across the glass rows
          if (k >= 2 && j >= 1 && j <= CAB_GLASS_SEGS) return { zone: zoneOk('rear_screen'), tone: 'glass', group: 6, hint: [-1, 0, 0] };
          return { zone: null, tone: 'body', group: 6, hint: [-1, 0, 0] };
        },
        { shell: true, lines: true }
      );
    }
  }

  // ── overlays (draped on the shell) ──
  type P2 = [number, number];
  const sp = mb.shellPos;
  const sn = mb.shellNor;
  const casters = new Map<string, Caster>();
  const caster = (key: string, make: () => Caster) => {
    let c = casters.get(key);
    if (!c) casters.set(key, (c = make()));
    return c;
  };
  // planar casters: front/rear in (z, y), side in (x, y), top in (x, z)
  const frontPlanar = () => caster('fp', () => new Caster(sp, sn, (p) => (p[0] > s.axleF ? [p[2], p[1]] : null), (a, b) => ({ o: [s.xF + 1, b, a], d: [-1, 0, 0] })));
  const rearPlanar = () => caster('rp', () => new Caster(sp, sn, (p) => (p[0] < s.axleR ? [p[2], p[1]] : null), (a, b) => ({ o: [s.xR - 1, b, a], d: [1, 0, 0] })));
  const sidePlanar = (side: number) =>
    caster(`s${side}`, () => new Caster(sp, sn, (p) => (p[2] * side > 0.05 ? [p[0], p[1]] : null), (a, b) => ({ o: [a, b, side * (hw + 1)], d: [0, 0, -side] })));
  const topPlanar = () => caster('tp', () => new Caster(sp, sn, (p) => (p[1] > s.belt - 0.1 ? [p[0], p[2]] : null), (a, b) => ({ o: [a, s.H + 1, b], d: [0, -1, 0] })));
  // radial casters: (angle round a vertical axis inside the car, y) — lamps that wrap round the corners
  const CxF = s.xF - 1.15;
  const CxR = s.xR + 1.15;
  const frontRadial = () =>
    caster('fr', () => new Caster(sp, sn, (p) => (p[0] > CxF + 0.05 ? [Math.atan2(p[2], p[0] - CxF), p[1]] : null), (a, b) => ({ o: [CxF + 3 * Math.cos(a), b, 3 * Math.sin(a)], d: [-Math.cos(a), 0, -Math.sin(a)] }), 0.02, 0.04));
  const rearRadial = () =>
    caster('rr', () => new Caster(sp, sn, (p) => (p[0] < CxR - 0.05 ? [Math.atan2(p[2], CxR - p[0]), p[1]] : null), (a, b) => ({ o: [CxR - 3 * Math.cos(a), b, 3 * Math.sin(a)], d: [Math.cos(a), 0, -Math.sin(a)] }), 0.02, 0.04));
  const put = (c: Caster, poly: P2[], zone: string | null, tone: Tone, off: number, layer: number, rings = 3, perEdge = 3) => drape(mb, c, polyPatch(poly, rings, perEdge), zone, tone, off, layer);
  /** Mirror a right-side (positive a/z) polygon to the left. */
  const mirrorA = (poly: P2[], side: number): P2[] => (side > 0 ? poly : poly.map(([a, y]) => [-a, y] as P2).reverse());
  // plan outline: station whose corner is seen at angle `a` from the radial centre (front or rear)
  const planXAt = (a: number, front: boolean) => {
    const C = front ? CxF : CxR;
    const ang = (xb: number) => Math.atan2(hwPlan(xb), front ? xb - C : C - xb);
    let lo = front ? C + 0.05 : s.xR;
    let hi = front ? s.xF : C - 0.05;
    for (let k = 0; k < 40; k++) {
      const m = (lo + hi) / 2;
      if (front ? ang(m) > Math.abs(a) : ang(m) < Math.abs(a)) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  };
  const angAtX = (xb: number, front: boolean) => Math.atan2(hwPlan(xb), front ? xb - CxF : CxR - xb);
  const angAtZ = (z: number, front: boolean) => Math.atan2(z, front ? s.xF - 0.08 - CxF : CxR - s.xR - 0.06);
  /** Polygon whose top edge follows the body's top edge (bonnet / wing line) between angles a0 → a1. */
  const edgeBand = (a0: number, a1: number, front: boolean, drop: (t: number) => number, height: (t: number) => number, n = 6): P2[] => {
    const top: P2[] = [];
    const bot: P2[] = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const a = lerp(a0, a1, t);
      const yEdge = topEdge(planXAt(a, front)) - drop(t);
      top.push([a, yEdge]);
      bot.push([a, yEdge - height(t)]);
    }
    return [...bot, ...top.reverse()];
  };
  /** Shrink a polygon toward its centroid (for lamp internals). */
  const inset = (poly: P2[], ka: number, kb: number, db = 0): P2[] => {
    const ca = poly.reduce((v, p) => v + p[0], 0) / poly.length;
    const cb = poly.reduce((v, p) => v + p[1], 0) / poly.length;
    return poly.map(([a, b]) => [ca + (a - ca) * ka, cb + (b - cb) * kb + db] as P2);
  };

  // headlamps (front radial)
  const fr = frontRadial();
  const nose = topEdge(s.xF);
  const aFace = angAtX(s.xF, true);
  let lampInnerZ = hw - 0.42;
  for (const side of [1, -1]) {
    const zone = sided('headlamp', side);
    let lens: P2[];
    let drl: P2[] | null = null;
    switch (s.lampStyle) {
      case 'round': {
        const ac = angAtZ(hw - 0.27, true);
        lens = superellipse(ac, nose - 0.11, 0.085 / 1.05, 0.085, 2, 20);
        lampInnerZ = hw - 0.36;
        put(fr, mirrorA(lens, side), zone, 'lamp', 0.005, 1);
        put(fr, mirrorA(superellipse(ac, nose - 0.11, 0.04 / 1.05, 0.04, 2, 14), side), zone, 'chrome', 0.008, 2, 2);
        continue;
      }
      case 'tall':
        lampInnerZ = hw - 0.36;
        lens = edgeBand(angAtZ(lampInnerZ, true), angAtX(s.xF - 0.34, true), true, () => 0.02, (t) => lerp(0.2, 0.3, t));
        drl = edgeBand(angAtZ(lampInnerZ + 0.03, true), angAtX(s.xF - 0.3, true), true, () => 0.035, () => 0.03);
        break;
      case 'square':
        lampInnerZ = hw - 0.36;
        lens = edgeBand(angAtZ(lampInnerZ, true), angAtX(s.xF - 0.22, true), true, () => 0.025, () => 0.15);
        break;
      case 'swept':
        lampInnerZ = hw - 0.42;
        lens = edgeBand(angAtZ(lampInnerZ, true), angAtX(s.xF - 0.5, true), true, () => 0.016, (t) => lerp(0.13, 0.05, t));
        drl = edgeBand(angAtZ(lampInnerZ + 0.04, true), angAtX(s.xF - 0.4, true), true, () => 0.03, () => 0.022);
        break;
      case 'split':
        lampInnerZ = hw - 0.4;
        lens = edgeBand(angAtZ(lampInnerZ, true), angAtX(s.xF - 0.42, true), true, () => 0.016, (t) => lerp(0.04, 0.03, t));
        put(fr, mirrorA(superellipse(angAtZ(hw - 0.25, true), s.bumperTopF + 0.05, 0.1 / 1.05, 0.055, 4, 18), side), zone, 'lamp', 0.005, 1);
        put(fr, mirrorA(superellipse(angAtZ(hw - 0.25, true), s.bumperTopF + 0.05, 0.05 / 1.05, 0.03, 2.5, 14), side), zone, 'chrome', 0.008, 2, 2);
        break;
      default: // slim / light-bar
        lampInnerZ = hw - 0.44;
        lens = edgeBand(angAtZ(lampInnerZ, true), angAtX(s.xF - 0.42, true), true, () => 0.016, (t) => lerp(0.085, 0.05, t));
        drl = edgeBand(angAtZ(lampInnerZ + 0.03, true), angAtX(s.xF - 0.36, true), true, () => 0.026, () => 0.016);
    }
    put(fr, mirrorA(lens, side), zone, 'lamp', 0.005, 1, 3, 3);
    if (s.lampStyle !== 'split') put(fr, mirrorA(inset(lens, 0.4, 0.45, -0.005), side), zone, 'chrome', 0.008, 2, 2, 2);
    if (drl) put(fr, mirrorA(drl, side), zone, 'drl', 0.009, 3, 2, 2);
  }
  void aFace;
  const fp = frontPlanar();
  if (s.lampStyle === 'light-bar') {
    for (const side of [1, -1]) put(fp, mirrorA([[0, nose - 0.04], [lampInnerZ + 0.02, nose - 0.04], [lampInnerZ + 0.02, nose - 0.024], [0, nose - 0.024]], side), sided('headlamp', side), 'drl', 0.007, 2, 1, 4);
  }

  // grille (front planar)
  const gi = lampInnerZ - 0.03;
  const gTop = nose - 0.04;
  const gBot = Math.max(s.bumperTopF - 0.03, gTop - 0.2);
  const grille = (poly: P2[], tone: Tone = 'black', off = 0.004, layer = 1) => put(fp, poly, 'grille', tone, off, layer, 3, 4);
  const bars = (half: number, y0: number, y1: number, n: number) => {
    for (let k = 1; k <= n; k++) {
      const y = lerp(y0, y1, k / (n + 1));
      grille([[-half, y - 0.006], [half, y - 0.006], [half, y + 0.006], [-half, y + 0.006]], 'chrome', 0.007, 3);
    }
  };
  let grilleLow = gBot;
  switch (s.grilleStyle) {
    case 'kidney':
      for (const c of [-1, 1]) {
        const half = Math.min(0.15, gi * 0.47);
        const cz = c * (half + 0.02);
        const yc = (gTop + s.bumperTopF - 0.04) / 2;
        const hh = (gTop - s.bumperTopF + 0.04) / 2;
        grille(superellipse(cz, yc, half, hh, 4.5, 24), 'chrome', 0.003, 1);
        grille(superellipse(cz, yc, half - 0.016, hh - 0.016, 4.5, 24), 'black', 0.005, 2);
      }
      grilleLow = s.bumperTopF - 0.04;
      break;
    case 'hexagonal': {
      const yb = s.bumperTopF - 0.17;
      grille([[-gi * 0.62, yb], [gi * 0.62, yb], [gi * 0.95, (gTop + yb) / 2 + 0.03], [gi * 0.82, gTop], [-gi * 0.82, gTop], [-gi * 0.95, (gTop + yb) / 2 + 0.03]]);
      grilleLow = yb;
      break;
    }
    case 'trapezoid': {
      const yb = s.bumperTopF - 0.13;
      grille([[-gi * 1.02, yb], [gi * 1.02, yb], [gi * 0.84, gTop - 0.02], [-gi * 0.84, gTop - 0.02]]);
      bars(gi * 0.8, yb, gTop - 0.02, 2);
      grilleLow = yb;
      break;
    }
    case 'slim':
      grille([[-gi, gTop - 0.055], [gi, gTop - 0.055], [gi, gTop], [-gi, gTop]], 'black', 0.004, 1);
      grilleLow = gTop - 0.055;
      break;
    case 'closed':
      grille([[-gi * 0.8, gTop - 0.05], [gi * 0.8, gTop - 0.05], [gi * 0.85, gTop - 0.012], [-gi * 0.85, gTop - 0.012]], 'black', 0.004, 1);
      grilleLow = gTop - 0.05;
      break;
    case 'split':
      for (const c of [-1, 1]) {
        const p: P2[] = [[c * 0.05, gBot], [c * gi, gBot], [c * gi, gTop], [c * 0.05, gTop]];
        grille(c > 0 ? p : p.reverse());
      }
      break;
    case 'shield': {
      const yb = s.bumperTopF - 0.17;
      const sh: P2[] = [[0, yb], [0.1, (gTop + yb) / 2 - 0.02], [0.13, gTop], [-0.13, gTop], [-0.1, (gTop + yb) / 2 - 0.02]];
      grille(sh, 'chrome', 0.003, 1);
      grille(inset(sh, 0.8, 0.85, 0.006), 'black', 0.005, 2);
      grilleLow = yb;
      break;
    }
    case 'large': {
      const yb = s.bumperTopF - 0.1;
      grille(superellipse(0, (gTop + yb) / 2, gi + 0.015, (gTop - yb) / 2 + 0.012, 6, 28), 'chrome', 0.003, 1);
      grille(superellipse(0, (gTop + yb) / 2, gi - 0.01, (gTop - yb) / 2 - 0.01, 6, 28), 'black', 0.005, 2);
      bars(gi - 0.03, yb, gTop, 3);
      grilleLow = yb;
      break;
    }
    default: // wide
      grille(superellipse(0, (gTop + gBot) / 2, gi, (gTop - gBot) / 2, 5, 28), 'black', 0.004, 1);
      bars(gi - 0.04, gBot, gTop, 1);
  }
  // lower grille, fogs, radar, sensors
  const ybF0 = botY(s.xF - 0.05);
  const lgTop = Math.min(grilleLow - 0.05, s.bumperTopF - 0.12);
  const lgBot = Math.max(ybF0 + 0.05, lgTop - (s.grilleStyle === 'slim' || s.grilleStyle === 'closed' ? 0.17 : 0.12));
  const lgHalf = s.W * (s.grilleStyle === 'slim' ? 0.29 : 0.25);
  if (lgTop - lgBot > 0.04) {
    put(fp, [[-lgHalf, lgBot], [lgHalf, lgBot], [lgHalf * 1.05, lgTop], [-lgHalf * 1.05, lgTop]], 'front_lower_grille', 'black', 0.004, 1, 2, 4);
    put(fp, superellipse(0, (lgTop + lgBot) / 2, 0.055, 0.032, 4, 12), 'front_radar', 'frame', 0.007, 2, 1, 3);
  }
  for (const side of [1, -1]) {
    const fy = Math.max(lgBot + 0.035, (lgTop + lgBot) / 2);
    put(fr, mirrorA(superellipse(angAtZ(Math.min(hw - 0.17, lgHalf + 0.15), true), fy, 0.055 / 1.05, 0.028, 4, 14), side), sided('fog_lamp', side), 'lamp', 0.005, 1, 2, 3);
  }
  const rp = rearPlanar();
  for (const zc of [-0.36, -0.15, 0.15, 0.36]) {
    put(fp, superellipse(zc * s.W, s.bumperTopF - 0.05, 0.013, 0.013, 2, 10), 'front_parking_sensors', 'frame', 0.004, 2, 1, 2);
    put(rp, superellipse(zc * s.W, s.bumperTopR - 0.06, 0.013, 0.013, 2, 10), 'rear_parking_sensors', 'frame', 0.004, 2, 1, 2);
  }

  // rear lamps (rear radial): smoked lens + bright light element + reversing segment
  const rr2 = rearRadial();
  const yRT = topEdge(s.xR + 0.05);
  for (const side of [1, -1]) {
    const zone = sided('rear_lamp', side);
    if (s.rear === 'bed') continue;
    let lens: P2[];
    if (isVan) {
      const a0 = angAtZ(hw - 0.12, false);
      const a1 = angAtX(s.xR + 0.06, false);
      lens = [[a0, s.bumperTopR + 0.04], [a1, s.bumperTopR + 0.04], [a1, s.bumperTopR + 0.6], [a0, s.bumperTopR + 0.6]];
    } else {
      const tall = s.lampStyle === 'tall' || s.profile === 'estate' || s.profile === 'mpv' || s.profile === 'suv-boxy';
      const top = s.rear === 'boot' ? yRT - 0.015 : yRT + (tall ? 0.16 : 0.07);
      const aOut = angAtX(s.xR + (s.rear === 'boot' ? 0.3 : 0.2), false);
      if (s.lampStyle === 'round') {
        const ac = angAtZ(hw - 0.22, false);
        put(rr2, mirrorA(superellipse(ac, top - 0.09, 0.07 / 1.05, 0.07, 2, 16), side), zone, 'rearlamp', 0.005, 1, 2, 3);
        put(rr2, mirrorA(superellipse(angAtZ(hw - 0.4, false), top - 0.09, 0.06 / 1.05, 0.06, 2, 16), side), zone, 'rearlamp', 0.005, 1, 2, 3);
        put(rr2, mirrorA(superellipse(ac, top - 0.09, 0.035 / 1.05, 0.035, 2, 12), side), zone, 'redglow', 0.008, 2, 1, 3);
        continue;
      }
      if (tall) lens = [[angAtZ(hw - 0.17, false), s.bumperTopR + 0.05], [aOut, s.bumperTopR + 0.05], [aOut, top], [angAtZ(hw - 0.17, false), top]];
      else if (s.lampStyle === 'square') lens = [[angAtZ(hw - 0.34, false), top - 0.2], [aOut, top - 0.2], [aOut, top - 0.02], [angAtZ(hw - 0.34, false), top - 0.02]];
      else if (s.lampStyle === 'swept') lens = [[angAtZ(hw - 0.4, false), top - 0.1], [aOut, top - 0.2], [aOut, top], [angAtZ(hw - 0.4, false), top - 0.03]];
      else lens = [[angAtZ(hw - 0.46, false), top - 0.08], [aOut, top - 0.11], [aOut, top - 0.005], [angAtZ(hw - 0.46, false), top - 0.02]];
    }
    put(rr2, mirrorA(lens, side), zone, 'rearlamp', 0.005, 1, 3, 3);
    put(rr2, mirrorA(inset(lens, 0.82, 0.32, 0.01), side), zone, 'redglow', 0.008, 2, 2, 2);
    if (!isVan) {
      const ca = lens.reduce((v, p) => v + p[0], 0) / lens.length;
      const cb = lens.reduce((v, p) => v + p[1], 0) / lens.length;
      const inner = Math.min(...lens.map((p) => p[0]));
      put(rr2, mirrorA(superellipse(lerp(inner, ca, 0.45), cb - 0.02, 0.03, 0.016, 4, 10), side), zone, 'chrome', 0.01, 3, 1, 3);
    }
    if (s.lampStyle === 'light-bar' && !isVan) {
      const top = s.rear === 'boot' ? yRT - 0.015 : yRT + 0.07;
      put(rp, mirrorA([[0, top - 0.06], [hw - 0.46, top - 0.06], [hw - 0.46, top - 0.042], [0, top - 0.042]], side), zone, 'redglow', 0.006, 2, 1, 4);
    }
  }
  // camera, high-level brake lamp
  const plateYRear = s.rearPlateLow ? (botY(s.xR) + s.bumperTopR) / 2 + 0.01 : s.rear === 'boot' ? Math.min(yRT - 0.15, s.bumperTopR + 0.14) : s.bumperTopR + 0.13;
  if (s.rear !== 'bed') put(rp, superellipse(0, plateYRear + PLATE_H / 2 + 0.035, 0.03, 0.016, 4, 12), 'reversing_camera', 'black', 0.006, 2, 1, 3);
  else {
    box(mb, 'reversing_camera', 'black', [xRearFaceTop - 0.003, s.belt - 0.05, 0], [0.006, 0.014, 0.03], 3);
    box(mb, 'high_level_brake_lamp', 'redglow', [cabinRearX - 0.005, s.roofY - 0.035, 0], [0.006, 0.012, 0.12], 2);
  }
  if (isVan) put(rp, [[-0.13, s.roofY - 0.07], [0.13, s.roofY - 0.07], [0.13, s.roofY - 0.035], [-0.13, s.roofY - 0.035]], 'high_level_brake_lamp', 'redglow', 0.005, 1, 1, 4);
  if (s.rear === 'boot') {
    // boot-lid lip spoiler with the third brake lamp set into its trailing edge
    const ly = topEdge(s.xR + 0.06);
    superellipsoid(mb, zoneOk('spoiler'), 'body', [xRearFaceTop + 0.045, ly + 0.008, 0], [0.045, 0.011, hw - dzR - 0.16], 0.35, 20, 6, 1);
    box(mb, 'high_level_brake_lamp', 'redglow', [xRearFaceTop + 0.003, ly + 0.008, 0], [0.004, 0.006, 0.12], 2);
  }
  // wipers (top planar onto the windscreen)
  if (!s.softTop || true) {
    const tp = topPlanar();
    for (const c of [-1, 1]) {
      const x0 = s.cowlX - 0.07;
      const z0 = c < 0 ? -hw * 0.55 : 0.02;
      const x1 = s.cowlX - (isVan ? 0.2 : 0.3);
      const z1 = c < 0 ? -0.05 : hw * 0.5;
      const d: V3 = norm([x1 - x0, 0, z1 - z0]);
      const w = 0.011;
      put(tp, [[x0 + d[2] * w, z0 - d[0] * w], [x1 + d[2] * w, z1 - d[0] * w], [x1 - d[2] * w, z1 + d[0] * w], [x0 - d[2] * w, z0 + d[0] * w]], null, 'black', 0.006, 2, 1, 6);
    }
  }
  // door handles, sliding door rail, arch trims
  for (const side of [1, -1]) {
    const sc = sidePlanar(side);
    for (const d of s.doors) {
      const hx = d.zone === 'sliding_door' && isVan ? d.x1 - 0.12 : d.x0 + 0.11;
      const hy = beltY(hx) - 0.075;
      put(sc, superellipse(hx, hy, 0.065, 0.014, 4, 14), sided(d.zone, side), isVan || s.cladding ? 'black' : 'chrome', 0.006, 2, 1, 3);
    }
    if (s.slidingSideDoor && isVan) {
      const sd = s.doors.find((d) => d.zone === 'sliding_door');
      if (sd) {
        const y = s.belt + 0.06;
        put(sc, [[s.xR + 0.25, y], [sd.x0 + 0.02, y], [sd.x0 + 0.02, y + 0.022], [s.xR + 0.25, y + 0.022]], null, 'black', 0.004, 2, 1, 8);
      }
    }
    if (s.cladding) {
      for (const ax of [s.axleF, s.axleR]) {
        const t0 = Math.asin(clamp((s.gc + 0.03 - s.wheelR) / (s.archR + 0.004), -1, 1));
        const inner: P2[] = [];
        const outer: P2[] = [];
        for (let k = 0; k <= 18; k++) {
          const th = Math.PI - t0 + ((2 * t0 - Math.PI) * k) / 18;
          inner.push([ax + (s.archR + 0.006) * Math.cos(th), s.wheelR + (s.archR + 0.006) * Math.sin(th)]);
          outer.push([ax + (s.archR + 0.065) * Math.cos(th), s.wheelR + (s.archR + 0.065) * Math.sin(th)]);
        }
        drape(mb, sc, bandPatch(inner, outer, 2), sided('wheel_arch_trim', side), 'black', 0.005, 1);
      }
    }
  }

  // ── wheels ──
  const R = s.wheelR;
  const rr = s.rimR;
  const tw = s.tyreW;
  const spokes = isVan ? 6 : s.profile === 'pickup' ? 6 : 5;
  for (const [ax, fr] of [[s.axleF, 'f'], [s.axleR, 'r']] as const) {
    for (const side of [1, -1]) {
      const zone = `wheel_${fr}${side < 0 ? 'l' : 'r'}`;
      const c: V3 = [ax, R, side * s.wheelZ];
      wheel(mb, zone, c, side, R, rr, tw, spokes);
    }
  }

  // ── mirrors ──
  for (const side of [1, -1]) {
    const zone = sided('door_mirror', side);
    const mx = isVan ? doorFront - 0.05 : Math.min(doorFront - 0.04, s.cowlX - 0.12 / Math.tan((28 * Math.PI) / 180));
    const by = beltY(mx);
    const hwB = cabHWB(mx);
    const r: V3 = isVan ? [0.06, 0.15, 0.085] : [0.06, 0.058, 0.085];
    const cy = by + (isVan ? 0.2 : 0.085);
    const cz = side * (hwB + r[2] + (isVan ? 0.015 : 0.02));
    const tone: Tone = isVan || s.profile === 'pickup' ? 'black' : 'body';
    superellipsoid(mb, zone, tone, [mx, cy, cz], r, 0.55, 16, 10, 3);
    superellipsoid(mb, zone, 'glass', [mx - r[0] * 0.92, cy, cz], [0.006, r[1] * 0.82, r[2] * 0.86], 0.4, 12, 6, 4);
    box(mb, zone, 'black', [mx + 0.01, by + 0.03, side * (hwB + 0.025)], [0.035, 0.022, 0.03], 3);
    
  }

  // ── roof rails, spoiler, bed, spare ──
  if (s.roofRails) {
    for (const side of [1, -1]) {
      const zone = sided('roof_rail', side);
      const xs: number[] = [];
      for (let k = 0; k <= 14; k++) xs.push(lerp(roofEndX + 0.1, s.wsTopX - 0.1, k / 14));
      const ring: Array<[number, number]> = [];
      for (let k = 0; k <= 8; k++) {
        const t = (k / 8) * Math.PI * 2;
        ring.push([0.016 * Math.sign(Math.cos(t)) * Math.pow(Math.abs(Math.cos(t)), 0.6), 0.018 * Math.sign(Math.sin(t)) * Math.pow(Math.abs(Math.sin(t)), 0.6)]);
      }
      const P: V3[][] = xs.map((x) => {
        const hwr = cabHWR(x);
        const zr = hwr - 0.075;
        const yr = cabR(x) + s.crown * (1 - (zr / hwr) ** 2) + 0.032;
        return ring.map(([dz, dy]) => [x, yr + dy, side * (zr + dz)] as V3);
      });
      mb.grid(P, (i, j) => {
        const p = P[i]![j]!;
        const ctrY = (P[i]![0]![1] + P[i]![4]![1]) / 2;
        const ctrZ = (P[i]![0]![2] + P[i]![4]![2]) / 2;
        return { zone, tone: 'trim', group: 1, hint: [0, p[1] - ctrY, p[2] - ctrZ] };
      }, { layer: 1 });
      for (const x of [xs[0]!, xs[xs.length - 1]!]) {
        const hwr = cabHWR(x);
        const zr = hwr - 0.075;
        box(mb, zone, 'black', [x, cabR(x) + s.crown * (1 - (zr / hwr) ** 2) + 0.015, side * zr], [0.035, 0.018, 0.02], 1);
      }
    }
  }
  if (s.spoiler && !s.cabinCap) {
    const x = roofEndX - 0.03;
    const hwr = cabHWR(x);
    const y = cabR(x) + 0.01;
    superellipsoid(mb, zoneOk('spoiler'), 'body', [x - 0.03, y, 0], [0.085, 0.02, hwr - 0.02], 0.35, 20, 8, 1);
    box(mb, 'high_level_brake_lamp', 'rearlamp', [x - 0.112, y - 0.002, 0], [0.004, 0.009, 0.12], 2);
  }
  if (s.bed) {
    const x0 = xRearFaceTop + 0.004;
    const x1 = s.bed.x0;
    const yT = s.belt + 0.01;
    const yF = s.bed.floor - 0.02;
    const hb = hwPlan((x0 + x1) / 2) - 0.004;
    for (const side of [1, -1]) {
      box(mb, sided('load_bed_side', side), 'body', [(x0 + x1) / 2, (yT + yF) / 2, side * (hb - 0.025)], [(x1 - x0) / 2, (yT - yF) / 2, 0.025]);
      box(mb, sided('load_bed_side', side), 'black', [(x0 + x1) / 2, yT + 0.006, side * (hb - 0.028)], [(x1 - x0) / 2 + 0.002, 0.007, 0.03], 1);
      box(mb, sided('rear_lamp', side), 'rearlamp', [x0 - 0.002, (s.bumperTopR + yT) / 2 + 0.02, side * (hb - 0.06)], [0.012, (yT - s.bumperTopR) / 2 - 0.06, 0.055], 2);
    }
    box(mb, null, 'body', [x1 - 0.03, (yT + yF) / 2, 0], [0.03, (yT - yF) / 2, hb - 0.05]);
    box(mb, 'load_bed_tailgate', 'body', [x0 + 0.025, (yT + s.bumperTopR) / 2, 0], [0.025, (yT - s.bumperTopR) / 2, hb - 0.12]);
    // step bumper
    const by0 = botY(s.xR) - 0.01;
    box(mb, 'rear_bumper', 'chrome', [s.xR + 0.11, (by0 + s.bumperTopR - 0.04) / 2, 0], [0.11, (s.bumperTopR - 0.04 - by0) / 2, hw - 0.07], 2);
  }
  if (s.spareOnTailgate && s.rear !== 'bed') {
    const c: V3 = [warpX(s.xR, s.bumperTopR + 0.25) - 0.11, s.bumperTopR + 0.25, 0];
    const prof: Array<[number, number]> = [[0, 0.1], [R * 0.95, 0.095], [R, 0.06], [R, -0.06], [R * 0.9, -0.1]];
    const P: V3[][] = [];
    for (let k = 0; k <= 28; k++) {
      const t = (k / 28) * Math.PI * 2;
      P.push(prof.map(([rad, dx]) => [c[0] - dx, c[1] + rad * Math.cos(t), c[2] + rad * Math.sin(t)] as V3));
    }
    mb.grid(P, (i, j) => ({ zone: rearOpening(1), tone: j === 0 ? 'black' : 'tyre', group: j === 0 ? 2 : 1, hint: j === 0 ? [-1, 0, 0] : sub(P[i]![j]!, c) }), { layer: 1 });
  }

  // ── plates ──
  const plates: PlatePlacement[] = [];
  const platePlace = (kind: 'front' | 'rear', y: number) => {
    const h = (kind === 'front' ? fp : rp).cast(0, y);
    if (!h) return;
    let n = h.n;
    n = norm([n[0], clamp(n[1], -0.35, 0.35), 0]);
    const up = norm(sub([0, 1, 0], scale(n, n[1])));
    const zone = kind === 'front' ? 'front_bumper' : s.rearPlateLow ? 'rear_bumper' : rearOpening(1);
    plates.push({ kind, zone, center: add(h.p, scale(n, 0.012)), normal: n, up, width: PLATE_W, height: PLATE_H });
  };
  platePlace('front', grilleLow < s.bumperTopF - 0.08 ? Math.max(lgTop + 0.02, grilleLow + 0.07) : (lgTop + s.bumperTopF) / 2);
  if (s.rear === 'bed') plates.push({ kind: 'rear', zone: 'rear_bumper', center: [s.xR - 0.006, (botY(s.xR) - 0.01 + s.bumperTopR - 0.04) / 2, 0], normal: [-1, 0, 0], up: [0, 1, 0], width: PLATE_W, height: PLATE_H });
  else platePlace('rear', plateYRear);

  // van rear door centre line
  if (isVan) {
    for (let y = s.bumperTopR + 0.02; y < s.roofY - 0.04; y += 0.05) {
      const y2 = Math.min(y + 0.05, s.roofY - 0.04);
      const xa = y < s.belt ? warpX(s.xR, y) : cabinRearX;
      const xb2 = y2 < s.belt ? warpX(s.xR, y2) : cabinRearX;
      mb.line([xa - 0.004, y, 0], [xb2 - 0.004, y2, 0]);
    }
  }

  // ── collect ──
  const groups = [...mb.groups.values()];
  const zones = new Set<string>();
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const g of groups) {
    if (g.zone) zones.add(g.zone);
    const p = g.positions;
    for (let k = 0; k < p.length; k += 3) {
      for (let a = 0; a < 3; a++) {
        const v = p[k + a]!;
        if (v < min[a]!) min[a] = v;
        if (v > max[a]!) max[a] = v;
      }
    }
  }
  return { groups, lines: mb.lines, plates, zones, triangles: mb.triangles, bounds: { min, max }, spec };
}

/** Wheel: tyre with rounded shoulders, alloy rim lip, spokes, hub, brake disc and caliper. Outer face toward `side`. */
function wheel(mb: MeshBuilder, zone: string, c: V3, side: number, R: number, rr: number, tw: number, spokes: number): void {
  const h = tw / 2;
  const sw = rr + 0.45 * (R - rr);
  // tyre profile [radius, axial offset] from the inner bead round the tread to the outer bead
  const tyre: Array<[number, number]> = [
    [rr + 0.006, -h + 0.03],
    [sw, -h - 0.004],
    [R - 0.032, -h + 0.006],
    [R - 0.009, -h + 0.02],
    [R, -h + 0.048],
    [R, h - 0.048],
    [R - 0.009, h - 0.02],
    [R - 0.032, h - 0.006],
    [sw, h + 0.004],
    [rr + 0.012, h - 0.008],
    [rr + 0.004, h - 0.02]
  ];
  revolveProfile(mb, zone, 'tyre', c, tyre, 40, side, [(R + rr) / 2, 0]);
  // rim lip and barrel
  const lip: Array<[number, number]> = [
    [rr + 0.004, h - 0.02],
    [rr - 0.002, h - 0.012],
    [rr - 0.016, h - 0.014],
    [rr - 0.026, h - 0.03],
    [rr - 0.03, h - 0.09]
  ];
  revolveProfile(mb, zone, 'rim', c, lip, 40, side, [rr - 0.04, h - 0.1], 1);
  // brake disc behind the spokes
  revolveProfile(mb, zone, 'liner', c, [[0.0, h - 0.085], [rr - 0.03, h - 0.088]], 24, side, [0, h - 0.3], 1);
  // caliper
  const ang = (125 * Math.PI) / 180;
  const cr = rr * 0.72;
  box(mb, zone, 'black', [c[0] + Math.cos(ang) * cr, c[1] + Math.sin(ang) * cr, c[2] + side * (h - 0.075)], [0.035, 0.05, 0.012], 2, (p) => {
    // rotate about the wheel centre so the caliper follows the disc
    const dx = p[0] - (c[0] + Math.cos(ang) * cr);
    const dy = p[1] - (c[1] + Math.sin(ang) * cr);
    const a = ang - Math.PI / 2;
    return [c[0] + Math.cos(ang) * cr + dx * Math.cos(a) - dy * Math.sin(a), c[1] + Math.sin(ang) * cr + dx * Math.sin(a) + dy * Math.cos(a), p[2]];
  });
  // spokes: tapered, dished bars from the hub to the lip
  const rh = 0.065;
  const rs = rr - 0.022;
  for (let k = 0; k < spokes; k++) {
    const th = (k / spokes) * Math.PI * 2 + Math.PI / 2;
    const u: V3 = [Math.cos(th), Math.sin(th), 0];
    const v: V3 = [-Math.sin(th), Math.cos(th), 0];
    const pts = (r: number, w: number, dz: number): [V3, V3] => [
      add(add(c, scale(u, r)), add(scale(v, -w / 2), [0, 0, side * dz])),
      add(add(c, scale(u, r)), add(scale(v, w / 2), [0, 0, side * dz]))
    ];
    const [a0, b0] = pts(rh, 0.06, h - 0.01);
    const [a1, b1] = pts(rs, 0.04, h - 0.026);
    const [a0d, b0d] = pts(rh, 0.06, h - 0.04);
    const [a1d, b1d] = pts(rs, 0.04, h - 0.06);
    const out: V3 = [0, 0, side];
    const nTop = norm(add(out, scale(u, 0.15)));
    mb.tri(zone, 'rim', a0, a1, b1, nTop, nTop, nTop, 2);
    mb.tri(zone, 'rim', a0, b1, b0, nTop, nTop, nTop, 2);
    const nv = scale(v, -1);
    mb.tri(zone, 'rim', a0, a0d, a1d, nv, nv, nv, 2);
    mb.tri(zone, 'rim', a0, a1d, a1, nv, nv, nv, 2);
    mb.tri(zone, 'rim', b0, b1, b1d, v, v, v, 2);
    mb.tri(zone, 'rim', b0, b1d, b0d, v, v, v, 2);
  }
  // hub and centre cap
  revolveProfile(mb, zone, 'rim', c, [[0, h - 0.004], [rh * 0.6, h - 0.006], [rh + 0.004, h - 0.016], [rh + 0.004, h - 0.045]], 20, side, [0, h - 0.2], 2);
  revolveProfile(mb, zone, 'black', c, [[0, h - 0.0015], [0.028, h - 0.0025]], 16, side, [0, h - 0.2], 3);
}

/** Revolve a [radius, axial] profile about the wheel axis (z). Normals point away from `centre` in profile space. */
function revolveProfile(mb: MeshBuilder, zone: string, tone: Tone, c: V3, profile: Array<[number, number]>, segs: number, side: number, centre: [number, number], layer = 0): void {
  const P: V3[][] = [];
  for (let k = 0; k <= segs; k++) {
    const t = (k / segs) * Math.PI * 2;
    P.push(profile.map(([rad, dz]) => [c[0] + rad * Math.cos(t), c[1] + rad * Math.sin(t), c[2] + side * dz] as V3));
  }
  mb.grid(
    P,
    (i, j) => {
      const t = ((i + 0.5) / segs) * Math.PI * 2;
      const pm = [(profile[j]![0] + profile[j + 1]![0]) / 2, (profile[j]![1] + profile[j + 1]![1]) / 2];
      const dr = pm[0]! - centre[0];
      const dz = pm[1]! - centre[1];
      return { zone, tone, group: 1, hint: [Math.cos(t) * dr, Math.sin(t) * dr, side * dz] };
    },
    { layer }
  );
}

