/**
 * Exact (licensed) 3D vehicle models (slice `exact-models`).
 *
 * The owner can import a .glb / .gltf model they hold a licence for and assign it to a make / model / generation (and
 * optionally a body) from the vehicle catalogue. The engineer's damage model then shows that model instead of the
 * generated one. Audatex / Qapter models are proprietary and cannot be imported; nothing here fetches models from
 * anywhere — the file always comes from the user.
 *
 * Storage (never in the repository): `<DATA_DIR>/models3d/<id>/{record.json, model.glb, thumbnail.png}`.
 *  - Every upload is normalised to ONE self-contained binary glTF (`model.glb`): .gltf + .bin + textures (zipped, or a
 *    .gltf with data: URIs) are packed into the GLB binary chunk, so the browser never resolves an external URI.
 *  - Validation: glTF 2.0 header / JSON, size (MODELS3D_MAX_MB, default 200 MB), triangle and node limits, buffer
 *    and buffer-view bounds, no external URIs (http:, file:, absolute paths, `..`), images must really be PNG / JPEG /
 *    WebP (magic bytes), no scripting extensions or script-like strings, no compression the browser cannot decode
 *    here (Draco, meshopt and Basis need WebAssembly, which the app's content security policy does not allow).
 *  - Automatic damage-zone mapping by node / mesh / material names (`zoneForPartName`: a dictionary of part words in
 *    English and common vendor / European naming, left/right/front/rear words and corner codes such as FL, RR, LH, O/S),
 *    with missing sides / ends and unnamed painted panels resolved from each part's position on the car.
 *  - Manual tags (`tags`) override the automatic map per part and are saved with the model; `null` = "not a damage part".
 *
 * Part keys: `n<node>p<primitive>` — the glTF node index and primitive index. three.js' GLTFLoader keeps both in
 * `parser.associations`, so the browser and the server name the same mesh the same way (node names are sanitised by
 * the loader and are not unique, indices are).
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { unzipSync } from 'fflate';
import type { AppContext } from '../context.js';
import { HttpError, notFound } from '../errors.js';
import { getModel, listMakes, matchVehicle } from './catalogue.js';

const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface Models3dLimits {
  /** Largest upload (a .glb, a .gltf or a .zip). */
  maxBytes: number;
  /** Largest total of the files unpacked from a .zip. */
  maxUnpackedBytes: number;
  maxTriangles: number;
  maxNodes: number;
  maxZipEntries: number;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

/** Read per request so tests (and the owner) can change them through the environment. */
export function models3dLimits(env: NodeJS.ProcessEnv = process.env): Models3dLimits {
  const maxBytes = envInt(env, 'MODELS3D_MAX_MB', 200, 1, 2048) * MIB;
  return {
    maxBytes,
    maxUnpackedBytes: maxBytes * 2,
    maxTriangles: envInt(env, 'MODELS3D_MAX_TRIANGLES', 3_000_000, 1, 50_000_000),
    maxNodes: envInt(env, 'MODELS3D_MAX_NODES', 20_000, 1, 1_000_000),
    maxZipEntries: 500,
  };
}

export const MODELS3D_ACCEPT = ['.glb', '.gltf', '.zip'] as const;
export const LICENCE_NOTICE = 'Use only models you have a licence for. Audatex/Qapter models cannot be imported.';

// ---------------------------------------------------------------------------
// Zones (mirror of packages/domain/src/engineering/panels.ts VEHICLE_ZONES ids; the API cannot import that file —
// the test checks the two lists stay identical)
// ---------------------------------------------------------------------------

const PAIRED = [
  'chassis_leg', 'headlamp', 'fog_lamp', 'rear_lamp', 'front_wing', 'front_door', 'rear_door', 'sliding_door', 'quarter_panel', 'load_side_panel',
  'load_bed_side', 'sill', 'a_pillar', 'b_pillar', 'door_mirror', 'wheel_arch_trim', 'front_door_glass', 'rear_door_glass', 'quarter_glass', 'roof_rail',
  'rear_load_door', 'front_suspension', 'rear_suspension',
] as const;
const SINGLE = [
  'front_bumper', 'front_lower_grille', 'grille', 'bonnet', 'front_panel', 'radiator', 'front_parking_sensors', 'front_radar', 'high_level_brake_lamp',
  'windscreen', 'rear_screen', 'sunroof', 'roof', 'soft_top', 'rear_bumper', 'tailgate', 'boot_lid', 'load_bed_tailgate', 'load_bed_floor', 'rear_panel',
  'boot_floor', 'rear_parking_sensors', 'reversing_camera', 'spoiler', 'wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr', 'floor_pan', 'exhaust', 'dashboard',
  'airbags', 'seats',
] as const;
export const MODEL_ZONE_IDS: readonly string[] = [...PAIRED.flatMap((b) => [`${b}_l`, `${b}_r`]), ...SINGLE];
const ZONE_SET = new Set(MODEL_ZONE_IDS);
export const isModelZoneId = (z: unknown): z is string => typeof z === 'string' && ZONE_SET.has(z);

export const MODEL_BODY_TYPES = ['hatchback', 'saloon', 'estate', 'coupe', 'convertible', 'suv', 'mpv', 'panel-van', 'pickup'] as const;
export type ModelBodyType = (typeof MODEL_BODY_TYPES)[number];

/** Same rules as normaliseBodyType in @ccguk/domain engineering/panels.ts ('' → undefined here). */
export function normaliseModelBody(text: string | null | undefined): ModelBodyType | undefined {
  const t = (text ?? '').toLowerCase();
  if (!t.trim()) return undefined;
  if ((MODEL_BODY_TYPES as readonly string[]).includes(t)) return t as ModelBodyType;
  if (/pick[\s-]?up|double cab|crew cab|king cab|single cab|chassis-cab/.test(t)) return 'pickup';
  if (/\bvan\b|panel|box van|luton|crew van|crew-van|combi|light goods|lcv|minibus|camper/.test(t)) return 'panel-van';
  if (/convertible|cabrio|roadster|spider|spyder|soft[\s-]?top|drophead|volante/.test(t)) return 'convertible';
  if (/coup[eé]/.test(t)) return 'coupe';
  if (/\bmpv\b|people carrier|multi[\s-]?purpose|minivan/.test(t)) return 'mpv';
  if (/\bsuv\b|4x4|crossover|off[\s-]?road|sport utility/.test(t)) return 'suv';
  if (/estate|tourer|touring|avant|wagon|shooting[\s-]brake|variant\b/.test(t)) return 'estate';
  if (/saloon|sedan|limousine/.test(t)) return 'saloon';
  if (/hatch|sportback|fastback|liftback/.test(t)) return 'hatchback';
  return 'hatchback';
}

const TAILGATE_BODIES: readonly ModelBodyType[] = ['hatchback', 'estate', 'suv', 'mpv'];
const BOOT_BODIES: readonly ModelBodyType[] = ['saloon', 'coupe', 'convertible'];

// ---------------------------------------------------------------------------
// Name dictionary → zone
// ---------------------------------------------------------------------------

export type PartPos = 'front' | 'rear';
export type PartSide = 'l' | 'r';

/** Where a part sits on the car, from its bounding box (filled in when the model has geometry bounds). */
export interface GeoHint {
  pos: PartPos;
  side: PartSide;
  /** -1 rear … +1 front (part centre along the car). */
  u: number;
  /** -1 right … +1 left (part centre across the car). */
  v: number;
  /** 0 ground … 1 roof (part centre height). */
  h: number;
  /** Part size as a fraction of the car's length / width / height. */
  size: [number, number, number];
}

export interface ZoneGuess {
  zone: string | null;
  /** 'name': everything from the name; 'name+position': a side or end came from the part's position. */
  source: 'name' | 'name+position' | 'position';
  confidence: number;
  rule: string;
}

/** Words that carry no meaning in vendor part names. */
const NOISE = new Set([
  'mesh', 'meshes', 'geo', 'geom', 'geometry', 'obj', 'object', 'node', 'lod', 'lod0', 'lod1', 'mat', 'material', 'mtl', 'shape', 'poly', 'polysurface',
  'polysurface1', 'primitive', 'prim', 'group', 'grp', 'part', 'parts', 'low', 'high', 'hp', 'lp', 'sm', 'ext', 'exterior', 'car', 'vehicle', 'model', 'default',
  'scene', 'root', 'gltf', 'fbx', 'max', 'blend', 'copy', 'instance', 'inst', 'new', 'final', 'main', 'the', 'of', 'and', 'with', 'assembly', 'asm', 'cmp',
  'component', 'element', 'elem', 'piece', 'pc', 'item', 'surface', 'surf', 'subdiv', 'smooth', 'tris', 'quad', 'quads', 'ngon', 'n', 'o', 's',
]);

/** Side / end words. 'r' alone is resolved by the rule (right on a sided part, rear on a centre part). */
const LEFT = new Set(['l', 'lh', 'lhs', 'left', 'lt', 'ns', 'nearside', 'links', 'li', 'gauche', 'sx', 'sinistra', 'sinistro', 'izq', 'izquierda', 'izquierdo', 'esq', 'esquerda', 'esquerdo']);
const RIGHT = new Set(['rh', 'rhs', 'right', 'rt', 'os', 'offside', 'rechts', 'droite', 'droit', 'dx', 'destra', 'destro', 'der', 'derecha', 'derecho', 'dir', 'direita', 'direito']);
const FRONT = new Set(['f', 'front', 'frt', 'fwd', 'forward', 'vorne', 'vorn', 'vo', 'avant', 'av', 'anteriore', 'ant', 'delantero', 'delantera', 'del', 'dianteiro', 'dianteira', 'nose']);
const REAR = new Set(['rear', 'back', 'bk', 'hinten', 'hinter', 'arriere', 'arr', 'ar', 'posteriore', 'post', 'trasero', 'trasera', 'tras', 'traseiro', 'traseira', 'tail']);
/** Corner codes: [end, side]. */
const CORNERS: Record<string, [PartPos, PartSide]> = {
  fl: ['front', 'l'], lf: ['front', 'l'], flh: ['front', 'l'], fls: ['front', 'l'], vl: ['front', 'l'], avg: ['front', 'l'], lhf: ['front', 'l'],
  fr: ['front', 'r'], rf: ['front', 'r'], frh: ['front', 'r'], frs: ['front', 'r'], vr: ['front', 'r'], avd: ['front', 'r'], rhf: ['front', 'r'],
  rl: ['rear', 'l'], lr: ['rear', 'l'], rlh: ['rear', 'l'], bl: ['rear', 'l'], arg: ['rear', 'l'], lhr: ['rear', 'l'],
  rr: ['rear', 'r'], rrh: ['rear', 'r'], br: ['rear', 'r'], ard: ['rear', 'r'], rhr: ['rear', 'r'],
};

interface Quals {
  side?: PartSide;
  pos?: PartPos;
  /** A bare 'r' that has not been read yet. */
  bareR: boolean;
}

function readQuals(tokens: readonly string[]): Quals {
  const q: Quals = { bareR: false };
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    const next = tokens[i + 1];
    if ((t === 'n' || t === 'o') && next === 's') {
      q.side ??= t === 'n' ? 'l' : 'r';
      i += 1;
      continue;
    }
    const corner = CORNERS[t];
    if (corner) {
      q.pos ??= corner[0];
      q.side ??= corner[1];
    } else if (LEFT.has(t)) q.side ??= 'l';
    else if (RIGHT.has(t)) q.side ??= 'r';
    else if (FRONT.has(t)) q.pos ??= 'front';
    else if (REAR.has(t)) q.pos ??= 'rear';
    else if (t === 'r') q.bareR = true;
  }
  return q;
}

/** Context a rule builds its zone from. Reading a side or end the name did not give falls back to the part's position. */
class RuleCtx {
  usedGeo = false;
  private rTaken = false;
  private sideMemo: { v: PartSide | undefined } | undefined;
  constructor(
    readonly tokens: readonly string[],
    readonly text: string,
    private readonly quals: Quals,
    readonly body: ModelBodyType | undefined,
    readonly geo: GeoHint | undefined,
  ) {}
  has(...phrases: string[]): boolean {
    return phrases.some((p) => this.text.includes(` ${p} `));
  }
  /** Side from the name (a bare R counts as right), else the part's position. */
  side(): PartSide | undefined {
    if (this.sideMemo) return this.sideMemo.v;
    let v: PartSide | undefined;
    if (this.quals.side) v = this.quals.side;
    else if (this.quals.bareR && !this.rTaken) {
      this.rTaken = true;
      v = 'r';
    } else if (this.geo) {
      this.usedGeo = true;
      v = this.geo.side;
    }
    this.sideMemo = { v };
    return v;
  }
  /** End from the name (a bare R counts as rear when the side did not take it), else the part's position. */
  pos(): PartPos | undefined {
    if (this.quals.pos) return this.quals.pos;
    if (this.quals.bareR && !this.rTaken && !this.quals.side) {
      this.rTaken = true;
      return 'rear';
    }
    if (this.geo) {
      this.usedGeo = true;
      return this.geo.pos;
    }
    return undefined;
  }
  /** End from the name only (no position fallback). */
  namedPos(): PartPos | undefined {
    return this.quals.pos ?? (this.quals.bareR && !this.rTaken && !this.quals.side ? 'rear' : undefined);
  }
  /** Side from the name only (L / RH / FL / nearside …; a bare R is not read here). */
  namedSide(): PartSide | undefined {
    return this.quals.side;
  }
  sided(base: string): string | null {
    const s = this.side();
    return s ? `${base}_${s}` : null;
  }
}

