#!/usr/bin/env node
// Builds the portable ClaimDesk folder (also the input of the Windows installer, packaging/installer/ClaimDesk.iss):
//   ClaimDesk/ClaimDesk.exe        Node single-executable app (the launcher), with Courtesy Cars Group UK Ltd file details
//   ClaimDesk/app/...              the API source, built web app and node_modules (real files, no links), version.json
//   ClaimDesk/Start with example claims.cmd, Stop ClaimDesk.cmd, README.txt, docs/
// Requirements: run after `pnpm install --config.node-linker=hoisted` (flat node_modules) and the web build.
// Usage: node packaging/build-package.mjs [--out <dir>] [--no-exe]
// Environment: CLAIMDESK_VERSION (CI: <major>.<minor>.<run number>; default: package.json version),
//              SKIP_FEATURE_ASSERTS=1 (local partial builds only: catalogue / docx-preview / jszip checks become warnings).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, lstatSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';


/**
 * With `shell: true` Node joins the arguments with spaces and does not quote them, so a checkout under a path with
 * spaces ("C:\\Users\\Jo Smith\\…") would split. Quote any argument that needs it for cmd.exe / sh.
 */
function shellArg(a) {
  return /[\s"&()^%!|<>]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = outArg >= 0 ? args[outArg + 1] : join(HERE, 'dist', 'ClaimDesk');
const APP = join(OUT, 'app');
const WIN = process.platform === 'win32';
const EXE = join(OUT, WIN ? 'ClaimDesk.exe' : 'ClaimDesk');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const PUBLISHER = 'Courtesy Cars Group UK Ltd';

function step(msg) { console.log(`\n▶ ${msg}`); }
function fail(msg) { console.error(`✖ ${msg}`); process.exit(1); }
function warn(msg) { console.warn(`  ⚠ ${msg}`); }

// ---------------------------------------------------------------------------
// Version (design doc §G.1): CLAIMDESK_VERSION, else package.json. Numeric parts ≤ 65535 (Windows file versions).
// ---------------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = (process.env.CLAIMDESK_VERSION || '').trim() || String(pkg.version || '').trim();
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) fail(`version "${VERSION}" must be <major>.<minor>.<patch> (set CLAIMDESK_VERSION or package.json "version")`);
if (VERSION.split('.').some((n) => Number(n) > 65535)) fail(`version "${VERSION}": each part must be 65535 or less for the Windows file version`);
function gitCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

const SKIP_DIRS = new Set(['.git', '.test-data', 'coverage', '.cache', '.vite', 'out', '.turbo']);
const SKIP_FILE = /\.(test|spec)\.(ts|tsx|mjs|cjs|js)$|\.tsbuildinfo$/;
function keep(src) {
  const parts = src.split(sep);
  const base = parts[parts.length - 1];
  // .bin holds CLI shims only; after a --prod prune some point at removed packages and would break the copy
  if (base === '.bin') return false;
  if (!existsSync(src)) return false; // dangling symlink
  // inside node_modules ship packages untouched (some publish their code under out/ or name files *.test.js)
  if (parts.includes('node_modules')) return true;
  if (SKIP_DIRS.has(base)) return false;
  if (SKIP_FILE.test(base)) return false;
  // the API's own test helpers and scratch data are not shipped
  const rel = relative(ROOT, src).split(sep).join('/');
  if (rel.startsWith('apps/api/src/test') || rel === 'apps/api/data' || rel.startsWith('apps/api/data/')) return false;
  return true;
}
function copy(rel, opts = {}) {
  const src = join(ROOT, rel);
  if (!existsSync(src)) { if (opts.optional) return; fail(`missing ${rel}`); }
  cpSync(src, join(APP, rel), { recursive: true, dereference: true, filter: keep });
}
function dirSize(p) {
  let total = 0;
  for (const e of readdirSync(p)) {
    const f = join(p, e);
    const s = lstatSync(f);
    total += s.isDirectory() ? dirSize(f) : s.size;
  }
  return total;
}

step(`Checking the build inputs (ClaimDesk ${VERSION})`);
if (!existsSync(join(ROOT, 'apps', 'web', 'dist', 'index.html'))) fail('apps/web/dist is missing — run `pnpm --filter @ccguk/web build` first');
if (!existsSync(join(ROOT, 'node_modules', 'tsx'))) fail('node_modules/tsx is missing — install with `pnpm install --config.node-linker=hoisted`');
if (existsSync(join(ROOT, 'node_modules', '.pnpm')) && !existsSync(join(ROOT, 'node_modules', 'fastify'))) fail('node_modules uses the linked layout; reinstall with `--config.node-linker=hoisted` so it can be copied as plain files');

step(`Assembling ${OUT}`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });
for (const f of ['package.json', 'pnpm-workspace.yaml', 'tsconfig.base.json']) copyFileSync(join(ROOT, f), join(APP, f));
copy('apps/api/package.json');
copy('apps/api/tsconfig.json');
copy('apps/api/src');
copy('apps/api/node_modules', { optional: true });
copy('apps/web/package.json');
copy('apps/web/dist');
for (const p of readdirSync(join(ROOT, 'packages'))) {
  for (const part of ['package.json', 'tsconfig.json', 'src', 'data', 'assets', 'drizzle', 'node_modules']) copy(`packages/${p}/${part}`, { optional: true });
}
copy('node_modules');
copyFileSync(join(HERE, 'launch.cjs'), join(APP, 'launch.cjs'));
const versionInfo = { version: VERSION, commit: gitCommit(), builtAt: new Date().toISOString() };
writeFileSync(join(APP, 'version.json'), `${JSON.stringify(versionInfo, null, 2)}\n`);
// docs the owner may want next to the program
mkdirSync(join(OUT, 'docs'), { recursive: true });
for (const d of ['README.md']) copyFileSync(join(ROOT, d), join(OUT, 'docs', d));
for (const d of ['SETUP-APIS.md', 'LEGAL-CAVEATS.md', 'RESEARCH-CORRECTIONS.md', 'KNOWN-ISSUES.md']) if (existsSync(join(ROOT, 'docs', d))) copyFileSync(join(ROOT, 'docs', d), join(OUT, 'docs', d));

