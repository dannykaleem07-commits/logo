/**
 * Sign-in: password hashing (node:crypto scrypt), session tokens and the `claimdesk_session` cookie (parsed and set by
 * hand — no cookie plugin), the in-memory login rate limiter, and the owner's default account (`ensureDefaultLogin`).
 *
 * Passwords are never stored or logged in plain text: users.password_hash holds "scrypt$N$r$p$saltB64$hashB64".
 * Session tokens are 32 random bytes (base64url) held only by the browser; the database stores sha256(token).
 */
import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { SessionRecord, UserRecord } from '@ccguk/db';
import type { UserRole } from '@ccguk/domain';
import { DEFAULT_LOGIN } from '../config.js';
import type { AppContext } from '../context.js';

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, saltBytes: 16, keyBytes: 64 } as const;

function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** scrypt (N=16384, r=8, p=1), 16-byte random salt, 64-byte key → "scrypt$16384$8$1$<saltB64>$<hashB64>". */
export async function hashPassword(password: string): Promise<string> {
  const { N, r, p, saltBytes, keyBytes } = SCRYPT_PARAMS;
  const salt = randomBytes(saltBytes);
  const key = await scryptAsync(password, salt, keyBytes, { N, r, p, maxmem: 256 * N * r });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

const isPow2 = (n: number) => Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;

function parseHash(stored: string): ParsedHash | undefined {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // Bounds keep a corrupted row from asking scrypt for gigabytes of memory.
  if (!isPow2(N) || N < 1024 || N > 1_048_576 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return undefined;
  const salt = Buffer.from(parts[4]!, 'base64');
  const key = Buffer.from(parts[5]!, 'base64');
  if (salt.length < 8 || key.length < 16 || key.length > 256) return undefined;
  return { N, r, p, salt, key };
}

/** Constant-time comparison of the derived key (crypto.timingSafeEqual). False for a malformed stored value. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const { N, r, p, salt, key } = parsed;
  const derived = await scryptAsync(password, salt, key.length, { N, r, p, maxmem: 256 * N * r });
  return derived.length === key.length && timingSafeEqual(derived, key);
}

let dummyHashPromise: Promise<string> | undefined;
/**
 * A hash of a random secret nobody knows. Sign-in verifies against it when the username does not exist (or has no
 * password) so an unknown user costs the same scrypt work as a wrong password.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHashPromise;
}

// ---------------------------------------------------------------------------
// Session tokens and the cookie
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'claimdesk_session';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, unpadded

/** 32 random bytes, base64url. Only the browser ever holds it. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256 hex digest of a session token — the sessions.id stored in the database. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Parse a Cookie request header into name → value (first occurrence wins, as browsers send the most specific first). */
export function parseCookieHeader(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

/** The well-formed session token from a Cookie header, if any. */
export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  const value = parseCookieHeader(cookieHeader).get(SESSION_COOKIE);
  return value && TOKEN_PATTERN.test(value) ? value : undefined;
}

export interface CookieOptions {
  secure: boolean;
}

/** `claimdesk_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=<ttl>` (+ `; Secure` in production). */
export function sessionCookie(token: string, maxAgeSeconds: number, options: CookieOptions): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAgeSeconds)}${options.secure ? '; Secure' : ''}`;
}

/** Expires the cookie in the browser. */
export function clearSessionCookie(options: CookieOptions): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${options.secure ? '; Secure' : ''}`;
}

export function cookieOptions(ctx: AppContext): CookieOptions {
  return { secure: ctx.config.cookieSecure };
}

export interface ResolvedSession {
  session: SessionRecord;
  user: UserRecord;
}

const TOUCH_INTERVAL_MS = 60_000;

/**
 * Look up the session for a token. Expired rows (absolute 12-hour expiry) and rows whose user has gone are deleted and
 * rejected; `last_seen_at` is refreshed at most once a minute.
 */
