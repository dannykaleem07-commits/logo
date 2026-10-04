/**
 * Vehicle catalogue loader (TEMPLATES-VEHICLES-DESKTOP §D.1, §D.5).
 *
 * Reads `packages/kb/data/vehicle-catalogue/` (index.json, features.json, makes/<slug>.json) lazily: the make list comes
 * from index.json when present, else from reading every make file; each make is validated and normalised on first use
 * and cached. The directory may be empty or partial (it is filled by the data slice); a missing or invalid make file is
 * skipped and recorded in `catalogueLoadIssues()` rather than failing the whole catalogue.
 *
 * Tests (and tools) can point the loader elsewhere with `setCatalogueDataDir()` or the env `CATALOGUE_DATA_DIR`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KbValidationError, loadGtaSegmentDefaultsFile } from '../load.js';
import { CATALOGUE_SLUG, bodiesOf, normaliseCatalogueMake, validateCatalogueMake } from './normalise.js';
import {
  CATALOGUE_VEHICLE_TYPES,
  type CatalogueMakeSummary,
  type CatalogueSegment,
  type CatalogueVehicleType,
  type FeatureVocabulary,
  type NormalisedMake,
} from './types.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../data/vehicle-catalogue/', import.meta.url));

let overrideDir: string | undefined;

/** Point the loader at another catalogue directory (tests); `undefined` restores the default. Clears the caches. */
export function setCatalogueDataDir(dir: string | URL | undefined): void {
  overrideDir = dir === undefined ? undefined : dir instanceof URL ? fileURLToPath(dir) : dir;
  resetCatalogueCache();
}

/** The directory in use: setCatalogueDataDir() → env CATALOGUE_DATA_DIR → packages/kb/data/vehicle-catalogue/. */
export function catalogueDataDir(): string {
  return overrideDir ?? (process.env.CATALOGUE_DATA_DIR?.trim() || DEFAULT_DIR);
}

export interface CatalogueLoadIssue {
  file: string;
  level: 'error' | 'warning';
  message: string;
}

let makeCache = new Map<string, NormalisedMake | null>();
let summaryCache: CatalogueMakeSummary[] | undefined;
let featureCache: FeatureVocabulary | undefined;
let issues: CatalogueLoadIssue[] = [];

/** Drop every catalogue cache (and the recorded load issues). */
export function resetCatalogueCache(): void {
  makeCache = new Map();
  summaryCache = undefined;
  featureCache = undefined;
  issues = [];
}

/** Files skipped (errors) and §D.2 quality findings (warnings) seen so far. */
export function catalogueLoadIssues(): readonly CatalogueLoadIssue[] {
  return issues;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

function makesDir(): string {
  return path.join(catalogueDataDir(), 'makes');
}

/** Slugs of the make files on disk (sorted). */
export function catalogueMakeFiles(): string[] {
  const dir = makesDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .filter((s) => CATALOGUE_SLUG.test(s))
      .sort();
  } catch {
    return [];
  }
}

function loadMakeFile(slug: string): NormalisedMake | null {
  const file = path.join(makesDir(), `${slug}.json`);
  if (!existsSync(file)) return null;
  const rel = `makes/${slug}.json`;
  try {
    const warnings: string[] = [];
    const valid = validateCatalogueMake(readJson(file), rel, { strict: false, warnings });
    for (const w of warnings) issues.push({ file: rel, level: 'warning', message: w });
    return normaliseCatalogueMake(valid);
  } catch (err) {
    const message = err instanceof KbValidationError ? err.message : `${rel}: ${(err as Error).message}`;
    issues.push({ file: rel, level: 'error', message });
    return null;
  }
}

/** One make, validated and normalised on first use (cached). `undefined` when missing or invalid. */
export function getCatalogueMake(slug: string): NormalisedMake | undefined {
  const s = (slug ?? '').trim().toLowerCase();
  if (!CATALOGUE_SLUG.test(s)) return undefined;
  if (!makeCache.has(s)) makeCache.set(s, loadMakeFile(s));
  return makeCache.get(s) ?? undefined;
}

export function summariseMake(m: NormalisedMake): CatalogueMakeSummary {
  const froms = m.models.map((x) => x.years.from);
  const tos = m.models.map((x) => x.years.to);
  const vehicleTypes = CATALOGUE_VEHICLE_TYPES.filter((t) => m.models.some((x) => x.vehicleType === t));
  return {
    slug: m.slug,
    make: m.make,
    dvlaNames: m.dvlaNames,
    aliases: m.aliases,
    modelCount: m.models.length,
    years: { from: froms.length ? Math.min(...froms) : 0, to: tos.length === 0 || tos.some((t) => t === null) ? null : Math.max(...(tos as number[])) },
    vehicleTypes,
  };
}

