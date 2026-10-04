// ClaimDesk launcher: sets up the data folder and settings, starts the server and opens the browser.
// Runs from app/launch.cjs inside the packaged folder (ClaimDesk.exe → sea-bootstrap.cjs → here),
// or directly with `node packaging/launch.cjs` from a source checkout for testing.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const APP = __dirname;
const argv = process.argv.slice(2).filter((a) => a !== process.execPath);
const has = (flag) => argv.includes(flag);
const DEMO = has('--demo');
const SEED_ONLY = has('--seed-only');
const NO_BROWSER = has('--no-browser') || process.env.CLAIMDESK_NO_BROWSER === '1';
const PORT = Number(process.env.PORT || 4000);
const URL_BASE = `http://localhost:${PORT}`;

function pause(code) {
  if (!process.stdin.isTTY || NO_BROWSER) process.exit(code);
  console.log('\nPress Enter to close this window.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(code));
}

function homeDir() {
  if (process.env.CLAIMDESK_HOME) return process.env.CLAIMDESK_HOME;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'ClaimDesk');
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

function health() {
  return new Promise((resolve) => {
    const req = http.get(`${URL_BASE}/api/health`, { timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(res.statusCode === 200 && body.includes('@ccguk/api')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function openBrowser(url) {
  if (NO_BROWSER) return;
  try {
    if (process.platform === 'win32') spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

function configureEnvironment() {
  const home = homeDir();
  const dataDir = path.join(home, DEMO ? 'demo' : 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const secret = persistentSecret(path.join(home, 'secret.key'));
  const set = (k, v) => { if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v; };
  set('NODE_ENV', 'production');
  set('HOST', '127.0.0.1');
  set('PORT', String(PORT));
  set('DATA_DIR', dataDir);
  set('DATABASE_PATH', path.join(dataDir, 'claimdesk.sqlite'));
  set('EVIDENCE_DIR', path.join(dataDir, 'evidence'));
  set('DOCUMENTS_DIR', path.join(dataDir, 'documents'));
  set('WEB_DIST_DIR', path.join(APP, 'apps', 'web', 'dist'));
  set('ESIGN_SECRET', secret);
  set('SESSION_SECRET', secret);
  // Plain http on this computer only: the sign-in cookie cannot be marked HTTPS-only.
  set('COOKIE_SECURE', 'false');
  // No email/SMS sender is configured: show the one-time signing code to the handler to pass to the signer.
  set('ESIGN_DELIVERY', 'handler');
  set('JOBS_ENABLED', 'true');
  // An optional settings file next to the data (API keys etc.): KEY=value lines.
  const envFile = path.join(home, 'claimdesk.env');
  if (!fs.existsSync(envFile)) {
    fs.writeFileSync(envFile, [
      '# ClaimDesk settings. Remove the # and add a key to switch on live look-ups, then restart ClaimDesk.',
      '# DVLA_VES_API_KEY=',
      '# DVSA_MOT_CLIENT_ID=',
      '# DVSA_MOT_CLIENT_SECRET=',
      '# DVSA_MOT_API_KEY=',
      '# DVSA_MOT_TOKEN_URL=',
      '# COMPANIES_HOUSE_API_KEY=',
      '# LOGIN_PREFILL=false',
      '',
    ].join(os.EOL));
  }
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2] !== '') set(m[1], m[2]);
  }
  return { home, dataDir };
}

async function importTs(rel) {
  // Same loader `node --import tsx` installs: tsx's ESM hooks, resolved from the API package.
  if (!global.__claimdeskTsx) {
    // tsx's ESM register() (its CommonJS wrapper mis-resolves its own hook file in tsx 4.23).
    const tsxDir = path.dirname(require('node:module').createRequire(path.join(APP, 'apps', 'api', 'package.json')).resolve('tsx/package.json'));
    const api = await import(pathToFileURL(path.join(tsxDir, 'dist', 'esm', 'api', 'index.mjs')).href);
    global.__claimdeskTsx = api.register();
  }
  return import(pathToFileURL(path.join(APP, rel)).href);
}

async function runSeed() {
  const mod = await importTs(path.join('apps', 'api', 'src', 'seed.ts'));
  await mod.seed();
}

async function main() {
  process.title = 'ClaimDesk';
  const { home, dataDir } = configureEnvironment();
  process.chdir(path.join(APP, 'apps', 'api'));

  if (SEED_ONLY) {
    await runSeed();
    return;
  }

  console.log('ClaimDesk — Courtesy Cars Group UK Ltd');
  console.log('======================================');
  if (await health()) {
    console.log(`ClaimDesk is already running. Opening ${URL_BASE}`);
    openBrowser(URL_BASE);
    setTimeout(() => process.exit(0), 1500);
    return;
  }

  if (DEMO && !fs.existsSync(process.env.DATABASE_PATH)) {
    console.log('Creating the example claims (demo mode)…');
    await runSeed();
  }

  const server = await importTs(path.join('apps', 'api', 'src', 'server.ts'));
  await server.start();

  for (let i = 0; i < 60 && !(await health()); i++) await new Promise((r) => setTimeout(r, 500));
  console.log('');
  console.log(`ClaimDesk is running at ${URL_BASE}${DEMO ? '   (DEMO data)' : ''}`);
  console.log(`Your data: ${dataDir}`);
  console.log(`Settings and API keys: ${path.join(home, 'claimdesk.env')}`);
  console.log('Keep this window open while you use ClaimDesk. Close it to stop ClaimDesk.');
  console.log('');
  openBrowser(URL_BASE);
}

main().catch((err) => {
  console.error('\nClaimDesk stopped because of an error:');
  console.error(err && err.stack ? err.stack : err);
  if (err && err.code === 'EADDRINUSE') console.error(`\nPort ${PORT} is used by another program. Close it, or set PORT in claimdesk.env.`);
  pause(1);
});
