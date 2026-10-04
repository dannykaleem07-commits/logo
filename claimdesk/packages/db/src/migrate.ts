import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { DbClient } from './client.js';

/** Absolute path of the `drizzle/` migrations folder, resolved relative to this module (works from source or dist). */
export const migrationsFolder: string = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * Apply all pending migrations (idempotent — drizzle records applied migrations in `__drizzle_migrations`).
 * Call once at startup after `createDatabase()`.
 */
export function runMigrations(db: DbClient, options: { migrationsFolder?: string } = {}): void {
  migrate(db, { migrationsFolder: options.migrationsFolder ?? migrationsFolder });
}
