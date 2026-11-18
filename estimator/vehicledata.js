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
 *
 * Networking: main.js injects Electron's net.fetch with setFetch() so requests use the Windows proxy settings (PAC/WPAD,
 * integrated proxy sign-in) and the Windows certificate store. Every request has a timeout and refuses redirects, and
 * error messages name the cause (DNS, proxy, TLS, timeout) without ever repeating a key.
 */
'use strict';
const crypto = require('crypto');

const DVLA_BASE = { live: 'https://driver-vehicle-licensing.api.gov.uk', test: 'https://uat.driver-vehicle-licensing.api.gov.uk' };
const DVLA_PATH = '/vehicle-enquiry/v1/vehicles';
const DVLA_TEST_REG = 'AA19AAA'; // one of DVLA's test registrations, as the Settings hint and the README give
const MOT_BASE = 'https://history.mot.api.gov.uk/v1/trade/vehicles/';
const MOT_SCOPE = 'https://tapi.dvsa.gov.uk/.default';
const TOKEN_HOST = 'login.microsoftonline.com';
const DEFAULT_TIMEOUT_MS = 20000;

// ---------- transport (injectable) ----------
const defaultFetch = (url, init) => globalThis.fetch(url, init);
let fetchImpl = defaultFetch;
let timeoutMs = DEFAULT_TIMEOUT_MS;
/** Use another fetch (main.js passes Electron's net.fetch; tests pass a mock). opts.timeoutMs overrides the 20 s timeout. */
function setFetch(fn, opts) {
  fetchImpl = typeof fn === 'function' ? fn : defaultFetch;
  const t = opts && Number(opts.timeoutMs);
  timeoutMs = t > 0 ? t : DEFAULT_TIMEOUT_MS;
  motToken = null;
}

// ---------- credentials ----------
// Whitespace, control and invisible format characters survive String.trim() and password inputs when a key is copied
// from an email or PDF (zero-width space, BOM, NBSP, bidi marks…). None of them can be part of a key.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Z}\u034f\u115f\u1160\u17b4\u17b5\u3164\ufe00-\ufe0f\uffa0]/gu;
const cleanCredential = (v) => String(v == null ? '' : v).replace(INVISIBLE, '');

const DATA_KEY_NAMES = ['dvla', 'motClientId', 'motClientSecret', 'motApiKey', 'motTokenUrl', 'motTenantId', 'motScope'];
const KEY_LABELS = {
  dvla: 'DVLA API key', motClientId: 'MOT History client ID', motClientSecret: 'MOT History client secret', motApiKey: 'MOT History API key',
  motTokenUrl: 'MOT History access token URL', motTenantId: 'MOT History tenant ID', motScope: 'MOT History scope URL'
};
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
// Only Microsoft Entra ID token endpoints: the client secret must never be sent anywhere else.
const TOKEN_URL = /^https:\/\/login\.microsoftonline\.com\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)\/oauth2\/v2\.0\/token$/i;
const SCOPE = /^(?:https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~-]+)*|api:\/\/[A-Za-z0-9.-]+)\/\.default$/;
const TOKEN_URL_HELP = 'It must look like https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token (copy it from the DVSA email). Other addresses are refused so that the client secret can only ever be sent to Microsoft.';

