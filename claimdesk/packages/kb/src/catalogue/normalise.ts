/**
 * Catalogue make-file validation and normalisation (TEMPLATES-VEHICLES-DESKTOP §D.2, §D.5).
 *
 * `validateCatalogueMake` checks a raw make file against the §D.2 rules and throws `KbValidationError` with a JSON path;
 * `normaliseCatalogueMake` turns the compact form (string trims/engines) into the normalised shapes with stable ids.
 * Nothing here upgrades the `unverified` status of the data.
 */
import type { FuelType } from '@ccguk/domain';
import { KbValidationError } from '../load.js';
import {
  CATALOGUE_BODIES,
  CATALOGUE_FUELS,
  CATALOGUE_SEGMENTS,
  CATALOGUE_TRANSMISSIONS,
  CATALOGUE_VEHICLE_TYPES,
  type CatalogueBody,
  type CatalogueEngine,
  type CatalogueFuel,
  type CatalogueGeneration,
  type CatalogueMakeFile,
  type CatalogueModel,
  type CatalogueSegment,
  type CatalogueTransmission,
  type CatalogueTrim,
  type CatalogueVehicleType,
  type NormalisedEngine,
  type NormalisedGeneration,
  type NormalisedMake,
  type NormalisedModel,
  type NormalisedTrim,
} from './types.js';

