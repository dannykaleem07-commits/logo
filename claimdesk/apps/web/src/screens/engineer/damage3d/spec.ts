/**
 * Vehicle spec: real exterior dimensions (packages/kb/data/vehicle-dimensions, via the API or a `dims` prop) turned
 * into the stations the generators use — bumpers, axles, windscreen, roof, doors, windows — in metres.
 * Pure data; shared by the 2D projection (geometry.ts) and the 3D mesh (carMesh.ts), so both views always agree.
 *
 * The web cannot import @ccguk/kb, so the dimension record shape and body defaults are copied here (keep in sync with
 * packages/kb/src/dimensions/{types,normalise}.ts). Every field is optional: missing values come from the body type.
 *
 * Axes (metres): x along the car, front = +x; y up from the ground; z across, right (O/S) = +z, left (N/S) = −z.
 */
import type { VehicleBodyType } from './zones';

export const PROFILES = ['hatch', 'saloon', 'fastback', 'estate', 'coupe', 'convertible', 'suv', 'suv-coupe', 'mpv', 'van', 'van-high-roof', 'pickup'] as const;
export type Profile = (typeof PROFILES)[number];
export type LampStyle = 'slim' | 'swept' | 'round' | 'square' | 'tall' | 'light-bar';
export type GrilleStyle = 'wide' | 'trapezoid' | 'hexagonal' | 'kidney' | 'slim' | 'large' | 'closed' | 'split';

/** One body record from a dimensions file (copy of @ccguk/kb BodyDimensions; everything optional). */
export interface VehicleDims {
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
  wheelbaseMm?: number;
  groundClearanceMm?: number;
  wheelDiameterIn?: number;
  profile?: string;
  bonnetRatio?: number;
  rearOverhangRatio?: number;
  frontOverhangRatio?: number;
  glasshouseHeightRatio?: number;
  roofTaper?: number;
  doors?: number;
  roofRails?: boolean;
  spareOnTailgate?: boolean;
  slidingSideDoor?: boolean;
  lampStyle?: string;
  grilleStyle?: string;
  note?: string;
}

/** The vehicle being drawn. All optional; `body` is free text ("5 DOOR HATCHBACK", "panel-van high roof"). */
export interface VehicleIdentity {
  make?: string;
  model?: string;
  generation?: string;
  body?: string;
  colour?: string;
  registration?: string;
  doors?: number;
}

interface Resolved {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  wheelbaseMm: number;
  groundClearanceMm: number;
  wheelDiameterIn: number;
  bonnetRatio: number;
  frontOverhangRatio: number;
  rearOverhangRatio: number;
  glasshouseHeightRatio: number;
  roofTaper: number;
  doors: number;
  roofRails: boolean;
  spareOnTailgate: boolean;
  slidingSideDoor: boolean;
  lampStyle: LampStyle;
  grilleStyle: GrilleStyle;
}

