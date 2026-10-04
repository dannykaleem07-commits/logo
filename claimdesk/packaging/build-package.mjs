#!/usr/bin/env node
// Builds the portable ClaimDesk folder:
//   ClaimDesk/ClaimDesk.exe        Node single-executable app (the launcher)
//   ClaimDesk/app/...              the API source, built web app and node_modules (real files, no links)
//   ClaimDesk/Start with example claims.cmd, README.txt
// Requirements: run after `pnpm install --config.node-linker=hoisted` (flat node_modules) and the web build.
// Usage: node packaging/build-package.mjs [--out <dir>] [--no-exe]
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync, lstatSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = outArg >= 0 ? args[outArg + 1] : join(HERE, 'dist', 'ClaimDesk');
const APP = join(OUT, 'app');
const WIN = process.platform === 'win32';
const EXE = join(OUT, WIN ? 'ClaimDesk.exe' : 'ClaimDesk');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function step(msg) { console.log(`\n▶ ${msg}`); }
function fail(msg) { console.error(`✖ ${msg}`); process.exit(1); }

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

step('Checking the build inputs');
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
for (const pkg of readdirSync(join(ROOT, 'packages'))) {
  for (const part of ['package.json', 'tsconfig.json', 'src', 'data', 'assets', 'drizzle', 'node_modules']) copy(`packages/${pkg}/${part}`, { optional: true });
}
copy('node_modules');
copyFileSync(join(HERE, 'launch.cjs'), join(APP, 'launch.cjs'));
// docs the owner may want next to the program
mkdirSync(join(OUT, 'docs'), { recursive: true });
for (const d of ['README.md']) copyFileSync(join(ROOT, d), join(OUT, 'docs', d));
for (const d of ['SETUP-APIS.md', 'LEGAL-CAVEATS.md', 'RESEARCH-CORRECTIONS.md', 'KNOWN-ISSUES.md']) if (existsSync(join(ROOT, 'docs', d))) copyFileSync(join(ROOT, 'docs', d), join(OUT, 'docs', d));

writeFileSync(join(OUT, 'README.txt'), [
  'ClaimDesk — Courtesy Cars Group UK Ltd',
  '',
  'START: double-click ClaimDesk.exe. A window opens (keep it open) and your browser opens ClaimDesk.',
  'Sign in: username courtesycars, password CourtesyCars123! (both are filled in for you).',
  'Change the password in Settings before you put real claims in: this password is published.',
  '',
  'To look around with four example claims first, double-click "Start with example claims.cmd".',
  'Example claims are kept separately from your real data.',
  '',
  'Your data is stored in %LOCALAPPDATA%\\ClaimDesk\\data (examples in ...\\demo).',
  'API keys (DVLA, DVSA, Companies House) go in %LOCALAPPDATA%\\ClaimDesk\\claimdesk.env.',
  'PDFs are produced with Microsoft Edge, which every Windows 10/11 PC already has.',
  '',
  'Windows may say "Windows protected your PC" the first time because the program is not code-signed.',
  'Click "More info" then "Run anyway".',
  '',
  'To stop ClaimDesk, close its window.',
  '',
].join('\r\n'));
writeFileSync(join(OUT, 'Start with example claims.cmd'), '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0ClaimDesk.exe" --demo\r\n');

if (!args.includes('--no-exe')) {
  step('Building the single executable (Node SEA)');
  execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: HERE, stdio: 'inherit' });
  copyFileSync(process.execPath, EXE);
  if (WIN && existsSync(join(HERE, 'icon.ico'))) {
    try {
      // rcedit (Electron's resource editor) sets the icon and file details before the app is injected.
      const tmp = join(HERE, '.rcedit');
      execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', tmp, 'rcedit@4.0.1'], { stdio: 'inherit', shell: true });
      const rcedit = createRequire(join(tmp, 'package.json'))('rcedit');
      await (rcedit.rcedit ?? rcedit)(EXE, {
        icon: join(HERE, 'icon.ico'),
        'version-string': { ProductName: 'ClaimDesk', FileDescription: 'ClaimDesk - Courtesy Cars Group UK Ltd', CompanyName: 'Courtesy Cars Group UK Ltd', LegalCopyright: 'Courtesy Cars Group UK Ltd' },
      });
      rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      console.warn(`  (icon not applied: ${e instanceof Error ? e.message : e} — the program still works)`);
    }
  }
  const postject = ['--yes', 'postject@1.0.0-alpha.6', EXE, 'NODE_SEA_BLOB', join(HERE, 'sea-prep.blob'), '--sentinel-fuse', FUSE];
  if (process.platform === 'darwin') postject.push('--macho-segment-name', 'NODE_SEA');
  execFileSync('npx', postject, { stdio: 'inherit', shell: WIN });
  rmSync(join(HERE, 'sea-prep.blob'), { force: true });
}

step('Done');
console.log(`  ${OUT}  (${Math.round(dirSize(OUT) / 1048576)} MB)`);