/** Copied verbatim from TEMPLATES-VEHICLES-DESKTOP §A.4 (kb must not import @ccguk/documents). */
export function slugify(text: string, max = 48): string {
  const s = text
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‚‛']/g, '')
    .replace(/&/g, ' and ').replace(/\+/g, ' plus ').replace(/£/g, ' gbp ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = s.slice(0, max).replace(/-+$/g, '');
  return cut || 'x';
}

export const CATALOGUE_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const GTA_GROUP_CODE = /^[A-Z]{1,3}\d{0,2}$/;
export const CATALOGUE_MIN_YEAR = 2000;
export const CATALOGUE_MAX_YEAR = 2026;
export const DEFAULT_CATALOGUE_SOURCE_NOTE =
  'Compiled from general knowledge of the UK market 2000–2026; confirm against the V5C, DVLA record or Total Car Check.';

// ---------------------------------------------------------------------------
// Fuels and engine labels
// ---------------------------------------------------------------------------

/** mild-hybrid → base fuel (petrol unless the label says diesel); plug-in-hybrid → plugin_hybrid; hydrogen → other. */
export function catalogueFuelToDomain(f: CatalogueFuel): { fuel: FuelType; mildHybrid?: boolean } {
  switch (f) {
    case 'petrol':
    case 'diesel':
    case 'hybrid':
    case 'electric':
    case 'lpg':
      return { fuel: f };
    case 'mild-hybrid':
      return { fuel: 'petrol', mildHybrid: true };
    case 'plug-in-hybrid':
      return { fuel: 'plugin_hybrid' };
    case 'hydrogen':
      return { fuel: 'other' };
    default:
      return { fuel: 'other' };
  }
}

const FUEL_WORDS = new Set<string>(CATALOGUE_FUELS);

/**
 * Parse a compact engine string (§D.2 grammar): `[<litres>] <name words…> <power>PS <fuel>`, e.g. `1.0 EcoBoost 125PS
 * petrol`, `2.0 EcoBlue 130PS mild-hybrid diesel`, `ID.3 Pro 58kWh 204PS electric`. The fuel words after the power are
 * read in either order (`petrol mild-hybrid` = `mild-hybrid petrol`); `electric petrol` (range extender) is read as a
 * plug-in hybrid. A label with a qualifier after the fuel (`… plug-in-hybrid AWD`) is still read. Throws
 * KbValidationError when no fuel word is found at all.
 */
export function parseEngineLabel(label: string): NormalisedEngine {
  const text = typeof label === 'string' ? label.trim().replace(/\s+/g, ' ') : '';
  if (!text) throw new KbValidationError('engine label must not be empty', 'engine');
  const tokens = text.split(' ');
  const lower = tokens.map((t) => t.toLowerCase());

  // Fuel words: the fuel tokens after the power (`125PS petrol`, `100PS lpg bi-fuel`), else the trailing run (≤ 2).
  let psIdx = -1;
  lower.forEach((t, k) => {
    if (/^\d{2,4}ps$/.test(t)) psIdx = k;
  });
  let fuelWords: string[];
  if (psIdx >= 0) fuelWords = lower.slice(psIdx + 1).filter((t) => FUEL_WORDS.has(t));
  else {
    let i = lower.length;
    while (i > 0 && FUEL_WORDS.has(lower[i - 1]!) && lower.length - i < 2) i -= 1;
    fuelWords = lower.slice(i);
  }
  // Tolerance for labels that put a qualifier after the fuel ('… plug-in-hybrid AWD', '… electric dual-motor'):
  // take the fuel words wherever they are.
  if (!fuelWords.length) fuelWords = lower.map((t) => t.replace(/^[(]+|[),.;]+$/g, '')).filter((t) => FUEL_WORDS.has(t));
  if (!fuelWords.length) throw new KbValidationError(`engine label "${text}" must end with a fuel (${CATALOGUE_FUELS.join(', ')})`, 'engine');
  const has = (w: string) => fuelWords.includes(w);
  const base = has('diesel') ? 'diesel' : has('petrol') ? 'petrol' : undefined;
  let fuel: CatalogueFuel;
  let domainFuel: FuelType;
  let mildHybrid: boolean | undefined;
  if (has('plug-in-hybrid')) {
    fuel = 'plug-in-hybrid';
    domainFuel = 'plugin_hybrid';
  } else if (has('mild-hybrid')) {
    fuel = 'mild-hybrid';
    domainFuel = base ?? 'petrol';
    mildHybrid = true;
  } else if (has('hybrid')) {
    fuel = 'hybrid';
    domainFuel = 'hybrid';
  } else if (has('electric') && base) {
    fuel = 'plug-in-hybrid';
    domainFuel = 'plugin_hybrid';
  } else {
    fuel = fuelWords[fuelWords.length - 1] as CatalogueFuel;
    domainFuel = catalogueFuelToDomain(fuel).fuel;
  }

  const out: NormalisedEngine = { id: slugify(text), label: text, fuel, domainFuel };
  if (mildHybrid) out.mildHybrid = true;
  const litres = /^(\d{1,2}\.\d{1,2})$/.exec(tokens[0] ?? '');
  const ccToken = tokens.find((t) => /^\d{3,5}cc$/i.test(t));
  if (ccToken) out.cc = Number(ccToken.slice(0, -2));
  else if (litres) {
    out.cc = Math.round(Number(litres[1]) * 1000);
    out.ccApprox = true;
  }
  const ps = tokens.map((t) => /^(\d{2,4})PS$/i.exec(t)).find(Boolean);
  if (ps) out.powerPs = Number(ps[1]);
  const kw = tokens.map((t) => /^(\d{2,4})kW$/.exec(t)).find(Boolean);
  if (kw) out.powerKw = Number(kw[1]);
  const kwh = tokens.map((t) => /^(\d{1,3}(?:\.\d)?)kWh$/i.exec(t)).find(Boolean);
  if (kwh) out.batteryKwh = Number(kwh[1]);
  return out;
}

// ---------------------------------------------------------------------------
// Validation (§D.2 rules)
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (path: string, message: string): never => {
  throw new KbValidationError(message, path);
};

/** Options for `validateCatalogueMake`. */
export interface ValidateCatalogueOptions {
  /**
   * true (default): every §D.2 rule throws. false (the runtime loader): quality rules — a car generation without trims,
   * door/seat counts outside the ranges, generation years outside the model years, an alias shared by two models — are
   * pushed to `warnings` instead, so one questionable row does not hide a whole make. Structural errors always throw.
   */
  strict?: boolean;
  warnings?: string[];
}

let qualityMode: { strict: boolean; warnings: string[] } = { strict: true, warnings: [] };
/** A §D.2 quality rule: throws in strict mode, else recorded as a warning. Returns false when the rule failed. */
function quality(ok: boolean, path: string, message: string): boolean {
  if (ok) return true;
  if (qualityMode.strict) fail(path, message);
  qualityMode.warnings.push(`${path}: ${message}`);
  return false;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || !v.trim()) fail(path, `expected a non-empty string, got ${JSON.stringify(v)}`);
  return (v as string).trim();
}
function optStr(v: unknown, path: string): string | undefined {
  return v === undefined || v === null ? undefined : str(v, path);
}
function strArr(v: unknown, path: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(path, 'expected an array of strings');
  return (v as unknown[]).map((s, i) => str(s, `${path}[${i}]`));
}
function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) fail(path, `expected one of ${allowed.join(', ')}, got ${JSON.stringify(v)}`);
  return v as T;
}
function year(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < CATALOGUE_MIN_YEAR || v > CATALOGUE_MAX_YEAR) fail(path, `expected a year ${CATALOGUE_MIN_YEAR}–${CATALOGUE_MAX_YEAR}, got ${JSON.stringify(v)}`);
  return v as number;
}
function yearOrNull(v: unknown, path: string): number | null {
  return v === null || v === undefined ? null : year(v, path);
}
function intArr(v: unknown, path: string, min: number, max: number): number[] {
  if (!Array.isArray(v) || !v.length) fail(path, 'expected a non-empty array of integers');
  return (v as unknown[]).map((n, i) => {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) fail(`${path}[${i}]`, `expected a whole number, got ${JSON.stringify(n)}`);
    quality((n as number) >= min && (n as number) <= max, `${path}[${i}]`, `expected an integer ${min}–${max}, got ${JSON.stringify(n)}`);
    return n as number;
  });
}
function gta(v: unknown, path: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !GTA_GROUP_CODE.test(v)) fail(path, `expected a GTA group code like M1, got ${JSON.stringify(v)}`);
  return v as string;
}
function slugField(v: unknown, fallbackFrom: string, path: string): string {
  if (v === undefined) return slugify(fallbackFrom);
  const s = str(v, path);
  if (!CATALOGUE_SLUG.test(s)) fail(path, `slug must match ${CATALOGUE_SLUG} (got ${JSON.stringify(s)})`);
  return s;
}