interface PartRule {
  rule: string;
  /** Any of these phrases (space-separated tokens) must appear. */
  any: string[];
  /** None of these may appear. */
  not?: string[];
  /** The zone, or null for a recognised part that is not a damage zone (engine, interior mirror, ground plane). */
  build: (c: RuleCtx) => string | null;
  /** Recognised but deliberately not mapped. */
  ignore?: boolean;
}

const GLASS = ['glass', 'window', 'windows', 'scheibe', 'vitre', 'vetro', 'cristal', 'vidrio', 'vidro', 'pane'];
const DOOR = ['door', 'doors', 'tuer', 'tur', 'porte', 'portiere', 'portiera', 'porta', 'puerta'];

function rearClosure(c: RuleCtx, explicitHatch: boolean): string | null {
  const b = c.body;
  if (b === 'pickup') return 'load_bed_tailgate';
  if (b === 'panel-van') return c.sided('rear_load_door') ?? 'rear_load_door_l';
  if (b && TAILGATE_BODIES.includes(b)) return 'tailgate';
  if (b && BOOT_BODIES.includes(b)) return 'boot_lid';
  return explicitHatch ? 'tailgate' : 'boot_lid';
}

function rearSidePanel(c: RuleCtx): string | null {
  const base = c.body === 'panel-van' ? 'load_side_panel' : c.body === 'pickup' ? 'load_bed_side' : 'quarter_panel';
  return c.sided(base);
}

function bumperFor(c: RuleCtx): string | null {
  const p = c.pos();
  return p === 'rear' ? 'rear_bumper' : p === 'front' ? 'front_bumper' : null;
}