// prettier-ignore
const DEFAULTS: Record<Profile, Resolved> = {
  hatch:          r(4100, 1780, 1460, 2560, 140, 16, 0.26, 0.205, 0.165, 0.33, 0.9, 5, false, false, false, 'swept', 'wide'),
  saloon:         r(4700, 1820, 1440, 2820, 140, 17, 0.27, 0.185, 0.215, 0.31, 0.92, 4, false, false, false, 'slim', 'wide'),
  fastback:       r(4760, 1840, 1430, 2840, 140, 18, 0.27, 0.19, 0.21, 0.3, 0.9, 5, false, false, false, 'slim', 'wide'),
  estate:         r(4700, 1820, 1480, 2780, 140, 17, 0.27, 0.195, 0.215, 0.33, 0.95, 5, true, false, false, 'swept', 'wide'),
  coupe:          r(4500, 1830, 1380, 2700, 130, 18, 0.3, 0.2, 0.2, 0.3, 0.88, 2, false, false, false, 'slim', 'wide'),
  convertible:    r(4450, 1830, 1350, 2680, 130, 18, 0.3, 0.2, 0.2, 0.28, 0.88, 2, false, false, false, 'slim', 'wide'),
  suv:            r(4450, 1840, 1630, 2660, 185, 18, 0.27, 0.21, 0.19, 0.31, 0.92, 5, true, false, false, 'swept', 'large'),
  'suv-coupe':    r(4370, 1900, 1610, 2680, 200, 19, 0.28, 0.21, 0.175, 0.29, 0.85, 5, false, false, false, 'slim', 'large'),
  mpv:            r(4560, 1830, 1700, 2790, 150, 16, 0.2, 0.2, 0.19, 0.36, 0.95, 5, true, false, false, 'swept', 'wide'),
  van:            r(4970, 1990, 1990, 2930, 170, 16, 0.17, 0.195, 0.215, 0.4, 1, 4, false, false, true, 'tall', 'large'),
  'van-high-roof':r(4970, 1990, 2280, 2930, 170, 16, 0.17, 0.195, 0.215, 0.48, 1, 4, false, false, true, 'tall', 'large'),
  pickup:         r(5330, 1855, 1815, 3085, 225, 17, 0.25, 0.17, 0.25, 0.33, 0.95, 4, false, false, false, 'swept', 'large')
};
function r(
  lengthMm: number, widthMm: number, heightMm: number, wheelbaseMm: number, groundClearanceMm: number, wheelDiameterIn: number,
  bonnetRatio: number, frontOverhangRatio: number, rearOverhangRatio: number, glasshouseHeightRatio: number, roofTaper: number,
  doors: number, roofRails: boolean, spareOnTailgate: boolean, slidingSideDoor: boolean, lampStyle: LampStyle, grilleStyle: GrilleStyle
): Resolved {
  return { lengthMm, widthMm, heightMm, wheelbaseMm, groundClearanceMm, wheelDiameterIn, bonnetRatio, frontOverhangRatio, rearOverhangRatio, glasshouseHeightRatio, roofTaper, doors, roofRails, spareOnTailgate, slidingSideDoor, lampStyle, grilleStyle };
}

const BODY_PROFILE: Record<VehicleBodyType, Profile> = {
  hatchback: 'hatch',
  saloon: 'saloon',
  estate: 'estate',
  coupe: 'coupe',
  convertible: 'convertible',
  suv: 'suv',
  mpv: 'mpv',
  'panel-van': 'van',
  pickup: 'pickup'
};

const lc = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '');

export function normaliseProfile(text: unknown): Profile | undefined {
  const t = lc(text).replace(/[_\s]+/g, '-');
  if (!t) return undefined;
  if ((PROFILES as readonly string[]).includes(t)) return t as Profile;
  if (/van/.test(t) && /(high|h2|h3|tall)/.test(t)) return 'van-high-roof';
  if (/(pick-?up|double-?cab|crew-?cab|single-?cab|king-?cab|ute)/.test(t)) return 'pickup';
  if (/(panel|van|chassis|camper|luton|minibus)/.test(t)) return /minibus/.test(t) ? 'van-high-roof' : 'van';
  if (/(suv-?coupe|coupe-?suv|crossover-?coupe)/.test(t)) return 'suv-coupe';
  if (/(suv|crossover|4x4|off-?road)/.test(t)) return 'suv';
  if (/(mpv|people|carrier|multi-?purpose)/.test(t)) return 'mpv';
  if (/(estate|wagon|touring|tourer|avant|shooting|sportbrake|variant|kombi)/.test(t)) return 'estate';
  if (/(fastback|liftback|sportback|gran-?coupe)/.test(t)) return 'fastback';
  if (/(convert|cabrio|roadster|spider|spyder|soft-?top)/.test(t)) return 'convertible';
  if (/coupe/.test(t)) return 'coupe';
  if (/(saloon|sedan|notch|limousine)/.test(t)) return 'saloon';
  if (/hatch/.test(t)) return 'hatch';
  return undefined;
}

export function normaliseLampStyle(text: unknown): LampStyle | undefined {
  const t = lc(text);
  if (!t) return undefined;
  if (/(light-?bar|lightbar|full-?width|connected|bar)/.test(t)) return 'light-bar';
  if (/(round|circular|oval|bug)/.test(t)) return 'round';
  if (/(tall|vertical|upright|stacked)/.test(t)) return 'tall';
  if (/(swept|angular|sharp|wrap|boomerang|hawk)/.test(t)) return 'swept';
  if (/(slim|thin|narrow|strip|led|blade)/.test(t)) return 'slim';
  if (/(square|rect|box|block)/.test(t)) return 'square';
  return undefined;
}

