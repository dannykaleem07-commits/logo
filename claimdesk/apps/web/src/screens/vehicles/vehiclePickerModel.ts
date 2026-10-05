/**
 * VehiclePicker state logic (pure; unit-tested) — docs/TEMPLATES-VEHICLES-DESKTOP.md §D.9, §D.10, §E.3–E.5.
 *
 * Everything the picker does to its value lives here so the React component only renders and calls these:
 *  - the Make → Year → Model → Generation → Body/doors → Fuel → Engine → Transmission → Trim cascade (changing a step
 *    clears the later ones; picking an engine sets cc, fuel and power; picking a trim sets the variant and pre-ticks
 *    the trim's standard features);
 *  - the options of each step, derived from a catalogue model detail (`NormalisedModel`);
 *  - applying a Total Car Check paste (`applyParsed`) and a vehicle already on file (`applyOnFile`);
 *  - the "Add to catalogue" body, and the API bodies (`toSpec`, `toVehicleInput`, `vehiclePatchFrom`).
 *
 * Catalogue data and anything copied from Total Car Check are unverified; the server records that. The client never
 * sends a verification.
 */
import type { FuelType, ISODate, OnFileMatch, ParsedVehicleCheck, Transmission, Vehicle, VehicleSourceInput, VehicleSpec } from '@ccguk/domain';
import { isValidUkRegistration, normaliseRegistration, PS_TO_BHP } from '@ccguk/domain';
import type { VehicleInput } from '../../api/client';
import {
  CATALOGUE_SEGMENTS,
  type CatalogueBody,
  type CatalogueFuel,
  type CatalogueMakeSummary,
  type CatalogueModelSummary,
  type CatalogueSegment,
  type CustomCatalogueBody,
  type CustomCatalogueLevel,
  type FeatureItem,
  type FeatureVocabulary,
  type NormalisedEngine,
  type NormalisedGeneration,
  type NormalisedModel,
  type NormalisedTrim,
  type VehiclePatchBody
} from '../../api/vehiclesApi';

export type { VehicleSourceInput };

// ---------------------------------------------------------------------------
// Value (normative, §D.9)
// ---------------------------------------------------------------------------

export interface VehiclePickerValue {
  registration: string;
  make: string;
  model: string;
  /** Trim name (Vehicle.variant). */
  variant: string;
  bodyType?: string;
  doors?: number;
  seats?: number;
  yearOfManufacture?: number;
  /** 'YYYY-MM'. */
  monthOfFirstRegistration?: string;
  fuelType?: FuelType;
  transmission?: Transmission;
  engineCapacityCc?: number;
  powerPs?: number;
  colour?: string;
  vin?: string;
  motExpiryDate?: string;
  taxDueDate?: string;
  catalogue?: VehicleSpec['catalogue'];
  segment?: string;
  features: string[];
  extras: string[];
  source: VehicleSourceInput;
}

