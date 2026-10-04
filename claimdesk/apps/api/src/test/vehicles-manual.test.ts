/**
 * Vehicle search in manual mode (TEMPLATES-VEHICLES-DESKTOP §E): no DVLA/DVSA keys → on-file matches and the Total Car
 * Check link, nothing written; PATCH /vehicles/:id with provenance; spec + source on POST /vehicles and FNOL.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LookupRecord, OnFileMatch, Vehicle } from '@ccguk/domain';
import { createTestApp, FNOL, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp('2026-10-05T09:00:00.000Z');
});
afterEach(async () => {
  await t.close();
});

type LookupBody = {
  status: string;
  lookupMode: string;
  registration: string;
  onFile: OnFileMatch[];
  externalLinks: Array<{ id: string; url: string; verified: boolean; note: string }>;
  providers: Record<string, string>;
};

const auditCount = () => t.ctx.repos.listAudit(t.ctx.db, { limit: 10_000 }).length;

/** SYNTHETIC paste (not a real Total Car Check page). */
const SYNTHETIC_PASTE = 'Registration: AB12 CDE\nMake: VOLKSWAGEN\nModel: GOLF LIFE TSI\nColour: RED\nFuel Type: PETROL\nMOT Expiry Date: 12 March 2027';

describe('POST /vehicles/lookup without keys (manual mode)', () => {
  it('returns manual_required with on-file matches and the Total Car Check link, and writes nothing', async () => {
    const ids = t.ctx.repos.seedFileOne(t.ctx.db);
    const before = t.ctx.repos.requireVehicle(t.ctx.db, ids.clientVehicleId);
    const audits = auditCount();
    const res = await t.api<LookupBody>('POST', '/vehicles/lookup', { registration: 'ab12 cde' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'manual_required', lookupMode: 'manual', registration: 'AB12CDE', providers: { dvla_ves: 'no_key', dvsa_mot: 'no_key' } });
    expect(res.body.onFile[0]).toMatchObject({ vehicleId: ids.clientVehicleId, registration: 'AB12CDE', match: 'exact', make: 'VOLKSWAGEN', model: 'GOLF', ownership: 'client' });
    expect(res.body.onFile[0]!.claims.map((c) => c.id)).toEqual([ids.claimId]);
    expect(res.body.externalLinks[0]).toMatchObject({ id: 'totalcarcheck', url: 'https://totalcarcheck.co.uk/FreeCheck?regno=AB12CDE', verified: false });
    expect(res.body.externalLinks.map((l) => l.id)).toEqual(['totalcarcheck', 'gov_mot_history', 'gov_vehicle_enquiry']);
    // Nothing written: no LookupRecord, no audit row.
    expect(t.ctx.repos.requireVehicle(t.ctx.db, ids.clientVehicleId).lookups).toEqual(before.lookups);
    expect(auditCount()).toBe(audits);
  });

  it('uses the TOTALCARCHECK_URL_TEMPLATE override', async () => {
    const t2 = await createTestApp('2026-10-05T09:00:00.000Z', { config: { totalCarCheckUrlTemplate: 'https://tcc.example/check?reg={REG}' } });
    try {
      const res = await t2.api<LookupBody>('POST', '/vehicles/lookup', { registration: 'KX21 ABC' });
      expect(res.body.externalLinks[0]!.url).toBe('https://tcc.example/check?reg=KX21ABC');
      expect(res.body.onFile).toEqual([]);
    } finally {
      await t2.close();
    }
  });
});

describe('GET /vehicles/on-file', () => {
  it('lists the exact registration first, then partial matches of 4+ characters, with claims, fleet unit and lookups', async () => {
    const ids = t.ctx.repos.seedFileOne(t.ctx.db);
    t.ctx.repos.upsertVehicle(t.ctx.db, { registration: 'AB12 CDF', make: 'FORD', model: 'FOCUS', ownership: 'client' });
    const exact = await t.api<{ items: OnFileMatch[] }>('GET', '/vehicles/on-file?registration=AB12CDE');
    expect(exact.status).toBe(200);
    expect(exact.body.items.map((i) => [i.registration, i.match])).toEqual([['AB12CDE', 'exact']]);
    const partial = await t.api<{ items: OnFileMatch[] }>('GET', '/vehicles/on-file?registration=ab12');
    expect(partial.body.items.map((i) => [i.registration, i.match])).toEqual([
      ['AB12CDE', 'partial'],
      ['AB12CDF', 'partial'],
    ]);
    expect(partial.body.items[0]!.claims.map((c) => c.id)).toEqual([ids.claimId]);
    expect(partial.body.items[0]!.lookups.length).toBeGreaterThanOrEqual(0);
    const fleet = await t.api<{ items: OnFileMatch[] }>('GET', '/vehicles/on-file?registration=FL33EET');
    expect(fleet.body.items[0]).toMatchObject({ match: 'exact', ownership: 'fleet', fleetUnit: { id: ids.fleetUnitId, gtaGroup: 'S1', status: expect.any(String) } });
    const short = await t.api<{ items: OnFileMatch[] }>('GET', '/vehicles/on-file?registration=AB1');
    expect(short.body.items).toEqual([]);
    expect((await t.api('GET', '/vehicles/on-file')).status).toBe(400);
  });
});

