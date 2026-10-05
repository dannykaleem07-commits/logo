// ClaimDesk launcher: sets up the data folder and settings, starts the server and opens ClaimDesk in its own window.
// Runs from app/launch.cjs inside the packaged folder (ClaimDesk.exe → sea-bootstrap.cjs → run()), or directly with
// `node packaging/launch.cjs` from a source checkout for testing. Requiring this file does not start anything: the pure
// helpers are exported for packaging/launch.test.cjs (design doc §G.3).
//
//   ClaimDesk.exe              start (or bring up) ClaimDesk with your data, port 4000
//   ClaimDesk.exe --demo       the example claims, kept apart in <home>\demo, port 4001
//   ClaimDesk.exe --stop       stop every running ClaimDesk (your data and the example claims; --demo: example claims only)
//   --no-browser               start the server only (CI, services); CLAIMDESK_NO_BROWSER=1 does the same
//   --seed-only                create the example claims and exit
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const LIVE_PORT = 4000;
const DEMO_PORT = 4001;
/** A window process that exits sooner than this handed the URL to an already-open ClaimDesk window. */
const HANDOVER_MS = 8000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Port for a dataset: live data on 4000 (or PORT), the example claims on 4001 (or CLAIMDESK_DEMO_PORT). */
function portFor(demo, env = {}) {
  const raw = demo ? env.CLAIMDESK_DEMO_PORT : env.PORT;
  const n = Number(raw);
  if (raw !== undefined && raw !== '' && Number.isInteger(n) && n > 0 && n < 65536) return n;
  return demo ? DEMO_PORT : LIVE_PORT;
}

/** Windows environment lookups are case-insensitive; a plain object (tests) is not. */
function envGet(env, name) {
  if (env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === upper) return env[k];
  return undefined;
}

/**
 * Where the app-window browser is looked for, in order (design doc §G.3). KEEP IN SYNC with
 * packages/documents/src/render.ts installedBrowserCandidates() (same roots, Edge before Chrome), which renders PDFs
 * with the same browser.
 */
function browserRoots(env) {
  const roots = [envGet(env, 'ProgramFiles(x86)'), envGet(env, 'ProgramFiles'), envGet(env, 'LOCALAPPDATA'), 'C:\\Program Files (x86)', 'C:\\Program Files'];
  return [...new Set(roots.filter((r) => typeof r === 'string' && r.trim() !== ''))];
}

const APP_BROWSERS = [
  { exe: 'msedge.exe', rel: 'Microsoft\\Edge\\Application\\msedge.exe' },
  { exe: 'chrome.exe', rel: 'Google\\Chrome\\Application\\chrome.exe' },
];

/**
 * The browser for the ClaimDesk app window: CLAIMDESK_BROWSER_PATH → Edge under Program Files (x86), Program Files,
 * %LOCALAPPDATA% → Edge's App Paths registry entry → Chrome (same roots, then App Paths) → undefined (the caller falls
 * back to `explorer.exe <url>`, the default browser).
 * @param {Record<string, string | undefined>} env
 * @param {(p: string) => boolean} exists
 * @param {(exe: string) => string | undefined} regQuery App Paths lookup for 'msedge.exe' / 'chrome.exe'
 */
function findAppBrowser(env, exists, regQuery) {
  const override = envGet(env, 'CLAIMDESK_BROWSER_PATH');
  if (override && exists(override)) return override;
  for (const b of APP_BROWSERS) {
    for (const root of browserRoots(env)) {
      const p = path.win32.join(root, b.rel);
      if (exists(p)) return p;
    }
    let viaReg;
    try {
      viaReg = regQuery ? regQuery(b.exe) : undefined;
    } catch {
      viaReg = undefined;
    }
    if (viaReg && exists(viaReg)) return viaReg;
  }
  return undefined;
}

