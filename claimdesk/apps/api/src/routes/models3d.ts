/**
 * Exact (licensed) 3D vehicle models, mounted under /api (slice `exact-models`; service: services/models3d.ts).
 *
 *   GET    /models3d                      list (summaries)                         any signed-in user
 *   GET    /models3d/limits               upload limits, accepted types, the licence notice
 *   GET    /models3d/match                best model for a vehicle                  ?makeSlug&modelSlug&generationId | ?make&model, &bodyType&year
 *   GET    /models3d/:id                  the record + effective zone per part
 *   GET    /models3d/:id/model.glb        the model file (always one self-contained GLB)
 *   GET    /models3d/:id/thumbnail.png    the thumbnail (when one was saved)
 *   POST   /models3d                      upload (multipart: file + makeSlug, modelSlug, generationId?, bodyType?,
 *                                         title?, licenceConfirmed=true, licenceNote?)          admin / approver
 *   PATCH  /models3d/:id                  title, active, assignment, frame, paint materials, plates  admin / approver
 *   PUT    /models3d/:id/tags             manual zone tags { tags, clear?, replace? }          admin / approver
 *   PUT    /models3d/:id/thumbnail        { dataUrl: 'data:image/png;base64,…' }               admin / approver
 *   DELETE /models3d/:id                  remove the model and its files                       admin / approver
 *
 * Every change is audited (entity `model3d`). Files live under <DATA_DIR>/models3d, never in the repository.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, HttpError, notFound } from '../errors.js';
import { parse } from '../schemas/common.js';
import {
  LICENCE_NOTICE,
  MODEL_BODY_TYPES,
  MODEL_ZONE_IDS,
  MODELS3D_ACCEPT,
  createModel,
  deleteModel,
  discardStaged,
  listRecords,
  matchModel,
  modelFilePath,
  models3dLimits,
  readRecord,
  resolveAssignment,
  saveTags,
  saveThumbnail,
  stageModelStream,
  thumbnailPath,
  toSummary,
  toView,
  updateModel,
  type Model3dRecord,
  type StagedModelUpload,
} from '../services/models3d.js';
import { configRolesOnly, params } from './helpers.js';

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const MIB = 1024 * 1024;

const slug = z.string().trim().min(1).max(160);
const uploadFields = z.object({
  makeSlug: slug,
  modelSlug: slug,
  generationId: slug.optional(),
  bodyType: z.string().trim().max(60).optional(),
  title: z.string().trim().max(160).optional(),
  licenceConfirmed: z.enum(['true', 'on', 'yes', '1'], { errorMap: () => ({ message: `Tick "I hold a licence for this model". ${LICENCE_NOTICE}` }) }),
  licenceNote: z.string().trim().max(500).optional(),
});

const matchQuery = z.object({
  makeSlug: slug.optional(),
  modelSlug: slug.optional(),
  generationId: slug.optional(),
  make: z.string().trim().max(80).optional(),
  model: z.string().trim().max(160).optional(),
  bodyType: z.string().trim().max(60).optional(),
  year: z.coerce.number().int().min(1900).max(2100).optional(),
});

const partKey = z.string().regex(/^n\d+p\d+$/, 'expected a part key like n12p0');
const patchBody = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    active: z.boolean().optional(),
    assignment: z.object({ makeSlug: slug, modelSlug: slug, generationId: slug.nullish(), bodyType: z.enum(MODEL_BODY_TYPES).nullish() }).optional(),
    frame: z.object({ forward: z.enum(['+x', '-x', '+z', '-z']), mirror: z.boolean() }).optional(),
    paintMaterials: z.array(z.number().int().min(0)).max(2000).optional(),
    plateParts: z.array(z.object({ key: partKey, position: z.enum(['front', 'rear']) })).max(20).optional(),
    licenceNote: z.string().max(500).optional(),
  })
  .strict();

const tagsBody = z
  .object({
    tags: z.record(partKey, z.enum(MODEL_ZONE_IDS as unknown as [string, ...string[]]).nullable()),
    clear: z.array(partKey).max(20000).optional(),
    replace: z.boolean().optional(),
  })
  .strict();

const thumbnailBody = z.object({ dataUrl: z.string().max(3 * MIB) }).strict();

function contentLengthOf(request: FastifyRequest): number | undefined {
  const raw = request.headers['content-length'];
  const n = raw === undefined ? NaN : Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function tooLarge(limitBytes: number): HttpError {
  return new HttpError(413, 'FILE_TOO_LARGE', `This file is larger than the ${Math.round(limitBytes / MIB)} MB limit for a 3D model`, { limitBytes });
}

function isStreamFailure(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  if (e?.code === 'ECONNRESET' || e?.code === 'ERR_STREAM_PREMATURE_CLOSE') return true;
  return typeof e?.message === 'string' && /unexpected end of (form|multipart)|part terminated early|premature close|aborted/i.test(e.message);
}

/** Small audit snapshot (the part list can hold thousands of entries). */
function auditView(r: Model3dRecord): Record<string, unknown> {
  return {
    title: r.title,
    fileName: r.fileName,
    sha256: r.sha256,
    bytes: r.bytes,
    assignment: r.assignment,
    active: r.active,
    licence: r.licence,
    frame: r.frame,
    paintMaterials: r.paintMaterials,
    plateParts: r.plateParts,
    triangles: r.stats.triangles,
    parts: r.stats.parts,
  };
}

