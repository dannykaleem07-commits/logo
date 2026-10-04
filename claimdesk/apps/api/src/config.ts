/**
 * Process configuration for @ccguk/api. Read once from the environment (dotenv is loaded here, never elsewhere).
 * API keys are never exposed through the API — only their presence flags (Settings.apiKeysPresent).
 */
import { config as loadDotenv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

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
    port: int('PORT', 3000),
    host: str('HOST', '0.0.0.0')!,
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
    ...overrides,
  };
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
    ...overrides,
  };
}

/** The per-test scratch root (parent of evidence/documents), for cleanup. */
export function scratchRoot(config: AppConfig): string {
  return path.dirname(config.evidenceDir);
}
