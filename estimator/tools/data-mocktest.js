#!/usr/bin/env node
/*
 * Offline test of the DVLA VES and DVSA MOT History connectors (vehicledata.js) against mocked HTTP responses.
 * The response shapes are taken from the official specifications:
 *  - DVLA VES API v1.2.0 OpenAPI spec (live) and the DVLA test-environment mock responses (UAT)
 *  - DVSA MOT History API OpenAPI spec (mot_history_open_api_specification.yml)
 * Also covers: the injected fetch (setFetch, as main.js does with Electron's net.fetch), request timeouts, refusing any
 * token URL that is not Microsoft's, proxy / firewall block pages, network error mapping, key cleaning and the
 * DANGEROUS defect label. No request leaves this process.
 */
'use strict';
const assert = require('assert');
const calls = [];
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const htmlPage = (status, body = '<html><head><title>Access Denied</title></head><body>Blocked by the corporate web filter</body></html>') => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const TENANT = '1a2b3c4d-1111-2222-3333-444455556666';
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

// DVLA live v1.2.0 example (numeric month + separate year, motExpiry, wheelPlan)
const DVLA_LIVE = { registrationNumber: 'WN67DSO', artEndDate: '2007-12-25', co2Emissions: 0, engineCapacity: 1796, yearOfFirstRegistration: 2012, monthOfFirstRegistration: 12, yearOfFirstRegistrationWithDVLA: 2012, monthOfFirstRegistrationWithDVLA: 12, euroStatus: 'Euro 5', markedAsScrapped: true, markedForExport: true, fuelType: 'PETROL', motStatus: 'No details held by DVLA', motExpiry: '2008-12-25', revenueWeight: 1640, taxDueDate: '2017-12-25', taxStatus: 'Untaxed', colour: 'Blue', make: 'ROVER', typeApproval: 'N1', wheelPlan: 'NON STANDARD', yearOfManufacture: 2004, vehicleStatus: 'Not Taxed for on Road Use', dateOfLastV5CIssued: '2016-12-25', realDrivingEmissions: '1', automatedVehicle: false };
// DVLA test-environment (UAT) example AA19PPP (string month, motExpiryDate, wheelplan, blank strings)
const DVLA_UAT = { registrationNumber: 'AA19PPP', co2Emissions: 0, engineCapacity: 2000, euroStatus: 'EURO6', markedForExport: false, fuelType: 'PETROL', revenueWeight: 44000, colour: 'RED', make: 'FORD', yearOfManufacture: 2016, taxDueDate: ' ', taxStatus: 'Taxed', dateOfLastV5CIssued: '2019-05-20', wheelplan: '3 AXLE + 3 AXLE ARTIC', monthOfFirstDvlaRegistration: '2016-09', monthOfFirstRegistration: '2016-09', motStatus: 'Valid', motExpiryDate: ' ' };
const DVLA_ERR = (status, title, detail) => json({ errors: [{ status: String(status), code: String(status), title, detail }] }, status);

