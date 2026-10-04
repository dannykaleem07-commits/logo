/**
 * The shipped vehicle catalogue data (packages/kb/data/vehicle-catalogue, TEMPLATES-VEHICLES-DESKTOP §D.1–§D.4): the
 * plain-Node checker and index builder pass, every make file validates, the Appendix 3 makes are present, the spot
 * checks hold and features.json has the §D.3 shape with unique ids. The data stays `unverified`.
 *
 * Runtime API: `validateCatalogueMake`, `listCatalogueMakes`, `getCatalogueModel` and `loadFeatureVocabulary` come from
 * './index.js' (the vehicles-backend loader, written in parallel with this data). The module is imported dynamically;
 * when it is missing or one of those exports is not a function, the test falls back to reading the JSON files with
 * node:fs (and to the plain-Node checker for validation), so the data checks pass either way. `usingRuntimeApi`
 * records which path ran.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Paths, raw file access and the plain-Node scripts
// ---------------------------------------------------------------------------

const KB = fileURLToPath(new URL('../../', import.meta.url));
const DIR = path.join(KB, 'data/vehicle-catalogue');
const MAKES = path.join(DIR, 'makes');
const node = (script: string, ...args: string[]) =>
  execFileSync(process.execPath, [path.join(KB, 'scripts', script), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });

type Rec = Record<string, unknown>;
type RawEngine = string | { label: string; fuel: string };
type RawTrim = string | { name: string };
interface ModelLike {
  name: string;
  slug: string;
  aliases: string[];
  vehicleType: string;
  segment: string;
  years: { from: number; to: number | null };
  generations: Array<{ name: string; fuels: string[]; transmissions: string[]; trims: RawTrim[]; engines: RawEngine[] }>;
}
interface FeatureVocabularyLike {
  schemaVersion: number;
  categories: Array<{ id: string; label: string; items: Array<{ id: string; label: string; kind: string; aliases?: string[] }> }>;
}

const files = readdirSync(MAKES).filter((f) => f.endsWith('.json')).sort();
const rawCache = new Map<string, Rec>();
const readMake = (file: string): Rec => {
  if (!rawCache.has(file)) rawCache.set(file, JSON.parse(readFileSync(path.join(MAKES, file), 'utf8')) as Rec);
  return rawCache.get(file)!;
};
/** §D.2 grammar: the fuel is the last token, or `mild-hybrid` when the last two are `mild-hybrid petrol|diesel`. */
const engineFuel = (e: RawEngine): string => {
  if (typeof e !== 'string') return e.fuel;
  const t = e.trim().split(/\s+/);
  return t.length > 1 && t[t.length - 2] === 'mild-hybrid' ? 'mild-hybrid' : t[t.length - 1]!;
};
const trimName = (t: RawTrim): string => (typeof t === 'string' ? t : t.name);

// ---------------------------------------------------------------------------
// Runtime API (./index.js) with a node:fs fallback
// ---------------------------------------------------------------------------

interface CatalogueApi {
  validateCatalogueMake?: (raw: unknown, file: string, opts?: { strict?: boolean; warnings?: string[] }) => unknown;
  listCatalogueMakes: () => Array<{ slug: string; make: string; modelCount: number }>;
  getCatalogueModel: (makeSlug: string, modelSlug: string) => ModelLike | undefined;
  loadFeatureVocabulary: () => FeatureVocabularyLike;
  matchCatalogue?: (make: string, model?: string) => { make?: { slug: string }; model?: { slug: string } };
  resetCatalogueCache?: () => void;
  setCatalogueDataDir?: (dir: string | undefined) => void;
  catalogueLoadIssues?: () => ReadonlyArray<{ file: string; level: string; message: string }>;
}

const fallbackApi: CatalogueApi = {
  listCatalogueMakes: () =>
    files.map((f) => {
      const raw = readMake(f);
      return { slug: String(raw.slug), make: String(raw.make), modelCount: (raw.models as unknown[]).length };
    }),
  getCatalogueModel: (makeSlug, modelSlug) => {
    const f = `${makeSlug}.json`;
    if (!files.includes(f)) return undefined;
    return (readMake(f).models as ModelLike[]).find((m) => m.slug === modelSlug);
  },
  loadFeatureVocabulary: () => JSON.parse(readFileSync(path.join(DIR, 'features.json'), 'utf8')) as FeatureVocabularyLike,
};

let api: CatalogueApi = fallbackApi;
let usingRuntimeApi = false;

