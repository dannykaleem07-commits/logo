import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { Claim } from '@ccguk/domain';
import { DEFAULT_LOGIN } from '../config.js';
import type { Logger } from '../context.js';
import {
  clearSessionCookie,
  ensureDefaultLogin,
  hashPassword,
  hashSessionToken,
  LoginRateLimiter,
  parseCookieHeader,
  readSessionToken,
  SESSION_COOKIE,
  sessionCookie,
  verifyPassword,
} from '../services/auth.js';
import { createTestApp, FNOL, type TestApp, type TestAppOptions } from './helpers.js';

const PASSWORD = DEFAULT_LOGIN.password; // "CourtesyCars123!"
const NEW_PASSWORD = 'Brand-new passphrase 42';
const T0 = '2026-10-05T09:00:00.000Z';

interface Captured {
  logs: string[];
  logger: Logger;
  options: TestAppOptions;
}

/** Captures both the AppContext logger and Fastify's request logger. */
function capture(config: TestAppOptions['config'] = {}): Captured {
  const logs: string[] = [];
  const logger: Logger = {
    info: (msg, meta) => logs.push(JSON.stringify({ level: 'info', msg, ...meta })),
    warn: (msg, meta) => logs.push(JSON.stringify({ level: 'warn', msg, ...meta })),
    error: (msg, meta) => logs.push(JSON.stringify({ level: 'error', msg, ...meta })),
  };
  return {
    logs,
    logger,
    options: { config: { authMode: 'session', ...config }, logger, appLogger: { level: 'trace', stream: { write: (line: string) => void logs.push(line) } } },
  };
}

let t: TestApp;
let cap: Captured;

async function sessionApp(config: TestAppOptions['config'] = {}, now = T0): Promise<TestApp> {
  cap = capture(config);
  const app = await createTestApp(now, cap.options);
  await ensureDefaultLogin(app.ctx);
  return app;
}

function inject(method: InjectOptions['method'], url: string, opts: { payload?: unknown; cookie?: string; headers?: Record<string, string>; remoteAddress?: string } = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  return t.app.inject({ method, url: `/api${url}`, payload: opts.payload as InjectOptions['payload'], headers, remoteAddress: opts.remoteAddress });
}

function setCookieOf(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' ? v : '';
}

/** "claimdesk_session=<token>" from a login response, ready to send back as a Cookie header. */
function cookieFrom(res: LightMyRequestResponse): { cookie: string; token: string } {
  const sc = setCookieOf(res);
  const token = sc.split(';')[0]!.split('=')[1]!;
  return { cookie: `${SESSION_COOKIE}=${token}`, token };
}

async function login(username: string = DEFAULT_LOGIN.username, password: string = PASSWORD, remoteAddress?: string): Promise<LightMyRequestResponse> {
  return inject('POST', '/auth/login', { payload: { username, password }, remoteAddress });
}

async function signIn(): Promise<{ cookie: string; token: string }> {
  const res = await login();
  expect(res.statusCode).toBe(200);
  return cookieFrom(res);
}

afterEach(async () => {
  await t?.close();
});