const MOT_VEHICLE = {
  registration: 'AB12CDE', make: 'FORD', model: 'FOCUS', firstUsedDate: '2015-03-02', fuelType: 'Petrol', primaryColour: 'Silver', registrationDate: '2015-03-02', manufactureDate: '2015-03-01', engineSize: '1598', hasOutstandingRecall: 'Yes',
  motTests: [
    { registrationAtTimeOfTest: 'AB12CDE', completedDate: '2023-02-17T09:17:46.000Z', testResult: 'PASSED', expiryDate: '2024-02-16', odometerValue: '61200', odometerUnit: 'MI', odometerResultType: 'READ', motTestNumber: '1', dataSource: 'DVSA', defects: [{ text: 'Tyre worn close to legal limit', type: 'ADVISORY', dangerous: false }, { text: 'Brake pipe corroded', type: 'MAJOR', dangerous: true }, { text: 'Brake hose ruptured', type: 'DANGEROUS', dangerous: true }, { text: 'Steering rack leaking', dangerous: true }] },
    { registrationAtTimeOfTest: 'AB12CDE', completedDate: '2024-02-10T10:00:00.000Z', testResult: 'FAILED', expiryDate: null, odometerValue: null, odometerUnit: null, odometerResultType: 'UNREADABLE', motTestNumber: '2', dataSource: 'DVSA', defects: [] },
    { registrationAtTimeOfTest: 'AB12CDE', completedDate: '2022-02-14T10:00:00.000Z', testResult: 'PASSED', expiryDate: '2023-02-16', odometerValue: '83500', odometerUnit: 'KM', odometerResultType: 'READ', motTestNumber: '3', dataSource: 'DVSA', defects: [] }
  ]
};
const MOT_NEWREG = { registration: 'NE24WRG', make: 'KIA', model: 'SPORTAGE', manufactureYear: '2024', fuelType: 'Hybrid Electric (Clean)', primaryColour: 'Grey', registrationDate: '2024-03-01', manufactureDate: '2024-02-01', motTestDueDate: '2027-02-28', hasOutstandingRecall: 'Unknown' };

// Every request must go through the fetch injected with setFetch() (main.js injects Electron's net.fetch):
// the global fetch is a trap.
let globalFetchCalls = 0;
globalThis.fetch = async () => { globalFetchCalls++; throw new TypeError('global fetch must not be used'); };

let override = null; // (url, init) => Response | Promise | undefined, for one scenario at a time
let tokenSeq = 0;
const revoked = new Set();
async function mockFetch(url, init = {}) {
  url = String(url);
  calls.push({ url, init });
  if (override) { const r = await override(url, init); if (r) return r; }
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
    if (body.get('client_secret') !== 'secret') return json({ error: 'invalid_client', error_description: `AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app '${body.get('client_id')}'.\nTrace ID: x` }, 401);
    return json({ token_type: 'Bearer', expires_in: 1199, ext_expires_in: 1199, access_token: 'tok' + (++tokenSeq) });
  }
  if (url.startsWith('https://history.mot.api.gov.uk/v1/trade/vehicles/')) {
    if (revoked.has(init.headers.Authorization)) return json({ errorCode: 'MOTH-UA-01', errorMessage: 'Unauthorised', requestId: 'r0' }, 401);
    if (init.headers['X-API-Key'] !== 'apikey') return json({ errorCode: 'MOTH-FB-03', errorMessage: 'The API key sent with the request is not recognised', requestId: 'r1' }, 403);
    if (url.endsWith('/registration/ZZ99ZZZ')) return json({ errorCode: 'MOTH-NF-01', errorMessage: 'Vehicle with identifier: [ZZ99ZZZ] not found', requestId: 'r2' }, 404);
    if (url.endsWith('/registration/NE24WRG')) return json(MOT_NEWREG);
    return json(MOT_VEHICLE);
  }
  return json({}, 500);
}
const errOf = async (p) => { try { await p; } catch (e) { return e.message; } throw new Error('expected a rejection'); };
const netErr = (message, code, causeMessage) => Object.assign(new TypeError(message), code || causeMessage ? { cause: Object.assign(new Error(causeMessage || code), code ? { code } : {}) } : {});