function validateEngine(v: unknown, path: string): string | CatalogueEngine {
  if (typeof v === 'string') {
    try {
      parseEngineLabel(v);
    } catch (err) {
      fail(path, (err as Error).message.replace(/^engine: /, ''));
    }
    return v.trim();
  }
  if (!isRec(v)) return fail(path, 'expected an engine string or object');
  const e: CatalogueEngine = { label: str(v.label, `${path}.label`), fuel: oneOf(v.fuel, `${path}.fuel`, CATALOGUE_FUELS) };
  for (const k of ['cc', 'powerPs', 'powerKw', 'batteryKwh'] as const) {
    const n = v[k];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !(n > 0)) fail(`${path}.${k}`, 'expected a positive number');
    e[k] = n as number;
  }
  if (v.transmissions !== undefined) {
    if (!Array.isArray(v.transmissions)) fail(`${path}.transmissions`, 'expected an array');
    e.transmissions = (v.transmissions as unknown[]).map((t, i) => oneOf(t, `${path}.transmissions[${i}]`, CATALOGUE_TRANSMISSIONS));
  }
  if (v.from !== undefined) e.from = year(v.from, `${path}.from`);
  if (v.to !== undefined) e.to = yearOrNull(v.to, `${path}.to`);
  return e;
}

function validateTrim(v: unknown, path: string): string | CatalogueTrim {
  if (typeof v === 'string') return str(v, path);
  if (!isRec(v)) return fail(path, 'expected a trim string or object');
  const t: CatalogueTrim = { name: str(v.name, `${path}.name`) };
  if (v.from !== undefined) t.from = year(v.from, `${path}.from`);
  if (v.to !== undefined) t.to = yearOrNull(v.to, `${path}.to`);
  if (v.bodies !== undefined) {
    if (!Array.isArray(v.bodies)) fail(`${path}.bodies`, 'expected an array');
    t.bodies = (v.bodies as unknown[]).map((b, i) => oneOf(b, `${path}.bodies[${i}]`, CATALOGUE_BODIES));
  }
  if (v.engines !== undefined) t.engines = strArr(v.engines, `${path}.engines`);
  if (v.features !== undefined) t.features = strArr(v.features, `${path}.features`);
  const g = gta(v.gtaGroup, `${path}.gtaGroup`);
  if (g) t.gtaGroup = g;
  return t;
}

