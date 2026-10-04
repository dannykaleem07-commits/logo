/**
 * `pnpm --filter @ccguk/api seed` — development seed: the owner's sign-in account (ensureDefaultLogin — always, even
 * when the database already has claims), users (handler/approver/admin/engineer), settings with the rate
 * card, the four live-file archetypes (File 1 from @ccguk/db; Files 2–4 in src/seed/archetypes.ts) with chronologies,
 * ledgers, offers, hire/storage/recovery, programmatically generated PNG evidence, CARFLEX LTD (12640635) on the
 * watch list as high risk, two fleet units and one Collingwood policy covering credit_hire only. Idempotent: skipped
 * when the database already has claims.
 */
import { loadConfig } from './config.js';
import { buildContext, ensureDataDirs } from './context.js';
import { seedArchetypes, type SeedSummary } from './seed/archetypes.js';
import { ensureDefaultLogin } from './services/auth.js';

export async function seed(): Promise<SeedSummary | undefined> {
  const config = loadConfig();
  ensureDataDirs(config);
  const ctx = buildContext({ config });
  try {
    const login = await ensureDefaultLogin(ctx);
    ctx.logger.info(login.created ? 'seed: sign-in account created' : 'seed: sign-in account already exists', { username: login.username, userId: login.userId });
    const existing = ctx.repos.listClaims(ctx.db, { limit: 1 });
    if (existing.length) {
      ctx.logger.info('seed: database already has claims — nothing to do', { database: config.databasePath });
      return undefined;
    }
    const summary = await seedArchetypes(ctx);
    ctx.logger.info('seed: four archetype files created', { database: config.databasePath, ...summary });
    return summary;
  } finally {
    ctx.close();
  }
}

const invokedDirectly = process.argv[1] !== undefined && /seed\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  seed().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
