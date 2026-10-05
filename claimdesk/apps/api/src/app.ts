/**
 * buildApp(ctx) → Fastify instance. Plugins: CORS, multipart (25 MB files), static web app (SPA fallback) when
 * apps/web/dist exists. Error handler maps zod → 400 VALIDATION, NotFound → 404, Immutable → 409. A request id is
 * attached to every reply; the auth hook sets `request.user` / `request.actor` (every audit row records the real user):
 *  - authMode 'session' (development, production): the HttpOnly `claimdesk_session` cookie. Every /api route needs a
 *    valid session except PUBLIC_API_ROUTES; everything outside /api (the built SPA) is public.
 *  - authMode 'header' (tests only): the legacy X-User-Id header, falling back to config.defaultUserId.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { DbError, DocumentStateError, ImmutableError, NotFoundError, ValidationError, VerificationError, type Actor } from '@ccguk/db';
import type { UserRecord } from '@ccguk/db';
import { MANAGER_OVERRIDE_HEADER, MANAGER_OVERRIDES_RESPONSE_HEADER, MANAGER_RELAXED_HEADER, type User } from '@ccguk/domain';
import type { AppContext } from './context.js';
import { HttpError, type OverrideInfo } from './errors.js';
import { registerAllRoutes } from './routes/index.js';
import { readSessionToken, resolveSession } from './services/auth.js';
import { gateFor, peekGate } from './services/override.js';

/** Inline styles are allowed (React style props, docx-preview's generated CSS); scripts, objects and forms are not. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self' blob: data:",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface RequestUser extends User {
  username?: string;
  /** True when the user came from the dev/test default (header mode) rather than a header or a session. */
  assumed: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user. Always set on protected routes; undefined on a public route called without a session. */
    user: RequestUser;
    requestId: string;
    actor: Actor;
    /** sessions.id (sha256 of the cookie token) when the request carries a valid session. */
    sessionId: string | undefined;
  }
}

/** /api routes reachable without a session (matched against the route pattern, not the raw URL). */
export const PUBLIC_API_ROUTES: ReadonlySet<string> = new Set(['/api/health', '/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/auth/login-defaults']);

/** Anything under /api (including the bare prefix and a query string). */
export const isApiUrl = (url: string): boolean => url === '/api' || url.startsWith('/api/') || url.startsWith('/api?');

/** Actor recorded for an unauthenticated caller (e.g. a failed sign-in). */
export const ANONYMOUS = 'anonymous';

function toRequestUser(u: UserRecord, assumed: boolean): RequestUser {
  const out: RequestUser = { id: u.id, name: u.name, email: u.email, role: u.role, mfaEnabled: u.mfaEnabled, assumed };
  if (u.username !== undefined) out.username = u.username;
  return out;
}

export interface BuildAppOptions {
  /** Override Fastify's logger (tests pass `{ level, stream }` to capture output). */
  logger?: FastifyServerOptions['logger'];
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string; override?: OverrideInfo };
}

export function mapError(err: unknown): { status: number; body: ErrorBody['error'] } {
  if (err instanceof HttpError) {
    const body: ErrorBody['error'] = { code: err.code, message: err.message, details: err.details };
    if (err.override) body.override = err.override;
    return { status: err.statusCode, body };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        code: 'VALIDATION',
        message: 'Request failed validation',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
      },
    };
  }
  if (err instanceof NotFoundError) return { status: 404, body: { code: 'NOT_FOUND', message: err.message, details: { entity: err.entity, id: err.id } } };
  if (err instanceof ImmutableError) return { status: 409, body: { code: 'IMMUTABLE', message: err.message, details: { entity: err.entity } } };
  if (err instanceof DocumentStateError) return { status: 409, body: { code: 'DOCUMENT_STATE', message: err.message, details: { documentId: err.documentId, status: err.status } } };
  if (err instanceof VerificationError) return { status: 409, body: { code: 'VERIFICATION', message: err.message } };
  if (err instanceof ValidationError) return { status: 400, body: { code: 'VALIDATION', message: err.message } };
  if (err instanceof DbError) return { status: 400, body: { code: err.code, message: err.message } };
  const fe = err as Partial<FastifyError>;
  if (typeof fe?.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
    const code = fe.code === 'FST_REQ_FILE_TOO_LARGE' ? 'FILE_TOO_LARGE' : fe.code === 'FST_ERR_VALIDATION' ? 'VALIDATION' : (fe.code ?? 'BAD_REQUEST');
    return { status: fe.statusCode, body: { code, message: fe.message ?? 'Bad request' } };
  }
  return { status: 500, body: { code: 'INTERNAL', message: 'Internal server error' } };
}