const keyError = (name, why) => new Error(`The ${KEY_LABELS[name] || name} ${why}`);
/** Keys are printable ASCII without spaces. The message names the offending character and position, never the key. */
function checkCharset(name, v) {
  if (v.length > 1024) throw keyError(name, 'is too long. Copy it again from the email.');
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) {
      const cp = v.codePointAt(i).toString(16).toUpperCase().padStart(4, '0');
      throw keyError(name, `contains a character that cannot be part of it (U+${cp} at position ${i + 1}). Copy it again from the email.`);
    }
  }
}
/** Strip whitespace and invisible characters, then check the charset. `label` names the key in error messages. */
function cleanSecret(label, value) {
  if (typeof value !== 'string') throw keyError(label, 'must be text.');
  const v = cleanCredential(value);
  if (!v) throw keyError(label, 'is empty once spaces and invisible characters are removed.');
  checkCharset(label, v);
  return v;
}
function canonicalTokenUrl(v) {
  const m = TOKEN_URL.exec(cleanCredential(v));
  return m ? `https://${TOKEN_HOST}/${m[1]}/oauth2/v2.0/token` : null;
}
function canonicalTenant(v) {
  const t = cleanCredential(v);
  return GUID.test(t) || DOMAIN.test(t) ? t : null;
}
/** Clean (strip whitespace and invisible characters) and validate one credential; returns the value to store or throws. */
function validateDataKey(name, value) {
  if (!DATA_KEY_NAMES.includes(name)) throw new Error('Unknown credential field.');
  const v = cleanSecret(name, value);
  if (name === 'motTokenUrl') { const u = canonicalTokenUrl(v); if (!u) throw keyError(name, 'was refused. ' + TOKEN_URL_HELP); return u; }
  if (name === 'motTenantId') {
    if (!canonicalTenant(v)) throw keyError(name, 'must be the directory (tenant) ID from the DVSA email: a GUID such as 1a2b3c4d-1111-2222-3333-444455556666, or a domain such as example.onmicrosoft.com.');
    return v;
  }
  if (name === 'motScope' && !SCOPE.test(v)) throw keyError(name, `must look like ${MOT_SCOPE} (copy it from the DVSA email).`);
  return v;
}
/** Apply a renderer patch ({field: value | null | ''}) to the stored credentials; returns the new object or throws. */
function applyDataKeyPatch(existing, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid credentials update.');
  const out = { ...(existing || {}) };
  for (const [name, val] of Object.entries(patch)) {
    if (!DATA_KEY_NAMES.includes(name)) throw new Error('Unknown credential field.');
    if (val === null || val === undefined || val === '') { delete out[name]; continue; }
    out[name] = validateDataKey(name, val);
  }
  // A full token URL and a bare tenant ID are alternatives: saving one replaces the other.
  if (patch.motTokenUrl) delete out.motTenantId;
  else if (patch.motTenantId) delete out.motTokenUrl;
  return out;
}
/** Remove any stored credential value from a message (defence in depth: messages are built never to contain them). */
function redact(message, k) {
  let s = String(message == null ? '' : message);
  for (const v of Object.values(k || {})) {
    if (typeof v === 'string' && v.length >= 8 && !/^https:\/\//.test(v)) s = s.split(v).join('•••');
  }
  return s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer •••');
}

const cleanReg = (r) => String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const blank = (v) => (v == null || (typeof v === 'string' && !v.trim()) ? '' : v);
const pad2 = (n) => String(n).padStart(2, '0');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- requests and error mapping ----------
function codeOf(err) {
  const msgs = [err && err.message, err && err.cause && err.cause.message].map((m) => String(m || '')).join(' ');
  const chromium = /net::(ERR_[A-Z0-9_]+)/.exec(msgs);
  if (chromium) return { code: chromium[1], text: msgs };
  const raw = (err && err.cause && (err.cause.code || err.cause.errno)) || (err && err.code) || '';
  const code = /^[A-Z][A-Z0-9_]{1,59}$/.test(String(raw)) ? String(raw) : '';
  return { code, text: msgs };
}
/** Turn a fetch() rejection into a message that says what went wrong. Never includes err.message (it can contain a key). */
function networkError(svc, err) {
  const { code, text } = codeOf(err);
  const name = (err && err.name) || '';
  const tag = code ? ` (${code})` : '';
  const site = `https://${svc.host}`;
  let msg;
  if (name === 'TimeoutError' || /^(ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT|ERR_(CONNECTION_)?TIMED_OUT)$/.test(code)) {
    const secs = Math.max(1, Math.round(timeoutMs / 1000));
    msg = `${cap(svc.name)} did not respond within ${secs} second${secs === 1 ? '' : 's'}. Try again; if it keeps happening, the service may be down or the network may be blocking ${svc.host}.`;
  } else if (name === 'AbortError') {
    msg = `The request to ${svc.name} was cancelled.`;
  } else if (/^(ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NONAME|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_DNS_[A-Z_]+)$/.test(code)) {
    msg = `Could not reach ${svc.name}: ${svc.host} could not be found (DNS lookup failed${tag}). Check the internet connection. On a company network the DNS or proxy settings may be blocking it; ask IT to allow ${site}.`;
  } else if (/^ERR_(PROXY_[A-Z_]+|TUNNEL_CONNECTION_FAILED|MANDATORY_PROXY_CONFIGURATION_FAILED|PAC_[A-Z_]+)$/.test(code) || /proxy/i.test(text)) {
    msg = `Could not reach ${svc.name} through the network proxy${tag}. Check the proxy settings in Windows, or ask IT to allow ${site}.`;
  } else if (/^(ERR_CERT_[A-Z_]+|ERR_SSL_[A-Z_]+|ERR_BAD_SSL_CLIENT_AUTH_CERT|ERR_CERTIFICATE_[A-Z_]+|ERR_TLS_[A-Z_]+|CERT_[A-Z_]+|UNABLE_TO_[A-Z_]+|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|HOSTNAME_MISMATCH|EPROTO)$/.test(code)) {
    msg = `The secure (HTTPS) connection to ${svc.host} could not be verified${tag}. Usually a company firewall is inspecting HTTPS with a certificate this PC does not trust, or the PC's date and time are wrong.`;
  } else if (/redirect/i.test(text)) {
    msg = `The request to ${svc.host} was redirected, which the real service never does. A proxy, firewall or Wi-Fi sign-in page is probably intercepting the connection.`;
  } else if (/ERR_NETWORK_ACCESS_DENIED|ERR_BLOCKED_BY_(ADMINISTRATOR|CLIENT)/.test(code)) {
    msg = `Firewall or security software on this PC blocked the connection to ${svc.host}${tag}. Ask IT to allow Engineer Report Studio to reach ${site}.`;
  } else if (name === 'TypeError' && /ByteString|header|Headers/.test(text)) {
    msg = `A saved credential for ${svc.name} contains a character that cannot be sent. Enter it again in Settings → Data connections.`;
  } else if (code) {
    msg = `Could not connect to ${svc.host}${tag}. Check the internet connection and try again.`;
  } else {
    msg = `Could not reach ${svc.name}${name ? ' (' + name + ')' : ''}. Check the internet connection and try again.`;
  }
  const e = new Error(msg);
  e.code = code || name || 'NETWORK';
  return e;
}
/** fetch with a timeout, no redirects and no cookies; reads the whole body. Network failures become networkError(). */
async function request(svc, url, init) {
  const signal = AbortSignal.timeout(timeoutMs);
  let res, text;
  try {
    res = await fetchImpl(url, { ...init, signal, redirect: 'error', credentials: 'omit' });
    text = await res.text();
  } catch (err) {
    // Once the timeout has fired it is the cause, whatever the failure says: when the headers came in time but the body
    // stalled, Electron's net.fetch fails the body read with a plain AbortError ("premature close"), not the signal's
    // TimeoutError, which would otherwise read as "the request was cancelled".
    throw networkError(svc, signal.aborted && signal.reason ? signal.reason : err);
  }
  const ctype = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '';
  let body = null;
  try { const j = JSON.parse(text); if (isObj(j)) body = j; } catch (e) { /* not JSON */ }
  const html = /text\/html/i.test(ctype) || /^\s*<(!doctype|html|head|body|title|meta)\b/i.test(text);
  return { res, status: res.status, body, html, text };
}
/** A 401/403/407 that is a web page (not the API's JSON) comes from a proxy or firewall, not from the service. */
function blockedError(svc, r) {
  if (r.status === 407) return new Error(`The network proxy asked for a sign-in (HTTP 407) and the request to ${svc.name} could not be sent. Ask IT to allow https://${svc.host} without proxy authentication, or check the proxy settings in Windows.`);
  if ((r.status === 401 || r.status === 403) && r.html) {
    return new Error(`The request to ${svc.name} was blocked by a proxy or firewall (HTTP ${r.status}: a web page came back instead of the service's reply), so your credentials were not checked. If you are on a company network, ask IT to allow https://${svc.host}.`);
  }
  return null;
}
const unexpectedReply = (svc, status) => new Error(`${cap(svc.name)} returned an unexpected reply (HTTP ${status}, not the data the service sends). A proxy, firewall or Wi-Fi sign-in page may be intercepting the connection; try again or ask IT to allow https://${svc.host}.`);

function dvlaErrorDetail(r) {
  const e = r.body && Array.isArray(r.body.errors) && r.body.errors[0];
  if (e) return [e.title, e.detail].filter(Boolean).join(': ').slice(0, 300);
  if (r.body) return String(r.body.message || r.body.Message || '').slice(0, 200);
  return r.html ? '' : String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** A yes/no field DVLA sent (true, false, or "true"/"false"); null when it sent none, so that "not stated" is never read as "No". */
function flag(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string' && /^\s*(true|false)\s*$/i.test(v)) return /true/i.test(v);
  return null;
}
const yearOf = (v) => { const n = Number(String(v == null ? '' : v).trim()); return Number.isInteger(n) && n >= 1880 && n <= 2200 ? n : 0; };
const monthOf = (v) => { const n = typeof v === 'number' || (typeof v === 'string' && /^\s*\d{1,2}\s*$/.test(v)) ? Number(v) : 0; return n >= 1 && n <= 12 ? n : 0; };
/**
 * A registration month as 'YYYY-MM-01' when DVLA gives the month ("2019-03", or 3 with the year 2019), else ''; and the
 * year whenever DVLA gives one. A year on its own is never turned into a date: "1 January" would be a month DVLA never
 * gave, and it would stop the full date from the MOT record replacing it.
 */
function registrationMonth(month, year) {
  if (typeof month === 'string' && /^\s*\d{4}-\d{2}/.test(month)) {
    const s = month.trim(), y = yearOf(s.slice(0, 4)), mo = monthOf(s.slice(5, 7));
    return y && mo ? { date: `${y}-${pad2(mo)}-01`, year: y } : { date: '', year: y || yearOf(year) };
  }
  const y = yearOf(year), mo = monthOf(month);
  return { date: y && mo ? `${y}-${pad2(mo)}-01` : '', year: y };
}

/** Turn any DVLA VES response shape into one consistent object for the app. */
function normaliseDvla(d) {
  d = d || {};
  const first = registrationMonth(d.monthOfFirstRegistration, d.yearOfFirstRegistration);
  const md = d.monthOfFirstRegistrationWithDVLA != null ? d.monthOfFirstRegistrationWithDVLA : d.monthOfFirstDvlaRegistration;
  const withDvla = registrationMonth(md, d.yearOfFirstRegistrationWithDVLA);
  const firstReg = first.date, firstRegDvla = withDvla.date;
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
    firstRegistration: firstReg, // 'YYYY-MM-01' only when DVLA gives the month
    firstRegistrationYear: first.year || '', // the year, also when DVLA gives no month
    firstRegistrationWithDvla: firstRegDvla,
    // true / false when both months are known; null when DVLA did not give both, so it cannot be said
    importedOrReRegistered: firstReg && firstRegDvla ? firstReg !== firstRegDvla : null,
    taxStatus: blank(d.taxStatus),
    taxDueDate: blank(d.taxDueDate),
    artEndDate: blank(d.artEndDate),
    motStatus: blank(d.motStatus),
    motExpiry: blank(d.motExpiry != null ? d.motExpiry : d.motExpiryDate),
    // Every field is optional in the VES spec: a flag DVLA did not send is null ("not stated"), never false ("No").
    markedForExport: flag(d.markedForExport),
    markedAsScrapped: flag(d.markedAsScrapped),
    vehicleStatus: blank(d.vehicleStatus),
    typeApproval: blank(d.typeApproval),
    wheelPlan: blank(d.wheelPlan != null ? d.wheelPlan : d.wheelplan),
    revenueWeight: d.revenueWeight || '',
    dateOfLastV5CIssued: blank(d.dateOfLastV5CIssued),
    automatedVehicle: flag(d.automatedVehicle)
  };
}

async function dvlaLookup(reg, apiKey, environment) {
  if (!apiKey) throw new Error('No DVLA API key. Add it in Settings → Data connections.');
  const key = cleanCredential(apiKey);
  checkCharset('dvla', key);
  const vrm = cleanReg(reg);
  if (!vrm) throw new Error('Enter a registration first.');
  if (vrm.length > 8) throw new Error(`${vrm.slice(0, 12)}… is too long for a UK registration.`);
  const env = environment === 'test' ? 'test' : 'live';
  const base = DVLA_BASE[env];
  const svc = { name: env === 'test' ? 'the DVLA test service' : 'the DVLA service', host: new URL(base).host };
  const r = await request(svc, base + DVLA_PATH, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ registrationNumber: vrm })
  });
  if (r.status >= 200 && r.status < 300) {
    if (!r.body) throw unexpectedReply(svc, r.status);
    // environment 'test': the data came from DVLA's test service (its made-up test vehicles), not the register
    return Object.assign(normaliseDvla(r.body), { environment: env });
  }
  const blocked = blockedError(svc, r);
  if (blocked) throw blocked;
  const detail = dvlaErrorDetail(r);
  // The test service knows only DVLA's own test registrations, so its "not found" says nothing about a real vehicle.
  const testOnly = (check) => `That service only holds DVLA's test registrations (such as ${DVLA_TEST_REG}), not real vehicles: ${check}to look up a real vehicle, set "DVLA service" to Live in Settings → Data connections (with a live API key).`;
  if (r.status === 404) throw new Error(env === 'test' ? `The DVLA test service has no record of ${vrm}. ${testOnly('')}` : `DVLA has no record of ${vrm}.`);
  if (r.status === 400) {
    throw new Error(env === 'test'
      ? `The DVLA test service could not accept ${vrm}${detail ? ' (' + detail + ')' : ''}. ${testOnly('check the registration, or ')}`
      : `DVLA could not accept ${vrm}${detail ? ' (' + detail + ')' : ''}. Check the registration.`);
  }
  if (r.status === 401 || r.status === 403) {
    throw new Error(`DVLA refused the API key (${r.status}). Check the key in Settings → Data connections. ${env === 'test' ? 'You are using the DVLA test service: test keys only work there and live keys only work on the live service.' : 'If DVLA issued you a TEST key, switch "DVLA service" to Test in Settings.'} DVLA support: dvlaapiaccess@dvla.gov.uk.`);
  }
  if (r.status === 429) throw new Error('DVLA rate limit reached (default 2 lookups per second). Wait a moment and try again.');
  if (r.status === 503) throw new Error('The DVLA service is temporarily unavailable. Try again later.');
  if (r.html) throw unexpectedReply(svc, r.status);
  throw new Error(`DVLA error ${r.status}${detail ? ': ' + detail : ''}`);
}

