/*
 * UK government vehicle data connectors (main process only; keys never reach the page).
 *  - DVLA Vehicle Enquiry Service (VES) API v1.2.0
 *      POST {base}/vehicle-enquiry/v1/vehicles, header x-api-key, body {"registrationNumber":"AB12CDE"}
 *      live: https://driver-vehicle-licensing.api.gov.uk   test (UAT): https://uat.driver-vehicle-licensing.api.gov.uk
 *      Responses differ between versions/environments (e.g. monthOfFirstRegistration "2019-03" vs 12 + yearOfFirstRegistration,
 *      motExpiryDate vs motExpiry, wheelplan vs wheelPlan) so results are normalised by normaliseDvla().
 *      Errors: {"errors":[{"status","code","title","detail"}]}; 429 = throttled (default 2 requests/second).
 *  - DVSA MOT History API v1
 *      OAuth2 client credentials (Microsoft Entra ID): POST token URL (from the DVSA email, contains the tenant ID),
 *      scope https://tapi.dvsa.gov.uk/.default; then GET https://history.mot.api.gov.uk/v1/trade/vehicles/registration/{vrm}
 *      (or /vin/{vin}) with headers Authorization: Bearer <token> and X-API-Key.
 *      Errors: {"errorCode":"MOTH-…","errorMessage","requestId"}.
 *      Vehicles under 3 years old return a "new registration" record (motTestDueDate, no motTests).
 */
'use strict';

const DVLA_BASE = { live: 'https://driver-vehicle-licensing.api.gov.uk', test: 'https://uat.driver-vehicle-licensing.api.gov.uk' };
const DVLA_PATH = '/vehicle-enquiry/v1/vehicles';
const MOT_BASE = 'https://history.mot.api.gov.uk/v1/trade/vehicles/';
const MOT_SCOPE = 'https://tapi.dvsa.gov.uk/.default';

const cleanReg = (r) => String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const blank = (v) => (v == null || (typeof v === 'string' && !v.trim()) ? '' : v);
const pad2 = (n) => String(n).padStart(2, '0');

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { _raw: text }; }
}
function dvlaErrorDetail(body) {
  const e = body && Array.isArray(body.errors) && body.errors[0];
  if (e) return [e.title, e.detail].filter(Boolean).join(': ');
  return (body && (body.message || body.Message)) || (body && body._raw ? String(body._raw).slice(0, 200) : '');
}

/** Turn any DVLA VES response shape into one consistent object for the app. */
function normaliseDvla(d) {
  d = d || {};
  let firstReg = '';
  const m = d.monthOfFirstRegistration;
  if (typeof m === 'string' && /^\d{4}-\d{2}/.test(m)) firstReg = m.slice(0, 7) + '-01';
  else if (d.yearOfFirstRegistration && m) firstReg = `${d.yearOfFirstRegistration}-${pad2(m)}-01`;
  else if (d.yearOfFirstRegistration) firstReg = `${d.yearOfFirstRegistration}-01-01`;
  let firstRegDvla = '';
  const md = d.monthOfFirstRegistrationWithDVLA != null ? d.monthOfFirstRegistrationWithDVLA : d.monthOfFirstDvlaRegistration;
  if (typeof md === 'string' && /^\d{4}-\d{2}/.test(md)) firstRegDvla = md.slice(0, 7) + '-01';
  else if (d.yearOfFirstRegistrationWithDVLA && md) firstRegDvla = `${d.yearOfFirstRegistrationWithDVLA}-${pad2(md)}-01`;
  return {
    registrationNumber: d.registrationNumber || '',
    make: blank(d.make),
    colour: blank(d.colour),
    fuelType: blank(d.fuelType),
    engineCapacity: d.engineCapacity || '',
    co2Emissions: d.co2Emissions != null ? d.co2Emissions : '',
    euroStatus: blank(d.euroStatus),
    realDrivingEmissions: blank(d.realDrivingEmissions),
    yearOfManufacture: d.yearOfManufacture || '',
    firstRegistration: firstReg,
    firstRegistrationWithDvla: firstRegDvla,
    importedOrReRegistered: !!(firstReg && firstRegDvla && firstReg !== firstRegDvla),
    taxStatus: blank(d.taxStatus),
    taxDueDate: blank(d.taxDueDate),
    artEndDate: blank(d.artEndDate),
    motStatus: blank(d.motStatus),
    motExpiry: blank(d.motExpiry != null ? d.motExpiry : d.motExpiryDate),
    markedForExport: !!d.markedForExport,
    markedAsScrapped: !!d.markedAsScrapped,
    vehicleStatus: blank(d.vehicleStatus),
    typeApproval: blank(d.typeApproval),
    wheelPlan: blank(d.wheelPlan != null ? d.wheelPlan : d.wheelplan),
    revenueWeight: d.revenueWeight || '',
    dateOfLastV5CIssued: blank(d.dateOfLastV5CIssued),
    automatedVehicle: d.automatedVehicle === true
  };
}

