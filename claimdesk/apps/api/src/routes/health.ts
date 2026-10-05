import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { engineStatus } from '../engines.js';
import { lookupModeFor } from '../services/lookup.js';

let packageVersion: string | undefined;

/**
 * The ClaimDesk version: CLAIMDESK_VERSION (set by the desktop launcher from app/version.json, or by CI), else the
 * root package.json version (apps/api/src/routes → ../../../../package.json, the same path inside the packaged app).
 */
export function appVersion(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CLAIMDESK_VERSION?.trim();
  if (fromEnv) return fromEnv;
  if (packageVersion === undefined) {
    try {
      const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'package.json');
      const v = (JSON.parse(readFileSync(root, 'utf8')) as { version?: unknown }).version;
      packageVersion = typeof v === 'string' && v.trim() ? v.trim() : '0.0.0';
    } catch {
      packageVersion = '0.0.0';
    }
  }
  return packageVersion;
}

/** 'demo' only when the launcher started the example-claims dataset; everything else is live data. */
export function datasetOf(env: NodeJS.ProcessEnv = process.env): 'live' | 'demo' {
  return env.CLAIMDESK_DATASET?.trim().toLowerCase() === 'demo' ? 'demo' : 'live';
}

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
      version: appVersion(),
      dataset: datasetOf(),
      // the desktop launcher's "Stop ClaimDesk" shortcut terminates this process (after checking `dataset`)
      pid: process.pid,
      time: ctx.now(),
      env: ctx.config.env,
      database: dbOk ? 'ok' : 'error',
      lookups: { ...ctx.config.keysPresent, mode: lookupModeFor(ctx) },
      kbData: Boolean(ctx.kb.dataDir),
      engines: engineStatus(),
    };
  });
}
