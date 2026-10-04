/**
 * Documents routes: templates, draft creation (+ consistency report), flag clearing, approval (PDF), send (recorded
 * only), supersede, e-signature start/verify, PDF download.
 */
import type { FastifyInstance } from 'fastify';
import { listTemplates } from '@ccguk/documents';
import type { DocumentStatus } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { parse } from '../schemas/common.js';
import { approveDocumentBody, clearDocumentFlagBody, createDocumentBody, documentGetQuery, documentListQuery, sendDocumentBody, signStartBody, signVerifyBody, supersedeDocumentBody } from '../schemas/services.js';
import { approveDocument, clearDocumentFlag, createClaimDocument, readCertificatePdf, readDocumentPdf, sendDocument, startSignature, supersedeDocument, verifySignature } from '../services/documents.js';
import { params, requireClaim } from './helpers.js';

export function registerDocumentsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/templates', async () => {
    return { items: listTemplates() };
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
    const doc = createClaimDocument(ctx, { claimId: id, templateId: body.templateId, extra: body.data, recipientPartyId: body.recipientPartyId, user: request.user, actor: request.actor });
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
    return approveDocument(ctx, id, request.actor, body?.note);
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
    const doc = supersedeDocument(ctx, id, { extra: body.data, reason: body.reason, reExecutedOn: body.reExecutedOn }, request.user, request.actor);
    return reply.status(201).send(doc);
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