// ---------- MOT History ----------
let motToken = null; // { token, exp, who }
/** The Entra ID token endpoint for these credentials; throws if the stored URL / tenant is not a Microsoft one. */
function motTokenUrl(k) {
  if (k.motTokenUrl) {
    const u = canonicalTokenUrl(k.motTokenUrl);
    if (!u) throw new Error('The saved MOT History access token URL was refused. ' + TOKEN_URL_HELP + ' Enter it again in Settings → Data connections.');
    return u;
  }
  const t = canonicalTenant(k.motTenantId);
  if (!t) throw new Error('The saved MOT History tenant ID is not valid (it must be a GUID or a domain). Enter the access token URL or tenant ID from the DVSA email again in Settings → Data connections.');
  return `https://${TOKEN_HOST}/${t}/oauth2/v2.0/token`;
}
function motConfigured(k) {
  return !!(k && k.motClientId && k.motClientSecret && k.motApiKey && (k.motTokenUrl || k.motTenantId));
}
function motScope(k) {
  if (!k.motScope) return MOT_SCOPE;
  const s = cleanCredential(k.motScope);
  if (!SCOPE.test(s)) throw new Error(`The saved MOT History scope URL is not valid. It should be ${MOT_SCOPE}; enter it again in Settings → Data connections.`);
  return s;
}
async function motAccessToken(k) {
  const url = motTokenUrl(k);
  const scope = motScope(k);
  const clientId = cleanCredential(k.motClientId);
  const secret = cleanCredential(k.motClientSecret);
  checkCharset('motClientId', clientId);
  checkCharset('motClientSecret', secret);
  const who = crypto.createHash('sha256').update([clientId, secret, url, scope].join('\n')).digest('hex');
  if (motToken && motToken.who === who && motToken.exp > Date.now() + 60000) return { token: motToken.token, cached: true };
  const svc = { name: 'the Microsoft sign-in service for the MOT History API', host: TOKEN_HOST };
  const r = await request(svc, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope }).toString()
  });
  const j = r.body || {};
  if (r.status >= 200 && r.status < 300 && typeof j.access_token === 'string' && j.access_token) {
    motToken = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000, who };
    return { token: motToken.token, cached: false };
  }
  const blocked = blockedError(svc, r);
  if (blocked) throw blocked;
  if (!r.body) throw unexpectedReply(svc, r.status);
  const why = j.error_description ? String(j.error_description).split('\n')[0].trim().slice(0, 180) : String(j.error || r.status);
  throw new Error(redact(`MOT History sign-in failed (${why}). Check the client ID, client secret and access token URL / tenant ID from your DVSA email. Client secrets expire every 2 years.`, k));
}

