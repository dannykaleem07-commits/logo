/**
 * Vehicle catalogue for the API (TEMPLATES-VEHICLES-DESKTOP §D.7, §D.8): the shipped catalogue from @ccguk/kb merged with
 * the user's additions in `vehicle_catalogue_custom`, and the catalogue facts the GTA suggestion needs (§D.6).
 *
 * Custom makes/models appear in the lists (`custom: true`); custom generations, trims and engines are appended to the
 * shipped lists; override rows replace the segment / GTA group of a shipped entry. Everything stays unverified.
 */
import { suggestGtaGroup, type GtaSuggestion, type ISODate, type Vehicle } from '@ccguk/domain';
import type { CustomCatalogueEntry } from '@ccguk/db';
import {
  CATALOGUE_SEGMENTS,
  CATALOGUE_VEHICLE_TYPES,
  catalogueKey,
  findCatalogueMake,
  generationsForYear,
  getCatalogueMake,
  getCatalogueModel,
  listCatalogueMakes,
  listCatalogueModels,
  matchCatalogue,
  normaliseEngine,
  searchCatalogue,
  slugify,
  type CatalogueBody,
  type CatalogueFuel,
  type CatalogueMakeSummary,
  type CatalogueModelSummary,
  type CatalogueSearchHit,
  type CatalogueSegment,
  type CatalogueTransmission,
  type CatalogueVehicleType,
  type NormalisedEngine,
  type NormalisedGeneration,
  type NormalisedModel,
} from '@ccguk/kb';
import type { AppContext } from '../context.js';
import { gtaRatesFor, segmentDefaultsFor } from './kb.js';

const isSegment = (s: unknown): s is CatalogueSegment => typeof s === 'string' && (CATALOGUE_SEGMENTS as readonly string[]).includes(s);
const isVehicleType = (s: unknown): s is CatalogueVehicleType => typeof s === 'string' && (CATALOGUE_VEHICLE_TYPES as readonly string[]).includes(s);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function customEntries(ctx: AppContext): CustomCatalogueEntry[] {
  return ctx.repos.listCustomCatalogueEntries(ctx.db);
}