describe('password hashing and cookie helpers', () => {
  it('hashes with scrypt N=16384 r=8 p=1, a 16-byte random salt and a 64-byte key; verifies in constant time', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    const m = /^scrypt\$16384\$8\$1\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(a);
    expect(m).not.toBeNull();
    expect(Buffer.from(m![1]!, 'base64')).toHaveLength(16);
    expect(Buffer.from(m![2]!, 'base64')).toHaveLength(64);
    expect(a).not.toBe(b); // random salt
    expect(a).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD, b)).toBe(true);
    expect(await verifyPassword('courtesycars123!', a)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'not-a-hash')).toBe(false);
    expect(await verifyPassword(PASSWORD, 'scrypt$3$8$1$c2FsdA==$aGFzaA==')).toBe(false); // N not a sane power of two
  });

  it('parses the Cookie header by hand and only accepts a well-formed token', () => {
    const token = 'A'.repeat(43);
    expect(parseCookieHeader('a=1; claimdesk_session=xyz; b="q"')).toEqual(new Map([['a', '1'], ['claimdesk_session', 'xyz'], ['b', 'q']]));
    expect(readSessionToken(`theme=dark; ${SESSION_COOKIE}=${token}`)).toBe(token);
    expect(readSessionToken(`${SESSION_COOKIE}=short`)).toBeUndefined();
    expect(readSessionToken(`${SESSION_COOKIE}=${token}'; DROP`)).toBeUndefined();
    expect(readSessionToken(undefined)).toBeUndefined();
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionCookie(token, 43200, { secure: false })).toBe(`${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
    expect(sessionCookie(token, 43200, { secure: true })).toBe(`${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200; Secure`);
    expect(clearSessionCookie({ secure: false })).toBe(`${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  });

  it('rate limiter: sliding window per key, bounded memory', () => {
    const rl = new LoginRateLimiter({ maxFailures: 3, windowMs: 1000, maxKeys: 5 });
    const k = LoginRateLimiter.key('u', '1.2.3.4');
    expect(rl.retryAfterMs(k, 0)).toBe(0);
    rl.recordFailure(k, 0);
    rl.recordFailure(k, 100);
    rl.recordFailure(k, 200);
    expect(rl.retryAfterMs(k, 300)).toBe(700);
    expect(rl.retryAfterMs(LoginRateLimiter.key('u', '5.6.7.8'), 300)).toBe(0);
    expect(rl.retryAfterMs(k, 1000)).toBe(0); // the first failure aged out
    rl.reset(k);
    expect(rl.retryAfterMs(k, 1000)).toBe(0);
    for (let i = 0; i < 20; i += 1) rl.recordFailure(`k${i}`, 5000);
    expect(rl.size).toBeLessThanOrEqual(5);
  });
});

describe('default sign-in account', () => {
  beforeEach(async () => {
    t = await sessionApp();
  });

  it('is created on boot as courtesycars / Courtesy Cars / claims@courtesycars.net / admin, with a scrypt hash', async () => {
    const u = t.ctx.repos.getUser(t.ctx.db, 'courtesycars');
    expect(u).toMatchObject({ id: 'courtesycars', username: 'courtesycars', name: 'Courtesy Cars', email: 'claims@courtesycars.net', role: 'admin' });
    const hash = t.ctx.repos.getPasswordHash(t.ctx.db, 'courtesycars')!;
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    const raw = t.ctx.handle.sqlite.prepare('select * from users').all();
    expect(JSON.stringify(raw)).not.toContain(PASSWORD);
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'auth.default_login_created' })).toHaveLength(1);
  });

  it('is idempotent and never resets a changed password', async () => {
    const changed = await hashPassword(NEW_PASSWORD);
    t.ctx.repos.setPassword(t.ctx.db, 'courtesycars', changed);
    const again = await ensureDefaultLogin(t.ctx);
    expect(again).toMatchObject({ created: false, userId: 'courtesycars' });
    expect(t.ctx.repos.getPasswordHash(t.ctx.db, 'courtesycars')).toBe(changed);
    expect(t.ctx.repos.listUsers(t.ctx.db).filter((u) => u.username === 'courtesycars')).toHaveLength(1);
  });

  it('GET /users lists the username and never a hash', async () => {
    const { cookie } = await signIn();
    const res = await inject('GET', '/users', { cookie });
    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: Array<Record<string, unknown>> }>().items;
    expect(items.find((u) => u.id === 'courtesycars')).toMatchObject({ username: 'courtesycars', role: 'admin' });
    expect(res.body).not.toContain('scrypt');
    expect(res.body).not.toMatch(/password/i);
  });
});

