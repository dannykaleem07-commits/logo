/**
 * Pure normalisers for vehicle dimension records (no I/O). Tolerant by design: the data files are written by a
 * separate job and may be partial, so every missing or out-of-range field is filled from the body-type defaults
 * below and reported in `filled` rather than rejected.
 */
import {
  GRILLE_STYLES,
  LAMP_STYLES,
  type BodyDimensions,
  type BodyDimensionsInput,
  type DimensionProfile,
  type GrilleStyle,
  type LampStyle
} from './types.js';

type Defaults = Omit<BodyDimensions, 'note' | 'doorOptions'>;

/** Typical UK-market proportions per silhouette. Used only when a file lacks a value. */
export const PROFILE_DEFAULTS: Record<DimensionProfile, Defaults> = {
  hatch: d(4100, 1780, 1460, 2560, 140, 16, 'hatch', 0.22, 0.165, 0.205, 0.34, 0.25, 5, false, false, false, 'slim', 'wide'),
  saloon: d(4700, 1820, 1440, 2820, 135, 17, 'saloon', 0.27, 0.215, 0.19, 0.32, 0.3, 4, false, false, false, 'slim', 'wide'),
  fastback: d(4760, 1840, 1430, 2840, 135, 18, 'fastback', 0.27, 0.21, 0.195, 0.3, 0.45, 5, false, false, false, 'slim', 'wide'),
  estate: d(4700, 1820, 1480, 2780, 140, 17, 'estate', 0.25, 0.22, 0.2, 0.33, 0.12, 5, true, false, false, 'slim', 'wide'),
  coupe: d(4500, 1830, 1380, 2700, 125, 19, 'coupe', 0.29, 0.21, 0.21, 0.29, 0.45, 2, false, false, false, 'slim', 'wide'),
  convertible: d(4450, 1830, 1350, 2680, 125, 18, 'convertible', 0.29, 0.21, 0.206, 0.27, 0.42, 2, false, false, false, 'slim', 'wide'),
  suv: d(4450, 1840, 1630, 2660, 185, 18, 'suv', 0.23, 0.19, 0.21, 0.31, 0.25, 5, true, false, false, 'slim', 'large'),
  'suv-boxy': d(4600, 1900, 1750, 2740, 200, 17, 'suv-boxy', 0.24, 0.2, 0.2, 0.32, 0.08, 5, true, false, false, 'slim', 'large'),
  'suv-coupe': d(4370, 1900, 1610, 2680, 175, 20, 'suv-coupe', 0.24, 0.19, 0.209, 0.29, 0.42, 5, false, false, false, 'slim', 'large'),
  mpv: d(4560, 1830, 1700, 2790, 145, 16, 'mpv', 0.17, 0.18, 0.21, 0.37, 0.1, 5, true, false, false, 'slim', 'wide'),
  van: d(4970, 1990, 1990, 2930, 165, 16, 'van', 0.16, 0.19, 0.19, 0.3, 0.05, 4, false, false, true, 'tall', 'large'),
  'van-high-roof': d(4970, 1990, 2280, 2930, 175, 16, 'van-high-roof', 0.12, 0.2, 0.171, 0.24, 0.04, 4, false, false, true, 'tall', 'large'),
  pickup: d(5330, 1855, 1815, 3085, 215, 17, 'pickup', 0.22, 0.24, 0.17, 0.31, 0.08, 4, false, false, false, 'slim', 'large')
};

function d(
  lengthMm: number,
  widthMm: number,
  heightMm: number,
  wheelbaseMm: number,
  groundClearanceMm: number,
  wheelDiameterIn: number,
  profile: DimensionProfile,
  bonnetRatio: number,
  rearOverhangRatio: number,
  frontOverhangRatio: number,
  glasshouseHeightRatio: number,
  roofTaper: number,
  doors: number,
  roofRails: boolean,
  spareOnTailgate: boolean,
  slidingSideDoor: boolean,
  lampStyle: LampStyle,
  grilleStyle: GrilleStyle
): Defaults {
  return {
    lengthMm,
    widthMm,
    heightMm,
    wheelbaseMm,
    groundClearanceMm,
    wheelDiameterIn,
    profile,
    bonnetRatio,
    rearOverhangRatio,
    frontOverhangRatio,
    glasshouseHeightRatio,
    roofTaper,
    doors,
    roofRails,
    spareOnTailgate,
    slidingSideDoor,
    lampStyle,
    grilleStyle
  };
}

