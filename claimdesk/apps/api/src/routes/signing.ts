// owned by ap-paperwork
/**
 * Paperwork and signing routes (docs/SUPREME-AUTOPILOT.md §D.6, §E, §H.4). (H) = human-only (agent perimeter, and
 * `assertHuman` in the services).
 *
 *   GET   /claims/:id/packs                     the claim's packs with their documents, reviews, signer and requests
 *   POST  /claims/:id/packs                     prepare a stage pack now { stage, reservationId?, restart? }
 *   GET   /packs/:id                            one pack
 *   POST  /packs/:id/approve              (H)   approve every document { send?, note? } — send emails it (§E.4)
 *   POST  /packs/:id/send-for-signature   (H)   email an approved pack (cover letter + PDFs; signature requests)
 *   POST  /packs/:id/reject               (H)   cancel the pack { reason }
 *   POST  /packs/:id/kiosk                (H)   open the in-person signing kiosk → { token, path, lanUrl?, expiresAt }
 *   GET   /claims/:id/signatures                signed documents (method, evidence, pack), signature requests, packs
 *   POST  /documents/:id/mark-signed      (H)   a returned scan / paper copy confirmed by a person
 *   PATCH /claims/:id/hire/:hireId/paperwork (H) link signed documents to an existing hire and re-run the sync (§E.5)
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { canonicalTemplateId, PACK_STAGES, type HireAgreement, type PackStage } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isoDateTime, parse } from '../schemas/common.js';
import { params, requireClaim } from './helpers.js';
import { assertHuman } from '../services/humanOnly.js';
import { approvePack, claimPacks, packView, preparePack, rejectPack, sendPackForSignature } from '../signing/packs.js';
import { createKioskSession } from '../signing/kiosk.js';
import { markDocumentSigned } from '../signing/wet.js';
import { provenFromPack, refreshGapFlag, writeProven } from '../signing/enforceability.js';
import { audit } from '../signing/common.js';
import { nudgeAutopilot } from '../autopilot/nudge.js';

const id = z.string().min(1).max(128);
const prepareBody = z.object({ stage: z.enum(PACK_STAGES as unknown as [PackStage, ...PackStage[]]), reservationId: id.nullish(), restart: z.boolean().optional() }).strict();
const approveBody = z.object({ send: z.boolean().optional(), note: z.string().trim().max(1000).optional() }).strict();
const reasonBody = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
const markSignedBody = z
  .object({
    evidenceId: id,
    signerPartyId: id.optional(),
    signedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'expected the date written on the signed copy (YYYY-MM-DD)'),
    method: z.enum(['wet_ink', 'scan']),
  })
  .strict();
const paperworkBody = z
  .object({
    documentIds: z.array(id).max(20).optional(),
    cca60fCompliant: z.boolean().optional(),
    cancellationInfoProvidedAt: isoDateTime.optional(),
    schedule3FormProvidedAt: isoDateTime.optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

const userAgentOf = (request: FastifyRequest): string => {
  const ua = request.headers['user-agent'];
  return (Array.isArray(ua) ? ua.join(' ') : ua) ?? 'unknown';
};

export function registerSigningRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/claims/:id/packs', async (request) => {
    const { id: claimId } = params<{ id: string }>(request);
    requireClaim(ctx, claimId);
    return { packs: claimPacks(ctx, claimId) };
  });

  app.post('/claims/:id/packs', async (request, reply) => {
    const { id: claimId } = params<{ id: string }>(request);
    requireClaim(ctx, claimId);
    const body = parse(prepareBody, request.body ?? {});
    const r = await preparePack(ctx, { claimId, stage: body.stage, ...(body.reservationId ? { reservationId: body.reservationId } : {}), ...(body.restart ? { restart: true } : {}), actor: request.actor });
    nudgeAutopilot(ctx, claimId, `${body.stage} pack prepared`);
    return reply.status(r.reused ? 200 : 201).send({ pack: packView(ctx, r.pack), created: r.created, failed: r.failed, reused: r.reused });
  });

  app.get('/packs/:id', async (request) => {
    const { id: packId } = params<{ id: string }>(request);
    return { pack: packView(ctx, ctx.repos.requireDocumentPack(ctx.db, packId)) };
  });

  app.post('/packs/:id/approve', async (request) => {
    assertHuman(request.actor, 'approve paperwork');
    const { id: packId } = params<{ id: string }>(request);
    const body = parse(approveBody, request.body ?? {});
    const r = await approvePack(ctx, packId, request.actor, { send: Boolean(body.send), ...(body.note ? { note: body.note } : {}) });
    return { pack: packView(ctx, r.pack), approved: r.approved, ...(r.sent ? { outboxIds: r.sent.outboxIds, signatureRequestIds: r.sent.signatureRequestIds } : {}) };
  });

  app.post('/packs/:id/send-for-signature', async (request) => {
    assertHuman(request.actor, 'send paperwork');
    const { id: packId } = params<{ id: string }>(request);
    const r = await sendPackForSignature(ctx, packId, request.actor);
    return { pack: packView(ctx, r.pack), outboxIds: r.outboxIds, signatureRequestIds: r.signatureRequestIds };
  });

  app.post('/packs/:id/reject', async (request) => {
    assertHuman(request.actor, 'reject paperwork');
    const { id: packId } = params<{ id: string }>(request);
    const body = parse(reasonBody, request.body ?? {});
    return { pack: packView(ctx, rejectPack(ctx, packId, request.actor, body.reason)) };
  });

  app.post('/packs/:id/kiosk', async (request, reply) => {
    assertHuman(request.actor, 'open the signing kiosk');
    const { id: packId } = params<{ id: string }>(request);
    return reply.status(201).send(createKioskSession(ctx, packId, request.actor));
  });

  app.get('/claims/:id/signatures', async (request) => {
    const { id: claimId } = params<{ id: string }>(request);
    requireClaim(ctx, claimId);
    const docs = ctx.repos.listDocuments(ctx.db, { claimId, includeHtml: false }).filter((d) => d.signature);
    const signatures = docs.map((d) => {
      const s = d.signature!;
      const provenance = ctx.repos.getSignatureProvenance(ctx.db, s.certificateId) ?? {};
      return {
        documentId: d.id,
        title: d.title,
        templateId: d.templateId,
        signerPartyId: s.signerPartyId,
        signerName: s.signerName,
        signedAt: s.signedAt,
        certificateId: s.certificateId,
        method: s.method ?? provenance.method ?? 'otp',
        ...(s.evidenceId ?? provenance.evidenceId ? { evidenceId: s.evidenceId ?? provenance.evidenceId } : {}),
        ...(s.packId ?? provenance.packId ? { packId: s.packId ?? provenance.packId } : {}),
      };
    });
    return { signatures, requests: ctx.repos.listSignatureRequests(ctx.db, { claimId }), packs: claimPacks(ctx, claimId) };
  });

  app.post('/documents/:id/mark-signed', async (request) => {
    assertHuman(request.actor, 'mark a document signed');
    const { id: documentId } = params<{ id: string }>(request);
    const body = parse(markSignedBody, request.body ?? {});
    const r = await markDocumentSigned(ctx, documentId, { evidenceId: body.evidenceId, signedOn: body.signedOn, method: body.method, ...(body.signerPartyId ? { signerPartyId: body.signerPartyId } : {}) }, request.actor, { ip: request.ip, userAgent: userAgentOf(request) });
    return { document: r.document, certificateId: r.certificateId };
  });

  app.patch('/claims/:id/hire/:hireId/paperwork', async (request) => {
    assertHuman(request.actor, 'change hire paperwork');
    const { id: claimId, hireId } = params<{ id: string; hireId: string }>(request);
    requireClaim(ctx, claimId);
    const hire = ctx.repos.getHire(ctx.db, hireId);
    if (!hire || hire.claimId !== claimId) throw notFound('hire', hireId);
    const body = parse(paperworkBody, request.body ?? {});
    const proven: Partial<HireAgreement> = {};
    const e: Partial<HireAgreement['enforceability']> = {};
    for (const docId of body.documentIds ?? []) {
      const d = ctx.repos.getDocument(ctx.db, docId, { includeHtml: false });
      if (!d || d.claimId !== claimId) throw badRequest(`Document ${docId} is not on this claim`);
      const canonical = canonicalTemplateId(d.templateId);
      if (canonical === 'agreement.credit_hire') {
        if (d.status !== 'signed' || !d.signature) throw conflict('DOCUMENT_STATE', `${d.title} is not signed`);
        proven.signedAt = d.signature.signedAt;
        proven.documentId = d.id;
        if (d.sentAt) e.cancellationInfoProvidedAt = d.sentAt;
      } else if (d.templateId === 'form.express_request_to_start') {
        if (d.status !== 'signed' || !d.signature) throw conflict('DOCUMENT_STATE', `${d.title} is not signed`);
        e.expressRequestToStartAt = d.signature.signedAt;
        if (d.signature.evidenceId) e.expressRequestEvidenceId = d.signature.evidenceId;
      } else if (d.templateId === 'form.cancellation_sch3') {
        if (!d.sentAt) throw conflict('DOCUMENT_STATE', `${d.title} has not been given to the hirer (no sent date)`);
        e.schedule3FormProvidedAt = d.sentAt;
      } else throw badRequest(`${d.title} is not hire paperwork (credit hire agreement, cancellation form or express request)`);
    }
    if (body.cca60fCompliant === true) e.cca60fCompliant = true;
    // Dates the owner states explicitly replace what is recorded (audited below with before/after).
    const explicit: Partial<HireAgreement['enforceability']> = {
      ...(body.cancellationInfoProvidedAt ? { cancellationInfoProvidedAt: body.cancellationInfoProvidedAt } : {}),
      ...(body.schedule3FormProvidedAt ? { schedule3FormProvidedAt: body.schedule3FormProvidedAt } : {}),
    };
    const fromPack = hire.reservationId ? provenFromPack(ctx, ctx.db, hire.reservationId) : {};
    const merged: Partial<HireAgreement> = {
      ...fromPack,
      ...proven,
      enforceability: { cca60fCompliant: false, ...(fromPack.enforceability ?? {}), ...e } as HireAgreement['enforceability'],
    };
    const updated = ctx.db.transaction((tx) => {
      const h = writeProven(ctx, tx, hire, merged);
      if (!Object.keys(explicit).length) return h;
      const next = ctx.repos.updateHire(tx, h.id, { enforceability: { ...h.enforceability, ...explicit } });
      refreshGapFlag(ctx, tx, next);
      return next;
    });
    audit(ctx, request.actor, 'hire.paperwork', 'hire_agreements', hire.id, { claimId, documentIds: body.documentIds ?? [], cca60fCompliant: body.cca60fCompliant ?? null, note: body.note ?? null, before: { signedAt: hire.signedAt ?? null, enforceability: hire.enforceability }, after: { signedAt: updated.signedAt ?? null, enforceability: updated.enforceability } });
    nudgeAutopilot(ctx, claimId, 'hire paperwork linked');
    return { hire: updated };
  });
}