beforeAll(async () => {
  let mod: Rec | undefined;
  try {
    mod = (await import('./index.js')) as unknown as Rec;
  } catch {
    mod = undefined;
  }
  const fn = <T>(name: string): T | undefined => (typeof mod?.[name] === 'function' ? (mod[name] as T) : undefined);
  const required = ['validateCatalogueMake', 'listCatalogueMakes', 'getCatalogueModel', 'loadFeatureVocabulary'];
  if (mod && required.every((n) => fn(n))) {
    usingRuntimeApi = true;
    api = {
      validateCatalogueMake: fn('validateCatalogueMake'),
      listCatalogueMakes: fn('listCatalogueMakes')!,
      getCatalogueModel: fn('getCatalogueModel')!,
      loadFeatureVocabulary: fn('loadFeatureVocabulary')!,
      matchCatalogue: fn('matchCatalogue'),
      resetCatalogueCache: fn('resetCatalogueCache'),
      setCatalogueDataDir: fn('setCatalogueDataDir'),
      catalogueLoadIssues: fn('catalogueLoadIssues'),
    };
    api.setCatalogueDataDir?.(undefined); // the shipped data directory, not a fixture
    api.resetCatalogueCache?.();
  }
});

// ---------------------------------------------------------------------------
// Appendix 3
// ---------------------------------------------------------------------------

const APPENDIX_3 = [
  'volkswagen', 'skoda', 'seat', 'cupra', 'ford', 'vauxhall', 'audi', 'bmw', 'mini', 'mercedes-benz', 'smart', 'porsche',
  'volvo', 'polestar', 'saab', 'toyota', 'lexus', 'honda', 'nissan', 'mazda', 'mitsubishi', 'subaru', 'suzuki', 'daihatsu',
  'infiniti', 'isuzu', 'hyundai', 'kia', 'genesis', 'ssangyong', 'daewoo', 'chevrolet', 'mg', 'byd', 'omoda', 'jaecoo', 'gwm',
  'great-wall', 'proton', 'perodua', 'tata', 'leapmotor', 'xpeng', 'ldv', 'peugeot', 'citroen', 'ds', 'renault', 'dacia',
  'alpine', 'fiat', 'abarth', 'alfa-romeo', 'chrysler', 'jeep', 'dodge', 'cadillac', 'iveco', 'jaguar', 'land-rover', 'rover',
  'levc', 'lotus', 'aston-martin', 'bentley', 'rolls-royce', 'mclaren', 'morgan', 'caterham', 'ineos', 'tesla', 'ferrari',
  'lamborghini', 'maserati',
];
const FEATURE_CATEGORIES = [
  'safety', 'driver_assistance', 'parking', 'lighting', 'climate', 'seats_interior', 'infotainment', 'exterior', 'wheels_tyres',
  'security', 'towing_load', 'ev_charging', 'accessibility', 'performance', 'commercial',
];

// ---------------------------------------------------------------------------
// Make files
// ---------------------------------------------------------------------------

