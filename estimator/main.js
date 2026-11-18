'use strict';
/*
 * Engineer Report Studio: Electron main process.
 *
 * Security model
 *  - The UI is app/index.html in a sandboxed, context-isolated window with no Node.js. The window may only ever show
 *    that file: every other navigation is cancelled (web links open in the system browser), new windows are denied,
 *    <webview> is blocked and all permission requests (camera, notifications, clipboard read…) are refused.
 *  - The page reaches this process only through the IPC channels below. Each one answers only the main window's top
 *    frame while it shows app/index.html, checks its arguments, and always replies {ok:false, error} instead of throwing.
 *  - Keys (Anthropic, DVLA, DVSA) are encrypted with the operating system (safeStorage: DPAPI on Windows) and never
 *    sent to the page. A key file that cannot be read is reported, never silently replaced.
 *  - Network calls use Electron's net.fetch, so the Windows proxy settings (PAC/WPAD, integrated proxy sign-in) and the
 *    Windows certificate store apply.
 */
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Menu, net, session } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');
const vdata = require('./vehicledata');

// ai.js reads the parts catalogue when it loads. A damaged catalogue must not stop the app from starting: jobs, reports
// and DVLA/MOT lookups do not need the AI module, so its AI buttons report the problem instead.
let ai = null;
let aiLoadError = '';
try { ai = require('./ai'); } catch (err) { aiLoadError = String((err && err.message) || err).slice(0, 200); }

const APP_INDEX = path.join(__dirname, 'app', 'index.html');
const PDF_PARTITION = 'ers-pdf-export'; // in-memory session (no "persist:" prefix) used only by the hidden PDF window
const PDF_TEMP = /^ers-report-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.html$/;
// Page margins of the exported PDF, in mm. They must match report.js `@page` for mode 'pdf' (25mm 16mm 26mm 16mm);
// the renderer may send its own as pdf:export {marginsMm} so that report.js stays the single source of truth.
const PDF_MARGINS_MM = { top: 25, bottom: 26, left: 16, right: 16 };
const SAVE_KINDS = {
  pdf: { ext: 'pdf', filters: [{ name: 'PDF document', extensions: ['pdf'] }] },
  json: { ext: 'json', filters: [{ name: 'JSON file', extensions: ['json'] }] }
};

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isWeb = (url) => /^https?:\/\//i.test(String(url || ''));
const samePath = (a, b) => {
  const A = path.resolve(a), B = path.resolve(b);
  return process.platform === 'win32' ? A.toLowerCase() === B.toLowerCase() : A === B;
};
/** Local path of a plain file: URL (no host / UNC share, no query; the #fragment is ignored), else null. */
function localPathOf(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== 'file:' || url.host !== '' || url.search) return null;
    url.hash = '';
    return fileURLToPath(url);
  } catch (e) { return null; }
}
/** True only for the app's own app/index.html (any #/route). Compared as paths, so URL-encoding and drive-letter case cannot differ. */
const isAppUrl = (u) => { const p = localPathOf(u); return !!p && samePath(p, APP_INDEX); };

let win = null;

// ---------- IPC: one guarded entry point ----------
function trustedSender(event) {
  try {
    if (!win || win.isDestroyed() || !event || !event.sender || event.sender.id !== win.webContents.id) return false;
    const frame = event.senderFrame;
    if (!frame || frame.detached || frame.parent) return false; // the top frame only, never an iframe
    return isAppUrl(frame.url);
  } catch (e) { return false; }
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedSender(event)) return { ok: false, error: 'Request refused: it did not come from the Engineer Report Studio window.' };
    try {
      return await fn(...args);
    } catch (err) {
      return { ok: false, error: fsMessage(err) || redactAll(String((err && err.message) || err)) };
    }
  });
}