/** Ordered: the first rule whose words appear wins, so the more specific rules come first. */
export const PART_RULES: readonly PartRule[] = [
  // things that are not part of the car or not damage zones
  { rule: 'ignore:scene', any: ['shadow', 'ground', 'backdrop', 'studio', 'floor plane', 'ground plane', 'turntable', 'environment', 'skybox', 'collider', 'collision', 'helper', 'dummy', 'locator', 'camera target'], build: () => null, ignore: true },
  { rule: 'ignore:interior-mirror', any: ['rear view mirror', 'rearview mirror', 'rearview', 'interior mirror', 'inner mirror', 'inside mirror', 'innenspiegel'], build: () => null, ignore: true },
  { rule: 'ignore:driver', any: ['driver model', 'character', 'human', 'person', 'mannequin'], build: () => null, ignore: true },
  { rule: 'ignore:mechanical', any: ['engine', 'motor', 'gearbox', 'transmission', 'driveshaft', 'drive shaft', 'propshaft', 'differential', 'battery', 'fuel tank', 'tank', 'brake line', 'wiring', 'cable', 'hose', 'pipe', 'turbo', 'alternator'], not: ['exhaust', 'tail pipe', 'tailpipe', 'cover', 'bay', 'flap', 'cap', 'door', 'lid', 'filler', 'hood', 'bonnet'], build: () => null, ignore: true },

  // number plates sit on the bumpers; they are also used to show the registration
  {
    rule: 'plate',
    any: ['license plate', 'licence plate', 'number plate', 'numberplate', 'licenseplate', 'licenceplate', 'reg plate', 'registration plate', 'plate', 'kennzeichen', 'nummernschild', 'plaque', 'targa', 'matricula', 'license', 'licence'],
    not: ['skid plate', 'floor plate', 'plate glass', 'scuff plate', 'kick plate', 'tread plate', 'plate light', 'plate lamp', 'license light', 'licence light'],
    build: bumperFor,
  },

  // glass first: "door glass" must not become the door
  { rule: 'glass:windscreen', any: ['windscreen', 'windshield', 'wind shield', 'front screen', 'frontscheibe', 'windschutzscheibe', 'pare brise', 'parebrise', 'parabrezza', 'parabrisas', 'para brisa'], build: () => 'windscreen' },
  { rule: 'glass:sunroof', any: ['sunroof', 'sun roof', 'moonroof', 'moon roof', 'panoramic', 'pano roof', 'roof glass', 'glass roof', 'schiebedach', 'panoramadach', 'toit ouvrant', 'tetto apribile'], build: () => 'sunroof' },
  {
    rule: 'glass:door',
    any: GLASS,
    build: (c) => {
      if (!c.has(...DOOR)) return null;
      const s = c.side();
      if (!s) return null;
      return `${c.pos() === 'rear' ? 'rear' : 'front'}_door_glass_${s}`;
    },
  },
  { rule: 'glass:quarter', any: ['quarter glass', 'quarter window', 'quarter light', 'quarterglass', 'side glass rear', 'rear side glass', 'rear side window', 'c pillar glass', 'opera window'], build: (c) => c.sided('quarter_glass') },
  {
    rule: 'glass:quarter-words',
    any: GLASS,
    build: (c) => (c.has('quarter', 'qtr') ? c.sided('quarter_glass') : null),
  },
  { rule: 'glass:rear-screen', any: ['rear screen', 'rear windscreen', 'backlight', 'back light', 'heckscheibe', 'lunette', 'lunotto', 'luneta', 'tailgate glass', 'hatch glass', 'boot glass', 'trunk glass', 'rear windshield'], not: ['lamp', 'tail light', 'taillight'], build: () => 'rear_screen' },
  {
    rule: 'glass:by-position',
    any: GLASS,
    not: ['lamp', 'light', 'lens', 'headlight', 'headlamp', 'mirror'],
    build: (c) => {
      const named = c.namedPos();
      if (c.has('side')) return c.sided(named === 'rear' ? 'rear_door_glass' : 'front_door_glass');
      // a screen has no side: "Window_FL" / "Glass_RR" / "window_left" is a side window
      if (c.namedSide()) return c.sided((named ?? c.pos()) === 'rear' ? 'rear_door_glass' : 'front_door_glass');
      if (named === 'front') return 'windscreen';
      if (named === 'rear') return 'rear_screen';
      const g = c.geo;
      if (!g) return null;
      c.usedGeo = true;
      if (Math.abs(g.v) >= 0.45) return `${g.u >= -0.05 ? 'front' : 'rear'}_door_glass_${g.side}`;
      if (g.h >= 0.88 && Math.abs(g.u) < 0.4) return 'sunroof';
      return g.u >= 0 ? 'windscreen' : 'rear_screen';
    },
  },

  // lamps
  { rule: 'lamp:high-level-brake', any: ['high level brake', 'high level stop', 'third brake', '3rd brake', 'chmsl', 'hmsl', 'high mount stop', 'high mount brake', 'centre brake', 'center brake', 'top brake', 'brake light center', 'brake light centre', 'dritte bremsleuchte'], build: () => 'high_level_brake_lamp' },
  { rule: 'lamp:fog', any: ['fog', 'foglight', 'foglamp', 'foglights', 'nebel', 'nebelscheinwerfer', 'antibrouillard', 'fendinebbia', 'antiniebla'], build: (c) => c.sided(c.pos() === 'rear' ? 'rear_lamp' : 'fog_lamp') },
  { rule: 'lamp:head', any: ['headlight', 'headlights', 'headlamp', 'headlamps', 'head light', 'head lamp', 'hl', 'scheinwerfer', 'phare', 'phares', 'faro', 'faros', 'fanale anteriore', 'farol', 'drl', 'daytime running', 'front light', 'front lamp', 'frontlight', 'frontlamp', 'projector'], build: (c) => c.sided('headlamp') },
  { rule: 'lamp:rear', any: ['taillight', 'taillights', 'tail light', 'tail lights', 'tail lamp', 'taillamp', 'rear light', 'rear lights', 'rear lamp', 'stoplight', 'stop light', 'stop lamp', 'brake light', 'brakelight', 'brake lamp', 'reverse light', 'reversing light', 'reversing lamp', 'backup light', 'rueckleuchte', 'ruckleuchte', 'heckleuchte', 'feu arriere', 'feux arriere', 'fanale posteriore', 'piloto', 'lanterna', 'combination lamp'], build: (c) => c.sided('rear_lamp') },
  {
    rule: 'lamp:indicator',
    any: ['indicator', 'blinker', 'turn signal', 'turnsignal', 'turn light', 'repeater', 'side marker', 'marker light', 'clignotant', 'freccia', 'intermitente', 'pisca'],
    build: (c) => {
      if (c.has('mirror')) return c.sided('door_mirror');
      if (c.has('side repeater', 'repeater', 'side marker') && c.namedPos() !== 'rear') return c.sided('front_wing');
      return c.sided(c.pos() === 'rear' ? 'rear_lamp' : 'headlamp');
    },
  },

  {
    rule: 'lamp:generic',
    any: ['light', 'lights', 'lamp', 'lamps', 'lens', 'lenses', 'leuchte', 'licht', 'feu', 'luce', 'luz'],
    not: ['dome', 'reading', 'interior', 'courtesy', 'mirror', 'plate', 'license', 'licence', 'number', 'puddle', 'boot light', 'trunk light'],
    build: (c) => c.sided(c.pos() === 'rear' ? 'rear_lamp' : 'headlamp'),
  },

  // mirrors
  { rule: 'mirror', any: ['mirror', 'mirrors', 'wing mirror', 'side mirror', 'door mirror', 'spiegel', 'aussenspiegel', 'retro', 'retroviseur', 'specchietto', 'specchio', 'espejo', 'retrovisor'], build: (c) => c.sided('door_mirror') },

  // structure before wings and interior ("inner wing")
  { rule: 'struct:chassis-leg', any: ['chassis leg', 'chassis rail', 'frame rail', 'crash can', 'crash box', 'crashbox', 'inner wing', 'strut tower', 'suspension tower', 'longitudinal', 'laengstraeger', 'langstrager', 'longeron'], build: (c) => c.sided('chassis_leg') },
  { rule: 'struct:front-panel', any: ['front panel', 'slam panel', 'radiator support', 'front end carrier', 'core support', 'front crossmember', 'front cross member', 'schlosstraeger', 'frontmaske'], not: DOOR, build: () => 'front_panel' },
  { rule: 'struct:rear-panel', any: ['rear panel', 'back panel', 'tail panel', 'rear end panel', 'rear crossmember', 'rear cross member', 'heckblech', 'heckabschluss', 'jupe arriere'], not: DOOR, build: () => 'rear_panel' },

  // steering wheel before wheels
  { rule: 'interior:steering', any: ['steering wheel', 'steeringwheel', 'steering', 'lenkrad', 'volant', 'volante'], build: () => 'dashboard' },
  // arches before wheels ("wheel arch")
  {
    rule: 'arch',
    any: ['wheel arch', 'wheelarch', 'arch', 'arches', 'fender flare', 'flare', 'flares', 'arch trim', 'cladding', 'wheel well', 'wheelwell', 'arch liner', 'wheelhouse', 'radhaus', 'radlauf', 'passage de roue'],
    build: (c) => {
      if ((c.body === 'suv' || c.body === 'pickup') && c.has('trim', 'cladding', 'flare', 'flares', 'fender flare', 'arch trim', 'moulding', 'molding')) return c.sided('wheel_arch_trim');
      return c.pos() === 'rear' ? rearSidePanel(c) : c.sided('front_wing');
    },
  },
  {
    rule: 'wheel',
    any: ['wheel', 'wheels', 'rim', 'rims', 'tyre', 'tire', 'tyres', 'tires', 'alloy', 'alloys', 'hubcap', 'hub cap', 'wheel cover', 'wheelcover', 'felge', 'felgen', 'reifen', 'raeder', 'roue', 'roues', 'pneu', 'pneus', 'jante', 'ruota', 'ruote', 'cerchio', 'gomma', 'rueda', 'llanta', 'neumatico', 'roda', 'brake disc', 'brake disk', 'brake rotor', 'disc', 'disk', 'rotor', 'caliper', 'calliper', 'brake caliper', 'bremse', 'bremsscheibe', 'bremssattel', 'lug nut', 'wheel nut', 'wheel bolt', 'valve'],
    not: ['spare', 'reserverad', 'roue de secours'],
    build: (c) => {
      const s = c.side();
      const p = c.pos();
      if (!s || !p) return null;
      return `wheel_${p === 'front' ? 'f' : 'r'}${s}`;
    },
  },

  // bumpers and their trims
  { rule: 'bumper:lower-grille', any: ['lower grille', 'lower grill', 'bumper grille', 'bumper grill', 'lower intake', 'air intake', 'intake grille', 'bumper vent', 'grille lower'], build: () => 'front_lower_grille' },
  { rule: 'bumper:diffuser', any: ['diffuser', 'diffusor'], build: () => 'rear_bumper' },
  { rule: 'bumper:splitter', any: ['splitter', 'front lip', 'lip spoiler front', 'chin spoiler', 'air dam', 'frontspoiler', 'front spoiler'], build: () => 'front_bumper' },
  { rule: 'bumper:valance', any: ['valance', 'apron'], build: (c) => (c.pos() === 'rear' ? 'rear_panel' : 'front_bumper') },
  { rule: 'bumper:tow', any: ['tow hook', 'tow eye', 'towbar', 'tow bar', 'towing', 'hitch', 'anhaengerkupplung'], build: bumperFor },
  {
    rule: 'bumper',
    any: ['bumper', 'bumpers', 'bumper cover', 'bumper bar', 'stossstange', 'stossfanger', 'stossfaenger', 'pare choc', 'parechoc', 'pare chocs', 'paraurti', 'paragolpes', 'parachoque', 'parachoques', 'para choque', 'bumpercover', 'fascia'],
    build: (c) => {
      // "fascia" alone is the dashboard in British English; "front fascia" is the bumper cover.
      if (c.has('fascia') && !c.has('bumper', 'bumpers', 'bumper cover') && !c.namedPos()) return 'dashboard';
      return bumperFor(c);
    },
  },
  { rule: 'grille', any: ['grille', 'grill', 'grilles', 'kuehlergrill', 'kuhlergrill', 'calandre', 'griglia', 'calandra', 'parrilla', 'kidney', 'kidneys', 'radiator grille', 'front grille'], build: (c) => (c.namedPos() === 'rear' ? 'rear_bumper' : 'grille') },

  // sensors
  { rule: 'sensor:parking', any: ['parking sensor', 'park sensor', 'parking sensors', 'pdc', 'parktronic', 'park assist', 'ultrasonic', 'parksensor', 'einparkhilfe'], build: (c) => (c.pos() === 'rear' ? 'rear_parking_sensors' : 'front_parking_sensors') },
  { rule: 'sensor:radar', any: ['radar', 'lidar', 'acc sensor', 'distance sensor', 'adas', 'front camera', 'front cam'], build: () => 'front_radar' },
  { rule: 'sensor:camera', any: ['reversing camera', 'reverse camera', 'rear camera', 'backup camera', 'rear cam', 'rueckfahrkamera', 'camera', 'cam'], build: (c) => (c.pos() === 'front' ? 'front_radar' : 'reversing_camera') },

  // bonnet / soft top
  { rule: 'soft-top', any: ['soft top', 'softtop', 'convertible top', 'cabrio top', 'cabriolet top', 'roof fabric', 'hood fabric', 'canvas', 'verdeck', 'capote'], build: () => 'soft_top' },
  {
    rule: 'bonnet',
    any: ['bonnet', 'hood', 'engine hood', 'engine lid', 'motorhaube', 'haube', 'capot', 'cofano', 'capo', 'capota', 'hood scoop', 'bonnet scoop'],
    not: ['hood fabric', 'hood lining'],
    build: (c) => (c.body === 'convertible' && c.has('fabric', 'soft', 'top', 'canvas', 'cloth', 'folding') ? 'soft_top' : 'bonnet'),
  },

  // rear closures
  { rule: 'boot:floor', any: ['boot floor', 'trunk floor', 'spare wheel', 'spare tire', 'spare tyre', 'spare wheel well', 'luggage floor', 'cargo floor', 'boot liner', 'trunk liner', 'boot carpet', 'trunk carpet', 'kofferraumboden'], build: (c) => (c.body === 'pickup' ? 'load_bed_floor' : 'boot_floor') },
  { rule: 'tailgate', any: ['tailgate', 'tail gate', 'hatch', 'hatchback door', 'liftgate', 'lift gate', 'heckklappe', 'hayon', 'portellone', 'porton', 'portao', 'rear hatch', 'boot door', 'tailboard', 'tail board'], build: (c) => rearClosure(c, true) },
  { rule: 'boot', any: ['boot', 'bootlid', 'boot lid', 'trunk', 'trunk lid', 'trunklid', 'decklid', 'deck lid', 'kofferraumdeckel', 'kofferraum', 'kofferdeckel', 'coffre', 'bagagliaio', 'maletero', 'baul', 'porta malas', 'portamalas'], build: (c) => rearClosure(c, false) },
  { rule: 'van:rear-door', any: ['barn door', 'barn doors', 'rear load door', 'cargo door', 'cargo doors', 'load door', 'hecktuer', 'hecktur', 'portes arriere'], build: (c) => (c.body === 'panel-van' || !c.body ? c.sided('rear_load_door') : rearClosure(c, true)) },

  // spoiler: a rear "wing" up high in the middle is a spoiler; otherwise "rear wing" is the British quarter panel
  { rule: 'spoiler', any: ['spoiler', 'rear spoiler', 'roof spoiler', 'wing spoiler', 'ducktail', 'heckspoiler', 'dachspoiler', 'aileron', 'alettone', 'aleron', 'lip spoiler'], build: (c) => (c.namedPos() === 'front' ? 'front_bumper' : 'spoiler') },

  // fuel / charge flap sits in a wing or quarter
  { rule: 'fuel-flap', any: ['fuel flap', 'fuel door', 'fuel cap', 'fuel filler', 'filler cap', 'filler flap', 'petrol cap', 'gas cap', 'gas door', 'tank flap', 'tankdeckel', 'tankklappe', 'charge port', 'charging port', 'charge flap', 'charging flap', 'charge door'], build: (c) => (c.pos() === 'front' ? c.sided('front_wing') : rearSidePanel(c)) },

  // side panels
  { rule: 'quarter', any: ['quarter panel', 'quarterpanel', 'quarter', 'qtr', 'rear quarter', 'c pillar', 'cpillar', 'c post', 'seitenwand', 'seitenteil', 'aile arriere', 'rear fender', 'rear wing'], build: (c) => {
    // a centred, high "rear wing" is a spoiler (American usage)
    if (c.has('rear wing') && c.geo && Math.abs(c.geo.v) < 0.35 && c.geo.h > 0.6) {
      c.usedGeo = true;
      return 'spoiler';
    }
    return rearSidePanel(c);
  } },
  { rule: 'van:side', any: ['side panel', 'body side', 'bodyside', 'load side', 'cargo side', 'panel side', 'load area side', 'side wall', 'sidewall'], build: (c) => (c.body === 'panel-van' ? c.sided('load_side_panel') : c.body === 'pickup' ? c.sided('load_bed_side') : c.pos() === 'front' ? c.sided('front_wing') : rearSidePanel(c)) },
  { rule: 'pickup:bed', any: ['load bed', 'cargo bed', 'pickup bed', 'truck bed', 'bed', 'tub', 'pritsche', 'ladeflaeche', 'ladeflache', 'benne', 'cassone', 'caja', 'cacamba'], build: (c) => (c.has('side', 'sides', 'wall', 'rail') ? c.sided('load_bed_side') : 'load_bed_floor') },
  {
    rule: 'wing',
    any: ['fender', 'fenders', 'wing', 'wings', 'front wing', 'kotfluegel', 'kotflugel', 'aile', 'ailes', 'parafango', 'guardabarros', 'aleta', 'salpicadera', 'paralama'],
    build: (c) => {
      c.side();
      const named = c.namedPos();
      if (named === 'rear') {
        if (c.geo && Math.abs(c.geo.v) < 0.35 && c.geo.h > 0.6) {
          c.usedGeo = true;
          return 'spoiler';
        }
        return rearSidePanel(c);
      }
      if (named === 'front') return c.sided('front_wing');
      // no end in the name: wings are at the front unless the part clearly sits behind the middle
      if (c.geo && c.geo.u < -0.2) {
        c.usedGeo = true;
        return rearSidePanel(c);
      }
      return c.sided('front_wing');
    },
  },
  { rule: 'sill', any: ['sill', 'sills', 'rocker', 'rocker panel', 'rockers', 'side skirt', 'sideskirt', 'side skirts', 'skirt', 'skirts', 'schweller', 'seitenschweller', 'bas de caisse', 'minigonna', 'minigonne', 'talonera', 'estribo', 'running board', 'side step', 'sidestep', 'soleira'], build: (c) => c.sided('sill') },
  { rule: 'pillar:a', any: ['a pillar', 'apillar', 'a post', 'a column', 'a saeule', 'a saule', 'montant a', 'montante a'], build: (c) => c.sided('a_pillar') },
  { rule: 'pillar:b', any: ['b pillar', 'bpillar', 'b post', 'b column', 'b saeule', 'b saule', 'montant b', 'montante b', 'centre pillar', 'center pillar'], build: (c) => c.sided('b_pillar') },


  // interior before doors ("door card")
  { rule: 'interior:airbag', any: ['airbag', 'airbags', 'srs', 'air bag'], build: () => 'airbags' },
  { rule: 'interior:dashboard', any: ['dashboard', 'dash', 'dashboard panel', 'instrument', 'instruments', 'instrument panel', 'gauge', 'gauges', 'cluster', 'armaturenbrett', 'armaturen', 'tableau de bord', 'planche de bord', 'cruscotto', 'salpicadero', 'tablero', 'painel', 'glovebox', 'glove box', 'infotainment', 'centre stack', 'center stack', 'hvac'], build: () => 'dashboard' },
  { rule: 'interior:trim', any: ['seat', 'seats', 'sitz', 'sitze', 'siege', 'sieges', 'sedile', 'sedili', 'asiento', 'asientos', 'banco', 'headrest', 'headrests', 'upholstery', 'headliner', 'headlining', 'roof liner', 'roofliner', 'roof lining', 'carpet', 'carpets', 'interior', 'inner', 'inside', 'door card', 'door trim', 'door panel inner', 'console', 'centre console', 'center console', 'armrest', 'seatbelt', 'seat belt', 'pedal', 'pedals', 'gear lever', 'gearstick', 'shifter', 'cabin', 'cockpit', 'innenraum', 'interieur', 'interno', 'habitacle'], build: () => 'seats' },

  // doors
  {
    rule: 'door',
    any: DOOR,
    build: (c) => {
      if (c.has('sliding', 'slide', 'side load', 'schiebetuer', 'schiebetur')) return c.sided('sliding_door');
      if (c.body === 'panel-van' && c.has('rear', 'back', 'barn', 'cargo', 'load')) return c.sided('rear_load_door');
      const s = c.side();
      if (!s) return null;
      if (c.body === 'coupe' || c.body === 'convertible') return `front_door_${s}`;
      const named = c.namedPos();
      if (named) return `${named}_door_${s}`;
      if (c.geo) {
        c.usedGeo = true;
        return `${c.geo.u >= -0.05 ? 'front' : 'rear'}_door_${s}`;
      }
      return `front_door_${s}`;
    },
  },

  // roof
  { rule: 'roof:rail', any: ['roof rail', 'roofrail', 'roof rails', 'roof rack', 'roof bar', 'roof bars', 'roofbar', 'dachreling', 'dachtraeger', 'barres de toit', 'railing', 'rails'], build: (c) => c.sided('roof_rail') },
  { rule: 'roof', any: ['roof', 'roof panel', 'roofpanel', 'dach', 'toit', 'tetto', 'techo', 'teto', 'capota rigida', 'hardtop', 'hard top'], build: (c) => (c.body === 'convertible' && c.has('soft', 'fabric', 'canvas', 'cloth') ? 'soft_top' : 'roof') },

  // structure, underbody, mechanicals
  { rule: 'cooling', any: ['radiator', 'intercooler', 'condenser', 'cooling', 'cooler', 'kuehler', 'kuhler', 'radiateur', 'radiatore', 'radiador', 'fan', 'cooling fan'], build: () => 'radiator' },
  { rule: 'exhaust', any: ['exhaust', 'exhausts', 'tailpipe', 'tail pipe', 'muffler', 'silencer', 'auspuff', 'endrohr', 'echappement', 'pot', 'scarico', 'escape', 'escapamento', 'exhaust tip', 'exhaust pipe', 'catalytic', 'dpf', 'back box'], build: () => 'exhaust' },
  { rule: 'suspension', any: ['suspension', 'strut', 'struts', 'shock', 'shocks', 'shock absorber', 'damper', 'dampers', 'spring', 'springs', 'coilover', 'coilovers', 'wishbone', 'control arm', 'track rod', 'tie rod', 'knuckle', 'hub', 'axle', 'fahrwerk', 'stossdaempfer', 'feder', 'querlenker', 'amortisseur', 'ammortizzatore', 'amortiguador'], build: (c) => c.sided(c.pos() === 'rear' ? 'rear_suspension' : 'front_suspension') },
  { rule: 'underbody', any: ['underbody', 'under body', 'undercarriage', 'floor', 'floorpan', 'floor pan', 'underside', 'unterboden', 'bottom', 'underfloor', 'skid plate', 'undertray', 'under tray', 'splash shield', 'chassis', 'frame', 'subframe', 'sub frame', 'plancher', 'pianale', 'bajos'], build: () => 'floor_pan' },
];

/** Every word the rules and qualifiers know, for splitting glued names ("doorfl", "frontbumper", "headlightl"). */
const VOCAB: Set<string> = (() => {
  const v = new Set<string>();
  for (const r of PART_RULES) for (const p of [...r.any, ...(r.not ?? [])]) for (const w of p.split(' ')) if (w.length >= 2) v.add(w);
  for (const s of [LEFT, RIGHT, FRONT, REAR]) for (const w of s) if (w.length >= 2) v.add(w);
  for (const w of Object.keys(CORNERS)) v.add(w);
  for (const w of NOISE) if (w.length >= 3) v.add(w);
  for (const w of ['paint', 'body', 'carpaint', 'chrome', 'black', 'plastic', 'rubber', 'trim', 'handle', 'side', 'lower', 'upper', 'inner', 'outer', 'cover', 'panel', 'lid', 'light', 'lamp', 'lens', 'glass']) v.add(w);
  return v;
})();

