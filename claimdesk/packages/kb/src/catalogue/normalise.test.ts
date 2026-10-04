import { describe, expect, it } from 'vitest';
import { KbValidationError } from '../load.js';
import { catalogueFuelToDomain, normaliseCatalogueMake, parseEngineLabel, slugify, validateCatalogueMake } from './normalise.js';

describe('slugify (copied from §A.4)', () => {
  it('matches the normative behaviour', () => {
    expect(slugify('Mercedes-Benz')).toBe('mercedes-benz');
    expect(slugify('Citroën')).toBe('citroen');
    expect(slugify('Mk7 (2012–2020)')).toBe('mk7-2012-2020');
    expect(slugify('up!')).toBe('up');
    expect(slugify('Rock & Roll + £5')).toBe('rock-and-roll-plus-gbp-5');
    expect(slugify('!!!')).toBe('x');
    expect(slugify('a'.repeat(60))).toHaveLength(48);
  });
});

describe('parseEngineLabel', () => {
  it('parses litres, name words, power and fuel', () => {
    expect(parseEngineLabel('1.0 EcoBoost 125PS petrol')).toEqual({ id: '1-0-ecoboost-125ps-petrol', label: '1.0 EcoBoost 125PS petrol', fuel: 'petrol', domainFuel: 'petrol', cc: 1000, ccApprox: true, powerPs: 125 });
    expect(parseEngineLabel('2.0 TDI 150PS diesel')).toMatchObject({ fuel: 'diesel', domainFuel: 'diesel', cc: 2000, powerPs: 150 });
  });
  it('reads hybrid variants in either word order', () => {
    expect(parseEngineLabel('2.0 EcoBlue 130PS mild-hybrid diesel')).toMatchObject({ fuel: 'mild-hybrid', domainFuel: 'diesel', mildHybrid: true });
    expect(parseEngineLabel('2.0 TDI 163PS diesel mild-hybrid')).toMatchObject({ fuel: 'mild-hybrid', domainFuel: 'diesel', mildHybrid: true });
    expect(parseEngineLabel('1.5 TFSI 150PS petrol mild-hybrid')).toMatchObject({ fuel: 'mild-hybrid', domainFuel: 'petrol' });
    expect(parseEngineLabel('1.4 TSI 204PS plug-in-hybrid')).toMatchObject({ fuel: 'plug-in-hybrid', domainFuel: 'plugin_hybrid' });
    expect(parseEngineLabel('1.4 TFSI e 204PS petrol plug-in-hybrid')).toMatchObject({ fuel: 'plug-in-hybrid', domainFuel: 'plugin_hybrid' });
    expect(parseEngineLabel('2.0 TFSI hybrid 245PS petrol hybrid')).toMatchObject({ fuel: 'hybrid', domainFuel: 'hybrid' });
    expect(parseEngineLabel('i3 REx 170PS electric petrol')).toMatchObject({ fuel: 'plug-in-hybrid', domainFuel: 'plugin_hybrid' });
  });
  it('reads electric engines with a battery size and no litres', () => {
    const e = parseEngineLabel('ID.3 Pro 58kWh 204PS electric');
    expect(e).toMatchObject({ fuel: 'electric', domainFuel: 'electric', batteryKwh: 58, powerPs: 204 });
    expect(e.cc).toBeUndefined();
    expect(parseEngineLabel('Model 3 Long Range 498PS electric')).toMatchObject({ fuel: 'electric', powerPs: 498 });
  });
  it('maps hydrogen and lpg', () => {
    expect(parseEngineLabel('Mirai 182PS hydrogen')).toMatchObject({ fuel: 'hydrogen', domainFuel: 'other' });
    expect(parseEngineLabel('1.0 TCe 100PS lpg')).toMatchObject({ fuel: 'lpg', domainFuel: 'lpg' });
    expect(parseEngineLabel('1.0 TCe 100PS lpg bi-fuel')).toMatchObject({ fuel: 'lpg', domainFuel: 'lpg', powerPs: 100 });
  });
  it('tolerates a qualifier after the fuel', () => {
    expect(parseEngineLabel('1.5 TGDI SHS-P plug-in-hybrid AWD')).toMatchObject({ fuel: 'plug-in-hybrid', domainFuel: 'plugin_hybrid', cc: 1500 });
    expect(parseEngineLabel('85/90kWh P85D/P90D Performance electric dual-motor')).toMatchObject({ fuel: 'electric' });
  });
  it('throws when there is no fuel', () => {
    expect(() => parseEngineLabel('2.0 TDI 150PS')).toThrow(KbValidationError);
    expect(() => parseEngineLabel('')).toThrow(KbValidationError);
  });
});