/** Arguments for the app window: its own profile (cookies, taskbar group) so it never mixes with the user's browsing. */
function appWindowArgs(url, profileDir) {
  return [`--app=${url}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--window-size=1440,900'];
}

/** <home>\window for live data, <home>\window-demo for the example claims. */
function windowProfileDir(home, dataset) {
  return path.join(home, dataset === 'demo' ? 'window-demo' : 'window');
}

/**
 * Stop-on-close decision for an app-window process that exited after `elapsedMs`. Stops only when enabled
 * (CLAIMDESK_STOP_ON_CLOSE, default 1) and the window lived ≥ 8 s; a quick exit means the URL was handed to a window
 * that is already open, so ClaimDesk keeps running.
 */
function shouldStopOnWindowExit(elapsedMs, env = {}) {
  const flag = String(envGet(env, 'CLAIMDESK_STOP_ON_CLOSE') ?? '1').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'no' || flag === 'off') return false;
  return elapsedMs >= HANDOVER_MS;
}

/** Files a Chromium browser holds in its --user-data-dir while it runs (Windows: lockfile; Linux/macOS: SingletonLock). */
const PROFILE_LOCKS = ['lockfile', 'SingletonLock'];

/** Is a browser running with this app-window profile? */
function profileInUse(profileDir, exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } }) {
  return PROFILE_LOCKS.some((name) => exists(path.join(profileDir, name)));
}

/**
 * Stop-on-close by watching the window profile, not the process this launcher spawned: the browser keeps its lock
 * file in the profile while any ClaimDesk window is open, so this works when the URL was handed to a window that was
 * already open (after an upgrade or "Stop ClaimDesk" left one behind), and a slow hand-over never stops the server
 * under an open window. Feed it one observation per poll: it answers 'closed' once, after the lock has been seen and
 * then missed on `absentPolls` polls in a row; 'never' when no lock was seen within `firstSeenWithin` polls (the caller
 * then falls back to the process-exit rule).
 */
function createWindowWatch({ absentPolls = 2, firstSeenWithin = 30 } = {}) {
  let seen = false;
  let absent = 0;
  let polls = 0;
  let done = false;
  return {
    get seen() {
      return seen;
    },
    observe(open) {
      if (done) return 'done';
      polls += 1;
      if (open) {
        seen = true;
        absent = 0;
        return 'open';
      }
      if (!seen) {
        if (polls >= firstSeenWithin) {
          done = true;
          return 'never';
        }
        return 'waiting';
      }
      absent += 1;
      if (absent >= absentPolls) {
        done = true;
        return 'closed';
      }
      return 'closing';
    },
  };
}

/** Parse a /api/health body; null unless it is ClaimDesk's API. Older APIs without `dataset` are live data. */
function parseHealth(statusCode, body) {
  if (statusCode !== 200) return null;
  try {
    const h = JSON.parse(body);
    if (!h || h.service !== '@ccguk/api') return null;
    return { ok: Boolean(h.ok), dataset: h.dataset === 'demo' ? 'demo' : 'live', pid: Number.isInteger(h.pid) ? h.pid : undefined, version: typeof h.version === 'string' ? h.version : undefined };
  } catch {
    return null;
  }
}

/** Parse `reg query <key> /ve` output: the default value's path, environment variables expanded. */
function parseRegDefault(out, env = {}) {
  const m = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im.exec(out || '');
  if (!m) return undefined;
  const p = m[1].trim().replace(/^"|"$/g, '').replace(/%([^%]+)%/g, (all, v) => envGet(env, v) ?? all);
  return /\.exe$/i.test(p) ? p : undefined;
}

/** The claimdesk.env template written on first start (KEY=value lines; remove the # to switch one on). */
function envTemplate() {
  return [
    '# ClaimDesk settings. Remove the # in front of a line, fill in the value and restart ClaimDesk.',
    '#',
    '# Live vehicle look-ups (without them ClaimDesk works in manual mode: ClaimDesk records + Total Car Check).',
    '# DVLA_VES_API_KEY=',
    '# DVSA_MOT_CLIENT_ID=',
    '# DVSA_MOT_CLIENT_SECRET=',
    '# DVSA_MOT_API_KEY=',
    '# DVSA_MOT_TOKEN_URL=',
    '# COMPANIES_HOUSE_API_KEY=',
    '# LOGIN_PREFILL=false',
    ...envTemplateAdditions(),
    '',
  ];
}

/** Lines added in 0.2 (appended once to an older claimdesk.env as comments). */
function envTemplateAdditions() {
  return [
    '#',
    '# Word templates to PDF: auto (Word, then LibreOffice, then the browser), word, libreoffice or browser.',
    '# DOCX_PDF_CONVERTER=auto',
    '# Full path to LibreOffice soffice.exe when it is not in the usual place.',
    '# SOFFICE_PATH=C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    '# Total Car Check free-check address ({REG} = the registration, upper case, no spaces).',
    '# TOTALCARCHECK_URL_TEMPLATE=https://totalcarcheck.co.uk/FreeCheck?regno={REG}',
    '# Open ClaimDesk in a normal browser tab instead of its own window.',
    '# CLAIMDESK_BROWSER=tab',
    '# Keep ClaimDesk running after its window is closed (1 = stop when the last ClaimDesk window closes).',
    '# CLAIMDESK_STOP_ON_CLOSE=0',
  ];
}

/** KEY=value lines → object (blank values and comments ignored). */
function parseEnvFile(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2] !== '') out[m[1]] = m[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Side-effecting pieces
// ---------------------------------------------------------------------------

/** The app folder: app/ when packaged; the repository root when run as packaging/launch.cjs from a checkout. */
function appDir() {
  if (fs.existsSync(path.join(__dirname, 'apps', 'api'))) return __dirname;
  const parent = path.dirname(__dirname);
  if (fs.existsSync(path.join(parent, 'apps', 'api'))) return parent;
  return __dirname;
}

function homeDir(env = process.env) {
  if (env.CLAIMDESK_HOME) return env.CLAIMDESK_HOME;
  if (process.platform === 'win32' && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'ClaimDesk');
  return path.join(os.homedir(), '.claimdesk');
}

function persistentSecret(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {}
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

/** App Paths default value for an exe from HKCU, HKLM and HKLM\WOW6432Node (reg.exe; Windows only). */
function regAppPath(exe) {
  if (process.platform !== 'win32') return undefined;
  const keys = [
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
  ];
  for (const key of keys) {
    try {
      const out = execFileSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 3000 });
      const p = parseRegDefault(out, process.env);
      if (p) return p;
    } catch {}
  }
  return undefined;
}

function probeHealth(port) {
  return new Promise((resolve) => {
    // Straight to IPv4: on Windows a refused ::1 connection stalls ~2 s before falling back.
    const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(parseHealth(res.statusCode, body)));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function openDefaultBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

/**
 * Open ClaimDesk in its own Edge/Chrome app window (own profile, no tabs or address bar). Falls back to the default
 * browser tab when no Chromium browser is found, off Windows, or with CLAIMDESK_BROWSER=tab.
 * `onAllWindowsClosed` runs when the window process exits after ≥ 8 s (see shouldStopOnWindowExit).
 */
function openAppWindow(url, home, dataset, opts = {}) {
  const env = process.env;
  const wantTab = String(env.CLAIMDESK_BROWSER || '').trim().toLowerCase() === 'tab';
  const exe = process.platform === 'win32' && !wantTab ? findAppBrowser(env, (p) => fs.existsSync(p), regAppPath) : undefined;
  if (!exe) {
    openDefaultBrowser(url);
    return { mode: 'tab' };
  }
  const profile = windowProfileDir(home, dataset);
  try {
    fs.mkdirSync(profile, { recursive: true });
  } catch {}
  const started = Date.now();
  let child;
  try {
    child = spawn(exe, appWindowArgs(url, profile), { detached: true, stdio: 'ignore', windowsHide: false });
  } catch {
    openDefaultBrowser(url);
    return { mode: 'tab' };
  }
  child.on('error', () => openDefaultBrowser(url));
  const wantStop = typeof opts.onAllWindowsClosed === 'function' && shouldStopOnWindowExit(Number.MAX_SAFE_INTEGER, env);
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    opts.onAllWindowsClosed();
  };
  // Preferred: watch the profile's lock file (see createWindowWatch); it follows every ClaimDesk window of this
  // profile, including one opened by an earlier launcher.
  const watch = createWindowWatch();
  let timer;
  if (wantStop) {
    timer = setInterval(() => {
      const r = watch.observe(profileInUse(profile));
      if (r === 'closed') {
        clearInterval(timer);
        fire();
      } else if (r === 'never') clearInterval(timer);
    }, 2000);
    timer.unref();
  }
  // Fallback when the browser never showed a lock file: with this profile already open the browser hands the URL over
  // and this process exits within a second or two; otherwise it is the profile's main process and exits only when the
  // last ClaimDesk window closes.
  child.on('exit', () => {
    const elapsed = Date.now() - started;
    if (!wantStop || watch.seen) return;
    if (shouldStopOnWindowExit(elapsed, env)) {
      if (timer) clearInterval(timer);
      fire();
    }
  });
  child.unref();
  return { mode: 'window', exe };
}

const PS_WINDOW = "Add-Type -Name W -Namespace C -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern System.IntPtr GetConsoleWindow(); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(System.IntPtr h, int n);';";

/** Minimise this process's own console (shortcuts already start it minimised; this covers a double-click). */
function minimiseOwnConsole() {
  if (process.platform !== 'win32' || !process.stdout.isTTY) return;
  // stdio 'inherit' so PowerShell shares (and minimises) THIS console; no -WindowStyle.
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${PS_WINDOW} [void][C.W]::ShowWindow([C.W]::GetConsoleWindow(), 6)`], { stdio: 'inherit', windowsHide: false });
  } catch {}
}