export function normaliseGrilleStyle(text: unknown): GrilleStyle | undefined {
  const t = lc(text);
  if (!t) return undefined;
  if (/kidney/.test(t)) return 'kidney';
  if (/(hex|honeycomb)/.test(t)) return 'hexagonal';
  if (/trapez/.test(t)) return 'trapezoid';
  if (/(closed|blank|\bev\b|none|smooth)/.test(t)) return 'closed';
  if (/(split|twin|dual|two)/.test(t)) return 'split';
  if (/(large|big|tall|spindle|bold|chunky|upright|full)/.test(t)) return 'large';
  if (/(slim|thin|narrow|bar|slot)/.test(t)) return 'slim';
  if (/(wide|horizontal|mesh|oval|rect)/.test(t)) return 'wide';
  return undefined;
}

/** Which silhouette to draw: the dims profile when it fits the body type's family, else the body type's own. */
export function resolveProfile(body: VehicleBodyType, dims?: VehicleDims | null, identity?: VehicleIdentity | null): Profile {
  const fromBodyText = identity?.body ? normaliseProfile(identity.body) : undefined;
  let p = normaliseProfile(dims?.profile) ?? fromBodyText ?? BODY_PROFILE[body];
  if (body === 'panel-van') {
    if (p !== 'van' && p !== 'van-high-roof') p = 'van';
    if (p === 'van' && ((dims?.heightMm ?? 0) >= 2200 || fromBodyText === 'van-high-roof')) p = 'van-high-roof';
  } else if (body === 'pickup') p = 'pickup';
  else if (p === 'pickup') p = BODY_PROFILE[body];
  else if ((p === 'van' || p === 'van-high-roof') && body !== 'mpv') p = BODY_PROFILE[body];
  if (body === 'convertible') p = 'convertible';
  return p;
}

function num(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
}

/** Fill a partial dims record from the profile defaults (same rules as the kb normaliser). */
export function resolveDims(profile: Profile, dims?: VehicleDims | null, identity?: VehicleIdentity | null): Resolved {
  const d = DEFAULTS[profile];
  const x = dims ?? {};
  const lengthMm = num(x.lengthMm, 2400, 7600) ?? d.lengthMm;
  let wheelbaseMm = num(x.wheelbaseMm, 1700, 4900);
  if (wheelbaseMm !== undefined && wheelbaseMm > lengthMm * 0.82) wheelbaseMm = undefined;
  let front = num(x.frontOverhangRatio, 0.08, 0.34);
  let rear = num(x.rearOverhangRatio, 0.06, 0.36);
  if (wheelbaseMm === undefined) {
    wheelbaseMm = front !== undefined && rear !== undefined && front + rear < 0.6 ? lengthMm * (1 - front - rear) : lengthMm * (d.wheelbaseMm / d.lengthMm);
  }
  const over = 1 - wheelbaseMm / lengthMm;
  if (front === undefined && rear === undefined) {
    front = (over * d.frontOverhangRatio) / (d.frontOverhangRatio + d.rearOverhangRatio);
    rear = over - front;
  } else if (front === undefined) {
    rear = Math.min(rear!, over * 0.8);
    front = over - rear;
  } else if (rear === undefined) {
    front = Math.min(front, over * 0.8);
    rear = over - front;
  } else {
    const k = over / (front + rear);
    front *= k;
    rear *= k;
  }
  let taper = num(x.roofTaper, 0, 1.05);
  if (taper !== undefined && taper <= 0.5) taper = 1 - taper;
  const doorsIn = typeof x.doors === 'number' ? Math.round(x.doors) : typeof identity?.doors === 'number' ? Math.round(identity.doors) : undefined;
  return {
    lengthMm,
    widthMm: num(x.widthMm, 1350, 2700) ?? d.widthMm,
    heightMm: num(x.heightMm, 1000, 3300) ?? d.heightMm,
    wheelbaseMm,
    groundClearanceMm: num(x.groundClearanceMm, 70, 400) ?? d.groundClearanceMm,
    wheelDiameterIn: num(x.wheelDiameterIn, 12, 24) ?? d.wheelDiameterIn,
    bonnetRatio: num(x.bonnetRatio, 0.04, 0.42) ?? d.bonnetRatio,
    frontOverhangRatio: front,
    rearOverhangRatio: rear!,
    glasshouseHeightRatio: num(x.glasshouseHeightRatio, 0.15, 0.62) ?? d.glasshouseHeightRatio,
    roofTaper: taper === undefined ? d.roofTaper : Math.max(0.6, Math.min(1, taper)),
    doors: doorsIn !== undefined && doorsIn >= 2 && doorsIn <= 5 ? doorsIn : d.doors,
    roofRails: typeof x.roofRails === 'boolean' ? x.roofRails : d.roofRails,
    spareOnTailgate: typeof x.spareOnTailgate === 'boolean' ? x.spareOnTailgate : d.spareOnTailgate,
    slidingSideDoor: typeof x.slidingSideDoor === 'boolean' ? x.slidingSideDoor : d.slidingSideDoor,
    lampStyle: normaliseLampStyle(x.lampStyle) ?? d.lampStyle,
    grilleStyle: normaliseGrilleStyle(x.grilleStyle) ?? d.grilleStyle
  };
}