/** Split one unknown glued token into known words (fewest pieces; single letters l/r/f only at the end). */
function splitGlued(token: string): string[] {
  if (token.length < 4 || VOCAB.has(token) || /\d/.test(token)) return [token];
  const n = token.length;
  const best: Array<string[] | undefined> = new Array(n + 1);
  best[0] = [];
  for (let i = 0; i < n; i += 1) {
    const prev = best[i];
    if (!prev) continue;
    for (let j = i + 1; j <= n; j += 1) {
      const w = token.slice(i, j);
      const ok = VOCAB.has(w) || (j === n && (w === 'l' || w === 'r' || w === 'f'));
      if (!ok) continue;
      const cand = [...prev, w];
      const cur = best[j];
      if (!cur || cand.length < cur.length) best[j] = cand;
    }
  }
  const out = best[n];
  // at least one real word (3+ letters) and not a split of a single unknown word into qualifier crumbs
  if (!out || out.length < 2 || !out.some((w) => w.length >= 3)) return [token];
  return out;
}

/** Lower-case word tokens of a vendor name: camelCase, snake_case, dots, dashes, digits and accents handled. */
export function tokenizePartName(name: string): string[] {
  const ascii = name
    .replace(/ß/g, 'ss')
    .replace(/[äÄ]/g, 'ae')
    .replace(/[öÖ]/g, 'oe')
    .replace(/[üÜ]/g, 'ue')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const spaced = ascii
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!spaced) return [];
  const out: string[] = [];
  for (const t of spaced.split(' ')) {
    if (/^\d+$/.test(t)) continue;
    for (const w of splitGlued(t)) if (!NOISE.has(w) || w === 'n' || w === 'o' || w === 's') out.push(w);
  }
  // 'n'/'o'/'s' survive only as the N/S, O/S pair
  return out.filter((w, i) => !(w === 'n' || w === 'o' || w === 's') || (w === 's' ? out[i - 1] === 'n' || out[i - 1] === 'o' : out[i + 1] === 's'));
}

const isMeaningless = (tokens: readonly string[]): boolean => tokens.length === 0;

function runRules(tokens: readonly string[], quals: Quals, body: ModelBodyType | undefined, geo: GeoHint | undefined): ZoneGuess | undefined {
  const text = ` ${tokens.join(' ')} `;
  for (const r of PART_RULES) {
    if (!r.any.some((p) => text.includes(` ${p} `))) continue;
    if (r.not?.some((p) => text.includes(` ${p} `))) continue;
    const c = new RuleCtx(tokens, text, quals, body, geo);
    const zone = r.build(c);
    if (r.ignore) return { zone: null, source: 'name', confidence: 0.9, rule: r.rule };
    if (zone === null) {
      // the words matched but a side / end is missing and there is no position to read it from
      if (r.rule.startsWith('glass:') && r.rule !== 'glass:by-position') continue;
      if (r.rule === 'glass:by-position' && !c.geo) continue;
      return { zone: null, source: 'name', confidence: 0.3, rule: `${r.rule}:incomplete` };
    }
    if (!isModelZoneId(zone)) continue;
    return { zone, source: c.usedGeo ? 'name+position' : 'name', confidence: c.usedGeo ? 0.75 : 0.95, rule: r.rule };
  }
  return undefined;
}

export interface PartNames {
  /** The node's own name and its mesh's name. */
  own: string[];
  /** The primitive's material name. */
  material?: string;
  /** Parent node names, nearest first. */
  parents?: string[];
}

/**
 * Damage zone for a named part. Stage 1 reads the part's own names and its material; stage 2 adds the parent names
 * ("Door_FL" → child "Handle"). Sides / ends the names leave out are read from `geo` when given.
 */
export function zoneForPartName(names: PartNames | string, body?: ModelBodyType, geo?: GeoHint): ZoneGuess | undefined {
  const n: PartNames = typeof names === 'string' ? { own: [names] } : names;
  const own = n.own.flatMap(tokenizePartName);
  const mat = n.material ? tokenizePartName(n.material) : [];
  const parents = (n.parents ?? []).slice(0, 3).flatMap(tokenizePartName);
  // qualifiers: own name first, then material, then parents
  const quals = mergeQuals(readQuals(own), readQuals(mat), readQuals(parents));
  const stage1 = [...own, ...mat];
  if (!isMeaningless(stage1)) {
    const hit = runRules(stage1, quals, body, geo);
    // plain "glass" under a "Door_RR" parent is that door's glass, not the screen its position suggests
    if (hit?.rule === 'glass:by-position' && parents.length) {
      const deeper = runRules([...stage1, ...parents], quals, body, geo);
      if (deeper?.zone && deeper.rule.startsWith('glass:') && deeper.rule !== 'glass:by-position') return deeper;
    }
    if (hit) return hit;
  }
  if (parents.length) return runRules([...stage1, ...parents], quals, body, geo);
  return undefined;
}

function mergeQuals(...qs: Quals[]): Quals {
  const out: Quals = { bareR: false };
  for (const q of qs) {
    out.side ??= q.side;
    out.pos ??= q.pos;
    if (!out.side && !out.pos) out.bareR ||= q.bareR;
  }
  return out;
}

/** Materials that are the body colour (recoloured to the vehicle's colour). */
export function isPaintMaterialName(name: string | undefined): boolean {
  if (!name) return false;
  const t = ` ${tokenizePartName(name).join(' ')} `;
  const raw = name.toLowerCase();
  if (/(glass|chrome|rubber|tyre|tire|interior|plastic|black|trim|light|lamp|lens|plate|wheel|rim|brake|leather|fabric|carpet|grille|grill|mirror glass|window|decal|logo|badge|emblem|shadow|matte black|carbon|metal(?!lic))/.test(raw)) return false;
  return /(paint|carpaint|car_paint|lack|coat|livery|bodycolou?r|body_colou?r|colou?r_?body)/.test(raw) || / (paint|body|shell|bodyshell|exterior|primary|main colour|main color|karosserie|carrosserie) /.test(t) || /^body/.test(raw);
}

export function isGlassMaterialName(name: string | undefined): boolean {
  return !!name && /(glass|window|windscreen|windshield|scheibe|vitre|vetro)/i.test(name);
}

export function isPlateName(name: string | undefined): boolean {
  if (!name) return false;
  const t = ` ${tokenizePartName(name).join(' ')} `;
  if (/ (light|lamp|glass|skid|floor|scuff|kick|tread) /.test(t)) return false;
  return / (plate|kennzeichen|nummernschild|plaque|targa|matricula) /.test(t) || /licen[cs]e/.test(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// glTF reading
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

export interface GltfInput {
  json: Json;
  /** Buffer bytes by buffer index (undefined = not loaded: the GLB fast path reads only what it needs). */
  buffers: Array<Uint8Array | undefined>;
  /** True when the GLB binary chunk is already the only buffer and no URI is used: the file is stored as it is. */
  storeAsIs: boolean;
}

export class ModelInvalidError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(422, 'MODEL_INVALID', message, details);
  }
}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const ALLOWED_EXTENSION_PREFIXES = ['KHR_materials_', 'KHR_texture_transform', 'KHR_mesh_quantization', 'KHR_lights_punctual', 'EXT_texture_webp', 'EXT_texture_avif', 'EXT_mesh_gpu_instancing', 'KHR_xmp_json_ld', 'KHR_xmp'];
const UNSUPPORTED_EXTENSIONS: Record<string, string> = {
  KHR_draco_mesh_compression: 'Draco mesh compression',
  EXT_meshopt_compression: 'meshopt compression',
  KHR_meshopt_compression: 'meshopt compression',
  KHR_texture_basisu: 'Basis Universal (KTX2) textures',
};
const SCRIPT_EXTENSION = /interactiv|behavio|script|audio|physics/i;

function sniffImage(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return undefined;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A relative URI inside the upload, or a refusal. Returns the normalised path ('textures/paint.png'). */
export function safeRelativeUri(uri: string): string {
  if (typeof uri !== 'string' || !uri) throw new ModelInvalidError('An empty URI in the model');
  if (SCHEME.test(uri) || uri.startsWith('//')) throw new ModelInvalidError(`The model loads "${uri.slice(0, 80)}" from outside the file. Only files inside the upload are allowed — zip the .gltf with its .bin and textures.`, { uri: uri.slice(0, 200) });
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    throw new ModelInvalidError(`The URI "${uri.slice(0, 80)}" is not valid`);
  }
  if (decoded.includes('\\') || decoded.includes('\0')) throw new ModelInvalidError(`The URI "${uri.slice(0, 80)}" is not a plain relative path`);
  if (decoded.startsWith('/')) throw new ModelInvalidError(`The URI "${uri.slice(0, 80)}" is an absolute path; only files inside the upload are allowed`);
  const norm = path.posix.normalize(decoded);
  if (norm.startsWith('..') || norm.split('/').includes('..')) throw new ModelInvalidError(`The URI "${uri.slice(0, 80)}" points outside the upload`);
  return norm.replace(/^\.\//, '');
}

function decodeDataUri(uri: string, allowed: readonly string[]): { mime: string; bytes: Uint8Array } {
  const m = /^data:([^;,]*)(;[^,]*)?,(.*)$/s.exec(uri);
  if (!m) throw new ModelInvalidError('A data: URI in the model is malformed');
  const mime = (m[1] || 'application/octet-stream').toLowerCase();
  if (!allowed.includes(mime)) throw new ModelInvalidError(`Embedded data of type "${mime}" is not allowed in a model`, { mime });
  const base64 = (m[2] ?? '').includes(';base64');
  const payload = m[3] ?? '';
  const bytes = base64 ? new Uint8Array(Buffer.from(payload, 'base64')) : new Uint8Array(Buffer.from(decodeURIComponent(payload), 'binary'));
  return { mime, bytes };
}

/** Parse a GLB held in memory. */
export function parseGlb(bytes: Uint8Array): { json: Json; bin?: Uint8Array } {
  if (bytes.length < 20) throw new ModelInvalidError('The .glb file is too short to be a glTF binary');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new ModelInvalidError('This is not a binary glTF (.glb) file — the "glTF" header is missing');
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new ModelInvalidError(`This is glTF version ${version}; only glTF 2.0 models can be imported`, { version });
  const length = dv.getUint32(8, true);
  if (length !== bytes.length) throw new ModelInvalidError(`The .glb header says ${length} bytes but the file has ${bytes.length}; the file is truncated or damaged`);
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== CHUNK_JSON) throw new ModelInvalidError('The first chunk of the .glb is not JSON');
  if (20 + jsonLen > bytes.length) throw new ModelInvalidError('The .glb JSON chunk runs past the end of the file');
  const json = parseJsonText(Buffer.from(bytes.buffer, bytes.byteOffset + 20, jsonLen).toString('utf8'));
  let off = 20 + jsonLen;
  let bin: Uint8Array | undefined;
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    if (off + 8 + len > bytes.length) throw new ModelInvalidError('A .glb chunk runs past the end of the file');
    if (type === CHUNK_BIN && !bin) bin = bytes.subarray(off + 8, off + 8 + len);
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { json, ...(bin ? { bin } : {}) };
}

/** Read only the header and JSON chunk of a GLB on disk (the binary chunk can be ~200 MB). */
export function readGlbHeader(file: string): { json: Json; binOffset?: number; binLength?: number; fileBytes: number } {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(20);
    if (size < 20 || readSync(fd, head, 0, 20, 0) !== 20) throw new ModelInvalidError('The .glb file is too short to be a glTF binary');
    if (head.readUInt32LE(0) !== GLB_MAGIC) throw new ModelInvalidError('This is not a binary glTF (.glb) file — the "glTF" header is missing');
    const version = head.readUInt32LE(4);
    if (version !== 2) throw new ModelInvalidError(`This is glTF version ${version}; only glTF 2.0 models can be imported`, { version });
    const length = head.readUInt32LE(8);
    if (length !== size) throw new ModelInvalidError(`The .glb header says ${length} bytes but the file has ${size}; the file is truncated or damaged`);
    const jsonLen = head.readUInt32LE(12);
    if (head.readUInt32LE(16) !== CHUNK_JSON) throw new ModelInvalidError('The first chunk of the .glb is not JSON');
    if (20 + jsonLen > size || jsonLen > 64 * MIB) throw new ModelInvalidError('The .glb JSON chunk is too large or runs past the end of the file');
    const jb = Buffer.alloc(jsonLen);
    readSync(fd, jb, 0, jsonLen, 20);
    const json = parseJsonText(jb.toString('utf8'));
    let off = 20 + jsonLen;
    const ch = Buffer.alloc(8);
    while (off + 8 <= size) {
      readSync(fd, ch, 0, 8, off);
      const len = ch.readUInt32LE(0);
      const type = ch.readUInt32LE(4);
      if (off + 8 + len > size) throw new ModelInvalidError('A .glb chunk runs past the end of the file');
      if (type === CHUNK_BIN) return { json, binOffset: off + 8, binLength: len, fileBytes: size };
      off += 8 + len + ((4 - (len % 4)) % 4);
    }
    return { json, fileBytes: size };
  } finally {
    closeSync(fd);
  }
}