/** Restore the console (after a fatal error) so the message is readable. */
function restoreOwnConsole() {
  if (process.platform !== 'win32') return;
  try {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${PS_WINDOW} [void][C.W]::ShowWindow([C.W]::GetConsoleWindow(), 9)`], { stdio: 'inherit', timeout: 10000 });
  } catch {}
}

/** A Windows message box (the console may be minimised or hidden behind the app window). */
function messageBox(message) {
  if (process.platform !== 'win32') return;
  try {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:CLAIMDESK_MESSAGE, 'ClaimDesk', 'OK', 'Error')"], {
      stdio: 'ignore',
      env: { ...process.env, CLAIMDESK_MESSAGE: message },
      windowsHide: true,
      timeout: 10 * 60 * 1000,
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argvIn) {
  const argv = argvIn.filter((a) => a !== process.execPath);
  const has = (flag) => argv.includes(flag);
  return {
    demo: has('--demo'),
    stop: has('--stop'),
    seedOnly: has('--seed-only'),
    noBrowser: has('--no-browser') || process.env.CLAIMDESK_NO_BROWSER === '1',
  };
}

function pause(code, interactive) {
  if (!interactive || !process.stdin.isTTY) process.exit(code);
  console.log('\nPress Enter to close this window.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(code));
}

function readVersion(APP) {
  for (const f of [path.join(APP, 'version.json'), path.join(__dirname, 'version.json')]) {
    try {
      const v = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (v && typeof v.version === 'string' && v.version) return v.version;
    } catch {}
  }
  try {
    const v = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;
    if (typeof v === 'string' && v) return v;
  } catch {}
  return undefined;
}

function configureEnvironment(APP, opts) {
  const home = homeDir();
  const dataset = opts.demo ? 'demo' : 'live';
  const dataDir = path.join(home, opts.demo ? 'demo' : 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // An optional settings file next to the data (API keys etc.): KEY=value lines. Real environment variables win.
  const envFile = path.join(home, 'claimdesk.env');
  if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, envTemplate().join(os.EOL));
  else {
    try {
      const text = fs.readFileSync(envFile, 'utf8');
      if (!/DOCX_PDF_CONVERTER/.test(text)) fs.appendFileSync(envFile, os.EOL + envTemplateAdditions().join(os.EOL) + os.EOL);
    } catch {}
  }
  const set = (k, v) => {
    if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
  };
  let fileVars = {};
  try {
    fileVars = parseEnvFile(fs.readFileSync(envFile, 'utf8'));
  } catch {}
  for (const [k, v] of Object.entries(fileVars)) set(k, v);

  const port = portFor(opts.demo, process.env);
  const secret = persistentSecret(path.join(home, 'secret.key'));
  // Forced (not defaults): the dataset and port decide which data this process serves.
  process.env.PORT = String(port);
  process.env.CLAIMDESK_DATASET = dataset;
  set('CLAIMDESK_VERSION', readVersion(APP) || '');
  set('NODE_ENV', 'production');
  set('HOST', 'localhost'); // Fastify binds both 127.0.0.1 and ::1 for 'localhost', so the browser never waits on IPv6
  set('DATA_DIR', dataDir);
  set('DATABASE_PATH', path.join(dataDir, 'claimdesk.sqlite'));
  set('EVIDENCE_DIR', path.join(dataDir, 'evidence'));
  set('DOCUMENTS_DIR', path.join(dataDir, 'documents'));
  set('TEMPLATES_DIR', path.join(dataDir, 'templates'));
  set('WEB_DIST_DIR', path.join(APP, 'apps', 'web', 'dist'));
  set('ESIGN_SECRET', secret);
  set('SESSION_SECRET', secret);
  // Plain http on this computer only: the sign-in cookie cannot be marked HTTPS-only.
  set('COOKIE_SECURE', 'false');
  // No email/SMS sender is configured: show the one-time signing code to the handler to pass to the signer.
  set('ESIGN_DELIVERY', 'handler');
  set('JOBS_ENABLED', 'true');
  return { home, dataDir, dataset, port, envFile };
}

async function importTs(APP, rel) {
  // Same loader `node --import tsx` installs: tsx's ESM hooks, resolved from the API package.
  if (!global.__claimdeskTsx) {
    // tsx's ESM register() (its CommonJS wrapper mis-resolves its own hook file in tsx 4.23).
    const tsxDir = path.dirname(require('node:module').createRequire(path.join(APP, 'apps', 'api', 'package.json')).resolve('tsx/package.json'));
    const api = await import(pathToFileURL(path.join(tsxDir, 'dist', 'esm', 'api', 'index.mjs')).href);
    global.__claimdeskTsx = api.register();
  }
  return import(pathToFileURL(path.join(APP, rel)).href);
}

/**
 * `--stop --demo` stops the example claims; plain `--stop` (the Start menu "Stop ClaimDesk") stops whatever ClaimDesk
 * is running — your data and the example claims — as the portable "Stop ClaimDesk.cmd" does.
 */
async function stopRunning(opts) {
  if (opts.demo) return stopDataset(true);
  const live = await stopDataset(false);
  const demo = await stopDataset(true, { quietIfNotRunning: true });
  return live || demo;
}

async function stopDataset(demoFlag, { quietIfNotRunning = false } = {}) {
  const opts = { demo: demoFlag };
  const dataset = opts.demo ? 'demo' : 'live';
  // the env file may move the port: read it the same way a start would
  const home = homeDir();
  let fileVars = {};
  try {
    fileVars = parseEnvFile(fs.readFileSync(path.join(home, 'claimdesk.env'), 'utf8'));
  } catch {}
  const port = portFor(opts.demo, { ...fileVars, ...process.env });
  const h = await probeHealth(port);
  if (!h) {
    if (!quietIfNotRunning) console.log(`ClaimDesk${opts.demo ? ' (example claims)' : ''} is not running.`);
    return 0;
  }
  if (h.dataset !== dataset) {
    console.log(`Port ${port} is ClaimDesk with the ${h.dataset} data, not the ${dataset} data; left running.`);
    return 1;
  }
  if (!h.pid) {
    console.log('This ClaimDesk is too old to be stopped this way: close its console window instead.');
    return 1;
  }
  try {
    process.kill(h.pid);
  } catch (err) {
    console.log(`Could not stop ClaimDesk (process ${h.pid}): ${err && err.message ? err.message : err}`);
    return 1;
  }
  for (let i = 0; i < 20 && (await probeHealth(port)); i++) await new Promise((r) => setTimeout(r, 250));
  console.log(`ClaimDesk${opts.demo ? ' (example claims)' : ''} stopped.`);
  return 0;
}

async function run(argvIn = process.argv.slice(2)) {
  const opts = parseArgs(argvIn);
  const interactive = !opts.noBrowser;
  process.title = opts.demo ? 'ClaimDesk (example claims)' : 'ClaimDesk';
  try {
    if (opts.stop) {
      process.exitCode = await stopRunning(opts);
      return;
    }
    await start(opts);
  } catch (err) {
    console.error('\nClaimDesk stopped because of an error:');
    console.error(err && err.stack ? err.stack : err);
    let advice = '';
    if (err && err.code === 'EADDRINUSE') {
      advice = `Port ${process.env.PORT} is used by another program. Close it, or set ${opts.demo ? 'CLAIMDESK_DEMO_PORT' : 'PORT'} in claimdesk.env.`;
      console.error(`\n${advice}`);
    }
    if (interactive && process.env.CLAIMDESK_NO_DIALOG !== '1') {
      restoreOwnConsole();
      messageBox(`ClaimDesk could not start.\n\n${err && err.message ? err.message : String(err)}${advice ? `\n\n${advice}` : ''}\n\nThe console window has the details.`);
    }
    pause(1, interactive);
  }
}

async function start(opts) {
  const APP = appDir();
  const env = configureEnvironment(APP, opts);
  const url = `http://localhost:${env.port}`;
  process.chdir(path.join(APP, 'apps', 'api'));

  if (opts.seedOnly) {
    const mod = await importTs(APP, path.join('apps', 'api', 'src', 'seed.ts'));
    await mod.seed();
    return;
  }

  const title = `ClaimDesk ${process.env.CLAIMDESK_VERSION || ''} — Courtesy Cars Group UK Ltd`.replace(/\s+/g, ' ');
  console.log(title);
  console.log('='.repeat(title.length));
  const running = await probeHealth(env.port);
  if (running) {
    if (running.dataset !== env.dataset) {
      throw new Error(`Port ${env.port} is already used by ClaimDesk with the ${running.dataset === 'demo' ? 'example claims' : 'live data'}; it will not be opened as the ${env.dataset === 'demo' ? 'example claims' : 'live data'}. Stop it first (Start menu → Stop ClaimDesk).`);
    }
    console.log(`ClaimDesk is already running. Opening ${url}`);
    if (!opts.noBrowser) openAppWindow(url, env.home, env.dataset);
    setTimeout(() => process.exit(0), 1500);
    return;
  }

  if (opts.demo && !fs.existsSync(process.env.DATABASE_PATH)) {
    console.log('Creating the example claims (demo mode)…');
    const mod = await importTs(APP, path.join('apps', 'api', 'src', 'seed.ts'));
    await mod.seed();
  }

  const server = await importTs(APP, path.join('apps', 'api', 'src', 'server.ts'));
  await server.start();

  for (let i = 0; i < 60 && !(await probeHealth(env.port)); i++) await new Promise((r) => setTimeout(r, 500));
  console.log('');
  console.log(`ClaimDesk is running at ${url}${opts.demo ? '   (EXAMPLE CLAIMS)' : ''}`);
  console.log(`Your data: ${env.dataDir}`);
  console.log(`Settings and API keys: ${env.envFile}`);
  console.log('Close the ClaimDesk window to stop it (or use Start menu → Stop ClaimDesk).');
  console.log('');
  if (opts.noBrowser) return;
  const opened = openAppWindow(url, env.home, env.dataset, {
    onAllWindowsClosed: () => {
      console.log('The ClaimDesk window was closed: stopping.');
      // server.ts closes Fastify on SIGTERM and exits; the timer covers a server without that handler.
      if (process.listenerCount('SIGTERM') > 0) process.emit('SIGTERM', 'SIGTERM');
      setTimeout(() => process.exit(0), 5000);
    },
  });
  if (opened.mode === 'tab') console.log('Keep this window open while you use ClaimDesk. Close it to stop ClaimDesk.');
  minimiseOwnConsole();
}

module.exports = {
  LIVE_PORT,
  DEMO_PORT,
  HANDOVER_MS,
  portFor,
  findAppBrowser,
  appWindowArgs,
  windowProfileDir,
  shouldStopOnWindowExit,
  profileInUse,
  createWindowWatch,
  parseHealth,
  parseRegDefault,
  parseEnvFile,
  envTemplate,
  openAppWindow,
  minimiseOwnConsole,
  run,
};

if (require.main === module) void run();