// ── spec ──

export type RearKind = 'hatch' | 'boot' | 'van' | 'bed';

export interface DoorCut {
  /** Base zone name without side suffix (front_door, rear_door, sliding_door). */
  zone: string;
  x0: number;
  x1: number;
  /** Runs up to the roof (van sliding door). */
  tall?: boolean;
}
export interface WindowCut {
  zone: string | null;
  x0: number;
  x1: number;
}

/** Silhouette shaping per profile (metres / degrees). */
interface Shape {
  noseDrop: number; // belt − bonnet leading edge
  noseSetback: number; // how far the bonnet leading edge sits behind the bumper face
  rake: number; // windscreen angle from horizontal (deg)
  tumble: number; // side glass lean-in (deg)
  inset: number; // shoulder: cabin side inboard of the body side
  cornerF: [number, number]; // plan-view front corner [length along x, narrowing in z]
  cornerR: [number, number];
  beltRise: number;
  frontLift: number; // bumper underside rise at the nose
  rearLift: number;
  tailLean: number; // rear face lean above the bumper
  crown: number;
  roofArc: number;
}
// prettier-ignore
const SHAPES: Record<Profile, Shape> = {
  hatch:          { noseDrop: 0.2, noseSetback: 0.17, rake: 27, tumble: 20, inset: 0.075, cornerF: [0.42, 0.25], cornerR: [0.3, 0.12], beltRise: 0.06, frontLift: 0.13, rearLift: 0.17, tailLean: 0.06, crown: 0.03, roofArc: 0.015 },
  saloon:         { noseDrop: 0.22, noseSetback: 0.18, rake: 25, tumble: 22, inset: 0.08, cornerF: [0.45, 0.27], cornerR: [0.36, 0.16], beltRise: 0.05, frontLift: 0.12, rearLift: 0.16, tailLean: 0.08, crown: 0.03, roofArc: 0.025 },
  fastback:       { noseDrop: 0.22, noseSetback: 0.18, rake: 25, tumble: 22, inset: 0.08, cornerF: [0.45, 0.27], cornerR: [0.36, 0.16], beltRise: 0.05, frontLift: 0.12, rearLift: 0.16, tailLean: 0.08, crown: 0.03, roofArc: 0.03 },
  estate:         { noseDrop: 0.21, noseSetback: 0.18, rake: 26, tumble: 20, inset: 0.075, cornerF: [0.45, 0.27], cornerR: [0.28, 0.12], beltRise: 0.05, frontLift: 0.12, rearLift: 0.16, tailLean: 0.07, crown: 0.03, roofArc: 0.012 },
  coupe:          { noseDrop: 0.24, noseSetback: 0.2, rake: 23, tumble: 24, inset: 0.085, cornerF: [0.45, 0.28], cornerR: [0.36, 0.16], beltRise: 0.05, frontLift: 0.11, rearLift: 0.15, tailLean: 0.08, crown: 0.03, roofArc: 0.03 },
  convertible:    { noseDrop: 0.24, noseSetback: 0.2, rake: 24, tumble: 22, inset: 0.085, cornerF: [0.45, 0.28], cornerR: [0.36, 0.16], beltRise: 0.04, frontLift: 0.11, rearLift: 0.15, tailLean: 0.08, crown: 0.04, roofArc: 0.03 },
  suv:            { noseDrop: 0.17, noseSetback: 0.15, rake: 29, tumble: 15, inset: 0.07, cornerF: [0.4, 0.22], cornerR: [0.26, 0.1], beltRise: 0.07, frontLift: 0.14, rearLift: 0.18, tailLean: 0.06, crown: 0.03, roofArc: 0.01 },
  'suv-coupe':    { noseDrop: 0.17, noseSetback: 0.16, rake: 27, tumble: 18, inset: 0.075, cornerF: [0.4, 0.23], cornerR: [0.3, 0.12], beltRise: 0.11, frontLift: 0.14, rearLift: 0.18, tailLean: 0.08, crown: 0.03, roofArc: 0.02 },
  mpv:            { noseDrop: 0.22, noseSetback: 0.13, rake: 24, tumble: 14, inset: 0.06, cornerF: [0.4, 0.23], cornerR: [0.22, 0.09], beltRise: 0.04, frontLift: 0.13, rearLift: 0.16, tailLean: 0.05, crown: 0.03, roofArc: 0.01 },
  van:            { noseDrop: 0.13, noseSetback: 0.14, rake: 32, tumble: 4, inset: 0.012, cornerF: [0.36, 0.2], cornerR: [0.06, 0.03], beltRise: 0.0, frontLift: 0.12, rearLift: 0.1, tailLean: 0.015, crown: 0.025, roofArc: 0.0 },
  'van-high-roof':{ noseDrop: 0.13, noseSetback: 0.14, rake: 32, tumble: 4, inset: 0.012, cornerF: [0.36, 0.2], cornerR: [0.06, 0.03], beltRise: 0.0, frontLift: 0.12, rearLift: 0.1, tailLean: 0.015, crown: 0.03, roofArc: 0.0 },
  pickup:         { noseDrop: 0.09, noseSetback: 0.1, rake: 31, tumble: 12, inset: 0.05, cornerF: [0.34, 0.17], cornerR: [0.08, 0.04], beltRise: 0.0, frontLift: 0.16, rearLift: 0.14, tailLean: 0.0, crown: 0.02, roofArc: 0.0 }
};

