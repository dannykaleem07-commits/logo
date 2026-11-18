#!/usr/bin/env node
/* Offline test of the DVLA VES and DVSA MOT History connectors against mocked HTTP responses. */
'use strict';
const assert = require('assert');
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, init });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('vehicle-enquiry')) {
    const body = JSON.parse(init.body);
    if (body.registrationNumber === 'ZZ99ZZZ') return json({ errors: [{ status: '404' }] }, 404);
    return json({ registrationNumber: body.registrationNumber, make: 'MERCEDES-BENZ', colour: 'BLACK', fuelType: 'DIESEL', engineCapacity: 1950, monthOfFirstRegistration: '2019-03', taxStatus: 'Taxed', motStatus: 'Valid' });
  }
  if (url.includes('login.microsoftonline.com')) return json({ access_token: 'tok123', expires_in: 3599 });
  if (url.includes('history.mot.api.gov.uk')) return json({ registration: 'AB19CDE', make: 'MERCEDES-BENZ', model: 'E 220 D AMG LINE PREMIUM PLUS AUTO', motTests: [{ completedDate: '2025-03-01T10:00:00Z', testResult: 'PASSED', odometerValue: '41000', odometerUnit: 'MI', defects: [] }] });
  return json({}, 500);
};
const vd = require('../vehicledata');
(async () => {
  const d = await vd.dvlaLookup('ab19 cde', 'KEY1');
  const c = calls[0];
  assert.strictEqual(c.init.method, 'POST');
  assert.strictEqual(c.init.headers['x-api-key'], 'KEY1');
  assert.deepStrictEqual(JSON.parse(c.init.body), { registrationNumber: 'AB19CDE' });
  assert.strictEqual(d.make, 'MERCEDES-BENZ');
  await assert.rejects(vd.dvlaLookup('ZZ99 ZZZ', 'KEY1'), /no record/);
  await assert.rejects(vd.dvlaLookup('AB19CDE', ''), /No DVLA API key/);
  console.log('✓ DVLA VES: POST with x-api-key, registration normalised, 404 and missing key handled');
  const keys = { motClientId: 'id', motClientSecret: 'secret', motApiKey: 'apikey', motTenantId: 'tenant-1' };
  const m = await vd.motLookup('AB19 CDE', keys);
  const tok = calls.find((x) => x.url.includes('login.microsoftonline.com/tenant-1/oauth2/v2.0/token'));
  assert.ok(tok, 'token request to tenant');
  assert.match(String(tok.init.body), /grant_type=client_credentials/);
  assert.match(String(tok.init.body), /scope=https%3A%2F%2Ftapi.dvsa.gov.uk%2F.default/);
  const get = calls.find((x) => x.url.includes('history.mot.api.gov.uk/v1/trade/vehicles/registration/AB19CDE'));
  assert.strictEqual(get.init.headers.Authorization, 'Bearer tok123');
  assert.strictEqual(get.init.headers['X-API-Key'], 'apikey');
  assert.strictEqual(m.motTests[0].odometerValue, '41000');
  await assert.rejects(vd.motLookup('AB19CDE', {}), /incomplete/);
  console.log('✓ MOT History: OAuth client-credentials token, bearer + X-API-Key headers, missing credentials handled');
  console.log('Data connector mock test passed.');
})().catch((e) => { console.error(e); process.exit(1); });