function readRange(file: string, offset: number, length: number): Uint8Array {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(length);
    readSync(fd, b, 0, length, offset);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  } finally {
    closeSync(fd);
  }
}

function parseJsonText(text: string): Json {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new ModelInvalidError(`The glTF JSON cannot be read: ${(e as Error).message}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ModelInvalidError('The glTF JSON is not an object');
  return json as Json;
}

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** Structural checks shared by every input form. */
export function checkGltfJson(json: Json, limits: Models3dLimits): { warnings: string[] } {
  const warnings: string[] = [];
  const asset = json.asset as Json | undefined;
  if (!asset || typeof asset !== 'object') throw new ModelInvalidError('The glTF has no "asset" block, so it is not a glTF 2.0 file');
  const version = String(asset.version ?? '');
  const minVersion = asset.minVersion !== undefined ? String(asset.minVersion) : undefined;
  if (!/^2\.\d+$/.test(version) || (minVersion !== undefined && minVersion !== '2.0')) throw new ModelInvalidError(`This is glTF ${version || 'of unknown version'}; only glTF 2.0 models can be imported (re-export as glTF 2.0)`, { version, minVersion });

  const used = arr(json.extensionsUsed).map(String);
  const required = arr(json.extensionsRequired).map(String);
  for (const ext of [...used, ...required]) {
    if (SCRIPT_EXTENSION.test(ext)) throw new ModelInvalidError(`The model uses the "${ext}" extension (behaviour or scripting). Models with scripts cannot be imported.`, { extension: ext });
  }
  for (const ext of used) {
    const label = UNSUPPORTED_EXTENSIONS[ext];
    if (label && (required.includes(ext) || ext === 'KHR_draco_mesh_compression')) {
      throw new ModelInvalidError(`The model uses ${label} (${ext}), which ClaimDesk cannot decode. Re-export it without compression (in Blender: File → Export → glTF, untick "Compression").`, { extension: ext });
    }
    if (label) warnings.push(`${ext} is used but not required; the uncompressed fallback data is shown.`);
  }
  for (const ext of required) {
    if (!ALLOWED_EXTENSION_PREFIXES.some((p) => ext.startsWith(p))) throw new ModelInvalidError(`The model requires the "${ext}" extension, which ClaimDesk does not support`, { extension: ext });
  }
  for (const ext of used) if (!UNSUPPORTED_EXTENSIONS[ext] && !ALLOWED_EXTENSION_PREFIXES.some((p) => ext.startsWith(p))) warnings.push(`Unknown extension ${ext} is ignored.`);

  // script-like strings anywhere (extras, names): a model never needs them
  const text = JSON.stringify(json);
  if (/<\s*script|javascript:|data:text\/html|vbscript:|on(load|error|click)\s*=/i.test(text)) throw new ModelInvalidError('The model contains script-like text (for example "<script" or "javascript:"). It cannot be imported.');

  const meshes = arr(json.meshes);
  if (!meshes.length) throw new ModelInvalidError('The model has no meshes');
  const nodes = arr(json.nodes);
  if (nodes.length > limits.maxNodes) throw new ModelInvalidError(`The model has ${nodes.length} nodes; the limit is ${limits.maxNodes}`, { nodes: nodes.length, limit: limits.maxNodes });
  const accessors = arr(json.accessors);
  const bufferViews = arr(json.bufferViews);
  const buffers = arr(json.buffers);
  for (const [i, bv] of bufferViews.entries()) {
    const b = buffers[bv?.buffer];
    if (!b) throw new ModelInvalidError(`Buffer view ${i} points to a buffer that does not exist`);
    const off = Number(bv.byteOffset ?? 0);
    const len = Number(bv.byteLength);
    if (!Number.isInteger(off) || !Number.isInteger(len) || off < 0 || len < 0 || off + len > Number(b.byteLength)) throw new ModelInvalidError(`Buffer view ${i} runs past the end of buffer ${bv.buffer}`);
  }
  for (const [i, a] of accessors.entries()) {
    if (a?.bufferView === undefined) continue;
    const bv = bufferViews[a.bufferView];
    if (!bv) throw new ModelInvalidError(`Accessor ${i} points to a buffer view that does not exist`);
    const comps = COMPONENTS[a.type as string];
    const cb = COMPONENT_BYTES[a.componentType as number];
    if (!comps || !cb) throw new ModelInvalidError(`Accessor ${i} has an unknown type`);
    const count = Number(a.count);
    const stride = Number(bv.byteStride ?? 0) || comps * cb;
    const need = Number(a.byteOffset ?? 0) + (count > 0 ? stride * (count - 1) + comps * cb : 0);
    if (!Number.isInteger(count) || count < 0 || need > Number(bv.byteLength)) throw new ModelInvalidError(`Accessor ${i} reads past the end of its buffer view`);
  }
  for (const [mi, m] of meshes.entries()) {
    for (const p of arr(m?.primitives)) {
      const posIdx = p?.attributes?.POSITION;
      if (posIdx !== undefined && !accessors[posIdx]) throw new ModelInvalidError(`Mesh ${mi} uses an accessor that does not exist`);
      if (p?.indices !== undefined && !accessors[p.indices]) throw new ModelInvalidError(`Mesh ${mi} uses an index accessor that does not exist`);
      if (p?.material !== undefined && !arr(json.materials)[p.material]) throw new ModelInvalidError(`Mesh ${mi} uses a material that does not exist`);
    }
  }
  for (const [ni, n] of nodes.entries()) {
    if (n?.mesh !== undefined && !meshes[n.mesh]) throw new ModelInvalidError(`Node ${ni} uses a mesh that does not exist`);
    for (const c of arr(n?.children)) if (!nodes[c]) throw new ModelInvalidError(`Node ${ni} has a child that does not exist`);
  }
  return { warnings };
}

// ---------------------------------------------------------------------------
// Scene walk: parts, triangles, bounds
// ---------------------------------------------------------------------------

type Mat4 = number[];
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) {
    let s = 0;
    for (let k = 0; k < 4; k += 1) s += a[k * 4 + r]! * b[c * 4 + k]!;
    o[c * 4 + r] = s;
  }
  return o;
}

function nodeMatrix(n: Json): Mat4 {
  if (Array.isArray(n.matrix) && n.matrix.length === 16) return n.matrix.map(Number);
  const [tx, ty, tz] = Array.isArray(n.translation) ? n.translation.map(Number) : [0, 0, 0];
  const [qx, qy, qz, qw] = Array.isArray(n.rotation) ? n.rotation.map(Number) : [0, 0, 0, 1];
  const [sx, sy, sz] = Array.isArray(n.scale) ? n.scale.map(Number) : [1, 1, 1];
  const x2 = qx! + qx!, y2 = qy! + qy!, z2 = qz! + qz!;
  const xx = qx! * x2, xy = qx! * y2, xz = qx! * z2, yy = qy! * y2, yz = qy! * z2, zz = qz! * z2, wx = qw! * x2, wy = qw! * y2, wz = qw! * z2;
  return [
    (1 - (yy + zz)) * sx!, (xy + wz) * sx!, (xz - wy) * sx!, 0,
    (xy - wz) * sy!, (1 - (xx + zz)) * sy!, (yz + wx) * sy!, 0,
    (xz + wy) * sz!, (yz - wx) * sz!, (1 - (xx + yy)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}

function transformBox(m: Mat4, min: number[], max: number[]): [number[], number[]] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i += 1) {
    const p = [i & 1 ? max[0]! : min[0]!, i & 2 ? max[1]! : min[1]!, i & 4 ? max[2]! : min[2]!];
    for (let a = 0; a < 3; a += 1) {
      const v = m[a]! * p[0]! + m[4 + a]! * p[1]! + m[8 + a]! * p[2]! + m[12 + a]!;
      if (v < lo[a]!) lo[a] = v;
      if (v > hi[a]!) hi[a] = v;
    }
  }
  return [lo, hi];
}

export interface Model3dPart {
  /** `n<node>p<primitive>`. */
  key: string;
  node: number;
  primitive: number;
  /** Node name (or mesh name when the node has none). */
  name: string;
  meshName?: string;
  material?: number;
  materialName?: string;
  /** Parent node names, nearest first (up to 3). */
  parents: string[];
  triangles: number;
  /** World-space bounds [min, max] (glTF axes: +Y up). */
  bbox?: [number[], number[]];
}

export interface Model3dMaterial {
  index: number;
  name: string;
  role: 'paint' | 'glass' | 'plate' | 'other';
}

function trianglesOf(json: Json, prim: Json): number {
  const mode = prim.mode ?? 4;
  const accessors = arr(json.accessors);
  const count = prim.indices !== undefined ? Number(accessors[prim.indices]?.count ?? 0) : Number(accessors[prim.attributes?.POSITION]?.count ?? 0);
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

/** Walk the default scene: one part per mesh primitive instance, with world bounds when the accessor has min/max. */
export function scanParts(json: Json, limits: Models3dLimits): { parts: Model3dPart[]; triangles: number } {
  const nodes = arr(json.nodes);
  const meshes = arr(json.meshes);
  const materials = arr(json.materials);
  const accessors = arr(json.accessors);
  const scenes = arr(json.scenes);
  const scene = scenes[Number(json.scene ?? 0)] ?? scenes[0];
  let roots: number[] = arr(scene?.nodes).map(Number);
  if (!scenes.length) {
    const child = new Set(nodes.flatMap((n) => arr(n?.children).map(Number)));
    roots = nodes.map((_, i) => i).filter((i) => !child.has(i));
  }
  const parts: Model3dPart[] = [];
  let triangles = 0;
  const seen = new Set<number>();
  const stack: Array<{ node: number; m: Mat4; parents: string[] }> = roots.map((r) => ({ node: r, m: IDENTITY, parents: [] }));
  while (stack.length) {
    const { node, m: pm, parents } = stack.pop()!;
    if (seen.has(node)) throw new ModelInvalidError('The node hierarchy has a cycle or a node used twice');
    seen.add(node);
    const n = nodes[node] as Json | undefined;
    if (!n) continue;
    const m = mul(pm, nodeMatrix(n));
    const nodeName = typeof n.name === 'string' ? n.name : '';
    if (n.mesh !== undefined) {
      const mesh = meshes[n.mesh] as Json;
      const meshName = typeof mesh?.name === 'string' ? mesh.name : undefined;
      for (const [pi, prim] of arr(mesh?.primitives).entries()) {
        const tris = trianglesOf(json, prim);
        triangles += tris;
        const pos = accessors[prim?.attributes?.POSITION];
        const part: Model3dPart = { key: `n${node}p${pi}`, node, primitive: pi, name: nodeName || meshName || `node ${node}`, parents: parents.slice(0, 3), triangles: tris };
        if (meshName) part.meshName = meshName;
        if (prim?.material !== undefined) {
          part.material = Number(prim.material);
          const mn = materials[prim.material]?.name;
          if (typeof mn === 'string' && mn) part.materialName = mn;
        }
        if (Array.isArray(pos?.min) && Array.isArray(pos?.max) && pos.min.length >= 3) part.bbox = transformBox(m, pos.min.map(Number), pos.max.map(Number));
        parts.push(part);
      }
    }
    for (const c of arr(n.children)) stack.push({ node: Number(c), m, parents: nodeName ? [nodeName, ...parents] : parents });
  }
  if (triangles > limits.maxTriangles) throw new ModelInvalidError(`The model has ${triangles.toLocaleString('en-GB')} triangles; the limit is ${limits.maxTriangles.toLocaleString('en-GB')}. Use a lighter (lower LOD) version.`, { triangles, limit: limits.maxTriangles });
  if (!parts.length) throw new ModelInvalidError('The model has no visible meshes in its scene');
  parts.sort((a, b) => a.node - b.node || a.primitive - b.primitive);
  return { parts, triangles };
}

export function classifyMaterials(json: Json, parts: readonly Model3dPart[]): Model3dMaterial[] {
  const plateMats = new Set(parts.filter((p) => isPlateName(p.name) || isPlateName(p.meshName)).map((p) => p.material));
  return arr(json.materials).map((m, index) => {
    const name = typeof m?.name === 'string' ? m.name : `material ${index}`;
    const role: Model3dMaterial['role'] = isPlateName(name) || plateMats.has(index) ? 'plate' : isGlassMaterialName(name) ? 'glass' : isPaintMaterialName(name) ? 'paint' : 'other';
    return { index, name, role };
  });
}

// ---------------------------------------------------------------------------
// Automatic zone mapping
// ---------------------------------------------------------------------------

export type ForwardAxis = '+x' | '-x' | '+z' | '-z';
export interface ModelFrame {
  /** Direction the car's nose points in the model (glTF: +Y is always up). */
  forward: ForwardAxis;
  /** Swap left and right (a mirrored model, or names given from the viewer's side). */
  mirror: boolean;
  /** 'auto': worked out from the part names; 'owner': set in Settings. */
  source: 'auto' | 'owner';
}

const FRONT_ANCHORS = /^(headlamp|fog_lamp|front_bumper|front_lower_grille|grille|bonnet|windscreen|front_panel|radiator|front_parking_sensors|front_radar|front_wing|front_door|wheel_f)/;
const REAR_ANCHORS = /^(rear_lamp|rear_bumper|tailgate|boot_lid|rear_screen|rear_panel|exhaust|spoiler|high_level_brake_lamp|reversing_camera|rear_parking_sensors|quarter_panel|rear_door|wheel_r)/;

interface CarBox {
  min: number[];
  max: number[];
}

function carBox(parts: readonly Model3dPart[]): CarBox | undefined {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const p of parts) {
    if (!p.bbox) continue;
    if (zoneForPartName({ own: [p.name, p.meshName ?? ''] })?.rule === 'ignore:scene') continue;
    any = true;
    for (let a = 0; a < 3; a += 1) {
      min[a] = Math.min(min[a]!, p.bbox[0][a]!);
      max[a] = Math.max(max[a]!, p.bbox[1][a]!);
    }
  }
  if (!any || !min.every(Number.isFinite) || !max.every(Number.isFinite)) return undefined;
  return { min, max };
}

const axisIndex = (f: ForwardAxis): 0 | 2 => (f.endsWith('x') ? 0 : 2);
const axisSign = (f: ForwardAxis): 1 | -1 => (f.startsWith('+') ? 1 : -1);

function geoFor(p: Model3dPart, box: CarBox, frame: ModelFrame): GeoHint | undefined {
  if (!p.bbox) return undefined;
  const fa = axisIndex(frame.forward);
  const fs = axisSign(frame.forward);
  const la: 0 | 2 = fa === 0 ? 2 : 0;
  // left = up × forward: forward +z → left +x; forward +x → left -z
  const ls = (fa === 2 ? fs : -fs) * (frame.mirror ? -1 : 1);
  const c = [0, 1, 2].map((a) => (p.bbox![0][a]! + p.bbox![1][a]!) / 2);
  const mid = [0, 1, 2].map((a) => (box.min[a]! + box.max[a]!) / 2);
  const half = [0, 1, 2].map((a) => Math.max(1e-9, (box.max[a]! - box.min[a]!) / 2));
  const u = ((c[fa]! - mid[fa]!) / half[fa]!) * fs;
  const v = ((c[la]! - mid[la]!) / half[la]!) * ls;
  const h = (c[1]! - box.min[1]!) / (2 * half[1]!);
  const size: [number, number, number] = [
    (p.bbox[1][fa]! - p.bbox[0][fa]!) / (2 * half[fa]!),
    (p.bbox[1][la]! - p.bbox[0][la]!) / (2 * half[la]!),
    (p.bbox[1][1]! - p.bbox[0][1]!) / (2 * half[1]!),
  ];
  return { pos: u >= 0 ? 'front' : 'rear', side: v >= 0 ? 'l' : 'r', u, v, h, size };
}

/** Work out which way the car faces from parts whose names say front or rear (falls back to the glTF +Z convention). */
export function detectFrame(parts: readonly Model3dPart[], body?: ModelBodyType): ModelFrame {
  const box = carBox(parts);
  if (!box) return { forward: '+z', mirror: false, source: 'auto' };
  const long: 0 | 2 = box.max[0]! - box.min[0]! > box.max[2]! - box.min[2]! ? 0 : 2;
  const mid = (box.min[long]! + box.max[long]!) / 2;
  let frontSum = 0, frontN = 0, rearSum = 0, rearN = 0;
  for (const p of parts) {
    if (!p.bbox) continue;
    const g = zoneForPartName({ own: [p.name, p.meshName ?? ''], material: p.materialName, parents: p.parents }, body);
    if (!g?.zone || g.source !== 'name') continue;
    const c = (p.bbox[0][long]! + p.bbox[1][long]!) / 2 - mid;
    if (FRONT_ANCHORS.test(g.zone)) {
      frontSum += c;
      frontN += 1;
    } else if (REAR_ANCHORS.test(g.zone)) {
      rearSum += c;
      rearN += 1;
    }
  }
  let sign: 1 | -1 = 1;
  if (frontN && rearN) sign = frontSum / frontN >= rearSum / rearN ? 1 : -1;
  else if (frontN) sign = frontSum >= 0 ? 1 : -1;
  else if (rearN) sign = rearSum <= 0 ? 1 : -1;
  const forward = `${sign > 0 ? '+' : '-'}${long === 0 ? 'x' : 'z'}` as ForwardAxis;
  // left/right: named left parts should sit on the left of that frame
  const frame: ModelFrame = { forward, mirror: false, source: 'auto' };
  let agree = 0;
  for (const p of parts) {
    const q = readQuals([...tokenizePartName(p.name), ...(p.meshName ? tokenizePartName(p.meshName) : [])]);
    if (!q.side || !p.bbox) continue;
    const g = geoFor(p, box, frame);
    if (!g || Math.abs(g.v) < 0.2) continue;
    agree += (g.side === q.side ? 1 : -1);
  }
  if (agree < 0) frame.mirror = true;
  return frame;
}

/** Position-only guess for an unnamed painted panel (low confidence; shown as a suggestion to check). */
export function zoneFromPosition(g: GeoHint, body?: ModelBodyType): string | null {
  const { u, v, h, size } = g;
  const side = g.side;
  const au = Math.abs(u);
  const av = Math.abs(v);
  if (size[0] > 0.7) return null; // spans most of the car: a whole body shell, not one panel
  // wheels: low, near a corner, about as long as tall
  if (h < 0.4 && av > 0.55 && au > 0.35 && au < 0.95 && size[2] > 0.25 && Math.abs(size[0] - size[2] * 0.5) < 0.2) return `wheel_${u >= 0 ? 'f' : 'r'}${side}`;
  if (av < 0.4) {
    if (u > 0.78 && h < 0.55) return 'front_bumper';
    if (u < -0.78 && h < 0.55) return 'rear_bumper';
    if (h > 0.85 && au < 0.5) return body === 'convertible' ? 'soft_top' : 'roof';
    if (u > 0.3 && h >= 0.45 && h <= 0.85 && size[1] > 0.45) return 'bonnet';
    if (u < -0.45 && h >= 0.4) return body === 'pickup' ? 'load_bed_tailgate' : body === 'panel-van' ? `rear_load_door_${side}` : body && BOOT_BODIES.includes(body) ? 'boot_lid' : 'tailgate';
    return null;
  }
  if (av > 0.6) {
    if (h < 0.4 && size[2] < 0.15 && size[0] > 0.3) return `sill_${side}`;
    if (u > 0.45) return `front_wing_${side}`;
    if (u < -0.45) return `${body === 'panel-van' ? 'load_side_panel' : body === 'pickup' ? 'load_bed_side' : 'quarter_panel'}_${side}`;
    if (h >= 0.2 && h <= 0.75) {
      if (u >= -0.05 || body === 'coupe' || body === 'convertible') return `front_door_${side}`;
      return body === 'panel-van' ? `load_side_panel_${side}` : `rear_door_${side}`;
    }
  }
  return null;
}

function isGenericName(p: Model3dPart): boolean {
  return tokenizePartName(p.name).length === 0 && (!p.meshName || tokenizePartName(p.meshName).length === 0);
}

/** Automatic zone for every part. `materials` decides which unnamed parts may be placed by position (painted ones). */
export function autoMapZones(parts: readonly Model3dPart[], materials: readonly Model3dMaterial[], body: ModelBodyType | undefined, frame: ModelFrame): Record<string, ZoneGuess> {
  const box = carBox(parts);
  const out: Record<string, ZoneGuess> = {};
  const paint = new Set(materials.filter((m) => m.role === 'paint').map((m) => m.index));
  for (const p of parts) {
    const geo = box ? geoFor(p, box, frame) : undefined;
    const hit = zoneForPartName({ own: [p.name, ...(p.meshName && p.meshName !== p.name ? [p.meshName] : [])], material: p.materialName, parents: p.parents }, body, geo);
    if (hit) {
      out[p.key] = hit;
      continue;
    }
    // unnamed painted panels: place by position
    if (geo && (isGenericName(p) || (p.material !== undefined && paint.has(p.material)))) {
      const zone = zoneFromPosition(geo, body);
      if (zone && isModelZoneId(zone)) out[p.key] = { zone, source: 'position', confidence: 0.35, rule: 'position' };
    }
  }
  // doors with no end in the name: on each side the most-forward door is the front door
  if (box) {
    for (const side of ['l', 'r'] as const) {
      const doors = parts.filter((p) => out[p.key]?.rule === 'door' && out[p.key]?.source === 'name+position' && out[p.key]?.zone?.endsWith(`_door_${side}`) && !out[p.key]?.zone?.startsWith('sliding'));
      const centres = doors.map((p) => geoFor(p, box, frame)?.u ?? 0);
      if (doors.length < 2) continue;
      const lo = Math.min(...centres);
      const hi = Math.max(...centres);
      if (hi - lo < 0.15) continue;
      const split = (lo + hi) / 2;
      doors.forEach((p, i) => {
        out[p.key] = { ...out[p.key]!, zone: `${centres[i]! >= split ? 'front' : 'rear'}_door_${side}` };
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normalising to one GLB
// ---------------------------------------------------------------------------

const pad4 = (n: number): number => (4 - (n % 4)) % 4;

export function encodeGlb(json: Json, bin: Uint8Array | undefined): Uint8Array {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = pad4(jsonBytes.length);
  const binLen = bin ? bin.length + pad4(bin.length) : 0;
  const total = 12 + 8 + jsonBytes.length + jsonPad + (bin ? 8 + binLen : 0);
  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBytes.length + jsonPad, 12);
  out.writeUInt32LE(CHUNK_JSON, 16);
  jsonBytes.copy(out, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  if (bin) {
    const at = 20 + jsonBytes.length + jsonPad;
    out.writeUInt32LE(binLen, at);
    out.writeUInt32LE(CHUNK_BIN, at + 4);
    Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength).copy(out, at + 8);
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

const IMAGE_MIME_BY_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/**
 * Pack a glTF whose buffers / images come from data: URIs, sibling files (`files`) or a GLB binary chunk into one GLB:
 * every buffer is appended to a single binary buffer and every image becomes a buffer view.
 */
export function packToGlb(json: Json, glbBin: Uint8Array | undefined, files: Map<string, Uint8Array>, baseDir: string): Uint8Array {
  const out: Json = JSON.parse(JSON.stringify(json));
  const chunks: Uint8Array[] = [];
  let total = 0;
  const append = (bytes: Uint8Array): number => {
    const pad = pad4(total);
    if (pad) {
      chunks.push(new Uint8Array(pad));
      total += pad;
    }
    const at = total;
    chunks.push(bytes);
    total += bytes.length;
    return at;
  };
  const fileFor = (uri: string): Uint8Array => {
    const rel = safeRelativeUri(uri);
    const key = path.posix.normalize(path.posix.join(baseDir, rel)).replace(/^\.\//, '');
    const bytes = files.get(key);
    if (!bytes) throw new ModelInvalidError(`The model needs "${rel}", which is not in the upload. Zip the .gltf together with its .bin and texture files.`, { missing: rel });
    return bytes;
  };
  const buffers = arr(out.buffers);
  const offsets: number[] = [];
  for (const [i, b] of buffers.entries()) {
    let bytes: Uint8Array;
    if (b?.uri === undefined) {
      if (i !== 0 || !glbBin) throw new ModelInvalidError(`Buffer ${i} has no data`);
      bytes = glbBin;
    } else if (String(b.uri).startsWith('data:')) bytes = decodeDataUri(String(b.uri), ['application/octet-stream', 'application/gltf-buffer']).bytes;
    else bytes = fileFor(String(b.uri));
    const declared = Number(b.byteLength);
    if (!Number.isInteger(declared) || declared < 0 || bytes.length < declared) throw new ModelInvalidError(`Buffer ${i} is shorter than the model says (${bytes.length} of ${declared} bytes)`);
    offsets[i] = append(bytes.subarray(0, declared));
  }
  for (const bv of arr(out.bufferViews)) {
    bv.byteOffset = Number(bv.byteOffset ?? 0) + (offsets[bv.buffer] ?? 0);
    bv.buffer = 0;
  }
  out.bufferViews = arr(out.bufferViews);
  for (const [i, img] of arr(out.images).entries()) {
    if (img?.uri === undefined) continue;
    const uri = String(img.uri);
    let bytes: Uint8Array;
    let mime: string | undefined;
    if (uri.startsWith('data:')) {
      const d = decodeDataUri(uri, ['image/png', 'image/jpeg', 'image/webp']);
      bytes = d.bytes;
      mime = d.mime;
    } else {
      bytes = fileFor(uri);
      mime = IMAGE_MIME_BY_EXT[path.extname(safeRelativeUri(uri)).toLowerCase()];
    }
    const sniffed = sniffImage(bytes);
    if (!sniffed) throw new ModelInvalidError(`Image ${i} is not a PNG, JPEG or WebP picture`, { image: i });
    if (mime && mime !== sniffed && !(mime === 'image/jpeg' && sniffed === 'image/jpeg')) mime = sniffed;
    const at = append(bytes);
    out.bufferViews.push({ buffer: 0, byteOffset: at, byteLength: bytes.length });
    img.bufferView = out.bufferViews.length - 1;
    img.mimeType = sniffed;
    delete img.uri;
  }
  const bin = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    bin.set(c, o);
    o += c.length;
  }
  if (total > 0) out.buffers = [{ byteLength: total }];
  else delete out.buffers;
  return encodeGlb(out, total > 0 ? bin : undefined);
}

/** Embedded images (buffer views) must really be pictures. */
function checkEmbeddedImages(json: Json, readView: (bv: Json, len: number) => Uint8Array): void {
  for (const [i, img] of arr(json.images).entries()) {
    if (img?.uri !== undefined) continue;
    const bv = arr(json.bufferViews)[img?.bufferView];
    if (!bv) throw new ModelInvalidError(`Image ${i} points to a buffer view that does not exist`);
    const head = readView(bv, Math.min(16, Number(bv.byteLength)));
    const sniffed = sniffImage(head);
    if (!sniffed) throw new ModelInvalidError(`Image ${i} is not a PNG, JPEG or WebP picture`, { image: i });
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface Model3dAssignment {
  makeSlug: string;
  make: string;
  modelSlug: string;
  model: string;
  generationId?: string;
  generation?: string;
  /** Generation (or model) years, for matching a vehicle by year. */
  years?: { from: number; to: number | null };
  bodyType?: ModelBodyType;
}

export interface PlatePart {
  key: string;
  position: PartPos;
}

export interface Model3dRecord {
  id: string;
  title: string;
  fileName: string;
  /** What was uploaded. The stored file is always model.glb. */
  sourceFormat: 'glb' | 'gltf' | 'zip';
  /** Size of the stored model.glb. */
  bytes: number;
  /** SHA-256 of the uploaded file. */
  sha256: string;
  assignment: Model3dAssignment;
  licence: { confirmed: true; note?: string; confirmedBy: string; confirmedAt: string };
  active: boolean;
  stats: { triangles: number; nodes: number; meshes: number; materials: number; textures: number; parts: number; extensionsUsed: string[] };
  warnings: string[];
  frame: ModelFrame;
  parts: Model3dPart[];
  materials: Model3dMaterial[];
  /** Material indices recoloured to the vehicle's colour (starts from the automatic 'paint' roles). */
  paintMaterials: number[];
  /** Number-plate meshes (the registration is drawn on them). */
  plateParts: PlatePart[];
  autoZones: Record<string, ZoneGuess>;
  /** Manual tags: a zone id, or null = "not a damage part". They win over autoZones. */
  tags: Record<string, string | null>;
  thumbnail: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export type Model3dSummary = Omit<Model3dRecord, 'parts' | 'autoZones' | 'tags' | 'materials'> & { mappedParts: number; taggedParts: number };

export interface Model3dView extends Model3dRecord {
  /** Effective zone per part key (tags over automatic), only parts that have a zone. */
  zones: Record<string, string>;
  /** URL path (under /api) of the model file. */
  fileUrl: string;
  thumbnailUrl?: string;
}

export function models3dRoot(ctx: AppContext): string {
  return path.join(ctx.config.dataDir, 'models3d');
}

const ID_RE = /^[a-f0-9-]{36}$/;
function modelDir(ctx: AppContext, id: string): string {
  if (!ID_RE.test(id)) throw notFound('3D model', id);
  return path.join(models3dRoot(ctx), id);
}

export function effectiveZones(r: Pick<Model3dRecord, 'parts' | 'autoZones' | 'tags'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of r.parts) {
    const tag = r.tags[p.key];
    const zone = tag !== undefined ? tag : r.autoZones[p.key]?.zone ?? null;
    if (zone && isModelZoneId(zone)) out[p.key] = zone;
  }
  return out;
}

export function toSummary(r: Model3dRecord): Model3dSummary {
  const { parts: _p, autoZones: _a, tags, materials: _m, ...rest } = r;
  return { ...rest, mappedParts: Object.keys(effectiveZones(r)).length, taggedParts: Object.keys(tags).length };
}

export function toView(r: Model3dRecord): Model3dView {
  return { ...r, zones: effectiveZones(r), fileUrl: `/models3d/${r.id}/model.glb`, ...(r.thumbnail ? { thumbnailUrl: `/models3d/${r.id}/thumbnail.png` } : {}) };
}

function writeRecord(ctx: AppContext, r: Model3dRecord): void {
  const dir = modelDir(ctx, r.id);
  const tmp = path.join(dir, `record.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(r));
  renameSync(tmp, path.join(dir, 'record.json'));
}

