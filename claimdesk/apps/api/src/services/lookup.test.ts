import { describe, expect, it } from 'vitest';
import type { DvlaVesPayload, DvsaMotVehicle } from '@ccguk/domain';
import { createLookupClients, differsFromVerified, DVLA_VES_URL, DVSA_MOT_URL, mapLookupsToVehicle, manualLookupRecord, sourceLookupRecord, TokenBucket, verifiedLookupValues, type FetchLike } from './lookup.js';

const VES_FIXTURE: DvlaVesPayload = {
  registrationNumber: 'KX21ABC',
  taxStatus: 'Taxed',
  taxDueDate: '2027-03-01',
  motStatus: 'Valid',
  motExpiryDate: '2027-05-14',
  make: 'TOYOTA',
  yearOfManufacture: 2021,
  monthOfFirstRegistration: '2021-05',
  engineCapacity: 1490,
  co2Emissions: 92,
  fuelType: 'HYBRID ELECTRIC',
  colour: 'RED',
  markedForExport: false,
  typeApproval: 'M1',
  wheelplan: '2 AXLE RIGID BODY',
  dateOfLastV5CIssued: '2024-02-10',
  euroStatus: 'EURO 6 AP',
};

const MOT_FIXTURE: DvsaMotVehicle = {
  registration: 'KX21ABC',
  make: 'TOYOTA',
  model: 'YARIS',
  firstUsedDate: '2021-05-14',
  fuelType: 'Hybrid Electric (Clean)',
  primaryColour: 'Red',
  motTests: [
    { completedDate: '2026-05-10T10:12:00.000Z', testResult: 'PASSED', expiryDate: '2027-05-14', odometerValue: '41230', odometerUnit: 'MI', odometerResultType: 'READ', motTestNumber: '123456789012', defects: [{ text: 'Nearside Front Tyre worn close to legal limit', type: 'ADVISORY', dangerous: false }] },
    { completedDate: '2025-05-12T09:00:00.000Z', testResult: 'PASSED', expiryDate: '2026-05-14', odometerValue: '30100', odometerUnit: 'MI', odometerResultType: 'READ', motTestNumber: '123456789011', defects: [] },
    { completedDate: '2024-05-13T09:00:00.000Z', testResult: 'FAILED', odometerValue: '32000', odometerUnit: 'KM', odometerResultType: 'READ', motTestNumber: '123456789010', defects: [{ text: 'Brake pad worn', type: 'MAJOR' }] },
  ],
};

const META = { requestedAt: '2026-10-05T09:00:00.000Z', requestedBy: 'handler' };

describe('mapLookupsToVehicle (fixtures, no network)', () => {
  it('maps the DVLA VES payload to vehicle fields and a verified lookup record', () => {
    const r = mapLookupsToVehicle('kx21 abc', { ves: VES_FIXTURE }, META);
    expect(r.registration).toBe('KX21ABC');
    expect(r.fields).toMatchObject({ registration: 'KX21ABC', make: 'TOYOTA', yearOfManufacture: 2021, fuelType: 'hybrid', colour: 'RED', engineCapacityCc: 1490, motExpiryDate: '2027-05-14', taxDueDate: '2027-03-01', euroStatus: 'EURO 6 AP' });
    expect(r.lookups).toHaveLength(1);
    expect(r.lookups[0]).toMatchObject({ provider: 'dvla_ves', kind: 'vehicle', registration: 'KX21ABC', verification: { status: 'verified', verifiedBy: 'handler' } });
    expect(r.lookups[0]!.raw).toEqual(VES_FIXTURE);
    expect(r.extras).toMatchObject({ ves: { typeApproval: 'M1', wheelplan: '2 AXLE RIGID BODY' } });
  });

  it('maps the DVSA MOT history to tests and odometer readings in miles (km converted)', () => {
    const r = mapLookupsToVehicle('KX21ABC', { mot: MOT_FIXTURE }, META);
    expect(r.fields.model).toBe('YARIS');
    expect(r.fields.motHistory).toHaveLength(3);
    expect(r.fields.motHistory![0]).toMatchObject({ completedDate: '2026-05-10', result: 'PASSED', odometerMiles: 41230, odometerUnit: 'mi', testNumber: '123456789012' });
    expect(r.fields.motHistory![2]).toMatchObject({ result: 'FAILED', odometerUnit: 'km', odometerMiles: Math.round(32000 / 1.609344) });
    expect(r.odometer).toHaveLength(3);
    expect(r.odometer.every((o) => o.source === 'mot')).toBe(true);
    expect(r.lookups[0]).toMatchObject({ provider: 'dvsa_mot', kind: 'mot', verification: { status: 'verified' } });
  });

  it('combines both providers and prefers VES make', () => {
    const r = mapLookupsToVehicle('KX21ABC', { ves: { ...VES_FIXTURE, make: 'Toyota' }, mot: MOT_FIXTURE }, META);
    expect(r.fields.make).toBe('Toyota');
    expect(r.fields.model).toBe('YARIS');
    expect(r.lookups.map((l) => l.provider)).toEqual(['dvla_ves', 'dvsa_mot']);
  });

  it('manual entries are unverified', () => {
    const rec = manualLookupRecord({ make: 'Honda' }, 'ab12cde', META);
    expect(rec).toMatchObject({ provider: 'manual', registration: 'AB12CDE', verification: { status: 'unverified' } });
  });
});

