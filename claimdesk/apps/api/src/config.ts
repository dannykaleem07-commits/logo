/**
 * Process configuration for @ccguk/api. Read once from the environment (dotenv is loaded here, never elsewhere).
 * API keys are never exposed through the API — only their presence flags (Settings.apiKeysPresent).
 */
import { config as loadDotenv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { TOTAL_CAR_CHECK_URL_TEMPLATE } from '@ccguk/domain';

export interface ApiKeys {
  dvlaVesApiKey?: string;
  dvsaMotClientId?: string;
  dvsaMotClientSecret?: string;
  dvsaMotApiKey?: string;
  dvsaMotTokenUrl?: string;
  dvsaMotScopeUrl?: string;
  companiesHouseApiKey?: string;
  esignSecret?: string;
}

export interface ApiKeysPresence {
  dvlaVes: boolean;
  dvsaMot: boolean;
  companiesHouse: boolean;
  gateway: boolean;
  esign: boolean;
}

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databasePath: string;
  evidenceDir: string;
  documentsDir: string;
  chromiumPath?: string;
  /** Directory holding the built web app (served at / when it exists). */
  webDistDir: string;
  keys: ApiKeys;
  keysPresent: ApiKeysPresence;
  /** User id assumed when no X-User-Id header is supplied (dev/test only; disabled in production). */
  defaultUserId: string;
  /** Outbound lookup timeout. */
  lookupTimeoutMs: number;
  /**
   * Browser origins allowed by CORS. Default (CORS_ORIGINS unset): localhost / 127.0.0.1 / [::1] on any port and
   * scheme. `CORS_ORIGINS=https://claims.example.com,https://ops.example.com` replaces the default; `*` reflects any
   * origin (never the default — credentials are sent).
   */
  corsOrigins: Array<string | RegExp> | true;
  /**
   * How a request is identified. 'session' (default in development and production): the HttpOnly `claimdesk_session`
   * cookie set by POST /api/auth/login; every /api route except health and auth/{login,logout,me,login-defaults} needs
   * one. 'header' (default ONLY in test): the legacy `X-User-Id` header / `defaultUserId` fallback. Never 'header' in
   * production (loadConfig refuses it).
   */
  authMode: 'session' | 'header';
  /** The owner's default sign-in account, created on boot when no user has this username. */
  defaultLoginUsername: string;
  defaultLoginPassword: string;
  /**
   * Pre-fill the login form. GET /api/auth/login-defaults returns the default password only while this is true AND the
   * default account still has the default password (it stops by itself once the owner changes it).
   */
  loginPrefill: boolean;
  /** Absolute session lifetime. */
  sessionTtlHours: number;
  /**
   * Mark the session cookie Secure (HTTPS only). Default: true in production. The packaged desktop app runs on
   * plain http://localhost and sets COOKIE_SECURE=false.
   */
  cookieSecure: boolean;
  /**
   * How the e-signature one-time code reaches the signer. 'external' (default): a separate email/SMS sender delivers
   * it and the API never returns it in production. 'handler': no sender is configured, so the code is returned to the
   * signed-in handler to pass on (phone, text, in person); the audit row records this.
   */
  esignDelivery: 'external' | 'handler';
  /**
   * Fastify `trustProxy`: which hops may set X-Forwarded-For (it decides `request.ip`, used by the login rate limiter
   * and recorded on audit rows). Default 'loopback' — only a reverse proxy on the same host — so a client cannot
   * spoof its address with the header.
   */
  trustProxy: boolean | string;
  /**
   * Total Car Check free-check URL with `{REG}` for the registration (TOTALCARCHECK_URL_TEMPLATE). The API never requests
   * it; it is handed to the browser as a link (TEMPLATES-VEHICLES-DESKTOP §E.2), so a wrong format can be fixed here.
   */
  totalCarCheckUrlTemplate: string;
}

export const LOCALHOST_ORIGINS: readonly RegExp[] = [/^https?:\/\/localhost(:\d+)?$/i, /^https?:\/\/127\.0\.0\.1(:\d+)?$/, /^https?:\/\/\[::1\](:\d+)?$/];

