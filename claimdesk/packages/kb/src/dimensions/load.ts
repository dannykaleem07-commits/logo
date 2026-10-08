/**
 * Vehicle dimensions loader: packages/kb/data/vehicle-dimensions/<make-slug>.json, read lazily and cached per make.
 *
 * The directory is filled by a separate data job and may be missing, partial or mid-write: a missing file is simply
 * "no dimensions"; an unreadable or malformed file is skipped and recorded in `dimensionsLoadIssues()`; missing fields
 * inside a record are filled from body-type defaults (see normalise.ts). Nothing here throws on bad data.
 *
 * Point the loader elsewhere with `setDimensionsDataDir()` (tests) or env `VEHICLE_DIMENSIONS_DIR`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bodyCandidates,
  defaultBodyDimensions,
  generationCode,
  generationYears,
  makeSlug,
  normaliseBodyDimensions,
  normaliseProfile,
  slugText
} from './normalise.js';
import type { BodyDimensionsInput, DimensionsLoadIssue, DimensionsMakeFile, DimensionsQuery, ResolvedDimensions } from './types.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../data/vehicle-dimensions/', import.meta.url));
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

let overrideDir: string | undefined;
let cache = new Map<string, DimensionsMakeFile | null>();
let issues: DimensionsLoadIssue[] = [];

export function setDimensionsDataDir(dir: string | URL | undefined): void {
  overrideDir = dir === undefined ? undefined : dir instanceof URL ? fileURLToPath(dir) : dir;
  resetDimensionsCache();
}

export function dimensionsDataDir(): string {
  return overrideDir ?? (process.env.VEHICLE_DIMENSIONS_DIR?.trim() || DEFAULT_DIR);
}

export function resetDimensionsCache(): void {
  cache = new Map();
  issues = [];
}

export function dimensionsLoadIssues(): readonly DimensionsLoadIssue[] {
  return issues;
}

/** Make slugs with a dimensions file on disk (sorted). */
export function dimensionsMakeFiles(): string[] {
  const dir = dimensionsDataDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .filter((s) => SLUG.test(s))
      .sort();
  } catch {
    return [];
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Structural check only; individual body records are normalised on lookup. */
function parseMakeFile(raw: unknown, file: string, slug: string): DimensionsMakeFile | null {
  if (!isObj(raw)) {
    issues.push({ file, level: 'error', message: `${file}: expected an object` });
    return null;
  }
  if (!isObj(raw.models)) {
    issues.push({ file, level: 'error', message: `${file}: "models" must be an object keyed by model slug` });
    return null;
  }
  const models: DimensionsMakeFile['models'] = {};
  for (const [modelKey, gens] of Object.entries(raw.models)) {
    if (!isObj(gens)) {
      issues.push({ file, level: 'warning', message: `${file}: models.${modelKey} ignored (not an object)` });
      continue;
    }
    const outGens: DimensionsMakeFile['models'][string] = {};
    for (const [genKey, gen] of Object.entries(gens)) {
      if (!isObj(gen) || !isObj(gen.bodies)) {
        issues.push({ file, level: 'warning', message: `${file}: models.${modelKey}.${genKey} has no "bodies"` });
        continue;
      }
      const bodies: Record<string, BodyDimensionsInput> = {};
      for (const [bodyKey, b] of Object.entries(gen.bodies)) if (isObj(b)) bodies[bodyKey] = b as BodyDimensionsInput;
      if (Object.keys(bodies).length) outGens[genKey] = { bodies };
    }
    if (Object.keys(outGens).length) models[modelKey] = outGens;
  }
  const verification = isObj(raw.verification) ? (raw.verification as DimensionsMakeFile['verification']) : undefined;
  return {
    make: typeof raw.make === 'string' ? raw.make : slug,
    slug: typeof raw.slug === 'string' && SLUG.test(raw.slug) ? raw.slug : slug,
    ...(verification ? { verification } : {}),
    models
  };
}

/** One make file, structurally parsed and cached. `undefined` when missing or unreadable. */
export function getDimensionsMake(make: string): DimensionsMakeFile | undefined {
  const slug = makeSlug(make);
  if (!SLUG.test(slug)) return undefined;
  if (!cache.has(slug)) {
    const file = path.join(dimensionsDataDir(), `${slug}.json`);
    let parsed: DimensionsMakeFile | null = null;
    if (existsSync(file)) {
      try {
        parsed = parseMakeFile(JSON.parse(readFileSync(file, 'utf8')), `${slug}.json`, slug);
      } catch (err) {
        // usually a file caught mid-write: do not cache, so the next call retries
        issues.push({ file: `${slug}.json`, level: 'error', message: `${slug}.json: ${(err as Error).message}` });
        return undefined;
      }
    }
    cache.set(slug, parsed);
  }
  return cache.get(slug) ?? undefined;
}

function findModelKey(models: Record<string, unknown>, model: string, make: string): string | undefined {
  const keys = Object.keys(models);
  const bySlug = new Map(keys.map((k) => [slugText(k), k] as const));
  let q = slugText(model);
  const mk = makeSlug(make);
  if (q.startsWith(`${mk}-`)) q = q.slice(mk.length + 1);
  const exact = bySlug.get(q);
  if (exact) return exact;
  // DVLA-style model text ("fiesta-titanium-x-turbo") → longest key that prefixes it on a word boundary
  let best: string | undefined;
  let bestLen = 0;
  for (const [s, k] of bySlug) {
    if ((q.startsWith(`${s}-`) || q === s) && s.length > bestLen) {
      best = k;
      bestLen = s.length;
    }
  }
  if (best) return best;
  // "range-rover-evoque" asked as "evoque", or "transit-custom" asked as "transit custom 280"
  for (const [s, k] of bySlug) if (s.endsWith(`-${q}`) || q.endsWith(`-${s}`)) return k;
  return undefined;
}

function findGenerationKey(gens: Record<string, unknown>, generation: string | undefined, year: number | undefined): { key: string; exact: boolean } | undefined {
  const keys = Object.keys(gens);
  if (!keys.length) return undefined;
  if (generation) {
    const q = slugText(generation);
    const qc = generationCode(generation);
    const hit =
      keys.find((k) => slugText(k) === q) ??
      keys.find((k) => generationCode(k) === qc && qc !== '') ??
      keys.find((k) => slugText(k).startsWith(`${q}-`)) ??
      keys.find((k) => qc !== '' && generationCode(k).split('-').includes(qc));
    if (hit) return { key: hit, exact: true };
  }
  if (year) {
    const hit = keys.find((k) => {
      const y = generationYears(k);
      return y.from !== undefined && year >= y.from && year <= (y.to ?? y.from + 8);
    });
    if (hit) return { key: hit, exact: !generation };
  }
  // newest generation by start year, else the last listed
  const dated = keys.map((k) => ({ k, from: generationYears(k).from ?? -1 }));
  const newest = dated.reduce((a, b) => (b.from >= a.from ? b : a));
  return { key: newest.k, exact: false };
}

function findBodyKey(bodies: Record<string, BodyDimensionsInput>, body: string | undefined, doors: number | undefined): { key: string; exact: boolean } {
  const keys = Object.keys(bodies);
  const cands = bodyCandidates(body);
  const scored = keys.map((k) => {
    const s = slugText(k);
    let score = 0;
    const idx = cands.findIndex((c) => s === c || s.startsWith(`${c}-`) || s.endsWith(`-${c}`) || s.includes(`-${c}-`));
    if (idx >= 0) score += 100 - idx;
    else if (body && normaliseProfile(k) && normaliseProfile(k) === normaliseProfile(body)) score += 50;
    const kd = /(\d)-?door|door-?(\d)|(?:^|-)(\d)(?:-|$)/.exec(s);
    const rawDoors = bodies[k]!.doors;
    const keyDoors = kd ? [Number(kd[1] ?? kd[2] ?? kd[3])] : Array.isArray(rawDoors) ? rawDoors : typeof rawDoors === 'number' ? [rawDoors] : [];
    if (doors && keyDoors.includes(doors)) score += 10;
    return { k, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]!;
  return { key: top.k, exact: !body || top.score >= 50 };
}

/**
 * Dimensions for a make / model / generation / body. Falls back (and says so in `match`) to the newest generation
 * and then the first body when the exact one is not in the file. `undefined` when the make or model has no data.
 */
export function findVehicleDimensions(q: DimensionsQuery): ResolvedDimensions | undefined {
  if (!q || !q.make || !q.model) return undefined;
  const file = getDimensionsMake(q.make);
  if (!file) return undefined;
  const modelKey = findModelKey(file.models, q.model, q.make);
  if (!modelKey) return undefined;
  const gens = file.models[modelKey]!;
  const gen = findGenerationKey(gens, q.generation, q.year);
  if (!gen) return undefined;
  const bodies = gens[gen.key]!.bodies ?? {};
  if (!Object.keys(bodies).length) return undefined;
  const body = findBodyKey(bodies, q.body, q.doors);
  const { dims, filled } = normaliseBodyDimensions(bodies[body.key], body.key);
  if (q.doors && q.doors >= 2 && q.doors <= 5) {
    if (filled.includes('doors')) {
      dims.doors = q.doors;
      dims.doorOptions = [q.doors];
      filled.splice(filled.indexOf('doors'), 1);
    } else if (dims.doorOptions.includes(q.doors)) dims.doors = q.doors;
  }
  const v = file.verification;
  return {
    make: file.make,
    makeSlug: file.slug,
    model: modelKey,
    generation: gen.key,
    body: body.key,
    dims,
    filled,
    match: !gen.exact ? 'model' : body.exact ? 'exact' : 'generation',
    verification: { status: typeof v?.status === 'string' ? v.status : 'unverified', ...(typeof v?.sourceNote === 'string' ? { sourceNote: v.sourceNote } : {}) }
  };
}

/** Same as findVehicleDimensions, but always returns dimensions: body-type defaults when nothing is on file. */
export function vehicleDimensionsOrDefault(q: DimensionsQuery): ResolvedDimensions & { source: 'file' | 'default' } {
  const hit = findVehicleDimensions(q);
  if (hit) return { ...hit, source: 'file' };
  const body = q?.body ?? 'hatchback';
  const dims = defaultBodyDimensions(body);
  if (q?.doors && q.doors >= 2 && q.doors <= 5) {
    dims.doors = q.doors;
    dims.doorOptions = [q.doors];
  }
  return {
    make: q?.make ?? '',
    makeSlug: makeSlug(q?.make ?? ''),
    model: q?.model ?? '',
    generation: q?.generation ?? '',
    body,
    dims,
    filled: Object.keys(dims) as Array<keyof typeof dims>,
    match: 'model',
    verification: { status: 'unverified', sourceNote: 'Body-type defaults: no dimensions on file for this vehicle.' },
    source: 'default'
  };
}

/** Models (and their generations / bodies) in one make file — for pickers and coverage reports. */
export function listDimensionModels(make: string): Array<{ model: string; generations: Array<{ name: string; bodies: string[] }> }> {
  const file = getDimensionsMake(make);
  if (!file) return [];
  return Object.entries(file.models).map(([model, gens]) => ({
    model,
    generations: Object.entries(gens).map(([name, g]) => ({ name, bodies: Object.keys(g.bodies ?? {}) }))
  }));
}
