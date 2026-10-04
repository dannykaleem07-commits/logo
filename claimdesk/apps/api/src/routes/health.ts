import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { engineStatus } from '../engines.js';

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', async () => {
    let dbOk = true;
    try {
      ctx.handle.sqlite.prepare('select 1').get();
    } catch {
      dbOk = false;
    }
    return {
      ok: dbOk,
      service: '@ccguk/api',
      time: ctx.now(),
      env: ctx.config.env,
      database: dbOk ? 'ok' : 'error',
      lookups: ctx.config.keysPresent,
      kbData: Boolean(ctx.kb.dataDir),
      engines: engineStatus(),
    };
  });
}