function yearsOf(e: CustomCatalogueEntry): { from: number; to: number | null } {
  const y = (e.data.years ?? {}) as Record<string, unknown>;
  const from = num(y.from) ?? num(e.data.from) ?? 2000;
  const toRaw = y.to !== undefined ? y.to : e.data.to;
  return { from, to: num(toRaw) ?? null };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** Make slug for a typed make name: the shipped make it names, else slugify(name). */
export function makeSlugFor(make: string): string {
  return findCatalogueMake(make)?.slug ?? slugify(make);
}

/** Model slug for a typed model name within a make: the shipped model it names, else slugify(name). */
export function modelSlugFor(makeSlug: string, model: string): string {
  const shipped = getCatalogueMake(makeSlug)?.models.find((m) => catalogueKey(m.name) === catalogueKey(model) || m.slug === model);
  return shipped?.slug ?? slugify(model);
}

export function listMakes(ctx: AppContext): CatalogueMakeSummary[] {
  const custom = customEntries(ctx);
  const shipped = listCatalogueMakes();
  const bySlug = new Map<string, CatalogueMakeSummary>(shipped.map((m) => [m.slug, { ...m, vehicleTypes: [...m.vehicleTypes] }]));
  const customModels = custom.filter((e) => e.level === 'model' && !e.overridesBuiltin);
  for (const e of custom.filter((x) => x.level === 'make' && !x.overridesBuiltin)) {
    if (bySlug.has(e.makeSlug)) continue;
    bySlug.set(e.makeSlug, {
      slug: e.makeSlug,
      make: e.make,
      dvlaNames: strArr(e.data.dvlaNames).length ? strArr(e.data.dvlaNames) : [e.make.toUpperCase()],
      aliases: strArr(e.data.aliases),
      modelCount: 0,
      years: yearsOf(e),
      vehicleTypes: [],
      custom: true,
    });
  }
  for (const e of customModels) {
    let s = bySlug.get(e.makeSlug);
    if (!s) {
      // A custom model of a make that is neither shipped nor added: show the make too.
      s = { slug: e.makeSlug, make: e.make, dvlaNames: [e.make.toUpperCase()], aliases: [], modelCount: 0, years: yearsOf(e), vehicleTypes: [], custom: true };
      bySlug.set(e.makeSlug, s);
    }
    s.modelCount += 1;
    const vt = isVehicleType(e.data.vehicleType) ? e.data.vehicleType : 'car';
    if (!s.vehicleTypes.includes(vt)) s.vehicleTypes = CATALOGUE_VEHICLE_TYPES.filter((t) => t === vt || s!.vehicleTypes.includes(t));
  }
  return [...bySlug.values()].sort((a, b) => a.make.localeCompare(b.make, 'en-GB'));
}

function customModelSummary(e: CustomCatalogueEntry): CatalogueModelSummary {
  const bodies = Array.isArray(e.data.bodies) ? (e.data.bodies as Array<{ body?: unknown }>).map((b) => (typeof b === 'string' ? b : b?.body)).filter((b): b is CatalogueBody => typeof b === 'string') : [];
  return {
    makeSlug: e.makeSlug,
    slug: e.modelSlug ?? slugify(e.name),
    name: e.model ?? e.name,
    vehicleType: isVehicleType(e.data.vehicleType) ? e.data.vehicleType : 'car',
    segment: isSegment(e.segment) ? e.segment : isSegment(e.data.segment) ? e.data.segment : 'small-family',
    years: yearsOf(e),
    bodies,
    custom: true,
  };
}

export function listModels(ctx: AppContext, makeSlug: string, opts: { year?: number; vehicleType?: CatalogueVehicleType } = {}): CatalogueModelSummary[] {
  const custom = customEntries(ctx).filter((e) => e.makeSlug === makeSlug);
  const items = listCatalogueModels(makeSlug, opts).map((m) => {
    const o = latestOverride(custom, 'model', m.slug);
    return o && isSegment(o.segment) ? { ...m, segment: o.segment } : m;
  });
  for (const e of custom.filter((x) => x.level === 'model' && !x.overridesBuiltin)) {
    const s = customModelSummary(e);
    if (items.some((m) => m.slug === s.slug)) continue;
    if (opts.vehicleType && s.vehicleType !== opts.vehicleType) continue;
    if (opts.year !== undefined && (opts.year < s.years.from || (s.years.to !== null && opts.year > s.years.to))) continue;
    items.push(s);
  }
  return items.sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { numeric: true }));
}

