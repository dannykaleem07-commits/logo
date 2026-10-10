import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { DbClient } from './client.js';
import { DbError } from './errors.js';

/** Absolute path of the `drizzle/` migrations folder, resolved relative to this module (works from source or dist). */
export const migrationsFolder: string = fileURLToPath(new URL('../drizzle', import.meta.url));

/** Thrown at boot when a journal migration would be silently skipped (docs/SUPREME-AUTOPILOT.md §G.1 guard 2). */
export class MigrationOrderError extends DbError {
  readonly tags: string[];
  constructor(tags: string[], lastAppliedWhen: number) {
    super(
      'MIGRATION_ORDER',
      `Migration ${tags.join(', ')} has a journal "when" earlier than the last applied migration (${lastAppliedWhen}) and was never applied; ` +
        'the database migrator would skip it silently. ClaimDesk refuses to start rather than run with a missing table — restore the pre-upgrade backup or install a build whose migrations are in order.',
    );
    this.tags = tags;
  }
}

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function journalEntries(folder: string): JournalEntry[] {
  const parsed = JSON.parse(readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8')) as { entries?: unknown };
  if (!Array.isArray(parsed.entries)) return [];
  return parsed.entries.filter((e): e is JournalEntry => typeof e === 'object' && e !== null && typeof (e as JournalEntry).when === 'number' && typeof (e as JournalEntry).tag === 'string');
}

/**
 * The journal entries drizzle would never apply: `when` earlier than the latest applied migration and not applied
 * themselves (drizzle applies only `when` > last applied, `lastDbMigration.created_at < migration.folderMillis`).
 * Empty on a new database and on a database whose migrations are in order.
 */
export function skippedMigrations(db: DbClient, folder: string = migrationsFolder): { tags: string[]; lastAppliedWhen: number | null } {
  const sqlite = db.$client;
  const table = sqlite.prepare("select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'").get();
  if (!table) return { tags: [], lastAppliedWhen: null };
  const applied = (sqlite.prepare('select created_at as createdAt from __drizzle_migrations').all() as Array<{ createdAt: number | string | null }>)
    .map((r) => Number(r.createdAt))
    .filter((n) => Number.isFinite(n));
  if (!applied.length) return { tags: [], lastAppliedWhen: null };
  const last = Math.max(...applied);
  const appliedSet = new Set(applied);
  const tags = journalEntries(folder)
    .filter((e) => e.when < last && !appliedSet.has(e.when))
    .map((e) => e.tag);
  return { tags, lastAppliedWhen: last };
}

/**
 * Apply all pending migrations (idempotent — drizzle records applied migrations in `__drizzle_migrations`).
 * Call once at startup after `createDatabase()`. Refuses with MIGRATION_ORDER (before touching anything) when a journal
 * entry would be silently skipped.
 */
export function runMigrations(db: DbClient, options: { migrationsFolder?: string } = {}): void {
  const folder = options.migrationsFolder ?? migrationsFolder;
  const skipped = skippedMigrations(db, folder);
  if (skipped.tags.length) throw new MigrationOrderError(skipped.tags, skipped.lastAppliedWhen ?? 0);
  migrate(db, { migrationsFolder: folder });
}
