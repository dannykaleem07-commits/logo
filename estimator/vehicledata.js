/*
 * UK government vehicle data connectors (main process only; keys never reach the page).
 *  - DVLA Vehicle Enquiry Service (VES) API: make, colour, fuel, cc, first registration, tax/MOT status
 *  - DVSA MOT History API: model, MOT tests with odometer readings (mileage history)
 */
'use strict';

const DVLA_URL = 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
const MOT_URL = 'https://history.mot.api.gov.uk/v1/trade/vehicles/registration/';
const MOT_SCOPE = 'https://tapi.dvsa.gov.uk/.default';

const cleanReg = (r) => String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function dvlaLookup(reg, apiKey) {
  if (!apiKey) throw new Error('No DVLA API key. Add it in Settings → Data connections.');
  const vrm = cleanReg(reg);
  if (!vrm) throw new Error('Enter a registration first.');
  const res = await fetch(DVLA_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ registrationNumber: vrm })
  });
  if (res.status === 404) throw new Error(`DVLA has no record of ${vrm}.`);
  if (res.status === 403 || res.status === 401) throw new Error('DVLA rejected the API key. Check it in Settings → Data connections.');
  if (res.status === 429) throw new Error('DVLA rate limit reached. Try again shortly.');
  if (!res.ok) throw new Error(`DVLA error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

let motToken = null; // { token, exp }
async function motAccessToken(k) {
  if (motToken && motToken.exp > Date.now() + 60000) return motToken.token;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: k.motClientId, client_secret: k.motClientSecret, scope: k.motScope || MOT_SCOPE });
  const res = await fetch(k.motTokenUrl || `https://login.microsoftonline.com/${encodeURIComponent(k.motTenantId)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  if (!res.ok) throw new Error(`MOT History sign-in failed (${res.status}). Check the client ID, secret and tenant ID.`);
  const j = await res.json();
  motToken = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return motToken.token;
}

async function motLookup(reg, k) {
  if (!k || !k.motClientId || !k.motClientSecret || !k.motApiKey || !(k.motTenantId || k.motTokenUrl)) {
    throw new Error('MOT History API details incomplete. Add client ID, client secret, API key and tenant ID in Settings → Data connections.');
  }
  const vrm = cleanReg(reg);
  const token = await motAccessToken(k);
  const res = await fetch(MOT_URL + encodeURIComponent(vrm), { headers: { Authorization: 'Bearer ' + token, 'X-API-Key': k.motApiKey, Accept: 'application/json' } });
  if (res.status === 404) throw new Error(`No MOT history found for ${vrm} (it may be under 3 years old).`);
  if (res.status === 401 || res.status === 403) { motToken = null; throw new Error('MOT History API rejected the credentials.'); }
  if (!res.ok) throw new Error(`MOT History error ${res.status}`);
  return res.json();
}

module.exports = { dvlaLookup, motLookup, cleanReg };
