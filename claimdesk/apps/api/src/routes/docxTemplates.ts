/**
 * Word template library and DOCX claim documents (TEMPLATES-VEHICLES-DESKTOP §C.5), mounted under /api:
 *
 *   GET    /docx-templates                       list (built-ins + uploads)            ?includeInactive=true
 *   POST   /docx-templates                       upload (multipart: file, title, kind, description?, recipientRole?)
 *   GET    /docx-templates/:id                   detail (slots, blocks, outline, mapping, issues, field dictionary)
 *   PATCH  /docx-templates/:id                   title / description / active / recipientRole
 *   POST   /docx-templates/:id/acknowledge       "I have reviewed this wording"
 *   PUT    /docx-templates/:id/mapping           save the mapping (exact slot ids)
 *   DELETE /docx-templates/:id/mapping           built-ins: back to the curated default
 *   POST   /docx-templates/:id/file              new version of an uploaded template
 *   GET    /docx-templates/:id/file              the original .docx
 *   POST   /docx-templates/:id/test-fill         a filled copy, not stored (sample data unless claimId)
 *   GET    /claims/:id/docx-templates/:templateId/values   the values form for a claim
 *   POST   /claims/:id/docx-documents            generate a DOCX document (draft)
 *   GET    /docx-converters                      which DOCX → PDF converters this PC has
 * All writes are audited by the repository (docx_template.*) or the documents service (document.create).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { detectDocxConverters } from '@ccguk/documents';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import { parse } from '../schemas/common.js';
import {
  claimTemplateValuesQuery,
  DOCX_UPLOAD_MAX_BYTES,
  docxConvertersQuery,
  docxTemplateListQuery,
  docxTemplateMappingBody,
  docxTemplatePatchBody,
  docxTemplateUploadFields,
  docxTestFillBody,
  generateDocxBody,
} from '../schemas/docxTemplates.js';
import { claimTemplateValues, createDocxClaimDocument } from '../services/docxDocuments.js';
import { gateFor } from '../services/override.js';
import {
  converterOrderFor,
  listTemplateSummaries,
  replaceTemplate,
  resetMapping,
  safeFileName,
  saveMapping,
  templateBytes,
  templateDetail,
  templateSummary,
  testFill,
  uploadTemplate,
} from '../services/docxTemplates.js';
import { attachmentDisposition } from './documents.js';
import { configRolesOnly, params, requireClaim } from './helpers.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Read one multipart upload: exactly one file part named `file` (≤ 15 MiB → else 413) plus text fields. */
async function readUpload(request: FastifyRequest): Promise<{ bytes: Uint8Array; fileName: string; fields: Record<string, string> }> {
  if (!request.isMultipart()) throw badRequest('Upload the template as multipart/form-data with a "file" part');
  const fields: Record<string, string> = {};
  let file: { bytes: Uint8Array; fileName: string } | undefined;
  let files = 0;
  for await (const part of request.parts({ limits: { fileSize: DOCX_UPLOAD_MAX_BYTES, files: 2 } })) {
    if (part.type === 'file') {
      files += 1;
      if (part.fieldname !== 'file' || file) {
        part.file.resume();
        continue;
      }
      const buf = await part.toBuffer(); // throws FST_REQ_FILE_TOO_LARGE (413) past the limit
      file = { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), fileName: part.filename || 'template.docx' };
    } else {
      fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value);
    }
  }
  if (!file) throw badRequest('No file part named "file" in the upload');
  if (files > 1) throw badRequest('Upload exactly one file');
  return { ...file, fields };
}

function blankToUndefined(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) if (v.trim() !== '') out[k] = v;
  return out;
}

