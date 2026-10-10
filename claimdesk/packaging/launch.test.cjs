// Unit tests for the launcher's pure helpers (design doc §G.3, §K "Desktop"). Run: node packaging/launch.test.cjs
'use strict';
// No test ever calls a real model (docs/SUPREME-DESIGN.md §P.6).
process.env.CLAIMDESK_FORBID_REAL_AI = '1';
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

// ---------------------------------------------------------------------------
// Background mode, autostart, links (docs/SUPREME-DESIGN.md §M.1)
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const os = require('node:os');

test('restart backoff: 5 s doubling to a 5-minute cap', () => {
  assert.deepEqual(launch.backoffSchedule(8), [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000]);
  assert.equal(launch.restartDelayMs(0), 5000);
  assert.equal(launch.restartDelayMs(-3), 5000);
  assert.equal(launch.restartDelayMs(100), 300000);
});

test('more than 20 restarts within an hour → give up', () => {
  const now = 10 * 60 * 60 * 1000;
  const recent = Array.from({ length: 20 }, (_, i) => now - i * 60 * 1000);
  assert.equal(launch.MAX_RESTARTS_PER_HOUR, 20);
  assert.equal(launch.tooManyRestarts(recent, now), false);
  assert.equal(launch.tooManyRestarts([...recent, now - 1000], now), true);
  // restarts older than an hour do not count
  assert.equal(launch.tooManyRestarts([...recent, now - 61 * 60 * 1000, now - 2 * 60 * 60 * 1000], now), false);
});

test('background.lock: stale unless it names another live process', () => {
  const alive = (pid) => pid === 4242;
  assert.equal(launch.lockIsStale(null, alive), true);
  assert.equal(launch.lockIsStale({}, alive), true);
  assert.equal(launch.lockIsStale({ pid: 'x' }, alive), true);
  assert.equal(launch.lockIsStale({ pid: 999 }, alive), true); // that process is gone
  assert.equal(launch.lockIsStale({ pid: 4242 }, alive), false);
  assert.equal(launch.lockIsStale({ pid: 4242 }, alive, 4242), true); // our own pid from an earlier run
  assert.equal(launch.lockIsStale({ pid: 4242 }, () => { throw new Error('no'); }), true);
});

test('background.lock is taken atomically: a second supervisor loses; a stale lock is replaced once', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-lock-'));
  try {
    const alive = (pid) => pid === 4242;
    assert.equal(launch.acquireLock(home, { pid: 4242 }, alive), true);
    assert.equal(launch.acquireLock(home, { pid: 5000 }, alive), false); // 4242 is alive
    fs.writeFileSync(path.join(home, 'run', 'background.lock'), JSON.stringify({ pid: 999 })); // gone
    assert.equal(launch.acquireLock(home, { pid: 5000 }, alive), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'run', 'background.lock'), 'utf8')).pid, 5000);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('"Stop ClaimDesk" leaves a flag the Watchdog respects; a start clears it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-flag-'));
  try {
    assert.equal(launch.stoppedByOwner(home), false);
    launch.setStoppedFlag(home, true);
    assert.equal(launch.stoppedByOwner(home), true);
    launch.setStoppedFlag(home, false);
    assert.equal(launch.stoppedByOwner(home), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('logs: one file per local day, 14 days kept', () => {
  assert.equal(launch.logFileName(new Date(2026, 9, 7, 23, 59)), 'claimdesk-2026-10-07.log');
  assert.equal(launch.logFileName(new Date(2026, 0, 3)), 'claimdesk-2026-01-03.log');
  const now = new Date(2026, 9, 20, 12);
  const names = ['claimdesk-2026-10-20.log', 'claimdesk-2026-10-07.log', 'claimdesk-2026-10-06.log', 'claimdesk-2026-09-01.log', 'other.txt', 'claimdesk-x.log'];
  assert.deepEqual(launch.logsToDelete(names, now), ['claimdesk-2026-10-06.log', 'claimdesk-2026-09-01.log']);
});

test('log writer: appends tagged lines to the day file under <home>\\logs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claimdesk-launch-'));
  try {
    const old = path.join(home, 'logs', 'claimdesk-2000-01-01.log');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, 'old');
    const log = launch.createLogWriter(home, 'supervisor');
    log.write('info', 'hello\nsecond line');
    const file = log.file();
    assert.equal(path.basename(file), launch.logFileName());
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /\[supervisor \d+\] INFO hello\n {4}second line/);
    assert.equal(fs.existsSync(old), false); // pruned
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('childCommand: the packaged exe runs itself; a checkout runs node + launch.cjs', () => {
  assert.deepEqual(launch.childCommand('C:\\CD\\ClaimDesk-Background.exe', 'C:\\CD\\app\\launch.cjs', true, ['--server-child', '--no-browser']), { command: 'C:\\CD\\ClaimDesk-Background.exe', args: ['--server-child', '--no-browser'] });
  assert.deepEqual(launch.childCommand('/usr/bin/node', '/src/packaging/launch.cjs', false, ['--server-child']), { command: '/usr/bin/node', args: ['/src/packaging/launch.cjs', '--server-child'] });
});