const lc = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '');

/** Free-text profile or body name → silhouette family; undefined when nothing matches. */
export function normaliseProfile(text: unknown): DimensionProfile | undefined {
  const t = lc(text).replace(/[_\s]+/g, '-');
  if (!t) return undefined;
  if ((DIMENSION_PROFILE_SET as Set<string>).has(t)) return t as DimensionProfile;
  if (/van/.test(t) && /(high|h2|h3|tall)/.test(t)) return 'van-high-roof';
  if (/(pick-?up|double-?cab|crew-?cab|single-?cab|king-?cab|ute)/.test(t)) return 'pickup';
  if (/(panel|van|chassis|camper|luton|minibus)/.test(t)) return /minibus/.test(t) ? 'van-high-roof' : 'van';
  if (/(suv-?coupe|coupe-?suv|crossover-?coupe)/.test(t)) return 'suv-coupe';
  if (/(boxy|square|upright)/.test(t) && /(suv|4x4|off-?road)/.test(t)) return 'suv-boxy';
  if (/(suv|crossover|4x4|off-?road)/.test(t)) return 'suv';
  if (/taxi/.test(t)) return 'mpv';
  if (/(mpv|people|carrier|multi-?purpose)/.test(t)) return 'mpv';
  if (/(estate|wagon|touring|tourer|avant|shooting|sportbrake|sports-?tourer|variant|kombi)/.test(t)) return 'estate';
  if (/(fastback|liftback|sportback|gran-?coupe|five-?door-?coupe)/.test(t)) return 'fastback';
  if (/(convert|cabrio|roadster|spider|spyder|soft-?top)/.test(t)) return 'convertible';
  if (/coupe/.test(t)) return 'coupe';
  if (/(saloon|sedan|notch|limousine)/.test(t)) return 'saloon';
  if (/hatch/.test(t)) return 'hatch';
  return undefined;
}
const DIMENSION_PROFILE_SET = new Set<string>(Object.keys(PROFILE_DEFAULTS));

export function normaliseLampStyle(text: unknown): LampStyle | undefined {
  const t = lc(text);
  if (!t) return undefined;
  if ((LAMP_STYLES as readonly string[]).includes(t)) return t as LampStyle;
  if (/split|stacked|two-?tier|separate drl/.test(t)) return 'split';
  if (/(light-?bar|lightbar|full-?width|connected|bar)/.test(t)) return 'light-bar';
  if (/(round|circular|oval|bug)/.test(t)) return 'round';
  if (/(tall|vertical|upright)/.test(t)) return 'tall';
  if (/(swept|angular|sharp|wrap|boomerang|hawk)/.test(t)) return 'swept';
  if (/(slim|thin|narrow|strip|led|blade)/.test(t)) return 'slim';
  if (/(square|rect|box|block)/.test(t)) return 'square';
  return undefined;
}

export function normaliseGrilleStyle(text: unknown): GrilleStyle | undefined {
  const t = lc(text);
  if (!t) return undefined;
  if ((GRILLE_STYLES as readonly string[]).includes(t)) return t as GrilleStyle;
  if (/kidney/.test(t)) return 'kidney';
  if (/(shield|trilobo|scudetto)/.test(t)) return 'shield';
  if (/(hex|honeycomb)/.test(t)) return 'hexagonal';
  if (/trapez/.test(t)) return 'trapezoid';
  if (/(closed|blank|ev|none|smooth)/.test(t)) return 'closed';
  if (/(split|twin|dual|two)/.test(t)) return 'split';
  if (/(large|big|tall|spindle|bold|chunky|upright|full)/.test(t)) return 'large';
  if (/(slim|thin|narrow|bar|slot)/.test(t)) return 'slim';
  if (/(wide|horizontal|mesh|oval|rect)/.test(t)) return 'wide';
  return undefined;
}

