/**
 * Loader and query tests on the synthetic fixtures in __fixtures__/vehicle-catalogue (two makes, no index.json), plus
 * temporary directories for index.json, empty and broken data.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetKbCache } from '../load.js';
import {
  catalogueLoadIssues,
  getCatalogueMake,
  listCatalogueMakes,
  loadFeatureVocabulary,
  loadGtaSegmentDefaults,
  resetCatalogueCache,
  setCatalogueDataDir,
} from './load.js';
import { generationsForYear, getCatalogueModel, listCatalogueModels, matchCatalogue, searchCatalogue } from './query.js';

const FIXTURES = new URL('./__fixtures__/vehicle-catalogue/', import.meta.url);
const temps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'claimdesk-catalogue-'));
  temps.push(d);
  return d;
}

beforeEach(() => setCatalogueDataDir(FIXTURES));
afterAll(() => {
  setCatalogueDataDir(undefined);
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe('catalogue loader (fixtures)', () => {
  it('lists makes by reading every file when there is no index.json', () => {
    const makes = listCatalogueMakes();
    expect(makes.map((m) => m.slug)).toEqual(['ford', 'volkswagen']);
    expect(makes[0]).toMatchObject({ make: 'Ford', dvlaNames: ['FORD'], modelCount: 3, years: { from: 2000, to: null }, vehicleTypes: ['car', 'van'] });
    expect(makes[1]).toMatchObject({ make: 'Volkswagen', aliases: ['VW'], vehicleTypes: ['car'] });
  });

  it('loads a make lazily, normalised and cached', () => {
    const vw = getCatalogueMake('volkswagen');
    expect(vw?.models.map((m) => m.slug)).toEqual(['golf', 'polo', 'up']);
    expect(getCatalogueMake('volkswagen')).toBe(vw);
    const golf = vw!.models[0]!;
    expect(golf.generations.map((g) => g.id)).toEqual(['volkswagen-golf-mk7-2012-2020', 'volkswagen-golf-mk8-2020']);
    expect(golf.generations[0]!.trims.find((t) => t.id === 'gti')).toMatchObject({ gtaGroup: 'M1', features: ['sat_nav'] });
    expect(golf.generations[1]!.engines[0]).toMatchObject({ fuel: 'mild-hybrid', domainFuel: 'petrol', mildHybrid: true, cc: 1500, powerPs: 150 });
  });

  it('refuses path tricks and unknown makes', () => {
    expect(getCatalogueMake('../load')).toBeUndefined();
    expect(getCatalogueMake('nonexistent')).toBeUndefined();
  });

  it('reads the feature vocabulary', () => {
    const f = loadFeatureVocabulary();
    expect(f.schemaVersion).toBe(1);
    expect(f.categories.map((c) => c.id)).toEqual(['safety', 'infotainment', 'towing_load']);
    expect(f.categories[1]!.items[0]).toEqual({ id: 'sat_nav', label: 'Satellite navigation', aliases: ['Sat nav'], kind: 'both' });
  });

  it('reads the shipped GTA segment defaults', () => {
    resetKbCache();
    const d = loadGtaSegmentDefaults();
    expect(d.city).toBe('S1');
    expect(d['suv-small']).toBe('M1');
    expect(d['van-medium']).toBe('PV2');
    expect(Object.keys(d)).toHaveLength(19);
  });

  it('tolerates an empty or missing directory', () => {
    setCatalogueDataDir(path.join(tempDir(), 'missing'));
    expect(listCatalogueMakes()).toEqual([]);
    expect(loadFeatureVocabulary()).toEqual({ schemaVersion: 1, categories: [] });
    expect(searchCatalogue('golf')).toEqual([]);
    expect(matchCatalogue('FORD', 'FIESTA')).toEqual({ score: 0 });
  });

  it('skips an invalid make file and records why', () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, 'makes'));
    writeFileSync(path.join(dir, 'makes', 'broken.json'), JSON.stringify({ make: 'Broken', slug: 'broken', models: [{ name: 'X' }] }));
    writeFileSync(path.join(dir, 'makes', 'notjson.json'), '{');
    setCatalogueDataDir(dir);
    expect(listCatalogueMakes()).toEqual([]);
    expect(catalogueLoadIssues().filter((i) => i.level === 'error').map((i) => i.file).sort()).toEqual(['makes/broken.json', 'makes/notjson.json']);
  });

  it('uses index.json when present (only makes whose file exists)', () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, 'makes'));
    writeFileSync(path.join(dir, 'makes', 'ford.json'), JSON.stringify({ make: 'Ford', slug: 'ford', dvlaNames: ['FORD'], aliases: [], models: [] }));
    writeFileSync(
      path.join(dir, 'index.json'),
      JSON.stringify([
        { slug: 'ford', make: 'Ford', dvlaNames: ['FORD'], aliases: [], modelCount: 42, years: { from: 2000, to: null }, vehicleTypes: ['car', 'van'] },
        { slug: 'kia', make: 'Kia', dvlaNames: ['KIA'], aliases: [], modelCount: 10, years: { from: 2000, to: null }, vehicleTypes: ['car'] },
      ]),
    );
    setCatalogueDataDir(dir);
    expect(listCatalogueMakes()).toEqual([{ slug: 'ford', make: 'Ford', dvlaNames: ['FORD'], aliases: [], modelCount: 42, years: { from: 2000, to: null }, vehicleTypes: ['car', 'van'] }]);
  });

  it('resetCatalogueCache drops cached makes', () => {
    const a = getCatalogueMake('ford');
    resetCatalogueCache();
    expect(getCatalogueMake('ford')).not.toBe(a);
  });
});

describe('catalogue queries (fixtures)', () => {
  it('lists models with year and vehicle-type filters', () => {
    expect(listCatalogueModels('ford').map((m) => m.slug)).toEqual(['fiesta', 'transit', 'transit-custom']);
    expect(listCatalogueModels('ford', { vehicleType: 'van' }).map((m) => m.slug)).toEqual(['transit', 'transit-custom']);
    expect(listCatalogueModels('ford', { year: 2010 }).map((m) => m.slug)).toEqual(['fiesta', 'transit']);
    const tc = listCatalogueModels('ford').find((m) => m.slug === 'transit-custom')!;
    expect(tc).toEqual({ makeSlug: 'ford', slug: 'transit-custom', name: 'Transit Custom', vehicleType: 'van', segment: 'van-medium', years: { from: 2013, to: null }, bodies: ['panel-van', 'crew-van'] });
    expect(listCatalogueModels('nope')).toEqual([]);
  });

  it('finds a model and its generations for a year', () => {
    const golf = getCatalogueModel('volkswagen', 'golf')!;
    expect(generationsForYear(golf, 2016).map((g) => g.name)).toEqual(['Mk7 (2012–2020)']);
    expect(generationsForYear(golf, 2020).map((g) => g.name)).toEqual(['Mk7 (2012–2020)', 'Mk8 (2020–)']);
    expect(generationsForYear(golf, 2026).map((g) => g.name)).toEqual(['Mk8 (2020–)']);
    expect(generationsForYear(golf, 2005)).toEqual([]);
  });

  it('matches DVLA/TCC make and model strings', () => {
    const m = matchCatalogue('FORD', 'FIESTA ZETEC');
    expect(m.make?.slug).toBe('ford');
    expect(m.model?.slug).toBe('fiesta');
    expect(m.variantRemainder).toBe('Zetec');
    expect(m.score).toBe(1);
    expect(matchCatalogue('VW', 'GOLF GTI')).toMatchObject({ make: { slug: 'volkswagen' }, model: { slug: 'golf' }, variantRemainder: 'GTI' });
    expect(matchCatalogue('Volkswagen', 'Up')).toMatchObject({ model: { slug: 'up' } });
    expect(matchCatalogue('FORD', 'TRANSIT CUSTOM 300 LIMITED')).toMatchObject({ model: { slug: 'transit-custom' }, variantRemainder: '300 Limited' });
    expect(matchCatalogue('FORD', 'MONDEO')).toMatchObject({ make: { slug: 'ford' }, score: 0.5, variantRemainder: 'Mondeo' });
    expect(matchCatalogue('FORD')).toMatchObject({ make: { slug: 'ford' }, score: 0.5 });
    expect(matchCatalogue('TESLA', 'MODEL 3')).toEqual({ score: 0 });
  });

  it('searches make, model, trim and year', () => {
    const golfGti = searchCatalogue('golf gti 2016');
    expect(golfGti[0]).toMatchObject({ makeSlug: 'volkswagen', modelSlug: 'golf' });
    expect(golfGti.some((h) => h.trimId === 'gti' && h.generationId === 'volkswagen-golf-mk7-2012-2020')).toBe(true);
    const polo = searchCatalogue('vw polo match');
    expect(polo[0]).toMatchObject({ makeSlug: 'volkswagen', modelSlug: 'polo', trimId: 'match' });
    expect(searchCatalogue('transit custom')[0]).toMatchObject({ modelSlug: 'transit-custom' });
    expect(searchCatalogue('ford')[0]).toMatchObject({ makeSlug: 'ford' });
    expect(searchCatalogue('fies')[0]).toMatchObject({ modelSlug: 'fiesta' });
    expect(searchCatalogue('golf', 1)).toHaveLength(1);
    expect(searchCatalogue('   ')).toEqual([]);
  });
});