// ---------- secrets in messages ----------
let aiKey = null; // the Anthropic key in use (from the key file)
function redactAll(message, extra) {
  let s = vdata.redact(message, { a: aiKey, b: process.env.ANTHROPIC_API_KEY, ...(extra || {}) });
  s = s.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-•••');
  if (/invalid header value|ByteString/i.test(s)) return 'A saved key contains a character that cannot be sent. Enter it again in Settings.';
  return s;
}
const FS_WHY = {
  EBUSY: 'the file is open in another program (for example a PDF viewer, or an antivirus scan). Close it and try again, or save under another name.',
  EPERM: 'Windows did not allow the file to be written there (access denied). If "Controlled folder access" is on, allow Engineer Report Studio or choose another folder.',
  ENOSPC: 'the disk is full. Free some space or save somewhere else.',
  ENOENT: 'the folder does not exist (any more). Choose another folder.',
  EROFS: 'that location is read-only. Choose another folder.',
  ENAMETOOLONG: 'the file name or folder path is too long.',
  EISDIR: 'that name is a folder. Choose a file name.'
};
FS_WHY.EACCES = FS_WHY.EPERM;
/** A friendly message for a file-system error on a file the user chose, or null if err is not one. */
function fsMessage(err, what) {
  const why = FS_WHY[err && err.code];
  if (!why) return null;
  return what ? `${what}: ${why}` : why.charAt(0).toUpperCase() + why.slice(1);
}
/** Key files live in the app's settings folder (%APPDATA%\Engineer Report Studio), which the user does not choose. */
function settingsWriteMessage(err, what) {
  const code = (err && err.code) || 'error';
  if (code === 'ENOSPC') return `${what}: the disk is full.`;
  return `${what} (${code}): the app's settings folder could not be written. Try again; if it keeps failing, check that ${app.getPath('userData')} is not read-only and is not being locked by antivirus or backup software.`;
}

// ---------- key storage ----------
// File format: "ERSKEY1" + mode byte + payload. Mode A = safeStorage async ciphertext, S = safeStorage (sync) ciphertext,
// P = plain UTF-8 (only when this PC has no secure storage). The mode is recorded so a file is always decoded the way it
// was written, whatever is available today. Files without the header were written by version 1.0.0 (ciphertext or plain).
const MAGIC = Buffer.from('ERSKEY1');
const KEY_FILE = () => path.join(app.getPath('userData'), 'ai-key.bin');
const DATA_FILE = () => path.join(app.getPath('userData'), 'data-keys.bin');
const hasAsyncCrypto = () => typeof safeStorage.isAsyncEncryptionAvailable === 'function' && typeof safeStorage.encryptStringAsync === 'function' && typeof safeStorage.decryptStringAsync === 'function';
async function asyncCryptoAvailable() { try { return hasAsyncCrypto() && (await safeStorage.isAsyncEncryptionAvailable()) === true; } catch (e) { return false; } }
function syncCryptoAvailable() { try { return safeStorage.isEncryptionAvailable() === true; } catch (e) { return false; } }
/** How keys are protected on this PC: 'os' (OS encryption), 'weak' (Linux fixed-key fallback), 'none' (plain text). */
async function storageProtection() {
  const mode = (await asyncCryptoAvailable()) ? 'A' : syncCryptoAvailable() ? 'S' : 'P';
  let protection = mode === 'P' ? 'none' : 'os';
  if (mode !== 'P' && process.platform === 'linux') {
    try { if (safeStorage.getSelectedStorageBackend() === 'basic_text') protection = 'weak'; } catch (e) { /* unknown backend */ }
  }
  return { mode, protection, encrypted: protection === 'os' };
}
const coded = (code) => Object.assign(new Error(code), { code });
async function encodeSecret(text) {
  const { mode } = await storageProtection();
  const payload = mode === 'A' ? await safeStorage.encryptStringAsync(text) : mode === 'S' ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8');
  return Buffer.concat([MAGIC, Buffer.from(mode), Buffer.from(payload)]);
}
async function decryptPayload(payload) {
  let tried = false;
  const asyncOk = await asyncCryptoAvailable();
  if (asyncOk) {
    tried = true;
    try { const r = await safeStorage.decryptStringAsync(payload); return { text: r.result, reencrypt: !!r.shouldReEncrypt }; } catch (e) { /* try the sync API */ }
  }
  if (syncCryptoAvailable()) {
    tried = true;
    try { return { text: safeStorage.decryptString(payload), reencrypt: asyncOk }; } catch (e) { /* fall through */ }
  }
  throw coded(tried ? 'EDECRYPT' : 'NOCRYPTO');
}
async function decodeKeyFile(buf, plausible) {
  if (buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    const mode = String.fromCharCode(buf[MAGIC.length]);
    const payload = buf.subarray(MAGIC.length + 1);
    if (mode === 'P') return { text: payload.toString('utf8'), reencrypt: (await storageProtection()).mode !== 'P' };
    if (mode === 'A' || mode === 'S') return decryptPayload(payload);
    throw coded('EFORMAT');
  }
  // Version 1.0.0 file: ciphertext if secure storage was available when it was saved, otherwise plain text.
  let cryptoErr = null;
  try {
    const r = await decryptPayload(buf);
    if (plausible(r.text)) return { text: r.text, reencrypt: true };
  } catch (e) { cryptoErr = e; }
  const text = buf.toString('utf8');
  if (plausible(text)) return { text, reencrypt: true };
  throw coded(cryptoErr && cryptoErr.code === 'NOCRYPTO' ? 'NOCRYPTO' : 'EDECRYPT');
}
/** Write atomically (temp file + rename) so a failed write never leaves a truncated key file. */
async function writeKeyFile(file, text) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const data = await encodeSecret(text);
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
    await fs.promises.rename(tmp, file);
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
}
/** {state:'missing'} | {state:'ok', text} | {state:'error', code}. Only a missing file means "no keys". */
async function readKeyFile(file, plausible) {
  let buf;
  try { buf = await fs.promises.readFile(file); } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'missing' };
    return { state: 'error', code: (err && err.code) || 'EREAD' };
  }
  if (!buf.length) return { state: 'missing' };
  try {
    const r = await decodeKeyFile(buf, plausible);
    if (r.reencrypt) await writeKeyFile(file, r.text).catch(() => { /* keep the readable original */ });
    return { state: 'ok', text: r.text };
  } catch (err) {
    return { state: 'error', code: (err && err.code) || 'EDECRYPT' };
  }
}
function keyFileMessage(code, what) {
  if (code === 'EDECRYPT') return `The saved ${what} could not be decrypted. This happens when the settings were copied from another PC or Windows user account, or Windows reset this account's encryption keys (for example after an administrator reset the password).`;
  if (code === 'NOCRYPTO') return `The saved ${what} are encrypted, but this PC's secure storage (Windows data protection or the system keyring) is not available right now.`;
  if (code === 'EFORMAT') return `The saved ${what} file is damaged.`;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return `The saved ${what} could not be read (${code}): another program, often antivirus or backup software, is using the file, or access was denied. Try again in a moment.`;
  return `The saved ${what} could not be read (${code}).`;
}
// Every key-file read and write runs one at a time, so two saves can never interleave.
let keyQueue = Promise.resolve();
function withKeyLock(fn) {
  const run = keyQueue.then(fn, fn);
  keyQueue = run.catch(() => {});
  return run;
}