function num(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Resolve one body record. `bodyKey` (the key in the file, e.g. "hatchback") is the profile fallback when the record
 * has no usable `profile`. Overhangs are reconciled with the wheelbase so front + wheelbase + rear = length.
 */
export function normaliseBodyDimensions(input: unknown, bodyKey = ''): { dims: BodyDimensions; filled: Array<keyof BodyDimensions> } {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as BodyDimensionsInput & Record<string, unknown>;
  const filled: Array<keyof BodyDimensions> = [];
  const profileFromData = normaliseProfile(raw.profile);
  let profile = profileFromData ?? normaliseProfile(bodyKey) ?? 'hatch';
  if (!profileFromData) filled.push('profile');
  const take = <K extends keyof Defaults>(key: K, v: Defaults[K] | undefined): Defaults[K] => {
    if (v === undefined) {
      filled.push(key);
      return PROFILE_DEFAULTS[profile][key];
    }
    return v;
  };

  const heightMm0 = num(raw.heightMm, 1000, 3300);
  // a van file that only says "van" but is 2.2 m+ tall is a high-roof van
  if (profile === 'van' && heightMm0 !== undefined && heightMm0 >= 2200) profile = 'van-high-roof';

  const lengthMm = take('lengthMm', num(raw.lengthMm, 2400, 7600));
  const widthMm = take('widthMm', num(raw.widthMm, 1350, 2700));
  const heightMm = take('heightMm', heightMm0);
  let wheelbaseMm = num(raw.wheelbaseMm, 1700, 4900);
  if (wheelbaseMm !== undefined && wheelbaseMm > lengthMm * 0.82) wheelbaseMm = undefined;
  let front = num(raw.frontOverhangRatio, 0.08, 0.34);
  let rear = num(raw.rearOverhangRatio, 0.06, 0.36);
  const def = PROFILE_DEFAULTS[profile];
  if (wheelbaseMm === undefined) {
    filled.push('wheelbaseMm');
    if (front !== undefined && rear !== undefined && front + rear < 0.6) wheelbaseMm = Math.round(lengthMm * (1 - front - rear));
    else wheelbaseMm = Math.round(lengthMm * (def.wheelbaseMm / def.lengthMm));
  }
  const over = 1 - wheelbaseMm / lengthMm;
  if (front === undefined && rear === undefined) {
    filled.push('frontOverhangRatio', 'rearOverhangRatio');
    const share = def.frontOverhangRatio / (def.frontOverhangRatio + def.rearOverhangRatio);
    front = over * share;
    rear = over - front;
  } else if (front === undefined) {
    filled.push('frontOverhangRatio');
    rear = Math.min(rear!, over * 0.8);
    front = over - rear;
  } else if (rear === undefined) {
    filled.push('rearOverhangRatio');
    front = Math.min(front, over * 0.8);
    rear = over - front;
  } else if (Math.abs(front + rear - over) > 0.005) {
    const k = over / (front + rear);
    front *= k;
    rear *= k;
  }

  const roofTaper = num(raw.roofTaper, 0, 1);
  const doorOptions = (Array.isArray(raw.doors) ? raw.doors : [raw.doors])
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
    .map((x) => Math.round(x))
    .filter((x) => x >= 2 && x <= 5);
  const doorsRaw = doorOptions.length ? Math.max(...doorOptions) : undefined;
  // a single-cab pick-up has two doors
  const doorDefault = /single/.test(String(raw.profile ?? '')) ? 2 : undefined;

  const dims: BodyDimensions = {
    lengthMm,
    widthMm,
    heightMm,
    wheelbaseMm,
    groundClearanceMm: take('groundClearanceMm', num(raw.groundClearanceMm, 70, 400)),
    wheelDiameterIn: take('wheelDiameterIn', num(raw.wheelDiameterIn, 12, 24)),
    profile,
    bonnetRatio: take('bonnetRatio', num(raw.bonnetRatio, 0.04, 0.42)),
    rearOverhangRatio: round4(rear!),
    frontOverhangRatio: round4(front!),
    glasshouseHeightRatio: take('glasshouseHeightRatio', num(raw.glasshouseHeightRatio, 0.15, 0.62)),
    roofTaper: take('roofTaper', roofTaper),
    doors: take('doors', doorsRaw ?? doorDefault),
    doorOptions: [],
    roofRails: take('roofRails', bool(raw.roofRails)),
    spareOnTailgate: take('spareOnTailgate', bool(raw.spareOnTailgate)),
    slidingSideDoor: take('slidingSideDoor', bool(raw.slidingSideDoor)),
    lampStyle: take('lampStyle', normaliseLampStyle(raw.lampStyle)),
    grilleStyle: take('grilleStyle', normaliseGrilleStyle(raw.grilleStyle))
  };
  dims.doorOptions = doorOptions.length ? [...new Set(doorOptions)].sort() : [dims.doors];
  if (typeof raw.note === 'string' && raw.note.trim()) dims.note = raw.note.trim();
  return { dims, filled };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Body-type defaults as a resolved record (for a vehicle with no dimensions file). */
export function defaultBodyDimensions(bodyOrProfile: string): BodyDimensions {
  const profile = normaliseProfile(bodyOrProfile) ?? 'hatch';
  return { ...PROFILE_DEFAULTS[profile], doorOptions: [PROFILE_DEFAULTS[profile].doors] };
}

// ── matching helpers ──

export function slugText(text: unknown): string {
  return (typeof text === 'string' ? text : '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const MAKE_ALIASES: Record<string, string> = {
  vw: 'volkswagen',
  'volkswagen-commercial-vehicles': 'volkswagen',
  'vw-commercial': 'volkswagen',
  mercedes: 'mercedes-benz',
  'mercedes-amg': 'mercedes-benz',
  merc: 'mercedes-benz',
  'range-rover': 'land-rover',
  landrover: 'land-rover',
  alfa: 'alfa-romeo',
  'ds-automobiles': 'ds',
  'mini-cooper': 'mini',
  'great-wall-motors': 'gwm',
  'ssangyong-motor': 'ssangyong',
  kgm: 'ssangyong'
};

export function makeSlug(make: unknown): string {
  const s = slugText(make);
  return MAKE_ALIASES[s] ?? s;
}

/** Generation code: the part before any "(years)", slugged — "Mk8 (2017–2023)" → "mk8". */
export function generationCode(name: string): string {
  return slugText(name.split('(')[0] ?? name);
}

/** Years covered by a generation name such as "Mk8 (2017–2023)" or "Gen2 (2023–present)". */
export function generationYears(name: string): { from?: number; to?: number } {
  const m = /((?:19|20)\d{2})\s*(?:[-–—to]+\s*((?:19|20)\d{2}|present|now|on|date)?)?/i.exec(name);
  if (!m) return {};
  const from = Number(m[1]);
  const to = m[2] && /^\d{4}$/.test(m[2]) ? Number(m[2]) : m[2] ? 9999 : undefined;
  return { from, to };
}

/** Candidate body keys for a requested body, best first. */
export function bodyCandidates(body: string | undefined): string[] {
  const b = slugText(body ?? '');
  const p = normaliseProfile(b);
  const map: Record<DimensionProfile, string[]> = {
    hatch: ['hatchback', 'hatch', 'liftback', 'fastback', 'sportback'],
    saloon: ['saloon', 'sedan', 'fastback', 'liftback', 'gran-coupe'],
    fastback: ['fastback', 'liftback', 'sportback', 'gran-coupe', 'hatchback', 'saloon'],
    estate: ['estate', 'tourer', 'touring', 'shooting-brake', 'sports-tourer', 'avant'],
    coupe: ['coupe', 'fastback'],
    convertible: ['convertible', 'cabriolet', 'roadster'],
    suv: ['suv', 'crossover', '4x4', 'suv-coupe'],
    'suv-boxy': ['suv', 'suv-3-door', '4x4', 'crossover'],
    'suv-coupe': ['suv-coupe', 'coupe-suv', 'suv', 'crossover'],
    mpv: ['mpv', 'people-carrier', 'minibus'],
    van: ['panel-van', 'van', 'crew-van', 'combi', 'kombi', 'chassis-cab'],
    'van-high-roof': ['panel-van-high-roof', 'high-roof', 'panel-van', 'van', 'crew-van', 'minibus'],
    pickup: ['pickup', 'pick-up', 'double-cab', 'crew-cab', 'pickup-2-door', 'single-cab', 'king-cab']
  };
  const out = b ? [b] : [];
  if (p) for (const k of map[p]) if (!out.includes(k)) out.push(k);
  return out;
}
