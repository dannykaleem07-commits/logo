/**
 * ClaimDesk API entry point: load config, create data directories, open the database (migrations run on boot), make
 * sure the owner's sign-in account exists (ensureDefaultLogin), build the Fastify app and listen.
 * `pnpm --filter @ccguk/api dev` (tsx watch) or `start`.
 */
import { loadConfig } from './config.js';
import { buildContext, ensureDataDirs } from './context.js';
import { buildApp } from './app.js';
import { ensureDefaultLogin, prefillExposureWarning } from './services/auth.js';
import { lookupModeFor } from './services/lookup.js';
import { neutraliseAnthropicEnv } from './ai/apiKeyDriver.js';

export async function start(): Promise<void> {
  // No ANTHROPIC_* variable may steer the AI drivers (§A.2, §K.2): the key and host come from ClaimDesk only.
  const removedEnv = neutraliseAnthropicEnv();
  const config = loadConfig();
  ensureDataDirs(config);
  const ctx = buildContext({ config });
  const login = await ensureDefaultLogin(ctx);
  const exposure = prefillExposureWarning(ctx);
  if (exposure) ctx.logger.warn(exposure, { host: config.host, env: config.env });
  if (removedEnv.length) ctx.logger.warn('ignored ANTHROPIC_* environment variables (ClaimDesk sets the AI host and key itself)', { removed: removedEnv });
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
    templatesDir: config.templatesDir,
    docxPdfConverter: config.docxPdfConverter,
    kbData: ctx.kb.dataDir ?? 'not found',
    lookups: { ...config.keysPresent, mode: lookupModeFor(ctx) },
    auth: config.authMode,
    signIn: { username: login.username, created: login.created, prefill: config.loginPrefill },
  });
}

const invokedDirectly = process.argv[1] !== undefined && /server\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