writeFileSync(join(OUT, 'README.txt'), [
  `ClaimDesk ${VERSION} — ${PUBLISHER}`,
  'Accident claims, credit hire, recovery and storage case management.',
  '',
  'INSTALL (recommended): run ClaimDesk-Setup-<version>.exe. No administrator rights are needed.',
  'It adds ClaimDesk, "ClaimDesk (example claims)" and "Stop ClaimDesk" to the Start menu, and updates',
  'an earlier version in place without touching your data.',
  '',
  'Prefer the installer. To run without installing: unzip, then double-click ClaimDesk.exe; the app',
  'opens in its own window (Microsoft Edge, which every Windows 10/11 PC has). Closing the ClaimDesk',
  'window stops ClaimDesk. "Stop ClaimDesk.cmd" stops it too.',
  '',
  'Sign in: username courtesycars, password CourtesyCars123! (both are filled in for you).',
  'Change the password in Settings before you put real claims in: this password is published.',
  '',
  'To look around with example claims first, use "ClaimDesk (example claims)" in the Start menu or',
  'double-click "Start with example claims.cmd". Example claims are kept separately from your data.',
  '',
  'Your data is stored in %LOCALAPPDATA%\\ClaimDesk\\data (examples in ...\\demo). Uninstalling keeps it',
  'unless you choose to delete it.',
  'Settings and API keys (DVLA, DVSA, Companies House) go in %LOCALAPPDATA%\\ClaimDesk\\claimdesk.env.',
  'Without keys, vehicle searches use ClaimDesk records and Total Car Check (manual mode).',
  'PDFs are produced with Microsoft Word when installed, otherwise LibreOffice or Microsoft Edge.',
  '',
  'Windows may say "Windows protected your PC" or "Unknown publisher" because the program is not yet',
  'code-signed. Click "More info" then "Run anyway".',
  'If Windows says Smart App Control blocked this app, a code-signed build is needed (or turn Smart App',
  'Control off in Windows Security > App & browser control).',
  '',
  `${PUBLISHER} · Registered in England & Wales No. 17430389 · 44 Syon Lane, Isleworth, London TW7 5NQ`,
  'claims@courtesycars.net · 020 7052 5403 · www.courtesycars.net',
  '',
].join('\r\n'));
writeFileSync(join(OUT, 'Start with example claims.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nstart "" /min "%~dp0ClaimDesk.exe" --demo\r\n');
writeFileSync(join(OUT, 'Stop ClaimDesk.cmd'), '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0ClaimDesk.exe" --stop\r\n"%~dp0ClaimDesk.exe" --stop --demo\r\n');

// ---------------------------------------------------------------------------
// Packaging checks (design doc §G.6): the build fails when a feature's files are missing.
// ---------------------------------------------------------------------------
step('Checking the package contents');
{
  const skipFeatures = process.env.SKIP_FEATURE_ASSERTS === '1';
  const problems = [];
  const check = (ok, msg, feature = false) => {
    if (ok) return;
    if (feature && skipFeatures) warn(`${msg} (ignored: SKIP_FEATURE_ASSERTS=1)`);
    else problems.push(msg);
  };
  const countFiles = (dir, re) => (existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).length : 0);
  const docx = countFiles(join(APP, 'packages', 'documents', 'assets', 'docx'), /\.docx$/i);
  check(docx === 10, `app/packages/documents/assets/docx: expected 10 .docx templates, found ${docx}`);
  const makes = countFiles(join(APP, 'packages', 'kb', 'data', 'vehicle-catalogue', 'makes'), /\.json$/i);
  check(makes > 0, 'app/packages/kb/data/vehicle-catalogue/makes/*.json is missing (vehicle catalogue)', true);
  check(existsSync(join(APP, 'packages', 'kb', 'data', 'gta-segment-defaults.json')), 'app/packages/kb/data/gta-segment-defaults.json is missing');
  check(existsSync(join(APP, 'node_modules', 'docx-preview', 'dist', 'docx-preview.min.js')), 'app/node_modules/docx-preview/dist/docx-preview.min.js is missing (DOCX → PDF in the browser)', true);
  check(existsSync(join(APP, 'node_modules', 'jszip', 'dist', 'jszip.min.js')), 'app/node_modules/jszip/dist/jszip.min.js is missing (DOCX → PDF in the browser)', true);
  check(existsSync(join(APP, 'node_modules', 'fflate')), 'app/node_modules/fflate is missing (DOCX engine)');
  check(existsSync(join(APP, 'node_modules', '@xmldom', 'xmldom')), 'app/node_modules/@xmldom/xmldom is missing (DOCX engine)');
  check(existsSync(join(APP, 'version.json')), 'app/version.json is missing');
  if (problems.length) fail(`the package is incomplete:\n  - ${problems.join('\n  - ')}`);
  console.log(`  ok: ${docx} Word templates, ${makes} catalogue makes, DOCX engine and converter files, version ${VERSION}`);
}

