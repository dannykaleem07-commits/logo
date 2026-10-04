/**
 * Evidence routes: multipart upload (hash while streaming, EXIF, write-once store, dedupe), metadata, file stream,
 * tamper verification. Evidence rows are immutable (PATCH/DELETE → 409 IMMUTABLE).
 */
import type { FastifyInstance } from 'fastify';
import { EvidenceImmutableError } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { parse } from '../schemas/common.js';
import { evidenceFields, evidenceKind } from '../schemas/services.js';
import { discardStaged, openEvidenceStream, stageStream, storeEvidence, verifyEvidence, type StagedUpload } from '../services/evidence.js';
import { params, requireClaim } from './helpers.js';
import { z } from 'zod';

const listQuery = z.object({ kind: evidenceKind.optional() });

export function registerEvidenceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/claims/:id/evidence', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const q = parse(listQuery, request.query);
    return { items: ctx.repos.listEvidenceForClaim(ctx.db, id, { kind: q.kind }) };
  });

  app.post('/claims/:id/evidence', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    if (!request.isMultipart()) throw badRequest('Evidence must be uploaded as multipart/form-data with a "file" part');
    const fields: Record<string, string> = {};
    let staged: StagedUpload | undefined;
    let filename = 'upload';
    let mime = 'application/octet-stream';
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (staged) {
            // One file per upload: drain and ignore extras so the stream completes.
            part.file.resume();
            continue;
          }
          filename = part.filename || 'upload';
          mime = part.mimetype || mime;
          staged = await stageStream(ctx, part.file);
        } else {
          fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value);
        }
      }
      if (!staged) throw badRequest('No file part in the upload');
      if (staged.bytes === 0) throw badRequest('Uploaded file is empty');
      const parsed = parse(evidenceFields, fields);
      const result = await storeEvidence(ctx, { claimId: id, staged, filename, mime, fields: parsed, actor: request.actor });
      staged = undefined;
      return reply.status(result.deduped ? 200 : 201).send({ ...result.evidence, deduped: result.deduped, alsoOnClaims: result.alsoOnClaims });
    } catch (err) {
      if (staged) discardStaged(staged);
      throw err;
    }
  });

  app.get('/evidence/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    return ctx.repos.requireEvidence(ctx.db, id);
  });

  app.get('/evidence/:id/file', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const e = ctx.repos.requireEvidence(ctx.db, id);
    const stream = openEvidenceStream(ctx, e);
    if (!stream) throw notFound('evidence file', id);
    const disposition = (request.query as { download?: string }).download ? 'attachment' : 'inline';
    const ascii = e.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    return reply
      .header('content-type', e.mime)
      .header('content-length', String(e.bytes))
      .header('content-disposition', `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(e.filename)}`)
      .header('x-sha256', e.sha256)
      .header('cache-control', 'private, max-age=0, must-revalidate')
      .send(stream);
  });

  app.post('/evidence/:id/verify', async (request) => {
    const { id } = params<{ id: string }>(request);
    const e = ctx.repos.requireEvidence(ctx.db, id);
    return verifyEvidence(ctx, e, request.actor);
  });
  app.get('/evidence/:id/verify', async (request) => {
    const { id } = params<{ id: string }>(request);
    const e = ctx.repos.requireEvidence(ctx.db, id);
    return verifyEvidence(ctx, e, request.actor);
  });

  app.patch('/evidence/:id', async () => {
    throw new EvidenceImmutableError('update');
  });
  app.delete('/evidence/:id', async () => {
    throw new EvidenceImmutableError('delete');
  });
}
