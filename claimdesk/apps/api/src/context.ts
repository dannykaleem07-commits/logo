/**
 * AppContext — everything a route needs: the database, the repositories, settings, knowledge-base loaders,
 * an injectable clock and a logger. Built once per process (or per test).
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as db from '@ccguk/db';
import type { DatabaseHandle, Db, Settings } from '@ccguk/db';
import type { GtaRate, InsurerDirectoryEntry, ISODateTime, KbEntry } from '@ccguk/domain';
import * as kbPkg from '@ccguk/kb';
import { loadConfig, type AppConfig } from './config.js';
import { resolveEngines, type DomainEngines } from './engines.js';
import { syncBuiltinTemplates } from './services/docxTemplates.js';

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface KbLoaders {
  gtaRates(): GtaRate[];
  entries(): KbEntry[];
  directory(): InsurerDirectoryEntry[];
  playbookRules(): unknown[];
  /** Absolute path of packages/kb/data, or undefined when it cannot be located. */
  dataDir: string | undefined;
}

export interface AppContext {
  config: AppConfig;
  handle: DatabaseHandle;
  db: Db;
  /** The whole @ccguk/db repository surface (createClaim, appendLedgerEntry, …). */
  repos: typeof db;
  settings(): Settings;
  kb: KbLoaders;
  /** Injectable clock: tests freeze it. */
  now(): ISODateTime;
  engines(): DomainEngines;
  logger: Logger;
  close(): void;
}

export interface BuildContextOptions {
  config?: AppConfig;
  now?: () => ISODateTime;
  logger?: Logger;
  /** Run migrations on the opened database (default true). */
  migrate?: boolean;
}

export const consoleLogger: Logger = {
  info: (msg, meta) => console.log(JSON.stringify({ level: 'info', msg, ...meta })),
  warn: (msg, meta) => console.warn(JSON.stringify({ level: 'warn', msg, ...meta })),
  error: (msg, meta) => console.error(JSON.stringify({ level: 'error', msg, ...meta })),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Locate packages/kb/data whether the API runs from source, from a workspace clone or from dist. */
export function locateKbDataDir(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@ccguk/kb');
    const candidate = path.resolve(path.dirname(entry), '..', 'data');
    if (existsSync(candidate)) return candidate;
  } catch {
    /* fall through to the directory walk */
  }
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'packages', 'kb', 'data');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function jsonLoader<T>(dataDir: string | undefined, file: string, logger: Logger): () => T[] {
  let cache: T[] | undefined;
  return () => {
    if (cache) return cache;
    if (!dataDir) return (cache = []);
    const p = path.join(dataDir, file);
    if (!existsSync(p)) return (cache = []);
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown;
      cache = Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch (err) {
      logger.warn(`kb: could not parse ${file}`, { error: String(err) });
      cache = [];
    }
    return cache;
  };
}

export function buildKbLoaders(logger: Logger): KbLoaders {
  const dataDir = locateKbDataDir();
  const files = ['cases.json', 'statutes.json', 'cpr.json', 'gta.json', 'fca.json', 'fos.json', 'guidance.json'];
  const loaders = files.map((f) => jsonLoader<KbEntry>(dataDir, f, logger));
  let entriesCache: KbEntry[] | undefined;
  const raw = {
    gtaRates: jsonLoader<GtaRate>(dataDir, 'gta-rates.json', logger),
    directory: jsonLoader<InsurerDirectoryEntry>(dataDir, 'insurer-directory.json', logger),
    playbookRules: jsonLoader<unknown>(dataDir, 'playbook-rules.json', logger),
    entries: () => {
      if (!entriesCache) entriesCache = loaders.flatMap((l) => l());
      return entriesCache;
    },
  };
  // Prefer the validated @ccguk/kb loaders; fall back to the raw JSON only if validation throws (logged).
  const viaKb = <T>(name: string, fn: () => T, fallback: () => T): (() => T) => {
    let cache: T | undefined;
    return () => {
      if (cache !== undefined) return cache;
      try {
        cache = fn();
      } catch (err) {
        logger.warn(`kb: @ccguk/kb ${name} failed validation; serving raw JSON`, { error: String(err) });
        cache = fallback();
      }
      return cache;
    };
  };
  return {
    dataDir,
    gtaRates: viaKb('loadGtaRates', () => kbPkg.loadGtaRates(), raw.gtaRates),
    directory: viaKb('loadDirectory', () => kbPkg.loadDirectory(), raw.directory),
    playbookRules: viaKb<unknown[]>('loadPlaybookRules', () => kbPkg.loadPlaybookRules(), raw.playbookRules),
    entries: viaKb('loadAll', () => kbPkg.loadAll(), raw.entries),
  };
}

/** Fixed id of the development handler: the user assumed in header auth mode (tests) when X-User-Id is omitted. Has no password, so it cannot sign in. */
export const DEFAULT_HANDLER = { id: 'handler', name: 'Default handler (dev)', email: 'handler@ccguk.local', role: 'handler' as const };

export function ensureDefaultUser(database: Db, id: string): void {
  if (db.getUser(database, id)) return;
  db.createUser(database, { ...DEFAULT_HANDLER, id, mfaEnabled: false });
}

/** Temp folder for DOCX → PDF conversions (<DATA_DIR>/tmp/convert, §A.11). */
export function convertWorkDir(config: AppConfig): string {
  return path.join(config.dataDir, 'tmp', 'convert');
}

export function ensureDataDirs(config: AppConfig): void {
  for (const dir of [config.evidenceDir, config.documentsDir, config.templatesDir, convertWorkDir(config)]) mkdirSync(dir, { recursive: true });
  if (config.databasePath !== ':memory:') mkdirSync(path.dirname(config.databasePath), { recursive: true });
}

export function buildContext(options: BuildContextOptions = {}): AppContext {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? (config.env === 'test' ? silentLogger : consoleLogger);
  const handle = db.createDatabase({ path: config.databasePath });
  if (options.migrate ?? true) db.runMigrations(handle.db);
  ensureDefaultUser(handle.db, config.defaultUserId);
  // Settings carry the presence flags so the UI can show which lookups are live (keys themselves never leave the process).
  const current = db.getSettings(handle.db);
  const presence = config.keysPresent;
  const stale = (Object.keys(presence) as Array<keyof typeof presence>).some((k) => current.apiKeysPresent[k] !== presence[k]);
  if (stale) db.patchSettings(handle.db, { apiKeysPresent: presence }, db.SYSTEM_ACTOR);
  const ctx: AppContext = {
    config,
    handle,
    db: handle.db,
    repos: db,
    settings: () => db.getSettings(handle.db),
    kb: buildKbLoaders(logger),
    now: options.now ?? (() => new Date().toISOString()),
    engines: resolveEngines,
    logger,
    close: () => db.closeDatabase(handle),
  };
  // Built-in Word templates: cache their scans in document_templates once per boot (never throws; a failure marks the
  // template inactive with a warning — TEMPLATES-VEHICLES-DESKTOP §C.4).
  if (options.migrate ?? true) syncBuiltinTemplates(ctx);
  return ctx;
}
