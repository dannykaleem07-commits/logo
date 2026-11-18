#!/usr/bin/env node
/*
 * Offline test of the DVLA VES and DVSA MOT History connectors against mocked HTTP responses.
 * The response shapes are taken from the official specifications:
 *  - DVLA VES API v1.2.0 OpenAPI spec (live) and the DVLA test-environment mock responses (UAT)
 *  - DVSA MOT History API OpenAPI spec (mot_history_open_api_specification.yml)
 */
'use strict';
const assert = require('assert');
const calls = [];
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// DVLA live v1.2.0 example (numeric month + separate year, motExpiry, wheelPlan)
const DVLA_LIVE = { registrationNumber: 'WN67DSO', artEndDate: '2007-12-25', co2Emissions: 0, engineCapacity: 1796, yearOfFirstRegistration: 2012, monthOfFirstRegistration: 12, yearOfFirstRegistrationWithDVLA: 2012, monthOfFirstRegistrationWithDVLA: 12, euroStatus: 'Euro 5', markedAsScrapped: true, markedForExport: true, fuelType: 'PETROL', motStatus: 'No details held by DVLA', motExpiry: '2008-12-25', revenueWeight: 1640, taxDueDate: '2017-12-25', taxStatus: 'Untaxed', colour: 'Blue', make: 'ROVER', typeApproval: 'N1', wheelPlan: 'NON STANDARD', yearOfManufacture: 2004, vehicleStatus: 'Not Taxed for on Road Use', dateOfLastV5CIssued: '2016-12-25', realDrivingEmissions: '1', automatedVehicle: false };
// DVLA test-environment (UAT) example AA19PPP (string month, motExpiryDate, wheelplan, blank strings)
const DVLA_UAT = { registrationNumber: 'AA19PPP', co2Emissions: 0, engineCapacity: 2000, euroStatus: 'EURO6', markedForExport: false, fuelType: 'PETROL', revenueWeight: 44000, colour: 'RED', make: 'FORD', yearOfManufacture: 2016, taxDueDate: ' ', taxStatus: 'Taxed', dateOfLastV5CIssued: '2019-05-20', wheelplan: '3 AXLE + 3 AXLE ARTIC', monthOfFirstDvlaRegistration: '2016-09', monthOfFirstRegistration: '2016-09', motStatus: 'Valid', motExpiryDate: ' ' };
const DVLA_ERR = (status, title, detail) => json({ errors: [{ status: String(status), code: String(status), title, detail }] }, status);

