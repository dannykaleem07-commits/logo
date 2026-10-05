/**
 * Update check (docs/V03-MANAGER-MODE-HIRE-PRICING.md §F.3) and backup-before-migrate in buildContext (§F.2.2).
 * The releases list is served by an injected fetch or a local http stub — never GitHub.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as db from '@ccguk/db';
import { testConfig } from '../config.js';
import { buildContext, silentLogger, type AppContext, type Logger } from '../context.js';
import { appVersion } from '../routes/health.js';
import { ensureDefaultLogin } from '../services/auth.js';
import { checkForUpdates, compareVersions, parseClaimDeskTag, updatesServiceFor, UPDATE_CACHE_MS, UPDATE_RETRY_MS } from '../services/updates.js';
import { createTestApp, type TestApp } from './helpers.js';

const T0 = '2026-10-05T09:00:00.000Z';
const SHA = 'ab'.repeat(32);

function release(tag: string, extra: Record<string, unknown> = {}) {
  const version = parseClaimDeskTag(tag) ?? 'x';
  return {
    tag_name: tag,
    name: `ClaimDesk ${version}`,
    draft: false,
    prerelease: false,
    published_at: '2026-10-12T10:00:00Z',
    html_url: `https://github.com/dannykaleem07-commits/logo/releases/tag/${tag}`,
    body: `**What's new in ${version}**`,
    assets: [
      { name: `ClaimDesk-Setup-${version}.exe`, browser_download_url: `https://example.test/${tag}/ClaimDesk-Setup-${version}.exe`, size: 44_040_192, digest: `sha256:${SHA}` },
      { name: `ClaimDesk-${version}-win-x64.zip`, browser_download_url: `https://example.test/${tag}/portable.zip`, size: 10 },
    ],
    ...extra,
  };
}

/** A fetch that answers with `body` (JSON-encoded unless a string) and records each call. */
function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

const now = () => T0;

