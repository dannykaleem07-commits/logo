/**
 * buildApp(ctx) → Fastify instance. Plugins: CORS, multipart (25 MB files), static web app (SPA fallback) when
 * apps/web/dist exists. Error handler maps zod → 400 VALIDATION, NotFound → 404, Immutable → 409. A request id is
 * attached to every reply; the header-token auth placeholder sets `request.user` for audit rows.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { DbError, DocumentStateError, ImmutableError, NotFoundError, ValidationError, VerificationError, type Actor } from '@ccguk/db';
import type { User } from '@ccguk/domain';
import type { AppContext } from './context.js';
import { HttpError } from './errors.js';
import { registerAllRoutes } from './routes/index.js';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface RequestUser extends User {
  /** True when the user came from the dev default rather than a header. */
  assumed: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: RequestUser;
    requestId: string;
    actor: Actor;
  }
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export function mapError(err: unknown): { status: number; body: ErrorBody['error'] } {
  if (err instanceof HttpError) return { status: err.statusCode, body: { code: err.code, message: err.message, details: err.details } };
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

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.config.env === 'test' ? false : { level: ctx.config.env === 'production' ? 'info' : 'debug' },
    genReqId: (req) => (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].length <= 128 ? req.headers['x-request-id'] : randomUUID()),
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });

  app.decorateRequest('user', undefined as unknown as RequestUser);
  app.decorateRequest('requestId', '');
  app.decorateRequest('actor', undefined as unknown as Actor);

  await app.register(cors, { origin: true, credentials: true, exposedHeaders: ['x-request-id'] });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 10, fields: 50 } });

  // Request id + auth placeholder. A real identity layer replaces this hook; everything downstream reads request.user/actor.
  app.addHook('onRequest', async (request, reply) => {
    request.requestId = String(request.id);
    reply.header('x-request-id', request.requestId);
    const header = request.headers['x-user-id'];
    const headerId = Array.isArray(header) ? header[0] : header;
    if (headerId) {
      const u = ctx.repos.getUser(ctx.db, headerId);
      if (!u) throw new HttpError(401, 'UNAUTHENTICATED', `Unknown user ${headerId} (X-User-Id)`);
      request.user = { id: u.id, name: u.name, email: u.email, role: u.role, mfaEnabled: u.mfaEnabled, assumed: false };
    } else {
      if (ctx.config.env === 'production') throw new HttpError(401, 'UNAUTHENTICATED', 'X-User-Id header is required');
      const u = ctx.repos.getUser(ctx.db, ctx.config.defaultUserId);
      if (!u) throw new HttpError(401, 'UNAUTHENTICATED', 'No default user is seeded');
      request.user = { id: u.id, name: u.name, email: u.email, role: u.role, mfaEnabled: u.mfaEnabled, assumed: true };
    }
    request.actor = { userId: request.user.id, ip: request.ip };
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
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
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