describe('vehicle catalogue data', () => {
  it('passes scripts/check-catalogue.mjs (exit 0, no schema errors in any file)', () => {
    expect(node('check-catalogue.mjs', '--quiet')).toMatch(/OK: no schema errors/);
    const report = JSON.parse(node('check-catalogue.mjs', '--json')) as { errors: string[]; rows: Array<{ slug: string; errors: number }> };
    expect(report.errors).toEqual([]);
    expect(report.rows.map((r) => `${r.slug}.json`).sort()).toEqual(files);
    for (const r of report.rows) expect(r.errors, r.slug).toBe(0);
  });

  it('has an up-to-date index.json (scripts/build-catalogue-index.mjs --check)', () => {
    expect(node('build-catalogue-index.mjs', '--check')).toMatch(/up to date/);
  });

  it('validates every make file with validateCatalogueMake (strict) when the runtime module is present', () => {
    if (!api.validateCatalogueMake) {
      // Fallback: the plain-Node checker above validated every file against the same §D.2 rules.
      expect(usingRuntimeApi).toBe(false);
      return;
    }
    const failures: string[] = [];
    for (const f of files) {
      try {
        api.validateCatalogueMake(readMake(f), `makes/${f}`, { strict: true, warnings: [] });
      } catch (err) {
        failures.push(`${f}: ${(err as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('has at least 70 makes, one file per slug', () => {
    expect(files.length).toBeGreaterThanOrEqual(70);
    for (const f of files) expect(readMake(f).slug, f).toBe(f.slice(0, -5));
    const listed = api.listCatalogueMakes();
    expect(listed.length).toBeGreaterThanOrEqual(70);
    expect(new Set(listed.map((m) => m.slug)).size).toBe(listed.length);
  });

  it('has every Appendix 3 make', () => {
    const slugs = new Set(files.map((f) => f.slice(0, -5)));
    const listed = new Set(api.listCatalogueMakes().map((m) => m.slug));
    expect(APPENDIX_3).toHaveLength(74);
    for (const s of APPENDIX_3) {
      expect(slugs.has(s), `makes/${s}.json`).toBe(true);
      expect(listed.has(s), `listCatalogueMakes() ${s}`).toBe(true);
    }
  });

  it('marks every make unverified with a source note', () => {
    for (const f of files) {
      const v = readMake(f).verification as { status: string; sourceNote: string };
      expect(v.status, f).toBe('unverified');
      expect(v.sourceNote.length, f).toBeGreaterThan(20);
    }
  });

  it('carries the Appendix 3 / §D.4 DVLA spellings (and Opel is not a UK make)', () => {
    const dvla = (slug: string) => (readMake(`${slug}.json`).dvlaNames as string[]) ?? [];
    expect(dvla('ssangyong')).toEqual(expect.arrayContaining(['SSANGYONG', 'KGM']));
    expect(dvla('gwm')).toEqual(expect.arrayContaining(['GWM', 'ORA']));
    expect(dvla('ldv')).toEqual(expect.arrayContaining(['LDV', 'MAXUS']));
    expect(dvla('land-rover')).toContain('LAND ROVER');
    expect(dvla('mercedes-benz')).toContain('MERCEDES-BENZ');
    expect(dvla('citroen')).toContain('CITROEN');
    expect(files).not.toContain('opel.json');
  });

  it('keeps each generation fuel list equal to the union of its engine fuels', () => {
    const failures: string[] = [];
    for (const f of files) {
      for (const m of readMake(f).models as ModelLike[]) {
        for (const g of m.generations) {
          const fromEngines = [...new Set(g.engines.map(engineFuel))].sort();
          if (fromEngines.join() !== [...g.fuels].sort().join()) failures.push(`${f} ${m.slug} ${g.name}: ${g.fuels} vs ${fromEngines}`);
          if (g.fuels.length === 1 && g.fuels[0] === 'electric' && g.transmissions.join() !== 'automatic') {
            failures.push(`${f} ${m.slug} ${g.name}: electric-only generation must be automatic only`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('loads through the runtime loader without load errors (when present)', () => {
    if (!usingRuntimeApi || !api.catalogueLoadIssues) return;
    api.resetCatalogueCache?.();
    for (const s of api.listCatalogueMakes()) expect(api.getCatalogueModel(s.slug, '__none__')).toBeUndefined();
    expect(api.catalogueLoadIssues().filter((i) => i.level === 'error')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Spot checks
// ---------------------------------------------------------------------------

describe('catalogue spot checks', () => {
  const model = (make: string, slug: string): ModelLike => {
    const m = api.getCatalogueModel(make, slug);
    expect(m, `${make}/${slug}`).toBeDefined();
    return m!;
  };

  it('ford/fiesta: UK sale years 2000–2023', () => {
    const m = model('ford', 'fiesta');
    expect(m.vehicleType).toBe('car');
    expect(m.years).toEqual({ from: 2000, to: 2023 });
  });

  it('volkswagen/golf: generations Mk4 to Mk8', () => {
    const names = model('volkswagen', 'golf').generations.map((g) => g.name);
    for (const mk of ['Mk4', 'Mk5', 'Mk6', 'Mk7', 'Mk8']) {
      expect(names.some((n) => n.startsWith(`${mk} `) || n.startsWith(`${mk}.`)), mk).toBe(true);
    }
  });

  it('vauxhall/corsa: includes the Corsa-e electric', () => {
    const m = model('vauxhall', 'corsa');
    expect(m.aliases).toContain('Corsa-e');
    const electric = m.generations.filter((g) => g.fuels.includes('electric'));
    expect(electric.length).toBeGreaterThan(0);
    expect(electric.flatMap((g) => g.engines.map(engineFuel))).toContain('electric');
  });

  it('tesla/model-3: electric and automatic only', () => {
    const m = model('tesla', 'model-3');
    expect(m.generations.length).toBeGreaterThan(0);
    for (const g of m.generations) {
      expect(g.fuels, g.name).toEqual(['electric']);
      expect(g.transmissions, g.name).toEqual(['automatic']);
      for (const e of g.engines) expect(engineFuel(e), g.name).toBe('electric');
    }
  });

  it('land-rover/range-rover-evoque: Range Rover models are Land Rover models', () => {
    const m = model('land-rover', 'range-rover-evoque');
    expect(m.name).toBe('Range Rover Evoque');
    expect(files).not.toContain('range-rover.json');
  });

  it('toyota/hilux: a pickup', () => {
    const m = model('toyota', 'hilux');
    expect(m.vehicleType).toBe('pickup');
    expect(m.segment).toBe('pickup');
  });

  it('ford/transit-custom: a van', () => {
    const m = model('ford', 'transit-custom');
    expect(m.vehicleType).toBe('van');
    expect(m.generations.flatMap((g) => g.trims.map(trimName)).length).toBeGreaterThan(0);
  });

  it('matches DVLA-style make/model text (when the runtime matcher is present)', () => {
    if (!api.matchCatalogue) return;
    api.resetCatalogueCache?.();
    const hit = (make: string, model: string) => {
      const r = api.matchCatalogue!(make, model);
      return `${r.make?.slug ?? '-'}/${r.model?.slug ?? '-'}`;
    };
    expect(hit('FORD', 'FIESTA ZETEC')).toBe('ford/fiesta');
    expect(hit('MAXUS', 'DELIVER 9')).toMatch(/^ldv\//);
    expect(hit('KGM', 'TORRES')).toMatch(/^ssangyong\//);
    expect(hit('ORA', 'FUNKY CAT')).toMatch(/^gwm\//);
    expect(hit('RENAULT', '5 ICONIC E-TECH EV')).toBe('renault/5-e-tech');
    expect(hit('MERCEDES-BENZ', 'AMG C 63 S E PERFORMANCE')).toBe('mercedes-benz/c-class');
    expect(hit('LAND ROVER', 'RANGE ROVER EVOQUE')).toBe('land-rover/range-rover-evoque');
  });
});

// ---------------------------------------------------------------------------
// features.json (§D.3)
// ---------------------------------------------------------------------------

describe('features.json (§D.3)', () => {
  const raw = JSON.parse(readFileSync(path.join(DIR, 'features.json'), 'utf8')) as FeatureVocabularyLike;
  const items = raw.categories.flatMap((c) => c.items);

  it('exists next to the make files', () => {
    expect(existsSync(path.join(DIR, 'features.json'))).toBe(true);
  });

  it('has schemaVersion 1 and exactly the 15 category ids', () => {
    expect(raw.schemaVersion).toBe(1);
    expect(raw.categories.map((c) => c.id).sort()).toEqual([...FEATURE_CATEGORIES].sort());
    for (const c of raw.categories) expect(c.label.trim().length, c.id).toBeGreaterThan(0);
  });

  it('has at least 150 items with unique ids, a label and a kind', () => {
    expect(items.length).toBeGreaterThanOrEqual(150);
    const ids = items.map((i) => i.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    for (const i of items) {
      expect(Object.keys(i).every((k) => ['id', 'label', 'aliases', 'kind'].includes(k)), i.id).toBe(true);
      expect(['feature', 'extra', 'both'], i.id).toContain(i.kind);
      expect(i.label.trim().length, i.id).toBeGreaterThan(0);
    }
  });

  it('includes the §D.3 example ids', () => {
    const ids = new Set(items.map((i) => i.id));
    for (const id of ['aeb', 'adaptive_cruise', 'lane_keep_assist', 'blind_spot', 'rear_camera', '360_camera', 'parking_sensors_front',
      'led_headlights', 'matrix_led', 'climate_control_dual', 'heated_seats_front', 'heated_steering_wheel', 'leather', 'electric_seats',
      'sat_nav', 'apple_carplay', 'android_auto', 'dab', 'bluetooth', 'panoramic_roof', 'sunroof', 'privacy_glass', 'alloy_wheels_17',
      'alloy_wheels_18', 'run_flat_tyres', 'spare_wheel', 'alarm', 'tracker', 'tow_bar', 'roof_rails', 'roof_bars', 'type2_cable',
      'three_pin_cable', 'heat_pump', 'wheelchair_access', 'hand_controls', 'swivel_seat', 'dash_cam', 'ply_lining', 'roof_rack',
      'tail_lift']) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('loads through loadFeatureVocabulary with the same items and unique ids', () => {
    api.resetCatalogueCache?.();
    const v = api.loadFeatureVocabulary();
    expect(v.categories).toHaveLength(15);
    const loaded = v.categories.flatMap((c) => c.items.map((i) => i.id));
    expect(loaded).toHaveLength(items.length);
    expect(new Set(loaded).size).toBe(loaded.length);
  });

  it('only references known feature ids from trims', () => {
    const known = new Set(items.map((i) => i.id));
    const unknown: string[] = [];
    for (const f of files) {
      for (const m of readMake(f).models as ModelLike[]) {
        for (const g of m.generations) {
          for (const t of g.trims) {
            if (typeof t === 'string') continue;
            for (const id of (t as { features?: string[] }).features ?? []) if (!known.has(id)) unknown.push(`${f} ${m.slug} ${t.name}: ${id}`);
          }
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});
