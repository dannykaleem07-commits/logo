import Database from 'better-sqlite3';
import type { Database as SqliteDatabase, RunResult } from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import * as schema from './schema.js';

/**
 * The database handle every repository function accepts. It is the common base of the drizzle
 * connection and of a `db.transaction((tx) => ...)` transaction object, so repos work inside either.
 */
export type Db = BaseSQLiteDatabase<'sync', RunResult, typeof schema>;

/** The concrete drizzle connection (needed by the migrator). */
export type DbClient = BetterSQLite3Database<typeof schema> & { $client: SqliteDatabase };

export interface DatabaseHandle {
  /** The raw better-sqlite3 connection (pragmas, backups, `exec`). */
  sqlite: SqliteDatabase;
  /** The drizzle connection. */
  db: DbClient;
  path: string;
}

export interface CreateDatabaseOptions {
  /** File path, or ':memory:' for an in-memory database (tests). */
  path: string;
  /** Milliseconds to wait on a locked database before SQLITE_BUSY. Default 5000. */
  busyTimeoutMs?: number;
  /** Open read-only. Default false. */
  readonly?: boolean;
  /** Pass better-sqlite3 verbose logger (e.g. console.log) to trace SQL. */
  verbose?: (message?: unknown, ...rest: unknown[]) => void;
}

/**
 * Open (or create) the SQLite database with the production pragmas:
 * WAL journal (file databases), foreign keys on, busy timeout, synchronous=NORMAL.
 */
export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  const sqlite = new Database(options.path, {
    readonly: options.readonly ?? false,
    timeout: options.busyTimeoutMs ?? 5000,
    verbose: options.verbose,
  });
  const inMemory = options.path === ':memory:' || options.path === '';
  if (!inMemory && !options.readonly) {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
  }
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  const db = drizzle(sqlite, { schema }) as DbClient;
  return { sqlite, db, path: options.path };
}

/** Close the connection. Safe to call twice. */
export function closeDatabase(handle: DatabaseHandle): void {
  if (handle.sqlite.open) handle.sqlite.close();
}