function validateGeneration(v: unknown, path: string, vehicleType: CatalogueVehicleType, model: { from: number; to: number | null }): CatalogueGeneration {
  if (!isRec(v)) return fail(path, 'expected a generation object');
  const from = year(v.from, `${path}.from`);
  const to = yearOrNull(v.to, `${path}.to`);
  if (to !== null && to < from) fail(`${path}.to`, `generation ends (${to}) before it starts (${from})`);
  quality(!(from < model.from || (model.to !== null && (to === null || to > model.to))), path, `generation years ${from}–${to ?? 'now'} fall outside the model years ${model.from}–${model.to ?? 'now'}`);
  if (!Array.isArray(v.bodies) || !v.bodies.length) fail(`${path}.bodies`, 'must be a non-empty array');
  const maxSeats = vehicleType === 'minibus' ? 17 : 9;
  const bodies = (v.bodies as unknown[]).map((b, i) => {
    const bp = `${path}.bodies[${i}]`;
    if (!isRec(b)) return fail(bp, 'expected { body, doors, seats }');
    return { body: oneOf(b.body, `${bp}.body`, CATALOGUE_BODIES), doors: intArr(b.doors, `${bp}.doors`, 2, 5), seats: intArr(b.seats, `${bp}.seats`, 1, maxSeats) };
  });
  if (!Array.isArray(v.trims)) fail(`${path}.trims`, 'expected an array');
  quality(!(vehicleType === 'car' && !(v.trims as unknown[]).length), `${path}.trims`, 'a car generation needs at least one trim');
  const trims = (v.trims as unknown[]).map((t, i) => validateTrim(t, `${path}.trims[${i}]`));
  if (!Array.isArray(v.engines) || !v.engines.length) fail(`${path}.engines`, 'must be a non-empty array');
  const engines = (v.engines as unknown[]).map((e, i) => validateEngine(e, `${path}.engines[${i}]`));
  if (!Array.isArray(v.fuels)) fail(`${path}.fuels`, 'expected an array');
  const fuels = (v.fuels as unknown[]).map((f, i) => oneOf(f, `${path}.fuels[${i}]`, CATALOGUE_FUELS));
  if (!Array.isArray(v.transmissions) || !v.transmissions.length) fail(`${path}.transmissions`, 'must be a non-empty array');
  const transmissions = (v.transmissions as unknown[]).map((t, i) => oneOf(t, `${path}.transmissions[${i}]`, CATALOGUE_TRANSMISSIONS)) as CatalogueTransmission[];
  const g: CatalogueGeneration = { name: str(v.name, `${path}.name`), from, to, bodies, trims, engines, fuels, transmissions };
  const id = optStr(v.id, `${path}.id`);
  if (id) {
    if (!CATALOGUE_SLUG.test(id)) fail(`${path}.id`, `id must match ${CATALOGUE_SLUG}`);
    g.id = id;
  }
  const gg = gta(v.gtaGroup, `${path}.gtaGroup`);
  if (gg) g.gtaGroup = gg;
  const note = optStr(v.note, `${path}.note`);
  if (note) g.note = note;
  return g;
}

/** Validate a raw make file (§D.2). Throws KbValidationError naming `file` and the JSON path. */
export function validateCatalogueMake(raw: unknown, file: string, opts: ValidateCatalogueOptions = {}): CatalogueMakeFile {
  const previous = qualityMode;
  qualityMode = { strict: opts.strict ?? true, warnings: opts.warnings ?? [] };
  try {
    return validateMakeInner(raw, file);
  } finally {
    qualityMode = previous;
  }
}

function validateMakeInner(raw: unknown, file: string): CatalogueMakeFile {
  if (!isRec(raw)) return fail(file, 'expected a make object');
  const make = str(raw.make, `${file}.make`);
  const slug = slugField(raw.slug, make, `${file}.slug`);
  const dvlaNames = strArr(raw.dvlaNames, `${file}.dvlaNames`);
  const aliases = strArr(raw.aliases, `${file}.aliases`);
  let verification: CatalogueMakeFile['verification'] = { status: 'unverified', sourceNote: DEFAULT_CATALOGUE_SOURCE_NOTE };
  if (raw.verification !== undefined) {
    if (!isRec(raw.verification)) fail(`${file}.verification`, 'expected an object');
    const v = raw.verification as Rec;
    if (v.status !== 'unverified') fail(`${file}.verification.status`, `catalogue data is always 'unverified' (got ${JSON.stringify(v.status)})`);
    verification = { status: 'unverified', sourceNote: optStr(v.sourceNote, `${file}.verification.sourceNote`) ?? DEFAULT_CATALOGUE_SOURCE_NOTE };
  }
  if (!Array.isArray(raw.models)) fail(`${file}.models`, 'expected an array');
  const seenSlugs = new Set<string>();
  const seenAliases = new Map<string, string>();
  const models: CatalogueModel[] = (raw.models as unknown[]).map((m, i) => {
    const p = `${file}.models[${i}]`;
    if (!isRec(m)) return fail(p, 'expected a model object');
    const name = str(m.name, `${p}.name`);
    const mslug = slugField(m.slug, name, `${p}.slug`);
    if (seenSlugs.has(mslug)) fail(`${p}.slug`, `duplicate model slug '${mslug}'`);
    seenSlugs.add(mslug);
    const maliases = strArr(m.aliases, `${p}.aliases`);
    for (const a of maliases) {
      const key = a.toLowerCase();
      const other = seenAliases.get(key);
      quality(!(other && other !== mslug), `${p}.aliases`, `alias '${a}' is also used by model '${other}'`);
      seenAliases.set(key, mslug);
    }
    const vehicleType = oneOf(m.vehicleType, `${p}.vehicleType`, CATALOGUE_VEHICLE_TYPES);
    const segment = oneOf(m.segment, `${p}.segment`, CATALOGUE_SEGMENTS) as CatalogueSegment;
    if (!isRec(m.years)) fail(`${p}.years`, 'expected { from, to }');
    const yrs = m.years as Rec;
    const years = { from: year(yrs.from, `${p}.years.from`), to: yearOrNull(yrs.to, `${p}.years.to`) };
    if (years.to !== null && years.to < years.from) fail(`${p}.years`, 'years.to is before years.from');
    if (!Array.isArray(m.generations) || !m.generations.length) fail(`${p}.generations`, 'must be a non-empty array');
    const generations = (m.generations as unknown[]).map((g, j) => validateGeneration(g, `${p}.generations[${j}]`, vehicleType, years));
    const model: CatalogueModel = { name, slug: mslug, aliases: maliases, vehicleType, segment, years, generations };
    const gg = gta(m.gtaGroup, `${p}.gtaGroup`);
    if (gg) model.gtaGroup = gg;
    return model;
  });
  return { make, slug, dvlaNames, aliases, verification, models };
}

