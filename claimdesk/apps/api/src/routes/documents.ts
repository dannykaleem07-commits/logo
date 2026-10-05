/**
 * Documents routes: templates, draft creation (+ consistency report), flag clearing, approval (PDF), send (recorded
 * only), supersede, e-signature start/verify, PDF download, the filled Word file of a DOCX document and any HTML
 * letter recomposed on the CCGUK Word letterhead (TEMPLATES-VEHICLES-DESKTOP §C.5, §C.7).
 */
import type { FastifyInstance } from 'fastify';
import { builtinAssetBytes, composeLetterheadDocx, extractLetterContent, LETTERHEAD_TEMPLATE_ID, listTemplates, readDocumentMeta } from '@ccguk/documents';
import type { DocumentStatus, GeneratedDocument } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { HttpError, notFound, unprocessable } from '../errors.js';
import { parse } from '../schemas/common.js';
import { supersedeDocxExtra } from '../schemas/docxTemplates.js';
import { approveDocumentBody, clearDocumentFlagBody, createDocumentBody, documentGetQuery, documentListQuery, sendDocumentBody, signStartBody, signVerifyBody, supersedeDocumentBody } from '../schemas/services.js';
import { approveDocument, clearDocumentFlag, createClaimDocument, readCertificatePdf, readDocumentDocx, readDocumentPdf, sendDocument, startSignature, supersedeDocument, templateMeta, verifySignature } from '../services/documents.js';
import { safeFileName } from '../services/docxTemplates.js';
import { gateFor } from '../services/override.js';
import { params, requireClaim } from './helpers.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** `attachment; filename="…"` with an RFC 5987 UTF-8 variant (titles carry dashes and ampersands). */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, '-').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function referenceOf(ctx: AppContext, doc: GeneratedDocument): string {
  return doc.claimId ? (ctx.repos.getClaim(ctx.db, doc.claimId)?.reference ?? doc.id) : doc.id;
}