export async function buildApp(ctx: AppContext, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  if (ctx.config.authMode === 'header' && ctx.config.env === 'production') throw new Error('authMode "header" is not allowed in production: X-User-Id is not authentication');
  const app = Fastify({
    logger: options.logger ?? (ctx.config.env === 'test' ? false : { level: ctx.config.env === 'production' ? 'info' : 'debug' }),
    genReqId: (req) => (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].length <= 128 ? req.headers['x-request-id'] : randomUUID()),
    bodyLimit: 2 * 1024 * 1024,
    // Who may set X-Forwarded-For (decides request.ip for the login rate limiter and audit rows). Default 'loopback'.
    trustProxy: ctx.config.trustProxy,
  });

  app.decorateRequest('user', undefined as unknown as RequestUser);
  app.decorateRequest('requestId', '');
  app.decorateRequest('actor', undefined as unknown as Actor);
  app.decorateRequest('sessionId', undefined);

  // CORS: localhost origins only unless CORS_ORIGINS lists others (config.ts). Credentials are allowed, so the origin
  // list is never a wildcard by default.
  await app.register(cors, { origin: ctx.config.corsOrigins, credentials: true, exposedHeaders: ['x-request-id', 'x-sha256', 'x-certificate-id', MANAGER_OVERRIDES_RESPONSE_HEADER] });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 10, fields: 50 } });

  // Request id + identity. Everything downstream reads request.user / request.actor.
  app.addHook('onRequest', async (request, reply) => {
    request.requestId = String(request.id);
    reply.header('x-request-id', request.requestId);

    if (ctx.config.authMode === 'header') {
      // Test-only identity (config refuses header mode in production): X-User-Id, else the default user.
      const header = request.headers['x-user-id'];
      const headerId = Array.isArray(header) ? header[0] : header;
      if (headerId) {
        const u = ctx.repos.getUser(ctx.db, headerId);
        if (!u) throw new HttpError(401, 'UNAUTHENTICATED', `Unknown user ${headerId} (X-User-Id)`);
        request.user = toRequestUser(u, false);
      } else {
        if (ctx.config.env === 'production') throw new HttpError(401, 'UNAUTHENTICATED', 'X-User-Id header is required');
        const u = ctx.repos.getUser(ctx.db, ctx.config.defaultUserId);
        if (!u) throw new HttpError(401, 'UNAUTHENTICATED', 'No default user is seeded');
        request.user = toRequestUser(u, true);
      }
      request.actor = { userId: request.user.id, ip: request.ip };
      return;
    }

    // Session mode. Decide "is this the API?" from the matched route pattern (immune to URL-encoding tricks); fall
    // back to the raw URL for unmatched requests so an unknown /api path is 401, not a hint that it does not exist.
    const routeUrl = request.routeOptions.url;
    const api = routeUrl !== undefined ? isApiUrl(routeUrl) : isApiUrl(request.url);
    request.actor = { userId: ANONYMOUS, ip: request.ip };
    if (!api) return; // the built web app and its assets are public; its screens call /api/auth/me
    const token = readSessionToken(request.headers.cookie);
    const resolved = token ? resolveSession(ctx, token) : undefined;
    if (resolved) {
      request.user = toRequestUser(resolved.user, false);
      request.sessionId = resolved.session.id;
      request.actor = { userId: resolved.user.id, ip: request.ip };
      return;
    }
    if (routeUrl !== undefined && PUBLIC_API_ROUTES.has(routeUrl)) return;
    throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
  });

  // Content-Security-Policy on every HTML response (the web app shell and HTML documents): scripts only from the
  // app itself, so a javascript: link or injected markup can never run (docx-preview renders Word files into the page).
  app.addHook('onSend', async (_request, reply, payload) => {
    const type = String(reply.getHeader('content-type') ?? '');
    if (/^text\/html/i.test(type) && !reply.hasHeader('content-security-policy')) reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
    if (!reply.hasHeader('x-content-type-options')) reply.header('x-content-type-options', 'nosniff');
    return payload;
  });

  // Manager mode (0.3 §A.4.3): build the override gate up front for any mutation that carries a manager header, so
  // web-only relaxations (X-Manager-Relaxed) are recorded even on routes that never call the gate themselves.
  app.addHook('preHandler', async (request) => {
    if (request.method === 'GET' || request.method === 'HEAD') return;
    if (request.headers[MANAGER_OVERRIDE_HEADER] === undefined && request.headers[MANAGER_RELAXED_HEADER] === undefined) return;
    if (!request.user) return;
    gateFor(ctx, request);
  });

  // One audit row per applied override, only when the response succeeded; then tell the client what was overridden.
  app.addHook('onSend', async (request, reply, payload) => {
    const gate = peekGate(request);
    if (!gate?.applied.length || reply.statusCode >= 400) return payload;
    const at = ctx.now();
    ctx.db.transaction((tx) => {
      for (const o of gate.applied) {
        ctx.repos.appendAudit(tx, {
          actor: request.actor,
          action: `override.${o.code}`,
          entity: o.target.claimId ? 'claims' : o.target.entity,
          entityId: o.target.claimId ?? o.target.entityId,
          before: { code: o.code, message: o.message, details: o.details ?? null },
          after: { reason: o.reason, class: o.class, label: o.label, target: { entity: o.target.entity, entityId: o.target.entityId }, method: request.method, route: request.routeOptions.url, requestId: request.requestId },
          at,
        });
      }
    });
    reply.header(MANAGER_OVERRIDES_RESPONSE_HEADER, encodeURIComponent(JSON.stringify(gate.applied.map((o) => ({ code: o.code, label: o.label, reason: o.reason })))));
    return payload;
  });

  app.setErrorHandler((err: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const mapped = mapError(err);
    if (mapped.status >= 500) ctx.logger.error('unhandled error', { requestId: request.requestId, url: request.url, error: err instanceof Error ? err.stack ?? err.message : String(err) });
    void reply.status(mapped.status).send({ error: { ...mapped.body, requestId: request.requestId } } satisfies ErrorBody);
  });

  await app.register(
    async (api) => {
      registerAllRoutes(api, ctx);
    },
    { prefix: '/api' },
  );

  // Static web app with SPA fallback (only when built).
  const indexHtml = path.join(ctx.config.webDistDir, 'index.html');
  const hasWeb = existsSync(indexHtml);
  if (hasWeb) {
    await app.register(fastifyStatic, { root: ctx.config.webDistDir, prefix: '/', wildcard: false, index: ['index.html'] });
  }
  // Anything under /api (including the bare prefix and a query string) is the API's 404 — the SPA shell never answers for it.
  app.setNotFoundHandler((request, reply) => {
    if (isApiUrl(request.url)) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found`, requestId: request.requestId } });
    }
    if (hasWeb && request.method === 'GET') return reply.sendFile('index.html');
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found', requestId: request.requestId } });
  });

  app.addHook('onClose', async () => {
    ctx.close();
  });

  return app;
}