// ---------------------------------------------------------------------------
// Normalisation (ids, parsed engines)
// ---------------------------------------------------------------------------

function uniqueId(base: string, seen: Set<string>): string {
  let id = base;
  for (let n = 2; seen.has(id); n += 1) id = `${base}-${n}`;
  seen.add(id);
  return id;
}

export function normaliseEngine(e: string | CatalogueEngine, seen: Set<string> = new Set()): NormalisedEngine {
  if (typeof e === 'string') {
    const parsed = parseEngineLabel(e);
    return { ...parsed, id: uniqueId(parsed.id, seen) };
  }
  const { fuel, mildHybrid } = catalogueFuelToDomain(e.fuel);
  let domainFuel = fuel;
  if (e.fuel === 'mild-hybrid' && /\bdiesel\b/i.test(e.label)) domainFuel = 'diesel';
  const out: NormalisedEngine = { ...e, id: uniqueId(slugify(e.label), seen), domainFuel };
  if (mildHybrid) out.mildHybrid = true;
  if (out.cc === undefined) {
    const l = /^(\d{1,2}\.\d)\b/.exec(e.label.trim());
    if (l) {
      out.cc = Math.round(Number(l[1]) * 1000);
      out.ccApprox = true;
    }
  }
  return out;
}

export function normaliseTrim(t: string | CatalogueTrim, seen: Set<string> = new Set()): NormalisedTrim {
  const trim: CatalogueTrim = typeof t === 'string' ? { name: t } : t;
  return { ...trim, id: uniqueId(slugify(trim.name), seen) };
}

export function normaliseGeneration(g: CatalogueGeneration, makeSlug: string, modelSlug: string, seenIds: Set<string> = new Set()): NormalisedGeneration {
  const trimIds = new Set<string>();
  const engineIds = new Set<string>();
  const { trims, engines, ...rest } = g;
  return {
    ...rest,
    id: uniqueId(g.id ?? `${makeSlug}-${modelSlug}-${slugify(g.name)}`, seenIds),
    trims: trims.map((t) => normaliseTrim(t, trimIds)),
    engines: engines.map((e) => normaliseEngine(e, engineIds)),
  };
}

export function normaliseModel(m: CatalogueModel, makeSlug: string): NormalisedModel {
  const seen = new Set<string>();
  const { generations, ...rest } = m;
  return { ...rest, makeSlug, generations: generations.map((g) => normaliseGeneration(g, makeSlug, m.slug, seen)) };
}

export function normaliseCatalogueMake(file: CatalogueMakeFile): NormalisedMake {
  const { models, ...rest } = file;
  return { ...rest, models: models.map((m) => normaliseModel(m, file.slug)) };
}

/** Union of bodies across generations, in first-seen order. */
export function bodiesOf(generations: ReadonlyArray<Pick<CatalogueGeneration, 'bodies'>>): CatalogueBody[] {
  const out: CatalogueBody[] = [];
  for (const g of generations) for (const b of g.bodies) if (!out.includes(b.body)) out.push(b.body);
  return out;
}
