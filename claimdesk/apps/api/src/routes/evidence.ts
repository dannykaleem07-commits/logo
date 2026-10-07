/**
 * Evidence routes: multipart upload (hash while streaming, EXIF, write-once store, dedupe), metadata, file stream,
 * tamper verification. Evidence rows are immutable (PATCH/DELETE → 409 IMMUTABLE).
 *
 * Big uploads (SUPREME-DESIGN §0.3, slice `uploads-desktop`): the evidence route has its own size limit
 * (MAX_EVIDENCE_UPLOAD_MB, default 2 GiB — the global 25 MiB stays for every other route), `GET /limits`, resumable
 * chunked uploads (`/uploads…`) and the import folder (`/imports…`, plus the inbox watcher when JOBS_ENABLED=true).
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { EvidenceImmutableError } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest, conflict, HttpError, notFound, notImplemented } from '../errors.js';
import { parse } from '../schemas/common.js';
import { evidenceFields, evidenceFileQuery, evidenceKind } from '../schemas/services.js';
import { attachEvidenceBody, chunkQuery, completeUploadBody, createUploadBody, listImportsQuery } from '../schemas/uploads.js';
import { discardStaged, readEvidenceVerified, stageStream, storeEvidence, verifyEvidence, type StagedUpload } from '../services/evidence.js';
import { attachImportAsEvidence, ensureInbox, getStagedImport, inboxDir, listStagedImports, startImportWatcher, type ImportWatcher } from '../services/imports.js';
import { appendChunk, completeUpload, createUpload, deleteUpload, getUpload, uploadLimits } from '../services/uploads.js';
import { params, requireClaim } from './helpers.js';
import { z } from 'zod';

/** Multipart framing around the file (boundaries, part headers, text fields) allowed on top of the file limit. */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

function fileTooLarge(limitBytes: number): HttpError {
  const mb = Math.round(limitBytes / (1024 * 1024));
  return new HttpError(413, 'FILE_TOO_LARGE', `This file is larger than the ${mb} MB limit for one upload`, { limitBytes, useChunked: true });
}

function contentLengthOf(request: FastifyRequest): number | undefined {
  const raw = request.headers['content-length'];
  const n = raw === undefined ? NaN : Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** busboy / stream errors raised while a multipart body is being read. */
function isStreamFailure(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  if (!e) return false;
  if (e.code === 'ECONNRESET' || e.code === 'ERR_STREAM_PREMATURE_CLOSE' || e.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') return true;
  return typeof e.message === 'string' && /unexpected end of (form|multipart)|part terminated early|premature close|aborted/i.test(e.message);
}

/** The inbox watcher runs only in the real app with background jobs on (never in tests). */
function importWatcherEnabled(ctx: AppContext): boolean {
  return process.env.JOBS_ENABLED === 'true' && ctx.config.env !== 'test';
}

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
    const { maxEvidenceBytes } = uploadLimits();
    // Refuse at once when the declared body cannot fit, before a byte of it is read.
    const declared = contentLengthOf(request);
    if (declared !== undefined && declared > maxEvidenceBytes + MULTIPART_OVERHEAD_BYTES) throw fileTooLarge(maxEvidenceBytes);
    const fields: Record<string, string> = {};
    let staged: StagedUpload | undefined;
    let filename = 'upload';
    let mime = 'application/octet-stream';
    try {
      // Per-call limits are deep-merged over the plugin's (25 MiB) by @fastify/multipart, so this fileSize wins here only.
      for await (const part of request.parts({ limits: { fileSize: maxEvidenceBytes, files: 1 } })) {
        if (part.type === 'file') {
          if (staged) {
            // One file per upload: drain and ignore extras so the stream completes.
            part.file.resume();
            continue;
          }
          filename = part.filename || 'upload';
          mime = part.mimetype || mime;
          staged = await stageStream(ctx, part.file);
          if (part.file.truncated) throw fileTooLarge(maxEvidenceBytes);
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
      if ((err as { code?: string })?.code === 'FST_REQ_FILE_TOO_LARGE') throw fileTooLarge(maxEvidenceBytes);
      // A body that stops part-way (dropped connection, truncated multipart) is the client's problem, not a 500.
      if (!(err instanceof HttpError) && isStreamFailure(err)) throw new HttpError(400, 'UPLOAD_ABORTED', 'The upload stopped before the whole file arrived; nothing was stored. Try again.');
      throw err;
    }
  });

  app.get('/evidence/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    return ctx.repos.requireEvidence(ctx.db, id);
  });

  /** The bytes are re-hashed on every read; a mismatch with the record is refused (409 EVIDENCE_TAMPERED) and audited. */
  app.get('/evidence/:id/file', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const e = ctx.repos.requireEvidence(ctx.db, id);
    const q = parse(evidenceFileQuery, request.query);
    // Streaming verify first (cached for files > 256 MiB while unchanged), then stream the bytes.
    const read = await readEvidenceVerified(ctx, e);
    if (!read) throw notFound('evidence file', id);
    if (!read.intact) {
      ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'evidence.read.tampered', entity: 'evidence', entityId: id, after: { recordedSha256: e.sha256, computedSha256: read.computedSha256, bytesOnDisk: read.size, recordedBytes: e.bytes }, at: ctx.now() });
      throw conflict('EVIDENCE_TAMPERED', `The stored bytes for evidence ${id} no longer hash to the recorded sha256 — the file is not served`, { recordedSha256: e.sha256, computedSha256: read.computedSha256 });
    }
    const disposition = q.download ? 'attachment' : 'inline';
    const ascii = e.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    return reply
      .header('content-type', e.mime)
      .header('content-length', String(read.size))
      .header('content-disposition', `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(e.filename)}`)
      .header('x-sha256', e.sha256)
      .header('cache-control', 'private, max-age=0, must-revalidate')
      .send(createReadStream(read.absolutePath, { start: 0, end: Math.max(read.size - 1, 0), highWaterMark: 1024 * 1024 }));
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

  registerUploadRoutes(app, ctx);
  registerImportRoutes(app, ctx);

  app.patch('/evidence/:id', async () => {
    throw new EvidenceImmutableError('update');
  });
  app.delete('/evidence/:id', async () => {
    throw new EvidenceImmutableError('delete');
  });
}