export function registerModels3dRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/models3d', async () => ({ items: listRecords(ctx).map(toSummary), notice: LICENCE_NOTICE }));

  app.get('/models3d/limits', async () => {
    const l = models3dLimits();
    return { maxBytes: l.maxBytes, maxTriangles: l.maxTriangles, maxNodes: l.maxNodes, accept: MODELS3D_ACCEPT, notice: LICENCE_NOTICE, zones: MODEL_ZONE_IDS };
  });

  app.get('/models3d/match', async (request) => {
    const q = parse(matchQuery, request.query);
    return matchModel(ctx, q);
  });

  app.get('/models3d/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    return toView(readRecord(ctx, id));
  });

  app.get('/models3d/:id/model.glb', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const r = readRecord(ctx, id);
    const file = modelFilePath(ctx, id);
    if (!existsSync(file)) throw notFound('3D model file', id);
    const size = statSync(file).size;
    return reply
      .header('content-type', 'model/gltf-binary')
      .header('content-length', String(size))
      .header('cache-control', 'private, max-age=0, must-revalidate')
      .header('etag', `"${r.sha256.slice(0, 32)}-${size}"`)
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(file, { highWaterMark: MIB }));
  });

  app.get('/models3d/:id/thumbnail.png', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const r = readRecord(ctx, id);
    const file = thumbnailPath(ctx, id);
    if (!r.thumbnail || !existsSync(file)) throw notFound('3D model thumbnail', id);
    return reply.header('content-type', 'image/png').header('cache-control', 'private, max-age=0, must-revalidate').header('x-content-type-options', 'nosniff').send(createReadStream(file));
  });

  app.post('/models3d', { preHandler: configRolesOnly }, async (request, reply) => {
    if (!request.isMultipart()) throw badRequest('Upload the model as multipart/form-data with a "file" part');
    const limits = models3dLimits();
    const declared = contentLengthOf(request);
    if (declared !== undefined && declared > limits.maxBytes + MULTIPART_OVERHEAD_BYTES) throw tooLarge(limits.maxBytes);
    const fields: Record<string, string> = {};
    let staged: StagedModelUpload | undefined;
    let fileName = 'model';
    try {
      for await (const part of request.parts({ limits: { fileSize: limits.maxBytes, files: 1 } })) {
        if (part.type === 'file') {
          if (staged || part.fieldname !== 'file') {
            part.file.resume();
            continue;
          }
          fileName = part.filename || 'model';
          staged = await stageModelStream(ctx, part.file);
          if (part.file.truncated) throw tooLarge(limits.maxBytes);
        } else {
          fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value);
        }
      }
      if (!staged) throw badRequest('No file part named "file" in the upload');
      const f = parse(uploadFields, Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim() !== '')));
      const assignment = resolveAssignment(ctx, { makeSlug: f.makeSlug, modelSlug: f.modelSlug, ...(f.generationId ? { generationId: f.generationId } : {}), ...(f.bodyType ? { bodyType: f.bodyType } : {}) });
      const now = ctx.now();
      const record = createModel(ctx, { staged, fileName, ...(f.title ? { title: f.title } : {}), assignment, ...(f.licenceNote ? { licenceNote: f.licenceNote } : {}), actorId: request.actor.userId, now }, limits);
      ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'models3d.upload', entity: 'model3d', entityId: record.id, after: auditView(record), at: now });
      return reply.status(201).send(toView(record));
    } catch (err) {
      if ((err as { code?: string })?.code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge(limits.maxBytes);
      if (!(err instanceof HttpError) && isStreamFailure(err)) throw new HttpError(400, 'UPLOAD_ABORTED', 'The upload stopped before the whole file arrived; nothing was stored. Try again.');
      throw err;
    } finally {
      // a stored GLB was moved away; anything still staged is discarded
      if (staged && existsSync(staged.path)) discardStaged(staged);
    }
  });

  app.patch('/models3d/:id', { preHandler: configRolesOnly }, async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(patchBody, request.body ?? {});
    const current = readRecord(ctx, id);
    const assignment = body.assignment
      ? resolveAssignment(ctx, {
          makeSlug: body.assignment.makeSlug,
          modelSlug: body.assignment.modelSlug,
          ...(body.assignment.generationId ? { generationId: body.assignment.generationId } : {}),
          ...(body.assignment.bodyType ? { bodyType: body.assignment.bodyType } : {}),
        })
      : undefined;
    const now = ctx.now();
    const { before, after } = updateModel(
      ctx,
      current.id,
      {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(assignment ? { assignment } : {}),
        ...(body.frame ? { frame: body.frame } : {}),
        ...(body.paintMaterials ? { paintMaterials: body.paintMaterials } : {}),
        ...(body.plateParts ? { plateParts: body.plateParts } : {}),
        ...(body.licenceNote !== undefined ? { licenceNote: body.licenceNote } : {}),
      },
      now,
    );
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'models3d.update', entity: 'model3d', entityId: id, before: auditView(before), after: auditView(after), at: now });
    return toView(after);
  });

  app.put('/models3d/:id/tags', { preHandler: configRolesOnly }, async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(tagsBody, request.body ?? {});
    const now = ctx.now();
    const { before, after } = saveTags(ctx, id, { tags: body.tags, ...(body.clear ? { clear: body.clear } : {}), ...(body.replace ? { replace: true } : {}) }, now);
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'models3d.tags', entity: 'model3d', entityId: id, before: { tags: before }, after: { tags: after.tags }, at: now });
    return toView(after);
  });

  app.put('/models3d/:id/thumbnail', { preHandler: configRolesOnly, bodyLimit: 4 * MIB }, async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(thumbnailBody, request.body ?? {});
    const r = saveThumbnail(ctx, id, body.dataUrl, ctx.now());
    return { id: r.id, thumbnail: true, thumbnailUrl: `/models3d/${r.id}/thumbnail.png` };
  });

  app.delete('/models3d/:id', { preHandler: configRolesOnly }, async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const now = ctx.now();
    const r = deleteModel(ctx, id);
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'models3d.delete', entity: 'model3d', entityId: id, before: auditView(r), at: now });
    return reply.status(204).send();
  });
}
