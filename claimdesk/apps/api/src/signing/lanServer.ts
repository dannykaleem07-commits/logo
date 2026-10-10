// owned by ap-paperwork
/**
 * Optional LAN signing listener (docs/SUPREME-AUTOPILOT.md §E.3; off by default). With `SIGNING_LAN=1` or Settings >
 * Autopilot > Signing "LAN tablet" on, a SECOND Fastify listener starts on SIGNING_LAN_HOST (default: this PC's first
 * LAN IPv4 address) and SIGNING_LAN_PORT (default 5181). It serves only:
 *
 *   GET  /sign/kiosk/:token      the web app's page bundle (index.html), which renders the kiosk screen
 *   GET  /assets/*               the bundle's static files
 *   *    /api/kiosk/*            forwarded in-process to the main app's token-authenticated kiosk routes — without
 *                                cookies or authorization headers, with the tablet's address as X-Forwarded-For
 *
 * Nothing else of the API is reachable from the network (everything else is 404). Plain HTTP on the office network:
 * the Settings screen and the kiosk QR panel say so; kiosk tokens are single-pack, expire in 30 minutes and are
 * pinned to the first device that opens them.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { AppContext } from '../context.js';
import { signingSettings } from './common.js';

export const DEFAULT_SIGNING_LAN_PORT = 5181;

let running: { app?: FastifyInstance; baseUrl: string } | undefined;

/** `http://<lan address>:<port>` while the LAN listener runs; undefined when it is off. */
export function lanKioskBaseUrl(): string | undefined {
  return running?.baseUrl;
}

/** The PC's first non-internal IPv4 address (what a tablet on the same Wi-Fi reaches). */
export function lanAddress(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return undefined;
}

const FORWARD_HEADERS = ['content-type', 'user-agent', 'accept', 'accept-language'] as const;

/** The LAN app (exported for tests, which drive it with inject and never listen). */
export async function buildSigningLanApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: false });
  const webDist = ctx.config.webDistDir;
  const indexHtml = path.join(webDist, 'index.html');
  const assets = path.join(webDist, 'assets');
  if (existsSync(assets)) await app.register(fastifyStatic, { root: assets, prefix: '/assets/', wildcard: true, index: false });

  app.get('/sign/kiosk/:token', async (_request, reply) => {
    if (!existsSync(indexHtml)) return reply.status(404).type('text/plain').send('The signing screen is not installed on this PC.');
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(readFileSync(indexHtml));
  });

  // The kiosk page asks who is signed in on start-up; on the LAN nobody is.
  app.get('/api/auth/me', async (_request, reply) => reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Not available on the signing network' } }));

  app.route({
    method: ['GET', 'POST'],
    url: '/api/kiosk/*',
    handler: async (request, reply) => {
      if (!ctx.inject) return reply.status(503).send({ error: { code: 'UNAVAILABLE', message: 'ClaimDesk is starting' } });
      const headers: Record<string, string> = { 'x-forwarded-for': request.ip, 'x-claimdesk-lan': '1' };
      for (const h of FORWARD_HEADERS) {
        const v = request.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      const res = await ctx.inject({
        method: request.method as 'GET' | 'POST',
        url: request.url,
        headers,
        ...(request.body !== undefined ? { payload: typeof request.body === 'string' ? request.body : JSON.stringify(request.body) } : {}),
      });
      const type = res.headers['content-type'];
      if (typeof type === 'string') reply.header('content-type', type);
      reply.header('cache-control', 'no-store');
      return reply.status(res.statusCode).send(res.rawPayload);
    },
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Only the signing kiosk is available on this network' } }));
  return app;
}

/** Start the LAN listener when it is switched on. Never throws past server.ts (the main app keeps running). */
export async function startSigningLanServer(ctx: AppContext): Promise<void> {
  const enabled = process.env.SIGNING_LAN === '1' || signingSettings(ctx).lanKiosk;
  if (!enabled || running) return;
  const host = process.env.SIGNING_LAN_HOST?.trim() || lanAddress();
  if (!host) {
    ctx.logger.warn('signing LAN listener is on but this PC has no network address; the kiosk stays on this PC only');
    return;
  }
  const port = Number(process.env.SIGNING_LAN_PORT ?? DEFAULT_SIGNING_LAN_PORT) || DEFAULT_SIGNING_LAN_PORT;
  const app = await buildSigningLanApp(ctx);
  await app.listen({ host, port });
  running = { app, baseUrl: `http://${host}:${port}` };
  ctx.logger.warn('signing kiosk available on the office network over plain HTTP (no TLS): use only on a trusted Wi-Fi', { url: running.baseUrl });
}

/** Stop the LAN listener (tests and shutdown). */
export async function stopSigningLanServer(): Promise<void> {
  const r = running;
  running = undefined;
  if (r?.app) await r.app.close();
}

/** Test hook: pretend the LAN listener runs at `baseUrl` (no socket is opened). */
export function setLanBaseUrlForTests(baseUrl: string | undefined): void {
  running = baseUrl ? { ...(running?.app ? { app: running.app } : {}), baseUrl } : undefined;
}
