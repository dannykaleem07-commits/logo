import { createDatabase, type DatabaseHandle } from './client.js';
import { runMigrations } from './migrate.js';

/** In-memory database with all migrations applied — for vitest in this and dependent packages. */
export function createTestDatabase(): DatabaseHandle {
  const handle = createDatabase({ path: ':memory:' });
  runMigrations(handle.db);
  return handle;
}