describe('parseClaimDeskTag and compareVersions', () => {
  it('parses ClaimDesk tags only', () => {
    expect(parseClaimDeskTag('claimdesk-v0.3.12')).toBe('0.3.12');
    expect(parseClaimDeskTag('claimdesk-v1.0')).toBe('1.0');
    expect(parseClaimDeskTag('callpilot-latest')).toBeUndefined();
    expect(parseClaimDeskTag('claimdesk-latest')).toBeUndefined();
    expect(parseClaimDeskTag('v0.3.1')).toBeUndefined();
    expect(parseClaimDeskTag('claimdesk-v0.3.1-beta')).toBeUndefined();
  });

  it('compares numerically per part', () => {
    expect(compareVersions('0.3.10', '0.3.9')).toBe(1);
    expect(compareVersions('0.2.6', '0.3.0')).toBe(-1);
    expect(compareVersions('0.3', '0.3.0')).toBe(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.3.0-dev', '0.3.0')).toBe(0);
  });
});

describe('checkForUpdates', () => {
  it('reports a newer release with its Setup asset url, size and sha256 from the digest', async () => {
    const f = fakeFetch([release('claimdesk-v0.3.15')]);
    const r = await checkForUpdates({ current: '0.3.12', url: 'https://stub/releases', fetchImpl: f.impl, now });
    expect(r).toMatchObject({
      status: 'ok',
      current: '0.3.12',
      latest: '0.3.15',
      updateAvailable: true,
      checkedAt: T0,
      release: { tag: 'claimdesk-v0.3.15', name: 'ClaimDesk 0.3.15', publishedAt: '2026-10-12T10:00:00Z', notes: "**What's new in 0.3.15**" },
      download: { name: 'ClaimDesk-Setup-0.3.15.exe', url: 'https://example.test/claimdesk-v0.3.15/ClaimDesk-Setup-0.3.15.exe', size: 44_040_192, sha256: SHA },
    });
    expect(f.calls[0]!.url).toBe('https://stub/releases');
    expect(f.calls[0]!.headers).toMatchObject({ Accept: 'application/vnd.github+json', 'User-Agent': 'ClaimDesk/0.3.12' });
  });

  it('is up to date when the newest release is the installed one', async () => {
    const r = await checkForUpdates({ current: '0.3.15', url: 'u', fetchImpl: fakeFetch([release('claimdesk-v0.3.15')]).impl, now });
    expect(r).toMatchObject({ status: 'ok', latest: '0.3.15', updateAvailable: false });
  });

  it('includes prereleases, skips drafts and other products, and the highest version wins', async () => {
    const list = [
      release('callpilot-latest', { name: 'CallPilot' }),
      release('claimdesk-v0.2.6', { prerelease: true }),
      release('claimdesk-v0.3.9', { prerelease: true }),
      release('claimdesk-v0.4.0', { draft: true }),
      release('claimdesk-v0.3.10', { prerelease: true }),
      release('claimdesk-v0.3.2'),
    ];
    const r = await checkForUpdates({ current: '0.2.6', url: 'u', fetchImpl: fakeFetch(list).impl, now });
    expect(r).toMatchObject({ status: 'ok', latest: '0.3.10', updateAvailable: true, release: { tag: 'claimdesk-v0.3.10' } });
  });

  it('ignores non-ClaimDesk tags entirely', async () => {
    const r = await checkForUpdates({ current: '0.3.0', url: 'u', fetchImpl: fakeFetch([release('callpilot-latest'), release('callpilot-v9.9.9')]).impl, now });
    expect(r).toMatchObject({ status: 'ok', updateAvailable: false });
    expect(r.latest).toBeUndefined();
  });

  it('caps the release notes and copes with a release without a Setup asset or digest', async () => {
    const r = await checkForUpdates({
      current: '0.3.0',
      url: 'u',
      fetchImpl: fakeFetch([release('claimdesk-v0.3.1', { body: 'x'.repeat(9000), assets: [{ name: 'ClaimDesk-Setup-0.3.1.exe', browser_download_url: 'https://e/x.exe' }] })]).impl,
      now,
    });
    expect(r.release!.notes!.length).toBe(4000);
    expect(r.download).toEqual({ name: 'ClaimDesk-Setup-0.3.1.exe', url: 'https://e/x.exe' });
    const none = await checkForUpdates({ current: '0.3.0', url: 'u', fetchImpl: fakeFetch([release('claimdesk-v0.3.1', { assets: [] })]).impl, now });
    expect(none).toMatchObject({ status: 'ok', updateAvailable: true });
    expect(none.download).toBeUndefined();
  });

  it('a network failure is offline, a timeout is offline, never a throw', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(checkForUpdates({ current: '0.3.0', url: 'u', fetchImpl: failing, now })).resolves.toMatchObject({ status: 'offline', updateAvailable: false, current: '0.3.0' });
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    await expect(checkForUpdates({ current: '0.3.0', url: 'u', fetchImpl: hanging, timeoutMs: 30, now })).resolves.toMatchObject({ status: 'offline' });
  });

  it('bad JSON, a non-list and a non-200 answer are errors', async () => {
    await expect(checkForUpdates({ current: '0.3.0', url: 'u', fetchImpl: fakeFetch('<html>not json').impl, now })).resolves.toMatchObject({ status: 'error', updateAvailable: false });
    await expect(checkForUpdates({ current: '0.3.0', url: 'u', fetchImpl: fakeFetch({ message: 'x' }).impl, now })).resolves.toMatchObject({ status: 'error' });
    await expect(checkForUpdates({ current: '0.3.0', url: 'u', fetchImpl: fakeFetch({ message: 'API rate limit exceeded' }, 403).impl, now })).resolves.toMatchObject({ status: 'error', message: expect.stringContaining('403') });
  });
});

