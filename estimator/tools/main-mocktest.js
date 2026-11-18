#!/usr/bin/env node
'use strict';
/*
 * Proof for estimator/main.js: loads it under a fake 'electron' module (Module._resolveFilename + require.cache stub)
 * and exercises single-instance, window hardening, navigation guards, IPC sender checks, key-file failure handling,
 * credential validation, save-dialog sanitising, PDF temp-file handling, the streaming backup channels, app:info and
 * the crash / hang recovery dialogs. Nothing under the repo is written: userData / temp / documents point into a
 * scratch directory. Run: node tools/main-mocktest.js  (ERS_ROOT overrides the app dir)
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
    // message boxes: messageBox(opts) returns {response}, or undefined to leave the box open until its signal aborts it
    messageBoxes: [], messageBox: () => ({ response: 0 }), reloads: 0, forcedCrashes: 0,
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
  constructor(win, type = 'window') {
    super(); this.id = ++wcIds; this.win = win; this.type = type; this.crashed = false;
    // like WebFrameMain: framesInSubtree holds the top frame and every iframe; an iframe has a parent
    this.mainFrame = { url: APP_URL, parent: null, detached: false, framesInSubtree: [] };
    this.mainFrame.framesInSubtree.push(this.mainFrame);
  }
  getType() { return this.type; }
  isCrashed() { return this.crashed; }
  setWindowOpenHandler(fn) { this.windowOpenHandler = fn; }
  async printToPDF(opts) { S.printCalls.push(opts); return S.printToPDF(opts, this.win); }
  isDestroyed() { return !!(this.win && this.win.destroyed); }
  reload() { S.reloads++; }
  // like Electron: the renderer is killed and render-process-gone follows asynchronously
  forcefullyCrashRenderer() { S.forcedCrashes++; setTimeout(() => this.emit('render-process-gone', {}, { reason: 'killed', exitCode: 9 }), 5); }
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
    showErrorBox: (t, m) => S.errorBoxes.push(m),
    showMessageBox: (a, b) => {
      const opts = b || a;
      const box = { parent: b ? a : null, opts, aborted: false };
      S.messageBoxes.push(box);
      return new Promise((resolve) => {
        // like Electron: an aborted signal closes the box as if it was cancelled
        if (opts.signal) opts.signal.addEventListener('abort', () => { box.aborted = true; resolve({ response: opts.cancelId || 0, checkboxChecked: false }); });
        Promise.resolve().then(() => S.messageBox(opts, box)).then((res) => { if (res) resolve({ checkboxChecked: false, ...res }); });
      });
    }
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
  S.main = require(MAIN);
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
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
/** Poll until cond() holds (counted in steps, not Date.now(), which a test may freeze). */
async function waitFor(cond, ms = 3000, what = 'condition') {
  for (let i = 0; i * 10 < ms; i++) { if (cond()) return; await tick(10); }
  if (!cond()) throw new Error('timed out waiting for ' + what);
}

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
  for (const ch of S.handlers.keys()) {
    for (const arg of [undefined, null, 0, 'x', [], {}, { html: 5 }, { content: {} }]) {
      const res = await call(ch, arg);
      if (res.ok && typeof res.id === 'string') assert.strictEqual((await call('backup:abort', res.id)).ok, true); // backup:begin({}) opens one
    }
  }
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

  // ================= 7. streaming backup =================
  await boot();
  const bdocs = S.dirs.documents;
  const parts = () => fs.readdirSync(bdocs).filter((f) => f.endsWith('.part'));
  const inDocs = (name) => path.join(bdocs, name);
  const MAX = 64 * 1024 * 1024;
  assert.strictEqual(S.main.BACKUP_CHUNK_MAX, MAX);
  // round trip: begin → several writes → end, over an earlier backup of the same name
  const target = inDocs('backup-2026-11-18.ersbackup');
  fs.writeFileSync(target, 'EARLIER BACKUP');
  S.dialogResult = { canceled: false, filePath: target };
  r = await call('backup:begin', { fileName: 'backup-2026-11-18.ersbackup' });
  assert.strictEqual(r.ok, true); assert.match(r.id, /^[0-9a-f-]{36}$/);
  const bid = r.id;
  d = S.saveDialogCalls.slice(-1)[0];
  assert.strictEqual(path.basename(d.opts.defaultPath), 'backup-2026-11-18.ersbackup');
  assert.deepStrictEqual(d.opts.filters, [{ name: 'Engineer Report Studio backup', extensions: ['ersbackup'] }]);
  assert.strictEqual(d.parent, mainWin());
  assert.strictEqual(parts().length, 1);
  assert.match(parts()[0], /^backup-2026-11-18\.ersbackup\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/, '<target>.<uuid>.part in the chosen folder');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(inDocs(parts()[0])).mode & 0o777, 0o600);
  const lines = [
    { kind: 'engineer-report-studio-backup', format: 2, at: '2026-11-18T10:00:00.000Z', jobs: 2 },
    { type: 'settings', data: { company: 'Müller & Søn – Engineers' } },
    { type: 'customOem', data: [] },
    { type: 'job', data: { id: 'j1', ref: 'Ref 🚗 AB12 CDE – “quoted”', photo: 'data:image/jpeg;base64,' + 'A'.repeat(9 * 1024 * 1024) } },
    { type: 'job', data: { id: 'j2', notes: 'Kühler – 🚙🚕 ' + '€'.repeat(100000) } },
    { type: 'end', jobs: 2 }
  ];
  const all = lines.map((o) => JSON.stringify(o)).join('\n') + '\n';
  const emoji = all.indexOf('🚗');
  const cuts = [0, 70, emoji + 1, emoji + 5, 4 * 1024 * 1024, all.length - 30, all.length]; // emoji + 1 splits its surrogate pair
  const chunks = cuts.slice(1).map((c, i) => all.slice(cuts[i], c));
  chunks.splice(2, 0, ''); // an empty piece right after the split half
  assert.ok(/[\ud800-\udbff]$/.test(chunks[1]) && /^[\udc00-\udfff]/.test(chunks[3]), 'one piece ends inside an emoji');
  const order = [];
  const realFsync = fs.fsync, realRename = fs.promises.rename, realWrite = fs.write, realWritev = fs.writev;
  fs.fsync = function (fd, cb) { order.push('fsync'); return realFsync.call(fs, fd, cb); };
  fs.promises.rename = async function (a, b) { order.push('rename'); return realRename.call(fs.promises, a, b); };
  try {
    for (const c of chunks) { r = await call('backup:write', bid, c); assert.deepStrictEqual(r, { ok: true }); }
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'EARLIER BACKUP', 'the earlier backup is untouched while writing');
    r = await call('backup:end', bid);
  } finally { fs.fsync = realFsync; fs.promises.rename = realRename; }
  assert.deepStrictEqual(r, { ok: true, filePath: target });
  assert.ok(fs.readFileSync(target).equals(Buffer.from(all, 'utf8')), 'the file is exactly the UTF-8 of the text sent');
  assert.deepStrictEqual(fs.readFileSync(target, 'utf8').split('\n').slice(0, -1).map((l) => { const o = JSON.parse(l); return o.type || o.kind; }), ['engineer-report-studio-backup', 'settings', 'customOem', 'job', 'job', 'end']);
  assert.deepStrictEqual(order, ['fsync', 'rename'], 'fsynced before the rename');
  assert.deepStrictEqual(parts(), []);
  assert.ok(!S.openPath.includes(target), 'nothing is opened');
  for (const ch of ['backup:write', 'backup:end', 'backup:abort']) { r = await call(ch, bid, 'more'); assert.strictEqual(r.ok, false, ch + ' after end'); assert.match(r.error, /no longer open/); }
  // writes that are not awaited are applied in call order, and end waits for them
  S.dialogResult = { canceled: false, filePath: inDocs('queued.ersbackup') };
  r = await call('backup:begin', {}); const qid = r.id;
  const queued = await Promise.all([call('backup:write', qid, 'one\n'), call('backup:write', qid, 'two\n'), call('backup:write', qid, 'three\n'), call('backup:end', qid)]);
  assert.deepStrictEqual(queued.map((x) => x.ok), [true, true, true, true]);
  assert.strictEqual(fs.readFileSync(inDocs('queued.ersbackup'), 'utf8'), 'one\ntwo\nthree\n');
  r = await call('backup:begin', {}); const fid = r.id;
  const pFinish = call('backup:end', fid);
  r = await call('backup:write', fid, 'late'); assert.deepStrictEqual(r, { ok: false, error: 'That backup is already being finished.' });
  assert.strictEqual((await pFinish).ok, true);
  ok('Backup: begin → 7 writes (non-ASCII, a 9 MB line, an empty piece, a split inside an emoji) → end gives exactly the UTF-8 text; .ersbackup dialog and filter; <name>.<uuid>.part (0600) in the chosen folder; fsynced, then renamed over the earlier backup, which is untouched until then; nothing opened; writes run in call order');

  // abort deletes the temporary file, also while writes are queued
  S.dialogResult = { canceled: false, filePath: inDocs('aborted.ersbackup') };
  r = await call('backup:begin', { fileName: 'aborted' }); const aid = r.id;
  assert.strictEqual(path.basename(S.saveDialogCalls.slice(-1)[0].opts.defaultPath), 'aborted.ersbackup');
  assert.deepStrictEqual(await call('backup:write', aid, 'partial data'), { ok: true });
  assert.strictEqual(parts().length, 1);
  assert.deepStrictEqual(await call('backup:abort', aid), { ok: true });
  assert.deepStrictEqual(parts(), [], 'temporary file deleted');
  assert.ok(!fs.existsSync(inDocs('aborted.ersbackup')));
  r = await call('backup:write', aid, 'x'); assert.match(r.error, /no longer open/);
  r = await call('backup:abort', aid); assert.strictEqual(r.ok, false, 'an aborted id is unknown');
  r = await call('backup:begin', {}); const aid2 = r.id;
  const inFlight = [call('backup:write', aid2, 'a'.repeat(5e6)), call('backup:write', aid2, 'b'.repeat(5e6))];
  assert.deepStrictEqual(await call('backup:abort', aid2), { ok: true });
  assert.ok((await Promise.all(inFlight)).every((x) => typeof x.ok === 'boolean'));
  assert.deepStrictEqual(parts(), []);
  ok('Backup abort: the temporary file is deleted (also with writes still queued), the target is not created, and the id is then unknown');

  // one backup per window; a second begin (also a simultaneous one) is refused without a dialog
  S.dialogResult = { canceled: false, filePath: inDocs('one.ersbackup') };
  r = await call('backup:begin', {}); const oneId = r.id; assert.strictEqual(r.ok, true);
  const dialogCount = S.saveDialogCalls.length;
  r = await call('backup:begin', {}); assert.strictEqual(r.ok, false); assert.match(r.error, /already being written/);
  assert.strictEqual(S.saveDialogCalls.length, dialogCount, 'no second save dialog');
  assert.strictEqual((await call('backup:abort', oneId)).ok, true);
  const both = await Promise.all([call('backup:begin', {}), call('backup:begin', {})]);
  assert.deepStrictEqual(both.map((x) => x.ok).sort(), [false, true], 'two quick clicks start one backup');
  assert.match(both.find((x) => !x.ok).error, /already being written/);
  assert.strictEqual((await call('backup:abort', both.find((x) => x.ok).id)).ok, true);
  S.dialogResult = { canceled: true };
  assert.deepStrictEqual(await call('backup:begin', {}), { ok: false, canceled: true });
  S.dialogResult = { canceled: false, filePath: path.join(RUN, 'missing-dir', 'b.ersbackup') };
  r = await call('backup:begin', {}); assert.strictEqual(r.ok, false); assert.match(r.error, /^The backup could not be started: the folder does not exist/);
  r = await call('backup:begin', 'x'); assert.strictEqual(r.ok, false);
  S.dialogResult = { canceled: false, filePath: inDocs('after.ersbackup') };
  r = await call('backup:begin', {}); assert.strictEqual(r.ok, true, 'a cancelled or failed begin leaves nothing open');
  assert.strictEqual((await call('backup:abort', r.id)).ok, true);
  assert.deepStrictEqual(parts(), []);
  ok('Backup: one at a time per window (a second or simultaneous begin is refused without a dialog); cancel → {canceled}; missing folder → friendly fsMessage; neither blocks the next backup');

  // the 64 MiB limit; non-text; unknown ids
  S.dialogResult = { canceled: false, filePath: inDocs('limit.ersbackup') };
  r = await call('backup:begin', {}); const lid = r.id;
  assert.deepStrictEqual(await call('backup:write', lid, 'a'.repeat(MAX)), { ok: true }, 'exactly 64 MiB is accepted');
  r = await call('backup:write', lid, 'a'.repeat(MAX + 1)); assert.strictEqual(r.ok, false); assert.match(r.error, /larger than 64 MiB, so the backup was stopped/);
  assert.deepStrictEqual(parts(), [], 'the stopped backup is deleted straight away');
  r = await call('backup:write', lid, 'x'); assert.match(r.error, /larger than 64 MiB/, 'later writes say why it stopped');
  r = await call('backup:end', lid); assert.strictEqual(r.ok, false); assert.match(r.error, /larger than 64 MiB/);
  assert.ok(!fs.existsSync(inDocs('limit.ersbackup')));
  assert.deepStrictEqual(await call('backup:abort', lid), { ok: true }, 'abort after a failure is fine');
  r = await call('backup:begin', {}); const tid = r.id;
  r = await call('backup:write', tid, 42); assert.strictEqual(r.ok, false); assert.match(r.error, /not text/);
  assert.deepStrictEqual(parts(), []);
  await call('backup:abort', tid);
  for (const [ch, args] of [['backup:write', ['nope', 'x']], ['backup:write', [42, 'x']], ['backup:end', ['nope']], ['backup:end', []], ['backup:abort', ['nope']], ['backup:abort', [{}]]]) {
    r = await call(ch, ...args); assert.strictEqual(r.ok, false, `${ch} ${JSON.stringify(args)}`); assert.match(r.error, /no longer open/);
  }
  ok('Backup limits: a 64 MiB piece is accepted, 64 MiB + 1 (or non-text) stops the backup and deletes its file at once; write/end then repeat the reason; unknown ids → {ok:false, error}');

  // file-system failures: disk full while writing, a busy target (retried), a lasting rename failure
  S.dialogResult = { canceled: false, filePath: inDocs('full.ersbackup') };
  r = await call('backup:begin', {}); const eid = r.id;
  const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' });
  fs.write = function (...a) { process.nextTick(a[a.length - 1], enospc()); };
  fs.writev = function (...a) { process.nextTick(a[a.length - 1], enospc()); };
  try { r = await call('backup:write', eid, 'some data'); } finally { fs.write = realWrite; fs.writev = realWritev; }
  assert.deepStrictEqual(r, { ok: false, error: 'The backup could not be written: the disk is full. Free some space or save somewhere else.' });
  assert.deepStrictEqual(parts(), []);
  r = await call('backup:end', eid); assert.match(r.error, /disk is full/);
  assert.deepStrictEqual(await call('backup:abort', eid), { ok: true });
  S.dialogResult = { canceled: false, filePath: inDocs('busy.ersbackup') };
  r = await call('backup:begin', {}); const rid = r.id; await call('backup:write', rid, 'data\n');
  let renames = 0;
  fs.promises.rename = async function (a, b) { if (++renames <= 2) throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' }); return realRename.call(fs.promises, a, b); };
  try { r = await call('backup:end', rid); } finally { fs.promises.rename = realRename; }
  assert.deepStrictEqual(r, { ok: true, filePath: inDocs('busy.ersbackup') }); assert.strictEqual(renames, 3, 'a briefly busy file is retried');
  fs.writeFileSync(inDocs('folder.ersbackup'), 'EARLIER');
  S.dialogResult = { canceled: false, filePath: inDocs('folder.ersbackup') };
  r = await call('backup:begin', {}); const kid = r.id; await call('backup:write', kid, 'new data\n');
  fs.promises.rename = async () => { throw Object.assign(new Error('EISDIR: illegal operation on a directory, rename'), { code: 'EISDIR' }); };
  try { r = await call('backup:end', kid); } finally { fs.promises.rename = realRename; }
  assert.deepStrictEqual(r, { ok: false, error: 'The backup could not be saved: that name is a folder. Choose a file name.' });
  assert.strictEqual(fs.readFileSync(inDocs('folder.ersbackup'), 'utf8'), 'EARLIER', 'a failed backup never touches the earlier file');
  assert.deepStrictEqual(parts(), []);
  await call('backup:abort', kid);
  // abort while end is flushing: the chosen file is never replaced
  S.dialogResult = { canceled: false, filePath: inDocs('racing.ersbackup') };
  r = await call('backup:begin', {}); const xid = r.id; await call('backup:write', xid, 'data\n');
  let releaseFsync = null;
  fs.fsync = function (fd, cb) { releaseFsync = () => realFsync.call(fs, fd, cb); };
  let pEnd, pAbort;
  try {
    pEnd = call('backup:end', xid);
    await waitFor(() => !!releaseFsync, 2000, 'fsync');
    pAbort = call('backup:abort', xid);
  } finally { fs.fsync = realFsync; }
  releaseFsync();
  const [endRes, abortRes] = await Promise.all([pEnd, pAbort]);
  assert.strictEqual(endRes.ok, false); assert.match(endRes.error, /cancelled/); assert.deepStrictEqual(abortRes, { ok: true });
  assert.ok(!fs.existsSync(inDocs('racing.ersbackup')), 'an abort during end never replaces the chosen file');
  assert.deepStrictEqual(parts(), []);
  ok('Backup failures use fsMessage: disk full while writing (file deleted), a busy target retried, a lasting rename failure leaves the earlier file and no temporary file; an abort during end never replaces the chosen file');

  // sender guard: untrusted senders cannot begin, write into, end or abort an open backup
  S.dialogResult = { canceled: false, filePath: inDocs('guarded.ersbackup') };
  r = await call('backup:begin', {}); const gid = r.id; await call('backup:write', gid, 'GOOD\n');
  const dialogsBefore = S.saveDialogCalls.length;
  for (const [label, ev] of evilFrames) {
    for (const [ch, args] of [['backup:begin', [{}]], ['backup:write', [gid, 'EVIL\n']], ['backup:end', [gid]], ['backup:abort', [gid]], ['app:info', []]]) {
      const res = await S.handlers.get(ch)({ ...appEvent(), ...ev }, ...args);
      assert.strictEqual(res.ok, false, `${ch} from ${label}`); assert.match(res.error, /Request refused/);
    }
  }
  assert.strictEqual(S.saveDialogCalls.length, dialogsBefore, 'no dialog for an untrusted begin');
  r = await call('backup:end', gid); assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.readFileSync(inDocs('guarded.ersbackup'), 'utf8'), 'GOOD\n');
  ok(`Backup sender guard: begin/write/end/abort (and app:info) refuse ${evilFrames.length} untrusted senders; an open backup is unaffected`);

  // the page going away cancels its backup: reload (a new document), the window closing
  S.dialogResult = { canceled: false, filePath: inDocs('reload.ersbackup') };
  r = await call('backup:begin', {}); const nid1 = r.id; await call('backup:write', nid1, 'x');
  mainWin().webContents.emit('did-navigate-in-page', {}, APP_URL + '#/settings', true);
  assert.strictEqual(parts().length, 1, 'a #route change keeps the backup');
  mainWin().webContents.emit('did-navigate', {}, APP_URL, -1, '');
  await waitFor(() => parts().length === 0, 3000, 'temporary file deleted after a reload');
  r = await call('backup:write', nid1, 'y'); assert.match(r.error, /no longer open/);
  r = await call('backup:begin', {}); assert.strictEqual(r.ok, true, 'the reloaded page can start a new backup');
  await call('backup:write', r.id, 'z');
  assert.strictEqual(parts().length, 1);
  mainWin().destroy();
  await waitFor(() => parts().length === 0, 3000, 'temporary file deleted after the window closed');
  assert.ok(!fs.existsSync(inDocs('reload.ersbackup')));
  ok('Backup cleanup: a reload (did-navigate, not an in-page #route change) or closing the window aborts the open backup and deletes its temporary file');

  // quitting waits for the temporary file to be deleted, then quits; nothing new can start
  await boot();
  S.dialogResult = { canceled: false, filePath: inDocs('quit.ersbackup') };
  r = await call('backup:begin', {}); await call('backup:write', r.id, 'x');
  const quitsBefore = S.quitCalls;
  const q1 = { prevented: false, preventDefault() { this.prevented = true; } };
  app.emit('before-quit', q1);
  assert.strictEqual(q1.prevented, true, 'the quit waits for the open backup');
  await waitFor(() => S.quitCalls === quitsBefore + 1, 3000, 'quit resumed');
  assert.deepStrictEqual(parts(), []);
  const q2 = { prevented: false, preventDefault() { this.prevented = true; } };
  app.emit('before-quit', q2); assert.strictEqual(q2.prevented, false, 'the second quit goes ahead');
  r = await call('backup:begin', {}); assert.strictEqual(r.ok, false); assert.match(r.error, /app is closing/);
  app.emit('will-quit');
  // last resort: a temporary file still there at will-quit is deleted synchronously
  await boot();
  S.dialogResult = { canceled: false, filePath: inDocs('lastresort.ersbackup') };
  r = await call('backup:begin', {}); assert.strictEqual(parts().length, 1);
  app.emit('will-quit');
  if (process.platform !== 'win32') assert.deepStrictEqual(parts(), [], 'deleted synchronously at will-quit');
  await call('backup:abort', r.id);
  assert.deepStrictEqual(parts(), []);
  ok('Backup on quit: before-quit is held until the open backup is aborted and its temporary file deleted, then app.quit() again; later begins are refused; will-quit deletes any leftover synchronously');

  // ================= 8. app:info =================
  r = await call('app:info'); assert.deepStrictEqual(r, { ok: true, dataFolder: S.dirs.userData });
  ok('app:info → {ok:true, dataFolder: userData}; sender-guarded like every channel');

  // ================= 9. the page crashing or hanging =================
  await boot();
  let wc9 = mainWin().webContents;
  const gone = (reason) => wc9.emit('render-process-gone', {}, { reason, exitCode: 1 });
  S.dialogResult = { canceled: false, filePath: inDocs('crash.ersbackup') };
  r = await call('backup:begin', {}); const cid = r.id; await call('backup:write', cid, 'x');
  S.messageBox = () => ({ response: 0 }); // Reload
  gone('crashed');
  await waitFor(() => S.reloads === 1, 2000, 'reload');
  let box = S.messageBoxes[0];
  assert.strictEqual(box.parent, mainWin());
  assert.deepStrictEqual([box.opts.type, box.opts.buttons, box.opts.defaultId, box.opts.cancelId, box.opts.noLink], ['error', ['Reload', 'Close'], 0, 0, true]);
  assert.match(box.opts.message, /stopped working\.$/);
  assert.match(box.opts.detail, /saved on this PC/); assert.match(box.opts.detail, /backup that was being written was cancelled/);
  assert.ok(box.opts.detail.includes(S.dirs.userData), 'the data folder is shown');
  await waitFor(() => parts().length === 0, 2000, 'the crash deleted the backup temporary file');
  r = await call('backup:write', cid, 'y'); assert.match(r.error, /no longer open/);
  assert.strictEqual(mainWin().isDestroyed(), false);
  gone('crashed'); // again within a minute: Close only
  await waitFor(() => mainWin().isDestroyed(), 2000, 'window closed');
  box = S.messageBoxes[1];
  assert.deepStrictEqual(box.opts.buttons, ['Close']); assert.match(box.opts.message, /stopped working again/); assert.match(box.opts.detail, /twice within a minute/);
  assert.ok(!/backup that was being written/.test(box.opts.detail), 'no backup mentioned when none was open');
  assert.strictEqual(S.reloads, 1, 'no second reload');
  // out of memory hint; a crash more than a minute after the last one may reload again
  await boot();
  wc9 = mainWin().webContents;
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  try {
    S.messageBox = () => ({ response: 0 });
    gone('oom'); await waitFor(() => S.reloads === 1, 2000, 'reload after oom');
    assert.match(S.messageBoxes[0].opts.detail, /ran out of memory/);
    fakeNow += 61 * 1000;
    gone('crashed'); await waitFor(() => S.reloads === 2, 2000, 'reload a minute later');
    assert.deepStrictEqual(S.messageBoxes[1].opts.buttons, ['Reload', 'Close']);
    S.messageBox = () => ({ response: 1 }); // Close
    fakeNow += 61 * 1000;
    gone('abnormal-exit'); await waitFor(() => mainWin().isDestroyed(), 2000, 'Close');
    assert.strictEqual(S.reloads, 2);
  } finally { Date.now = realNow; }
  ok('Crash: render-process-gone → error dialog (Reload / Close, data folder, the open backup cancelled and its file deleted) → Reload reloads; a second crash within a minute offers Close only and closes the window (no crash loop); a minute later Reload is offered again; out-of-memory explained');

  // hang: Wait / Reload / Close; Reload ends the hung renderer first and is not reported as a crash
  await boot();
  wc9 = mainWin().webContents;
  S.dialogResult = { canceled: false, filePath: inDocs('hang.ersbackup') };
  r = await call('backup:begin', {}); await call('backup:write', r.id, 'x');
  S.messageBox = () => ({ response: 1 }); // Reload
  wc9.emit('unresponsive');
  await waitFor(() => S.reloads === 1, 2000, 'reload after a hang');
  box = S.messageBoxes[0];
  assert.deepStrictEqual([box.opts.type, box.opts.buttons, box.opts.defaultId, box.opts.cancelId], ['warning', ['Wait', 'Reload', 'Close'], 0, 0]);
  assert.ok(box.opts.signal instanceof AbortSignal); assert.match(box.opts.detail, /cancels the backup/);
  assert.strictEqual(S.forcedCrashes, 1, 'the hung renderer is ended before the reload');
  await tick(60); // the forced crash's render-process-gone (reason "killed") arrives
  assert.strictEqual(S.messageBoxes.length, 1, 'our own restart is not reported as a crash');
  await waitFor(() => parts().length === 0, 2000, 'the backup of the hung page is deleted');
  S.messageBox = () => ({ response: 0 }); // Wait
  wc9.emit('unresponsive'); await waitFor(() => S.messageBoxes.length === 2, 2000, 'second hang dialog'); await tick();
  assert.deepStrictEqual(S.messageBoxes[1].opts.buttons, ['Wait', 'Close'], 'hanging again within a minute: no further reload');
  assert.deepStrictEqual([S.reloads, S.forcedCrashes, mainWin().isDestroyed()], [1, 1, false], 'Wait changes nothing');
  S.messageBox = () => undefined; // left open
  gone('crashed'); await waitFor(() => S.messageBoxes.length === 3, 2000, 'crash dialog');
  assert.deepStrictEqual(S.messageBoxes[2].opts.buttons, ['Close'], 'a crash after a hang restart within a minute: Close only');
  // the dialog closes by itself when the page recovers; one dialog at a time; a crash replaces the hang dialog
  await boot();
  wc9 = mainWin().webContents;
  S.messageBox = () => undefined;
  wc9.emit('unresponsive'); await waitFor(() => S.messageBoxes.length === 1, 2000, 'hang dialog');
  wc9.emit('unresponsive'); await tick();
  assert.strictEqual(S.messageBoxes.length, 1, 'one dialog at a time');
  wc9.emit('responsive'); await tick();
  assert.strictEqual(S.messageBoxes[0].aborted, true, 'the page recovered: the dialog closed by itself');
  assert.deepStrictEqual([S.reloads, S.forcedCrashes, mainWin().isDestroyed()], [0, 0, false]);
  wc9.emit('unresponsive'); await waitFor(() => S.messageBoxes.length === 2, 2000, 'hang dialog again');
  S.messageBox = () => ({ response: 0 });
  gone('crashed'); await waitFor(() => S.reloads === 1, 2000, 'reload after the crash');
  assert.strictEqual(S.messageBoxes[1].aborted, true, 'the hang dialog is replaced by the crash dialog');
  assert.deepStrictEqual(S.messageBoxes[2].opts.buttons, ['Reload', 'Close']);
  // Close on the hang dialog; no dialog while the window is closing or the app is quitting
  await boot();
  S.messageBox = () => ({ response: 2 });
  mainWin().webContents.emit('unresponsive'); await waitFor(() => mainWin().isDestroyed(), 2000, 'Close');
  assert.strictEqual(S.forcedCrashes, 0);
  await boot();
  wc9 = mainWin().webContents;
  mainWin().emit('close', {});
  gone('crashed'); wc9.emit('unresponsive'); await tick();
  assert.strictEqual(S.messageBoxes.length, 0, 'no dialog while the window is closing');
  await boot();
  wc9 = mainWin().webContents;
  app.emit('before-quit', { preventDefault() {} });
  gone('crashed'); wc9.emit('unresponsive'); await tick();
  assert.strictEqual(S.messageBoxes.length, 0, 'no dialog while quitting');
  // Windows shutting down / logging off (no before-quit follows): backups cleaned up, no dialogs
  await boot();
  wc9 = mainWin().webContents;
  S.dialogResult = { canceled: false, filePath: inDocs('shutdown.ersbackup') };
  r = await call('backup:begin', {}); await call('backup:write', r.id, 'x');
  mainWin().emit('session-end', { reasons: ['shutdown'] });
  if (process.platform !== 'win32') assert.deepStrictEqual(parts(), [], 'deleted at once at session-end');
  await waitFor(() => parts().length === 0, 3000, 'temporary file deleted at session-end');
  gone('killed'); await tick();
  assert.strictEqual(S.messageBoxes.length, 0, 'no dialog while Windows is shutting down');
  r = await call('backup:begin', {}); assert.strictEqual(r.ok, false, 'no new backup during shutdown');
  ok('Hang: unresponsive → warning dialog (Wait / Reload / Close, closes itself on "responsive", one at a time); Reload ends the renderer (forcefullyCrashRenderer), reloads on its render-process-gone, cancels the backup, and that kill is not reported as a crash; within a minute only Wait / Close; no dialogs while closing, quitting or at Windows session-end (which also deletes backup temp files)');

  assert.deepStrictEqual(unhandled, [], 'no unhandled promise rejections');
  fs.rmSync(RUN, { recursive: true, force: true });
  console.log('main.js IPC proof passed.');
  process.exit(0);
})().catch((e) => { console.error(e); console.error('scratch kept at', RUN); process.exit(1); });

function MAGIC_LEN() { return 'ERSKEY1'.length + 1; }