function latestOverride(entries: CustomCatalogueEntry[], level: CustomCatalogueEntry['level'], modelSlug: string, generationId?: string, trim?: { id: string; name: string }): CustomCatalogueEntry | undefined {
  const matches = entries.filter((e) => {
    if (!e.overridesBuiltin || e.level !== level || e.modelSlug !== modelSlug) return false;
    if (level === 'generation' || level === 'trim') if (e.generationId !== generationId) return false;
    if (level === 'trim' && trim) return e.data.trimId === trim.id || slugify(e.name) === trim.id || catalogueKey(e.name) === catalogueKey(trim.name);
    return true;
  });
  return matches[matches.length - 1];
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

function customGeneration(e: CustomCatalogueEntry, makeSlug: string, modelSlug: string, taken: Set<string>): NormalisedGeneration {
  const years = yearsOf(e);
  const bodies = Array.isArray(e.data.bodies)
    ? (e.data.bodies as unknown[]).flatMap((b) => {
        if (typeof b === 'string') return [{ body: b as CatalogueBody, doors: [], seats: [] }];
        const r = b as Record<string, unknown>;
        return typeof r?.body === 'string' ? [{ body: r.body as CatalogueBody, doors: (r.doors as number[]) ?? [], seats: (r.seats as number[]) ?? [] }] : [];
      })
    : [];
  const g: NormalisedGeneration = {
    id: uniqueId(`${makeSlug}-${modelSlug}-${slugify(e.name)}`, taken),
    name: e.name,
    from: years.from,
    to: years.to,
    bodies,
    trims: [],
    engines: [],
    fuels: strArr(e.data.fuels) as CatalogueFuel[],
    transmissions: strArr(e.data.transmissions) as CatalogueTransmission[],
  };
  if (e.gtaGroup) g.gtaGroup = e.gtaGroup;
  return g;
}

function customEngine(e: CustomCatalogueEntry, taken: Set<string>): NormalisedEngine {
  try {
    return normaliseEngine(e.name, taken);
  } catch {
    const fuel: CatalogueFuel = typeof e.data.fuel === 'string' ? (e.data.fuel as CatalogueFuel) : 'petrol';
    return normaliseEngine({ label: e.name, fuel, ...(num(e.data.cc) ? { cc: num(e.data.cc)! } : {}), ...(num(e.data.powerPs) ? { powerPs: num(e.data.powerPs)! } : {}) }, taken);
  }
}

/** One model with the user's additions and overrides applied (deep copy; the shipped cache is never mutated). */
export function getModel(ctx: AppContext, makeSlug: string, modelSlug: string): NormalisedModel | undefined {
  const custom = customEntries(ctx).filter((e) => e.makeSlug === makeSlug);
  const shipped = getCatalogueModel(makeSlug, modelSlug);
  let model: NormalisedModel | undefined;
  if (shipped) model = structuredClone(shipped);
  else {
    const e = [...custom].reverse().find((x) => x.level === 'model' && !x.overridesBuiltin && (x.modelSlug ?? slugify(x.name)) === modelSlug);
    if (!e) return undefined;
    const s = customModelSummary(e);
    model = { name: s.name, slug: s.slug, aliases: strArr(e.data.aliases), vehicleType: s.vehicleType, segment: s.segment, years: s.years, makeSlug, generations: [], custom: true };
    if (e.gtaGroup) model.gtaGroup = e.gtaGroup;
  }
  const mine = custom.filter((e) => e.modelSlug === modelSlug);
  const genIds = new Set(model.generations.map((g) => g.id));
  for (const e of mine.filter((x) => x.level === 'generation' && !x.overridesBuiltin)) model.generations.push(customGeneration(e, makeSlug, modelSlug, genIds));
  for (const g of model.generations) {
    const trimIds = new Set(g.trims.map((t) => t.id));
    const engineIds = new Set(g.engines.map((x) => x.id));
    for (const e of mine.filter((x) => x.generationId === g.id && !x.overridesBuiltin)) {
      if (e.level === 'trim') {
        const t: NormalisedGeneration['trims'][number] = { id: uniqueId(slugify(e.name), trimIds), name: e.name };
        if (e.gtaGroup) t.gtaGroup = e.gtaGroup;
        const features = strArr(e.data.features);
        if (features.length) t.features = features;
        g.trims.push(t);
      } else if (e.level === 'engine') g.engines.push(customEngine(e, engineIds));
    }
    const go = latestOverride(custom, 'generation', modelSlug, g.id);
    if (go?.gtaGroup) g.gtaGroup = go.gtaGroup;
    for (const t of g.trims) {
      const to = latestOverride(custom, 'trim', modelSlug, g.id, t);
      if (to?.gtaGroup) t.gtaGroup = to.gtaGroup;
    }
  }
  const mo = latestOverride(custom, 'model', modelSlug);
  if (mo?.gtaGroup) model.gtaGroup = mo.gtaGroup;
  if (mo && isSegment(mo.segment)) model.segment = mo.segment;
  return model;
}

// ---------------------------------------------------------------------------
// Match and search (shipped first, then custom makes/models)
// ---------------------------------------------------------------------------

export interface CatalogueMatchView {
  makeSlug?: string;
  modelSlug?: string;
  variantRemainder?: string;
  score: number;
}

export function matchVehicle(ctx: AppContext, make: string, model?: string): CatalogueMatchView {
  const shipped = matchCatalogue(make, model);
  const out: CatalogueMatchView = { score: shipped.score };
  if (shipped.make) out.makeSlug = shipped.make.slug;
  if (shipped.model) out.modelSlug = shipped.model.slug;
  if (shipped.variantRemainder) out.variantRemainder = shipped.variantRemainder;
  if (shipped.model) return out;
  // Custom additions: a custom make, or a custom model of a shipped or custom make.
  const custom = customEntries(ctx);
  const makeKey = catalogueKey(make);
  const makeSlug = out.makeSlug ?? custom.find((e) => !e.overridesBuiltin && (catalogueKey(e.make) === makeKey || e.makeSlug === slugify(make)))?.makeSlug;
  if (!makeSlug) return out;
  out.makeSlug = makeSlug;
  out.score = Math.max(out.score, 0.5);
  if (!model) return out;
  const modelKey = catalogueKey(model);
  let best: { slug: string; words: number } | undefined;
  for (const e of custom.filter((x) => x.level === 'model' && !x.overridesBuiltin && x.makeSlug === makeSlug)) {
    const k = catalogueKey(e.model ?? e.name);
    const n = k.split(' ').length;
    if (k && (modelKey === k || modelKey.startsWith(`${k} `)) && (!best || n > best.words)) best = { slug: e.modelSlug ?? slugify(e.name), words: n };
  }
  if (best) {
    out.modelSlug = best.slug;
    out.score = 0.9;
    const rest = model.trim().split(/\s+/).slice(best.words).join(' ');
    if (rest) out.variantRemainder = rest;
    else delete out.variantRemainder;
  }
  return out;
}

export function searchVehicles(ctx: AppContext, q: string, limit = 20): CatalogueSearchHit[] {
  const hits = searchCatalogue(q, limit);
  const words = catalogueKey(q).split(' ').filter(Boolean);
  if (!words.length) return hits;
  for (const e of customEntries(ctx).filter((x) => !x.overridesBuiltin && (x.level === 'make' || x.level === 'model'))) {
    const hay = catalogueKey(`${e.make} ${e.model ?? ''} ${e.level === 'model' ? e.name : ''}`);
    const matched = words.filter((w) => hay.split(' ').some((h) => h === w || (w.length >= 2 && h.startsWith(w)))).length;
    if (!matched) continue;
    const hit: CatalogueSearchHit = { makeSlug: e.makeSlug, make: e.make, score: Math.round((matched / words.length) * 1000) / 1000, label: e.level === 'model' ? `${e.make} ${e.model ?? e.name}` : e.make };
    if (e.level === 'model') {
      hit.modelSlug = e.modelSlug ?? slugify(e.name);
      hit.model = e.model ?? e.name;
    }
    if (!hits.some((h) => h.makeSlug === hit.makeSlug && h.modelSlug === hit.modelSlug && !h.trimId)) hits.push(hit);
  }
  return hits.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, 'en-GB')).slice(0, limit);
}

