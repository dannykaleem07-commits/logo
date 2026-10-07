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
//
// 24/7 background mode (docs/SUPREME-DESIGN.md §M.1):
//   ClaimDesk-Background.exe --background     supervisor: one instance, starts the server as a hidden child process,
//                                             restarts it (5 s → 5 min backoff), logs to <home>\logs\claimdesk-<date>.log
//   ... --server-child                        the server itself (started by --background; JOBS_ENABLED=true)
//   ... --ensure                              start the background server if it is not answering, then exit
//   ClaimDesk.exe --install-autostart         scheduled tasks ClaimDesk\Background (at sign-in) and ClaimDesk\Watchdog
//   ClaimDesk.exe --remove-autostart          remove both tasks
//   ClaimDesk.exe --open claimdesk://needs-you/<id>   open that page (the claimdesk:// link handler)
// With autostart installed, a normal start makes sure the background server runs and only opens the window; closing
// the window never stops the server.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const util = require('node:util');

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
// Background mode, autostart, links (pure; exported for tests) — docs/SUPREME-DESIGN.md §M.1
// ---------------------------------------------------------------------------

/** The import folder's subfolders (<home>\inbox\…), one per kind of file (§0.3 point 3). */
const INBOX_SUBFOLDERS = ['evidence', 'intake', 'mail', 'brain-packs', 'engineer-data'];

const TASK_BACKGROUND = 'ClaimDesk\\Background';
const TASK_WATCHDOG = 'ClaimDesk\\Watchdog';
/** Used only if Windows refuses the ClaimDesk task folder for a standard user. */
const TASK_FALLBACK = { [TASK_BACKGROUND]: 'ClaimDesk Background', [TASK_WATCHDOG]: 'ClaimDesk Watchdog' };
const BACKGROUND_EXE = 'ClaimDesk-Background.exe';

/** Restart backoff for the server child: 5 s, 10 s, 20 s … capped at 5 minutes. */
const RESTART_BASE_MS = 5000;
const RESTART_MAX_MS = 5 * 60 * 1000;
/** More restarts than this within an hour → stop and tell the owner. */
const MAX_RESTARTS_PER_HOUR = 20;
/** A child that ran this long resets the backoff. */
const STABLE_RUN_MS = 10 * 60 * 1000;
const LOG_KEEP_DAYS = 14;

function restartDelayMs(consecutiveFailures) {
  const n = Math.max(0, Number(consecutiveFailures) || 0);
  return Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.min(n, 16));
}

/** The backoff schedule as a list (for the log and the tests). */
function backoffSchedule(steps = 8) {
  return Array.from({ length: steps }, (_, i) => restartDelayMs(i));
}

/** True when there were more than MAX_RESTARTS_PER_HOUR restarts in the hour before `nowMs`. */
function tooManyRestarts(restartTimesMs, nowMs, max = MAX_RESTARTS_PER_HOUR) {
  return restartTimesMs.filter((t) => nowMs - t < 60 * 60 * 1000).length > max;
}