const looksLikeAiKey = (t) => /^[\x21-\x7e]{8,1024}$/.test(String(t).trim());
const looksLikeDataKeys = (t) => {
  try {
    const o = JSON.parse(t);
    return isObj(o) && Object.entries(o).every(([k, v]) => vdata.DATA_KEY_NAMES.includes(k) && typeof v === 'string');
  } catch (e) { return false; }
};
async function loadAiKey() {
  const r = await readKeyFile(KEY_FILE(), looksLikeAiKey);
  if (r.state === 'ok') aiKey = vdata.cleanCredential(r.text) || null;
  else if (r.state === 'missing') aiKey = null; // on a read error keep the key already in use
  if (ai) ai.setApiKey(aiKey);
  return r;
}
async function readDataKeys() {
  const r = await readKeyFile(DATA_FILE(), looksLikeDataKeys);
  if (r.state === 'missing') return { state: 'missing', keys: {} };
  if (r.state === 'error') return r;
  try {
    const keys = JSON.parse(r.text);
    if (!isObj(keys)) throw new Error('not an object');
    return { state: 'ok', keys };
  } catch (e) { return { state: 'error', code: 'EFORMAT' }; }
}
const DATA_WHAT = 'data-connection credentials (DVLA / MOT History)';
const unreadableDataKeys = (code) => `${keyFileMessage(code, DATA_WHAT)} Nothing was changed, so they are not lost. Try again, or remove all saved data-connection credentials and enter them again.`;

