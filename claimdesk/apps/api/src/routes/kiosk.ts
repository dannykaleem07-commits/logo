// owned by ap-paperwork
/**
 * Signing kiosk routes (docs/SUPREME-AUTOPILOT.md §E.2, §H.4) — token auth, not the session: `/api/kiosk/` is a public
 * prefix in app.ts and every route here checks its token itself. Never agent-reachable: the perimeter refuses any run
 * token on `/api/kiosk/*`, and these handlers refuse one again.
 *
 *   GET  /kiosk/:token                          summary: signer, documents (read / signed), how the code is delivered
 *   GET  /kiosk/:token/documents/:docId/pdf     one member document as PDF
 *   POST /kiosk/:token/read                     { documentId } "I have read this" (scrolled to the end)
 *   POST /kiosk/:token/otp/start                one code for the whole pack (email, else shown to the Claims Team)
 *   POST /kiosk/:token/sign                     { typedName, drawnSignaturePngBase64, code, consent: true }
 *   POST /kiosk/:token/close                    { password } of the person who opened the kiosk
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { parse } from '../schemas/common.js';
import { params } from './helpers.js';
import { closeKiosk, kioskDocumentPdf, kioskMarkRead, kioskSummary, startPackSignature, verifyPackSignature, type KioskRequestInfo } from '../signing/kiosk.js';

const readBody = z.object({ documentId: z.string().min(1).max(128) }).strict();
const signBody = z
  .object({
    typedName: z.string().trim().min(2).max(120),
    drawnSignaturePngBase64: z.string().min(16).max(300_000),
    code: z.string().trim().min(4).max(12),
    consent: z.literal(true),
  })
  .strict();
const closeBody = z.object({ password: z.string().min(1).max(200) }).strict();

function info(request: FastifyRequest): KioskRequestInfo {
  if (request.agent) throw new HttpError(403, 'AGENT_FORBIDDEN', 'The signing kiosk is never available to agents');
  const ua = request.headers['user-agent'];
  return { ip: request.ip, userAgent: (Array.isArray(ua) ? ua.join(' ') : ua) ?? 'unknown' };
}

export function registerKioskRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/kiosk/:token', async (request, reply) => {
    const req = info(request);
    const { token } = params<{ token: string }>(request);
    reply.header('cache-control', 'no-store');
    return kioskSummary(ctx, token, req);
  });

  app.get('/kiosk/:token/documents/:docId/pdf', async (request, reply) => {
    const req = info(request);
    const { token, docId } = params<{ token: string; docId: string }>(request);
    const pdf = await kioskDocumentPdf(ctx, token, docId, req);
    return reply.type('application/pdf').header('cache-control', 'no-store').header('content-disposition', 'inline').send(pdf);
  });

  app.post('/kiosk/:token/read', async (request) => {
    const req = info(request);
    const { token } = params<{ token: string }>(request);
    const body = parse(readBody, request.body ?? {});
    return kioskMarkRead(ctx, token, body.documentId, req);
  });

  app.post('/kiosk/:token/otp/start', async (request) => {
    const req = info(request);
    const { token } = params<{ token: string }>(request);
    return startPackSignature(ctx, token, req);
  });

  app.post('/kiosk/:token/sign', async (request) => {
    const req = info(request);
    const { token } = params<{ token: string }>(request);
    const body = parse(signBody, request.body ?? {});
    return verifyPackSignature(ctx, token, body, req);
  });

  app.post('/kiosk/:token/close', async (request) => {
    const req = info(request);
    const { token } = params<{ token: string }>(request);
    const body = parse(closeBody, request.body ?? {});
    return closeKiosk(ctx, token, body.password, req);
  });
}