export function registerDocxTemplatesRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/docx-templates', async (request) => {
    const q = parse(docxTemplateListQuery, request.query);
    return { items: listTemplateSummaries(ctx, q.includeInactive === 'true') };
  });

  app.post('/docx-templates', { preHandler: configRolesOnly }, async (request, reply) => {
    const upload = await readUpload(request);
    const fields = parse(docxTemplateUploadFields, blankToUndefined(upload.fields));
    const detail = uploadTemplate(
      ctx,
      { bytes: upload.bytes, fileName: upload.fileName, title: fields.title, kind: fields.kind, ...(fields.description ? { description: fields.description } : {}), ...(fields.recipientRole ? { recipientRole: fields.recipientRole } : {}) },
      request.actor,
    );
    return reply.status(201).send(detail);
  });

  app.get('/docx-templates/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    return templateDetail(ctx, ctx.repos.requireDocumentTemplate(ctx.db, id));
  });

  app.patch('/docx-templates/:id', { preHandler: configRolesOnly }, async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(docxTemplatePatchBody, request.body ?? {});
    ctx.repos.requireDocumentTemplate(ctx.db, id);
    const row = ctx.repos.patchDocumentTemplate(ctx.db, id, body, request.actor);
    return templateSummary(ctx, row);
  });

  app.post('/docx-templates/:id/acknowledge', { preHandler: configRolesOnly }, async (request) => {
    const { id } = params<{ id: string }>(request);
    ctx.repos.requireDocumentTemplate(ctx.db, id);
    const row = ctx.repos.acknowledgeTemplateWarnings(ctx.db, id, request.actor);
    return templateSummary(ctx, row);
  });

  app.put('/docx-templates/:id/mapping', { preHandler: configRolesOnly }, async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(docxTemplateMappingBody, request.body);
    return saveMapping(ctx, id, { entries: body.entries, ...(body.ignore ? { ignore: body.ignore } : {}) }, request.actor);
  });

  app.delete('/docx-templates/:id/mapping', { preHandler: configRolesOnly }, async (request) => {
    const { id } = params<{ id: string }>(request);
    return resetMapping(ctx, id, request.actor);
  });

  app.post('/docx-templates/:id/file', { preHandler: configRolesOnly }, async (request) => {
    const { id } = params<{ id: string }>(request);
    const row = ctx.repos.requireDocumentTemplate(ctx.db, id);
    if (row.source !== 'uploaded') throw badRequest('Built-in templates ship with the app and cannot be replaced; upload your own version as a new template');
    const upload = await readUpload(request);
    return replaceTemplate(ctx, id, { bytes: upload.bytes, fileName: upload.fileName }, request.actor);
  });

  app.get('/docx-templates/:id/file', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const row = ctx.repos.requireDocumentTemplate(ctx.db, id);
    const bytes = templateBytes(ctx, row);
    return reply.header('content-type', DOCX_MIME).header('content-disposition', attachmentDisposition(safeFileName(row.fileName))).header('x-sha256', row.sha256).send(Buffer.from(bytes));
  });

  app.post('/docx-templates/:id/test-fill', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(docxTestFillBody, request.body ?? {});
    const out = testFill(ctx, id, body, request.user);
    return reply.header('content-type', DOCX_MIME).header('content-disposition', attachmentDisposition(out.fileName)).header('x-sha256', out.sha256).send(Buffer.from(out.docx));
  });

  app.get('/claims/:id/docx-templates/:templateId/values', async (request) => {
    const { id, templateId } = params<{ id: string; templateId: string }>(request);
    requireClaim(ctx, id);
    const q = parse(claimTemplateValuesQuery, request.query);
    return claimTemplateValues(ctx, id, templateId, request.user, q);
  });

  app.post('/claims/:id/docx-documents', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(generateDocxBody, request.body);
    const doc = await createDocxClaimDocument(ctx, { claimId: id, body, user: request.user, actor: request.actor, gate: gateFor(ctx, request) });
    return reply.status(201).send(doc);
  });

  app.get('/docx-converters', async (request) => {
    const q = parse(docxConvertersQuery, request.query);
    const preference = ctx.config.docxPdfConverter;
    const available = await detectDocxConverters({ refresh: q.refresh === 'true' });
    return { preference, order: converterOrderFor(preference), available };
  });
}
