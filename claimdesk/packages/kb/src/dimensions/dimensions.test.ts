import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bodyCandidates,
  defaultBodyDimensions,
  dimensionsLoadIssues,
  dimensionsMakeFiles,
  findVehicleDimensions,
  generationCode,
  generationYears,
  getDimensionsMake,
  listDimensionModels,
  makeSlug,
  normaliseBodyDimensions,
  normaliseGrilleStyle,
  normaliseLampStyle,
  normaliseProfile,
  PROFILE_DEFAULTS,
  setDimensionsDataDir,
  vehicleDimensionsOrDefault
} from './index.js';

const FIXTURES = new URL('./__fixtures__/vehicle-dimensions/', import.meta.url);

beforeEach(() => setDimensionsDataDir(FIXTURES));
afterAll(() => setDimensionsDataDir(undefined));

describe('normalisers', () => {
  it('maps free-text profiles, lamp and grille styles', () => {
    expect(normaliseProfile('5 door hatchback')).toBe('hatch');
    expect(normaliseProfile('Saloon')).toBe('saloon');
    expect(normaliseProfile('Sports Tourer')).toBe('estate');
    expect(normaliseProfile('Gran Coupe')).toBe('fastback');
    expect(normaliseProfile('coupe-SUV')).toBe('suv-coupe');
    expect(normaliseProfile('crossover')).toBe('suv');
    expect(normaliseProfile('High roof van')).toBe('van-high-roof');
    expect(normaliseProfile('panel-van')).toBe('van');
    expect(normaliseProfile('double cab pick-up')).toBe('pickup');
    expect(normaliseProfile('cabriolet')).toBe('convertible');
    expect(normaliseProfile('')).toBeUndefined();
    expect(normaliseProfile(42)).toBeUndefined();
    expect(normaliseLampStyle('full-width LED light bar')).toBe('light-bar');
    expect(normaliseLampStyle('Round')).toBe('round');
    expect(normaliseLampStyle('vertical')).toBe('tall');
    expect(normaliseLampStyle(7)).toBeUndefined();
    expect(normaliseGrilleStyle('twin kidney')).toBe('kidney');
    expect(normaliseGrilleStyle('honeycomb')).toBe('hexagonal');
    expect(normaliseGrilleStyle('blanked (EV)')).toBe('closed');
    expect(normaliseGrilleStyle('trapezoid')).toBe('trapezoid');
  });

  it('fills missing fields from the body defaults and lists them', () => {
    const { dims, filled } = normaliseBodyDimensions({ lengthMm: 4040, widthMm: 1735 }, 'hatchback');
    expect(dims.lengthMm).toBe(4040);
    expect(dims.profile).toBe('hatch');
    expect(dims.heightMm).toBe(PROFILE_DEFAULTS.hatch.heightMm);
    expect(filled).toEqual(expect.arrayContaining(['profile', 'heightMm', 'wheelbaseMm', 'lampStyle', 'doors']));
    expect(filled).not.toContain('lengthMm');
  });

  it('reconciles overhangs with the wheelbase', () => {
    const { dims } = normaliseBodyDimensions({ lengthMm: 4000, wheelbaseMm: 2500, frontOverhangRatio: 0.3, rearOverhangRatio: 0.3, profile: 'hatch' });
    expect(dims.frontOverhangRatio + dims.rearOverhangRatio + dims.wheelbaseMm / dims.lengthMm).toBeCloseTo(1, 3);
    expect(dims.frontOverhangRatio).toBeCloseTo(dims.rearOverhangRatio, 3);
    const one = normaliseBodyDimensions({ lengthMm: 4000, wheelbaseMm: 2600, frontOverhangRatio: 0.2, profile: 'hatch' }).dims;
    expect(one.rearOverhangRatio).toBeCloseTo(0.15, 3);
  });

  it('rejects out-of-range values instead of trusting them', () => {
    const { dims, filled } = normaliseBodyDimensions({ lengthMm: 40, heightMm: 99999, wheelbaseMm: 9000, doors: 9, roofTaper: 0.1, profile: 'suv' });
    expect(dims.lengthMm).toBe(PROFILE_DEFAULTS.suv.lengthMm);
    expect(dims.heightMm).toBe(PROFILE_DEFAULTS.suv.heightMm);
    expect(dims.doors).toBe(PROFILE_DEFAULTS.suv.doors);
    expect(dims.roofTaper).toBeCloseTo(0.9); // ≤ 0.5 is a fractional narrowing
    expect(filled).toEqual(expect.arrayContaining(['lengthMm', 'heightMm', 'wheelbaseMm', 'doors']));
  });

  it('treats a 2.2 m+ "van" as a high-roof van', () => {
    expect(normaliseBodyDimensions({ heightMm: 2300, profile: 'van' }).dims.profile).toBe('van-high-roof');
  });

  it('slugs, generation codes and years', () => {
    expect(makeSlug('VW')).toBe('volkswagen');
    expect(makeSlug('Mercedes')).toBe('mercedes-benz');
    expect(makeSlug('LAND ROVER')).toBe('land-rover');
    expect(generationCode('Mk8 (2017–2023)')).toBe('mk8');
    expect(generationYears('Mk8 (2017–2023)')).toEqual({ from: 2017, to: 2023 });
    expect(generationYears('Gen2 (2023–present)')).toEqual({ from: 2023, to: 9999 });
    expect(bodyCandidates('suv')).toEqual(expect.arrayContaining(['suv', 'crossover']));
    expect(defaultBodyDimensions('panel-van').profile).toBe('van');
  });
});