// ---------------------------------------------------------------------------
// GTA suggestion facts (§D.6)
// ---------------------------------------------------------------------------

export interface GtaSuggestQuery {
  make?: string;
  model?: string;
  generationId?: string;
  trimId?: string;
  segment?: string;
  bodyType?: string;
  engineCapacityCc?: number;
  fuelType?: Vehicle['fuelType'];
  variant?: string;
  recordedGroup?: string;
  date: ISODate;
}

/** Shipped catalogue groups (trim → generation → model), the user's custom group, and the segment, for a vehicle. */
export function catalogueFactsFor(
  ctx: AppContext,
  q: Pick<GtaSuggestQuery, 'make' | 'model' | 'generationId' | 'trimId' | 'segment'> & { year?: number },
): { catalogue?: { trimGroup?: string; generationGroup?: string; modelGroup?: string; segment?: string }; customOverride?: string; makeSlug?: string; modelSlug?: string } {
  if (!q.make) return q.segment ? { catalogue: { segment: q.segment } } : {};
  // make/model may be slugs (from the picker) or names (typed / DVLA).
  let makeSlug = getCatalogueMake(q.make) ? q.make : undefined;
  let modelSlug = makeSlug && q.model && getCatalogueModel(makeSlug, q.model) ? q.model : undefined;
  if (!makeSlug || !modelSlug) {
    const m = matchVehicle(ctx, q.make, q.model);
    makeSlug = makeSlug ?? m.makeSlug;
    modelSlug = modelSlug ?? m.modelSlug;
    if (!modelSlug && makeSlug && q.model) {
      const custom = customEntries(ctx).find((e) => e.makeSlug === makeSlug && e.modelSlug === q.model);
      if (custom) modelSlug = q.model;
    }
  }
  if (!makeSlug || !modelSlug) return q.segment ? { catalogue: { segment: q.segment }, ...(makeSlug ? { makeSlug } : {}) } : makeSlug ? { makeSlug } : {};
  const shipped = getCatalogueModel(makeSlug, modelSlug);
  const merged = getModel(ctx, makeSlug, modelSlug);
  const catalogue: { trimGroup?: string; generationGroup?: string; modelGroup?: string; segment?: string } = {};
  const gen = shipped && q.generationId ? shipped.generations.find((g) => g.id === q.generationId) : shipped && q.year !== undefined ? generationsForYear(shipped, q.year)[0] : undefined;
  const trim = gen && q.trimId ? gen.trims.find((t) => t.id === q.trimId) : undefined;
  if (trim?.gtaGroup) catalogue.trimGroup = trim.gtaGroup;
  if (gen?.gtaGroup) catalogue.generationGroup = gen.gtaGroup;
  if (shipped?.gtaGroup) catalogue.modelGroup = shipped.gtaGroup;
  const segment = q.segment ?? merged?.segment;
  if (segment) catalogue.segment = segment;

  // The user's own group, most specific first: a custom trim/generation/model they added, or an override row.
  let customOverride: string | undefined;
  if (merged) {
    const mgen = q.generationId ? merged.generations.find((g) => g.id === q.generationId) : undefined;
    const mtrim = mgen && q.trimId ? mgen.trims.find((t) => t.id === q.trimId) : undefined;
    const pick = (mine: string | undefined, theirs: string | undefined) => (mine && mine !== theirs ? mine : undefined);
    customOverride = pick(mtrim?.gtaGroup, trim?.gtaGroup) ?? pick(mgen?.gtaGroup, gen?.gtaGroup) ?? pick(merged.gtaGroup, shipped?.gtaGroup);
  }
  return { catalogue, ...(customOverride ? { customOverride } : {}), makeSlug, modelSlug };
}