/** background.lock content → stale (safe to take over) unless it names a live process other than us. */
function lockIsStale(lock, isAlive, selfPid = process.pid) {
  if (!lock || typeof lock !== 'object') return true;
  const pid = Number(lock.pid);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === selfPid) return true;
  try {
    return !isAlive(pid);
  } catch {
    return true;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** claimdesk-YYYY-MM-DD.log for the local date. */
function logFileName(date = new Date()) {
  return `claimdesk-${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}.log`;
}

/** Log files older than `keepDays` (by the date in their name). */
function logsToDelete(names, now = new Date(), keepDays = LOG_KEEP_DAYS) {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return names.filter((n) => {
    const m = /^claimdesk-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(n);
    if (!m) return false;
    const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return (today - day) / 86400000 >= keepDays;
  });
}

/** How to start this launcher again in another mode: the exe itself when packaged, else `node launch.cjs`. */
function childCommand(execPath, scriptPath, isSea, args) {
  return isSea ? { command: execPath, args: [...args] } : { command: execPath, args: [scriptPath, ...args] };
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Fill a task template: {{KEY}} → escaped value; comments removed; a placeholder left over is an error. */
function buildTaskXml(template, values) {
  const out = String(template)
    .replace(/<!--[\s\S]*?-->\s*/g, '')
    .replace(/\{\{([A-Z_]+)\}\}/g, (all, key) => (values[key] === undefined || values[key] === null ? all : xmlEscape(values[key])));
  const left = /\{\{([A-Z_]+)\}\}/.exec(out);
  if (left) throw new Error(`task template value missing: ${left[1]}`);
  return out;
}

/** Local time as the task scheduler wants it (no zone): 2026-10-07T18:15:00. */
function localIsoNoZone(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** DOMAIN\user for the task principal. */
function taskUserId(env, fallbackUser) {
  const user = envGet(env, 'USERNAME') || fallbackUser;
  const domain = envGet(env, 'USERDOMAIN');
  return domain ? `${domain}\\${user}` : user;
}

/** Values for both templates: the background task runs `--background`, the watchdog `--ensure` every 15 minutes. */
function taskDefinitions({ exe, workDir, userId, now = new Date() }) {
  const common = { AUTHOR: 'Courtesy Cars Group UK Ltd - ClaimDesk', USER_ID: userId, COMMAND: exe, WORKING_DIR: workDir };
  return [
    { name: TASK_BACKGROUND, template: 'background.xml', values: { ...common, ARGUMENTS: '--background' } },
    // first check 15 minutes after installing (the logon task or the window starts it before that)
    { name: TASK_WATCHDOG, template: 'watchdog.xml', values: { ...common, ARGUMENTS: '--ensure', START_BOUNDARY: localIsoNoZone(new Date(now.getTime() + 15 * 60 * 1000)) } },
  ];
}

/**
 * claimdesk:// links (Windows notifications, the daily log) → the app URL. Known pages only; ids are plain;
 * only `undo=1` survives as a query. Anything else opens the home page.
 */
function protocolToUrl(raw, port) {
  const base = `http://localhost:${port}`;
  const m = /^claimdesk:\/\/([^?#]*)(?:\?([^#]*))?/i.exec(String(raw || '').trim());
  if (!m) return `${base}/`;
  const parts = m[1].split('/').filter(Boolean);
  const page = (parts[0] || '').toLowerCase();
  const id = parts[1];
  const okId = id === undefined || /^[A-Za-z0-9_-]{1,80}$/.test(id);
  const pages = new Set(['needs-you', 'outbox', 'daily-log', 'agents', 'claims', 'intake']);
  if (!pages.has(page) || !okId || parts.length > 2) return `${base}/`;
  let url = `${base}/${page}${id ? `/${id}` : ''}`;
  const q = new URLSearchParams(m[2] || '');
  if (q.get('undo') === '1') url += '?undo=1';
  return url;
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
// Background mode: log writer, lock, supervisor, server child, ensure, autostart (§M.1)
// ---------------------------------------------------------------------------

function runDir(home) {
  return path.join(home, 'run');
}
function lockPath(home) {
  return path.join(runDir(home), 'background.lock');
}
function logsDir(home) {
  return path.join(home, 'logs');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

function readLock(home) {
  try {
    return JSON.parse(fs.readFileSync(lockPath(home), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * A daily log file under <home>\logs (14 days kept). `install()` replaces console.* so nothing is lost in a process
 * without a console (ClaimDesk-Background.exe is a GUI-subsystem program: stdout and stderr go nowhere).
 */
function createLogWriter(home, tag) {
  const dir = logsDir(home);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  let currentName = '';
  const prune = () => {
    try {
      for (const n of logsToDelete(fs.readdirSync(dir))) fs.rmSync(path.join(dir, n), { force: true });
    } catch {}
  };
  const file = () => {
    const name = logFileName();
    if (name !== currentName) {
      currentName = name;
      prune();
    }
    return path.join(dir, name);
  };
  const write = (level, text) => {
    const line = `${new Date().toISOString()} [${tag} ${process.pid}] ${level.toUpperCase()} ${text}`.replace(/\r?\n(?!$)/g, '\n    ');
    try {
      fs.appendFileSync(file(), `${line}${os.EOL}`);
    } catch {}
  };
  return {
    write,
    file,
    /** Open the current day's file for a child's stdout/stderr. */
    openFd: () => fs.openSync(file(), 'a'),
    install() {
      for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
        console[level] = (...args) => write(level === 'log' ? 'info' : level, util.format(...args));
      }
      process.on('uncaughtException', (err) => {
        write('error', `uncaught: ${err && err.stack ? err.stack : err}`);
        process.exit(1);
      });
      process.on('unhandledRejection', (err) => write('error', `unhandled rejection: ${err && err.stack ? err.stack : err}`));
    },
  };
}

function isSea() {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

/** How to run this launcher in another mode (the packaged exe, or node + this file from a checkout). */
function selfCommand(args) {
  return childCommand(process.execPath, __filename, isSea(), args);
}

/** ClaimDesk-Background.exe next to ClaimDesk.exe when packaged (no console window), else this program. */
function backgroundCommand(args) {
  if (isSea()) {
    const bg = path.join(path.dirname(process.execPath), BACKGROUND_EXE);
    if (fs.existsSync(bg)) return { command: bg, args: [...args] };
  }
  return selfCommand(args);
}

/** The live port as a start would choose it (claimdesk.env may move it). */
function livePort(home) {
  let fileVars = {};
  try {
    fileVars = parseEnvFile(fs.readFileSync(path.join(home, 'claimdesk.env'), 'utf8'));
  } catch {}
  return portFor(false, { ...fileVars, ...process.env });
}

/** Start `--background` detached (it checks itself whether one is already running). */
function spawnBackground() {
  const { command, args } = backgroundCommand(['--background']);
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(command) });
  child.on('error', () => {});
  child.unref();
  return child.pid;
}

async function waitForHealth(port, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    const h = await probeHealth(port);
    if (h) return h;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** `--ensure`: health probe; if ClaimDesk is not answering, start the background server. */
async function ensureBackground({ wait = 0 } = {}) {
  const home = homeDir();
  const port = livePort(home);
  const h = await probeHealth(port);
  if (h) {
    console.log(`ClaimDesk is running on port ${port}.`);
    return 0;
  }
  const pid = spawnBackground();
  console.log(`ClaimDesk was not running: background server started (process ${pid}).`);
  if (wait > 0 && !(await waitForHealth(port, wait))) return 1;
  return 0;
}

/** Is the ClaimDesk\Background scheduled task installed? (schtasks /Query exit code 0) */
function backgroundTaskInstalled() {
  if (process.platform !== 'win32') return false;
  for (const name of [TASK_BACKGROUND, TASK_FALLBACK[TASK_BACKGROUND]]) {
    try {
      const r = spawnSync('schtasks.exe', ['/Query', '/TN', name], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
      if (r.status === 0) return true;
    } catch {}
  }
  return false;
}

/** packaging/autostart (source checkout) or app/autostart (packaged). */
function autostartDir() {
  for (const d of [path.join(__dirname, 'autostart'), path.join(__dirname, 'packaging', 'autostart')]) if (fs.existsSync(path.join(d, 'background.xml'))) return d;
  throw new Error('the scheduled-task templates (autostart\\background.xml, watchdog.xml) are missing next to launch.cjs');
}

/** `--install-autostart`: create both scheduled tasks for this user (no administrator rights needed). */
function installAutostart() {
  if (process.platform !== 'win32') {
    console.log('Autostart uses the Windows Task Scheduler: nothing to do on this system.');
    return 1;
  }
  const home = homeDir();
  fs.mkdirSync(runDir(home), { recursive: true });
  const { command } = backgroundCommand([]);
  const defs = taskDefinitions({ exe: command, workDir: path.dirname(command), userId: taskUserId(process.env, os.userInfo().username) });
  const dir = autostartDir();
  let failed = 0;
  for (const def of defs) {
    const xml = buildTaskXml(fs.readFileSync(path.join(dir, def.template), 'utf8'), def.values);
    const file = path.join(runDir(home), `task-${def.template}`);
    // Task Scheduler reads UTF-16 with a byte-order mark
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
    let r = spawnSync('schtasks.exe', ['/Create', '/XML', file, '/TN', def.name, '/F'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (r.status !== 0) {
      console.log(`schtasks /Create ${def.name}: ${(r.stderr || r.stdout || '').trim()} — trying "${TASK_FALLBACK[def.name]}"`);
      r = spawnSync('schtasks.exe', ['/Create', '/XML', file, '/TN', TASK_FALLBACK[def.name], '/F'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    }
    if (r.status === 0) console.log(`Scheduled task created: ${def.name}`);
    else {
      failed += 1;
      console.error(`Could not create the scheduled task ${def.name}: ${(r.stderr || r.stdout || '').trim()}`);
    }
  }
  return failed ? 1 : 0;
}

/** `--remove-autostart`: delete both tasks (missing ones are fine). */
function removeAutostart() {
  if (process.platform !== 'win32') return 0;
  for (const name of [TASK_BACKGROUND, TASK_WATCHDOG, TASK_FALLBACK[TASK_BACKGROUND], TASK_FALLBACK[TASK_WATCHDOG]]) {
    try {
      const r = spawnSync('schtasks.exe', ['/Delete', '/TN', name, '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30000 });
      if (r.status === 0) console.log(`Scheduled task removed: ${name}`);
    } catch {}
  }
  return 0;
}

/** The import folder: <home>\inbox\{evidence,intake,mail,brain-packs,engineer-data}. */
function ensureInboxFolders(inbox) {
  for (const sub of INBOX_SUBFOLDERS) {
    try {
      fs.mkdirSync(path.join(inbox, sub), { recursive: true });
    } catch {}
  }
}

/**
 * `--background`: the supervisor. One instance (health probe + run\background.lock), the server as a hidden child
 * (`--server-child`), restarts with backoff 5 s → 5 min, gives up after more than 20 restarts in an hour.
 */
async function runBackground(log) {
  const APP = appDir();
  const env = configureEnvironment(APP, { demo: false });
  process.title = 'ClaimDesk (background)';
  if (await probeHealth(env.port)) {
    console.log(`ClaimDesk is already running on port ${env.port}; this background start exits.`);
    return 0;
  }
  const lock = readLock(env.home);
  if (!lockIsStale(lock, isAlive)) {
    console.log(`Another ClaimDesk background process (${lock.pid}) is running; this one exits.`);
    return 0;
  }
  fs.mkdirSync(runDir(env.home), { recursive: true });
  fs.writeFileSync(lockPath(env.home), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), port: env.port }));
  const releaseLock = () => {
    const l = readLock(env.home);
    if (l && Number(l.pid) === process.pid) {
      try {
        fs.rmSync(lockPath(env.home), { force: true });
      } catch {}
    }
  };
  console.log(`Background supervisor started (port ${env.port}, data ${env.dataDir}). Restart backoff: ${backoffSchedule(7).map((ms) => `${ms / 1000}s`).join(', ')}.`);

  let child = null;
  let stopping = false;
  let failures = 0;
  const restarts = [];
  let startedAt = 0;
  let healthMisses = 0;
  let restartTimer = null;

  const startChild = () => {
    if (stopping) return;
    const { command, args } = selfCommand(['--server-child', '--no-browser']);
    let fd;
    try {
      fd = log.openFd();
    } catch {
      fd = 'ignore';
    }
    startedAt = Date.now();
    healthMisses = 0;
    child = spawn(command, args, { stdio: ['ignore', fd, fd], windowsHide: true, env: process.env, cwd: path.dirname(command) });
    if (typeof fd === 'number') {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    console.log(`Server started (process ${child.pid}).`);
    child.on('error', (err) => console.error(`Could not start the server: ${err && err.message ? err.message : err}`));
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return;
      const ran = Date.now() - startedAt;
      failures = ran >= STABLE_RUN_MS ? 0 : failures + 1;
      restarts.push(Date.now());
      while (restarts.length && Date.now() - restarts[0] > 60 * 60 * 1000) restarts.shift();
      if (tooManyRestarts(restarts, Date.now())) {
        const msg = `ClaimDesk stopped: the server failed and was restarted more than ${MAX_RESTARTS_PER_HOUR} times in an hour. The log is in ${logsDir(env.home)}. Start ClaimDesk again from the Start menu.`;
        console.error(msg);
        stopping = true;
        clearInterval(healthTimer);
        releaseLock();
        messageBox(msg);
        process.exit(1);
      }
      const delay = restartDelayMs(Math.max(0, failures - 1));
      console.warn(`Server exited (code ${code}${signal ? `, signal ${signal}` : ''}) after ${Math.round(ran / 1000)} s; restarting in ${delay / 1000} s.`);
      restartTimer = setTimeout(startChild, delay);
    });
  };

  // A server that hangs without exiting: three missed health checks in a row (after a 2-minute start-up) → restart it.
  const healthTimer = setInterval(async () => {
    if (!child || Date.now() - startedAt < 120000) return;
    const h = await probeHealth(env.port);
    healthMisses = h ? 0 : healthMisses + 1;
    if (healthMisses >= 3 && child) {
      console.warn(`The server stopped answering (process ${child.pid}); restarting it.`);
      try {
        child.kill();
      } catch {}
    }
  }, 60000);

  const stop = (why) => {
    if (stopping) return;
    stopping = true;
    console.log(`Background supervisor stopping (${why}).`);
    clearInterval(healthTimer);
    if (restartTimer) clearTimeout(restartTimer);
    if (child) {
      try {
        child.kill();
      } catch {}
    }
    releaseLock();
    setTimeout(() => process.exit(0), 1500);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    try {
      process.on(sig, () => stop(sig));
    } catch {}
  }
  process.on('exit', releaseLock);
  startChild();
  return new Promise(() => {}); // runs until stopped
}

/** `--server-child`: the API in this process, background jobs on, never stopped by a window closing. */
async function runServerChild() {
  const APP = appDir();
  process.env.JOBS_ENABLED = 'true';
  process.env.CLAIMDESK_STOP_ON_CLOSE = '0';
  const env = configureEnvironment(APP, { demo: false });
  process.title = 'ClaimDesk server (background)';
  process.chdir(path.join(APP, 'apps', 'api'));
  const server = await importTs(APP, path.join('apps', 'api', 'src', 'server.ts'));
  await server.start();
  console.log(`ClaimDesk ${process.env.CLAIMDESK_VERSION || ''} is running in the background at http://localhost:${env.port} (data ${env.dataDir}).`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argvIn) {
  const argv = argvIn.filter((a) => a !== process.execPath);
  const has = (flag) => argv.includes(flag);
  const openAt = argv.indexOf('--open');
  return {
    demo: has('--demo'),
    stop: has('--stop'),
    seedOnly: has('--seed-only'),
    noBrowser: has('--no-browser') || process.env.CLAIMDESK_NO_BROWSER === '1',
    background: has('--background'),
    serverChild: has('--server-child'),
    ensure: has('--ensure'),
    installAutostart: has('--install-autostart'),
    removeAutostart: has('--remove-autostart'),
    /** claimdesk://… link to open (from the URL protocol handler). */
    open: openAt >= 0 ? argv[openAt + 1] || 'claimdesk://' : undefined,
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
  // The import folder (§0.3, §K.6): <home>\inbox for your data; the example claims get their own.
  const inbox = opts.demo ? path.join(home, 'demo-inbox') : path.join(home, 'inbox');
  set('CLAIMDESK_HOME', home);
  set('CLAIMDESK_INBOX_DIR', inbox);
  if (!opts.demo) ensureInboxFolders(process.env.CLAIMDESK_INBOX_DIR || inbox);
  return { home, dataDir, dataset, port, envFile, inbox };
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
  // The background supervisor would restart a stopped server: stop it first (live data only).
  let supervisorStopped = false;
  if (!opts.demo) {
    const lock = readLock(home);
    if (!lockIsStale(lock, isAlive)) {
      try {
        process.kill(Number(lock.pid));
        supervisorStopped = true;
        console.log(`ClaimDesk background process ${lock.pid} stopped.`);
      } catch (err) {
        console.log(`Could not stop the ClaimDesk background process ${lock.pid}: ${err && err.message ? err.message : err}`);
      }
      try {
        fs.rmSync(lockPath(home), { force: true });
      } catch {}
    }
  }
  const h = await probeHealth(port);
  if (!h) {
    if (supervisorStopped) return 0;
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
    // the supervisor may already have taken its server down with it
    if (!(supervisorStopped && err && err.code === 'ESRCH')) {
      console.log(`Could not stop ClaimDesk (process ${h.pid}): ${err && err.message ? err.message : err}`);
      return 1;
    }
  }
  for (let i = 0; i < 20 && (await probeHealth(port)); i++) await new Promise((r) => setTimeout(r, 250));
  console.log(`ClaimDesk${opts.demo ? ' (example claims)' : ''} stopped.`);
  return 0;
}

async function run(argvIn = process.argv.slice(2)) {
  const opts = parseArgs(argvIn);
  // Background modes have no console (ClaimDesk-Background.exe): the log file replaces console.* before anything runs.
  if (opts.background || opts.serverChild) {
    const log = createLogWriter(homeDir(), opts.background ? 'supervisor' : 'server');
    log.install();
    try {
      if (opts.background) process.exitCode = await runBackground(log);
      else await runServerChild();
    } catch (err) {
      console.error(`ClaimDesk ${opts.background ? 'background supervisor' : 'server'} stopped because of an error: ${err && err.stack ? err.stack : err}`);
      process.exit(1);
    }
    return;
  }
  if (opts.ensure || opts.installAutostart || opts.removeAutostart) {
    try {
      if (opts.installAutostart) process.exitCode = installAutostart();
      else if (opts.removeAutostart) process.exitCode = removeAutostart();
      else process.exitCode = await ensureBackground();
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
    }
    return;
  }
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
  // --open claimdesk://needs-you/<id> → that page; otherwise the home page
  const openUrl = opts.open ? protocolToUrl(opts.open, env.port) : url;
  process.chdir(path.join(APP, 'apps', 'api'));

  // Autostart installed (§M.1): the server lives in the background. Make sure it runs, open the window, leave.
  if (!opts.demo && !opts.seedOnly && !opts.noBrowser && backgroundTaskInstalled()) {
    let running = await probeHealth(env.port);
    if (running && running.dataset !== env.dataset) throw new Error(`Port ${env.port} is used by ClaimDesk with the example claims. Stop it first (Start menu → Stop ClaimDesk).`);
    if (!running) {
      console.log('Starting ClaimDesk in the background…');
      spawnBackground();
      running = await waitForHealth(env.port, 90);
      if (!running) throw new Error(`ClaimDesk did not start in the background within 90 seconds. The log is in ${logsDir(env.home)}.`);
    }
    console.log(`ClaimDesk is running in the background. Opening ${openUrl}`);
    openAppWindow(openUrl, env.home, env.dataset);
    setTimeout(() => process.exit(0), 1500);
    return;
  }

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
    console.log(`ClaimDesk is already running. Opening ${openUrl}`);
    if (!opts.noBrowser) openAppWindow(openUrl, env.home, env.dataset);
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
  if (env.dataset === 'live') console.log(`Import folder (drop big files here): ${env.inbox}`);
  console.log('Close the ClaimDesk window to stop it (or use Start menu → Stop ClaimDesk).');
  console.log('');
  if (opts.noBrowser) return;
  const opened = openAppWindow(openUrl, env.home, env.dataset, {
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
  // background mode, autostart, links (§M.1)
  INBOX_SUBFOLDERS,
  TASK_BACKGROUND,
  TASK_WATCHDOG,
  BACKGROUND_EXE,
  MAX_RESTARTS_PER_HOUR,
  restartDelayMs,
  backoffSchedule,
  tooManyRestarts,
  lockIsStale,
  logFileName,
  logsToDelete,
  childCommand,
  xmlEscape,
  buildTaskXml,
  localIsoNoZone,
  taskUserId,
  taskDefinitions,
  protocolToUrl,
  createLogWriter,
};

if (require.main === module) void run();