async function dvlaLookup(reg, apiKey, environment) {
  if (!apiKey) throw new Error('No DVLA API key. Add it in Settings → Data connections.');
  const vrm = cleanReg(reg);
  if (!vrm) throw new Error('Enter a registration first.');
  const base = DVLA_BASE[environment === 'test' ? 'test' : 'live'];
  let res;
  try {
    res = await fetch(base + DVLA_PATH, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ registrationNumber: vrm })
    });
  } catch (e) {
    throw new Error('Could not reach the DVLA service. Check the internet connection and try again.');
  }
  const body = await readJson(res);
  if (res.ok) return normaliseDvla(body);
  const detail = dvlaErrorDetail(body);
  if (res.status === 404) throw new Error(`DVLA has no record of ${vrm}.`);
  if (res.status === 400) throw new Error(`DVLA could not accept ${vrm}${detail ? ' (' + detail + ')' : ''}. Check the registration.`);
  if (res.status === 401 || res.status === 403) {
    throw new Error(`DVLA refused the API key (${res.status}). Check the key in Settings → Data connections. ${environment === 'test' ? 'You are using the DVLA test service: test keys only work there and live keys only work on the live service.' : 'If DVLA issued you a TEST key, switch "DVLA service" to Test in Settings.'} DVLA support: dvlaapiaccess@dvla.gov.uk.`);
  }
  if (res.status === 429) throw new Error('DVLA rate limit reached (default 2 lookups per second). Wait a moment and try again.');
  if (res.status === 503) throw new Error('The DVLA service is temporarily unavailable. Try again later.');
  throw new Error(`DVLA error ${res.status}${detail ? ': ' + detail : ''}`);
}

let motToken = null; // { token, exp, who }
function motTokenUrl(k) {
  const t = String(k.motTokenUrl || k.motTenantId || '').trim();
  if (/^https:\/\//i.test(t)) return t;
  return `https://login.microsoftonline.com/${encodeURIComponent(t)}/oauth2/v2.0/token`;
}
function motConfigured(k) {
  return !!(k && k.motClientId && k.motClientSecret && k.motApiKey && (k.motTokenUrl || k.motTenantId));
}
async function motAccessToken(k) {
  const who = k.motClientId + '|' + motTokenUrl(k);
  if (motToken && motToken.who === who && motToken.exp > Date.now() + 60000) return motToken.token;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: k.motClientId, client_secret: k.motClientSecret, scope: (k.motScope || MOT_SCOPE).trim() });
  let res;
  try {
    res = await fetch(motTokenUrl(k), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  } catch (e) {
    throw new Error('Could not reach the Microsoft sign-in service for the MOT History API. Check the internet connection.');
  }
  const j = await readJson(res);
  if (!res.ok || !j.access_token) {
    const why = j.error_description ? String(j.error_description).split('\n')[0].slice(0, 180) : (j.error || res.status);
    throw new Error(`MOT History sign-in failed (${why}). Check the client ID, client secret and access token URL / tenant ID from your DVSA email. Client secrets expire every 2 years.`);
  }
  motToken = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000, who };
  return motToken.token;
}

async function motLookup(reg, k, by) {
  if (!motConfigured(k)) {
    throw new Error('MOT History API details incomplete. Add the client ID, client secret, API key and access token URL (or tenant ID) in Settings → Data connections.');
  }
  const isVin = by === 'vin';
  const id = isVin ? String(reg || '').toUpperCase().replace(/[^A-Z0-9]/g, '') : cleanReg(reg);
  if (!id) throw new Error(isVin ? 'Enter the VIN first.' : 'Enter a registration first.');
  const token = await motAccessToken(k);
  let res;
  try {
    res = await fetch(MOT_BASE + (isVin ? 'vin/' : 'registration/') + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + token, 'X-API-Key': k.motApiKey, Accept: 'application/json' } });
  } catch (e) {
    throw new Error('Could not reach the MOT History service. Check the internet connection.');
  }
  const body = await readJson(res);
  if (res.ok) return body;
  const code = body.errorCode ? `${body.errorCode}: ${body.errorMessage || ''}`.trim() : '';
  if (res.status === 404) throw new Error(`No MOT history record found for ${id}.${code ? ' (' + code + ')' : ''}`);
  if (res.status === 401 || res.status === 403) {
    motToken = null;
    throw new Error(`MOT History API refused the request${code ? ' (' + code + ')' : ''}. Check the API key and client details. Unused API keys are revoked after 90 days.`);
  }
  if (res.status === 429) throw new Error(`MOT History rate limit reached${code ? ' (' + code + ')' : ''}. Wait a few minutes and try again.`);
  throw new Error(`MOT History error ${res.status}${code ? ' (' + code + ')' : ''}`);
}

/** Normalise MOT History tests for the app: real odometer readings only, numeric, newest first. */
function normaliseMot(d) {
  d = d || {};
  const tests = (d.motTests || []).map((t) => {
    const read = (t.odometerResultType || 'READ') === 'READ' && t.odometerValue != null && String(t.odometerValue).trim() !== '';
    return {
      date: String(t.completedDate || '').slice(0, 10),
      result: t.testResult || '',
      odometer: read ? Number(String(t.odometerValue).replace(/[^0-9.]/g, '')) || 0 : 0,
      unit: t.odometerUnit === 'KM' ? 'km' : t.odometerUnit === 'MI' ? 'mi' : '',
      odometerResult: t.odometerResultType || '',
      expiry: String(t.expiryDate || '').slice(0, 10),
      testNumber: t.motTestNumber || '',
      defects: (t.defects || []).map((x) => `${x.type ? x.type + (x.dangerous ? ' (DANGEROUS)' : '') + ': ' : ''}${x.text || ''}`)
    };
  }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return {
    registration: d.registration || '',
    make: d.make || '',
    model: d.model || '',
    fuelType: d.fuelType || '',
    primaryColour: d.primaryColour || '',
    engineSize: d.engineSize || '',
    firstUsedDate: d.firstUsedDate || '',
    registrationDate: d.registrationDate || '',
    manufactureDate: d.manufactureDate || '',
    motTestDueDate: d.motTestDueDate || '',
    recall: d.hasOutstandingRecall === true ? 'Yes' : d.hasOutstandingRecall === false ? 'No' : String(d.hasOutstandingRecall || ''),
    tests
  };
}

module.exports = { dvlaLookup, motLookup, normaliseDvla, normaliseMot, cleanReg, motConfigured, DVLA_BASE };