export function gtaSuggestionFor(ctx: AppContext, q: GtaSuggestQuery): GtaSuggestion {
  const year = Number(q.date.slice(0, 4));
  const facts = catalogueFactsFor(ctx, { ...q, year: Number.isFinite(year) ? year : undefined });
  const vehicle: GtaSuggestQueryVehicle = { make: q.make ?? '', model: q.model ?? '' };
  // For the heuristic: display names rather than slugs.
  if (facts.makeSlug) {
    const make = listMakes(ctx).find((m) => m.slug === facts.makeSlug);
    if (make) vehicle.make = make.make;
    if (facts.modelSlug) {
      const model = getModel(ctx, facts.makeSlug, facts.modelSlug);
      if (model) vehicle.model = model.name;
    }
  }
  if (q.variant) vehicle.variant = q.variant;
  if (q.bodyType) vehicle.bodyType = q.bodyType;
  if (q.engineCapacityCc) vehicle.engineCapacityCc = q.engineCapacityCc;
  if (q.fuelType) vehicle.fuelType = q.fuelType;
  return suggestGtaGroup({
    recordedGroup: q.recordedGroup,
    customOverride: facts.customOverride,
    catalogue: facts.catalogue,
    segmentDefaults: segmentDefaultsFor(ctx),
    vehicle,
    date: q.date,
    rates: gtaRatesFor(ctx),
  });
}

type GtaSuggestQueryVehicle = Pick<Vehicle, 'make' | 'model' | 'variant' | 'bodyType' | 'engineCapacityCc' | 'fuelType'>;