describe('loader', () => {
  it('lists make files and tolerates broken ones', () => {
    expect(dimensionsMakeFiles()).toEqual(['broken', 'ford', 'nomodels']);
    expect(getDimensionsMake('broken')).toBeUndefined();
    expect(getDimensionsMake('nomodels')).toBeUndefined();
    expect(getDimensionsMake('missing-make')).toBeUndefined();
    const files = dimensionsLoadIssues().map((i) => i.file);
    expect(files).toEqual(expect.arrayContaining(['broken.json', 'nomodels.json']));
  });

  it('skips malformed models and generations with a warning', () => {
    const ford = getDimensionsMake('Ford')!;
    expect(Object.keys(ford.models)).toEqual(['fiesta', 'transit-custom', 'ranger']);
    expect(dimensionsLoadIssues().some((i) => i.level === 'warning' && /broken/.test(i.message))).toBe(true);
    expect(listDimensionModels('ford').find((m) => m.model === 'fiesta')?.generations.map((g) => g.name)).toEqual(['Mk7 (2008–2017)', 'Mk8 (2017–2023)']);
  });

  it('finds the exact make / model / generation / body', () => {
    const r = findVehicleDimensions({ make: 'FORD', model: 'Fiesta', generation: 'Mk8', body: 'hatchback', doors: 5 })!;
    expect(r.generation).toBe('Mk8 (2017–2023)');
    expect(r.body).toBe('hatchback-5-door');
    expect(r.match).toBe('exact');
    expect(r.dims).toMatchObject({ lengthMm: 4040, widthMm: 1735, heightMm: 1476, wheelbaseMm: 2493, lampStyle: 'swept', grilleStyle: 'trapezoid', doors: 5 });
    expect(r.filled).toEqual([]);
    expect(r.verification.status).toBe('unverified');
  });

  it('picks the 3-door body by door count and a DVLA-style model name', () => {
    const r = findVehicleDimensions({ make: 'Ford', model: 'FIESTA ST-LINE X EDITION', generation: 'Mk8 (2017–2023)', body: 'hatchback', doors: 3 })!;
    expect(r.model).toBe('fiesta');
    expect(r.body).toBe('hatchback-3-door');
    expect(r.dims.doors).toBe(3);
  });

  it('picks a generation by year, else the newest', () => {
    expect(findVehicleDimensions({ make: 'ford', model: 'fiesta', year: 2012 })!.generation).toBe('Mk7 (2008–2017)');
    const r = findVehicleDimensions({ make: 'ford', model: 'fiesta' })!;
    expect(r.generation).toBe('Mk8 (2017–2023)');
    expect(r.match).toBe('model');
  });

  it('high-roof van by body key; bad fields filled', () => {
    const hi = findVehicleDimensions({ make: 'ford', model: 'Transit Custom', generation: 'Gen1', body: 'panel-van-high-roof' })!;
    expect(hi.dims.profile).toBe('van-high-roof');
    expect(hi.dims.heightMm).toBe(2280);
    const pick = findVehicleDimensions({ make: 'ford', model: 'ranger', body: 'pickup' })!;
    expect(pick.dims.profile).toBe('pickup');
    expect(pick.filled).toEqual(expect.arrayContaining(['lengthMm', 'heightMm', 'lampStyle']));
  });

  it('returns undefined for unknown models, defaults on request', () => {
    expect(findVehicleDimensions({ make: 'ford', model: 'model-t' })).toBeUndefined();
    expect(findVehicleDimensions({ make: 'nobody', model: 'x' })).toBeUndefined();
    const d = vehicleDimensionsOrDefault({ make: 'nobody', model: 'x', body: 'suv', doors: 3 });
    expect(d.source).toBe('default');
    expect(d.dims.profile).toBe('suv');
    expect(d.dims.doors).toBe(3);
    expect(vehicleDimensionsOrDefault({ make: 'ford', model: 'fiesta', generation: 'mk8' }).source).toBe('file');
  });

  it('reads the real data directory when present without throwing', () => {
    setDimensionsDataDir(undefined);
    for (const slug of dimensionsMakeFiles()) {
      const f = getDimensionsMake(slug);
      if (!f) continue;
      for (const [model, gens] of Object.entries(f.models)) {
        for (const gen of Object.keys(gens)) {
          const r = findVehicleDimensions({ make: slug, model, generation: gen });
          expect(r, `${slug}/${model}/${gen}`).toBeDefined();
          expect(r!.dims.wheelbaseMm).toBeLessThan(r!.dims.lengthMm);
        }
      }
    }
  });
});