export function readRecord(ctx: AppContext, id: string): Model3dRecord {
  const file = path.join(modelDir(ctx, id), 'record.json');
  if (!existsSync(file)) throw notFound('3D model', id);
  return JSON.parse(readFileSync(file, 'utf8')) as Model3dRecord;
}

export function listRecords(ctx: AppContext): Model3dRecord[] {
  const root = models3dRoot(ctx);
  if (!existsSync(root)) return [];
  const out: Model3dRecord[] = [];
  for (const name of readdirSync(root)) {
    if (!ID_RE.test(name)) continue;
    const file = path.join(root, name, 'record.json');
    if (!existsSync(file)) continue;
    try {
      out.push(JSON.parse(readFileSync(file, 'utf8')) as Model3dRecord);
    } catch {
      ctx.logger.warn('models3d: unreadable record skipped', { id: name });
    }
  }
  return out.sort((a, b) => a.assignment.make.localeCompare(b.assignment.make) || a.assignment.model.localeCompare(b.assignment.model) || b.createdAt.localeCompare(a.createdAt));
}

export function modelFilePath(ctx: AppContext, id: string): string {
  return path.join(modelDir(ctx, id), 'model.glb');
}
export function thumbnailPath(ctx: AppContext, id: string): string {
  return path.join(modelDir(ctx, id), 'thumbnail.png');
}

