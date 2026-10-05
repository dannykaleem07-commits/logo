// Unit tests for the launcher's pure helpers (design doc §G.3, §K "Desktop"). Run: node packaging/launch.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const launch = require('./launch.cjs');

const WIN_ENV = {
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\danny\\AppData\\Local',
};
const EDGE_X86 = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EDGE_LOCAL = 'C:\\Users\\danny\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME_PF = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const existsIn = (...paths) => (p) => paths.includes(p);
const noReg = () => undefined;

test('requiring the launcher does not start ClaimDesk', () => {
  assert.equal(typeof launch.run, 'function');
  assert.equal(process.env.CLAIMDESK_DATASET, undefined);
});

test('findAppBrowser: CLAIMDESK_BROWSER_PATH wins when it exists', () => {
  const env = { ...WIN_ENV, CLAIMDESK_BROWSER_PATH: 'D:\\Portable\\chrome.exe' };
  assert.equal(launch.findAppBrowser(env, existsIn('D:\\Portable\\chrome.exe', EDGE_X86), noReg), 'D:\\Portable\\chrome.exe');
  // a missing override is ignored
  assert.equal(launch.findAppBrowser(env, existsIn(EDGE_X86), noReg), EDGE_X86);
});

test('findAppBrowser: Edge under Program Files (x86), then Program Files, then LOCALAPPDATA', () => {
  assert.equal(launch.findAppBrowser(WIN_ENV, existsIn(EDGE_X86, EDGE_LOCAL), noReg), EDGE_X86);
  assert.equal(launch.findAppBrowser(WIN_ENV, existsIn(EDGE_LOCAL), noReg), EDGE_LOCAL);
});

test('findAppBrowser: Edge from the App Paths registry before any Chrome', () => {
  const regEdge = 'E:\\Edge\\msedge.exe';
  const calls = [];
  const reg = (exe) => {
    calls.push(exe);
    return exe === 'msedge.exe' ? regEdge : undefined;
  };
  assert.equal(launch.findAppBrowser(WIN_ENV, existsIn(regEdge, CHROME_PF), reg), regEdge);
  assert.deepEqual(calls, ['msedge.exe']);
});

test('findAppBrowser: Chrome when there is no Edge; a registry path that does not exist is skipped', () => {
  const reg = (exe) => (exe === 'msedge.exe' ? 'C:\\gone\\msedge.exe' : undefined);
  assert.equal(launch.findAppBrowser(WIN_ENV, existsIn(CHROME_PF), reg), CHROME_PF);
  const regChrome = 'F:\\Chrome\\chrome.exe';
  assert.equal(launch.findAppBrowser(WIN_ENV, existsIn(regChrome), (exe) => (exe === 'chrome.exe' ? regChrome : undefined)), regChrome);
});

test('findAppBrowser: nothing found → undefined (the launcher falls back to explorer.exe <url>)', () => {
  assert.equal(launch.findAppBrowser(WIN_ENV, () => false, noReg), undefined);
  assert.equal(launch.findAppBrowser({}, () => false, () => { throw new Error('reg.exe missing'); }), undefined);
});