describe('updatesServiceFor', () => {
  let t: TestApp;
  afterEach(async () => {
    await t?.close();
  });

  it('CLAIMDESK_UPDATE_CHECK=off → disabled without any request', async () => {
    t = await createTestApp(T0);
    const f = fakeFetch([release('claimdesk-v9.0.0')]);
    const r = await updatesServiceFor(t.ctx, { fetchImpl: f.impl, env: { CLAIMDESK_UPDATE_CHECK: 'off', CLAIMDESK_VERSION: '0.3.0' } }).check(true);
    expect(r).toMatchObject({ status: 'disabled', current: '0.3.0', updateAvailable: false });
    expect(f.calls).toHaveLength(0);
  });

  it('answers from the 1 h cache; force re-checks, but at most once a minute', async () => {
    t = await createTestApp(T0);
    const f = fakeFetch([release('claimdesk-v0.3.15')]);
    const env = { CLAIMDESK_VERSION: '0.3.12', CLAIMDESK_UPDATE_URL: 'https://stub/releases' };
    const svc = updatesServiceFor(t.ctx, { fetchImpl: f.impl, env });
    expect((await svc.check()).updateAvailable).toBe(true);
    expect(f.calls[0]!.url).toBe('https://stub/releases');
    await svc.check();
    t.setNow('2026-10-05T09:30:00.000Z');
    await svc.check();
    expect(f.calls).toHaveLength(1);
    // forced, but the last network check was 30 minutes ago → goes out
    await svc.check(true);
    expect(f.calls).toHaveLength(2);
    // forced again 20 s later → cached
    t.setNow('2026-10-05T09:30:20.000Z');
    await svc.check(true);
    expect(f.calls).toHaveLength(2);
    // a minute later → goes out
    t.setNow('2026-10-05T09:31:30.000Z');
    await svc.check(true);
    expect(f.calls).toHaveLength(3);
    // the cache expires after an hour
    t.setNow(new Date(Date.parse('2026-10-05T09:31:30.000Z') + UPDATE_CACHE_MS + 1000).toISOString());
    await svc.check();
    expect(f.calls).toHaveLength(4);
  });

  it('an offline answer is kept for 5 minutes only, then checked again', async () => {
    t = await createTestApp(T0);
    let online = false;
    const calls: string[] = [];
    const impl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      if (!online) throw new TypeError('fetch failed');
      return new Response(JSON.stringify([release('claimdesk-v0.3.15')]), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const svc = updatesServiceFor(t.ctx, { fetchImpl: impl, env: { CLAIMDESK_VERSION: '0.3.12' } });
    expect((await svc.check()).status).toBe('offline');
    online = true;
    t.setNow('2026-10-05T09:04:00.000Z');
    expect((await svc.check()).status).toBe('offline'); // still inside the 5 minutes
    expect(calls).toHaveLength(1);
    t.setNow(new Date(Date.parse(T0) + UPDATE_RETRY_MS + 1000).toISOString());
    const r = await svc.check();
    expect(r).toMatchObject({ status: 'ok', updateAvailable: true, latest: '0.3.15' });
    expect(calls).toHaveLength(2);
  });

  it('concurrent checks share one request, and the cache belongs to the app context', async () => {
    t = await createTestApp(T0);
    const f = fakeFetch([release('claimdesk-v0.3.15')]);
    const env = { CLAIMDESK_VERSION: '0.3.12' };
    const a = updatesServiceFor(t.ctx, { fetchImpl: f.impl, env });
    const b = updatesServiceFor(t.ctx, { fetchImpl: f.impl, env });
    await Promise.all([a.check(), b.check(), a.check()]);
    expect(f.calls).toHaveLength(1);
    const other = await createTestApp(T0);
    try {
      await updatesServiceFor(other.ctx, { fetchImpl: f.impl, env }).check();
      expect(f.calls).toHaveLength(2);
    } finally {
      await other.close();
    }
  });
});

describe('GET /api/updates/check against a local stub server', () => {
  let server: Server;
  let base: string;
  let hits = 0;
  let mode: 'ok' | 'bad' = 'ok';
  const saved = { url: process.env.CLAIMDESK_UPDATE_URL, check: process.env.CLAIMDESK_UPDATE_CHECK, version: process.env.CLAIMDESK_VERSION };
  let t: TestApp;

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits += 1;
      if (req.url?.startsWith('/releases')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(mode === 'ok' ? JSON.stringify([release('callpilot-latest'), release('claimdesk-v0.3.99', { prerelease: true }), release('claimdesk-v0.3.1')]) : '{not json');
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    await t?.close();
    for (const [key, value] of [
      ['CLAIMDESK_UPDATE_URL', saved.url],
      ['CLAIMDESK_UPDATE_CHECK', saved.check],
      ['CLAIMDESK_VERSION', saved.version],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('a signed-in user sees the newer version; force=1 goes back to the server; the stub down is offline', async () => {
    process.env.CLAIMDESK_UPDATE_URL = `${base}/releases?per_page=30`;
    process.env.CLAIMDESK_VERSION = '0.3.4';
    delete process.env.CLAIMDESK_UPDATE_CHECK;
    hits = 0;
    mode = 'ok';
    t = await createTestApp(T0);
    const first = await t.api<Record<string, unknown>>('GET', '/updates/check');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'ok', current: '0.3.4', latest: '0.3.99', updateAvailable: true, download: { name: 'ClaimDesk-Setup-0.3.99.exe', sha256: SHA } });
    await t.api('GET', '/updates/check');
    expect(hits).toBe(1);

    mode = 'bad';
    t.setNow('2026-10-05T09:05:00.000Z');
    const forced = await t.api<Record<string, unknown>>('GET', '/updates/check?force=1');
    expect(hits).toBe(2);
    expect(forced.body).toMatchObject({ status: 'error', updateAvailable: false });

    // nothing listening on the port any more → offline, still 200
    process.env.CLAIMDESK_UPDATE_URL = 'http://127.0.0.1:9/releases';
    t.setNow('2026-10-05T09:10:00.000Z');
    const offline = await t.api<Record<string, unknown>>('GET', '/updates/check?force=1');
    expect(offline.status).toBe(200);
    expect(offline.body).toMatchObject({ status: 'offline', current: '0.3.4', updateAvailable: false });
  });

  it('CLAIMDESK_UPDATE_CHECK=off → disabled', async () => {
    process.env.CLAIMDESK_UPDATE_URL = `${base}/releases`;
    process.env.CLAIMDESK_UPDATE_CHECK = 'off';
    hits = 0;
    t = await createTestApp(T0);
    const r = await t.api<Record<string, unknown>>('GET', '/updates/check?force=1');
    expect(r.body).toMatchObject({ status: 'disabled', updateAvailable: false });
    expect(hits).toBe(0);
  });

  it('needs a session in session mode', async () => {
    process.env.CLAIMDESK_UPDATE_URL = `${base}/releases`;
    mode = 'ok';
    t = await createTestApp(T0, { config: { authMode: 'session' } });
    await ensureDefaultLogin(t.ctx);
    const anon = await t.app.inject({ method: 'GET', url: '/api/updates/check' });
    expect(anon.statusCode).toBe(401);
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'courtesycars', password: 'CourtesyCars123!' } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const ok = await t.app.inject({ method: 'GET', url: '/api/updates/check', headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ status: 'ok', current: appVersion() });
  });
});

describe('buildContext backs the database up before migrating (§F.2.2)', () => {
  const dirs: string[] = [];
  const contexts: AppContext[] = [];
  afterEach(() => {
    for (const c of contexts.splice(0)) c.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A file database as 0.2.6 left it (journal idx ≤ 5). */
  function database026(): { dataDir: string; file: string } {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'claimdesk-ctx-backup-'));
    dirs.push(dataDir);
    const folder = path.join(dataDir, 'mig026');
    mkdirSync(path.join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(path.join(db.migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
    const kept = journal.entries.filter((e) => e.idx <= 5);
    writeFileSync(path.join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }));
    for (const e of kept) copyFileSync(path.join(db.migrationsFolder, `${e.tag}.sql`), path.join(folder, `${e.tag}.sql`));
    const file = path.join(dataDir, 'data', 'claimdesk.sqlite');
    mkdirSync(path.dirname(file), { recursive: true });
    const h = db.createDatabase({ path: file });
    db.runMigrations(h.db, { migrationsFolder: folder });
    db.closeDatabase(h);
    return { dataDir, file };
  }

  function capture(): { logger: Logger; logs: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> } {
    const logs: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> = [];
    return {
      logs,
      logger: {
        info: (msg, meta) => logs.push({ level: 'info', msg, meta }),
        warn: (msg, meta) => logs.push({ level: 'warn', msg, meta }),
        error: (msg, meta) => logs.push({ level: 'error', msg, meta }),
      },
    };
  }

  it('writes data/backups/claimdesk-before-<version>-<stamp>.sqlite once, then not on the next start', () => {
    const { file } = database026();
    const cap = capture();
    const ctx = buildContext({ config: testConfig({ databasePath: file }), logger: cap.logger, now: () => T0 });
    contexts.push(ctx);
    const backups = path.join(path.dirname(file), 'backups');
    const made = readdirSync(backups);
    expect(made).toHaveLength(1);
    const escaped = appVersion().replace(/\./g, '\\.');
    expect(made[0]).toMatch(new RegExp(`^claimdesk-before-${escaped}-\\d{8}-\\d{6}\\.sqlite$`));
    expect(cap.logs.some((l) => l.level === 'info' && l.msg.includes('backed up'))).toBe(true);
    expect(db.pendingMigrationCount(ctx.handle)).toBe(0);
    ctx.close();
    contexts.pop();

    const again = buildContext({ config: testConfig({ databasePath: file }), logger: silentLogger, now: () => T0 });
    contexts.push(again);
    expect(readdirSync(backups)).toEqual(made);
  });

  it('a new database is not backed up, and a failed backup is a warning — the start carries on', () => {
    const fresh = mkdtempSync(path.join(os.tmpdir(), 'claimdesk-ctx-new-'));
    dirs.push(fresh);
    const ctxNew = buildContext({ config: testConfig({ databasePath: path.join(fresh, 'claimdesk.sqlite') }), logger: silentLogger });
    contexts.push(ctxNew);
    expect(existsSync(path.join(fresh, 'backups'))).toBe(false);

    const { file } = database026();
    // a plain file where the backups folder should be → the backup cannot be written
    writeFileSync(path.join(path.dirname(file), 'backups'), 'not a folder');
    const cap = capture();
    const ctx = buildContext({ config: testConfig({ databasePath: file }), logger: cap.logger });
    contexts.push(ctx);
    expect(cap.logs.some((l) => l.level === 'warn' && l.msg.includes('backup'))).toBe(true);
    expect(db.pendingMigrationCount(ctx.handle)).toBe(0);
    expect(ctx.settings().companyName).toBe('Courtesy Cars Group UK Ltd');
  });
});