async function motLookup(reg, k, by) {
  if (!motConfigured(k)) {
    throw new Error('MOT History API details incomplete. Add the client ID, client secret, API key and access token URL (or tenant ID) in Settings → Data connections.');
  }
  const isVin = by === 'vin';
  const id = cleanReg(reg);
  if (!id) throw new Error(isVin ? 'Enter the VIN first.' : 'Enter a registration first.');
  if (id.length > (isVin ? 20 : 8)) throw new Error(`${id.slice(0, 24)}… is too long for a ${isVin ? 'VIN' : 'UK registration'}.`);
  const apiKey = cleanCredential(k.motApiKey);
  checkCharset('motApiKey', apiKey);
  const svc = { name: 'the MOT History service', host: new URL(MOT_BASE).host };
  const url = MOT_BASE + (isVin ? 'vin/' : 'registration/') + encodeURIComponent(id);
  let tok = await motAccessToken(k);
  let r = await request(svc, url, { headers: { Authorization: 'Bearer ' + tok.token, 'X-API-Key': apiKey, Accept: 'application/json' } });
  if (r.status === 401 && tok.cached && !r.html) {
    // The cached token may have been revoked before it expired: get a new one and try once more.
    motToken = null;
    tok = await motAccessToken(k);
    r = await request(svc, url, { headers: { Authorization: 'Bearer ' + tok.token, 'X-API-Key': apiKey, Accept: 'application/json' } });
  }
  if (r.status >= 200 && r.status < 300) {
    if (!r.body) throw unexpectedReply(svc, r.status);
    return r.body;
  }
  const blocked = blockedError(svc, r);
  if (blocked) throw blocked;
  const body = r.body || {};
  const code = body.errorCode ? redact(`${body.errorCode}: ${body.errorMessage || ''}`.trim().slice(0, 200), k) : '';
  if (r.status === 404) throw new Error(`No MOT history record found for ${id}.${code ? ' (' + code + ')' : ''}`);
  if (r.status === 401 || r.status === 403) {
    motToken = null;
    throw new Error(`MOT History API refused the request${code ? ' (' + code + ')' : ''}. Check the API key and client details. Unused API keys are revoked after 90 days.`);
  }
  if (r.status === 429) throw new Error(`MOT History rate limit reached${code ? ' (' + code + ')' : ''}. Wait a few minutes and try again.`);
  if (r.html) throw unexpectedReply(svc, r.status);
  throw new Error(`MOT History error ${r.status}${code ? ' (' + code + ')' : ''}`);
}