// ---------------------------------------------------------------------------
// Staging an upload
// ---------------------------------------------------------------------------

export interface StagedModelUpload {
  path: string;
  bytes: number;
  sha256: string;
}

export function stagingDir(ctx: AppContext): string {
  const d = path.join(models3dRoot(ctx), '.staging');
  mkdirSync(d, { recursive: true });
  return d;
}

/** Stream an upload to `<models3d>/.staging/<uuid>` while hashing it. */
export async function stageModelStream(ctx: AppContext, stream: Readable): Promise<StagedModelUpload> {
  const file = path.join(stagingDir(ctx), randomUUID());
  const hash = createHash('sha256');
  let bytes = 0;
  stream.on('data', (c: Buffer) => {
    hash.update(c);
    bytes += c.length;
  });
  try {
    await pipeline(stream, createWriteStream(file));
  } catch (e) {
    rmSync(file, { force: true });
    throw e;
  }
  return { path: file, bytes, sha256: hash.digest('hex') };
}

export function discardStaged(staged: StagedModelUpload | undefined): void {
  if (staged) rmSync(staged.path, { force: true });
}

const ZIP_IGNORE = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;
const ZIP_ALLOWED = new Set(['.gltf', '.glb', '.bin', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.md', '.pdf', '.license', '.licence']);

/** Unpack a .zip in memory with path, count, size and file-type checks. */
export function unpackZip(bytes: Uint8Array, limits: Models3dLimits): Map<string, Uint8Array> {
  let entries = 0;
  let unpacked = 0;
  const refused: string[] = [];
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (f.name.endsWith('/') || ZIP_IGNORE.test(f.name)) return false;
        entries += 1;
        if (entries > limits.maxZipEntries) throw new ModelInvalidError(`The zip holds more than ${limits.maxZipEntries} files`);
        const name = f.name.replace(/\\/g, '/');
        if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) throw new ModelInvalidError(`The zip entry "${f.name.slice(0, 80)}" has an unsafe path`);
        const ext = path.posix.extname(name).toLowerCase();
        if (!ZIP_ALLOWED.has(ext) && !/^(licen[cs]e|readme|copying)(\.|$)/i.test(path.posix.basename(name))) refused.push(name);
        unpacked += f.originalSize;
        if (unpacked > limits.maxUnpackedBytes) throw new ModelInvalidError(`The zip unpacks to more than ${Math.round(limits.maxUnpackedBytes / MIB)} MB`);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new ModelInvalidError(`The zip cannot be opened: ${(e as Error).message}`);
  }
  if (refused.length) throw new ModelInvalidError(`The zip contains files that are not part of a glTF model (${refused.slice(0, 5).join(', ')}${refused.length > 5 ? ', …' : ''}). Only .gltf/.glb, .bin, PNG/JPEG/WebP textures and licence text are allowed — no scripts or programs.`, { refused: refused.slice(0, 20) });
  const out = new Map<string, Uint8Array>();
  let total = 0;
  for (const [name, data] of Object.entries(files)) {
    total += data.length;
    out.set(path.posix.normalize(name.replace(/\\/g, '/')), data);
  }
  if (total > limits.maxUnpackedBytes) throw new ModelInvalidError(`The zip unpacks to more than ${Math.round(limits.maxUnpackedBytes / MIB)} MB`);
  return out;
}

export interface PreparedModel {
  json: Json;
  /** The GLB to store: bytes in memory, or the staged file to move as it is. */
  glb: { bytes: Uint8Array } | { file: string; bytes: number };
  sourceFormat: 'glb' | 'gltf' | 'zip';
  warnings: string[];
}

function detectFormat(fileName: string, head: Uint8Array): 'glb' | 'gltf' | 'zip' {
  if (head.length >= 4 && head[0] === 0x67 && head[1] === 0x6c && head[2] === 0x54 && head[3] === 0x46) return 'glb';
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5)) return 'zip';
  const ext = path.extname(fileName).toLowerCase();
  const firstChar = Buffer.from(head).toString('utf8').replace(/^﻿/, '').trimStart()[0];
  if (firstChar === '{') return 'gltf';
  if (ext === '.glb') throw new ModelInvalidError('This is not a binary glTF (.glb) file — the "glTF" header is missing');
  if (ext === '.zip') throw new ModelInvalidError('This is not a zip file');
  throw new ModelInvalidError('Upload a .glb, a .gltf, or a .zip holding a .gltf with its .bin and textures');
}

