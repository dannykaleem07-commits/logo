/**
 * Sign-in endpoints (base /api):
 *   GET  /auth/login-defaults   public — { username, password?, prefill }; the password only while LOGIN_PREFILL is on
 *                               and the default account still has the default password
 *   POST /auth/login            public — { username, password } → { user } + Set-Cookie claimdesk_session (HttpOnly)
 *   POST /auth/logout           public — 204; deletes the session row and expires the cookie
 *   GET  /auth/me               public — { user } or 401 UNAUTHENTICATED
 *   POST /auth/change-password  session — { currentPassword, newPassword } → 204; signs out the user's other sessions
 *   GET  /auth/manager-mode     session — ManagerModeView (0.3 §A.4.2)
 *   POST /auth/manager-mode     session — { on, why? } → ManagerModeView; on:true is admin/approver only (403 FORBIDDEN)
 *   GET  /auth/manager-mode/log session, admin/approver — { items } recent overrides and manager-mode on/off rows
 *
 * Audit rows: auth.login, auth.login_failed (the username tried, never the password), auth.logout,
 * auth.password_changed, auth.password_change_failed, manager_mode.on, manager_mode.off. Passwords and tokens are
 * never logged or audited.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_OVERRIDE_REASON, MANAGER_ROLES } from '@ccguk/domain';
import type { AuditEntry } from '@ccguk/db';
import type { RequestUser } from '../app.js';
import type { AppContext } from '../context.js';
import { badRequest, HttpError } from '../errors.js';
import { parse } from '../schemas/common.js';
import {
  clearSessionCookie,
  cookieOptions,
  defaultPasswordChecker,
  dummyPasswordHash,
  hashPassword,
  hashSessionToken,
  LoginRateLimiter,
  newSessionToken,
  publicUser,
  readSessionToken,
  sessionCookie,
  verifyPassword,
} from '../services/auth.js';
import { managerModeState, setManagerMode, type ManagerModeState } from '../services/override.js';
import { requireRole } from './helpers.js';

export const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 1024;

export const loginBody = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH, `New password must be at least ${MIN_PASSWORD_LENGTH} characters`).max(MAX_PASSWORD_LENGTH),
});

export const managerModeBody = z.object({ on: z.boolean(), why: z.enum(['user', 'idle']).optional() });
const managerModeLogQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });

/** GET /auth/manager-mode, POST /auth/manager-mode and GET /auth/me → managerMode. */
export interface ManagerModeView { allowed: boolean; on: boolean; until?: string; idleMinutes: number; defaultReason: typeof DEFAULT_OVERRIDE_REASON }

function managerModeView(state: ManagerModeState): ManagerModeView {
  const v: ManagerModeView = { allowed: state.allowed, on: state.on, idleMinutes: state.idleMinutes, defaultReason: DEFAULT_OVERRIDE_REASON };
  if (state.until) v.until = state.until;
  return v;
}

const INVALID_CREDENTIALS_MESSAGE = 'Username or password is incorrect';

function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}

function rateLimited(reply: FastifyReply, waitMs: number): HttpError {
  const retryAfterSeconds = Math.ceil(waitMs / 1000);
  reply.header('retry-after', String(retryAfterSeconds));
  return new HttpError(429, 'LOGIN_RATE_LIMITED', `Too many failed attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`, { retryAfterSeconds });
}

