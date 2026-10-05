/**
 * Backup before migrating (docs/V03-MANAGER-MODE-HIRE-PRICING.md §F.2.2). When an upgraded ClaimDesk opens an existing
 * database that still has migrations to apply, the API start-up copies the database first so the owner can always go
 * back to the file as it was before the upgrade.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseHandle } from './client.js';
import { migrationsFolder } from './migrate.js';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/** Journal entries of a drizzle migrations folder (`<folder>/meta/_journal.json`). */
export function readMigrationJournal(folder: string = migrationsFolder): JournalEntry[] {
  const file = path.join(folder, 'meta', '_journal.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entries?: unknown };
  if (!Array.isArray(parsed.entries)) return [];
  return parsed.entries.filter(
    (e): e is JournalEntry => typeof e === 'object' && e !== null && typeof (e as JournalEntry).when === 'number' && typeof (e as JournalEntry).tag === 'string',
  );
}

/**
 * How many journal entries drizzle would apply on the next `runMigrations`: the entries whose `when` is later than the
 * last applied `__drizzle_migrations.created_at` (drizzle's own rule), or all of them when the table does not exist yet.
 */
export function pendingMigrationCount(handle: Pick<DatabaseHandle, 'sqlite'>, folder: string = migrationsFolder): number {
  const entries = readMigrationJournal(folder);
  const table = handle.sqlite.prepare("select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'").get();
  if (!table) return entries.length;
  const last = handle.sqlite.prepare('select created_at as createdAt from __drizzle_migrations order by created_at desc limit 1').get() as { createdAt: number | string | null } | undefined;
  if (!last || last.createdAt === null || last.createdAt === undefined) return entries.length;
  const lastWhen = Number(last.createdAt);
  return entries.filter((e) => e.when > lastWhen).length;
}

/**
 * Write a consistent copy of the open database to `destFile` with `VACUUM INTO` (safe while the database is in WAL
 * mode: the copy includes committed WAL content). Creates the parent folder; refuses to overwrite an existing file.
 */
export function backupDatabase(handle: Pick<DatabaseHandle, 'sqlite'>, destFile: string): void {
  if (existsSync(destFile)) throw new Error(`backup file already exists: ${destFile}`);
  mkdirSync(path.dirname(destFile), { recursive: true });
  try {
    handle.sqlite.prepare('VACUUM INTO ?').run(destFile);
  } catch (err) {
    // Leave no half-written backup behind.
    rmSync(destFile, { force: true });
    throw err;
  }
}

/** Prefix of the automatic pre-upgrade backups (`<data>/backups/claimdesk-before-<version>-<yyyyMMdd-HHmmss>.sqlite`). */
export const BACKUP_PREFIX = 'claimdesk-before-';
/** How many automatic backups are kept (newest first). */
export const BACKUPS_KEPT = 5;

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** `claimdesk-before-0.3.12-20261005-104200.sqlite` (local time of the PC; the version is made file-name safe). */
export function backupFileName(version: string, at: Date): string {
  const safeVersion = version.replace(/[^0-9A-Za-z.+-]/g, '_') || 'unknown';
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${BACKUP_PREFIX}${safeVersion}-${stamp}.sqlite`;
}

/**
 * Delete all but the newest `keep` automatic backups in `dir` (by modification time; `justWritten` always counts as the
 * newest). Returns the deleted paths.
 */
export function pruneBackups(dir: string, keep: number = BACKUPS_KEPT, justWritten?: string): string[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith('.sqlite'))
    .map((name) => {
      const full = path.join(dir, name);
      return { full, name, mtime: statSync(full).mtimeMs };
    })
    .sort((a, b) => Number(b.full === justWritten) - Number(a.full === justWritten) || b.mtime - a.mtime || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const removed: string[] = [];
  for (const f of files.slice(Math.max(0, keep))) {
    rmSync(f.full, { force: true });
    removed.push(f.full);
  }
  return removed;
}

export interface BackupBeforeMigrateOptions {
  /** The database file path (`:memory:` is never backed up). */
  databasePath: string;
  /** Whether the file existed before it was opened (a brand-new database has nothing to keep). */
  existedBefore: boolean;
  /** The version that is about to migrate the database (goes into the file name). */
  version: string;
  /** Default: the current time. */
  now?: Date;
  /** Default BACKUPS_KEPT. */
  keep?: number;
  /** Migrations folder (default the package's own). */
  folder?: string;
}

export interface BackupBeforeMigrateResult {
  /** Migrations that the next runMigrations will apply. */
  pending: number;
  /** The backup written, when one was needed. */
  file?: string;
  /** Older backups deleted to keep the newest `keep`. */
  removed: string[];
  /** Why no backup was written. */
  skipped?: 'memory' | 'new_database' | 'up_to_date';
}

/**
 * The start-up rule (§F.2.2): a file database that existed before it was opened and has pending migrations is copied to
 * `<dirname(databasePath)>/backups/claimdesk-before-<version>-<stamp>.sqlite` before the migrations run; the newest
 * `keep` backups are kept. Throws when the backup cannot be written — the caller logs a warning and carries on.
 */
export function backupBeforeMigrate(handle: Pick<DatabaseHandle, 'sqlite'>, options: BackupBeforeMigrateOptions): BackupBeforeMigrateResult {
  const { databasePath } = options;
  if (databasePath === ':memory:' || databasePath === '') return { pending: 0, removed: [], skipped: 'memory' };
  const pending = pendingMigrationCount(handle, options.folder);
  if (!options.existedBefore) return { pending, removed: [], skipped: 'new_database' };
  if (pending === 0) return { pending, removed: [], skipped: 'up_to_date' };
  const dir = path.join(path.dirname(databasePath), 'backups');
  const base = backupFileName(options.version, options.now ?? new Date());
  let file = path.join(dir, base);
  for (let n = 2; existsSync(file); n += 1) file = path.join(dir, base.replace(/\.sqlite$/, `-${n}.sqlite`));
  backupDatabase(handle, file);
  const removed = pruneBackups(dir, options.keep ?? BACKUPS_KEPT, file);
  return { pending, file, removed };
}