test('findAppBrowser: environment names are case-insensitive, and the default roots are tried without them', () => {
  const env = { 'PROGRAMFILES(X86)': 'G:\\PF86' };
  assert.equal(launch.findAppBrowser(env, existsIn('G:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe'), noReg), 'G:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(launch.findAppBrowser({}, existsIn(EDGE_X86), noReg), EDGE_X86);
});

test('appWindowArgs: app mode with its own profile', () => {
  assert.deepEqual(launch.appWindowArgs('http://localhost:4000', 'C:\\Users\\danny\\AppData\\Local\\ClaimDesk\\window'), [
    '--app=http://localhost:4000',
    '--user-data-dir=C:\\Users\\danny\\AppData\\Local\\ClaimDesk\\window',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--window-size=1440,900',
  ]);
  assert.equal(launch.windowProfileDir('/h', 'live'), path.join('/h', 'window'));
  assert.equal(launch.windowProfileDir('/h', 'demo'), path.join('/h', 'window-demo'));
});

test('portFor: live 4000, example claims 4001; PORT moves only the live port', () => {
  assert.equal(launch.portFor(false), 4000);
  assert.equal(launch.portFor(true), 4001);
  assert.equal(launch.portFor(false, { PORT: '5000' }), 5000);
  assert.equal(launch.portFor(true, { PORT: '5000' }), 4001);
  assert.equal(launch.portFor(true, { CLAIMDESK_DEMO_PORT: '5001' }), 5001);
  assert.equal(launch.portFor(false, { PORT: 'abc' }), 4000);
  assert.equal(launch.portFor(false, { PORT: '70000' }), 4000);
});

test('stop on last window close: only after 8 s, and CLAIMDESK_STOP_ON_CLOSE=0 turns it off', () => {
  assert.equal(launch.HANDOVER_MS, 8000);
  assert.equal(launch.shouldStopOnWindowExit(1500, {}), false); // handed over to an open window
  assert.equal(launch.shouldStopOnWindowExit(8000, {}), true);
  assert.equal(launch.shouldStopOnWindowExit(60000, { CLAIMDESK_STOP_ON_CLOSE: '1' }), true);
  assert.equal(launch.shouldStopOnWindowExit(60000, { CLAIMDESK_STOP_ON_CLOSE: '0' }), false);
  assert.equal(launch.shouldStopOnWindowExit(60000, { CLAIMDESK_STOP_ON_CLOSE: 'false' }), false);
});

test('parseHealth: only ClaimDesk; dataset defaults to live; pid and version read', () => {
  assert.equal(launch.parseHealth(200, '{"ok":true,"service":"other"}'), null);
  assert.equal(launch.parseHealth(500, '{"ok":true,"service":"@ccguk/api"}'), null);
  assert.equal(launch.parseHealth(200, 'not json'), null);
  assert.deepEqual(launch.parseHealth(200, '{"ok":true,"service":"@ccguk/api"}'), { ok: true, dataset: 'live', pid: undefined, version: undefined });
  assert.deepEqual(launch.parseHealth(200, '{"ok":true,"service":"@ccguk/api","dataset":"demo","pid":4242,"version":"0.2.57"}'), { ok: true, dataset: 'demo', pid: 4242, version: '0.2.57' });
});

test('parseRegDefault: App Paths default value, quotes stripped, variables expanded', () => {
  const out = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe\r\n    (Default)    REG_SZ    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"\r\n';
  assert.equal(launch.parseRegDefault(out), EDGE_X86);
  const exp = '    (Default)    REG_EXPAND_SZ    %LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe\r\n';
  assert.equal(launch.parseRegDefault(exp, { LOCALAPPDATA: 'C:\\L' }), 'C:\\L\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(launch.parseRegDefault('ERROR: The system was unable to find the specified registry key or value.'), undefined);
});

test('claimdesk.env template documents the 0.2 settings; the parser ignores comments', () => {
  const text = launch.envTemplate().join('\n');
  for (const key of ['DOCX_PDF_CONVERTER', 'SOFFICE_PATH', 'TOTALCARCHECK_URL_TEMPLATE', 'CLAIMDESK_BROWSER', 'CLAIMDESK_STOP_ON_CLOSE', 'DVLA_VES_API_KEY']) assert.match(text, new RegExp(`# ${key}=`));
  assert.match(text, /totalcarcheck\.co\.uk\/FreeCheck\?regno=\{REG\}/);
  assert.deepEqual(launch.parseEnvFile(text), {});
  assert.deepEqual(launch.parseEnvFile('DVLA_VES_API_KEY = abc \r\n# PORT=1\r\nEMPTY=\r\nCLAIMDESK_BROWSER=tab'), { DVLA_VES_API_KEY: 'abc', CLAIMDESK_BROWSER: 'tab' });
});

test('window watch: stops once the profile lock has been seen and then missed twice in a row', () => {
  const w = launch.createWindowWatch();
  assert.equal(w.observe(false), 'waiting'); // the browser is still starting
  assert.equal(w.observe(true), 'open');
  assert.equal(w.observe(false), 'closing'); // one missed poll is not enough (a restart in progress)
  assert.equal(w.observe(true), 'open');
  assert.equal(w.observe(false), 'closing');
  assert.equal(w.observe(false), 'closed');
  assert.equal(w.observe(false), 'done'); // fires once
});

test('window watch: a hand-over to an already-open window keeps the server (the lock stays)', () => {
  const w = launch.createWindowWatch();
  for (let i = 0; i < 10; i++) assert.equal(w.observe(true), 'open');
  assert.equal(w.seen, true);
});

test('window watch: no lock file ever seen → "never" (the process-exit rule is used instead)', () => {
  const w = launch.createWindowWatch({ firstSeenWithin: 3 });
  assert.equal(w.observe(false), 'waiting');
  assert.equal(w.observe(false), 'waiting');
  assert.equal(w.observe(false), 'never');
  assert.equal(w.seen, false);
});

test('profileInUse: Chromium lock file names', () => {
  const dir = path.join('C:', 'Home', 'window');
  assert.equal(launch.profileInUse(dir, (p) => p === path.join(dir, 'lockfile')), true);
  assert.equal(launch.profileInUse(dir, (p) => p === path.join(dir, 'SingletonLock')), true);
  assert.equal(launch.profileInUse(dir, () => false), false);
});