function currentUser(request: FastifyRequest): RequestUser | undefined {
  return request.user as RequestUser | undefined;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const limiter = new LoginRateLimiter();
  // A separate instance so no crafted username can share (or lock) a change-password key.
  const changeLimiter = new LoginRateLimiter();
  const defaultPasswordStillSet = defaultPasswordChecker(ctx);
  void dummyPasswordHash(); // warm the unknown-user hash so the first miss costs the same as a wrong password

  app.get('/auth/login-defaults', async (_request, reply) => {
    noStore(reply);
    if (!ctx.config.loginPrefill) return { username: '', prefill: false };
    const body: { username: string; password?: string; prefill: boolean } = { username: ctx.repos.normaliseUsername(ctx.config.defaultLoginUsername), prefill: true };
    if (await defaultPasswordStillSet()) body.password = ctx.config.defaultLoginPassword;
    return body;
  });

  app.post('/auth/login', async (request, reply) => {
    noStore(reply);
    const body = parse(loginBody, request.body);
    const username = ctx.repos.normaliseUsername(body.username);
    const ip = request.ip;
    const key = LoginRateLimiter.key(username, ip);
    const now = ctx.now();
    const nowMs = Date.parse(now);
    const wait = limiter.retryAfterMs(key, nowMs);
    if (wait > 0) throw rateLimited(reply, wait);
    // Count the attempt BEFORE the (async) password check: otherwise a burst of parallel guesses all pass the check
    // above while the first ones are still hashing, and the limit never applies. A correct password clears the key.
    const failures = limiter.recordFailure(key, nowMs);

    const user = username ? ctx.repos.getUserByUsername(ctx.db, username) : undefined;
    const stored = user ? ctx.repos.getPasswordHash(ctx.db, user.id) : undefined;
    // Same scrypt work whether or not the user exists.
    const matches = await verifyPassword(body.password, stored ?? (await dummyPasswordHash()));
    if (!user || !stored || !matches) {
      const tried = username.slice(0, 100);
      const reason = !user ? 'unknown_user' : !stored ? 'no_password' : 'wrong_password';
      ctx.repos.appendAudit(ctx.db, {
        actor: { userId: 'anonymous', ip },
        action: 'auth.login_failed',
        entity: user ? 'user' : 'auth',
        entityId: user ? user.id : tried || '(blank)',
        after: { username: tried, reason, failuresInWindow: failures },
        at: now,
      });
      // The username tried goes to the audit row only: people sometimes type their password into the username box.
      ctx.logger.warn('auth: sign-in failed', { reason, ip, requestId: request.requestId });
      throw new HttpError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS_MESSAGE);
    }
    limiter.reset(key);

    // Rotate: whatever session the browser held before is discarded (no session fixation).
    const previous = request.sessionId ?? (() => {
      const t = readSessionToken(request.headers.cookie);
      return t ? hashSessionToken(t) : undefined;
    })();
    const token = newSessionToken();
    const ttlMs = ctx.config.sessionTtlHours * 3_600_000;
    const expiresAt = new Date(nowMs + ttlMs).toISOString();
    const userAgent = typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined;
    ctx.db.transaction((tx) => {
      if (previous) ctx.repos.deleteSession(tx, previous);
      ctx.repos.deleteExpiredSessions(tx, now);
      ctx.repos.createSession(tx, { tokenHash: hashSessionToken(token), userId: user.id, createdAt: now, expiresAt, ip, userAgent });
      ctx.repos.appendAudit(tx, { actor: { userId: user.id, ip }, action: 'auth.login', entity: 'user', entityId: user.id, after: { username: user.username, expiresAt }, at: now });
    });
    ctx.logger.info('auth: signed in', { userId: user.id, ip, requestId: request.requestId });
    reply.header('set-cookie', sessionCookie(token, ttlMs / 1000, cookieOptions(ctx)));
    return { user: publicUser(user) };
  });

  app.post('/auth/logout', async (request, reply) => {
    noStore(reply);
    const user = currentUser(request);
    const sessionId = request.sessionId;
    // Signing out always ends manager mode (audited when it was on).
    if (user) setManagerMode(ctx, request, false, 'sign_out');
    if (sessionId && user) {
      const now = ctx.now();
      ctx.db.transaction((tx) => {
        ctx.repos.deleteSession(tx, sessionId);
        ctx.repos.appendAudit(tx, { actor: request.actor, action: 'auth.logout', entity: 'user', entityId: user.id, at: now });
      });
    }
    reply.header('set-cookie', clearSessionCookie(cookieOptions(ctx)));
    return reply.status(204).send();
  });

  app.get('/auth/me', async (request, reply) => {
    noStore(reply);
    const user = currentUser(request);
    if (!user) {
      // A cookie was sent but did not resolve (expired / signed out elsewhere): tell the browser to drop it.
      if (readSessionToken(request.headers.cookie)) reply.header('set-cookie', clearSessionCookie(cookieOptions(ctx)));
      throw new HttpError(401, 'UNAUTHENTICATED', 'Not signed in');
    }
    return { user: publicUser(user), managerMode: managerModeView(managerModeState(ctx, request)) };
  });

  app.get('/auth/manager-mode', async (request, reply) => {
    noStore(reply);
    if (!currentUser(request)) throw new HttpError(401, 'UNAUTHENTICATED', 'Not signed in');
    return managerModeView(managerModeState(ctx, request));
  });

  app.post('/auth/manager-mode', async (request, reply) => {
    noStore(reply);
    if (!currentUser(request)) throw new HttpError(401, 'UNAUTHENTICATED', 'Not signed in');
    const body = parse(managerModeBody, request.body);
    return managerModeView(setManagerMode(ctx, request, body.on, body.why ?? 'user'));
  });

  app.get('/auth/manager-mode/log', async (request, reply) => {
    noStore(reply);
    requireRole(request, MANAGER_ROLES);
    const { limit } = parse(managerModeLogQuery, request.query ?? {});
    const rows = ctx.repos.listAuditByActions(ctx.db, { prefixes: ['override.'], actions: ['manager_mode.on', 'manager_mode.off'], limit });
    const names = new Map<string, string | undefined>();
    const refs = new Map<string, string | undefined>();
    const items = rows.map((row) => {
      const item: AuditEntry & { userName?: string; claimReference?: string } = { ...row };
      if (!names.has(row.userId)) names.set(row.userId, row.userId === 'system' ? 'System' : ctx.repos.getUser(ctx.db, row.userId)?.name);
      const userName = names.get(row.userId);
      if (userName) item.userName = userName;
      if (row.entity === 'claims') {
        if (!refs.has(row.entityId)) refs.set(row.entityId, ctx.repos.getClaim(ctx.db, row.entityId)?.reference);
        const ref = refs.get(row.entityId);
        if (ref) item.claimReference = ref;
      }
      return item;
    });
    return { items };
  });

  app.post('/auth/change-password', async (request, reply) => {
    noStore(reply);
    const user = currentUser(request);
    if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Not signed in');
    const body = parse(changePasswordBody, request.body);
    const ip = request.ip;
    const key = LoginRateLimiter.key(user.id, ip);
    const now = ctx.now();
    const nowMs = Date.parse(now);
    const wait = changeLimiter.retryAfterMs(key, nowMs);
    if (wait > 0) throw rateLimited(reply, wait);
    changeLimiter.recordFailure(key, nowMs); // counted before the async check (see login); cleared on success

    const stored = ctx.repos.getPasswordHash(ctx.db, user.id);
    const matches = await verifyPassword(body.currentPassword, stored ?? (await dummyPasswordHash()));
    if (!stored || !matches) {
      ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'auth.password_change_failed', entity: 'user', entityId: user.id, after: { reason: 'wrong_current_password' }, at: now });
      throw new HttpError(400, 'INVALID_CREDENTIALS', 'Current password is incorrect');
    }
    changeLimiter.reset(key);
    if (body.newPassword === body.currentPassword) throw badRequest('New password must be different from the current password');
    if (body.newPassword === ctx.config.defaultLoginPassword) throw badRequest('New password must not be the default password shown on the login screen');

    const hash = await hashPassword(body.newPassword);
    const keep = request.sessionId;
    const revoked = ctx.db.transaction((tx) => {
      ctx.repos.setPassword(tx, user.id, hash, now);
      const n = ctx.repos.deleteUserSessions(tx, user.id, keep);
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'auth.password_changed', entity: 'user', entityId: user.id, after: { otherSessionsSignedOut: n }, at: now });
      return n;
    });
    ctx.logger.info('auth: password changed', { userId: user.id, otherSessionsSignedOut: revoked, requestId: request.requestId });
    return reply.status(204).send();
  });
}