// ---------- AI ----------
const aiUnavailable = () => `The AI assessor could not be started (${aiLoadError || 'unknown error'}). The rest of the app works; reinstall or update Engineer Report Studio to restore AI features.`;
function aiCall(fn) {
  return async (p) => {
    if (!ai) return { ok: false, error: aiUnavailable() };
    if (p != null && !isObj(p)) return { ok: false, error: 'Invalid request.' };
    try {
      return { ok: true, result: await fn(p || {}) };
    } catch (err) {
      let msg;
      try { msg = ai.describeError(err); } catch (e) { msg = 'The AI request failed.'; }
      return { ok: false, error: redactAll(String(msg || 'The AI request failed.')) };
    }
  };
}

// ---------- PDF export ----------
const pdfAllowed = new Set(); // temp files the hidden PDF window may load
let pdfSessionReady = false;
function pdfSession() {
  const ses = session.fromPartition(PDF_PARTITION);
  if (!pdfSessionReady) {
    pdfSessionReady = true;
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    // Only the report's own temp file and inline data: images may load; no web, UNC (file://host/share) or other files.
    ses.webRequest.onBeforeRequest((details, callback) => {
      const u = String(details.url || '');
      const p = localPathOf(u);
      const allowed = /^data:/i.test(u) || (!!p && [...pdfAllowed].some((t) => samePath(p, t)));
      callback({ cancel: !allowed });
    });
  }
  return ses;
}
// Belt and braces with the webRequest filter: a CSP that allows only inline styles and data: images. It goes straight
// after the doctype so that it is in <head> before any content the renderer sent.
const PDF_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:">';
function withPdfCsp(html) {
  const m = /^\uFEFF?\s*(<!doctype[^>]*>)?/i.exec(html);
  return (m[1] || '<!doctype html>') + PDF_CSP + html.slice(m[0].length);
}
function pdfMargins(mm) {
  const m = { ...PDF_MARGINS_MM };
  if (isObj(mm)) for (const k of Object.keys(m)) { const v = Number(mm[k]); if (Number.isFinite(v) && v >= 0 && v <= 60) m[k] = v; }
  const inch = (v) => Math.round((v / 25.4) * 10000) / 10000;
  return { top: inch(m.top), bottom: inch(m.bottom), left: inch(m.left), right: inch(m.right) };
}
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}
async function renderPdf(html, { header, footer, margins }) {
  const tmp = path.join(app.getPath('temp'), `ers-report-${crypto.randomUUID()}.html`);
  let pdfWin = null;
  pdfAllowed.add(tmp);
  try {
    // 'wx': never follow or overwrite an existing file; 0o600: readable by this user only.
    await fs.promises.writeFile(tmp, withPdfCsp(html), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    pdfSession(); // request filter and permission handlers are in place before the window exists
    pdfWin = new BrowserWindow({
      show: false,
      webPreferences: { partition: PDF_PARTITION, sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false, webviewTag: false, devTools: false, spellcheck: false }
    });
    const wc = pdfWin.webContents;
    wc.on('will-navigate', (e) => e.preventDefault()); // e.g. <meta http-equiv="refresh">
    wc.on('will-redirect', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    await withTimeout(pdfWin.loadFile(tmp), 60000, 'The report took too long to load for the PDF. Try again.');
    // Option shapes as in electron.d.ts PrintToPDFOptions / PrintToPDFMargins (margins in inches; no marginType).
    return await withTimeout(wc.printToPDF({
      pageSize: 'A4',
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: header || '<span></span>', // an empty template would print Chromium's default date/title header
      footerTemplate: footer || '<span></span>',
      margins
    }), 120000, 'Creating the PDF took too long. Try again.');
  } finally {
    pdfAllowed.delete(tmp);
    if (pdfWin && !pdfWin.isDestroyed()) pdfWin.destroy();
    await fs.promises.rm(tmp, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }).catch(() => { /* swept at next start */ });
  }
}
/** Remove report temp files left behind by a crash or a killed process (single instance, so none can be in use). */
async function sweepStaleExports() {
  try {
    const dir = app.getPath('temp');
    for (const name of await fs.promises.readdir(dir)) {
      if (PDF_TEMP.test(name)) await fs.promises.rm(path.join(dir, name), { force: true }).catch(() => {});
    }
  } catch (e) { /* temp folder unavailable */ }
}

// ---------- save dialogs ----------
let lastSaveDir = '';
function saveDir() {
  if (lastSaveDir) return lastSaveDir;
  try { return app.getPath('documents'); } catch (e) { return app.getPath('home'); }
}
/** Suggested file name: the base name only, safe characters, the kind's extension; never a path the renderer chose. */
function safeFileName(name, fallback, ext) {
  let base = String(typeof name === 'string' ? name : '').split(/[\\/]/).pop().normalize('NFC');
  base = base.replace(/[^\p{L}\p{N} ._()-]+/gu, '_').replace(/_{2,}/g, '_').replace(/^[\s._-]+|[\s.]+$/g, '').slice(0, 120).replace(/[\s.]+$/, '');
  if (base.toLowerCase().endsWith('.' + ext)) base = base.slice(0, -(ext.length + 1)).replace(/[\s.]+$/, '');
  if (!base) base = fallback;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base)) base = '_' + base;
  return `${base}.${ext}`;
}
async function askSavePath(kind, name, fallback, title) {
  const k = SAVE_KINDS[kind];
  const opts = { title, defaultPath: path.join(saveDir(), safeFileName(name, fallback, k.ext)), filters: k.filters };
  const parent = win && !win.isDestroyed() ? win : null;
  const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
  if (!r || r.canceled || !r.filePath) return null;
  return r.filePath;
}
const rememberDir = (filePath) => { lastSaveDir = path.dirname(filePath); };