export function emptyPickerValue(registration = ''): VehiclePickerValue {
  return { registration, make: '', model: '', variant: '', features: [], extras: [], source: { provider: 'manual' } };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const FUEL_LABEL: Record<FuelType, string> = {
  petrol: 'Petrol',
  diesel: 'Diesel',
  hybrid: 'Hybrid',
  plugin_hybrid: 'Plug-in hybrid',
  electric: 'Electric',
  lpg: 'LPG',
  other: 'Other'
};
export const FUEL_TYPES = Object.keys(FUEL_LABEL) as FuelType[];

export const TRANSMISSION_LABEL: Record<Transmission, string> = { manual: 'Manual', automatic: 'Automatic', unknown: 'Unknown' };

export const BODY_LABEL: Record<CatalogueBody, string> = {
  hatchback: 'Hatchback',
  saloon: 'Saloon',
  estate: 'Estate',
  coupe: 'Coupé',
  convertible: 'Convertible',
  suv: 'SUV',
  crossover: 'Crossover',
  mpv: 'MPV',
  pickup: 'Pick-up',
  'panel-van': 'Panel van',
  'crew-van': 'Crew van',
  'chassis-cab': 'Chassis cab',
  minibus: 'Minibus',
  roadster: 'Roadster',
  fastback: 'Fastback',
  liftback: 'Liftback',
  'shooting-brake': 'Shooting brake',
  camper: 'Camper'
};

export const SOURCE_LABEL: Record<VehicleSourceInput['provider'], string> = {
  manual: 'Typed by hand',
  catalogue: 'Vehicle catalogue (ClaimDesk)',
  totalcarcheck_manual: 'Total Car Check (copied by hand)'
};

/** Option value that switches a step to free text. */
export const NOT_LISTED = '__not_listed__';
export const NOT_LISTED_LABEL = 'Not listed — type it';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const has = (s: string | undefined | null): s is string => typeof s === 'string' && s.trim().length > 0;

/** Lower-case, accents stripped, punctuation to spaces: 'Citroën' ≡ 'CITROEN', 'Mercedes-Benz' ≡ 'mercedes benz'. */
export function matchKey(text: string | undefined | null): string {
  return (text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function uniq<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

function inYears(year: number | undefined, from: number | undefined, to: number | null | undefined): boolean {
  if (year === undefined) return true;
  if (from !== undefined && year < from) return false;
  if (to !== undefined && to !== null && year > to) return false;
  return true;
}

/** Catalogue fuel → domain fuel. Mild hybrids are their base fuel (the engine's `domainFuel` says which). */
export function catalogueFuelToDomain(f: CatalogueFuel): FuelType | undefined {
  switch (f) {
    case 'plug-in-hybrid':
      return 'plugin_hybrid';
    case 'hydrogen':
      return 'other';
    case 'mild-hybrid':
      return undefined;
    default:
      return f;
  }
}

/** Domain fuel → catalogue fuel (for an engine added to the catalogue). */
export function domainFuelToCatalogue(f: FuelType | undefined): CatalogueFuel {
  switch (f) {
    case 'plugin_hybrid':
      return 'plug-in-hybrid';
    case 'other':
    case undefined:
      return 'petrol';
    default:
      return f;
  }
}

/** Catalogue body slug for a stored body type ('Panel van', 'panel-van', 'HATCHBACK'). */
export function bodySlugOf(bodyType: string | undefined): CatalogueBody | undefined {
  const k = matchKey(bodyType);
  if (!k) return undefined;
  for (const [slug, label] of Object.entries(BODY_LABEL) as Array<[CatalogueBody, string]>) {
    if (matchKey(slug) === k || matchKey(label) === k) return slug;
  }
  return undefined;
}

export function isSegment(s: string | undefined): s is CatalogueSegment {
  return typeof s === 'string' && (CATALOGUE_SEGMENTS as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// Make / model resolution (type-ahead with <datalist>)
// ---------------------------------------------------------------------------

/** The catalogue make a typed or DVLA-printed name refers to (name, slug, DVLA spelling or alias). */
export function findMake(makes: readonly CatalogueMakeSummary[] | undefined, text: string): CatalogueMakeSummary | undefined {
  const k = matchKey(text);
  if (!k || !makes) return undefined;
  return makes.find((m) => matchKey(m.make) === k || matchKey(m.slug) === k || m.dvlaNames.some((d) => matchKey(d) === k) || m.aliases.some((a) => matchKey(a) === k));
}

/** The catalogue model a typed name refers to, within the make's model list. */
export function findModel(models: readonly CatalogueModelSummary[] | undefined, text: string): CatalogueModelSummary | undefined {
  const k = matchKey(text);
  if (!k || !models) return undefined;
  return models.find((m) => matchKey(m.name) === k || matchKey(m.slug) === k);
}

/**
 * Link a vehicle saved without catalogue ids (seeded, older records, DVLA upper case "FORD" / "FOCUS", a TCC model
 * string "GOLF MATCH EDITION TSI") to the catalogue, so the generation, body, engine and trim lists appear. An exact
 * name keeps the text as stored; otherwise the longest catalogue model name that starts the text (whole words) is the
 * model and the rest becomes the variant when none is set. Nothing else changes (year, fuel, gearbox, engine size,
 * colour stay). Returns the same object when there is nothing to link.
 */
export function linkToCatalogue(v: VehiclePickerValue, make: CatalogueMakeSummary | undefined, models: readonly CatalogueModelSummary[] | undefined): VehiclePickerValue {
  if (v.catalogue?.modelSlug || !make || !models?.length || !has(v.model)) return v;
  let hit = findModel(models, v.model);
  let remainder = '';
  if (!hit) {
    const k = matchKey(v.model);
    const candidates = models
      .filter((m) => {
        const mk = matchKey(m.name);
        return mk.length > 0 && k.startsWith(`${mk} `);
      })
      .sort((a, b) => matchKey(b.name).length - matchKey(a.name).length);
    hit = candidates[0];
    if (!hit) return v;
    // the words of the stored text after the model name ("C-HR ICON" → "ICON")
    const words = v.model.trim().split(/\s+/);
    let used = 0;
    while (used < words.length && matchKey(words.slice(0, used + 1).join(' ')).length <= matchKey(hit.name).length) used += 1;
    remainder = words.slice(used).join(' ');
  }
  const next: VehiclePickerValue = {
    ...v,
    model: remainder ? hit.name : v.model,
    variant: has(v.variant) ? v.variant : remainder,
    catalogue: { makeSlug: make.slug, modelSlug: hit.slug, ...(hit.custom ? { custom: true } : {}) },
    segment: v.segment ?? hit.segment
  };
  return syncSource(next);
}

/** The make slug for the current value: the catalogue pick, else the typed make resolved against the make list. */
export function makeSlugOf(v: Pick<VehiclePickerValue, 'make' | 'catalogue'>, makes?: readonly CatalogueMakeSummary[]): string | undefined {
  return v.catalogue?.makeSlug || findMake(makes, v.make)?.slug;
}

// ---------------------------------------------------------------------------
// Cascade
// ---------------------------------------------------------------------------

export type CascadeStep = 'make' | 'year' | 'model' | 'generation' | 'body' | 'fuel' | 'engine' | 'transmission' | 'trim';
export const CASCADE_STEPS: readonly CascadeStep[] = ['make', 'year', 'model', 'generation', 'body', 'fuel', 'engine', 'transmission', 'trim'];
export const CASCADE_LABEL: Record<CascadeStep, string> = {
  make: 'Make',
  year: 'Year of manufacture',
  model: 'Model',
  generation: 'Generation',
  body: 'Body and doors',
  fuel: 'Fuel',
  engine: 'Engine',
  transmission: 'Transmission',
  trim: 'Trim'
};

function findGeneration(model: NormalisedModel | undefined, id: string | undefined): NormalisedGeneration | undefined {
  if (!model || !id) return undefined;
  return model.generations.find((g) => g.id === id);
}

function findTrim(model: NormalisedModel | undefined, generationId: string | undefined, trimId: string | undefined): NormalisedTrim | undefined {
  if (!trimId) return undefined;
  return findGeneration(model, generationId)?.trims.find((t) => t.id === trimId);
}

function findEngine(model: NormalisedModel | undefined, generationId: string | undefined, engineId: string | undefined): NormalisedEngine | undefined {
  if (!engineId) return undefined;
  return findGeneration(model, generationId)?.engines.find((e) => e.id === engineId);
}

/** Catalogue ids without empty members (the API schema rejects empty strings). */
function cleanCatalogue(c: VehicleSpec['catalogue'] | undefined): VehicleSpec['catalogue'] | undefined {
  if (!c || !has(c.makeSlug) || !has(c.modelSlug)) return undefined;
  const out: NonNullable<VehicleSpec['catalogue']> = { makeSlug: c.makeSlug, modelSlug: c.modelSlug };
  if (has(c.generationId)) out.generationId = c.generationId;
  if (has(c.trimId)) out.trimId = c.trimId;
  if (has(c.engineId)) out.engineId = c.engineId;
  if (c.custom) out.custom = true;
  return out;
}

function withCatalogue(v: VehiclePickerValue, patch: Partial<NonNullable<VehicleSpec['catalogue']>> | null): VehiclePickerValue {
  if (patch === null) return { ...v, catalogue: undefined };
  const merged = cleanCatalogue({ ...(v.catalogue ?? { makeSlug: '', modelSlug: '' }), ...patch } as NonNullable<VehicleSpec['catalogue']>);
  return { ...v, catalogue: merged };
}

/** Remove the standard features a trim pre-ticked (extras and anything ticked by hand that the trim does not list stay). */
function dropTrimFeatures(v: VehiclePickerValue, trim: NormalisedTrim | undefined): VehiclePickerValue {
  if (!trim?.features?.length) return v;
  const drop = new Set(trim.features);
  return { ...v, features: v.features.filter((f) => !drop.has(f)) };
}

/** Keep `source.provider` in step with the value: a paste stays a paste; otherwise catalogue ids mean 'catalogue'. */
export function syncSource(v: VehiclePickerValue): VehiclePickerValue {
  if (v.source.provider === 'totalcarcheck_manual') return v;
  const provider: VehicleSourceInput['provider'] = cleanCatalogue(v.catalogue) ? 'catalogue' : 'manual';
  return provider === v.source.provider ? v : { ...v, source: { ...v.source, provider } };
}

/**
 * Clear the steps after `step` (the step itself is kept). Up to the model, everything later is cleared (another
 * vehicle). From the generation on, `model` (the current catalogue detail) decides: a later value that still fits the
 * new choice is kept — a pasted fuel, gearbox or engine size survives picking the body — and only what no longer fits
 * is cleared. `prev` is the value before the change, so a cleared trim takes back the standard features it pre-ticked.
 */
export function clearAfter(v: VehiclePickerValue, step: CascadeStep, model?: NormalisedModel, prev: VehiclePickerValue = v): VehiclePickerValue {
  const idx = CASCADE_STEPS.indexOf(step);
  const later = (s: CascadeStep) => CASCADE_STEPS.indexOf(s) > idx;
  const keepFitting = Boolean(model) && idx >= CASCADE_STEPS.indexOf('generation');
  let next: VehiclePickerValue = { ...v };
  if (later('year')) next.yearOfManufacture = undefined;
  if (later('model')) {
    next.model = '';
    next.segment = undefined;
    next.catalogue = undefined;
  }
  if (later('generation') && next.catalogue) next = withCatalogue(next, { generationId: undefined });
  const gen = keepFitting ? findGeneration(model, next.catalogue?.generationId) : undefined;
  /** Kept when the step's options (for the new choice) include it, or there is no list to check against. */
  const fits = (opts: PickerOption[], value: string | undefined): boolean => keepFitting && has(value) && (opts.length === 0 || opts.some((o) => o.value === value));
  const year = next.yearOfManufacture;

  if (later('body') && !fits(bodyOptions(model, gen?.id), next.bodyType ? bodyOptionValue(next) || next.bodyType : undefined)) {
    next.bodyType = undefined;
    next.doors = undefined;
    next.seats = undefined;
  }
  if (later('fuel') && !fits(fuelOptions(model, gen?.id, year), next.fuelType)) next.fuelType = undefined;
  // engine and trim ids belong to one generation: a different generation never keeps them (plain values may stay)
  const sameGeneration = prev.catalogue?.generationId === next.catalogue?.generationId;
  if (later('engine')) {
    const engineId = next.catalogue?.engineId;
    const engine = gen && engineId && sameGeneration ? gen.engines.find((e) => e.id === engineId) : undefined;
    const engineFits = Boolean(engine && fits(engineOptions(model, gen!.id, { fuel: next.fuelType, year }), engineId));
    if (!engineFits) {
      if (next.catalogue?.engineId) next = withCatalogue(next, { engineId: undefined });
      // a typed or pasted capacity stays while an engine of that size (±60 cc) is still on offer
      const cc = next.engineCapacityCc;
      const ccFits = keepFitting && cc !== undefined && (!gen || enginesFor(gen, year).some((e) => e.cc !== undefined && Math.abs(e.cc - cc) <= 60 && (!next.fuelType || e.domainFuel === next.fuelType)));
      if (!ccFits || engineId) {
        next.engineCapacityCc = undefined;
        next.powerPs = undefined;
      }
    }
  }
  if (later('transmission') && !fits(transmissionOptions(model, gen?.id, next.catalogue?.engineId), next.transmission)) next.transmission = undefined;
  if (later('trim')) {
    const trimId = next.catalogue?.trimId;
    const trimFits = Boolean(gen && trimId && sameGeneration && fits(trimOptions(model, gen.id, { bodyType: next.bodyType, engineId: next.catalogue?.engineId, year }), trimId));
    if (!trimFits) {
      const oldTrim = findTrim(model, prev.catalogue?.generationId, prev.catalogue?.trimId);
      next = dropTrimFeatures(next, oldTrim);
      if (next.catalogue?.trimId) next = withCatalogue(next, { trimId: undefined });
      // a variant typed or pasted by hand (no catalogue trim) stays; the name of a trim that no longer fits goes
      if (!keepFitting || trimId || (oldTrim && matchKey(oldTrim.name) === matchKey(next.variant))) next.variant = '';
    }
  }
  return syncSource(next);
}

/** Make chosen (from the list: pass its slug) or typed. Same make again → unchanged. */
export function setMake(v: VehiclePickerValue, make: string): VehiclePickerValue {
  if (matchKey(make) === matchKey(v.make) && make.trim() === v.make.trim()) return v;
  const sameMake = matchKey(make) === matchKey(v.make);
  const next = { ...v, make };
  // Re-typing the same make in another case keeps the later steps.
  return sameMake ? syncSource(next) : clearAfter({ ...next, catalogue: undefined }, 'make');
}

export function setYear(v: VehiclePickerValue, year: number | undefined, model?: NormalisedModel): VehiclePickerValue {
  if (year === v.yearOfManufacture) return v;
  return clearAfter({ ...v, yearOfManufacture: year }, 'year', model);
}

/**
 * Model chosen from the catalogue (pass the summary and the make slug) or typed (pass a name only). Sets the segment
 * from the catalogue; a typed model keeps a segment only when one is given (e.g. chosen for the GTA suggestion).
 */
export function setModel(v: VehiclePickerValue, model: string | CatalogueModelSummary, makeSlug?: string, current?: NormalisedModel): VehiclePickerValue {
  const name = typeof model === 'string' ? model : model.name;
  const slug = typeof model === 'string' ? undefined : model.slug;
  if (name === v.model && (slug ?? undefined) === (v.catalogue?.modelSlug ?? undefined)) return v;
  let next = clearAfter({ ...v, model: name }, 'model', current);
  if (slug && makeSlug) {
    next = withCatalogue(next, { makeSlug, modelSlug: slug, ...(typeof model !== 'string' && model.custom ? { custom: true } : {}) });
    if (typeof model !== 'string') next.segment = model.segment;
  } else {
    // A typed model keeps a segment the user chose for it, not the one of a catalogue model it replaces.
    next = { ...next, catalogue: undefined, segment: v.catalogue?.modelSlug ? undefined : next.segment };
  }
  return syncSource(next);
}

export function setSegment(v: VehiclePickerValue, segment: string | undefined): VehiclePickerValue {
  return { ...v, segment: segment || undefined };
}

export function setGeneration(v: VehiclePickerValue, generationId: string | undefined, model?: NormalisedModel): VehiclePickerValue {
  if ((generationId || undefined) === v.catalogue?.generationId) return v;
  if (!v.catalogue) return clearAfter(v, 'generation', model);
  return clearAfter(withCatalogue(v, { generationId: generationId || undefined }), 'generation', model, v);
}

/** Body chosen from an option value `body|doors` (see bodyOptions) or typed. Seats follow when the generation has one count. */
export function setBody(v: VehiclePickerValue, body: { bodyType?: string; doors?: number; seats?: number }, model?: NormalisedModel): VehiclePickerValue {
  const withBody: VehiclePickerValue = { ...v, bodyType: body.bodyType || undefined, doors: body.doors, seats: body.seats ?? (body.bodyType ? seatsFor(model, v.catalogue?.generationId, bodySlugOf(body.bodyType)) : undefined) };
  return clearAfter(withBody, 'body', model, v);
}

export function setFuel(v: VehiclePickerValue, fuel: FuelType | undefined, model?: NormalisedModel): VehiclePickerValue {
  if (fuel === v.fuelType) return v;
  return clearAfter({ ...v, fuelType: fuel }, 'fuel', model, v);
}

/** Picking a catalogue engine sets engineCapacityCc, fuelType and powerPs. */
export function setEngine(v: VehiclePickerValue, engineId: string | undefined, model?: NormalisedModel): VehiclePickerValue {
  const engine = findEngine(model, v.catalogue?.generationId, engineId);
  if (!engine) {
    const cleared = v.catalogue?.engineId ? withCatalogue(v, { engineId: undefined }) : v;
    return clearAfter(cleared, 'engine', model, v);
  }
  let next: VehiclePickerValue = v.catalogue ? withCatalogue(v, { engineId: engine.id }) : { ...v };
  const power = engine.powerPs ?? (engine.powerKw ? Math.round(engine.powerKw * 1.35962) : undefined);
  // The catalogue's capacity is nominal: a capacity already read from the vehicle's own record (1,498 cc for a
  // "1.5") is kept while it is within 60 cc of it, the same tolerance used to match a pasted engine.
  const keepCc = v.engineCapacityCc !== undefined && engine.cc !== undefined && Math.abs(v.engineCapacityCc - engine.cc) <= 60 && !v.catalogue?.engineId;
  next = { ...next, engineCapacityCc: keepCc ? v.engineCapacityCc : (engine.cc ?? next.engineCapacityCc), fuelType: engine.domainFuel, powerPs: power ?? (keepCc ? v.powerPs : undefined) };
  return clearAfter(next, 'engine', model, v);
}

/** "Not listed" engine: capacity and power typed by hand. */
export function setEngineFree(v: VehiclePickerValue, e: { engineCapacityCc?: number; powerPs?: number }, model?: NormalisedModel): VehiclePickerValue {
  const next = v.catalogue?.engineId ? clearAfter(v, 'engine', model) : v;
  return { ...next, engineCapacityCc: e.engineCapacityCc, powerPs: e.powerPs };
}

export function setTransmission(v: VehiclePickerValue, t: Transmission | undefined, model?: NormalisedModel): VehiclePickerValue {
  if (t === v.transmission) return v;
  return clearAfter({ ...v, transmission: t }, 'transmission', model, v);
}

/** Picking a trim sets the variant and pre-ticks the trim's standard features (the previous trim's are taken back). */
export function setTrim(v: VehiclePickerValue, trimId: string | undefined, model?: NormalisedModel): VehiclePickerValue {
  const prev = findTrim(model, v.catalogue?.generationId, v.catalogue?.trimId);
  const trim = findTrim(model, v.catalogue?.generationId, trimId);
  let next = dropTrimFeatures(v, prev);
  if (!trim) {
    next = next.catalogue ? withCatalogue(next, { trimId: undefined }) : next;
    return syncSource({ ...next, variant: '' });
  }
  next = next.catalogue ? withCatalogue(next, { trimId: trim.id }) : next;
  return syncSource({ ...next, variant: trim.name, features: uniq([...next.features, ...(trim.features ?? [])]) });
}

/** "Not listed" trim: the variant is typed; any catalogue trim (and its pre-ticked features) is dropped. */
export function setTrimFree(v: VehiclePickerValue, variant: string, model?: NormalisedModel): VehiclePickerValue {
  const prev = findTrim(model, v.catalogue?.generationId, v.catalogue?.trimId);
  let next = dropTrimFeatures(v, prev);
  if (next.catalogue?.trimId) next = withCatalogue(next, { trimId: undefined });
  return syncSource({ ...next, variant });
}

// ---------------------------------------------------------------------------
// Options from a NormalisedModel
// ---------------------------------------------------------------------------

export interface PickerOption {
  value: string;
  label: string;
}

/** Years for the year step: the make's UK sale years when known, newest first. */
export function yearOptions(make: CatalogueMakeSummary | undefined, today: ISODate, current?: number): PickerOption[] {
  const thisYear = Number(today.slice(0, 4));
  const from = make ? Math.max(1990, Math.min(make.years.from, thisYear)) : 1990;
  const to = make?.years.to ? Math.min(make.years.to, thisYear) : thisYear;
  const years: number[] = [];
  for (let y = to; y >= from; y -= 1) years.push(y);
  if (current !== undefined && !years.includes(current)) years.push(current);
  return years.sort((a, b) => b - a).map((y) => ({ value: String(y), label: String(y) }));
}

function yearRangeLabel(from: number, to: number | null): string {
  return `${from}–${to ?? 'now'}`;
}

/** Generations on sale in `year` (all of them when no year is set or none matches). */
export function generationOptions(model: NormalisedModel | undefined, year?: number): PickerOption[] {
  if (!model) return [];
  const forYear = model.generations.filter((g) => inYears(year, g.from, g.to));
  const list = forYear.length ? forYear : model.generations;
  return list.map((g) => ({ value: g.id, label: /\d{4}/.test(g.name) ? g.name : `${g.name} (${yearRangeLabel(g.from, g.to)})` }));
}

/** One option per body and door count: value `body|doors`. */
export function bodyOptions(model: NormalisedModel | undefined, generationId: string | undefined): PickerOption[] {
  const gen = findGeneration(model, generationId);
  if (!gen) return [];
  const out: PickerOption[] = [];
  for (const b of gen.bodies) {
    const label = BODY_LABEL[b.body] ?? b.body;
    if (!b.doors.length) out.push({ value: `${b.body}|`, label });
    for (const d of b.doors) out.push({ value: `${b.body}|${d}`, label: `${label}, ${d} doors` });
  }
  return out;
}

/** `body|doors` option value → the picker's body fields (the label is what is stored as bodyType). */
export function parseBodyOption(value: string): { bodyType?: string; doors?: number } {
  const [body, doors] = value.split('|');
  const slug = body as CatalogueBody;
  const bodyType = body ? (BODY_LABEL[slug] ?? body) : undefined;
  const d = doors ? Number(doors) : NaN;
  return { bodyType, doors: Number.isInteger(d) && d > 0 ? d : undefined };
}

/** The option value matching the current body fields (so the Select shows the choice). */
export function bodyOptionValue(v: Pick<VehiclePickerValue, 'bodyType' | 'doors'>): string {
  const slug = bodySlugOf(v.bodyType);
  if (!slug) return '';
  return `${slug}|${v.doors ?? ''}`;
}

/** Seat count when the generation lists exactly one for the body. */
export function seatsFor(model: NormalisedModel | undefined, generationId: string | undefined, body: CatalogueBody | undefined): number | undefined {
  const gen = findGeneration(model, generationId);
  if (!gen || !body) return undefined;
  const seats = uniq(gen.bodies.filter((b) => b.body === body).flatMap((b) => b.seats));
  return seats.length === 1 ? seats[0] : undefined;
}

function enginesFor(gen: NormalisedGeneration, year?: number): NormalisedEngine[] {
  return gen.engines.filter((e) => inYears(year, e.from, e.to));
}

/** Domain fuels of the generation's engines (on sale in `year` when given). */
export function fuelOptions(model: NormalisedModel | undefined, generationId: string | undefined, year?: number): PickerOption[] {
  const gen = findGeneration(model, generationId);
  if (!gen) return [];
  let fuels = uniq(enginesFor(gen, year).map((e) => e.domainFuel));
  if (!fuels.length) fuels = uniq(gen.fuels.map(catalogueFuelToDomain).filter((f): f is FuelType => Boolean(f)));
  return FUEL_TYPES.filter((f) => fuels.includes(f)).map((f) => ({ value: f, label: FUEL_LABEL[f] }));
}

/** Engines of the generation for the fuel (and year) chosen. */
export function engineOptions(model: NormalisedModel | undefined, generationId: string | undefined, opts: { fuel?: FuelType; year?: number } = {}): PickerOption[] {
  const gen = findGeneration(model, generationId);
  if (!gen) return [];
  return enginesFor(gen, opts.year)
    .filter((e) => !opts.fuel || e.domainFuel === opts.fuel)
    .map((e) => ({ value: e.id, label: e.ccApprox || !e.cc ? e.label : `${e.label} (${e.cc.toLocaleString('en-GB')} cc)` }));
}

/** The engine's own transmissions, else the generation's. */
export function transmissionOptions(model: NormalisedModel | undefined, generationId: string | undefined, engineId?: string): PickerOption[] {
  const gen = findGeneration(model, generationId);
  if (!gen) return [];
  const engine = engineId ? gen.engines.find((e) => e.id === engineId) : undefined;
  const list = uniq(engine?.transmissions?.length ? engine.transmissions : gen.transmissions);
  return (['manual', 'automatic'] as const).filter((t) => list.includes(t)).map((t) => ({ value: t, label: TRANSMISSION_LABEL[t] }));
}

/** Trims of the generation, narrowed by body, engine and year when the trim says which it was sold with. */
export function trimOptions(model: NormalisedModel | undefined, generationId: string | undefined, opts: { bodyType?: string; engineId?: string; year?: number } = {}): PickerOption[] {
  const gen = findGeneration(model, generationId);
  if (!gen) return [];
  const body = bodySlugOf(opts.bodyType);
  const engine = opts.engineId ? gen.engines.find((e) => e.id === opts.engineId) : undefined;
  const engineKeys = engine ? new Set([matchKey(engine.label), matchKey(engine.id)]) : undefined;
  return gen.trims
    .filter((t) => !body || !t.bodies?.length || t.bodies.includes(body))
    .filter((t) => !engineKeys || !t.engines?.length || t.engines.some((e) => engineKeys.has(matchKey(e))))
    .filter((t) => inYears(opts.year, t.from, t.to))
    .map((t) => ({ value: t.id, label: t.name }));
}

/**
 * The trim a DVLA/TCC model string names, e.g. "Match Edition TSI EVO S-A" → Match Edition, "1.0 EcoBoost Zetec" →
 * Zetec: the longest trim name found as whole words in the text, preferring one at the start. Two different trims of
 * the same length → none (never guessed).
 */
export function trimInVariant(gen: NormalisedGeneration, variant: string): NormalisedTrim | undefined {
  const k = ` ${matchKey(variant)} `;
  if (k.trim() === '') return undefined;
  const hits = gen.trims
    .map((t) => ({ t, key: matchKey(t.name) }))
    .filter((x) => x.key.length > 0 && k.includes(` ${x.key} `))
    .sort((a, b) => b.key.length - a.key.length || Number(!k.startsWith(` ${a.key} `)) - Number(!k.startsWith(` ${b.key} `)));
  if (!hits.length) return undefined;
  const best = hits[0]!;
  const tie = hits.find((h) => h !== best && h.key.length === best.key.length && h.key !== best.key);
  if (tie && k.startsWith(` ${best.key} `) === k.startsWith(` ${tie.key} `)) return undefined;
  return best.t;
}

/**
 * Fill catalogue ids the value implies but does not hold yet, once the model detail is loaded (after a paste or an
 * on-file pick): the segment, the generation when exactly one matches the year, the trim named by the variant and
 * the engine matching the capacity, fuel and power. Conservative: nothing is guessed when two candidates fit.
 * Returns the same object when nothing changes (safe in an effect).
 */
export function resolveFromModel(v: VehiclePickerValue, model: NormalisedModel | undefined): VehiclePickerValue {
  if (!model || !v.catalogue || v.catalogue.modelSlug !== model.slug) return v;
  let next = v;
  let changed = false;
  if (!next.segment && model.segment) {
    next = { ...next, segment: model.segment };
    changed = true;
  }
  let generationId = next.catalogue?.generationId;
  if (!generationId && next.yearOfManufacture !== undefined) {
    const gens = model.generations.filter((g) => inYears(next.yearOfManufacture, g.from, g.to));
    if (gens.length === 1) generationId = gens[0]!.id;
  }
  if (!generationId && model.generations.length === 1) generationId = model.generations[0]!.id;
  const gen = findGeneration(model, generationId);
  if (gen && generationId !== next.catalogue?.generationId) {
    next = withCatalogue(next, { generationId });
    changed = true;
  }
  if (gen && !next.catalogue?.trimId && has(next.variant)) {
    const exact = gen.trims.find((t) => matchKey(t.name) === matchKey(next.variant));
    const trim = exact ?? trimInVariant(gen, next.variant);
    if (trim) {
      next = withCatalogue(next, { trimId: trim.id });
      // an exact name is the trim; a longer DVLA/TCC string ("Match Edition TSI EVO S-A") is kept as the variant
      next = { ...next, variant: exact ? trim.name : next.variant, features: uniq([...next.features, ...(trim.features ?? [])]) };
      changed = true;
    }
  }
  if (gen && !next.catalogue?.engineId && next.engineCapacityCc) {
    const cc = next.engineCapacityCc;
    const candidates = gen.engines.filter(
      (e) => e.cc !== undefined && Math.abs(e.cc - cc) <= 60 && (!next.fuelType || e.domainFuel === next.fuelType) && (!next.powerPs || !e.powerPs || Math.abs(e.powerPs - next.powerPs) <= 5)
    );
    if (candidates.length === 1) {
      const e = candidates[0]!;
      next = withCatalogue(next, { engineId: e.id });
      next = { ...next, powerPs: next.powerPs ?? e.powerPs, fuelType: next.fuelType ?? e.domainFuel };
      changed = true;
    }
  }
  return changed ? syncSource(next) : v;
}

// ---------------------------------------------------------------------------
// Total Car Check paste (§E.3)
// ---------------------------------------------------------------------------

type ParsedFields = ParsedVehicleCheck['fields'];
export type ParsedField = keyof ParsedFields;

/** Display order and labels of the parsed fields. */
export const PARSED_FIELD_LABEL: Record<ParsedField, string> = {
  registration: 'Registration',
  make: 'Make',
  model: 'Model',
  colour: 'Colour',
  bodyType: 'Body type',
  doors: 'Doors',
  seats: 'Seats',
  yearOfManufacture: 'Year of manufacture',
  monthOfFirstRegistration: 'First registered (month)',
  firstRegisteredDate: 'First registered',
  engineCapacityCc: 'Engine size',
  fuelType: 'Fuel',
  transmission: 'Transmission',
  powerBhp: 'Power',
  co2Gkm: 'CO₂ emissions',
  euroStatus: 'Euro status',
  vin: 'VIN',
  motStatus: 'MOT status',
  motExpiryDate: 'MOT expiry',
  taxStatus: 'Tax status',
  taxDueDate: 'Tax due',
  lastMotMileage: 'Last MOT mileage',
  lastMotDate: 'Last MOT date'
};

/** Parsed fields that are saved on the vehicle (the rest are shown for checking only). */
export const APPLICABLE_PARSED_FIELDS: readonly ParsedField[] = [
  'make',
  'model',
  'colour',
  'bodyType',
  'doors',
  'seats',
  'yearOfManufacture',
  'monthOfFirstRegistration',
  'engineCapacityCc',
  'fuelType',
  'transmission',
  'powerBhp',
  'vin',
  'motExpiryDate',
  'taxDueDate',
  'co2Gkm',
  'euroStatus',
  'motStatus',
  'taxStatus'
];

/** Saved on the vehicle record but not shown in the picker (sent from `source.parsed`). */
const RECORD_ONLY_FIELDS = ['co2Gkm', 'euroStatus', 'motStatus', 'taxStatus'] as const;

export interface ParsedRow {
  field: ParsedField;
  label: string;
  value: string;
  raw?: string;
  /** False for fields shown for checking only (registration, last MOT …). */
  applicable: boolean;
}

function displayParsed(field: ParsedField, value: unknown): string {
  if (value === undefined || value === null) return '';
  switch (field) {
    case 'engineCapacityCc':
      return `${Number(value).toLocaleString('en-GB')} cc`;
    case 'powerBhp':
      return `${value} bhp (${Math.round(Number(value) / PS_TO_BHP)} PS)`;
    case 'co2Gkm':
      return `${value} g/km`;
    case 'lastMotMileage':
      return `${Number(value).toLocaleString('en-GB')} miles`;
    case 'fuelType':
      return FUEL_LABEL[value as FuelType] ?? String(value);
    case 'transmission':
      return TRANSMISSION_LABEL[value as Transmission] ?? String(value);
    default:
      return String(value);
  }
}

/** Rows for the "parsed fields" table, in a fixed order, with the line the parser read each from. */
export function parsedRows(parsed: ParsedVehicleCheck): ParsedRow[] {
  const raws = new Map(parsed.matches.map((m) => [m.field, m.raw] as const));
  return (Object.keys(PARSED_FIELD_LABEL) as ParsedField[])
    .filter((f) => parsed.fields[f] !== undefined)
    .map((f) => {
      const row: ParsedRow = { field: f, label: PARSED_FIELD_LABEL[f], value: displayParsed(f, parsed.fields[f]), applicable: APPLICABLE_PARSED_FIELDS.includes(f) };
      const raw = raws.get(f);
      if (raw !== undefined) row.raw = raw;
      return row;
    });
}

/** Ticked by default: every applicable field the paste supplied. */
export function defaultParsedSelection(parsed: ParsedVehicleCheck): ParsedField[] {
  return parsedRows(parsed)
    .filter((r) => r.applicable)
    .map((r) => r.field);
}

/** What GET /catalogue/match said about the pasted make/model, plus display names the caller resolved. */
export interface ParsedCatalogueMatch {
  makeSlug?: string;
  modelSlug?: string;
  variantRemainder?: string;
  /** Catalogue display name of the make ('Volkswagen' for a pasted 'VOLKSWAGEN'). */
  makeName?: string;
  /** Catalogue display name of the model. */
  modelName?: string;
}

export interface ApplyParsedOptions {
  /** Fields the user ticked (default: all applicable). */
  selected?: readonly string[];
  match?: ParsedCatalogueMatch;
  /** The Total Car Check page the details were copied from. */
  url?: string;
  pastedText?: string;
}

/** 'Fiesta Zetec' with remainder 'Zetec' → 'Fiesta'. */
export function modelWithoutRemainder(model: string, remainder: string | undefined): string {
  if (!remainder) return model.trim();
  const m = model.trim();
  if (m.toLowerCase().endsWith(remainder.trim().toLowerCase())) return m.slice(0, m.length - remainder.trim().length).trim() || m;
  return m;
}

/**
 * Apply the ticked fields of a parsed paste to the value. Make/model are split into model + trim with the catalogue
 * match when given. The source becomes `totalcarcheck_manual` with the URL, the pasted text, the parsed fields and the
 * list of picker fields applied (the server stores them on an unverified LookupRecord).
 */
export function applyParsed(v: VehiclePickerValue, parsed: ParsedVehicleCheck, opts: ApplyParsedOptions = {}): VehiclePickerValue {
  const f = parsed.fields;
  const selected = new Set(opts.selected ?? defaultParsedSelection(parsed));
  const on = (field: ParsedField) => selected.has(field) && f[field] !== undefined;
  const applied: string[] = [];
  let next: VehiclePickerValue = { ...v };
  const match = opts.match;

  const makeChanged = on('make') && matchKey(match?.makeName ?? f.make) !== matchKey(v.make);
  if (on('make')) {
    next.make = match?.makeName ?? f.make!;
    applied.push('make');
  }
  if (on('model')) {
    const remainder = match?.modelSlug ? match.variantRemainder : undefined;
    next.model = match?.modelName ?? modelWithoutRemainder(f.model!, remainder);
    applied.push('model');
    if (remainder) {
      next.variant = remainder.trim();
      applied.push('variant');
    }
  }
  const modelChanged = on('model') && (matchKey(next.model) !== matchKey(v.model) || (match?.modelSlug ?? undefined) !== (v.catalogue?.modelSlug ?? undefined));
  if (makeChanged || modelChanged) {
    // A different vehicle description: the catalogue pick restarts from the matched make/model.
    next.catalogue = match?.makeSlug && match.modelSlug && on('model') ? { makeSlug: match.makeSlug, modelSlug: match.modelSlug } : undefined;
    next.segment = undefined;
    if (!applied.includes('variant')) next.variant = '';
  } else if (match?.makeSlug && match.modelSlug && !next.catalogue) {
    next.catalogue = { makeSlug: match.makeSlug, modelSlug: match.modelSlug };
  }

  const simple: Array<[ParsedField, keyof VehiclePickerValue]> = [
    ['colour', 'colour'],
    ['bodyType', 'bodyType'],
    ['doors', 'doors'],
    ['seats', 'seats'],
    ['yearOfManufacture', 'yearOfManufacture'],
    ['engineCapacityCc', 'engineCapacityCc'],
    ['fuelType', 'fuelType'],
    ['transmission', 'transmission'],
    ['vin', 'vin'],
    ['motExpiryDate', 'motExpiryDate'],
    ['taxDueDate', 'taxDueDate']
  ];
  for (const [from, to] of simple) {
    if (!on(from)) continue;
    (next as unknown as Record<string, unknown>)[to] = f[from];
    applied.push(to);
  }
  if (on('monthOfFirstRegistration')) {
    next.monthOfFirstRegistration = f.monthOfFirstRegistration;
    applied.push('monthOfFirstRegistration');
  } else if (selected.has('monthOfFirstRegistration') && f.firstRegisteredDate) {
    next.monthOfFirstRegistration = f.firstRegisteredDate.slice(0, 7);
    applied.push('monthOfFirstRegistration');
  }
  if (on('powerBhp')) {
    next.powerPs = Math.round(f.powerBhp! / PS_TO_BHP);
    applied.push('powerPs');
  }
  // Engine/fuel/power from the paste replace a catalogue engine pick that no longer fits.
  if (next.catalogue?.engineId && (applied.includes('engineCapacityCc') || applied.includes('fuelType') || applied.includes('powerPs'))) {
    next = withCatalogue(next, { engineId: undefined });
  }
  for (const field of RECORD_ONLY_FIELDS) if (on(field)) applied.push(field);

  const parsedRecord: Record<string, unknown> = { ...f };
  const source: VehicleSourceInput = { provider: 'totalcarcheck_manual', parsed: parsedRecord, appliedFields: uniq(applied) };
  if (opts.url) source.url = opts.url;
  if (has(opts.pastedText)) source.pastedText = opts.pastedText;
  next.source = source;
  return next;
}

/** Vehicle-record fields from a paste that the picker does not show (CO₂, Euro status, MOT/tax status). */
export function parsedRecordFields(source: VehicleSourceInput): Pick<VehicleInput, 'co2Gkm' | 'euroStatus' | 'motStatus' | 'taxStatus'> {
  if (source.provider !== 'totalcarcheck_manual' || !source.parsed) return {};
  const applied = new Set(source.appliedFields ?? []);
  const p = source.parsed;
  const out: Pick<VehicleInput, 'co2Gkm' | 'euroStatus' | 'motStatus' | 'taxStatus'> = {};
  if (applied.has('co2Gkm') && typeof p.co2Gkm === 'number' && Number.isInteger(p.co2Gkm)) out.co2Gkm = p.co2Gkm;
  if (applied.has('euroStatus') && typeof p.euroStatus === 'string' && p.euroStatus.trim()) out.euroStatus = p.euroStatus.trim();
  if (applied.has('motStatus') && typeof p.motStatus === 'string' && p.motStatus.trim()) out.motStatus = p.motStatus.trim();
  if (applied.has('taxStatus') && typeof p.taxStatus === 'string' && p.taxStatus.trim()) out.taxStatus = p.taxStatus.trim();
  return out;
}

// ---------------------------------------------------------------------------
// On file (§E.1)
// ---------------------------------------------------------------------------

const known = (s: string | undefined) => (s && s.trim().toUpperCase() !== 'UNKNOWN' ? s : '');

/**
 * Fill the value from a vehicle already on file. Details the match does not carry (VIN, MOT, tax, first registration)
 * are cleared: a partial match is a different registration.
 */
export function applyOnFile(v: VehiclePickerValue, m: OnFileMatch): VehiclePickerValue {
  const spec = m.spec;
  const next: VehiclePickerValue = {
    registration: m.registration,
    make: known(m.make),
    model: known(m.model),
    variant: m.variant ?? '',
    features: [...(spec?.features ?? [])],
    extras: [...(spec?.extras ?? [])],
    source: { provider: 'manual' }
  };
  if (m.bodyType) next.bodyType = m.bodyType;
  if (spec?.doors !== undefined) next.doors = spec.doors;
  if (spec?.seats !== undefined) next.seats = spec.seats;
  if (m.yearOfManufacture !== undefined) next.yearOfManufacture = m.yearOfManufacture;
  if (m.fuelType) next.fuelType = m.fuelType;
  if (m.transmission) next.transmission = m.transmission;
  if (m.engineCapacityCc !== undefined) next.engineCapacityCc = m.engineCapacityCc;
  if (spec?.powerPs !== undefined) next.powerPs = spec.powerPs;
  if (m.colour) next.colour = m.colour;
  const catalogue = cleanCatalogue(spec?.catalogue);
  if (catalogue) next.catalogue = catalogue;
  if (spec?.segment) next.segment = spec.segment;
  return syncSource(next);
}

/** The picker value for an existing vehicle (Vehicle tab "Edit details", fleet unit edit). */
export function pickerFromVehicle(vehicle: Vehicle): VehiclePickerValue {
  const spec = vehicle.spec;
  const out: VehiclePickerValue = {
    registration: vehicle.registration,
    make: known(vehicle.make),
    model: known(vehicle.model),
    variant: vehicle.variant ?? '',
    features: [...(spec?.features ?? [])],
    extras: [...(spec?.extras ?? [])],
    source: { provider: 'manual' }
  };
  const set = <K extends keyof VehiclePickerValue>(k: K, val: VehiclePickerValue[K] | undefined) => {
    if (val !== undefined && val !== null && val !== '') out[k] = val;
  };
  set('bodyType', vehicle.bodyType);
  set('doors', spec?.doors);
  set('seats', spec?.seats);
  set('yearOfManufacture', vehicle.yearOfManufacture);
  set('monthOfFirstRegistration', vehicle.monthOfFirstRegistration);
  set('fuelType', vehicle.fuelType);
  set('transmission', vehicle.transmission);
  set('engineCapacityCc', vehicle.engineCapacityCc);
  set('powerPs', spec?.powerPs);
  set('colour', vehicle.colour);
  set('vin', vehicle.vin);
  set('motExpiryDate', vehicle.motExpiryDate);
  set('taxDueDate', vehicle.taxDueDate);
  set('catalogue', cleanCatalogue(spec?.catalogue));
  set('segment', spec?.segment);
  return syncSource(out);
}

// ---------------------------------------------------------------------------
// Bodies for the API (§D.10, §E.4)
// ---------------------------------------------------------------------------

/** The provenance to send: a paste stays a paste; catalogue ids mean 'catalogue'; otherwise typed by hand. */
export function effectiveSource(v: VehiclePickerValue): VehicleSourceInput {
  if (v.source.provider === 'totalcarcheck_manual') {
    const s: VehicleSourceInput = { provider: 'totalcarcheck_manual' };
    if (v.source.url) s.url = v.source.url;
    if (v.source.pastedText) s.pastedText = v.source.pastedText;
    if (v.source.parsed) s.parsed = v.source.parsed;
    if (v.source.appliedFields?.length) s.appliedFields = [...v.source.appliedFields];
    return s;
  }
  return { provider: cleanCatalogue(v.catalogue) ? 'catalogue' : 'manual' };
}

const intIn = (n: number | undefined, min: number, max: number): number | undefined => (n !== undefined && Number.isInteger(n) && n >= min && n <= max ? n : undefined);

/** VehicleSpec (§D.10) from the value: catalogue ids, segment, doors/seats/power, features and extras. */
export function toSpec(v: VehiclePickerValue): VehicleSpec {
  const spec: VehicleSpec = { features: uniq(v.features.filter(has)), extras: uniq(v.extras.filter(has)) };
  const catalogue = cleanCatalogue(v.catalogue);
  if (catalogue) spec.catalogue = catalogue;
  if (has(v.segment)) spec.segment = v.segment;
  const doors = intIn(v.doors, 1, 9);
  if (doors !== undefined) spec.doors = doors;
  const seats = intIn(v.seats, 1, 17);
  if (seats !== undefined) spec.seats = seats;
  const power = intIn(v.powerPs, 1, 2000);
  if (power !== undefined) spec.powerPs = power;
  return spec;
}

/** True when the spec says anything beyond empty feature lists. */
export function specHasContent(spec: VehicleSpec | undefined): boolean {
  if (!spec) return false;
  return Boolean(spec.catalogue || spec.segment || spec.doors || spec.seats || spec.powerPs || spec.drivetrain || spec.notes || spec.features.length || spec.extras.length);
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** VIN as stored: upper case, no spaces. */
export function cleanVin(vin: string | undefined): string | undefined {
  const s = (vin ?? '').replace(/\s+/g, '').toUpperCase();
  return s || undefined;
}

/**
 * The vehicle details for POST /claims (FNOL), POST /vehicles and POST /fleet: the picker fields, the spec and the
 * source. Empty values are left out so the API's defaults apply.
 */
export function toVehicleInput(v: VehiclePickerValue, opts: { ownership?: VehicleInput['ownership'] } = {}): VehicleInput {
  const out: VehicleInput = { registration: normaliseRegistration(v.registration) };
  if (opts.ownership) out.ownership = opts.ownership;
  if (has(v.make)) out.make = v.make.trim();
  if (has(v.model)) out.model = v.model.trim();
  if (has(v.variant)) out.variant = v.variant.trim();
  if (has(v.bodyType)) out.bodyType = v.bodyType.trim();
  const year = intIn(v.yearOfManufacture, 1900, 2100);
  if (year !== undefined) out.yearOfManufacture = year;
  if (v.monthOfFirstRegistration && MONTH_RE.test(v.monthOfFirstRegistration)) out.monthOfFirstRegistration = v.monthOfFirstRegistration;
  if (v.fuelType) out.fuelType = v.fuelType;
  if (v.transmission) out.transmission = v.transmission;
  const cc = intIn(v.engineCapacityCc, 1, 20_000);
  if (cc !== undefined) out.engineCapacityCc = cc;
  if (has(v.colour)) out.colour = v.colour.trim();
  const vin = cleanVin(v.vin);
  if (vin) out.vin = vin;
  if (v.motExpiryDate && DATE_RE.test(v.motExpiryDate)) out.motExpiryDate = v.motExpiryDate;
  if (v.taxDueDate && DATE_RE.test(v.taxDueDate)) out.taxDueDate = v.taxDueDate;
  Object.assign(out, parsedRecordFields(v.source));
  const spec = toSpec(v);
  if (specHasContent(spec)) out.spec = spec;
  out.source = effectiveSource(v);
  return out;
}

/** `string` field patch: the trimmed value, or null to clear. */
function strPatch(a: string | undefined, b: string | undefined): string | null | undefined {
  const x = (a ?? '').trim();
  const y = (b ?? '').trim();
  if (x === y) return undefined;
  return y ? y : null;
}

function numPatch(a: number | undefined, b: number | undefined): number | null | undefined {
  if (a === b) return undefined;
  return b === undefined ? null : b;
}

/**
 * PATCH /vehicles/:id body (and the `vehicle` of PATCH /fleet/:id): only what changed between `initial` and `next`
 * (`null` clears), the spec when it changed, the paste's record-only fields, and the source. Make and model cannot be
 * cleared (the API needs them), so an emptied make/model is simply not sent.
 */
export function vehiclePatchFrom(initial: VehiclePickerValue, next: VehiclePickerValue): VehiclePatchBody {
  const body: VehiclePatchBody = { source: effectiveSource(next) };
  if (has(next.make) && next.make.trim() !== initial.make.trim()) body.make = next.make.trim();
  if (has(next.model) && next.model.trim() !== initial.model.trim()) body.model = next.model.trim();
  const s = (k: 'variant' | 'bodyType' | 'colour', val: string | null | undefined) => {
    if (val !== undefined) body[k] = val;
  };
  s('variant', strPatch(initial.variant, next.variant));
  s('bodyType', strPatch(initial.bodyType, next.bodyType));
  s('colour', strPatch(initial.colour, next.colour));
  const vin = strPatch(cleanVin(initial.vin), cleanVin(next.vin));
  if (vin !== undefined) body.vin = vin;
  const month = strPatch(initial.monthOfFirstRegistration, next.monthOfFirstRegistration && MONTH_RE.test(next.monthOfFirstRegistration) ? next.monthOfFirstRegistration : undefined);
  if (month !== undefined) body.monthOfFirstRegistration = month;
  const mot = strPatch(initial.motExpiryDate, next.motExpiryDate && DATE_RE.test(next.motExpiryDate) ? next.motExpiryDate : undefined);
  if (mot !== undefined) body.motExpiryDate = mot;
  const tax = strPatch(initial.taxDueDate, next.taxDueDate && DATE_RE.test(next.taxDueDate) ? next.taxDueDate : undefined);
  if (tax !== undefined) body.taxDueDate = tax;
  const year = numPatch(initial.yearOfManufacture, intIn(next.yearOfManufacture, 1900, 2100));
  if (year !== undefined) body.yearOfManufacture = year;
  const cc = numPatch(initial.engineCapacityCc, intIn(next.engineCapacityCc, 1, 20_000));
  if (cc !== undefined) body.engineCapacityCc = cc;
  if (initial.fuelType !== next.fuelType) body.fuelType = next.fuelType ?? null;
  if (initial.transmission !== next.transmission) body.transmission = next.transmission ?? null;
  const before = toSpec(initial);
  const after = toSpec(next);
  if (JSON.stringify(before) !== JSON.stringify(after)) body.spec = specHasContent(after) ? after : null;
  Object.assign(body, parsedRecordFields(next.source));
  return body;
}

/** True when a patch body changes anything (more than its source). */
export function patchHasChanges(body: VehiclePatchBody): boolean {
  return Object.keys(body).some((k) => k !== 'source');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type PickerErrors = Partial<Record<keyof VehiclePickerValue, string>>;

/** Field checks shared by the three uses; make and model are required when `requireMakeModel`. */
export function validatePicker(v: VehiclePickerValue, opts: { requireMakeModel?: boolean; today?: ISODate } = {}): PickerErrors {
  const e: PickerErrors = {};
  if (opts.requireMakeModel) {
    if (!has(v.make)) e.make = 'Make is required — pick it from the list or type it.';
    if (!has(v.model)) e.model = 'Model is required — pick it from the list or type it.';
  }
  const thisYear = Number((opts.today ?? new Date().toISOString()).slice(0, 4));
  if (v.yearOfManufacture !== undefined && (!Number.isInteger(v.yearOfManufacture) || v.yearOfManufacture < 1950 || v.yearOfManufacture > thisYear + 1)) e.yearOfManufacture = `Enter a year between 1950 and ${thisYear + 1}.`;
  if (v.engineCapacityCc !== undefined && intIn(v.engineCapacityCc, 1, 20_000) === undefined) e.engineCapacityCc = 'Engine size in whole cc (e.g. 1598).';
  if (v.powerPs !== undefined && intIn(v.powerPs, 1, 2000) === undefined) e.powerPs = 'Power in whole PS.';
  if (v.monthOfFirstRegistration && !MONTH_RE.test(v.monthOfFirstRegistration)) e.monthOfFirstRegistration = 'Use the month, e.g. 2019-03.';
  const vin = cleanVin(v.vin);
  if (vin && vin.length !== 17) e.vin = 'A full VIN has 17 characters (check the V5C).';
  return e;
}

// ---------------------------------------------------------------------------
// "Add to catalogue" (§D.7)
// ---------------------------------------------------------------------------

export type CustomEntryResult = { ok: true; body: CustomCatalogueBody } | { ok: false; error: string };

/**
 * POST /catalogue/custom body for a step the catalogue does not list. The entry is the user's own addition
 * (unverified, like the shipped catalogue).
 */
export function customEntryBody(level: CustomCatalogueLevel, v: VehiclePickerValue, name: string, opts: { vehicleType?: string } = {}): CustomEntryResult {
  const n = name.trim();
  if (!n) return { ok: false, error: 'Type the name first.' };
  if (level === 'make') return { ok: true, body: { level, make: n, name: n } };
  if (!has(v.make)) return { ok: false, error: 'Choose or type the make first.' };
  const make = v.make.trim();
  if (level === 'model') {
    const data: Record<string, unknown> = { vehicleType: opts.vehicleType ?? 'car' };
    if (v.yearOfManufacture) data.years = { from: v.yearOfManufacture, to: null };
    const body: CustomCatalogueBody = { level, make, model: n, name: n, data };
    if (isSegment(v.segment)) body.segment = v.segment;
    return { ok: true, body };
  }
  if (!has(v.model)) return { ok: false, error: 'Choose or type the model first.' };
  const model = v.model.trim();
  if (level === 'generation') {
    const data: Record<string, unknown> = {};
    if (v.yearOfManufacture) data.years = { from: v.yearOfManufacture, to: null };
    const body = bodySlugOf(v.bodyType);
    if (body) data.bodies = [{ body, doors: v.doors ? [v.doors] : [], seats: v.seats ? [v.seats] : [] }];
    return { ok: true, body: { level, make, model, name: n, data } };
  }
  const generationId = v.catalogue?.generationId;
  if (!generationId) return { ok: false, error: 'Choose the generation first (a trim or engine belongs to one).' };
  if (level === 'trim') return { ok: true, body: { level, make, model, generationId, name: n } };
  const data: Record<string, unknown> = { fuel: domainFuelToCatalogue(v.fuelType) };
  if (v.engineCapacityCc) data.cc = v.engineCapacityCc;
  if (v.powerPs) data.powerPs = v.powerPs;
  return { ok: true, body: { level, make, model, generationId, name: n, data } };
}

// ---------------------------------------------------------------------------
// Features and extras (§D.3)
// ---------------------------------------------------------------------------

export type FeatureTab = 'standard' | 'extras';

/** Categories whose items match the search (label, id or alias); empty categories are dropped. */
export function filterVocabulary(vocab: FeatureVocabulary | undefined, query: string): FeatureVocabulary['categories'] {
  if (!vocab) return [];
  const q = matchKey(query);
  const hit = (i: FeatureItem) => !q || matchKey(i.label).includes(q) || matchKey(i.id).includes(q) || (i.aliases ?? []).some((a) => matchKey(a).includes(q));
  return vocab.categories.map((c) => ({ ...c, items: c.items.filter(hit) })).filter((c) => c.items.length > 0);
}

export function toggleId(list: readonly string[], id: string, on: boolean): string[] {
  return on ? uniq([...list, id]) : list.filter((x) => x !== id);
}

/** 'heated_seats_front' → 'Heated seats front' when the vocabulary is not loaded. */
export function humaniseId(id: string): string {
  const s = id.replace(/_/g, ' ').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : id;
}

export function featureLabels(vocab: FeatureVocabulary | undefined, ids: readonly string[]): string[] {
  const byId = new Map<string, string>();
  for (const c of vocab?.categories ?? []) for (const i of c.items) byId.set(i.id, i.label);
  return ids.map((id) => byId.get(id) ?? humaniseId(id));
}

/** One-line description for summaries: 'Ford Fiesta Zetec · 2019 · 1.0 EcoBoost … · Petrol · Manual'. */
export function describeVehicle(v: Pick<VehiclePickerValue, 'make' | 'model' | 'variant' | 'yearOfManufacture' | 'fuelType' | 'transmission' | 'engineCapacityCc'>): string {
  const name = [v.make, v.model, v.variant].map((x) => (x ?? '').trim()).filter(Boolean).join(' ');
  const parts = [name, v.yearOfManufacture ? String(v.yearOfManufacture) : '', v.engineCapacityCc ? `${v.engineCapacityCc.toLocaleString('en-GB')} cc` : '', v.fuelType ? FUEL_LABEL[v.fuelType] : '', v.transmission && v.transmission !== 'unknown' ? TRANSMISSION_LABEL[v.transmission] : ''];
  return parts.filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// Registration rules relaxed in manager mode (0.3 §A.6 B08, B12, B17)
// ---------------------------------------------------------------------------

export const NON_UK_REGISTRATION = 'This does not look like a UK registration mark — check it against the V5C.';

/** A typed registration that is not a UK format (undefined when empty or valid). Relaxed in manager mode. */
export function registrationFormatMessage(registration: string): string | undefined {
  const reg = registration.trim();
  if (!reg) return undefined;
  return isValidUkRegistration(reg) ? undefined : NON_UK_REGISTRATION;
}

/** The searched registration is a client vehicle on a claim (a fleet unit for it is refused: REGISTRATION_ON_CLAIM). */
export function isClientVehicleOnClaim(matches: readonly OnFileMatch[] | undefined): boolean {
  return (matches ?? []).some((m) => m.match === 'exact' && m.ownership !== 'fleet' && m.claims.length > 0);
}

/**
 * How an on-file CCGUK fleet vehicle is offered as a client vehicle: 'block' (normal mode, New claim), 'warn' (manager
 * mode: allowed with a warning; the server still raises the FLEET_UNIT_AS_CLIENT_VEHICLE block flag) or 'allow' (the
 * host does not block fleet vehicles).
 */
export function fleetMatchHandling(opts: { blockFleet: boolean; warnFleet?: boolean; managerOn: boolean }): 'block' | 'warn' | 'allow' {
  if (opts.blockFleet) return opts.managerOn ? 'warn' : 'block';
  return opts.warnFleet ? 'warn' : 'allow';
}
