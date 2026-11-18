#!/usr/bin/env node
'use strict';
/*
 * Proof for estimator/main.js: loads it under a fake 'electron' module (Module._resolveFilename + require.cache stub)
 * and exercises single-instance, window hardening, navigation guards, IPC sender checks, key-file failure handling,
 * credential validation, save-dialog sanitising and PDF temp-file handling. Nothing under the repo is written:
 * userData / temp / documents point into a scratch directory. Run: node tools/main-mocktest.js  (ERS_ROOT overrides the app dir)
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');

// The app folder: ERS_ROOT, else the parent of this file (estimator/).
const APP_ROOT = process.env.ERS_ROOT || path.join(__dirname, '..');
const MAIN = path.join(APP_ROOT, 'main.js');
const APP_INDEX = path.join(APP_ROOT, 'app', 'index.html');
const APP_URL = pathToFileURL(APP_INDEX).href;
const RUN = fs.mkdtempSync(path.join(process.env.ERS_TEST_TMP || os.tmpdir(), 'ers-main-proof-')); // removed on success
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String(e && e.message || e)));

// ---------------- fake electron ----------------
let S; // per-boot state
function freshState(o = {}) {
  const dirs = { userData: path.join(RUN, 'userData'), temp: path.join(RUN, 'temp'), documents: path.join(RUN, 'docs'), home: RUN };
  for (const d of [dirs.temp, dirs.documents]) fs.mkdirSync(d, { recursive: true });
  return {
    dirs, handlers: new Map(), windows: [], isPackaged: true, lock: true, quitCalls: 0, errorBoxes: [], menus: [], focus: [],
    crypto: true, backend: 'gnome_libsecret', keyId: 1,
    dialogResult: null, saveDialogCalls: [], openExternal: [], openPath: [], printCalls: [],
    printToPDF: async () => Buffer.from('%PDF-1.7 fake'), loadFile: async () => {},
    netFetch: async () => new Response(JSON.stringify({ registrationNumber: 'AB12CDE', make: 'FORD' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    netFetchCalls: [], sessions: new Map(), aiThrows: false, aiFake: true, aiCalls: { setApiKey: [], setFetch: [] },
    ...o
  };
}
const enc = (s, keyId) => Buffer.concat([Buffer.from('v10'), Buffer.from([keyId]), Buffer.from(String(s), 'utf8').map((b) => b ^ 0x5a)]);
const dec = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.subarray(0, 3).toString() !== 'v10') throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
  return { text: Buffer.from(buf.subarray(4).map((b) => b ^ 0x5a)).toString('utf8'), keyId: buf[3] };
};
let wcIds = 0;
class FakeWebContents extends EventEmitter {
  constructor(win) { super(); this.id = ++wcIds; this.win = win; }
  setWindowOpenHandler(fn) { this.windowOpenHandler = fn; }
  async printToPDF(opts) { S.printCalls.push(opts); return S.printToPDF(opts, this.win); }
}
function makeSession(name) {
  const s = {
    name, req: null, check: null, device: null, beforeRequest: null,
    setPermissionRequestHandler(fn) { s.req = fn; }, setPermissionCheckHandler(fn) { s.check = fn; }, setDevicePermissionHandler(fn) { s.device = fn; },
    webRequest: { onBeforeRequest(a, b) { s.beforeRequest = typeof a === 'function' ? a : b; } }
  };
  return s;
}
const app = new EventEmitter();
Object.assign(app, {
  getPath: (n) => { if (!S.dirs[n]) throw new Error('unknown path ' + n); return S.dirs[n]; },
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  requestSingleInstanceLock: () => S.lock,
  quit: () => { S.quitCalls++; }
});
Object.defineProperty(app, 'isPackaged', { get: () => S.isPackaged });
class BrowserWindow extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.webContents = new FakeWebContents(this); S.windows.push(this); app.emit('web-contents-created', {}, this.webContents); }
  loadFile(p) { this.loaded = p; return S.loadFile(p, this); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  isDestroyed() { return !!this.destroyed; }
  isMinimized() { return !!this.minimized; }
  restore() { S.focus.push('restore'); this.minimized = false; }
  show() { S.focus.push('show'); }
  focus() { S.focus.push('focus'); }
  static getAllWindows() { return S.windows.filter((w) => !w.destroyed); }
}
const electron = {
  app, BrowserWindow,
  ipcMain: { handle: (ch, fn) => { assert.ok(!S.handlers.has(ch), 'handler registered twice: ' + ch); S.handlers.set(ch, fn); } },
  dialog: {
    showSaveDialog: async (a, b) => { const opts = b || a; S.saveDialogCalls.push({ parent: b ? a : null, opts }); return S.dialogResult || { canceled: false, filePath: path.join(S.dirs.documents, opts.defaultPath ? path.basename(opts.defaultPath) : 'x') }; },
    showErrorBox: (t, m) => S.errorBoxes.push(m)
  },
  safeStorage: {
    isEncryptionAvailable: () => S.crypto,
    encryptString: (s) => { if (!S.crypto) throw new Error('Encryption is not available.'); return enc(s, S.keyId); },
    decryptString: (b) => { if (!S.crypto) throw new Error('Decryption is not available.'); return dec(b).text; },
    isAsyncEncryptionAvailable: async () => S.crypto,
    encryptStringAsync: async (s) => { if (!S.crypto) throw new Error('Encryption is not available.'); return enc(s, S.keyId); },
    decryptStringAsync: async (b) => { if (!S.crypto) throw new Error('Decryption is not available.'); const d = dec(b); return { result: d.text, shouldReEncrypt: d.keyId !== S.keyId }; },
    getSelectedStorageBackend: () => S.backend
  },
  shell: { openExternal: async (u) => { S.openExternal.push(u); }, openPath: async (p) => { S.openPath.push(p); return ''; } },
  Menu: { buildFromTemplate: (t) => t, setApplicationMenu: (m) => S.menus.push(m) },
  net: { fetch: async (input, init) => { S.netFetchCalls.push(String(input)); return S.netFetch(String(input), init); } },
  session: {
    get defaultSession() { if (!S.sessions.has('')) S.sessions.set('', makeSession('')); return S.sessions.get(''); },
    fromPartition: (p) => { if (!S.sessions.has(p)) S.sessions.set(p, makeSession(p)); return S.sessions.get(p); }
  }
};
const FAKE_ID = path.join(RUN, 'electron-fake.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { return request === 'electron' ? FAKE_ID : origResolve.call(this, request, ...rest); };
require.cache[FAKE_ID] = Object.assign(new Module(FAKE_ID), { id: FAKE_ID, filename: FAKE_ID, loaded: true, exports: electron });
// './ai' from main.js: a spy (default), the real ai.js, or a module that throws like a damaged catalogue would
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './ai' && parent && parent.filename === MAIN) {
    if (S.aiThrows) throw new SyntaxError('Unexpected end of input');
    if (S.aiFake) return S.aiModule;
  }
  return origLoad.apply(this, arguments);
};

async function boot(o = {}) {
  S = freshState(o);
  S.aiModule = {
    setApiKey: (k) => S.aiCalls.setApiKey.push(k),
    setFetch: (fn) => S.aiCalls.setFetch.push(fn),
    describeError: (e) => e.message,
    testConnection: async (p) => { if (S.aiTestThrows) throw S.aiTestThrows; return { ok: true, model: p.model || 'default' }; },
    analysePhotos: async (p) => ({ echo: p }), draftNarrative: async (p) => ({ echo: p }), valuationAssistant: async (p) => ({ echo: p })
  };
  for (const f of ['main.js', 'vehicledata.js', 'ai.js']) delete require.cache[path.join(APP_ROOT, f)];
  app.removeAllListeners();
  require(MAIN);
  for (let i = 0; i < 50 && (S.lock && !S.windows.length); i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
  return S;
}
const mainWin = () => S.windows[0];
const appEvent = (url = APP_URL + '#/jobs', extra = {}) => ({ sender: mainWin().webContents, senderFrame: { url, parent: null, detached: false }, ...extra });
const call = async (ch, ...args) => { const r = await S.handlers.get(ch)(appEvent(), ...args); assert.ok(r && typeof r === 'object' && typeof r.ok === 'boolean', `${ch} returns {ok}: ${JSON.stringify(r)}`); return r; };
const navigate = (wc, ev, url) => { const e = { url, prevented: false, preventDefault() { this.prevented = true; } }; for (const l of wc.listeners(ev)) l(e, url); return e.prevented; };
const KEY_FILE = () => path.join(S.dirs.userData, 'ai-key.bin');
const DATA_FILE = () => path.join(S.dirs.userData, 'data-keys.bin');
const ok = (m) => console.log('✓ ' + m);
const TENANT = '1a2b3c4d-1111-2222-3333-444455556666';

(async () => {
  // ================= 1. single instance, window hardening, menu, startup =================
  fs.writeFileSync(path.join(RUN, 'temp-seed'), '');
  fs.mkdirSync(path.join(RUN, 'temp'), { recursive: true });
  const stale = path.join(RUN, 'temp', 'ers-report-0b7f7f3e-2c1d-4d8e-9a6b-1f2e3d4c5b6a.html');
  const unrelated = path.join(RUN, 'temp', 'report-1794970441196.html');
  fs.writeFileSync(stale, 'stale PII'); fs.writeFileSync(unrelated, 'not ours');
  await boot({ lock: false });
  assert.strictEqual(S.quitCalls, 1); assert.strictEqual(S.windows.length, 0); assert.strictEqual(S.handlers.size, 0);
  ok('Second launch: requestSingleInstanceLock() false → app.quit(), no window, no IPC handlers');

  await boot({ isPackaged: true });
  const w = mainWin();
  assert.strictEqual(w.loaded, APP_INDEX);
  const wp = w.opts.webPreferences;
  assert.deepStrictEqual([wp.contextIsolation, wp.nodeIntegration, wp.sandbox, wp.webviewTag, wp.navigateOnDragDrop, wp.devTools], [true, false, true, false, false, false]);
  const view = S.menus[0].find((m) => m.label === 'View').submenu.map((i) => i.role).filter(Boolean);
  assert.ok(!view.includes('toggleDevTools') && view.includes('reload'), 'packaged: no DevTools in View menu');
  assert.ok(!fs.existsSync(stale) && fs.existsSync(unrelated), 'stale ers-report temp file swept, unrelated file kept');
  app.emit('second-instance', {}, ['x'], RUN); w.minimized = true; app.emit('second-instance', {}, ['x'], RUN);
  assert.deepStrictEqual(S.focus, ['show', 'focus', 'restore', 'show', 'focus']);
  ok('Packaged boot: sandbox + contextIsolation, no node, webviewTag/navigateOnDragDrop/devTools off; View menu without DevTools; second launch restores + focuses the window; stale PDF temp files swept at start');

  // permissions
  const ds = S.sessions.get('');
  let granted = null; ds.req(w.webContents, 'media', (g) => { granted = g; }, {});
  assert.strictEqual(granted, false); granted = null; ds.req(w.webContents, 'clipboard-read', (g) => { granted = g; }, {}); assert.strictEqual(granted, false);
  assert.strictEqual(ds.check(w.webContents, 'notifications', 'file://', {}), false);
  assert.strictEqual(ds.device({}), false);
  ok('Permissions: request handler denies (media, clipboard-read), check handler and device handler return false');

  // networking: vehicledata and ai.js use Electron's net.fetch
  assert.strictEqual(S.aiCalls.setFetch.length, 1);
  await S.aiCalls.setFetch[0]('https://api.anthropic.com/v1/messages', {});
  assert.deepStrictEqual(S.netFetchCalls, ['https://api.anthropic.com/v1/messages']);
  ok('Networking: ai.setFetch() given a function that calls net.fetch (guarded with typeof)');

  // navigation guards
  const wc = w.webContents;
  for (const u of [APP_URL, APP_URL + '#/job/abc/report']) assert.strictEqual(navigate(wc, 'will-navigate', u), false, 'allowed ' + u);
  const blocked = ['file:///C:/Users/eng/Downloads/claim-pack.html', 'file://fileserver.example/share/app/index.html', APP_URL + '?x=1',
    pathToFileURL(path.join(APP_ROOT, 'app', 'other.html')).href, pathToFileURL(path.join(os.tmpdir(), 'photo.jpg')).href, 'https://example.org/', 'smb://host/share', 'about:blank'];
  for (const u of blocked) assert.strictEqual(navigate(wc, 'will-navigate', u), true, 'blocked ' + u);
  assert.deepStrictEqual(S.openExternal, ['https://example.org/'], 'only the web link went to the system browser');
  assert.strictEqual(navigate(wc, 'will-redirect', 'https://example.org/'), true);
  assert.deepStrictEqual(wc.windowOpenHandler({ url: 'https://dealer.example/ad/1' }), { action: 'deny' });
  assert.deepStrictEqual(wc.windowOpenHandler({ url: 'file:///C:/Windows/System32/calc.exe' }), { action: 'deny' });
  assert.deepStrictEqual(S.openExternal, ['https://example.org/', 'https://dealer.example/ad/1']);
  assert.strictEqual(navigate(wc, 'will-attach-webview', 'x'), true, 'webview attachment prevented');
  ok(`Navigation: only app/index.html (any #route) allowed; ${blocked.length} other targets (dropped/local/UNC html, query, photo, web, smb:, about:) blocked; web links → system browser; window.open denied; <webview> blocked`);

  // dev boot: DevTools available from source only
  await boot({ isPackaged: false });
  assert.ok(S.menus[0].find((m) => m.label === 'View').submenu.some((i) => i.role === 'toggleDevTools'));
  assert.strictEqual(mainWin().opts.webPreferences.devTools, true);
  ok('Running from source (!app.isPackaged): DevTools in the View menu and enabled');

  // loadFile promise handled
  await boot({ loadFile: async () => { throw new Error("ERR_FILE_NOT_FOUND (-6) loading 'file:///x/index.html'"); } });
  assert.strictEqual(S.errorBoxes.length, 1); assert.match(S.errorBoxes[0], /could not be loaded/);
  await boot({ loadFile: async () => { throw new Error("ERR_ABORTED (-3) loading 'file:///x/index.html'"); } });
  assert.strictEqual(S.errorBoxes.length, 0);
  ok('win.loadFile() rejection handled: error box for a failed load, ignored for ERR_ABORTED (superseded load)');

  // ai.js failing to load (e.g. a damaged catalogue) does not stop the app
  await boot({ aiThrows: true });
  assert.strictEqual(S.windows.length, 1);
  let r = await call('ai:status'); assert.strictEqual(r.ok, true); assert.match(r.error, /AI assessor could not be started \(Unexpected end of input\)/);
  r = await call('ai:test', {}); assert.strictEqual(r.ok, false); assert.match(r.error, /could not be started/);
  r = await call('data:status'); assert.strictEqual(r.ok, true);
  ok('ai.js throwing at require time: window still opens, data features work, AI channels answer {ok:false, "AI assessor could not be started …"}');

  // real ai.js loads and has no setFetch yet / or has one: either way it is guarded
  await boot({ aiFake: false });
  r = await call('ai:status'); assert.strictEqual(r.ok, true);
  ok('Real ai.js: main.js boots and ai:status answers (ai.setFetch ' + (typeof require(path.join(APP_ROOT, 'ai.js')).setFetch === 'function' ? 'present and wired' : 'absent, guarded') + ')');

  // ================= 2. IPC sender validation =================
  await boot();
  const evilFrames = [
    ['web page', { senderFrame: { url: 'https://evil.example/', parent: null } }],
    ['local html', { senderFrame: { url: 'file:///C:/Users/eng/Downloads/claim-pack.html', parent: null } }],
    ['UNC html', { senderFrame: { url: 'file://fileserver.example/share/app/index.html', parent: null } }],
    ['app url + query', { senderFrame: { url: APP_URL + '?evil=1', parent: null } }],
    ['iframe on app url', { senderFrame: { url: APP_URL, parent: { url: APP_URL } } }],
    ['detached frame', { senderFrame: { url: APP_URL, parent: null, detached: true } }],
    ['no frame', { senderFrame: null }],
    ['other webContents', { sender: new FakeWebContents(null), senderFrame: { url: APP_URL, parent: null } }]
  ];
  for (const ch of S.handlers.keys()) {
    for (const [label, ev] of evilFrames) {
      const res = await S.handlers.get(ch)({ ...appEvent(), ...ev }, { motTokenUrl: 'https://attacker.example/collect' });
      assert.strictEqual(res.ok, false, `${ch} from ${label}`); assert.match(res.error, /Request refused/);
    }
  }
  assert.ok(!fs.existsSync(DATA_FILE()), 'nothing written by refused calls');
  const enc2 = APP_URL.replace(/estimator/, 'estimat%6Fr').replace(/index\.html$/, 'ind%65x.html');
  assert.strictEqual((await S.handlers.get('data:status')(appEvent(enc2 + '#/settings'))).ok, true, 'same file, different percent-encoding');
  ok(`IPC: all ${S.handlers.size} channels refuse ${evilFrames.length} untrusted senders (web, local/UNC html, query, iframe, detached, null frame, other webContents); the app frame is accepted however its URL is encoded`);

  // ================= 3. credentials through IPC =================
  r = await call('data:setKeys', { motClientId: 'cid', motClientSecret: 'TOP-SECRET-CLIENT-SECRET', motApiKey: 'apikey', motTokenUrl: 'https://attacker.example/collect' });
  assert.strictEqual(r.ok, false); assert.match(r.error, /access token URL was refused/); assert.ok(!r.error.includes('TOP-SECRET'));
  assert.ok(!fs.existsSync(DATA_FILE()), 'refused update writes nothing');
  r = await call('data:setKeys', { dvla: 42 }); assert.strictEqual(r.ok, false); assert.match(r.error, /must be text/);
  r = await call('data:setKeys', 'dvla'); assert.strictEqual(r.ok, false);
  r = await call('data:setKeys', { dvla: ' DVLA-KEY-0001\u200b\n', motClientId: 'cid', motClientSecret: 'secret', motApiKey: 'apikey', motTokenUrl: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token` });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.encrypted, true);
  r = await call('data:status'); assert.deepStrictEqual([r.dvla, r.mot, r.motTokenUrl, r.encrypted, r.protection, r.error], [true, true, true, true, 'os', undefined]);
  // the stored key was cleaned; lookups go through net.fetch with it
  S.netFetchCalls.length = 0;
  let seenKey = null;
  S.netFetch = async (url, init) => { if (url.includes('driver-vehicle')) seenKey = init.headers['x-api-key']; return url.includes('login.microsoftonline') ? new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }), { status: 200 }) : new Response(JSON.stringify({ registrationNumber: 'AB12CDE', registration: 'AB12CDE', motTests: [{ completedDate: '2024-01-01T00:00:00Z', testResult: 'PASSED', odometerValue: '100', odometerUnit: 'MI', odometerResultType: 'READ', defects: [{ type: 'DANGEROUS', dangerous: true, text: 'Brake hose ruptured' }] }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  r = await call('data:dvla', { reg: 'ab12 cde', env: 'live' }); assert.strictEqual(r.ok, true); assert.strictEqual(seenKey, 'DVLA-KEY-0001');
  r = await call('data:mot', { id: 'AB12CDE', by: 'registration' }); assert.strictEqual(r.ok, true); assert.deepStrictEqual(r.result.tests[0].defects, ['DANGEROUS: Brake hose ruptured']);
  assert.deepStrictEqual(S.netFetchCalls.map((u) => new URL(u).host), ['driver-vehicle-licensing.api.gov.uk', 'login.microsoftonline.com', 'history.mot.api.gov.uk']);
  r = await call('data:dvla', { reg: 42 }); assert.strictEqual(r.ok, false);
  r = await call('data:mot', null); assert.strictEqual(r.ok, false);
  S.netFetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }); };
  r = await call('data:dvla', { reg: 'AB12CDE' }); assert.match(r.error, /DNS lookup failed \(ENOTFOUND\)/);
  ok('Credentials: attacker token URL refused in main (nothing stored, secret not echoed); non-text refused; keys cleaned of invisible chars; DVLA/MOT lookups go through net.fetch; DANGEROUS label not doubled; network errors named');

  // ================= 4. key files: never silently lost =================
  // S1: no secure storage → stored as plain text but reported (encrypted:false) by both status channels
  await boot({ crypto: false });
  r = await call('ai:setKey', '  sk-ant-api03-PLAINKEY-0001\u200b ');
  assert.deepStrictEqual([r.ok, r.encrypted, r.protection], [true, false, 'none']);
  assert.strictEqual(fs.readFileSync(KEY_FILE()).subarray(0, 8).toString(), 'ERSKEY1P');
  assert.deepStrictEqual([(await call('ai:status')).encrypted, (await call('data:status')).encrypted], [false, false]);
  assert.strictEqual(S.aiCalls.setApiKey.slice(-1)[0], 'sk-ant-api03-PLAINKEY-0001');
  // S2: secure storage becomes available → still readable, and the file is upgraded to encrypted
  S.crypto = true;
  r = await call('ai:status'); assert.deepStrictEqual([r.hasKey, r.encrypted, r.error], [true, true, undefined]);
  assert.strictEqual(fs.readFileSync(KEY_FILE()).subarray(0, 8).toString(), 'ERSKEY1A', 'plain-text key re-encrypted once possible');
  // S2b: encrypted key, secure storage gone → error reported, ciphertext never used as the key
  S.crypto = false;
  r = await call('ai:status'); assert.match(r.error, /saved Anthropic API key cannot be decrypted right now: this PC's secure storage .* is not available/);
  assert.ok(S.aiCalls.setApiKey.every((k) => k === null || /^sk-ant-api03-PLAINKEY-0001$/.test(k)), 'no ciphertext ever passed to ai.setApiKey');
  S.crypto = true;
  // Linux basic_text backend = weak
  S.backend = 'basic_text';
  if (process.platform === 'linux') { r = await call('ai:status'); assert.deepStrictEqual([r.encrypted, r.protection], [false, 'weak']); }
  S.backend = 'gnome_libsecret';
  // Key rotation: shouldReEncrypt → rewritten with the current key
  S.keyId = 2; await call('ai:status');
  assert.strictEqual(fs.readFileSync(KEY_FILE())[MAGIC_LEN() + 3], 2, 're-encrypted after shouldReEncrypt');
  ok('Keys: no secure storage → saved but encrypted:false/protection:none in ai:status AND data:status; upgraded to encrypted when possible; undecryptable key reported (never used as ciphertext); Linux basic_text → protection "weak"; shouldReEncrypt honoured');

  // Version 1.0.0 files (no header) are still read
  await boot();
  fs.mkdirSync(S.dirs.userData, { recursive: true });
  fs.writeFileSync(KEY_FILE(), 'sk-ant-api03-LEGACYPLAIN');
  r = await call('ai:status'); assert.deepStrictEqual([r.hasKey, r.error], [true, undefined]);
  fs.writeFileSync(KEY_FILE(), enc('sk-ant-api03-LEGACYENC', 2));
  r = await call('ai:status'); assert.strictEqual(r.hasKey, true); assert.strictEqual(S.aiCalls.setApiKey.slice(-1)[0], 'sk-ant-api03-LEGACYENC');
  fs.writeFileSync(DATA_FILE(), JSON.stringify({ dvla: 'LEGACY-DVLA-1', motTenantId: TENANT }));
  r = await call('data:status'); assert.deepStrictEqual([r.dvla, r.error], [true, undefined]);
  ok('Version 1.0.0 key files (plain text or sync-encrypted, no header) are still read and migrated');

  // S3: data keys that cannot be read are never overwritten by a partial update
  await call('data:setKeys', { dvla: 'DVLA-KEY-0002', motClientId: 'cid', motClientSecret: 'csecret-xyz', motApiKey: 'mkey-123456', motTenantId: TENANT });
  const good = fs.readFileSync(DATA_FILE());
  fs.writeFileSync(DATA_FILE(), Buffer.concat([good.subarray(0, 8), Buffer.from('garbage-not-ciphertext')]));
  const broken = fs.readFileSync(DATA_FILE());
  r = await call('data:status'); assert.deepStrictEqual([r.unreadable, r.dvla, r.mot], [true, false, false]); assert.match(r.error, /could not be decrypted/);
  r = await call('data:setKeys', { dvla: 'NEW-DVLA-KEY' }); assert.deepStrictEqual([r.ok, r.code], [false, 'unreadable']); assert.match(r.error, /Nothing was changed, so they are not lost/);
  r = await call('data:setKeys', { dvla: null }); assert.strictEqual(r.ok, false, 'a partial clear is refused too');
  assert.ok(fs.readFileSync(DATA_FILE()).equals(broken), 'unreadable file left untouched');
  r = await call('data:dvla', { reg: 'AB12CDE' }); assert.strictEqual(r.ok, false); assert.match(r.error, /could not be decrypted/);
  // EISDIR / EBUSY-like read errors behave the same; a transient error clears on retry
  fs.renameSync(DATA_FILE(), DATA_FILE() + '.bak'); fs.mkdirSync(DATA_FILE());
  r = await call('data:setKeys', { dvla: 'NEW-DVLA-KEY' }); assert.strictEqual(r.ok, false); assert.match(r.error, /could not be read \(EISDIR\)/);
  fs.rmdirSync(DATA_FILE()); fs.renameSync(DATA_FILE() + '.bak', DATA_FILE());
  // explicit clear: data:clearKeys, or a patch that clears every field
  r = await call('data:setKeys', Object.fromEntries(['dvla', 'motClientId', 'motClientSecret', 'motApiKey', 'motTokenUrl', 'motTenantId', 'motScope'].map((k) => [k, null])));
  assert.deepStrictEqual([r.ok, r.cleared], [true, true]); assert.ok(!fs.existsSync(DATA_FILE()));
  fs.writeFileSync(DATA_FILE(), broken);
  r = await call('data:clearKeys'); assert.strictEqual(r.ok, true); assert.ok(!fs.existsSync(DATA_FILE()));
  r = await call('data:status'); assert.deepStrictEqual([r.dvla, r.unreadable, r.error], [false, undefined, undefined]);
  ok('Data keys: undecryptable / unreadable (EISDIR) file → status {unreadable, error}; setKeys (even a partial clear) refused with the file untouched; lookups report it; only data:clearKeys or clearing every field removes it');

  // Atomic writes, permissions, unwritable settings folder, non-string input
  await call('data:setKeys', { dvla: 'DVLA-KEY-0003' }); await call('ai:setKey', 'sk-ant-api03-ATOMIC-0001');
  assert.deepStrictEqual(fs.readdirSync(S.dirs.userData).sort(), ['ai-key.bin', 'data-keys.bin'], 'no temp files left');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(KEY_FILE()).mode & 0o777, 0o600);
  r = await call('ai:setKey', 123); assert.deepStrictEqual([r.ok, /must be text/.test(r.error)], [false, true]);
  r = await call('ai:setKey', 'sk-ant-\u00e9-KEY-SECRET-PART'); assert.strictEqual(r.ok, false); assert.match(r.error, /U\+00E9 at position 8/); assert.ok(!r.error.includes('SECRET-PART'));
  r = await call('ai:setKey', ''); assert.strictEqual(r.ok, true); assert.ok(!fs.existsSync(KEY_FILE()));
  S.dirs.userData = path.join(RUN, 'not-a-dir'); fs.writeFileSync(S.dirs.userData, 'file in the way');
  r = await call('ai:setKey', 'sk-ant-api03-NOWHERE-0001'); assert.strictEqual(r.ok, false); assert.match(r.error, /The key could not be saved \((ENOTDIR|EEXIST)\): the app's settings folder could not be written/);
  r = await call('data:setKeys', { dvla: 'DVLA-KEY-0004' }); assert.strictEqual(r.ok, false);
  S.dirs.userData = path.join(RUN, 'fresh-userData'); // missing folder is created
  r = await call('ai:setKey', 'sk-ant-api03-CREATED-0001'); assert.strictEqual(r.ok, true);
  ok('Writes are atomic (no temp left), key files 0600, missing settings folder created, unwritable one → {ok:false, friendly}; non-text / bad-character keys refused without echoing the key');

  // Every channel answers {ok} for garbage input, never throws
  for (const ch of S.handlers.keys()) for (const arg of [undefined, null, 0, 'x', [], {}, { html: 5 }, { content: {} }]) await call(ch, arg);
  ok(`All ${S.handlers.size} channels resolve to {ok:…} for 8 kinds of bad input (no rejected invoke)`);

  // AI error messages never carry a key
  S.aiTestThrows = new TypeError('Headers.append: "Bearer sk-ant-api03-SECRET\nTAIL" is an invalid header value.');
  r = await call('ai:test', {}); assert.strictEqual(r.ok, false); assert.ok(!/SECRET|TAIL/.test(r.error)); assert.match(r.error, /cannot be sent/);
  S.aiTestThrows = new Error('upstream said: bad key sk-ant-api03-ABCDEFGHIJ');
  r = await call('ai:test', {}); assert.ok(!r.error.includes('ABCDEFGHIJ'));
  S.aiTestThrows = null;
  r = await call('ai:test', { model: 'claude-opus-5-5' }); assert.deepStrictEqual(r.result, { ok: true, model: 'claude-opus-5-5' });
  ok('AI errors: invalid-header and sk-ant-… key text redacted before reaching the page');

  // ================= 5. save dialogs =================
  await boot();
  const docs = S.dirs.documents;
  S.dialogResult = { canceled: false, filePath: path.join(docs, 'job.json') };
  r = await call('file:save', { content: '{}', fileName: 'C:\\Users\\Public\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\update.bat', filters: [{ name: 'Batch', extensions: ['bat'] }] });
  let d = S.saveDialogCalls.slice(-1)[0];
  assert.strictEqual(d.opts.defaultPath, path.join(docs, 'update.bat.json'));
  assert.deepStrictEqual(d.opts.filters, [{ name: 'JSON file', extensions: ['json'] }]);
  assert.strictEqual(d.parent, mainWin());
  assert.strictEqual(fs.readFileSync(path.join(docs, 'job.json'), 'utf8'), '{}');
  const names = { '..\\..\\x': 'x.pdf', '../../etc/passwd': 'passwd.pdf', 'CON': '_CON.pdf', 'ER/123:<>|?*"report': '123_report.pdf', 'Müller AB12 CDE': 'Müller AB12 CDE.pdf', '': 'engineering-report.pdf', 'ref.pdf': 'ref.pdf', '.hidden': 'hidden.pdf', 'a\u202egpj.exe': 'a_gpj.exe.pdf' };
  for (const [input, want] of Object.entries(names)) {
    S.dialogResult = { canceled: true };
    r = await call('pdf:export', { html: '<p>x</p>', header: '', footer: '', fileName: input });
    assert.deepStrictEqual(r, { ok: false, canceled: true });
    d = S.saveDialogCalls.slice(-1)[0];
    assert.strictEqual(path.basename(d.opts.defaultPath), want, JSON.stringify(input));
    assert.deepStrictEqual(d.opts.filters, [{ name: 'PDF document', extensions: ['pdf'] }]);
  }
  // the next dialog opens where the user last saved
  fs.mkdirSync(path.join(RUN, 'chosen'), { recursive: true });
  S.dialogResult = { canceled: false, filePath: path.join(RUN, 'chosen', 'b.json') };
  await call('file:save', { content: '{}', fileName: 'b.json' });
  S.dialogResult = { canceled: true };
  await call('file:save', { content: '{}', fileName: 'c.json' });
  assert.strictEqual(path.dirname(S.saveDialogCalls.slice(-1)[0].opts.defaultPath), path.join(RUN, 'chosen'));
  S.dialogResult = { canceled: false, filePath: path.join(RUN, 'missing-dir', 'job.json') };
  r = await call('file:save', { content: '{}', fileName: 'j.json' }); assert.strictEqual(r.ok, false); assert.match(r.error, /folder does not exist/);
  r = await call('file:save', { content: { a: 1 }, fileName: 'j.json' }); assert.strictEqual(r.ok, false);
  r = await call('file:save', { content: '{}', fileName: 'j.csv', kind: 'bat' }); assert.strictEqual(r.ok, false);
  ok(`Save dialogs: base name only, safe characters (${Object.keys(names).length} cases incl. ..\\, Startup path, CON, bidi override), fixed PDF/JSON filters (renderer filters ignored), Documents or last-used folder; cancel / write failure / bad input → {ok:false}`);

  // ================= 6. PDF export =================
  let seen = null;
  S.loadFile = async (p, win) => {
    seen = { path: p, name: path.basename(p), mode: fs.statSync(p).mode & 0o777, html: fs.readFileSync(p, 'utf8'), opts: win.opts, wc: win.webContents };
  };
  S.dialogResult = { canceled: false, filePath: path.join(docs, 'r8.pdf') };
  const hostile = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=https://example.invalid/"></head><body><img src="file://attacker.example/share/x.png"><img src="https://tracker.example/p.gif"></body></html>';
  r = await call('pdf:export', { html: hostile, header: '<span class="title"></span>', footer: '', fileName: 'r8' });
  assert.deepStrictEqual(r, { ok: true, filePath: path.join(docs, 'r8.pdf') });
  assert.match(seen.name, /^ers-report-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.html$/, 'random temp name');
  assert.strictEqual(path.dirname(seen.path), S.dirs.temp);
  if (process.platform !== 'win32') assert.strictEqual(seen.mode, 0o600, 'temp file readable by this user only');
  assert.ok(seen.html.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:">'), 'CSP first in <head>');
  assert.ok(!fs.existsSync(seen.path), 'temp file deleted');
  assert.deepStrictEqual(fs.readdirSync(S.dirs.temp).filter((f) => f.startsWith('ers-')), []);
  const pw = seen.opts.webPreferences;
  assert.deepStrictEqual([seen.opts.show, pw.partition, pw.sandbox, pw.javascript, pw.nodeIntegration, pw.devTools], [false, 'ers-pdf-export', true, false, false, false]);
  assert.strictEqual(navigate(seen.wc, 'will-navigate', 'https://example.invalid/'), true, 'meta refresh / navigation prevented');
  assert.deepStrictEqual(seen.wc.windowOpenHandler({ url: 'https://x' }), { action: 'deny' });
  assert.ok(S.windows.find((x) => x.webContents === seen.wc).isDestroyed(), 'hidden window destroyed');
  const ps = S.sessions.get('ers-pdf-export');
  const verdict = (url) => { let res; ps.beforeRequest({ url }, (v) => { res = v; }); return res.cancel ? 'cancel' : 'allow'; };
  assert.strictEqual(verdict(pathToFileURL(seen.path).href), 'cancel', 'after export even the temp file is no longer allowed');
  // during an export: only that temp file and data: URLs
  let during = null;
  S.loadFile = async (p) => { during = { self: verdict(pathToFileURL(p).href), data: verdict('data:image/png;base64,AAAA'), web: verdict('https://tracker.example/p.gif'), unc: verdict('file://attacker.example/share/x.png'), other: verdict('file:///etc/passwd'), sibling: verdict(pathToFileURL(path.join(path.dirname(p), 'other.html')).href) }; };
  await call('pdf:export', { html: '<p>x</p>', header: 'h', footer: 'f', fileName: 'r9' });
  assert.deepStrictEqual(during, { self: 'allow', data: 'allow', web: 'cancel', unc: 'cancel', other: 'cancel', sibling: 'cancel' });
  let granted2 = null; ps.req(null, 'media', (g) => { granted2 = g; }); assert.strictEqual(granted2, false); assert.strictEqual(ps.check(), false);
  // printToPDF options: electron.d.ts PrintToPDFOptions shapes, margins = report.js @page (25/26/16/16 mm) in inches
  const po = S.printCalls[0];
  assert.deepStrictEqual(Object.keys(po).sort(), ['displayHeaderFooter', 'footerTemplate', 'headerTemplate', 'margins', 'pageSize', 'preferCSSPageSize', 'printBackground']);
  assert.deepStrictEqual(po.margins, { top: 0.9843, bottom: 1.0236, left: 0.6299, right: 0.6299 });
  assert.ok(!('marginType' in po.margins));
  assert.deepStrictEqual([po.pageSize, po.preferCSSPageSize, po.printBackground, po.displayHeaderFooter, po.headerTemplate, po.footerTemplate], ['A4', true, true, true, '<span class="title"></span>', '<span></span>']);
  S.loadFile = async () => {};
  await call('pdf:export', { html: '<p>x</p>', header: 'h', footer: 'f', fileName: 'r10', marginsMm: { top: 20, bottom: 'x', left: -5, right: 99 } });
  assert.deepStrictEqual(S.printCalls.slice(-1)[0].margins, { top: 0.7874, bottom: 1.0236, left: 0.6299, right: 0.6299 }, 'valid renderer margins used, invalid ignored');
  assert.deepStrictEqual(S.openPath.slice(0, 1), [path.join(docs, 'r8.pdf')]);
  // failures: printToPDF error, temp folder missing, output write error → {ok:false}, temp always removed
  S.printToPDF = async () => { throw new Error('Printing failed'); };
  r = await call('pdf:export', { html: '<p>x</p>', fileName: 'f1' }); assert.deepStrictEqual(r, { ok: false, error: 'The PDF could not be created: Printing failed' });
  S.printToPDF = async () => Buffer.from('%PDF');
  S.dirs.temp = path.join(RUN, 'no-such-temp');
  r = await call('pdf:export', { html: '<p>x</p>', fileName: 'f2' }); assert.strictEqual(r.ok, false); assert.match(r.error, /could not be prepared \(ENOENT\) in the Windows temporary folder/);
  S.dirs.temp = path.join(RUN, 'temp');
  S.dialogResult = { canceled: false, filePath: path.join(RUN, 'missing-dir', 'r.pdf') };
  r = await call('pdf:export', { html: '<p>x</p>', fileName: 'f3' }); assert.strictEqual(r.ok, false); assert.match(r.error, /The PDF could not be saved: the folder does not exist/);
  r = await call('pdf:export', { header: 'h' }); assert.deepStrictEqual(r, { ok: false, error: 'There is no report to export.' });
  r = await call('pdf:export'); assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(fs.readdirSync(S.dirs.temp).filter((f) => f.startsWith('ers-')), [], 'no temp file left after any failure');
  assert.ok(S.windows.every((x) => x === mainWin() || x.isDestroyed()), 'every hidden PDF window destroyed');
  ok('PDF: random ers-report-<uuid>.html, mode 0600, written inside try and deleted in finally (success and 3 failure paths), CSP injected first, hidden window on its own partition (JS off, sandbox, no DevTools, navigation/window.open blocked, permissions denied, webRequest allows only that temp file + data:), printToPDF options per electron.d.ts with margins = @page 25/26/16/16 mm (renderer may send marginsMm)');

  assert.deepStrictEqual(unhandled, [], 'no unhandled promise rejections');
  fs.rmSync(RUN, { recursive: true, force: true });
  console.log('main.js IPC proof passed.');
  process.exit(0);
})().catch((e) => { console.error(e); console.error('scratch kept at', RUN); process.exit(1); });

function MAGIC_LEN() { return 'ERSKEY1'.length + 1; }