// ---------- IPC handlers ----------
function registerIpc() {
  handle('ai:status', async () => {
    const r = await withKeyLock(loadAiKey);
    const p = await storageProtection();
    const out = { ok: true, hasKey: !!aiKey || !!process.env.ANTHROPIC_API_KEY, encrypted: p.encrypted, protection: p.protection };
    const errors = [];
    if (r.state === 'error') errors.push(keyFileMessage(r.code, 'Anthropic API key') + ' Enter the key again to replace it.');
    if (!ai) errors.push(aiUnavailable());
    else if (typeof ai.aiStatus === 'function') {
      try { const s = ai.aiStatus(); if (s && s.ok === false && s.error) errors.push(String(s.error)); } catch (e) { /* status only */ }
    }
    if (errors.length) out.error = errors.join(' ');
    return out;
  });
  handle('ai:setKey', (key) => withKeyLock(async () => {
    if (key === null || key === undefined || key === '') {
      try { await fs.promises.rm(KEY_FILE(), { force: true }); } catch (err) { return { ok: false, error: settingsWriteMessage(err, 'The key could not be removed') }; }
      aiKey = null;
      if (ai) ai.setApiKey(null);
      return { ok: true };
    }
    let clean;
    try { clean = vdata.cleanSecret('Anthropic API key', key); } catch (err) { return { ok: false, error: err.message }; }
    if (clean.length < 8) return { ok: false, error: 'That is too short to be an Anthropic API key. Copy it again from the Anthropic Console.' };
    try { await writeKeyFile(KEY_FILE(), clean); } catch (err) { return { ok: false, error: settingsWriteMessage(err, 'The key could not be saved') }; }
    aiKey = clean;
    if (ai) ai.setApiKey(clean);
    const p = await storageProtection();
    return { ok: true, encrypted: p.encrypted, protection: p.protection };
  }));
  handle('ai:test', aiCall((p) => ai.testConnection({ model: typeof p.model === 'string' ? p.model : undefined })));
  handle('ai:analysePhotos', aiCall((p) => ai.analysePhotos(p)));
  handle('ai:draftNarrative', aiCall((p) => ai.draftNarrative(p)));
  handle('ai:valuation', aiCall((p) => ai.valuationAssistant(p)));

  handle('data:status', () => withKeyLock(async () => {
    const r = await readDataKeys();
    const k = r.keys || {};
    const p = await storageProtection();
    const out = { ok: true, dvla: !!k.dvla, mot: vdata.motConfigured(k), motTokenUrl: !!(k.motTokenUrl || k.motTenantId), encrypted: p.encrypted, protection: p.protection };
    if (r.state === 'error') { out.unreadable = true; out.error = `${keyFileMessage(r.code, DATA_WHAT)} Enter them again after choosing "Remove all saved credentials", or try again if the file was only busy.`; }
    return out;
  }));
  handle('data:setKeys', (patch) => withKeyLock(async () => {
    if (!isObj(patch)) return { ok: false, error: 'Invalid credentials update.' };
    const r = await readDataKeys();
    if (r.state === 'error') {
      // Never overwrite credentials that could not be read: only an explicit "remove everything" may replace them.
      const clearsAll = vdata.DATA_KEY_NAMES.every((n) => n in patch && (patch[n] === null || patch[n] === ''));
      if (!clearsAll) return { ok: false, code: 'unreadable', error: unreadableDataKeys(r.code) };
      try { await fs.promises.rm(DATA_FILE(), { force: true }); } catch (err) { return { ok: false, error: settingsWriteMessage(err, 'The credentials could not be removed') }; }
      return { ok: true, cleared: true };
    }
    let next;
    try { next = vdata.applyDataKeyPatch(r.keys, patch); } catch (err) { return { ok: false, error: err.message }; }
    try {
      if (!Object.keys(next).length) await fs.promises.rm(DATA_FILE(), { force: true });
      else await writeKeyFile(DATA_FILE(), JSON.stringify(next));
    } catch (err) { return { ok: false, error: settingsWriteMessage(err, 'The credentials could not be saved') }; }
    const p = await storageProtection();
    return { ok: true, encrypted: p.encrypted, protection: p.protection };
  }));
  // Explicit "remove all saved data-connection credentials": the way out when the file cannot be read.
  handle('data:clearKeys', () => withKeyLock(async () => {
    try { await fs.promises.rm(DATA_FILE(), { force: true }); } catch (err) { return { ok: false, error: settingsWriteMessage(err, 'The credentials could not be removed') }; }
    return { ok: true };
  }));
  handle('data:dvla', async (p) => {
    if (!isObj(p) || typeof p.reg !== 'string' || !p.reg.trim()) return { ok: false, error: 'Enter a registration first.' };
    const r = await withKeyLock(readDataKeys);
    if (r.state === 'error') return { ok: false, error: unreadableDataKeys(r.code) };
    try {
      return { ok: true, result: await vdata.dvlaLookup(p.reg, r.keys.dvla, p.env === 'test' ? 'test' : 'live') };
    } catch (err) { return { ok: false, error: redactAll(err.message, r.keys) }; }
  });
  handle('data:mot', async (p) => {
    const by = isObj(p) && p.by === 'vin' ? 'vin' : 'registration';
    if (!isObj(p) || typeof p.id !== 'string' || !p.id.trim()) return { ok: false, error: by === 'vin' ? 'Enter the VIN first.' : 'Enter a registration first.' };
    const r = await withKeyLock(readDataKeys);
    if (r.state === 'error') return { ok: false, error: unreadableDataKeys(r.code) };
    try {
      return { ok: true, result: vdata.normaliseMot(await vdata.motLookup(p.id, r.keys, by)) };
    } catch (err) { return { ok: false, error: redactAll(err.message, r.keys) }; }
  });

  handle('pdf:export', async (p) => {
    if (!isObj(p) || typeof p.html !== 'string' || !p.html) return { ok: false, error: 'There is no report to export.' };
    const header = typeof p.header === 'string' ? p.header : '';
    const footer = typeof p.footer === 'string' ? p.footer : '';
    if (header.length > 8e6 || footer.length > 8e6) return { ok: false, error: 'The report header or footer is too large (is the logo very big?).' };
    const filePath = await askSavePath('pdf', p.fileName, 'engineering-report', 'Save report as PDF');
    if (!filePath) return { ok: false, canceled: true };
    let pdf;
    try {
      pdf = await renderPdf(p.html, { header, footer, margins: pdfMargins(p.marginsMm) });
    } catch (err) {
      if (err && typeof err.code === 'string' && /^E[A-Z]+$/.test(err.code)) {
        return { ok: false, error: `The PDF could not be prepared (${err.code}) in the Windows temporary folder. Check that there is free disk space and that the TEMP folder exists.` };
      }
      return { ok: false, error: `The PDF could not be created: ${redactAll(String((err && err.message) || err))}` };
    }
    try { await fs.promises.writeFile(filePath, pdf); } catch (err) { return { ok: false, error: fsMessage(err, 'The PDF could not be saved') || `The PDF could not be saved (${err.code || err.message}).` }; }
    rememberDir(filePath);
    Promise.resolve(shell.openPath(filePath)).catch(() => {});
    return { ok: true, filePath };
  });
  handle('file:save', async (p) => {
    if (!isObj(p) || typeof p.content !== 'string') return { ok: false, error: 'There is nothing to save.' };
    const kind = p.kind === 'json' || !p.kind ? 'json' : null; // renderer-supplied filters are ignored
    if (!kind) return { ok: false, error: 'That file type cannot be saved.' };
    const filePath = await askSavePath(kind, p.fileName, 'export', 'Save file');
    if (!filePath) return { ok: false, canceled: true };
    try { await fs.promises.writeFile(filePath, p.content, 'utf8'); } catch (err) { return { ok: false, error: fsMessage(err, 'The file could not be saved') || `The file could not be saved (${err.code || err.message}).` }; }
    rememberDir(filePath);
    return { ok: true, filePath };
  });
}

