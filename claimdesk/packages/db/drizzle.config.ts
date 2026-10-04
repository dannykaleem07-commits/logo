import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config. Generate migrations with:
 *   pnpm --filter @ccguk/db exec drizzle-kit generate
 * (run from the workspace root). Migrations are applied at runtime by `runMigrations()` in src/migrate.ts.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.CLAIMDESK_DB_PATH ?? './data/claimdesk.sqlite' },
  strict: true,
  verbose: true,
});