describe('lookup clients (fake fetch)', () => {
  const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  it('returns no_key without credentials and never throws', async () => {
    const clients = createLookupClients({ keys: {}, fetch: (() => Promise.reject(new Error('should not be called'))) as FetchLike });
    expect(await clients.dvlaVes('KX21ABC')).toEqual({ ok: false, reason: 'no_key' });
    expect(await clients.dvsaMot('KX21ABC')).toEqual({ ok: false, reason: 'no_key' });
    expect(await clients.companiesHouse('12640635')).toEqual({ ok: false, reason: 'no_key' });
    expect(clients.presence()).toEqual({ dvlaVes: false, dvsaMot: false, companiesHouse: false });
  });

  it('calls DVLA VES with x-api-key and maps HTTP errors to http_<status>', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return url === DVLA_VES_URL ? json(VES_FIXTURE) : json({ message: 'nope' }, 404);
    };
    const clients = createLookupClients({ keys: { dvlaVesApiKey: 'k' }, fetch: fetchImpl });
    const r = await clients.dvlaVes('kx21 abc');
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe(DVLA_VES_URL);
    expect((calls[0]!.init!.headers as Record<string, string>)['x-api-key']).toBe('k');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ registrationNumber: 'KX21ABC' });

    const clients404 = createLookupClients({ keys: { dvlaVesApiKey: 'k' }, fetch: async () => json({ errors: [] }, 404) });
    expect(await clients404.dvlaVes('KX21ABC')).toMatchObject({ ok: false, reason: 'http_404' });
  });

  it('obtains an OAuth token then calls the MOT history endpoint with Bearer + X-API-Key', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      if (url === 'https://login.example/token') return json({ access_token: 'tok', expires_in: 3600 });
      if (url.startsWith(DVSA_MOT_URL)) return json(MOT_FIXTURE);
      return json({}, 500);
    };
    const clients = createLookupClients({ keys: { dvsaMotClientId: 'id', dvsaMotClientSecret: 's', dvsaMotApiKey: 'apikey', dvsaMotTokenUrl: 'https://login.example/token', dvsaMotScopeUrl: 'https://tapi.dvsa.gov.uk/.default' }, fetch: fetchImpl });
    const r = await clients.dvsaMot('KX21ABC');
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe('https://login.example/token');
    expect(String(calls[0]!.init!.body)).toContain('grant_type=client_credentials');
    expect(String(calls[0]!.init!.body)).toContain('scope=https%3A%2F%2Ftapi.dvsa.gov.uk%2F.default');
    expect(calls[1]!.url).toBe(`${DVSA_MOT_URL}KX21ABC`);
    const h = calls[1]!.init!.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer tok');
    expect(h['x-api-key']).toBe('apikey');
    // token is cached
    await clients.dvsaMot('KX21ABC');
    expect(calls.filter((c) => c.url === 'https://login.example/token')).toHaveLength(1);
  });

  it('calls Companies House with basic auth and maps network failures', async () => {
    let seen: RequestInit | undefined;
    const clients = createLookupClients({
      keys: { companiesHouseApiKey: 'chkey' },
      fetch: async (_url, init) => {
        seen = init;
        return json({ company_number: '12640635', company_name: 'CARFLEX LTD', company_status: 'active-proposal-to-strike-off' });
      },
    });
    const r = await clients.companiesHouse('12640635');
    expect(r.ok && r.data.company_status).toBe('active-proposal-to-strike-off');
    expect((seen!.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('chkey:').toString('base64')}`);

    const down = createLookupClients({ keys: { companiesHouseApiKey: 'chkey' }, fetch: async () => { throw new TypeError('fetch failed'); } });
    expect(await down.companiesHouse('12640635')).toMatchObject({ ok: false, reason: 'network' });
  });

  it('rate-limits with the token bucket and times out slow responses', async () => {
    let now = 0;
    const bucket = new TokenBucket(2, 1, () => now);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    now = 1000;
    expect(bucket.take()).toBe(true);

    const limited = createLookupClients({ keys: { dvlaVesApiKey: 'k' }, fetch: async () => json(VES_FIXTURE), buckets: { dvla_ves: new TokenBucket(1, 0) } });
    expect((await limited.dvlaVes('KX21ABC')).ok).toBe(true);
    expect(await limited.dvlaVes('KX21ABC')).toEqual({ ok: false, reason: 'rate_limited' });

    const slow = createLookupClients({
      keys: { dvlaVesApiKey: 'k' },
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    expect(await slow.dvlaVes('KX21ABC')).toMatchObject({ ok: false, reason: 'network' });
  });
});

describe('hand-entered provenance (§E.4)', () => {
  it('builds unverified LookupRecords per source', () => {
    const tcc = sourceLookupRecord({ provider: 'totalcarcheck_manual', url: 'https://totalcarcheck.co.uk/FreeCheck?regno=KX21ABC', pastedText: 'x'.repeat(25_000), appliedFields: ['make'] }, 'kx21 abc', META);
    expect(tcc).toMatchObject({ provider: 'totalcarcheck_manual', kind: 'vehicle', registration: 'KX21ABC', raw: { source: 'totalcarcheck_paste', url: 'https://totalcarcheck.co.uk/FreeCheck?regno=KX21ABC', appliedFields: ['make'] }, verification: { status: 'unverified', sourceUrl: 'https://totalcarcheck.co.uk/FreeCheck?regno=KX21ABC' } });
    expect((tcc.raw as { pastedText: string }).pastedText).toHaveLength(20_000);
    expect(sourceLookupRecord({ provider: 'catalogue' }, 'KX21ABC', META)).toMatchObject({ provider: 'catalogue', kind: 'spec', raw: { source: 'catalogue' }, verification: { status: 'unverified', sourceNote: 'Chosen from the ClaimDesk vehicle catalogue (unverified reference data).' } });
    expect(sourceLookupRecord({ provider: 'manual' }, 'KX21ABC', META).verification.sourceUrl).toBeUndefined();
  });

  it('compares hand-entered values with verified DVLA/DVSA values only', () => {
    const lookups = mapLookupsToVehicle('KX21ABC', { ves: VES_FIXTURE, mot: MOT_FIXTURE }, META).lookups.map((l, i) => ({ ...l, id: `l${i}` }));
    expect(verifiedLookupValues({ lookups })).toMatchObject({ make: 'TOYOTA', model: 'YARIS', colour: 'RED', engineCapacityCc: 1490, fuelType: 'hybrid' });
    expect(differsFromVerified({ lookups }, { make: 'Toyota', colour: 'Blue', engineCapacityCc: null, variant: 'Icon' })).toEqual([{ code: 'DIFFERS_FROM_VERIFIED', field: 'colour', verifiedValue: 'RED' }]);
    const unverified = lookups.map((l) => ({ ...l, verification: { status: 'unverified' as const } }));
    expect(differsFromVerified({ lookups: unverified }, { colour: 'Blue' })).toEqual([]);
  });
});