const MOT_VEHICLE = {
  registration: 'AB12CDE', make: 'FORD', model: 'FOCUS', firstUsedDate: '2015-03-02', fuelType: 'Petrol', primaryColour: 'Silver', registrationDate: '2015-03-02', manufactureDate: '2015-03-01', engineSize: '1598', hasOutstandingRecall: 'Yes',
  motTests: [
    { registrationAtTimeOfTest: 'AB12CDE', completedDate: '2023-02-17T09:17:46.000Z', testResult: 'PASSED', expiryDate: '2024-02-16', odometerValue: '61200', odometerUnit: 'MI', odometerResultType: 'READ', motTestNumber: '1', dataSource: 'DVSA', defects: [{ text: 'Tyre worn close to legal limit', type: 'ADVISORY', dangerous: false }, { text: 'Brake pipe corroded', type: 'MAJOR', dangerous: true }] },
    { registrationAtTimeOfTest: 'AB12CDE', completedDate: '2024-02-10T10:00:00.000Z', testResult: 'FAILED', expiryDate: null, odometerValue: null, odometerUnit: null, odometerResultType: 'UNREADABLE', motTestNumber: '2', dataSource: 'DVSA', defects: [] },
    { registrationAtTimeOfTest: 'AB12CDE', completedDate: '2022-02-14T10:00:00.000Z', testResult: 'PASSED', expiryDate: '2023-02-16', odometerValue: '83500', odometerUnit: 'KM', odometerResultType: 'READ', motTestNumber: '3', dataSource: 'DVSA', defects: [] }
  ]
};
const MOT_NEWREG = { registration: 'NE24WRG', make: 'KIA', model: 'SPORTAGE', manufactureYear: '2024', fuelType: 'Hybrid Electric (Clean)', primaryColour: 'Grey', registrationDate: '2024-03-01', manufactureDate: '2024-02-01', motTestDueDate: '2027-02-28', hasOutstandingRecall: 'Unknown' };

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, init });
  if (url.endsWith('/vehicle-enquiry/v1/vehicles')) {
    const vrm = JSON.parse(init.body).registrationNumber;
    if (init.headers['x-api-key'] === 'BADKEY') return json({ Message: 'User is not authorized to access this resource with an explicit deny in an identity-based policy' }, 403);
    if (vrm === 'ER19NFD') return DVLA_ERR(404, 'Vehicle Not Found', 'Record for vehicle not found');
    if (vrm === 'ER19BAD') return DVLA_ERR(400, 'Bad Request', 'Invalid format for field - vehicle registration number');
    if (vrm === 'ER19THR') return DVLA_ERR(429, 'Too Many Requests', 'Too many requests');
    if (vrm === 'ER19MNT') return DVLA_ERR(503, 'Service Unavailable', 'Service Unavailable');
    return json(url.startsWith('https://uat.') ? DVLA_UAT : DVLA_LIVE);
  }
  if (url.startsWith('https://login.microsoftonline.com/')) {
    const body = new URLSearchParams(String(init.body));
    if (body.get('client_secret') !== 'secret') return json({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\nTrace ID: x' }, 401);
    return json({ token_type: 'Bearer', expires_in: 1199, ext_expires_in: 1199, access_token: 'tok123' });
  }
  if (url.startsWith('https://history.mot.api.gov.uk/v1/trade/vehicles/')) {
    if (init.headers['X-API-Key'] !== 'apikey') return json({ errorCode: 'MOTH-FB-03', errorMessage: 'The API key sent with the request is not recognised', requestId: 'r1' }, 403);
    if (url.endsWith('/registration/ZZ99ZZZ')) return json({ errorCode: 'MOTH-NF-01', errorMessage: 'Vehicle with identifier: [ZZ99ZZZ] not found', requestId: 'r2' }, 404);
    if (url.endsWith('/registration/NE24WRG')) return json(MOT_NEWREG);
    return json(MOT_VEHICLE);
  }
  return json({}, 500);
};

const vd = require('../vehicledata');
(async () => {
  // ---------- DVLA ----------
  const live = await vd.dvlaLookup('wn67 dso', 'KEY1', 'live');
  let c = calls[calls.length - 1];
  assert.strictEqual(c.url, 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles');
  assert.strictEqual(c.init.method, 'POST');
  assert.strictEqual(c.init.headers['x-api-key'], 'KEY1');
  assert.deepStrictEqual(JSON.parse(c.init.body), { registrationNumber: 'WN67DSO' });
  assert.strictEqual(live.firstRegistration, '2012-12-01', 'v1.2.0 numeric month + year');
  assert.strictEqual(live.motExpiry, '2008-12-25');
  assert.strictEqual(live.wheelPlan, 'NON STANDARD');
  assert.strictEqual(live.markedAsScrapped, true);
  assert.strictEqual(live.importedOrReRegistered, false);
  console.log('✓ DVLA live v1.2.0: POST + x-api-key, VRN normalised, numeric month/year → 2012-12-01, motExpiry, wheelPlan, scrapped flag');

  const uat = await vd.dvlaLookup('AA19PPP', 'KEY1', 'test');
  c = calls[calls.length - 1];
  assert.strictEqual(c.url, 'https://uat.driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles', 'test service URL');
  assert.strictEqual(uat.firstRegistration, '2016-09-01', 'UAT string month');
  assert.strictEqual(uat.motExpiry, '', 'blank " " normalised');
  assert.strictEqual(uat.taxDueDate, '');
  assert.strictEqual(uat.wheelPlan, '3 AXLE + 3 AXLE ARTIC', 'wheelplan (lower-case p) accepted');
  console.log('✓ DVLA test service (UAT): uat. URL, string month → 2016-09-01, blank strings and wheelplan normalised');

  await assert.rejects(vd.dvlaLookup('ER19NFD', 'KEY1', 'test'), /no record of ER19NFD/);
  await assert.rejects(vd.dvlaLookup('ER19BAD', 'KEY1', 'test'), /Invalid format for field/);
  await assert.rejects(vd.dvlaLookup('ER19THR', 'KEY1', 'test'), /rate limit/);
  await assert.rejects(vd.dvlaLookup('ER19MNT', 'KEY1', 'test'), /temporarily unavailable/);
  await assert.rejects(vd.dvlaLookup('AB12CDE', 'BADKEY', 'live'), /refused the API key \(403\).*TEST key.*dvlaapiaccess@dvla\.gov\.uk/);
  await assert.rejects(vd.dvlaLookup('AB12CDE', '', 'live'), /No DVLA API key/);
  await assert.rejects(vd.dvlaLookup('  ', 'KEY1', 'live'), /Enter a registration/);
  console.log('✓ DVLA errors: 404 / 400 detail / 429 / 503 / 403 key help / missing key / empty registration');

  // ---------- MOT History ----------
  const keys = { motClientId: 'id', motClientSecret: 'secret', motApiKey: 'apikey', motTokenUrl: 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token', motScope: 'https://tapi.dvsa.gov.uk/.default' };
  assert.strictEqual(vd.motConfigured(keys), true);
  assert.strictEqual(vd.motConfigured({ motClientId: 'id' }), false);
  const raw = await vd.motLookup('AB12 CDE', keys, 'registration');
  const tok = calls.find((x) => x.url === 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
  assert.ok(tok, 'token URL from the DVSA email used as-is');
  const tb = new URLSearchParams(String(tok.init.body));
  assert.strictEqual(tb.get('grant_type'), 'client_credentials');
  assert.strictEqual(tb.get('client_id'), 'id');
  assert.strictEqual(tb.get('scope'), 'https://tapi.dvsa.gov.uk/.default');
  const get = calls.find((x) => x.url === 'https://history.mot.api.gov.uk/v1/trade/vehicles/registration/AB12CDE');
  assert.strictEqual(get.init.headers.Authorization, 'Bearer tok123');
  assert.strictEqual(get.init.headers['X-API-Key'], 'apikey');
  console.log('✓ MOT History: client-credentials token from the email token URL + scope, Bearer + X-API-Key on GET /registration/{vrm}');

  const n = vd.normaliseMot(raw);
  assert.strictEqual(n.recall, 'Yes');
  assert.deepStrictEqual(n.tests.map((t) => t.date), ['2024-02-10', '2023-02-17', '2022-02-14'], 'newest first');
  assert.strictEqual(n.tests[0].odometer, 0, 'UNREADABLE odometer → 0');
  assert.strictEqual(n.tests[0].odometerResult, 'UNREADABLE');
  assert.strictEqual(n.tests[1].odometer, 61200);
  assert.strictEqual(n.tests[1].unit, 'mi');
  assert.strictEqual(n.tests[2].unit, 'km');
  assert.match(n.tests[1].defects[1], /^MAJOR \(DANGEROUS\): Brake pipe corroded/);
  console.log('✓ MOT normalisation: newest first, UNREADABLE odometers excluded, MI/KM units, dangerous defects marked, recall status');

  const tenantOnly = { ...keys, motTokenUrl: undefined, motTenantId: 'tenant-2' };
  await vd.motLookup('AB12CDE', { ...tenantOnly, motClientId: 'id2' }, 'registration');
  assert.ok(calls.some((x) => x.url === 'https://login.microsoftonline.com/tenant-2/oauth2/v2.0/token'), 'bare tenant ID still supported');
  await vd.motLookup('wdd2130042a000000', keys, 'vin');
  assert.ok(calls.some((x) => x.url === 'https://history.mot.api.gov.uk/v1/trade/vehicles/vin/WDD2130042A000000'), 'VIN endpoint');
  const nr = vd.normaliseMot(await vd.motLookup('NE24WRG', keys, 'registration'));
  assert.strictEqual(nr.tests.length, 0);
  assert.strictEqual(nr.motTestDueDate, '2027-02-28');
  console.log('✓ MOT: tenant-ID fallback, lookup by VIN, new-registration record (no tests, first MOT due date)');

  await assert.rejects(vd.motLookup('ZZ99ZZZ', keys, 'registration'), /No MOT history record found for ZZ99ZZZ.*MOTH-NF-01/);
  await assert.rejects(vd.motLookup('AB12CDE', { ...keys, motApiKey: 'wrong' }, 'registration'), /refused the request \(MOTH-FB-03/);
  await assert.rejects(vd.motLookup('AB12CDE', { ...keys, motClientId: 'id3', motClientSecret: 'nope' }, 'registration'), /sign-in failed \(AADSTS7000215: Invalid client secret provided\.\)/);
  await assert.rejects(vd.motLookup('AB12CDE', {}, 'registration'), /incomplete/);
  console.log('✓ MOT errors: MOTH-NF-01 not found, MOTH-FB-03 bad API key, invalid client secret, incomplete credentials');
  console.log('Data connector mock test passed.');
})().catch((e) => { console.error(e); process.exit(1); });