describe('catalogueFuelToDomain', () => {
  it('maps every catalogue fuel', () => {
    expect(catalogueFuelToDomain('mild-hybrid')).toEqual({ fuel: 'petrol', mildHybrid: true });
    expect(catalogueFuelToDomain('plug-in-hybrid')).toEqual({ fuel: 'plugin_hybrid' });
    expect(catalogueFuelToDomain('hydrogen')).toEqual({ fuel: 'other' });
    expect(catalogueFuelToDomain('electric')).toEqual({ fuel: 'electric' });
  });
});

const make = (over: Record<string, unknown> = {}, model: Record<string, unknown> = {}, gen: Record<string, unknown> = {}) => ({
  make: 'Test Make',
  slug: 'test-make',
  dvlaNames: ['TEST MAKE'],
  aliases: [],
  verification: { status: 'unverified', sourceNote: 'synthetic' },
  models: [
    {
      name: 'Alpha',
      slug: 'alpha',
      aliases: [],
      vehicleType: 'car',
      segment: 'supermini',
      years: { from: 2010, to: null },
      generations: [
        { name: 'Mk1 (2010–2015)', from: 2010, to: 2015, bodies: [{ body: 'hatchback', doors: [3, 5], seats: [5] }], trims: ['S', 'SE', { name: 'SE', gtaGroup: 'S2' }], engines: ['1.2 70PS petrol', '1.2 70PS petrol'], fuels: ['petrol'], transmissions: ['manual'], ...gen },
      ],
      ...model,
    },
  ],
  ...over,
});

describe('validateCatalogueMake', () => {
  it('accepts a valid compact make file', () => {
    expect(validateCatalogueMake(make(), 'test.json').models).toHaveLength(1);
  });
  it('defaults a missing verification block to unverified and refuses any other status', () => {
    const { verification: _v, ...rest } = make();
    expect(validateCatalogueMake(rest, 'x.json').verification.status).toBe('unverified');
    expect(() => validateCatalogueMake(make({ verification: { status: 'verified', sourceNote: 'x' } }), 'x.json')).toThrow(/always 'unverified'/);
  });
  it('rejects structural errors with a path', () => {
    expect(() => validateCatalogueMake(make({ slug: 'Bad Slug' }), 'x.json')).toThrow(/x\.json\.slug/);
    expect(() => validateCatalogueMake(make({}, { segment: 'family' }), 'x.json')).toThrow(/segment/);
    expect(() => validateCatalogueMake(make({}, {}, { engines: ['1.2 70PS'] }), 'x.json')).toThrow(/engines\[0\]/);
    expect(() => validateCatalogueMake(make({}, { years: { from: 1998, to: null } }), 'x.json')).toThrow(/years\.from/);
    expect(() => validateCatalogueMake(make({}, { gtaGroup: 'm1' }), 'x.json')).toThrow(/gtaGroup/);
    expect(() => validateCatalogueMake(make({}, {}, { transmissions: [] }), 'x.json')).toThrow(/transmissions/);
  });
  it('quality rules throw in strict mode and become warnings otherwise', () => {
    const bad = make({}, {}, { trims: [], bodies: [{ body: 'hatchback', doors: [6], seats: [5] }] });
    expect(() => validateCatalogueMake(bad, 'x.json')).toThrow(KbValidationError);
    const warnings: string[] = [];
    expect(validateCatalogueMake(bad, 'x.json', { strict: false, warnings }).models).toHaveLength(1);
    expect(warnings.some((w) => /doors/.test(w))).toBe(true);
    expect(warnings.some((w) => /at least one trim/.test(w))).toBe(true);
  });
  it('rejects duplicate model slugs', () => {
    const m = make();
    const models = [...(m.models as unknown[]), ...(m.models as unknown[])];
    expect(() => validateCatalogueMake({ ...m, models }, 'x.json')).toThrow(/duplicate model slug/);
  });
});

describe('normaliseCatalogueMake', () => {
  it('derives generation ids and unique trim/engine ids', () => {
    const n = normaliseCatalogueMake(validateCatalogueMake(make(), 'x.json'));
    const g = n.models[0]!.generations[0]!;
    expect(g.id).toBe('test-make-alpha-mk1-2010-2015');
    expect(g.trims.map((t) => t.id)).toEqual(['s', 'se', 'se-2']);
    expect(g.trims[2]).toMatchObject({ name: 'SE', gtaGroup: 'S2' });
    expect(g.engines.map((e) => e.id)).toEqual(['1-2-70ps-petrol', '1-2-70ps-petrol-2']);
    expect(n.models[0]!.makeSlug).toBe('test-make');
  });
  it('keeps an explicit generation id', () => {
    const n = normaliseCatalogueMake(validateCatalogueMake(make({}, {}, { id: 'custom-id' }), 'x.json'));
    expect(n.models[0]!.generations[0]!.id).toBe('custom-id');
  });
});