// ---------- windows ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1024, minHeight: 680,
    title: 'Engineer Report Studio',
    backgroundColor: '#f3f5f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webviewTag: false, navigateOnDragDrop: false, devTools: !app.isPackaged
    }
  });
  const wc = win.webContents;
  // Links that open a new window go to the system browser, and only when they are web links:
  // never hand file:, smb:, ms-msdt: or other protocol URLs (e.g. from AI web-search results) to the OS.
  wc.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  // The window may only show the app's own index.html. Anything else (a dropped .html or photo file, another local or
  // network page, a web link without target=_blank) is cancelled; web links open in the system browser instead.
  wc.on('will-navigate', (e, legacyUrl) => {
    const url = (e && e.url) || legacyUrl;
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (isWeb(url)) shell.openExternal(url).catch(() => {});
  });
  wc.on('will-redirect', (e, legacyUrl) => { if (!isAppUrl((e && e.url) || legacyUrl)) e.preventDefault(); });
  win.on('closed', () => { win = null; });
  win.loadFile(APP_INDEX).catch((err) => {
    if (/ERR_ABORTED|\(-3\)/.test(String(err && err.message))) return; // superseded by another load (e.g. a reload)
    dialog.showErrorBox('Engineer Report Studio', `The app window could not be loaded.\n\n${(err && err.message) || err}`);
  });
}
function focusMainWindow() {
  if (!win || win.isDestroyed()) { if (app.isReady()) createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function buildMenu() {
  const view = [{ role: 'reload' }];
  if (!app.isPackaged) view.push({ role: 'toggleDevTools' }); // developer tools only when running from source
  view.push({ type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' }, { role: 'togglefullscreen' });
  return Menu.buildFromTemplate([
    { label: 'File', submenu: [{ role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: view }
  ]);
}
async function onReady() {
  // Chromium's network stack: Windows proxy (PAC/WPAD, integrated sign-in) and certificate store.
  const viaChromium = (input, init) => net.fetch(input, init);
  vdata.setFetch(viaChromium);
  if (ai && typeof ai.setFetch === 'function') ai.setFetch(viaChromium);
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  if (typeof ses.setDevicePermissionHandler === 'function') ses.setDevicePermissionHandler(() => false);
  Menu.setApplicationMenu(buildMenu());
  await withKeyLock(loadAiKey).catch(() => {});
  sweepStaleExports();
  createWindow();
  app.on('activate', () => { if (!win || win.isDestroyed()) createWindow(); });
}

if (!app.requestSingleInstanceLock()) {
  // Another copy is already running on this profile (jobs live in its IndexedDB): it is focused instead.
  app.quit();
} else {
  app.on('second-instance', focusMainWindow);
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' })); // the main window replaces this with its own handler
  });
  registerIpc();
  app.whenReady().then(onReady).catch((err) => {
    dialog.showErrorBox('Engineer Report Studio', `Engineer Report Studio could not start.\n\n${(err && err.message) || err}`);
    app.quit();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

// Exposed for tests run under a fake 'electron' module; not used by the app.
module.exports = { isAppUrl, safeFileName, pdfMargins, withPdfCsp, PDF_MARGINS_MM };