/** Parse CORS_ORIGINS: unset → localhost only; a comma list → exactly those origins; `*` → any origin. */
export function parseCorsOrigins(raw: string | undefined): Array<string | RegExp> | true {
  const items = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length) return [...LOCALHOST_ORIGINS];
  if (items.includes('*')) return true;
  return items;
}

function str(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/** The owner's default sign-in account (requested by the owner; pre-filled on the login screen until its password is changed). */
export const DEFAULT_LOGIN = {
  username: 'courtesycars',
  password: 'CourtesyCars123!',
  id: 'courtesycars',
  name: 'Courtesy Cars',
  email: 'claims@courtesycars.net',
  role: 'admin' as const,
};

/** AUTH_MODE: unset → 'header' in test, 'session' otherwise. 'header' is refused in production. */
export function resolveAuthMode(env: AppConfig['env'], raw: string | undefined): AppConfig['authMode'] {
  const mode = raw?.trim().toLowerCase();
  if (mode !== undefined && mode !== '' && mode !== 'session' && mode !== 'header') throw new Error(`AUTH_MODE must be "session" or "header" (got "${raw}")`);
  const resolved = mode === 'session' || mode === 'header' ? mode : env === 'test' ? 'header' : 'session';
  if (resolved === 'header' && env === 'production') throw new Error('AUTH_MODE=header is not allowed in production: X-User-Id is not authentication');
  return resolved;
}

/** TRUST_PROXY: unset → 'loopback'; 'true'/'false'; otherwise a comma list of addresses/CIDRs/keywords for proxy-addr. */
export function parseTrustProxy(raw: string | undefined): boolean | string {
  const v = raw?.trim();
  if (!v) return 'loopback';
  if (v.toLowerCase() === 'true') return true;
  if (v.toLowerCase() === 'false') return false;
  return v;
}

/** TOTALCARCHECK_URL_TEMPLATE: an https URL containing {REG}; anything else falls back to the built-in template. */
export function parseTotalCarCheckTemplate(raw: string | undefined): string {
  const v = raw?.trim();
  if (v && /^https:\/\/\S+$/i.test(v) && v.includes('{REG}')) return v;
  return TOTAL_CAR_CHECK_URL_TEMPLATE;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function keysPresence(keys: ApiKeys): ApiKeysPresence {
  return {
    dvlaVes: Boolean(keys.dvlaVesApiKey),
    dvsaMot: Boolean(keys.dvsaMotClientId && keys.dvsaMotClientSecret && keys.dvsaMotApiKey && keys.dvsaMotTokenUrl),
    companiesHouse: Boolean(keys.companiesHouseApiKey),
    gateway: Boolean(str('GATEWAY_API_KEY')),
    esign: Boolean(keys.esignSecret),
  };
}

/** Build the config from `process.env` (after loading `.env` from the api app and the repo root, if present). */
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  loadDotenv({ path: path.resolve(process.cwd(), '.env') });
  loadDotenv({ path: path.resolve(process.cwd(), '../../.env') });
  const envName = (str('NODE_ENV', 'development') as AppConfig['env']) ?? 'development';
  const dataDir = str('DATA_DIR', path.resolve(process.cwd(), 'data'))!;
  const keys: ApiKeys = {
    dvlaVesApiKey: str('DVLA_VES_API_KEY'),
    dvsaMotClientId: str('DVSA_MOT_CLIENT_ID'),
    dvsaMotClientSecret: str('DVSA_MOT_CLIENT_SECRET'),
    dvsaMotApiKey: str('DVSA_MOT_API_KEY'),
    dvsaMotTokenUrl: str('DVSA_MOT_TOKEN_URL'),
    dvsaMotScopeUrl: str('DVSA_MOT_SCOPE_URL', 'https://tapi.dvsa.gov.uk/.default'),
    companiesHouseApiKey: str('COMPANIES_HOUSE_API_KEY'),
    esignSecret: str('ESIGN_SECRET'),
  };
  const cfg: AppConfig = {
    env: envName === 'test' || envName === 'production' ? envName : 'development',
    port: int('PORT', 4000),
    // Loopback by default: never expose claimant data on the LAN unless HOST is set deliberately (and the login pre-fill is off).
    host: str('HOST', '127.0.0.1')!,
    databasePath: str('DATABASE_PATH', path.join(dataDir, 'claimdesk.sqlite'))!,
    evidenceDir: str('EVIDENCE_DIR', path.join(dataDir, 'evidence'))!,
    documentsDir: str('DOCUMENTS_DIR', path.join(dataDir, 'documents'))!,
    chromiumPath: str('CHROMIUM_PATH'),
    webDistDir: str('WEB_DIST_DIR', path.resolve(process.cwd(), '../web/dist'))!,
    keys,
    keysPresent: keysPresence(keys),
    defaultUserId: str('DEFAULT_USER_ID', 'handler')!,
    lookupTimeoutMs: int('LOOKUP_TIMEOUT_MS', 10_000),
    corsOrigins: parseCorsOrigins(str('CORS_ORIGINS')),
    authMode: resolveAuthMode(envName === 'test' || envName === 'production' ? envName : 'development', str('AUTH_MODE')),
    defaultLoginUsername: str('DEFAULT_LOGIN_USERNAME', DEFAULT_LOGIN.username)!,
    defaultLoginPassword: str('DEFAULT_LOGIN_PASSWORD', DEFAULT_LOGIN.password)!,
    loginPrefill: bool('LOGIN_PREFILL', true),
    sessionTtlHours: int('SESSION_TTL_HOURS', 12),
    cookieSecure: bool('COOKIE_SECURE', envName === 'production'),
    esignDelivery: str('ESIGN_DELIVERY')?.trim().toLowerCase() === 'handler' ? 'handler' : 'external',
    trustProxy: parseTrustProxy(str('TRUST_PROXY')),
    totalCarCheckUrlTemplate: parseTotalCarCheckTemplate(str('TOTALCARCHECK_URL_TEMPLATE')),
    ...overrides,
  };
  if (cfg.authMode === 'header' && cfg.env === 'production') throw new Error('AUTH_MODE=header is not allowed in production: X-User-Id is not authentication');
  if (!(cfg.sessionTtlHours > 0)) throw new Error('SESSION_TTL_HOURS must be a positive number');
  if (cfg.chromiumPath) process.env.CHROMIUM_PATH = cfg.chromiumPath;
  return cfg;
}

/**
 * Config for tests: in-memory database, no keys, a fresh scratch directory per app under the OS temp dir
 * (`<tmp>/claimdesk-api-tests/<uuid>/{evidence,documents}`) — `test/helpers.ts` removes it on close.
 */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const keys: ApiKeys = {};
  const scratch = path.join(os.tmpdir(), 'claimdesk-api-tests', randomUUID());
  return {
    env: 'test',
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    evidenceDir: path.join(scratch, 'evidence'),
    documentsDir: path.join(scratch, 'documents'),
    webDistDir: path.join(scratch, 'no-web-dist'),
    keys,
    keysPresent: keysPresence(keys),
    defaultUserId: 'handler',
    lookupTimeoutMs: 2_000,
    corsOrigins: [...LOCALHOST_ORIGINS],
    // Header mode keeps the existing X-User-Id / default-user tests working; auth tests override with 'session'.
    authMode: 'header',
    defaultLoginUsername: DEFAULT_LOGIN.username,
    defaultLoginPassword: DEFAULT_LOGIN.password,
    loginPrefill: true,
    sessionTtlHours: 12,
    esignDelivery: 'external',
    trustProxy: 'loopback',
    totalCarCheckUrlTemplate: TOTAL_CAR_CHECK_URL_TEMPLATE,
    ...overrides,
    // Mirror loadConfig: production defaults to Secure cookies unless the override says otherwise.
    cookieSecure: overrides.cookieSecure ?? overrides.env === 'production',
  };
}

/** The per-test scratch root (parent of evidence/documents), for cleanup. */
export function scratchRoot(config: AppConfig): string {
  return path.dirname(config.evidenceDir);
}
