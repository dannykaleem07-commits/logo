/**
 * Fleet: GTA pre-fill on POST /fleet, provenance LookupRecords, vehicle changes on PATCH /fleet/:id and the keeper
 * address fallback (TEMPLATES-VEHICLES-DESKTOP §F.2). Catalogue facts come from the synthetic kb fixtures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FleetUnit, GtaSuggestion, Vehicle } from '@ccguk/domain';
import { setCatalogueDataDir } from '@ccguk/kb';
import { CCGUK_REGISTERED_OFFICE_LINES, registeredOfficeLines } from '../routes/fleet.js';
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

type UnitView = FleetUnit & { vehicle: Vehicle; gtaSuggestion?: GtaSuggestion; warnings?: Array<{ code: string; field: string }> };
type ErrorBody = { error: { code: string; message: string; details?: { suggestion?: GtaSuggestion } } };

const golfGti = {
  registration: 'GT17 GTI',
  make: 'Volkswagen',
  model: 'Golf',
  variant: 'GTI',
  bodyType: 'Hatchback',
  engineCapacityCc: 1984,
  fuelType: 'petrol',
  spec: { catalogue: { makeSlug: 'volkswagen', modelSlug: 'golf', generationId: 'volkswagen-golf-mk7-2012-2020', trimId: 'gti' }, segment: 'small-family', features: ['sat_nav'], extras: [] },
};

describe('POST /fleet GTA pre-fill', () => {
  it('fills gtaGroup and dailyRatePence from the suggestion and records a catalogue LookupRecord', async () => {
    const res = await t.api<UnitView>('POST', '/fleet', { vehicle: golfGti, declaredUses: ['credit_hire'], gtaSuggestion: { group: 'M1', basis: 'catalogue_trim', rateGroup: 'M1', ratePeriod: '2026-27' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ gtaGroup: 'M1', dailyRatePence: 6549, gtaSuggestion: { group: 'M1', basis: 'catalogue_trim' } });
    expect(res.body.vehicle).toMatchObject({ registration: 'GT17GTI', ownership: 'fleet', gtaGroup: 'M1', spec: { catalogue: { trimId: 'gti' } } });
    expect(res.body.vehicle.lookups).toHaveLength(1);
    expect(res.body.vehicle.lookups[0]).toMatchObject({
      provider: 'catalogue',
      kind: 'spec',
      raw: { source: 'catalogue', gtaSuggestion: { group: 'M1', basis: 'catalogue_trim', rateGroup: 'M1', ratePeriod: '2026-27' } },
      verification: { status: 'unverified' },
    });
    const audit = t.ctx.repos.listAudit(t.ctx.db, { action: 'fleet_unit.create' })[0]!;
    expect(audit.after).toMatchObject({ gtaGroup: 'M1', dailyRatePence: 6549 });
  });

  it('uses the benchmark rate for a group the user chose, and keeps explicit values', async () => {
    const chosen = await t.api<UnitView>('POST', '/fleet', { vehicle: { registration: 'AB18 SML', make: 'Ford', model: 'Fiesta' }, declaredUses: ['credit_hire'], gtaGroup: 's1' });
    expect(chosen.status).toBe(201);
    expect(chosen.body).toMatchObject({ gtaGroup: 'S1', dailyRatePence: 4232 });
    expect(chosen.body.vehicle.lookups[0]).toMatchObject({ provider: 'manual', kind: 'vehicle', verification: { status: 'unverified' } });
    const explicit = await t.api<UnitView>('POST', '/fleet', { vehicle: { registration: 'AB18 EXP', make: 'Ford', model: 'Fiesta', source: { provider: 'totalcarcheck_manual', url: 'https://totalcarcheck.co.uk/FreeCheck?regno=AB18EXP' } }, declaredUses: ['credit_hire'], gtaGroup: 'S2', dailyRatePence: 3999 });
    expect(explicit.body).toMatchObject({ gtaGroup: 'S2', dailyRatePence: 3999 });
    expect(explicit.body.gtaSuggestion).toBeUndefined();
    expect(explicit.body.vehicle.lookups[0]).toMatchObject({ provider: 'totalcarcheck_manual', raw: { source: 'totalcarcheck_paste' } });
  });

  it('answers 422 GTA_SUGGESTION_UNAVAILABLE when no group or no rate results', async () => {
    const unknown = await t.api<ErrorBody>('POST', '/fleet', { vehicle: { registration: 'AB18 UNK' }, declaredUses: ['credit_hire'] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error).toMatchObject({ code: 'GTA_SUGGESTION_UNAVAILABLE', message: 'Choose a GTA group and daily rate' });
    expect(unknown.body.error.details?.suggestion).toMatchObject({ basis: 'none' });
    // Transit Custom → van-medium → PV2, which has no 2026-27 benchmark rate in the KB file.
    const van = await t.api<ErrorBody>('POST', '/fleet', { vehicle: { registration: 'VN20 VAN', make: 'Ford', model: 'Transit Custom', spec: { catalogue: { makeSlug: 'ford', modelSlug: 'transit-custom' }, features: [], extras: [] } }, declaredUses: ['credit_hire'] });
    expect(van.status).toBe(422);
    expect(van.body.error.details?.suggestion).toMatchObject({ group: 'PV2', rate: null });
    expect(t.ctx.repos.findByRegistration(t.ctx.db, 'VN20VAN')).toBeUndefined();
  });

  it('a manual rate in Settings fills the van rate', async () => {
    await t.api('POST', '/settings/gta-rates', { group: 'PV2', dailyRatePence: 7900, period: '2026-27', effectiveFrom: '2026-07-01', effectiveTo: '2027-06-30' });
    const van = await t.api<UnitView>('POST', '/fleet', { vehicle: { registration: 'VN20 VAN', make: 'Ford', model: 'Transit Custom' }, declaredUses: ['credit_hire'] });
    expect(van.status).toBe(201);
    expect(van.body).toMatchObject({ gtaGroup: 'PV2', dailyRatePence: 7900 });
  });
});

describe('PATCH /fleet/:id', () => {
  it('applies vehicle changes with a LookupRecord and a vehicle.update audit row', async () => {
    const created = await t.api<UnitView>('POST', '/fleet', { vehicle: { registration: 'AB18 SML', make: 'Ford', model: 'Fiesta' }, declaredUses: ['credit_hire'], gtaGroup: 'S1' });
    const res = await t.api<UnitView>('PATCH', `/fleet/${created.body.id}`, {
      status: 'off_road',
      vehicle: { variant: 'Zetec', colour: 'Blue', motExpiryDate: '2027-04-30', taxDueDate: '2027-03-31', spec: { catalogue: { makeSlug: 'ford', modelSlug: 'fiesta' }, features: [], extras: ['tow_bar'] } },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('off_road');
    expect(res.body.vehicle).toMatchObject({ variant: 'Zetec', colour: 'Blue', motExpiryDate: '2027-04-30', taxDueDate: '2027-03-31', spec: { extras: ['tow_bar'] } });
    expect(res.body.vehicle.lookups.map((l) => l.provider)).toEqual(['manual', 'catalogue']);
    expect(res.body.warnings).toEqual([]);
    expect(t.ctx.repos.listAudit(t.ctx.db, { entity: 'vehicles', entityId: created.body.vehicleId, action: 'vehicle.update' })).toHaveLength(1);
    // A unit-only patch leaves the vehicle alone.
    const unitOnly = await t.api<UnitView>('PATCH', `/fleet/${created.body.id}`, { status: 'available' });
    expect(unitOnly.body.vehicle.lookups).toHaveLength(2);
    expect(unitOnly.body.warnings).toBeUndefined();
  });
});

describe('keeper address fallback', () => {
  it('uses the registered office lines from Settings, else the CCGUK registered office', () => {
    expect(registeredOfficeLines({ registeredOffice: { line1: '1 Test Street', town: 'Testtown', postcode: 'TT1 1TT' } })).toEqual(['1 Test Street', 'Testtown', 'TT1 1TT']);
    expect(registeredOfficeLines({ registeredOffice: undefined })).toEqual([...CCGUK_REGISTERED_OFFICE_LINES]);
    expect(CCGUK_REGISTERED_OFFICE_LINES).toEqual(['44 Syon Lane', 'Isleworth', 'London', 'TW7 5NQ']);
  });
});