/** MOT defect label. The spec has both a type (which can itself be DANGEROUS) and a dangerous flag. */
function defectText(x) {
  x = isObj(x) ? x : {};
  const type = x.type ? String(x.type) : '';
  const tag = x.dangerous === true && type.toUpperCase() !== 'DANGEROUS' ? (type ? type + ' (DANGEROUS)' : 'DANGEROUS') : type;
  return `${tag ? tag + ': ' : ''}${x.text || ''}`;
}

/** Normalise MOT History tests for the app: real odometer readings only, numeric, newest first. */
function normaliseMot(d) {
  d = isObj(d) ? d : {};
  const tests = (Array.isArray(d.motTests) ? d.motTests : []).filter(isObj).map((t) => {
    const read = (t.odometerResultType || 'READ') === 'READ' && t.odometerValue != null && String(t.odometerValue).trim() !== '';
    return {
      date: String(t.completedDate || '').slice(0, 10),
      result: t.testResult || '',
      odometer: read ? Number(String(t.odometerValue).replace(/[^0-9.]/g, '')) || 0 : 0,
      unit: t.odometerUnit === 'KM' ? 'km' : t.odometerUnit === 'MI' ? 'mi' : '',
      odometerResult: t.odometerResultType || '',
      expiry: String(t.expiryDate || '').slice(0, 10),
      testNumber: t.motTestNumber || '',
      defects: (Array.isArray(t.defects) ? t.defects : []).map(defectText)
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

module.exports = {
  dvlaLookup, motLookup, normaliseDvla, normaliseMot, cleanReg, motConfigured, motTokenUrl, DVLA_BASE,
  setFetch, cleanCredential, cleanSecret, validateDataKey, applyDataKeyPatch, redact, networkError, DATA_KEY_NAMES
};