const vd = require('../vehicledata');
vd.setFetch(mockFetch);
// AbortSignal.timeout() timers do not keep Node alive (Electron's main process always is): hold the loop open meanwhile.
const keepAlive = setInterval(() => {}, 1000);
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
  await assert.rejects(vd.dvlaLookup('AB12CDEFGHIJ', 'KEY1', 'live'), /too long for a UK registration/);
  console.log('✓ DVLA errors: 404 / 400 detail / 429 / 503 / 403 key help (JSON body) / missing key / empty or over-long registration');

  // ---------- MOT History ----------
  const keys = { motClientId: 'id', motClientSecret: 'secret', motApiKey: 'apikey', motTokenUrl: TOKEN_URL, motScope: 'https://tapi.dvsa.gov.uk/.default' };
  assert.strictEqual(vd.motConfigured(keys), true);
  assert.strictEqual(vd.motConfigured({ motClientId: 'id' }), false);
  const raw = await vd.motLookup('AB12 CDE', keys, 'registration');
  const tok = calls.find((x) => x.url === TOKEN_URL);
  assert.ok(tok, 'token URL from the DVSA email used');
  const tb = new URLSearchParams(String(tok.init.body));
  assert.strictEqual(tb.get('grant_type'), 'client_credentials');
  assert.strictEqual(tb.get('client_id'), 'id');
  assert.strictEqual(tb.get('scope'), 'https://tapi.dvsa.gov.uk/.default');
  const get = calls.find((x) => x.url === 'https://history.mot.api.gov.uk/v1/trade/vehicles/registration/AB12CDE');
  assert.strictEqual(get.init.headers.Authorization, 'Bearer tok1');
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
  assert.deepStrictEqual(n.tests[1].defects, [
    'ADVISORY: Tyre worn close to legal limit',
    'MAJOR (DANGEROUS): Brake pipe corroded',
    'DANGEROUS: Brake hose ruptured', // type DANGEROUS is not doubled into "DANGEROUS (DANGEROUS)"
    'DANGEROUS: Steering rack leaking' // dangerous flag without a type is still shown
  ]);
  assert.doesNotThrow(() => vd.normaliseMot({ motTests: [null, { completedDate: null, defects: 'x' }] }), 'malformed tests do not throw');
  console.log('✓ MOT normalisation: newest first, UNREADABLE odometers excluded, MI/KM units, recall status; defect labels MAJOR (DANGEROUS) / DANGEROUS (never "DANGEROUS (DANGEROUS)")');

  const tenantOnly = { ...keys, motTokenUrl: undefined, motTenantId: TENANT };
  await vd.motLookup('AB12CDE', { ...tenantOnly, motClientId: 'id2' }, 'registration');
  assert.ok(calls.some((x) => x.url === TOKEN_URL && new URLSearchParams(String(x.init.body)).get('client_id') === 'id2'), 'bare tenant ID builds the Microsoft token URL');
  await vd.motLookup('AB12CDE', { ...keys, motTokenUrl: undefined, motTenantId: 'contoso.onmicrosoft.com', motClientId: 'id4' }, 'registration');
  assert.ok(calls.some((x) => x.url === 'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token'), 'domain tenant ID');
  await vd.motLookup('wdd2130042a000000', keys, 'vin');
  assert.ok(calls.some((x) => x.url === 'https://history.mot.api.gov.uk/v1/trade/vehicles/vin/WDD2130042A000000'), 'VIN endpoint');
  const nr = vd.normaliseMot(await vd.motLookup('NE24WRG', keys, 'registration'));
  assert.strictEqual(nr.tests.length, 0);
  assert.strictEqual(nr.motTestDueDate, '2027-02-28');
  console.log('✓ MOT: tenant-ID fallback (GUID or domain), lookup by VIN, new-registration record (no tests, first MOT due date)');

  await assert.rejects(vd.motLookup('ZZ99ZZZ', keys, 'registration'), /No MOT history record found for ZZ99ZZZ.*MOTH-NF-01/);
  await assert.rejects(vd.motLookup('AB12CDE', { ...keys, motApiKey: 'wrong' }, 'registration'), /refused the request \(MOTH-FB-03/);
  const signin = await errOf(vd.motLookup('AB12CDE', { ...keys, motClientId: 'client-id-0042', motClientSecret: 'nope' }, 'registration'));
  assert.match(signin, /sign-in failed \(AADSTS7000215: Invalid client secret provided\./);
  assert.ok(!signin.includes('client-id-0042'), 'client ID echoed by Microsoft is redacted');
  await assert.rejects(vd.motLookup('AB12CDE', {}, 'registration'), /incomplete/);
  console.log('✓ MOT errors: MOTH-NF-01 not found, MOTH-FB-03 bad API key, invalid client secret (client ID redacted), incomplete credentials');

  // A token revoked before it expires: the 401 is retried once with a fresh token.
  const before = calls.filter((x) => x.url === TOKEN_URL).length;
  revoked.add('Bearer tok1');
  const again = vd.normaliseMot(await vd.motLookup('AB12CDE', keys, 'registration'));
  assert.strictEqual(again.registration, 'AB12CDE');
  assert.strictEqual(calls.filter((x) => x.url === TOKEN_URL).length, before + 1, 'one new token fetched');
  assert.strictEqual(calls[calls.length - 1].init.headers.Authorization, 'Bearer tok' + tokenSeq);
  console.log('✓ MOT: a cached token rejected with 401 is replaced and the lookup retried once');

  // ---------- injected fetch, timeouts, no redirects ----------
  assert.strictEqual(globalFetchCalls, 0, 'global fetch never used while a fetch is injected');
  for (const x of calls) {
    assert.ok(x.init.signal instanceof AbortSignal, `${x.url} has a timeout signal`);
    assert.strictEqual(x.init.redirect, 'error', `${x.url} refuses redirects (keys must not follow one)`);
    assert.strictEqual(x.init.credentials, 'omit', `${x.url} sends no cookies`);
  }
  // A server that accepts the connection but never answers: the request is aborted by its timeout.
  const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  vd.setFetch(hang, { timeoutMs: 150 });
  let t0 = Date.now();
  assert.match(await errOf(vd.dvlaLookup('AB12CDE', 'KEY1', 'live')), /The DVLA service did not respond within 1 second\. .*driver-vehicle-licensing\.api\.gov\.uk/);
  assert.ok(Date.now() - t0 < 2000, 'DVLA aborted by the timeout');
  t0 = Date.now();
  assert.match(await errOf(vd.motLookup('AB12CDE', keys, 'registration')), /Microsoft sign-in service .* did not respond within 1 second/);
  assert.ok(Date.now() - t0 < 2000, 'token request aborted by the timeout');
  // The default timeout is 20 s (message wording) for DVLA, token and MOT requests.
  vd.setFetch(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
  assert.match(await errOf(vd.dvlaLookup('AB12CDE', 'KEY1', 'live')), /did not respond within 20 seconds/);
  assert.match(await errOf(vd.motLookup('AB12CDE', { ...keys, motClientId: 'id-t' }, 'registration')), /did not respond within 20 seconds/);
  vd.setFetch(mockFetch);
  await vd.motLookup('AB12CDE', { ...keys, motClientId: 'id-t2' }, 'registration'); // token now cached
  vd.setFetch((url, init) => (url.startsWith('https://history.') ? hang(url, init) : mockFetch(url, init)), { timeoutMs: 150 });
  assert.match(await errOf(vd.motLookup('AB12CDE', { ...keys, motClientId: 'id-t3' }, 'registration')), /The MOT History service did not respond within 1 second/);
  // setFetch() with no function goes back to the global fetch
  vd.setFetch();
  await errOf(vd.dvlaLookup('AB12CDE', 'KEY1', 'live'));
  assert.strictEqual(globalFetchCalls, 1, 'setFetch() resets to globalThis.fetch');
  vd.setFetch(mockFetch);
  console.log('✓ Transport: every request uses the injected fetch with a timeout signal, redirect:"error" and no cookies; hung DVLA / token / MOT requests time out (20 s by default)');

  // ---------- network error mapping (Node undici and Chromium net.fetch shapes) ----------
  const LEAK = ['dvla-KEY-7f3a9c11', 'mot-SECRET-55aa77bb', 'mot-APIKEY-0c0ffee0'];
  const leakKeys = { motClientId: 'id-leak', motClientSecret: LEAK[1], motApiKey: LEAK[2], motTokenUrl: TOKEN_URL };
  const mapCase = async (thrown, re, label) => {
    vd.setFetch(async () => { throw thrown; });
    const m1 = await errOf(vd.dvlaLookup('AB12CDE', LEAK[0], 'live'));
    const m2 = await errOf(vd.motLookup('AB12CDE', { ...leakKeys, motClientId: 'id-' + label }, 'registration'));
    assert.match(m1, re, `${label}: ${m1}`);
    assert.match(m2, re, `${label} (token): ${m2}`);
    for (const m of [m1, m2]) for (const k of LEAK) assert.ok(!m.includes(k), `${label}: no key in "${m}"`);
    return [m1, m2];
  };
  const [dns] = await mapCase(netErr('fetch failed', 'ENOTFOUND', 'getaddrinfo ENOTFOUND driver-vehicle-licensing.api.gov.uk'), /could not be found \(DNS lookup failed \(ENOTFOUND\)\)/, 'dns');
  assert.match(dns, /driver-vehicle-licensing\.api\.gov\.uk could not be found/);
  await mapCase(new Error('net::ERR_NAME_NOT_RESOLVED'), /DNS lookup failed \(ERR_NAME_NOT_RESOLVED\)/, 'dns-chromium');
  await mapCase(new Error('net::ERR_PROXY_CONNECTION_FAILED'), /through the network proxy \(ERR_PROXY_CONNECTION_FAILED\)/, 'proxy');
  await mapCase(new Error('net::ERR_TUNNEL_CONNECTION_FAILED'), /through the network proxy \(ERR_TUNNEL_CONNECTION_FAILED\)/, 'tunnel');
  await mapCase(netErr('fetch failed', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'unable to get local issuer certificate'), /secure \(HTTPS\) connection .* could not be verified \(UNABLE_TO_GET_ISSUER_CERT_LOCALLY\).*firewall/, 'tls');
  await mapCase(new Error('net::ERR_CERT_AUTHORITY_INVALID'), /could not be verified \(ERR_CERT_AUTHORITY_INVALID\)/, 'tls-chromium');
  await mapCase(netErr('fetch failed', null, 'unexpected redirect'), /was redirected, which the real service never does/, 'redirect');
  await mapCase(new Error("Attempted to redirect, but redirect policy was 'error'"), /was redirected/, 'redirect-chromium');
  await mapCase(netErr('fetch failed', 'ECONNREFUSED', 'connect ECONNREFUSED 1.2.3.4:443'), /Could not connect to .* \(ECONNREFUSED\)/, 'refused');
  await mapCase(new Error('net::ERR_INTERNET_DISCONNECTED'), /Could not connect to .* \(ERR_INTERNET_DISCONNECTED\)/, 'offline');
  await mapCase(new Error('net::ERR_NETWORK_ACCESS_DENIED'), /Firewall or security software on this PC blocked/, 'local-firewall');
  // undici puts the header VALUE in this message: it must never reach the user
  await mapCase(new TypeError(`Headers.append: "${LEAK[0]}\nTAIL" is an invalid header value.`), /contains a character that cannot be sent/, 'header');
  await mapCase(new TypeError(`Cannot convert argument to a ByteString because the character at index 8 has a value of 8203 which is greater than 255.`), /contains a character that cannot be sent/, 'bytestring');
  vd.setFetch(mockFetch);
  console.log('✓ Error mapping: DNS / proxy / TLS / redirect / connection / local firewall / invalid header (undici and Chromium net:: forms); no key value in any message');

  // ---------- proxy / firewall block pages ----------
  override = (url) => htmlPage(403);
  let m = await errOf(vd.dvlaLookup('AB12CDE', 'KEY1', 'live'));
  assert.match(m, /blocked by a proxy or firewall \(HTTP 403.*your credentials were not checked.*https:\/\/driver-vehicle-licensing\.api\.gov\.uk/);
  assert.ok(!/refused the API key/.test(m), 'an HTML 403 is not blamed on the key');
  assert.match(m, /^The request to the DVLA service was blocked/, 'sentence case');
  m = await errOf(vd.motLookup('AB12CDE', { ...keys, motClientId: 'id-p1' }, 'registration'));
  assert.match(m, /Microsoft sign-in service .* blocked by a proxy or firewall \(HTTP 403/);
  assert.ok(!/sign-in failed/.test(m));
  override = (url) => (url.startsWith('https://history.') ? htmlPage(401, '<!DOCTYPE html><title>Proxy</title>') : undefined);
  assert.match(await errOf(vd.motLookup('AB12CDE', keys, 'registration')), /MOT History service was blocked by a proxy or firewall \(HTTP 401/);
  override = () => new Response('Proxy Authentication Required', { status: 407 });
  assert.match(await errOf(vd.dvlaLookup('AB12CDE', 'KEY1', 'live')), /proxy asked for a sign-in \(HTTP 407\)/);
  override = () => htmlPage(200, '<html><body>Welcome to Guest Wi-Fi. Accept the terms to continue.</body></html>');
  assert.match(await errOf(vd.dvlaLookup('AB12CDE', 'KEY1', 'live')), /unexpected reply \(HTTP 200/);
  assert.match(await errOf(vd.motLookup('AB12CDE', { ...keys, motClientId: 'id-p2' }, 'registration')), /unexpected reply \(HTTP 200/);
  override = () => htmlPage(502, '<html><body>Bad gateway</body></html>');
  m = await errOf(vd.dvlaLookup('AB12CDE', 'KEY1', 'live'));
  assert.match(m, /^The DVLA service returned an unexpected reply \(HTTP 502/);
  assert.ok(!/<html|<body/i.test(m), 'no raw HTML in the message');
  override = null;
  console.log('✓ Proxy / firewall: HTML 401/403 → "blocked by a proxy or firewall" (not a key problem), 407 → proxy sign-in, HTML 200 / 502 → unexpected reply (no raw HTML)');

  // ---------- token URL and tenant validation (the client secret only ever goes to Microsoft) ----------
  const refusedUrls = [
    'https://attacker.example/collect',
    'https://login.microsoftonline.com.attacker.example/t/oauth2/v2.0/token',
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token?x=1`,
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token#x`,
    'https://login.microsoftonline.com/../oauth2/v2.0/token',
    'https://login.microsoftonline.com/a..b/oauth2/v2.0/token',
    `http://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    `https://user:pw@login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    `https://login.microsoftonline.com:8443/${TENANT}/oauth2/v2.0/token`,
    `https://login.microsoftonline.com/${TENANT}/oauth2/token`,
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token/../../x`
  ];
  for (const u of refusedUrls) {
    assert.throws(() => vd.applyDataKeyPatch({}, { motTokenUrl: u }), /access token URL was refused\. It must look like https:\/\/login\.microsoftonline\.com\/<tenant>\/oauth2\/v2\.0\/token/, u);
    const n0 = calls.length;
    assert.match(await errOf(vd.motLookup('AB12CDE', { ...keys, motTokenUrl: u }, 'registration')), /saved MOT History access token URL was refused/, u);
    assert.strictEqual(calls.length, n0, `no request at all for a stored ${u}`);
  }
  assert.strictEqual(vd.applyDataKeyPatch({}, { motTokenUrl: ` HTTPS://LOGIN.MICROSOFTONLINE.COM/${TENANT}/oauth2/v2.0/token​ ` }).motTokenUrl, TOKEN_URL, 'case and stray whitespace normalised');
  assert.strictEqual(vd.applyDataKeyPatch({}, { motTokenUrl: 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token' }).motTokenUrl, 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
  for (const t of [TENANT, 'contoso.onmicrosoft.com', 'dvsa.gov.uk']) assert.strictEqual(vd.applyDataKeyPatch({}, { motTenantId: t }).motTenantId, t);
  for (const t of ['tenant-2', '../evil', 'evil.example/collect', 'https://attacker.example/x', 'a_b.com']) {
    assert.throws(() => vd.applyDataKeyPatch({}, { motTenantId: t }), /tenant ID must be the directory \(tenant\) ID/, t);
  }
  await assert.rejects(vd.motLookup('AB12CDE', { ...keys, motTokenUrl: undefined, motTenantId: 'evil.example/collect' }, 'registration'), /saved MOT History tenant ID is not valid/);
  assert.throws(() => vd.applyDataKeyPatch({}, { motScope: 'https://attacker.example/steal' }), /scope URL must look like https:\/\/tapi\.dvsa\.gov\.uk\/\.default/);
  assert.strictEqual(vd.applyDataKeyPatch({}, { motScope: 'https://tapi.dvsa.gov.uk/.default' }).motScope, 'https://tapi.dvsa.gov.uk/.default');
  // A full token URL and a bare tenant ID replace each other; null / '' delete; unknown or non-text fields are refused.
  let k = vd.applyDataKeyPatch({ motTenantId: TENANT, dvla: 'K1' }, { motTokenUrl: TOKEN_URL });
  assert.ok(!('motTenantId' in k) && k.motTokenUrl === TOKEN_URL && k.dvla === 'K1');
  k = vd.applyDataKeyPatch(k, { motTenantId: 'contoso.onmicrosoft.com' });
  assert.ok(!('motTokenUrl' in k) && k.motTenantId === 'contoso.onmicrosoft.com', 'a tenant ID replaces a stored token URL');
  k = vd.applyDataKeyPatch(k, { dvla: null, motTenantId: '' });
  assert.deepStrictEqual(k, {});
  assert.throws(() => vd.applyDataKeyPatch({}, { motTokenURL: TOKEN_URL }), /Unknown credential field/);
  assert.throws(() => vd.applyDataKeyPatch({}, { dvla: 42 }), /DVLA API key must be text/);
  assert.throws(() => vd.applyDataKeyPatch({}, null), /Invalid credentials update/);
  console.log(`✓ Token URL: only https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token accepted (${refusedUrls.length} look-alikes refused on save AND before any request); tenant must be a GUID or domain; scope checked; patch semantics`);

  // ---------- key cleaning ----------
  assert.strictEqual(vd.cleanCredential(' ab​c d\uFEFF‮\n\t '), 'abcd', 'whitespace, NBSP, zero-width, BOM and bidi marks removed');
  assert.strictEqual(vd.validateDataKey('dvla', '  KEY​-123\r\n'), 'KEY-123');
  const bad = await errOf(Promise.resolve().then(() => vd.validateDataKey('dvla', 'KÉY-SECRET-VALUE')));
  assert.match(bad, /DVLA API key contains a character that cannot be part of it \(U\+00C9 at position 2\)/);
  assert.ok(!bad.includes('SECRET-VALUE'), 'the message never includes the key');
  assert.throws(() => vd.validateDataKey('motClientSecret', ' ​ '), /client secret is empty once spaces and invisible characters are removed/);
  assert.throws(() => vd.cleanSecret('Anthropic API key', 'sk-ant-é'), /Anthropic API key contains a character .*U\+00E9/);
  // A key saved by an older version with an invisible character is cleaned before it is sent
  await vd.dvlaLookup('AB12CDE', 'KEY1​ ', 'live');
  assert.strictEqual(calls[calls.length - 1].init.headers['x-api-key'], 'KEY1');
  await assert.rejects(vd.dvlaLookup('AB12CDE', 'KÉY1', 'live'), /DVLA API key contains a character/);
  assert.strictEqual(vd.redact(`x ${LEAK[1]} Bearer abcdefghijklmnop y`, { s: LEAK[1] }), 'x ••• Bearer ••• y');
  console.log('✓ Credentials: whitespace / invisible characters stripped, charset checked (character and position named, key never shown), older stored keys cleaned before use');

  assert.strictEqual(globalFetchCalls, 1);
  clearInterval(keepAlive);
  console.log('Data connector mock test passed.');
})().catch((e) => { console.error(e); process.exit(1); });
