/**
 * ClaimDesk API entry point: load config, create data directories, open the database (migrations run on boot),
 * build the Fastify app and listen. `pnpm --filter @ccguk/api dev` (tsx watch) or `start`.
 */
import { loadConfig } from './config.js';
import { buildContext, ensureDataDirs } from './context.js';
import { buildApp } from './app.js';

export async function start(): Promise<void> {
  const config = loadConfig();
  ensureDataDirs(config);
  const ctx = buildContext({ config });
  const app = await buildApp(ctx);
  const shutdown = async (signal: string) => {
    ctx.logger.info('shutting down', { signal });
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  await app.listen({ port: config.port, host: config.host });
  ctx.logger.info('ClaimDesk API listening', {
    port: config.port,
    database: config.databasePath,
    evidenceDir: config.evidenceDir,
    documentsDir: config.documentsDir,
    kbData: ctx.kb.dataDir ?? 'not found',
    lookups: config.keysPresent,
  });
}

const invokedDirectly = process.argv[1] !== undefined && /server\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