export function resolveSession(ctx: AppContext, token: string): ResolvedSession | undefined {
  const id = hashSessionToken(token);
  const session = ctx.repos.getSessionByTokenHash(ctx.db, id);
  if (!session) return undefined;
  const now = ctx.now();
  const nowMs = Date.parse(now);
  if (!(Date.parse(session.expiresAt) > nowMs)) {
    ctx.repos.deleteSession(ctx.db, id);
    return undefined;
  }
  const user = ctx.repos.getUser(ctx.db, session.userId);
  if (!user) {
    ctx.repos.deleteSession(ctx.db, id);
    return undefined;
  }
  if (nowMs - Date.parse(session.lastSeenAt) >= TOUCH_INTERVAL_MS) ctx.repos.touchSession(ctx.db, id, now);
  return { session, user };
}

/** The user as the auth endpoints return it — never the hash, never a token. */
export interface PublicUser {
  id: string;
  name: string;
  username?: string;
  email: string;
  role: UserRole;
}

export function publicUser(u: { id: string; name: string; username?: string; email: string; role: UserRole }): PublicUser {
  const out: PublicUser = { id: u.id, name: u.name, email: u.email, role: u.role };
  if (u.username !== undefined) out.username = u.username;
  return out;
}

// ---------------------------------------------------------------------------
// Login rate limiter (in memory, per username + IP)
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  maxFailures: number;
  windowMs: number;
  /** Upper bound on tracked keys; stale keys are swept first, then the oldest are dropped. */
  maxKeys: number;
}

export const LOGIN_RATE_LIMIT: RateLimiterOptions = { maxFailures: 10, windowMs: 15 * 60_000, maxKeys: 10_000 };

