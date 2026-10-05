/**
 * @ccguk/db — SQLite persistence for ClaimDesk: Drizzle schema, migrations, repositories, claim bundle.
 *
 *   const handle = createDatabase({ path: 'data/claimdesk.sqlite' });
 *   runMigrations(handle.db);
 *   const claim = createClaim(handle.db, {...});
 *   const bundle = loadClaimBundle(handle.db, claim.id);
 */
export * as schema from './schema.js';
export type * from './schema.js';
export { createDatabase, closeDatabase } from './client.js';
export type { Db, DbClient, DatabaseHandle, CreateDatabaseOptions } from './client.js';
export { runMigrations, migrationsFolder } from './migrate.js';
export { pendingMigrationCount, backupDatabase, backupBeforeMigrate, backupFileName, pruneBackups, readMigrationJournal, BACKUP_PREFIX, BACKUPS_KEPT } from './backup.js';
export type { BackupBeforeMigrateOptions, BackupBeforeMigrateResult } from './backup.js';
export * from './errors.js';
export { newId, nowIso, denull, normaliseRegistration, normalisePhone, normaliseEmail, normalisePostcode, bankKey, chargeableDays } from './util.js';
export type { Denulled } from './util.js';
export * from './repos/index.js';
export { loadClaimBundle } from './bundle.js';
export type { LoadClaimBundleOptions } from './bundle.js';
export { createTestDatabase } from './testing.js';
export { seedFileOne, FILE_ONE } from './fixtures/fileOne.js';
export type { FileOneIds } from './fixtures/fileOne.js';