describe('POST /auth/login and GET /auth/me', () => {
  beforeEach(async () => {
    t = await sessionApp();
  });

  it('sets an HttpOnly, SameSite=Lax, 12-hour session cookie and /auth/me returns the user', async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: 'courtesycars', name: 'Courtesy Cars', username: 'courtesycars', email: 'claims@courtesycars.net', role: 'admin' } });
    const sc = setCookieOf(res);
    expect(sc).toMatch(/^claimdesk_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=43200$/);
    expect(sc).not.toContain('Secure'); // only in production
    expect(res.headers['cache-control']).toBe('no-store');
    const { cookie, token } = cookieFrom(res);
    expect(res.body).not.toContain(token);

    const me = await inject('GET', '/auth/me', { cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      user: { id: 'courtesycars', name: 'Courtesy Cars', username: 'courtesycars', email: 'claims@courtesycars.net', role: 'admin' },
      managerMode: { allowed: true, on: false, idleMinutes: 60, defaultReason: 'Manager override' },
    });

    // The database holds sha256(token), never the token.
    const rows = t.ctx.handle.sqlite.prepare('select * from sessions').all() as Array<{ id: string; expires_at: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(hashSessionToken(token));
    expect(rows[0]!.expires_at).toBe('2026-10-05T21:00:00.000Z');
    expect(JSON.stringify(rows)).not.toContain(token);

    const audit = t.ctx.repos.listAudit(t.ctx.db, { action: 'auth.login' });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: 'courtesycars', entity: 'user', entityId: 'courtesycars' });
  });

  it('compares usernames case-insensitively after trim', async () => {
    expect((await login('  CourtesyCars ', PASSWORD)).statusCode).toBe(200);
    expect((await login('COURTESYCARS', PASSWORD)).statusCode).toBe(200);
  });

  it('answers a wrong password and an unknown user identically: 401 INVALID_CREDENTIALS, no cookie', async () => {
    const wrong = await login('courtesycars', 'CourtesyCars123?');
    const unknown = await login('nobody-here', PASSWORD);
    for (const res of [wrong, unknown]) {
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Username or password is incorrect' });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const failed = t.ctx.repos.listAudit(t.ctx.db, { action: 'auth.login_failed' });
    expect(failed).toHaveLength(2);
    expect(failed.map((a) => (a.after as { username: string }).username).sort()).toEqual(['courtesycars', 'nobody-here']);
    expect(failed.every((a) => a.userId === 'anonymous')).toBe(true);
    // A staff row without a password (the dev "handler") cannot sign in either.
    expect((await login('handler', 'anything at all')).statusCode).toBe(401);
  });

  it('rejects a malformed body with 400 VALIDATION', async () => {
    const res = await inject('POST', '/auth/login', { payload: { username: 'courtesycars' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('/auth/me without a session is 401 UNAUTHENTICATED; a stale cookie is cleared', async () => {
    const none = await inject('GET', '/auth/me');
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('UNAUTHENTICATED');
    const stale = await inject('GET', '/auth/me', { cookie: `${SESSION_COOKIE}=${'B'.repeat(43)}` });
    expect(stale.statusCode).toBe(401);
    expect(setCookieOf(stale)).toContain('Max-Age=0');
  });

  it('rotates the session on a fresh login (the old cookie stops working)', async () => {
    const first = await signIn();
    const res = await inject('POST', '/auth/login', { payload: { username: 'courtesycars', password: PASSWORD }, cookie: first.cookie });
    expect(res.statusCode).toBe(200);
    const second = cookieFrom(res);
    expect((await inject('GET', '/auth/me', { cookie: first.cookie })).statusCode).toBe(401);
    expect((await inject('GET', '/auth/me', { cookie: second.cookie })).statusCode).toBe(200);
  });
});

describe('the auth hook', () => {
  beforeEach(async () => {
    t = await sessionApp();
  });

  it('401s a protected route without a cookie — X-User-Id is not accepted in session mode', async () => {
    const res = await inject('GET', '/claims');
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(res.json().error.requestId).toBeTruthy();
    expect((await inject('GET', '/claims', { headers: { 'x-user-id': 'courtesycars' } })).statusCode).toBe(401);
    expect((await inject('GET', '/claims', { headers: { 'x-user-id': 'handler' } })).statusCode).toBe(401);
    expect((await inject('GET', '/claims', { cookie: `${SESSION_COOKIE}=${'C'.repeat(43)}` })).statusCode).toBe(401);
    // Unknown /api paths are 401 too (no route discovery without a session); URL tricks do not dodge the check.
    expect((await inject('GET', '/no-such-route')).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/%63laims' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/claims?x=/api/health' })).statusCode).toBe(401);
  });

  it('leaves health, the auth endpoints and the non-/api web app public', async () => {
    expect((await inject('GET', '/health')).statusCode).toBe(200);
    expect((await inject('GET', '/auth/login-defaults')).statusCode).toBe(200);
    expect((await inject('POST', '/auth/logout')).statusCode).toBe(204);
    const spa = await t.app.inject({ method: 'GET', url: '/claims/123' });
    expect(spa.statusCode).toBe(404); // no web build in tests — but not 401
    expect(spa.json().error.code).toBe('NOT_FOUND');
  });

  it('with the cookie a protected route is 200 and the audit row records user id courtesycars', async () => {
    const { cookie } = await signIn();
    expect((await inject('GET', '/claims', { cookie })).statusCode).toBe(200);
    const created = await inject('POST', '/claims', { cookie, payload: FNOL });
    expect(created.statusCode).toBe(201);
    const claim = created.json<{ claim: Claim }>().claim;
    const rows = t.ctx.repos.listAudit(t.ctx.db, { action: 'claim.create', entityId: claim.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe('courtesycars');
    expect(rows[0]!.ip).toBe('127.0.0.1');
  });
});

describe('POST /auth/logout', () => {
  beforeEach(async () => {
    t = await sessionApp();
  });

  it('deletes the session row, clears the cookie and audits auth.logout', async () => {
    const { cookie } = await signIn();
    const res = await inject('POST', '/auth/logout', { cookie });
    expect(res.statusCode).toBe(204);
    expect(setCookieOf(res)).toBe(`${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    expect(t.ctx.handle.sqlite.prepare('select count(*) as n from sessions').get()).toEqual({ n: 0 });
    expect((await inject('GET', '/auth/me', { cookie })).statusCode).toBe(401);
    expect((await inject('GET', '/claims', { cookie })).statusCode).toBe(401);
    const rows = t.ctx.repos.listAudit(t.ctx.db, { action: 'auth.logout' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe('courtesycars');
  });

  it('is a harmless no-op without a session', async () => {
    const res = await inject('POST', '/auth/logout');
    expect(res.statusCode).toBe(204);
    expect(setCookieOf(res)).toContain('Max-Age=0');
    expect(t.ctx.repos.listAudit(t.ctx.db, { action: 'auth.logout' })).toHaveLength(0);
  });
});

describe('login rate limit', () => {
  beforeEach(async () => {
    t = await sessionApp();
  });

  it('429 LOGIN_RATE_LIMITED after 10 failures for the same username + IP within 15 minutes, until the window passes', async () => {
    for (let i = 0; i < 10; i += 1) {
      t.setNow(new Date(Date.parse(T0) + i * 1000).toISOString());
      expect((await login('courtesycars', `wrong-${i}`)).statusCode).toBe(401);
    }
    t.setNow('2026-10-05T09:01:00.000Z');
    const limited = await login('courtesycars', PASSWORD); // even the right password
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('LOGIN_RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['set-cookie']).toBeUndefined();
    // Case/whitespace variants are the same username.
    expect((await login(' COURTESYCARS ', PASSWORD)).statusCode).toBe(429);
    // Another IP is a different key.
    expect((await login('courtesycars', PASSWORD, '203.0.113.7')).statusCode).toBe(200);

    t.setNow('2026-10-05T09:14:59.000Z');
    expect((await login('courtesycars', PASSWORD)).statusCode).toBe(429);
    t.setNow('2026-10-05T09:15:00.500Z'); // the first failure has aged out of the window
    expect((await login('courtesycars', PASSWORD)).statusCode).toBe(200);
  });

  it('cannot be dodged by a spoofed X-Forwarded-For from a non-proxy client', async () => {
    for (let i = 0; i < 10; i += 1) await login('courtesycars', `wrong-${i}`, '198.51.100.20');
    const spoofed = await inject('POST', '/auth/login', { payload: { username: 'courtesycars', password: PASSWORD }, remoteAddress: '198.51.100.20', headers: { 'x-forwarded-for': '192.0.2.99' } });
    expect(spoofed.statusCode).toBe(429);
  });
});

describe('GET /auth/login-defaults and POST /auth/change-password', () => {
  beforeEach(async () => {
    t = await sessionApp();
  });

  it('returns the default password while it is unchanged, and stops after change-password', async () => {
    const before = await inject('GET', '/auth/login-defaults');
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ username: 'courtesycars', password: 'CourtesyCars123!', prefill: true });
    expect(before.headers['cache-control']).toBe('no-store');

    const { cookie } = await signIn();
    const res = await inject('POST', '/auth/change-password', { cookie, payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
    expect(res.statusCode).toBe(204);

    const after = await inject('GET', '/auth/login-defaults');
    expect(after.json()).toEqual({ username: 'courtesycars', prefill: true });
    expect(after.body).not.toContain(PASSWORD);

    expect((await login('courtesycars', PASSWORD)).statusCode).toBe(401);
    expect((await login('courtesycars', NEW_PASSWORD)).statusCode).toBe(200);
    expect(t.ctx.repos.getUser(t.ctx.db, 'courtesycars')?.passwordChangedAt).toBe(T0);
    const audit = t.ctx.repos.listAudit(t.ctx.db, { action: 'auth.password_changed' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.userId).toBe('courtesycars');
  });

  it('rejects a wrong current password (400 INVALID_CREDENTIALS) and a short or unchanged new one (400 VALIDATION)', async () => {
    const { cookie } = await signIn();
    const wrong = await inject('POST', '/auth/change-password', { cookie, payload: { currentPassword: 'not my password', newPassword: NEW_PASSWORD } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
    const short = await inject('POST', '/auth/change-password', { cookie, payload: { currentPassword: PASSWORD, newPassword: 'short12' } });
    expect(short.statusCode).toBe(400);
    expect(short.json().error.code).toBe('VALIDATION');
    expect(short.body).not.toContain('short12');
    const nine = await inject('POST', '/auth/change-password', { cookie, payload: { currentPassword: PASSWORD, newPassword: '123456789' } });
    expect(nine.statusCode).toBe(400);
    const same = await inject('POST', '/auth/change-password', { cookie, payload: { currentPassword: PASSWORD, newPassword: PASSWORD } });
    expect(same.statusCode).toBe(400);
    expect(same.json().error.code).toBe('VALIDATION');
    expect(await verifyPassword(PASSWORD, t.ctx.repos.getPasswordHash(t.ctx.db, 'courtesycars')!)).toBe(true);
    expect((await inject('GET', '/auth/login-defaults')).json().password).toBe(PASSWORD);
  });

  it('requires a session', async () => {
    const res = await inject('POST', '/auth/change-password', { payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('signs out every other session of the user but keeps the current one', async () => {
    const a = await signIn();
    const b = await signIn();
    const c = await signIn();
    expect(t.ctx.handle.sqlite.prepare('select count(*) as n from sessions').get()).toEqual({ n: 3 });
    const res = await inject('POST', '/auth/change-password', { cookie: a.cookie, payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
    expect(res.statusCode).toBe(204);
    expect((await inject('GET', '/auth/me', { cookie: a.cookie })).statusCode).toBe(200);
    expect((await inject('GET', '/auth/me', { cookie: b.cookie })).statusCode).toBe(401);
    expect((await inject('GET', '/claims', { cookie: c.cookie })).statusCode).toBe(401);
    expect(t.ctx.handle.sqlite.prepare('select count(*) as n from sessions').get()).toEqual({ n: 1 });
  });

  it('LOGIN_PREFILL=false: no password and no username are offered', async () => {
    await t.close();
    t = await sessionApp({ loginPrefill: false });
    const res = await inject('GET', '/auth/login-defaults');
    expect(res.json()).toEqual({ username: '', prefill: false });
  });

  it('honours DEFAULT_LOGIN_USERNAME / DEFAULT_LOGIN_PASSWORD', async () => {
    await t.close();
    t = await sessionApp({ defaultLoginUsername: 'Owner', defaultLoginPassword: 'Another default 99' });
    expect((await inject('GET', '/auth/login-defaults')).json()).toEqual({ username: 'owner', password: 'Another default 99', prefill: true });
    const res = await login('owner', 'Another default 99');
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ username: 'owner', role: 'admin', name: 'Courtesy Cars' });
  });
});

describe('session expiry', () => {
  beforeEach(async () => {
    t = await sessionApp();
  });

  it('accepts a session until its absolute 12-hour expiry, then rejects and deletes it', async () => {
    const { cookie } = await signIn();
    t.setNow('2026-10-05T20:59:59.000Z');
    expect((await inject('GET', '/auth/me', { cookie })).statusCode).toBe(200);
    t.setNow('2026-10-05T21:00:00.000Z');
    expect((await inject('GET', '/auth/me', { cookie })).statusCode).toBe(401);
    expect((await inject('GET', '/claims', { cookie })).statusCode).toBe(401);
    expect(t.ctx.handle.sqlite.prepare('select count(*) as n from sessions').get()).toEqual({ n: 0 });
  });

  it('activity does not extend the absolute expiry', async () => {
    const { cookie } = await signIn();
    for (const at of ['2026-10-05T12:00:00.000Z', '2026-10-05T18:00:00.000Z', '2026-10-05T20:30:00.000Z']) {
      t.setNow(at);
      expect((await inject('GET', '/claims', { cookie })).statusCode).toBe(200);
    }
    const row = t.ctx.handle.sqlite.prepare('select expires_at, last_seen_at from sessions').get();
    expect(row).toEqual({ expires_at: '2026-10-05T21:00:00.000Z', last_seen_at: '2026-10-05T20:30:00.000Z' });
    t.setNow('2026-10-05T21:00:01.000Z');
    expect((await inject('GET', '/claims', { cookie })).statusCode).toBe(401);
  });
});

describe('configuration guards', () => {
  it('refuses header mode in production', async () => {
    const { buildApp } = await import('../app.js');
    const { buildContext, silentLogger } = await import('../context.js');
    const { testConfig, resolveAuthMode } = await import('../config.js');
    const ctx = buildContext({ config: testConfig({ env: 'production', authMode: 'header' }), logger: silentLogger });
    try {
      await expect(buildApp(ctx)).rejects.toThrow(/not allowed in production/);
    } finally {
      ctx.close();
    }
    expect(() => resolveAuthMode('production', 'header')).toThrow(/not allowed in production/);
    expect(resolveAuthMode('production', undefined)).toBe('session');
    expect(resolveAuthMode('development', undefined)).toBe('session');
    expect(resolveAuthMode('test', undefined)).toBe('header');
    expect(resolveAuthMode('test', 'session')).toBe('session');
    expect(() => resolveAuthMode('development', 'none')).toThrow(/AUTH_MODE/);
  });
});

describe('production cookie', () => {
  it('adds Secure when env is production', async () => {
    t = await sessionApp({ env: 'production' });
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(setCookieOf(res)).toMatch(/; HttpOnly; SameSite=Lax; Path=\/; Max-Age=43200; Secure$/);
    expect(setCookieOf(await inject('POST', '/auth/logout', { cookie: cookieFrom(res).cookie }))).toMatch(/Max-Age=0; Secure$/);
  });
});

describe('secrets never reach audit_log or the logs', () => {
  it('passwords (right, wrong, new) and session tokens appear in no audit row and no log line', async () => {
    t = await sessionApp();
    const wrongPassword = 'Wrong-Secret-Attempt-777';
    await login('courtesycars', wrongPassword);
    await login('nobody', wrongPassword);
    const first = await signIn();
    const second = await signIn();
    await inject('POST', '/auth/change-password', { cookie: second.cookie, payload: { currentPassword: 'also-wrong-pass-123', newPassword: NEW_PASSWORD } });
    expect((await inject('POST', '/auth/change-password', { cookie: second.cookie, payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } })).statusCode).toBe(204);
    const third = cookieFrom(await login('courtesycars', NEW_PASSWORD));
    await inject('GET', '/claims', { cookie: third.cookie });
    await inject('POST', '/auth/logout', { cookie: third.cookie });

    const secrets = [PASSWORD, wrongPassword, NEW_PASSWORD, 'also-wrong-pass-123', first.token, second.token, third.token];
    const audit = JSON.stringify(t.ctx.handle.sqlite.prepare('select * from audit_log').all());
    const logs = cap.logs.join('\n');
    expect(cap.logs.length).toBeGreaterThan(10); // the capture really saw the request log
    expect(logs).toContain('auth: sign-in failed');
    expect(logs).not.toContain('nobody'); // the username tried is audited, not logged
    expect(audit).toContain('auth.login_failed');
    expect(audit).toContain('auth.password_changed');
    for (const secret of secrets) {
      expect(audit, 'audit_log').not.toContain(secret);
      expect(logs, 'logger output').not.toContain(secret);
    }
    // Nor in any other table: users hold scrypt hashes, sessions hold sha256 digests.
    const sessions = JSON.stringify(t.ctx.handle.sqlite.prepare('select * from sessions').all());
    const users = JSON.stringify(t.ctx.handle.sqlite.prepare('select * from users').all());
    for (const secret of secrets) {
      expect(sessions).not.toContain(secret);
      expect(users).not.toContain(secret);
    }
  });
});
