/**
 * Security review of the sign-in (session mode): every registered /api route outside the public list refuses an
 * unauthenticated request, the login rate limit holds under a parallel burst and a key-eviction flood, and CORS stays
 * localhost-only with credentials.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { isPublicApiRoute, PUBLIC_API_ROUTES } from '../app.js';
import { DEFAULT_LOGIN } from '../config.js';
import { ensureDefaultLogin, LoginRateLimiter, SESSION_COOKIE } from '../services/auth.js';
import { createTestApp, type TestApp } from './helpers.js';

const T0 = '2026-10-05T09:00:00.000Z';

interface RouteEntry {
  method: string;
  path: string;
}

/**
 * Rebuild the full route list from `app.printRoutes({ commonPrefix: false })`. The print is a radix tree: each line is
 * `<indent><├──|└──> <segment> (METHOD, …)` with 4 characters of indent per level, and a child's segment is appended
 * to its parent's verbatim ("/api/auth/login" + "-defaults"). Lines without methods are prefix-only nodes.
 */
export function parseRouteTree(tree: string): RouteEntry[] {
  const out: RouteEntry[] = [];
  const stack: string[] = [];
  for (const line of tree.split('\n')) {
    const m = /^(.*?)[├└]── (.+)$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    if (!Number.isInteger(depth)) throw new Error(`unexpected indentation in route tree: ${JSON.stringify(line)}`);
    const node = /^(\S+?)(?: \(([A-Z, ]+)\))?$/.exec(m[2]!);
    if (!node) throw new Error(`unexpected route tree line: ${JSON.stringify(line)}`);
    stack.length = depth;
    const full = stack.join('') + node[1]!;
    stack.push(node[1]!);
    for (const method of (node[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) out.push({ method, path: full });
  }
  return out;
}

/** A concrete URL for a route pattern: every :param and * becomes a harmless placeholder. */
const concrete = (pattern: string) => pattern.replace(/:[A-Za-z0-9_]+/g, 'probe-id').replace(/\*/g, 'probe');

let t: TestApp;

afterEach(async () => {
  await t?.close();
});

describe('every non-public /api route requires a session', () => {
  let routes: RouteEntry[];

  beforeEach(async () => {
    t = await createTestApp(T0, { config: { authMode: 'session' } });
    await ensureDefaultLogin(t.ctx);
    routes = parseRouteTree(t.app.printRoutes({ commonPrefix: false }));
  });

  it('the route tree parses into the full route table (guards the walk below against vacuous success)', () => {
    const keys = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const k of ['GET /api/health', 'GET /api/auth/login-defaults', 'POST /api/auth/login', 'POST /api/auth/change-password', 'GET /api/claims/:id/estimates', 'DELETE /api/claims/:id/ledger/:entryId', 'POST /api/documents/:id/sign/verify', 'POST /api/jobs/run', 'GET /api/users', 'PATCH /api/settings']) {
      expect(keys, k).toContain(k);
    }
    expect(routes.length).toBeGreaterThan(150);
    // Every public route in the allow-list really exists (no stale entries that could later match something new).
    for (const p of PUBLIC_API_ROUTES) expect(routes.some((r) => r.path === p), p).toBe(true);
    // Nothing is registered outside /api except the CORS preflight catch-all (the built web app is not present in tests).
    expect(routes.filter((r) => !r.path.startsWith('/api')).map((r) => `${r.method} ${r.path}`)).toEqual(['OPTIONS *']);
  });

  it('401 UNAUTHENTICATED for every protected route: no cookie, a forged cookie, or X-User-Id', async () => {
    // The signing kiosk (/api/kiosk/*, SUPREME-AUTOPILOT §E.2) is a public prefix: it authenticates with its own one-pack token.
    const protectedRoutes = routes.filter((r) => r.path.startsWith('/api') && !isPublicApiRoute(r.path));
    expect(protectedRoutes.length).toBeGreaterThan(140);
    const variants: Array<{ label: string; headers: Record<string, string> }> = [
      { label: 'no cookie', headers: {} },
      { label: 'forged cookie', headers: { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` } },
      { label: 'X-User-Id', headers: { 'x-user-id': DEFAULT_LOGIN.id } },
    ];
    const leaks: string[] = [];
    for (const r of protectedRoutes) {
      for (const v of variants) {
        const opts: InjectOptions = { method: r.method as InjectOptions['method'], url: concrete(r.path), headers: { ...v.headers } };
        if (!['GET', 'HEAD', 'DELETE'].includes(r.method)) opts.payload = {};
        const res = await t.app.inject(opts);
        const code = r.method === 'HEAD' ? 'UNAUTHENTICATED' : (res.json() as { error?: { code?: string } }).error?.code;
        if (res.statusCode !== 401 || code !== 'UNAUTHENTICATED') leaks.push(`${r.method} ${r.path} [${v.label}] → ${res.statusCode} ${code}`);
      }
    }
    expect(leaks).toEqual([]);
    // Nothing a protected handler would have written got written.
    expect(t.ctx.handle.sqlite.prepare("select count(*) as n from audit_log where action not like 'auth.%'").get()).toEqual({ n: 0 });
  });

  it('the public list answers without a session (and only it)', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/login-defaults' })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} })).json().error.code).toBe('VALIDATION');
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(me.statusCode).toBe(401); // public route, but the handler itself says "not signed in"
    expect(me.json().error.code).toBe('UNAUTHENTICATED');
    expect([...PUBLIC_API_ROUTES].sort()).toEqual(['/api/auth/login', '/api/auth/login-defaults', '/api/auth/logout', '/api/auth/me', '/api/health']);
  });
});

describe('login rate limit under attack', () => {
  beforeEach(async () => {
    t = await createTestApp(T0, { config: { authMode: 'session' } });
    await ensureDefaultLogin(t.ctx);
  });

  const attempt = (password: string, username: string = DEFAULT_LOGIN.username) => t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });

  it('a parallel burst gets at most 10 password checks; the rest are 429 before any hashing', async () => {
    const res = await Promise.all(Array.from({ length: 40 }, (_, i) => attempt(`wrong-${i}`)));
    const byStatus = res.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.statusCode]: (acc[r.statusCode] ?? 0) + 1 }), {});
    expect(byStatus).toEqual({ 401: 10, 429: 30 });
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'auth.login_failed' })).toHaveLength(10);
    // Mixed-case / padded variants of the username share the same key, so they are locked too.
    expect((await attempt(DEFAULT_LOGIN.password, '  CourtesyCars ')).statusCode).toBe(429);
  });

  it('a correct password still signs in after a few failures, and clears the count', async () => {
    for (let i = 0; i < 9; i += 1) expect((await attempt(`wrong-${i}`)).statusCode).toBe(401);
    expect((await attempt(DEFAULT_LOGIN.password)).statusCode).toBe(200);
    for (let i = 0; i < 10; i += 1) expect((await attempt(`wrong-again-${i}`)).statusCode).toBe(401);
    expect((await attempt(DEFAULT_LOGIN.password)).statusCode).toBe(429);
  });

  it('change-password: a parallel burst of wrong current passwords is limited too', async () => {
    const login = await attempt(DEFAULT_LOGIN.password);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const res = await Promise.all(
      Array.from({ length: 25 }, (_, i) => t.app.inject({ method: 'POST', url: '/api/auth/change-password', headers: { cookie }, payload: { currentPassword: `not-it-${i}`, newPassword: 'Another long passphrase 9' } })),
    );
    const codes = res.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 400)).toHaveLength(10);
    expect(codes.filter((c) => c === 429)).toHaveLength(15);
  });
});

describe('LoginRateLimiter eviction', () => {
  it('a flood of fresh keys cannot evict a locked-out key (which would reset its count)', () => {
    t = undefined as unknown as TestApp;
    const rl = new LoginRateLimiter({ maxFailures: 3, windowMs: 60_000, maxKeys: 50 });
    const victim = LoginRateLimiter.key('courtesycars', '198.51.100.9');
    for (let i = 0; i < 3; i += 1) rl.recordFailure(victim, i);
    expect(rl.retryAfterMs(victim, 10)).toBeGreaterThan(0);
    for (let i = 0; i < 5_000; i += 1) rl.recordFailure(LoginRateLimiter.key(`junk-${i}`, '198.51.100.9'), 20 + i);
    expect(rl.size).toBeLessThanOrEqual(50);
    expect(rl.retryAfterMs(victim, 6_000)).toBeGreaterThan(0); // still locked
  });

  it('when every key is locked, the oldest goes first and memory stays bounded', () => {
    t = undefined as unknown as TestApp;
    const rl = new LoginRateLimiter({ maxFailures: 1, windowMs: 60_000, maxKeys: 5 });
    for (let i = 0; i < 12; i += 1) rl.recordFailure(`k${i}`, i);
    expect(rl.size).toBe(5);
    expect(rl.retryAfterMs('k11', 20)).toBeGreaterThan(0);
    expect(rl.retryAfterMs('k0', 20)).toBe(0);
  });
});

describe('CORS in session mode', () => {
  beforeEach(async () => {
    t = await createTestApp(T0, { config: { authMode: 'session' } });
  });

  it('a localhost origin gets credentials (even on the 401); any other origin gets no CORS grant', async () => {
    const local = await t.app.inject({ method: 'GET', url: '/api/claims', headers: { origin: 'http://localhost:5173' } });
    expect(local.statusCode).toBe(401);
    expect(local.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(local.headers['access-control-allow-credentials']).toBe('true');
    for (const origin of ['https://evil.example', 'http://localhost.evil.example', 'null']) {
      const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'courtesycars', password: 'x' } });
      expect(res.headers['access-control-allow-origin'], origin).toBeUndefined();
    }
    const preflight = await t.app.inject({ method: 'OPTIONS', url: '/api/auth/login', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });
});