function summaryFromIndexRow(row: unknown): CatalogueMakeSummary | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const r = row as Record<string, unknown>;
  if (typeof r.slug !== 'string' || !CATALOGUE_SLUG.test(r.slug) || typeof r.make !== 'string') return undefined;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const years = (typeof r.years === 'object' && r.years !== null ? r.years : {}) as Record<string, unknown>;
  return {
    slug: r.slug,
    make: r.make,
    dvlaNames: strs(r.dvlaNames),
    aliases: strs(r.aliases),
    modelCount: typeof r.modelCount === 'number' ? r.modelCount : Array.isArray(r.models) ? r.models.length : 0,
    years: { from: typeof years.from === 'number' ? years.from : 0, to: typeof years.to === 'number' ? years.to : null },
    vehicleTypes: strs(r.vehicleTypes).filter((t): t is CatalogueVehicleType => (CATALOGUE_VEHICLE_TYPES as readonly string[]).includes(t)),
  };
}

/** Rows of index.json when it exists and parses (array, `{ makes: [] }` or `{ items: [] }`), else undefined. */
function readIndex(): CatalogueMakeSummary[] | undefined {
  const file = path.join(catalogueDataDir(), 'index.json');
  if (!existsSync(file)) return undefined;
  try {
    const raw = readJson(file);
    const rows = Array.isArray(raw) ? raw : typeof raw === 'object' && raw !== null ? ((raw as Record<string, unknown>).makes ?? (raw as Record<string, unknown>).items) : undefined;
    if (!Array.isArray(rows)) throw new Error('expected an array of make summaries');
    const out = rows.map(summaryFromIndexRow).filter((x): x is CatalogueMakeSummary => Boolean(x));
    // Only makes whose file exists (the index can run ahead of a partial data directory).
    const onDisk = new Set(catalogueMakeFiles());
    const present = out.filter((s) => onDisk.has(s.slug));
    return present.length ? present : undefined;
  } catch (err) {
    issues.push({ file: 'index.json', level: 'error', message: `index.json ignored: ${(err as Error).message}` });
    return undefined;
  }
}

/** Every shipped make (index.json, else every make file read and summarised). Sorted by display name. */
export function listCatalogueMakes(): CatalogueMakeSummary[] {
  if (summaryCache) return summaryCache;
  const fromIndex = readIndex();
  const list = fromIndex ?? catalogueMakeFiles().map((slug) => getCatalogueMake(slug)).filter((m): m is NormalisedMake => Boolean(m)).map(summariseMake);
  summaryCache = [...list].sort((a, b) => a.make.localeCompare(b.make, 'en-GB'));
  return summaryCache;
}

/** Every shipped make, fully loaded (search and match use this). */
export function loadAllCatalogueMakes(): NormalisedMake[] {
  return listCatalogueMakes()
    .map((s) => getCatalogueMake(s.slug))
    .filter((m): m is NormalisedMake => Boolean(m));
}

/** features.json (§D.3); an empty vocabulary when the file is missing or invalid. */
export function loadFeatureVocabulary(): FeatureVocabulary {
  if (featureCache) return featureCache;
  const file = path.join(catalogueDataDir(), 'features.json');
  let out: FeatureVocabulary = { schemaVersion: 1, categories: [] };
  if (existsSync(file)) {
    try {
      const raw = readJson(file) as Record<string, unknown>;
      if (!Array.isArray(raw.categories)) throw new Error('expected { schemaVersion: 1, categories: [] }');
      const categories: FeatureVocabulary['categories'] = [];
      for (const [i, c] of (raw.categories as unknown[]).entries()) {
        const cat = c as Record<string, unknown>;
        if (typeof cat?.id !== 'string' || typeof cat.label !== 'string' || !Array.isArray(cat.items)) throw new Error(`categories[${i}] needs id, label and items`);
        const items = (cat.items as unknown[]).flatMap((it) => {
          const x = it as Record<string, unknown>;
          if (typeof x?.id !== 'string' || typeof x.label !== 'string') return [];
          const kind = x.kind === 'extra' || x.kind === 'both' ? x.kind : 'feature';
          const item: FeatureVocabulary['categories'][number]['items'][number] = { id: x.id, label: x.label, kind };
          if (Array.isArray(x.aliases)) item.aliases = x.aliases.filter((a): a is string => typeof a === 'string');
          return [item];
        });
        categories.push({ id: cat.id, label: cat.label, items });
      }
      out = { schemaVersion: 1, categories };
    } catch (err) {
      issues.push({ file: 'features.json', level: 'error', message: `features.json ignored: ${(err as Error).message}` });
    }
  }
  featureCache = out;
  return out;
}

/** Segment → GTA group starting suggestions (packages/kb/data/gta-segment-defaults.json, unverified). */
export function loadGtaSegmentDefaults(): Record<CatalogueSegment, string> {
  return loadGtaSegmentDefaultsFile().defaults;
}