const TEMPLATES = path.join(__dirname, 'autostart');
const userId = launch.taskUserId({ USERDOMAIN: 'DESKTOP-1', USERNAME: 'danny' }, 'x');

test('task user: DOMAIN\\user, else the plain user name', () => {
  assert.equal(userId, 'DESKTOP-1\\danny');
  assert.equal(launch.taskUserId({}, 'danny'), 'danny');
});

test('task XML: the Background task (logon, InteractiveToken, IgnoreNew, no time limit, restart on failure)', () => {
  const now = new Date(2026, 9, 7, 18, 0, 0);
  const defs = launch.taskDefinitions({ exe: 'C:\\Users\\danny\\AppData\\Local\\Programs\\ClaimDesk\\ClaimDesk-Background.exe', workDir: 'C:\\Users\\danny\\AppData\\Local\\Programs\\ClaimDesk', userId, now });
  assert.deepEqual(defs.map((d) => d.name), [launch.TASK_BACKGROUND, launch.TASK_WATCHDOG]);
  assert.equal(launch.TASK_BACKGROUND, 'ClaimDesk\\Background');
  assert.equal(launch.TASK_WATCHDOG, 'ClaimDesk\\Watchdog');
  const bg = launch.buildTaskXml(fs.readFileSync(path.join(TEMPLATES, defs[0].template), 'utf8'), defs[0].values);
  assert.doesNotMatch(bg, /\{\{|<!--/);
  for (const re of [
    /<LogonTrigger>[\s\S]*<UserId>DESKTOP-1\\danny<\/UserId>[\s\S]*<\/LogonTrigger>/,
    /<LogonType>InteractiveToken<\/LogonType>/,
    /<RunLevel>LeastPrivilege<\/RunLevel>/,
    /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/,
    /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/,
    /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/,
    /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/,
    /<Hidden>true<\/Hidden>/,
    /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>999<\/Count>\s*<\/RestartOnFailure>/,
    /<Command>C:\\Users\\danny\\AppData\\Local\\Programs\\ClaimDesk\\ClaimDesk-Background\.exe<\/Command>/,
    /<Arguments>--background --at-logon<\/Arguments>/,
  ]) assert.match(bg, re);
  assert.match(bg, /^<\?xml version="1\.0" encoding="UTF-16"\?>/);
});

test('task XML: the Watchdog runs --ensure every 15 minutes, first 15 minutes after installing', () => {
  const now = new Date(2026, 9, 7, 18, 0, 0);
  const defs = launch.taskDefinitions({ exe: 'C:\\CD\\ClaimDesk-Background.exe', workDir: 'C:\\CD', userId, now });
  const wd = launch.buildTaskXml(fs.readFileSync(path.join(TEMPLATES, defs[1].template), 'utf8'), defs[1].values);
  assert.match(wd, /<Interval>PT15M<\/Interval>/);
  assert.match(wd, /<StartBoundary>2026-10-07T18:15:00<\/StartBoundary>/);
  assert.match(wd, /<Arguments>--ensure<\/Arguments>/);
  assert.match(wd, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(wd, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
});

test('task XML builder escapes values and refuses a missing one', () => {
  assert.equal(launch.buildTaskXml('<a>{{X}}</a>', { X: 'R&D <"x">' }), '<a>R&amp;D &lt;&quot;x&quot;&gt;</a>');
  assert.throws(() => launch.buildTaskXml('<a>{{X}}{{Y}}</a>', { X: '1' }), /value missing: Y/);
  assert.equal(launch.localIsoNoZone(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02T03:04:05');
});

test('claimdesk:// links open the right page, and nothing else', () => {
  assert.equal(launch.protocolToUrl('claimdesk://needs-you/9f1c2d3e-aaaa-bbbb-cccc-000000000001', 4000), 'http://localhost:4000/needs-you/9f1c2d3e-aaaa-bbbb-cccc-000000000001');
  assert.equal(launch.protocolToUrl('claimdesk://outbox/ob_123?undo=1', 4000), 'http://localhost:4000/outbox/ob_123?undo=1');
  assert.equal(launch.protocolToUrl('claimdesk://outbox/ob_123/?undo=0&x=1', 5000), 'http://localhost:5000/outbox/ob_123');
  assert.equal(launch.protocolToUrl('claimdesk://needs-you', 4000), 'http://localhost:4000/needs-you');
  assert.equal(launch.protocolToUrl('CLAIMDESK://Needs-You/abc', 4000), 'http://localhost:4000/needs-you/abc');
  assert.equal(launch.protocolToUrl('claimdesk://settings/../../etc', 4000), 'http://localhost:4000/');
  assert.equal(launch.protocolToUrl('claimdesk://needs-you/<script>', 4000), 'http://localhost:4000/');
  assert.equal(launch.protocolToUrl('https://evil.example/x', 4000), 'http://localhost:4000/');
  assert.equal(launch.protocolToUrl(undefined, 4000), 'http://localhost:4000/');
});

test('the import folder has the five subfolders the API watches', () => {
  assert.deepEqual(launch.INBOX_SUBFOLDERS, ['evidence', 'intake', 'mail', 'brain-packs', 'engineer-data']);
  assert.equal(launch.BACKGROUND_EXE, 'ClaimDesk-Background.exe');
});