export function registerDocumentsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/templates', async () => {
    // HTML templates; the Word templates are listed by GET /docx-templates (format 'docx').
    return { items: listTemplates().map((t) => ({ ...t, format: 'html' as const })) };
  });

  app.get('/claims/:id/documents', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const q = parse(documentListQuery, request.query);
    const status = q.status ? (q.status.split(',') as DocumentStatus[]) : undefined;
    return { items: ctx.repos.listDocuments(ctx.db, { claimId: id, status, templateId: q.templateId, limit: q.limit, includeHtml: false }) };
  });

  app.post('/claims/:id/documents', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(createDocumentBody, request.body);
    const doc = createClaimDocument(ctx, { claimId: id, templateId: body.templateId, extra: body.data, recipientPartyId: body.recipientPartyId, user: request.user, actor: request.actor, gate: gateFor(ctx, request) });
    return reply.status(201).send(doc);
  });

  app.get('/documents/:id', async (request) => {
    const { id } = params<{ id: string }>(request);
    const q = parse(documentGetQuery, request.query);
    return ctx.repos.requireDocument(ctx.db, id, { includeHtml: q.html !== 'false' });
  });

  /** The approved PDF, re-hashed on every read (409 DOCUMENT_PDF_TAMPERED when the bytes no longer match the record). */
  app.get('/documents/:id/pdf', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const doc = ctx.repos.requireDocument(ctx.db, id, { includeHtml: false });
    const pdf = readDocumentPdf(ctx, doc);
    if (!pdf) throw notFound('document PDF (approve the document first)', id);
    const name = `${doc.title.replace(/[^\w.\- ]/g, '_').slice(0, 80)}.pdf`;
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${name}"`).header('x-sha256', doc.sha256).send(pdf);
  });

  /** The e-signature certificate PDF (rendered at sign/verify) for a signed document. */
  app.get('/documents/:id/certificate', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const doc = ctx.repos.requireDocument(ctx.db, id, { includeHtml: false });
    const cert = readCertificatePdf(ctx, doc);
    if (!cert) throw notFound('signature certificate (the document is not signed, or the certificate PDF was not rendered)', id);
    const name = `${cert.certificateId.replace(/[^\w.\-]/g, '_').slice(0, 80)}.pdf`;
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${name}"`).header('x-sha256', cert.sha256).header('x-certificate-id', cert.certificateId).send(cert.pdf);
  });

  app.post('/documents/:id/clear-flag', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(clearDocumentFlagBody, request.body);
    return clearDocumentFlag(ctx, id, body, request.actor);
  });

  app.post('/documents/:id/approve', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(approveDocumentBody, request.body ?? {});
    return approveDocument(ctx, id, request.actor, body?.note, gateFor(ctx, request));
  });

  app.post('/documents/:id/send', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(sendDocumentBody, request.body);
    const result = await sendDocument(ctx, id, body, request.actor);
    return { ...result.document, send: { events: result.events, pdfUrl: result.pdfUrl, note: result.note }, pdfBase64: result.pdfBase64 };
  });

  app.post('/documents/:id/supersede', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(supersedeDocumentBody, request.body ?? {}) ?? {};
    // Word documents: new slot values / confirmations are merged over the previous inputs (§C.6).
    const docx = parse(supersedeDocxExtra, request.body ?? {});
    const doc = supersedeDocument(ctx, id, { extra: body.data, reason: body.reason, reExecutedOn: body.reExecutedOn, docx: { ...(docx.values ? { values: docx.values } : {}), ...(docx.confirm ? { confirm: docx.confirm } : {}) } }, request.user, request.actor, gateFor(ctx, request));
    return reply.status(201).send(doc);
  });

  /** The filled Word file of a DOCX document, re-hashed on every read (409 DOCUMENT_DOCX_TAMPERED). */
  app.get('/documents/:id/docx', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const doc = ctx.repos.requireDocument(ctx.db, id, { includeHtml: false });
    const { docx, sha256 } = readDocumentDocx(ctx, doc);
    const name = `${safeFileName(`${referenceOf(ctx, doc)} ${doc.title}`)}.docx`;
    return reply.header('content-type', DOCX_MIME).header('content-disposition', attachmentDisposition(name)).header('x-sha256', sha256).send(docx);
  });

  /**
   * An HTML letter recomposed on the CCGUK formal letterhead (not stored). 400 NOT_A_LETTER for anything that is not
   * an HTML letter; 422 LETTER_NOT_EXTRACTABLE when the HTML carries no letter parts. Audited with the sha256.
   */
  app.get('/documents/:id/letterhead.docx', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    const doc = ctx.repos.requireDocument(ctx.db, id, { includeHtml: true });
    const kind = templateMeta(doc.templateId)?.kind ?? readDocumentMeta(doc.html).kind;
    if (doc.format === 'docx' || kind !== 'letter') throw new HttpError(400, 'NOT_A_LETTER', `Document ${id} (${doc.templateId}) is not an HTML letter; only letters can be put on the letterhead`, { templateId: doc.templateId, kind });
    const content = extractLetterContent(doc.html);
    if (!content) throw unprocessable('LETTER_NOT_EXTRACTABLE', `The letter text of document ${id} could not be read (it was made with a layout that does not mark the letter parts). Re-generate it to get a letterhead copy.`);
    const reference = referenceOf(ctx, doc);
    const now = ctx.now();
    const { docx, sha256 } = composeLetterheadDocx(builtinAssetBytes(LETTERHEAD_TEMPLATE_ID), content, { now: new Date(now), reference, title: `${doc.title} — ${reference}` });
    ctx.repos.appendAudit(ctx.db, { actor: request.actor, action: 'document.letterhead_docx', entity: 'documents', entityId: id, after: { sha256, reference, status: doc.status, documentSha256: doc.sha256 }, at: now });
    const name = `${safeFileName(`${reference} ${doc.title} (letterhead)`)}.docx`;
    return reply.header('content-type', DOCX_MIME).header('content-disposition', attachmentDisposition(name)).header('x-sha256', sha256).send(Buffer.from(docx));
  });

  app.post('/documents/:id/sign/start', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(signStartBody, request.body);
    return startSignature(ctx, id, body, request.actor);
  });

  app.post('/documents/:id/sign/verify', async (request) => {
    const { id } = params<{ id: string }>(request);
    const body = parse(signVerifyBody, request.body);
    const ua = request.headers['user-agent'];
    const result = await verifySignature(ctx, id, { challengeId: body.challengeId, code: body.code, ipAddress: request.ip, userAgent: Array.isArray(ua) ? ua.join(' ') : (ua ?? 'unknown') }, request.actor);
    return { ...result.document, certificateId: result.certificateId, certificatePdfPath: result.certificatePdfPath, duplicateSignatureDate: result.duplicateSignatureDate };
  });
}