/** Validate a staged upload and turn it into one GLB. Throws ModelInvalidError (422) with a plain reason. */
export function prepareModel(staged: StagedModelUpload, fileName: string, limits: Models3dLimits): PreparedModel {
  if (staged.bytes === 0) throw new ModelInvalidError('The uploaded file is empty');
  if (staged.bytes > limits.maxBytes) throw new HttpError(413, 'FILE_TOO_LARGE', `This file is larger than the ${Math.round(limits.maxBytes / MIB)} MB limit for a 3D model`, { limitBytes: limits.maxBytes });
  const head = readRange(staged.path, 0, Math.min(64, staged.bytes));
  const format = detectFormat(fileName, head);

  if (format === 'glb') {
    const h = readGlbHeader(staged.path);
    const { warnings } = checkGltfJson(h.json, limits);
    const buffers = arr(h.json.buffers);
    const anyUri = buffers.some((b) => b?.uri !== undefined) || arr(h.json.images).some((i) => i?.uri !== undefined);
    if (!anyUri && buffers.length <= 1) {
      if (buffers.length === 1 && (h.binLength === undefined || h.binLength < Number(buffers[0].byteLength))) throw new ModelInvalidError('The .glb binary chunk is shorter than the model says');
      checkEmbeddedImages(h.json, (bv, len) => readRange(staged.path, (h.binOffset ?? 0) + Number(bv.byteOffset ?? 0), len));
      return { json: h.json, glb: { file: staged.path, bytes: staged.bytes }, sourceFormat: 'glb', warnings };
    }
    // a GLB that also uses data: URIs or several buffers: pack it
    for (const b of buffers) if (b?.uri !== undefined && !String(b.uri).startsWith('data:')) safeRelativeUri(String(b.uri));
    for (const i of arr(h.json.images)) if (i?.uri !== undefined && !String(i.uri).startsWith('data:')) safeRelativeUri(String(i.uri));
    const whole = readFileSync(staged.path);
    const parsed = parseGlb(new Uint8Array(whole.buffer, whole.byteOffset, whole.byteLength));
    const bytes = packToGlb(parsed.json, parsed.bin, new Map(), '');
    const repacked = parseGlb(bytes);
    checkEmbeddedImages(repacked.json, (bv, len) => repacked.bin!.subarray(Number(bv.byteOffset ?? 0), Number(bv.byteOffset ?? 0) + len));
    return { json: repacked.json, glb: { bytes }, sourceFormat: 'glb', warnings };
  }

  if (format === 'gltf') {
    if (staged.bytes > 256 * MIB) throw new ModelInvalidError('The .gltf text file is too large to read; export a .glb instead');
    const json = parseJsonText(readFileSync(staged.path, 'utf8'));
    const { warnings } = checkGltfJson(json, limits);
    const bytes = packToGlb(json, undefined, new Map(), '');
    const repacked = parseGlb(bytes);
    if (repacked.bin) checkEmbeddedImages(repacked.json, (bv, len) => repacked.bin!.subarray(Number(bv.byteOffset ?? 0), Number(bv.byteOffset ?? 0) + len));
    return { json: repacked.json, glb: { bytes }, sourceFormat: 'gltf', warnings };
  }

  // zip
  const zipBytes = readFileSync(staged.path);
  const files = unpackZip(new Uint8Array(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength), limits);
  const models = [...files.keys()].filter((n) => /\.(gltf|glb)$/i.test(n));
  if (models.length === 0) throw new ModelInvalidError('The zip has no .gltf or .glb file');
  if (models.length > 1) throw new ModelInvalidError(`The zip holds ${models.length} models (${models.slice(0, 4).join(', ')}). Zip one model per upload.`, { models: models.slice(0, 20) });
  const entry = models[0]!;
  const entryBytes = files.get(entry)!;
  let json: Json;
  let bin: Uint8Array | undefined;
  if (/\.glb$/i.test(entry)) {
    const p = parseGlb(entryBytes);
    json = p.json;
    bin = p.bin;
  } else json = parseJsonText(Buffer.from(entryBytes.buffer, entryBytes.byteOffset, entryBytes.byteLength).toString('utf8'));
  const { warnings } = checkGltfJson(json, limits);
  const baseDir = path.posix.dirname(entry) === '.' ? '' : path.posix.dirname(entry);
  const bytes = packToGlb(json, bin, files, baseDir);
  const repacked = parseGlb(bytes);
  if (repacked.bin) checkEmbeddedImages(repacked.json, (bv, len) => repacked.bin!.subarray(Number(bv.byteOffset ?? 0), Number(bv.byteOffset ?? 0) + len));
  return { json: repacked.json, glb: { bytes }, sourceFormat: 'zip', warnings };
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

export interface AssignmentInput {
  makeSlug: string;
  modelSlug: string;
  generationId?: string;
  bodyType?: string;
}

/** Resolve a make / model / generation pick against the catalogue (422 when it is not there). */
export function resolveAssignment(ctx: AppContext, input: AssignmentInput): Model3dAssignment {
  const m = getModel(ctx, input.makeSlug, input.modelSlug);
  if (!m) throw new HttpError(422, 'UNKNOWN_VEHICLE', `${input.makeSlug} / ${input.modelSlug} is not in the vehicle catalogue. Add it under Vehicles first.`);
  const out: Model3dAssignment = { makeSlug: m.makeSlug, make: makeDisplayName(ctx, m.makeSlug), modelSlug: m.slug, model: m.name, years: m.years };
  if (input.generationId) {
    const g = m.generations.find((x) => x.id === input.generationId);
    if (!g) throw new HttpError(422, 'UNKNOWN_GENERATION', `Generation ${input.generationId} is not listed for the ${m.name}`);
    out.generationId = g.id;
    out.generation = g.name;
    out.years = { from: g.from, to: g.to };
  }
  const body = normaliseModelBody(input.bodyType) ?? (input.generationId ? normaliseModelBody(m.generations.find((x) => x.id === input.generationId)?.bodies[0]?.body) : undefined);
  if (body) out.bodyType = body;
  return out;
}

/** The catalogue's display name for a make slug ('mercedes-benz' → 'Mercedes-Benz'). */
function makeDisplayName(ctx: AppContext, makeSlug: string): string {
  return listMakes(ctx).find((m) => m.slug === makeSlug)?.make ?? makeSlug;
}

export interface CreateModelInput {
  staged: StagedModelUpload;
  fileName: string;
  title?: string;
  assignment: Model3dAssignment;
  licenceNote?: string;
  actorId: string;
  now: string;
}

export function createModel(ctx: AppContext, input: CreateModelInput, limits: Models3dLimits): Model3dRecord {
  const prepared = prepareModel(input.staged, input.fileName, limits);
  const { parts, triangles } = scanParts(prepared.json, limits);
  const materials = classifyMaterials(prepared.json, parts);
  const body = input.assignment.bodyType;
  const frame = detectFrame(parts, body);
  const autoZones = autoMapZones(parts, materials, body, frame);
  const plateParts: PlatePart[] = [];
  const box = carBox(parts);
  for (const p of parts) {
    const plate = isPlateName(p.name) || isPlateName(p.meshName) || (p.material !== undefined && materials[p.material]?.role === 'plate');
    if (!plate) continue;
    const q = readQuals([...tokenizePartName(p.name), ...(p.meshName ? tokenizePartName(p.meshName) : []), ...p.parents.flatMap(tokenizePartName)]);
    const g = box ? geoFor(p, box, frame) : undefined;
    plateParts.push({ key: p.key, position: q.pos ?? g?.pos ?? 'rear' });
  }
  const id = randomUUID();
  const dir = path.join(models3dRoot(ctx), id);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'model.glb');
  let storedBytes: number;
  if ('file' in prepared.glb) {
    renameSync(prepared.glb.file, target);
    storedBytes = prepared.glb.bytes;
  } else {
    writeFileSync(target, prepared.glb.bytes);
    storedBytes = prepared.glb.bytes.length;
  }
  const json = prepared.json;
  const record: Model3dRecord = {
    id,
    title: (input.title?.trim() || `${input.assignment.make} ${input.assignment.model}${input.assignment.generation ? ` ${input.assignment.generation}` : ''}`).slice(0, 160),
    fileName: path.basename(input.fileName).slice(0, 200),
    sourceFormat: prepared.sourceFormat,
    bytes: storedBytes,
    sha256: input.staged.sha256,
    assignment: input.assignment,
    licence: { confirmed: true, ...(input.licenceNote?.trim() ? { note: input.licenceNote.trim().slice(0, 500) } : {}), confirmedBy: input.actorId, confirmedAt: input.now },
    active: true,
    stats: {
      triangles,
      nodes: arr(json.nodes).length,
      meshes: arr(json.meshes).length,
      materials: arr(json.materials).length,
      textures: arr(json.textures).length,
      parts: parts.length,
      extensionsUsed: arr(json.extensionsUsed).map(String),
    },
    warnings: prepared.warnings,
    frame,
    parts,
    materials,
    paintMaterials: materials.filter((m) => m.role === 'paint').map((m) => m.index),
    plateParts,
    autoZones,
    tags: {},
    thumbnail: false,
    createdAt: input.now,
    createdBy: input.actorId,
    updatedAt: input.now,
  };
  try {
    writeRecord(ctx, record);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return record;
}

export interface ModelPatch {
  title?: string;
  active?: boolean;
  assignment?: Model3dAssignment;
  frame?: { forward: ForwardAxis; mirror: boolean };
  paintMaterials?: number[];
  plateParts?: PlatePart[];
  licenceNote?: string;
}

/** Apply a patch; a new body or frame re-runs the automatic mapping (manual tags are kept). */
export function updateModel(ctx: AppContext, id: string, patch: ModelPatch, now: string): { before: Model3dRecord; after: Model3dRecord } {
  const before = readRecord(ctx, id);
  const after: Model3dRecord = JSON.parse(JSON.stringify(before));
  if (patch.title !== undefined) after.title = patch.title.trim().slice(0, 160) || before.title;
  if (patch.active !== undefined) after.active = patch.active;
  if (patch.assignment) after.assignment = patch.assignment;
  if (patch.licenceNote !== undefined) {
    if (patch.licenceNote.trim()) after.licence.note = patch.licenceNote.trim().slice(0, 500);
    else delete after.licence.note;
  }
  if (patch.frame) after.frame = { ...patch.frame, source: 'owner' };
  if (patch.paintMaterials) {
    const valid = new Set(after.materials.map((m) => m.index));
    after.paintMaterials = [...new Set(patch.paintMaterials.filter((i) => valid.has(i)))].sort((a, b) => a - b);
  }
  if (patch.plateParts) {
    const keys = new Set(after.parts.map((p) => p.key));
    const bad = patch.plateParts.find((p) => !keys.has(p.key));
    if (bad) throw new HttpError(400, 'VALIDATION', `Part ${bad.key} is not in this model`);
    after.plateParts = patch.plateParts.map((p) => ({ key: p.key, position: p.position }));
  }
  if (patch.frame || (patch.assignment && patch.assignment.bodyType !== before.assignment.bodyType)) {
    after.autoZones = autoMapZones(after.parts, after.materials, after.assignment.bodyType, after.frame);
  }
  after.updatedAt = now;
  writeRecord(ctx, after);
  return { before, after };
}

/**
 * Save manual tags. `replace` swaps the whole set; otherwise the given keys are merged. A value of `null` marks a part
 * as "not a damage part"; `'auto'`-style removal is done by passing the key in `clear`.
 */
export function saveTags(ctx: AppContext, id: string, input: { tags: Record<string, string | null>; clear?: string[]; replace?: boolean }, now: string): { before: Record<string, string | null>; after: Model3dRecord } {
  const r = readRecord(ctx, id);
  const keys = new Set(r.parts.map((p) => p.key));
  for (const [k, v] of Object.entries(input.tags)) {
    if (!keys.has(k)) throw new HttpError(400, 'VALIDATION', `Part ${k} is not in this model`);
    if (v !== null && !isModelZoneId(v)) throw new HttpError(400, 'VALIDATION', `"${v}" is not a damage zone`, { zone: v });
  }
  for (const k of input.clear ?? []) if (!keys.has(k)) throw new HttpError(400, 'VALIDATION', `Part ${k} is not in this model`);
  const before = { ...r.tags };
  const next: Record<string, string | null> = input.replace ? {} : { ...r.tags };
  for (const [k, v] of Object.entries(input.tags)) next[k] = v;
  for (const k of input.clear ?? []) delete next[k];
  r.tags = next;
  r.updatedAt = now;
  writeRecord(ctx, r);
  return { before, after: r };
}

export function deleteModel(ctx: AppContext, id: string): Model3dRecord {
  const r = readRecord(ctx, id);
  rmSync(modelDir(ctx, id), { recursive: true, force: true });
  return r;
}

const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;
export const THUMBNAIL_MAX_BYTES = 2 * MIB;

export function saveThumbnail(ctx: AppContext, id: string, dataUrl: string, now: string): Model3dRecord {
  const r = readRecord(ctx, id);
  const m = PNG_DATA_URL.exec(dataUrl);
  if (!m) throw new HttpError(400, 'VALIDATION', 'The thumbnail must be a PNG data URL');
  const bytes = Buffer.from(m[1]!, 'base64');
  if (bytes.length > THUMBNAIL_MAX_BYTES) throw new HttpError(413, 'FILE_TOO_LARGE', 'The thumbnail is larger than 2 MB');
  if (sniffImage(new Uint8Array(bytes.buffer, bytes.byteOffset, Math.min(16, bytes.length))) !== 'image/png') throw new HttpError(400, 'VALIDATION', 'The thumbnail is not a PNG picture');
  writeFileSync(thumbnailPath(ctx, id), bytes);
  r.thumbnail = true;
  r.updatedAt = now;
  writeRecord(ctx, r);
  return r;
}

// ---------------------------------------------------------------------------
// Matching a vehicle to a model
// ---------------------------------------------------------------------------

export interface MatchQuery {
  makeSlug?: string;
  modelSlug?: string;
  generationId?: string;
  make?: string;
  model?: string;
  bodyType?: string;
  year?: number;
}

export interface MatchResult {
  model: Model3dView | null;
  matchedOn: 'generation+body' | 'generation' | 'year+body' | 'year' | 'model+body' | 'model' | null;
  makeSlug?: string;
  modelSlug?: string;
}

/**
 * Best active model for a vehicle. A model assigned to another generation never matches a vehicle whose generation is
 * known; a model with no generation fits every generation of the model, but ranks below an exact one.
 */
export function matchModel(ctx: AppContext, q: MatchQuery): MatchResult {
  let makeSlug = q.makeSlug;
  let modelSlug = q.modelSlug;
  if ((!makeSlug || !modelSlug) && q.make) {
    const m = matchVehicle(ctx, q.make, q.model);
    makeSlug ??= m.makeSlug;
    modelSlug ??= m.modelSlug;
  }
  if (!makeSlug || !modelSlug) return { model: null, matchedOn: null, ...(makeSlug ? { makeSlug } : {}) };
  const body = normaliseModelBody(q.bodyType);
  let best: { r: Model3dRecord; score: number; on: NonNullable<MatchResult['matchedOn']> } | undefined;
  for (const r of listRecords(ctx)) {
    if (!r.active || r.assignment.makeSlug !== makeSlug || r.assignment.modelSlug !== modelSlug) continue;
    const a = r.assignment;
    const bodyOk = !body || !a.bodyType || a.bodyType === body;
    const bodyExact = !!body && a.bodyType === body;
    let score = 0;
    let on: NonNullable<MatchResult['matchedOn']>;
    if (q.generationId) {
      if (a.generationId && a.generationId !== q.generationId) continue;
      if (a.generationId) {
        score = 100;
        on = bodyExact ? 'generation+body' : 'generation';
      } else {
        score = 40;
        on = bodyExact ? 'model+body' : 'model';
      }
    } else if (q.year && a.years) {
      const inYears = q.year >= a.years.from && (a.years.to === null || q.year <= a.years.to);
      if (a.generationId && !inYears) continue;
      score = inYears && a.generationId ? 80 : 40;
      on = inYears && a.generationId ? (bodyExact ? 'year+body' : 'year') : bodyExact ? 'model+body' : 'model';
    } else {
      score = a.generationId ? 30 : 40;
      on = bodyExact ? 'model+body' : 'model';
    }
    if (!bodyOk) score -= 25;
    if (bodyExact) score += 10;
    if (!best || score > best.score || (score === best.score && r.updatedAt > best.r.updatedAt)) best = { r, score, on };
  }
  return { model: best ? toView(best.r) : null, matchedOn: best?.on ?? null, makeSlug, modelSlug };
}