/** signtool.exe from the newest Windows 10/11 SDK, if installed. */
function findSigntool() {
  const base = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (!existsSync(base)) return undefined;
  const versions = readdirSync(base).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)).sort((a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
    return 0;
  });
  for (const v of versions) {
    const p = join(base, v, 'x64', 'signtool.exe');
    if (existsSync(p)) return p;
  }
  return undefined;
}

if (!args.includes('--no-exe')) {
  step('Building the single executable (Node SEA)');
  execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: HERE, stdio: 'inherit' });
  copyFileSync(process.execPath, EXE);
  if (WIN) {
    // node.exe carries the OpenJS Foundation's signature, which the resource and blob edits below invalidate:
    // remove it so Windows sees an unsigned file rather than a broken signature (design doc §G.2).
    const signtool = findSigntool();
    if (signtool) {
      try {
        execFileSync(signtool, ['remove', '/s', EXE], { stdio: 'inherit' });
      } catch (e) {
        warn(`signtool remove /s failed: ${e instanceof Error ? e.message : e} — continuing`);
      }
    } else warn('signtool.exe not found (Windows SDK) — the original node.exe signature is left in place');

    try {
      // rcedit (Electron's resource editor) sets the icon and file details before the app is injected.
      const tmp = join(HERE, '.rcedit');
      execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', shellArg(tmp), 'rcedit@4.0.1'], { stdio: 'inherit', shell: true });
      const rcedit = createRequire(join(tmp, 'package.json'))('rcedit');
      const details = {
        'file-version': `${VERSION}.0`,
        'product-version': VERSION,
        'version-string': {
          CompanyName: PUBLISHER,
          ProductName: 'ClaimDesk',
          FileDescription: `ClaimDesk - ${PUBLISHER}`,
          LegalCopyright: `Copyright © 2026 ${PUBLISHER}`,
          OriginalFilename: 'ClaimDesk.exe',
          InternalName: 'ClaimDesk',
        },
      };
      if (existsSync(join(HERE, 'icon.ico'))) details.icon = join(HERE, 'icon.ico');
      await (rcedit.rcedit ?? rcedit)(EXE, details);
      rmSync(tmp, { recursive: true, force: true });
      console.log(`  file details: ${PUBLISHER} · ClaimDesk ${VERSION} (file version ${VERSION}.0)`);
    } catch (e) {
      const msg = `file details and icon not applied: ${e instanceof Error ? e.message : e}`;
      // CI checks the exe's VersionInfo after installing, so a missing publisher must fail the build there.
      if (process.env.CI) fail(msg);
      warn(`${msg} — the program still works`);
    }
  }
  const postject = ['--yes', 'postject@1.0.0-alpha.6', EXE, 'NODE_SEA_BLOB', join(HERE, 'sea-prep.blob'), '--sentinel-fuse', FUSE];
  if (process.platform === 'darwin') postject.push('--macho-segment-name', 'NODE_SEA');
  execFileSync('npx', WIN ? postject.map(shellArg) : postject, { stdio: 'inherit', shell: WIN });
  rmSync(join(HERE, 'sea-prep.blob'), { force: true });
}

step('Done');
console.log(`  ${OUT}  (${Math.round(dirSize(OUT) / 1048576)} MB) — ClaimDesk ${VERSION} (${versionInfo.commit.slice(0, 12)})`);