/** Sliding window: after `maxFailures` failures within `windowMs`, the key is refused until the oldest one ages out. */
export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();
  constructor(private readonly options: RateLimiterOptions = LOGIN_RATE_LIMIT) {}

  static key(username: string, ip: string): string {
    return `${username}\u0000${ip}`;
  }

  private recent(key: string, nowMs: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => t > nowMs - this.options.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** Milliseconds until `key` may try again; 0 when it may try now. */
  retryAfterMs(key: string, nowMs: number): number {
    const list = this.recent(key, nowMs);
    if (list.length < this.options.maxFailures) return 0;
    const oldestCounted = list[list.length - this.options.maxFailures]!;
    return Math.max(1, oldestCounted + this.options.windowMs - nowMs);
  }

  /** Record a failure; returns the number of failures now inside the window. */
  recordFailure(key: string, nowMs: number): number {
    const list = this.recent(key, nowMs);
    list.push(nowMs);
    this.failures.delete(key); // re-insert so Map order tracks recency
    this.failures.set(key, list);
    if (this.failures.size > this.options.maxKeys) this.sweep(nowMs);
    return list.length;
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  get size(): number {
    return this.failures.size;
  }

  /**
   * Over capacity: drop stale keys, then the oldest keys that are NOT locked out, and only then (if every key is
   * locked) the oldest locked ones. Otherwise a flood of junk usernames would evict a locked key and reset its count.
   */
  private sweep(nowMs: number): void {
    for (const k of [...this.failures.keys()]) this.recent(k, nowMs);
    const over = () => this.failures.size > this.options.maxKeys;
    for (const [k, list] of [...this.failures]) {
      if (!over()) return;
      if (list.length < this.options.maxFailures) this.failures.delete(k);
    }
    for (const k of [...this.failures.keys()]) {
      if (!over()) return;
      this.failures.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// The owner's default account
// ---------------------------------------------------------------------------

export interface EnsureDefaultLoginResult {
  created: boolean;
  userId?: string;
  username: string;
}

const SLUG = /^[a-z0-9._-]{1,64}$/;

/**
 * Create the owner's sign-in account (DEFAULT_LOGIN_USERNAME / DEFAULT_LOGIN_PASSWORD; by default "courtesycars",
 * id "courtesycars", "Courtesy Cars", claims@courtesycars.net, admin) when no user has that username. Never touches an
 * existing account's password. Run on server boot and by `pnpm seed`; audited as `auth.default_login_created`.
 */
export async function ensureDefaultLogin(ctx: AppContext): Promise<EnsureDefaultLoginResult> {
  const username = ctx.repos.normaliseUsername(ctx.config.defaultLoginUsername);
  if (!username) return { created: false, username };
  const existing = ctx.repos.getUserByUsername(ctx.db, username);
  if (existing) return { created: false, userId: existing.id, username };

  const passwordHash = await hashPassword(ctx.config.defaultLoginPassword);
  const now = ctx.now();
  const result = ctx.db.transaction((tx): EnsureDefaultLoginResult => {
    const again = ctx.repos.getUserByUsername(tx, username);
    if (again) return { created: false, userId: again.id, username };
    const preferredId = username === DEFAULT_LOGIN.username ? DEFAULT_LOGIN.id : SLUG.test(username) ? username : undefined;
    const sameId = preferredId ? ctx.repos.getUser(tx, preferredId) : undefined;
    if (sameId && !sameId.username && !ctx.repos.getPasswordHash(tx, sameId.id)) {
      // A row with the owner's id but no sign-in (created before accounts existed): give it the credentials.
      ctx.repos.updateUser(tx, sameId.id, { username });
      ctx.repos.setPassword(tx, sameId.id, passwordHash, now);
      ctx.repos.appendAudit(tx, { actor: ctx.repos.SYSTEM_ACTOR, action: 'auth.default_login_created', entity: 'user', entityId: sameId.id, after: { username, role: sameId.role, attachedToExistingUser: true }, at: now });
      return { created: true, userId: sameId.id, username };
    }
    const id = preferredId && !sameId ? preferredId : ctx.repos.newId();
    const email = ctx.repos.getUserByEmail(tx, DEFAULT_LOGIN.email) ? `${id}@ccguk.local` : DEFAULT_LOGIN.email;
    const user = ctx.repos.createUser(tx, { id, name: DEFAULT_LOGIN.name, email, role: DEFAULT_LOGIN.role, username, passwordHash, createdAt: now });
    ctx.repos.appendAudit(tx, { actor: ctx.repos.SYSTEM_ACTOR, action: 'auth.default_login_created', entity: 'user', entityId: user.id, after: { username, name: user.name, email: user.email, role: user.role }, at: now });
    return { created: true, userId: user.id, username };
  });
  if (result.created) ctx.logger.info('auth: default sign-in account created', { userId: result.userId, username });
  return result;
}

/**
 * True while the default account still has the default password. Cached per stored hash, so the public
 * login-defaults endpoint costs one scrypt per password change rather than one per request.
 */
export function defaultPasswordChecker(ctx: AppContext): () => Promise<boolean> {
  let cache: { hash: string; result: boolean } | undefined;
  return async () => {
    const user = ctx.repos.getUserByUsername(ctx.db, ctx.config.defaultLoginUsername);
    const hash = user ? ctx.repos.getPasswordHash(ctx.db, user.id) : undefined;
    if (!hash) return false;
    if (cache?.hash === hash) return cache.result;
    const result = await verifyPassword(ctx.config.defaultLoginPassword, hash);
    cache = { hash, result };
    return result;
  };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Boot-time warning text when the login pre-fill would hand the default password to more than this machine. */
export function prefillExposureWarning(ctx: AppContext): string | undefined {
  const { config } = ctx;
  if (config.authMode !== 'session' || !config.loginPrefill) return undefined;
  if (config.env !== 'production' && LOOPBACK_HOSTS.has(config.host)) return undefined;
  return 'LOGIN_PREFILL is on: the login screen offers the default password to anyone who can reach this server until it is changed (Settings → Change password) or LOGIN_PREFILL=false is set.';
}