/** `GET /limits` and the resumable chunked upload protocol (`/uploads…`). */
function registerUploadRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/limits', async () => uploadLimits());

  app.post('/uploads', async (request, reply) => {
    const body = parse(createUploadBody, request.body);
    return reply.status(201).send({ uploadId: (createUpload(ctx, body, request.actor)).id, chunkBytes: uploadLimits().chunkBytes, receivedBytes: 0 });
  });

  app.get('/uploads/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const p = getUpload(ctx, id);
    return { uploadId: p.id, receivedBytes: p.receivedBytes, bytes: p.bytes, status: p.status, chunkBytes: p.chunkBytes };
  });

  app.post('/uploads/:id/complete', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(completeUploadBody, request.body ?? {});
    const r = await completeUpload(ctx, id, body.sha256, request.actor);
    return reply.status(r.status).send(r.body);
  });

  app.delete('/uploads/:id', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    deleteUpload(ctx, id);
    return reply.status(204).send();
  });

  // Raw chunks: an encapsulated scope so the application/octet-stream parser (the request stream itself, never
  // buffered, outside the 2 MiB JSON body limit) applies to this route only.
  void app.register(async (scoped) => {
    scoped.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
    scoped.put('/uploads/:id', async (request) => {
      const { id } = params<{ id: string }>(request);
      const q = parse(chunkQuery, request.query);
      const stream = request.body as NodeJS.ReadableStream | undefined;
      if (!stream || typeof (stream as { pipe?: unknown }).pipe !== 'function') throw badRequest('Send the chunk as the raw request body with Content-Type: application/octet-stream');
      const p = await appendChunk(ctx, id, q.offset, stream as unknown as import('node:stream').Readable, contentLengthOf(request));
      return { uploadId: p.id, receivedBytes: p.receivedBytes, bytes: p.bytes, status: p.status };
    });
  });
}

/** The import folder: staged imports, attach as evidence, where the folder is, open it in Explorer; plus the watcher. */
function registerImportRoutes(app: FastifyInstance, ctx: AppContext): void {
  if (importWatcherEnabled(ctx)) {
    let watcher: ImportWatcher | undefined;
    app.addHook('onReady', async () => {
      try {
        watcher = startImportWatcher(ctx);
      } catch (err) {
        ctx.logger.error('imports: the inbox watcher could not start', { error: String(err) });
      }
    });
    app.addHook('onClose', async () => watcher?.stop());
  }

  app.get('/imports', async (request) => {
    const q = parse(listImportsQuery, request.query);
    const items = listStagedImports(ctx, { purpose: q.purpose, status: q.status });
    return { items: items.slice(0, q.limit ?? 200), total: items.length };
  });

  app.get('/imports/folder', async () => {
    const subfolders = ensureInbox(ctx);
    return { path: inboxDir(ctx), subfolders, watching: importWatcherEnabled(ctx) };
  });

  app.post('/imports/folder/open', async () => {
    const dir = inboxDir(ctx);
    ensureInbox(ctx);
    if (process.platform !== 'win32') throw notImplemented(`Opening a folder window is only available on Windows. The import folder is ${dir}`);
    const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', (err) => ctx.logger.warn('imports: explorer.exe could not open the inbox', { error: String(err) }));
    child.unref();
    return { opened: true, path: dir };
  });

  app.get('/imports/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const imp = getStagedImport(ctx, id);
    if (!imp) throw notFound('import', id);
    return imp;
  });

  app.post('/imports/:id/attach-evidence', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(attachEvidenceBody, request.body);
    const r = await attachImportAsEvidence(ctx, id, body, request.actor);
    return reply.status(r.deduped ? 200 : 201).send({ ...r.evidence, deduped: r.deduped, alsoOnClaims: r.alsoOnClaims, importId: id });
  });
}