export interface CarSpec {
  body: VehicleBodyType;
  profile: Profile;
  rear: RearKind;
  /** Stable cache key. */
  key: string;
  L: number;
  W: number;
  H: number;
  xF: number;
  xR: number;
  wheelbase: number;
  axleF: number;
  axleR: number;
  wheelR: number;
  rimR: number;
  tyreW: number;
  /** |z| of the wheel centre plane. */
  wheelZ: number;
  archR: number;
  gc: number;
  belt: number;
  beltRise: number;
  nose: number;
  noseSetback: number;
  cowlX: number;
  wsTopX: number;
  /** Roof height at its edges (the centre is `crown` higher). */
  roofY: number;
  crown: number;
  roofArc: number;
  /** Rear end of the flat roof. */
  roofEndX: number;
  /** Where the rear glass/slope meets the belt (hatch: tailgate bottom; saloon: front of the boot deck). Van/bed: the cab back. */
  cabinRearX: number;
  /** Cabin ends with a vertical wall (van rear, pick-up cab back). */
  cabinCap: boolean;
  roofHW: number;
  roofTaper: number;
  inset: number;
  tumble: number;
  cornerF: [number, number];
  cornerR: [number, number];
  frontLift: number;
  rearLift: number;
  tailLean: number;
  bumperTopF: number;
  bumperTopR: number;
  sillTop: number;
  doors: DoorCut[];
  windows: WindowCut[];
  doorCount: number;
  bPillarX: number;
  /** Van high roof: the raised roof starts here and is `highRoofY` tall. */
  highRoof?: { x: number; y: number; lowY: number };
  bed?: { x0: number; floor: number };
  roofRails: boolean;
  spareOnTailgate: boolean;
  slidingSideDoor: boolean;
  lampStyle: LampStyle;
  grilleStyle: GrilleStyle;
  spoiler: boolean;
  softTop: boolean;
  /** Black plastic lower cladding and arch trims (SUV / pick-up look). */
  cladding: boolean;
  /** Rear plate on the bumper (vans, pick-ups) rather than the tailgate/boot. */
  rearPlateLow: boolean;
  dims: Resolved;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Build the generator spec for a body type, optionally with real dimensions and identity. */
export function resolveSpec(body: VehicleBodyType, dims?: VehicleDims | null, identity?: VehicleIdentity | null): CarSpec {
  const profile = resolveProfile(body, dims, identity);
  const d = resolveDims(profile, dims, identity);
  const s = SHAPES[profile];
  const L = d.lengthMm / 1000;
  const W = d.widthMm / 1000;
  const H = d.heightMm / 1000;
  const xF = L / 2;
  const xR = -L / 2;
  const wheelbase = d.wheelbaseMm / 1000;
  const fo = d.frontOverhangRatio * L;
  const axleF = xF - fo;
  const axleR = axleF - wheelbase;
  const gc = d.groundClearanceMm / 1000;
  const rimR = (d.wheelDiameterIn * 0.0254) / 2;
  const isVan = profile === 'van' || profile === 'van-high-roof';
  const sidewall = isVan ? 0.13 : profile === 'pickup' ? 0.165 : profile === 'suv' || profile === 'suv-coupe' ? 0.118 - (d.wheelDiameterIn - 17) * 0.006 : 0.1 - (d.wheelDiameterIn - 16) * 0.006;
  const wheelR = rimR + clamp(sidewall, 0.07, 0.2);
  const tyreW = clamp(isVan ? 0.215 : profile === 'pickup' ? 0.265 : 0.195 + (d.wheelDiameterIn - 15) * 0.012, 0.165, 0.29);
  const wheelZ = W / 2 - tyreW / 2 - (isVan ? 0.03 : 0.035);
  const archR = wheelR + (profile === 'pickup' || profile === 'suv' ? 0.06 : 0.04);

  // vertical stations
  const roofTop = H - (d.roofRails ? 0.045 : 0);
  const crown = s.crown;
  const roofY = roofTop - crown;
  let belt = roofTop * (1 - d.glasshouseHeightRatio);
  if (profile === 'van-high-roof') belt = Math.min(belt, 1.2);
  belt = clamp(belt, wheelR * 2 + 0.12, roofY - 0.3);
  const highRoof = profile === 'van-high-roof' ? { lowY: Math.min(roofY - 0.25, belt + 0.72), y: roofY, x: 0 } : undefined;
  const nose = belt - s.noseDrop;
  const bumperTopF = Math.min(nose - 0.16, wheelR + 0.3);
  const bumperTopR = Math.min(belt - 0.2, wheelR + (isVan ? 0.32 : 0.26));
  const sillTop = gc + (profile === 'pickup' ? 0.16 : 0.11);

  // windscreen and roof
  let cowlX = xF - d.bonnetRatio * L;
  if (!isVan && profile !== 'mpv') cowlX = Math.min(cowlX, axleF - 0.12);
  cowlX = clamp(cowlX, axleF - wheelbase * 0.45, xF - 0.45);
  const glassH = (highRoof ? highRoof.lowY : roofY) - belt;
  let wsTopX = cowlX - glassH / Math.tan((s.rake * Math.PI) / 180);
  wsTopX = Math.max(wsTopX, axleF - wheelbase * 0.62);
  if (highRoof) highRoof.x = wsTopX - 0.32;

  let rear: RearKind;
  if (body === 'panel-van') rear = 'van';
  else if (body === 'pickup') rear = 'bed';
  else if (profile === 'saloon' || profile === 'coupe' || profile === 'convertible' || (profile === 'fastback' && (body === 'saloon' || body === 'coupe'))) rear = 'boot';
  else rear = 'hatch';

  const wR = wheelR;
  let roofEndX: number;
  let cabinRearX: number;
  let cabinCap = false;
  switch (profile) {
    case 'hatch':
      roofEndX = xR + 0.27 + L * 0.015;
      cabinRearX = xR + s.tailLean + 0.02;
      break;
    case 'estate':
      roofEndX = xR + 0.16;
      cabinRearX = xR + s.tailLean + 0.01;
      break;
    case 'suv':
      roofEndX = xR + 0.24;
      cabinRearX = xR + s.tailLean + 0.02;
      break;
    case 'suv-coupe':
      roofEndX = axleR + wR + 0.12;
      cabinRearX = xR + s.tailLean + 0.06;
      break;
    case 'mpv':
      roofEndX = xR + 0.16;
      cabinRearX = xR + s.tailLean + 0.01;
      break;
    case 'fastback':
      roofEndX = axleR + wR + 0.45;
      cabinRearX = xR + 0.3;
      break;
    case 'saloon':
      roofEndX = axleR + wR + 0.12;
      cabinRearX = axleR - 0.18;
      break;
    case 'coupe':
      roofEndX = axleR + wR + 0.3;
      cabinRearX = xR + 0.48;
      break;
    case 'convertible':
      roofEndX = axleR + wR + 0.05;
      cabinRearX = axleR - 0.12;
      break;
    case 'pickup':
      roofEndX = 0;
      cabinRearX = 0; // set after the doors
      cabinCap = true;
      break;
    default: // vans
      roofEndX = xR + s.tailLean + 0.01;
      cabinRearX = roofEndX;
      cabinCap = true;
  }
  if (rear === 'hatch' && (profile === 'saloon' || profile === 'coupe')) {
    // a tailgate body drawn with a notchback profile: keep the shape
  }

  // doors
  const doorsWanted = d.doors;
  const doorFront = Math.min(cowlX - 0.02, axleF - wR - (isVan ? 0.06 : 0.11));
  const doors: DoorCut[] = [];
  const windows: WindowCut[] = [];
  const rearArchFront = axleR + archR;
  let bX: number;
  if (isVan) {
    bX = doorFront - clamp(wheelbase * 0.31, 0.85, 1.0);
    doors.push({ zone: 'front_door', x0: bX, x1: doorFront });
    if (body === 'mpv' || d.slidingSideDoor || body === 'panel-van') {
      const sx1 = bX - 0.03;
      doors.push({ zone: 'sliding_door', x0: Math.max(sx1 - 1.05, rearArchFront + 0.05), x1: sx1, tall: body === 'panel-van' });
    }
    windows.push({ zone: 'front_door_glass', x0: bX + 0.05, x1: doorFront + 0.04 });
    if (body === 'mpv') {
      const sd = doors[1]!;
      windows.push({ zone: 'rear_door_glass', x0: sd.x0 + 0.05, x1: sd.x1 - 0.05 });
      windows.push({ zone: 'quarter_glass', x0: roofEndX + 0.25, x1: sd.x0 - 0.06 });
    }
  } else if (profile === 'pickup') {
    const twoDoor = doorsWanted <= 2;
    bX = doorFront - clamp(wheelbase * 0.33, 0.95, 1.08);
    doors.push({ zone: 'front_door', x0: bX, x1: doorFront });
    windows.push({ zone: 'front_door_glass', x0: bX + 0.05, x1: doorFront + 0.04 });
    if (!twoDoor) {
      const rx0 = bX - clamp(wheelbase * 0.27, 0.72, 0.86);
      doors.push({ zone: 'rear_door', x0: rx0, x1: bX });
      windows.push({ zone: 'rear_door_glass', x0: rx0 + 0.06, x1: bX - 0.04 });
      cabinRearX = rx0 - 0.07;
    } else cabinRearX = bX - 0.28;
    roofEndX = cabinRearX;
  } else {
    const twoDoor = doorsWanted <= 3 || profile === 'coupe' || profile === 'convertible';
    if (twoDoor) {
      bX = doorFront - clamp(wheelbase * 0.46, 1.02, 1.32);
      doors.push({ zone: 'front_door', x0: bX, x1: doorFront });
      windows.push({ zone: 'front_door_glass', x0: bX + 0.05, x1: doorFront + 0.04 });
      const qEnd = Math.max(roofEndX + (rear === 'boot' ? 0.1 : 0.2), cabinRearX + 0.25);
      if (bX - 0.06 - qEnd > 0.12) windows.push({ zone: 'quarter_glass', x0: qEnd, x1: bX - 0.06 });
    } else {
      bX = doorFront - clamp(wheelbase * (profile === 'mpv' ? 0.37 : 0.385), 0.9, 1.18);
      const rdEnd = Math.max(rearArchFront - archR * 0.45, bX - 1.1);
      const rearZone = body === 'mpv' ? 'sliding_door' : 'rear_door';
      doors.push({ zone: 'front_door', x0: bX, x1: doorFront });
      doors.push({ zone: rearZone, x0: rdEnd, x1: bX });
      windows.push({ zone: 'front_door_glass', x0: bX + 0.045, x1: doorFront + 0.04 });
      const rgEnd = Math.max(rdEnd + 0.07, roofEndX + 0.05);
      windows.push({ zone: 'rear_door_glass', x0: rgEnd, x1: bX - 0.045 });
      const qEnd = Math.max(roofEndX + (rear === 'boot' ? 0.06 : profile === 'hatch' ? 0.14 : 0.22), cabinRearX + 0.2);
      if (rdEnd - 0.05 - qEnd > 0.1) windows.push({ zone: 'quarter_glass', x0: qEnd, x1: rdEnd - 0.05 });
    }
  }
  const doorCount = doors.length * 2 + (rear === 'hatch' ? 1 : 0);

  const roofHW = clamp(W / 2 - s.inset - glassH * Math.tan((s.tumble * Math.PI) / 180), W * 0.3, W / 2 - 0.02);
  const bed = rear === 'bed' ? { x0: cabinRearX - 0.02, floor: belt - 0.42 } : undefined;
  const key = [body, profile, d.lengthMm, d.widthMm, d.heightMm, d.wheelbaseMm, d.groundClearanceMm, d.wheelDiameterIn, d.bonnetRatio, d.frontOverhangRatio.toFixed(4), d.glasshouseHeightRatio, d.roofTaper, d.doors, d.roofRails, d.spareOnTailgate, d.slidingSideDoor, d.lampStyle, d.grilleStyle].join('|');

  return {
    body,
    profile,
    rear,
    key,
    L,
    W,
    H,
    xF,
    xR,
    wheelbase,
    axleF,
    axleR,
    wheelR,
    rimR,
    tyreW,
    wheelZ,
    archR,
    gc,
    belt,
    beltRise: s.beltRise,
    nose,
    noseSetback: s.noseSetback,
    cowlX,
    wsTopX,
    roofY,
    crown,
    roofArc: s.roofArc,
    roofEndX,
    cabinRearX,
    cabinCap,
    roofHW,
    roofTaper: d.roofTaper,
    inset: s.inset,
    tumble: s.tumble,
    cornerF: s.cornerF,
    cornerR: s.cornerR,
    frontLift: s.frontLift,
    rearLift: s.rearLift,
    tailLean: s.tailLean,
    bumperTopF,
    bumperTopR,
    sillTop,
    doors,
    windows,
    doorCount,
    bPillarX: bX,
    ...(highRoof ? { highRoof } : {}),
    ...(bed ? { bed } : {}),
    roofRails: d.roofRails,
    spareOnTailgate: d.spareOnTailgate,
    slidingSideDoor: d.slidingSideDoor || body === 'panel-van',
    lampStyle: d.lampStyle,
    grilleStyle: d.grilleStyle,
    spoiler: rear === 'hatch' && !isVan,
    softTop: profile === 'convertible',
    cladding: profile === 'suv' || profile === 'pickup' || profile === 'suv-coupe',
    rearPlateLow: isVan || rear === 'bed',
    dims: d
  };
}

/** Default spec per body type (no dimensions on file). */
export function defaultSpec(body: VehicleBodyType): CarSpec {
  return resolveSpec(body);
}