describe('PATCH /vehicles/:id', () => {
  it('saves pasted details with an unverified totalcarcheck_manual LookupRecord and an audit row', async () => {
    const v = t.ctx.repos.upsertVehicle(t.ctx.db, { registration: 'KX21ABC', make: 'UNKNOWN', model: 'UNKNOWN', ownership: 'client' });
    const res = await t.api<Vehicle & { vehicle: Vehicle; lookupId: string; warnings: unknown[] }>('PATCH', `/vehicles/${v.id}`, {
      make: 'TOYOTA',
      model: 'YARIS',
      colour: 'Red',
      fuelType: 'hybrid',
      motExpiryDate: '2027-05-14',
      spec: { segment: 'supermini', doors: 5, features: ['sat_nav'], extras: [] },
      source: {
        provider: 'totalcarcheck_manual',
        url: 'https://totalcarcheck.co.uk/FreeCheck?regno=KX21ABC',
        pastedText: SYNTHETIC_PASTE,
        parsed: { make: 'TOYOTA' },
        appliedFields: ['make', 'model', 'colour'],
        verification: { status: 'verified' },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ make: 'TOYOTA', model: 'YARIS', colour: 'Red', fuelType: 'hybrid', motExpiryDate: '2027-05-14', spec: { segment: 'supermini', doors: 5, features: ['sat_nav'], extras: [] } });
    expect(res.body.warnings).toEqual([]);
    const lookup = res.body.lookups.find((l: LookupRecord) => l.id === res.body.lookupId)!;
    expect(lookup).toMatchObject({
      provider: 'totalcarcheck_manual',
      kind: 'vehicle',
      registration: 'KX21ABC',
      requestedBy: 'handler',
      raw: { source: 'totalcarcheck_paste', url: 'https://totalcarcheck.co.uk/FreeCheck?regno=KX21ABC', pastedText: SYNTHETIC_PASTE, parsed: { make: 'TOYOTA' }, appliedFields: ['make', 'model', 'colour'] },
      verification: { status: 'unverified', sourceUrl: 'https://totalcarcheck.co.uk/FreeCheck?regno=KX21ABC', sourceNote: 'Copied by hand from Total Car Check (free check). Not verified — back it with the V5C or MOT certificate.' },
    });
    const audit = t.ctx.repos.listAudit(t.ctx.db, { entity: 'vehicles', entityId: v.id, action: 'vehicle.update' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.before).toMatchObject({ make: 'UNKNOWN', colour: null });
  });

  it('clears fields with null and records a catalogue pick as a spec lookup', async () => {
    const v = t.ctx.repos.upsertVehicle(t.ctx.db, { registration: 'KX21ABC', make: 'FORD', model: 'FIESTA', variant: 'Zetec', colour: 'Blue', ownership: 'client' });
    const res = await t.api<Vehicle & { lookupId: string }>('PATCH', `/vehicles/${v.id}`, { variant: null, colour: null, spec: { catalogue: { makeSlug: 'ford', modelSlug: 'fiesta' }, features: [], extras: [] }, source: { provider: 'catalogue' } });
    expect(res.status).toBe(200);
    expect(res.body.variant).toBeUndefined();
    expect(res.body.colour).toBeUndefined();
    expect(res.body.lookups.find((l) => l.id === res.body.lookupId)).toMatchObject({ provider: 'catalogue', kind: 'spec', raw: { source: 'catalogue' }, verification: { status: 'unverified', sourceNote: 'Chosen from the ClaimDesk vehicle catalogue (unverified reference data).' } });
  });

  it('warns DIFFERS_FROM_VERIFIED and never changes the verified lookup', async () => {
    const v = t.ctx.repos.upsertVehicle(t.ctx.db, { registration: 'KX21ABC', make: 'TOYOTA', model: 'YARIS', colour: 'RED', ownership: 'client' });
    const verified = t.ctx.repos.addLookup(t.ctx.db, v.id, {
      provider: 'dvla_ves',
      kind: 'vehicle',
      requestedAt: '2026-10-01T09:00:00.000Z',
      requestedBy: 'handler',
      registration: 'KX21ABC',
      raw: { registrationNumber: 'KX21ABC', make: 'TOYOTA', colour: 'RED', fuelType: 'HYBRID ELECTRIC', engineCapacity: 1490 },
      verification: { status: 'verified', sourceNote: 'Live DVLA VES response', verifiedAt: '2026-10-01', verifiedBy: 'handler' },
    });
    const res = await t.api<Vehicle & { warnings: Array<{ code: string; field: string; verifiedValue: unknown }> }>('PATCH', `/vehicles/${v.id}`, { make: 'Toyota', colour: 'Blue', engineCapacityCc: 1500, source: { provider: 'manual' } });
    expect(res.status).toBe(200);
    expect(res.body.colour).toBe('Blue');
    expect(res.body.warnings).toEqual([
      { code: 'DIFFERS_FROM_VERIFIED', field: 'colour', verifiedValue: 'RED' },
      { code: 'DIFFERS_FROM_VERIFIED', field: 'engineCapacityCc', verifiedValue: 1490 },
    ]);
    expect(res.body.lookups.find((l) => l.id === verified.id)).toEqual(verified);
  });

  it('requires a source and refuses a registration change', async () => {
    const v = t.ctx.repos.upsertVehicle(t.ctx.db, { registration: 'KX21ABC', make: 'FORD', model: 'FIESTA', ownership: 'client' });
    expect((await t.api('PATCH', `/vehicles/${v.id}`, { colour: 'Red' })).status).toBe(400);
    expect((await t.api('PATCH', `/vehicles/${v.id}`, { colour: 'Red', source: { provider: 'dvla_ves' } })).status).toBe(400);
    const res = await t.api<Vehicle>('PATCH', `/vehicles/${v.id}`, { registration: 'ZZ99ZZZ', source: { provider: 'manual' } });
    expect(res.status).toBe(200);
    expect(res.body.registration).toBe('KX21ABC');
    expect((await t.api('PATCH', '/vehicles/nope', { source: { provider: 'manual' } })).status).toBe(404);
  });
});

describe('spec and source on vehicle creation', () => {
  it('POST /vehicles stores the spec and a LookupRecord with the source provider', async () => {
    const res = await t.api<Vehicle>('POST', '/vehicles', {
      registration: 'KX21 ABC',
      make: 'Volkswagen',
      model: 'Golf',
      variant: 'Match',
      bodyType: 'Hatchback',
      engineCapacityCc: 1498,
      spec: { catalogue: { makeSlug: 'volkswagen', modelSlug: 'golf', generationId: 'volkswagen-golf-mk7-2012-2020', trimId: 'match' }, segment: 'small-family', features: [], extras: ['tow_bar'] },
      source: { provider: 'catalogue' },
    });
    expect(res.status).toBe(201);
    expect(res.body.spec).toMatchObject({ catalogue: { trimId: 'match' }, extras: ['tow_bar'] });
    expect(res.body.lookups[0]).toMatchObject({ provider: 'catalogue', kind: 'spec', verification: { status: 'unverified' } });
    const plain = await t.api<Vehicle>('POST', '/vehicles', { registration: 'LM19 XYZ', make: 'Ford', model: 'Transit' });
    expect(plain.body.lookups[0]).toMatchObject({ provider: 'manual', kind: 'vehicle', verification: { status: 'unverified' } });
  });

  it('FNOL vehicle input accepts spec and source (LookupRecord provider from the source)', async () => {
    const res = await t.api<{ claim: { clientVehicleId: string } }>('POST', '/claims', {
      ...FNOL,
      vehicle: { ...FNOL.vehicle, spec: { segment: 'supermini', features: ['dab'], extras: [] }, source: { provider: 'totalcarcheck_manual', url: 'https://totalcarcheck.co.uk/FreeCheck?regno=KX21ABC', pastedText: SYNTHETIC_PASTE } },
    });
    expect(res.status).toBe(201);
    const v = t.ctx.repos.requireVehicle(t.ctx.db, res.body.claim.clientVehicleId);
    expect(v.spec).toEqual({ segment: 'supermini', features: ['dab'], extras: [] });
    expect(v.lookups.map((l) => l.provider)).toEqual(['totalcarcheck_manual']);
    expect(v.lookups[0]!.raw).toMatchObject({ source: 'totalcarcheck_paste', pastedText: SYNTHETIC_PASTE });
  });
});
