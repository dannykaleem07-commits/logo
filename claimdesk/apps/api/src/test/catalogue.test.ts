/**
 * Catalogue routes (TEMPLATES-VEHICLES-DESKTOP §D.8) against the synthetic kb fixtures (two makes) plus custom entries,
 * and GET /gta/suggest.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GtaSuggestion } from '@ccguk/domain';
import { setCatalogueDataDir, setDimensionsDataDir, type CatalogueMakeSummary, type CatalogueModelSummary, type CatalogueSearchHit, type FeatureVocabulary, type NormalisedModel } from '@ccguk/kb';
import { createTestApp, type TestApp } from './helpers.js';

const FIXTURES = new URL('../../../../packages/kb/src/catalogue/__fixtures__/vehicle-catalogue/', import.meta.url);

beforeAll(() => setCatalogueDataDir(FIXTURES));
afterAll(() => setCatalogueDataDir(undefined));

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp('2026-10-05T09:00:00.000Z');
});
afterEach(async () => {
  await t.close();
});

type Entry = { id: string; level: string; makeSlug: string; modelSlug?: string; name: string; deletedAt?: string };

describe('catalogue lists', () => {
  it('serves makes, models and model detail with a private one-hour cache', async () => {
    const makes = await t.app.inject({ method: 'GET', url: '/api/catalogue/makes' });
    expect(makes.statusCode).toBe(200);
    expect(makes.headers['cache-control']).toBe('private, max-age=3600');
    expect((makes.json() as { items: CatalogueMakeSummary[] }).items.map((m) => m.slug)).toEqual(['ford', 'volkswagen']);

    const models = await t.api<{ items: CatalogueModelSummary[] }>('GET', '/catalogue/makes/ford/models?vehicleType=van');
    expect(models.body.items.map((m) => m.slug)).toEqual(['transit', 'transit-custom']);
    const year = await t.api<{ items: CatalogueModelSummary[] }>('GET', '/catalogue/makes/volkswagen/models?year=2010');
    expect(year.body.items.map((m) => m.slug)).toEqual(['polo']);

    const golf = await t.api<NormalisedModel>('GET', '/catalogue/makes/volkswagen/models/golf');
    expect(golf.status).toBe(200);
    expect(golf.body.generations.map((g) => g.id)).toEqual(['volkswagen-golf-mk7-2012-2020', 'volkswagen-golf-mk8-2020']);
    expect((await t.api('GET', '/catalogue/makes/volkswagen/models/beetle')).status).toBe(404);
    expect((await t.api('GET', '/catalogue/makes/ford/models?vehicleType=boat')).status).toBe(400);
  });

  it('matches DVLA strings, searches and serves the features vocabulary', async () => {
    const m = await t.api<{ makeSlug?: string; modelSlug?: string; variantRemainder?: string; score: number }>('GET', '/catalogue/match?make=FORD&model=FIESTA%20ZETEC');
    expect(m.body).toEqual({ makeSlug: 'ford', modelSlug: 'fiesta', variantRemainder: 'Zetec', score: 1 });
    const s = await t.api<{ items: CatalogueSearchHit[] }>('GET', '/catalogue/search?q=vw%20polo%20match&limit=5');
    expect(s.body.items[0]).toMatchObject({ makeSlug: 'volkswagen', modelSlug: 'polo', trimId: 'match' });
    const f = await t.api<FeatureVocabulary>('GET', '/catalogue/features');
    expect(f.body.categories.map((c) => c.id)).toEqual(['safety', 'infotainment', 'towing_load']);
  });
});

describe('custom catalogue entries', () => {
  it('adds a custom make and model that appear in the lists, match and search; delete is soft and audited', async () => {
    const make = await t.api<Entry>('POST', '/catalogue/custom', { level: 'make', make: 'Lynk & Co', name: 'Lynk & Co' });
    expect(make.status).toBe(201);
    expect(make.body).toMatchObject({ level: 'make', makeSlug: 'lynk-and-co' });
    const model = await t.api<Entry>('POST', '/catalogue/custom', { level: 'model', make: 'Lynk & Co', model: '01', name: '01', segment: 'suv-medium', data: { vehicleType: 'car', years: { from: 2021, to: null } } });
    expect(model.status).toBe(201);

    const makes = await t.api<{ items: CatalogueMakeSummary[] }>('GET', '/catalogue/makes?v=1');
    expect(makes.body.items.find((m) => m.slug === 'lynk-and-co')).toMatchObject({ make: 'Lynk & Co', custom: true, modelCount: 1, vehicleTypes: ['car'] });
    const models = await t.api<{ items: CatalogueModelSummary[] }>('GET', '/catalogue/makes/lynk-and-co/models');
    expect(models.body.items).toEqual([{ makeSlug: 'lynk-and-co', slug: '01', name: '01', vehicleType: 'car', segment: 'suv-medium', years: { from: 2021, to: null }, bodies: [], custom: true }]);
    const detail = await t.api<NormalisedModel>('GET', '/catalogue/makes/lynk-and-co/models/01');
    expect(detail.body).toMatchObject({ name: '01', custom: true, segment: 'suv-medium', generations: [] });
    expect((await t.api<{ modelSlug?: string }>('GET', '/catalogue/match?make=LYNK%20%26%20CO&model=01%20PHEV')).body).toMatchObject({ makeSlug: 'lynk-and-co', modelSlug: '01', variantRemainder: 'PHEV' });
    expect((await t.api<{ items: CatalogueSearchHit[] }>('GET', '/catalogue/search?q=lynk')).body.items[0]).toMatchObject({ makeSlug: 'lynk-and-co' });

    const list = await t.api<{ items: Entry[] }>('GET', '/catalogue/custom');
    expect(list.body.items).toHaveLength(2);
    expect((await t.api('DELETE', `/catalogue/custom/${model.body.id}`)).status).toBe(204);
    expect((await t.api('DELETE', `/catalogue/custom/${model.body.id}`)).status).toBe(404);
    expect((await t.api<{ items: Entry[] }>('GET', '/catalogue/custom')).body.items.map((e) => e.id)).toEqual([make.body.id]);
    const actions = t.ctx.repos.listAudit(t.ctx.db, { entity: 'vehicle_catalogue_custom' }).map((a) => a.action).sort();
    expect(actions).toEqual(['catalogue.custom.create', 'catalogue.custom.create', 'catalogue.custom.delete']);
  });

  it('appends custom trims/engines to a shipped generation and applies overrides', async () => {
    const gen = 'ford-fiesta-mk8-2017-2023';
    expect((await t.api('POST', '/catalogue/custom', { level: 'trim', make: 'Ford', model: 'Fiesta', generationId: gen, name: 'Active X', gtaGroup: 's2' })).status).toBe(201);
    expect((await t.api('POST', '/catalogue/custom', { level: 'engine', make: 'Ford', model: 'Fiesta', generationId: gen, name: '1.1 Ti-VCT 75PS petrol' })).status).toBe(201);
    expect((await t.api('POST', '/catalogue/custom', { level: 'model', make: 'FORD', model: 'Fiesta', name: 'Fiesta', segment: 'city', overridesBuiltin: true })).status).toBe(201);
    const fiesta = await t.api<NormalisedModel>('GET', '/catalogue/makes/ford/models/fiesta');
    const g = fiesta.body.generations.find((x) => x.id === gen)!;
    expect(g.trims.at(-1)).toEqual({ id: 'active-x', name: 'Active X', gtaGroup: 'S2' });
    expect(g.engines.at(-1)).toMatchObject({ label: '1.1 Ti-VCT 75PS petrol', fuel: 'petrol', domainFuel: 'petrol', powerPs: 75 });
    expect(fiesta.body.segment).toBe('city');
    // the shipped cache itself is untouched
    t.ctx.repos.softDeleteCustomCatalogueEntry(t.ctx.db, t.ctx.repos.listCustomCatalogueEntries(t.ctx.db)[2]!.id, { userId: 'handler' });
    expect((await t.api<NormalisedModel>('GET', '/catalogue/makes/ford/models/fiesta')).body.segment).toBe('supermini');
  });

  it('validates custom entries', async () => {
    expect((await t.api('POST', '/catalogue/custom', { level: 'trim', make: 'Ford', model: 'Fiesta', name: 'X' })).status).toBe(400);
    expect((await t.api('POST', '/catalogue/custom', { level: 'model', make: 'Ford', name: 'X', gtaGroup: 'not a group' })).status).toBe(400);
    expect((await t.api('POST', '/catalogue/custom', { level: 'model', make: 'Ford', name: 'X', segment: 'family' })).status).toBe(400);
  });
});

describe('GET /gta/suggest', () => {
  it('suggests from the catalogue trim, generation, model, segment default and heuristic', async () => {
    const trim = await t.api<GtaSuggestion>('GET', '/gta/suggest?make=volkswagen&model=golf&generationId=volkswagen-golf-mk7-2012-2020&trimId=gti&date=2026-10-05');
    expect(trim.status).toBe(200);
    expect(trim.body).toMatchObject({ group: 'M1', basis: 'catalogue_trim', confidence: 'medium', segment: 'small-family', rate: { group: 'M1', period: '2026-27' } });
    expect(trim.body.note).toMatch(/not a GTA subscriber/);
    expect((await t.api<GtaSuggestion>('GET', '/gta/suggest?make=volkswagen&model=golf&generationId=volkswagen-golf-mk8-2020')).body).toMatchObject({ group: 'M', basis: 'catalogue_generation' });
    expect((await t.api<GtaSuggestion>('GET', '/gta/suggest?make=VOLKSWAGEN&model=POLO%20MATCH')).body).toMatchObject({ group: 'S1', basis: 'catalogue_model' });
    const seg = await t.api<GtaSuggestion>('GET', '/gta/suggest?make=ford&model=fiesta');
    expect(seg.body).toMatchObject({ group: 'S2', basis: 'segment_default', confidence: 'low', segment: 'supermini' });
    expect((await t.api<GtaSuggestion>('GET', '/gta/suggest?make=Ford&model=Mondeo&engineCapacityCc=1999&bodyType=Estate')).body).toMatchObject({ basis: 'heuristic', confidence: 'low' });
    expect((await t.api<GtaSuggestion>('GET', '/gta/suggest?recordedGroup=m1')).body).toMatchObject({ group: 'M1', basis: 'recorded', confidence: 'high' });
    expect((await t.api<GtaSuggestion>('GET', '/gta/suggest')).body).toMatchObject({ group: null, basis: 'none', rate: null });
  });

  it('uses custom overrides and segment overrides, and says when no rate is loaded', async () => {
    await t.api('POST', '/catalogue/custom', { level: 'model', make: 'Ford', model: 'Fiesta', name: 'Fiesta', gtaGroup: 'S1', overridesBuiltin: true });
    expect((await t.api<GtaSuggestion>('GET', '/gta/suggest?make=ford&model=fiesta')).body).toMatchObject({ group: 'S1', basis: 'custom_override', confidence: 'medium' });
    await t.api('PUT', '/settings/gta-segments/van-medium', { group: 'CP1' });
    const van = await t.api<GtaSuggestion>('GET', '/gta/suggest?make=ford&model=transit-custom&date=2026-10-05');
    expect(van.body).toMatchObject({ group: 'CP1', basis: 'segment_default', rate: null });
    expect(van.body.reason).toContain('No benchmark rate is loaded for group CP1 on 2026-10-05 — add it in Settings → GTA benchmark rates');
    expect((await t.api('GET', '/gta/suggest?date=05/10/2026')).status).toBe(400);
  });
});

describe('GET /catalogue/dimensions', () => {
  const DIMS = new URL('../../../../packages/kb/src/dimensions/__fixtures__/vehicle-dimensions/', import.meta.url);
  beforeAll(() => setDimensionsDataDir(DIMS));
  afterAll(() => setDimensionsDataDir(undefined));
  type Resolved = { dims: { lengthMm: number; doors: number; profile: string }; source: 'file' | 'default'; match: string; generation: string; body: string };

  it('returns the dimensions on file for a make / model / generation / body', async () => {
    const r = await t.api<Resolved>('GET', `/catalogue/dimensions?make=Ford&model=Fiesta&generation=${encodeURIComponent('Mk8 (2017–2023)')}&body=hatchback&doors=3`);
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('file');
    expect(r.body.generation).toBe('Mk8 (2017–2023)');
    expect(r.body.body).toBe('hatchback-3-door');
    expect(r.body.dims).toMatchObject({ lengthMm: 4040, doors: 3, profile: 'hatch' });
  });

  it('falls back to body-type defaults when nothing is on file, and rejects bad door counts', async () => {
    const r = await t.api<Resolved>('GET', '/catalogue/dimensions?make=Nonesuch&model=Phantom&body=estate&doors=5');
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('default');
    expect(r.body.dims.doors).toBe(5);
    expect(typeof r.body.dims.lengthMm).toBe('number');
    expect((await t.api('GET', '/catalogue/dimensions?make=Ford&model=Fiesta&doors=9')).status).toBe(400);
  });
});
