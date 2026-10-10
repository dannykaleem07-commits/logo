// owned by ap-paperwork
/**
 * Attach a signature to a document with its completion certificate (docs/SUPREME-AUTOPILOT.md §E.2 step 4, §E.4) —
 * the same internals as the single-document OTP flow (`verifySignature` in services/documents.ts): certificate JSON
 * (write-once) and PDF next to the document, `attachSignature` (document → `signed`), the 0013 provenance columns
 * (method, drawn signature hash, evidence, pack) and the DUPLICATE_SIGNATURE_DATE alert on the claim.
 *
 * The certificate lines say how identity was checked: OTP by email (kiosk), a code shown to the Claims Team member
 * (kiosk, no mailbox), or a wet-ink / scanned copy confirmed by a person.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Actor } from '@ccguk/db';
import { buildCertificate, certificateIdFor, signatureDateChecks, type ConsistencyFlag, type GeneratedDocument, type SignatureRecord } from '@ccguk/domain';
import { hasTemplate, renderPdf, renderTemplate } from '@ccguk/documents';
import type { AppContext } from '../context.js';
import { conflict } from '../errors.js';
import { companySettings } from '../services/documentData.js';
import { documentPdfPath } from '../services/documents.js';
import { assertHuman } from '../services/humanOnly.js';

export interface SignDocumentInput {
  document: GeneratedDocument;
  signature: Omit<SignatureRecord, 'certificateId' | 'certificatePdfPath'>;
  /** The secret token behind the identity check (OTP token, or a nonce for a wet-ink confirmation); never stored. */
  proofToken: string;
  actor: Actor;
}

export interface SignDocumentResult {
  document: GeneratedDocument;
  certificateId: string;
  certificatePdfPath?: string;
  duplicateSignatureDate?: ConsistencyFlag;
}

const METHOD_LINE: Partial<Record<NonNullable<SignatureRecord['method']>, (s: SignDocumentInput['signature']) => string>> = {
  kiosk_handler_code: (s) => `Identity: one-time code shown to the Claims Team member at the signing kiosk (no mailbox set up) and given to the signer in person; code verified ${s.otpVerifiedAt}`,
  wet_ink: (s) => `Wet-ink signature: the returned paper copy was checked against the generated document and confirmed by a person on ${s.otpVerifiedAt}`,
  scan: (s) => `Scanned signature: the returned scan was checked against the generated document and confirmed by a person on ${s.otpVerifiedAt}`,
};

export async function signDocumentWithCertificate(ctx: AppContext, input: SignDocumentInput): Promise<SignDocumentResult> {
  assertHuman(input.actor, 'record a signature');
  const doc = input.document;
  if (doc.signature) throw conflict('DOCUMENT_STATE', `${doc.title} already carries a signature`);
  if (doc.status !== 'approved' && doc.status !== 'sent') throw conflict('DOCUMENT_STATE', `${doc.title} must be approved before it is signed (status is ${doc.status})`);
  const now = ctx.now();
  if (Date.parse(input.signature.signedAt) < Date.parse(doc.createdAt)) throw conflict('DATE_BEFORE_CREATION', `A document cannot be signed (${input.signature.signedAt}) before it was created (${doc.createdAt})`);
  const certificateId = certificateIdFor(doc.id, doc.sha256, input.signature.signedAt, input.proofToken);
  const signature: SignatureRecord = { ...input.signature, certificateId };
  const certificate = buildCertificate({ document: doc, signature, otpToken: input.proofToken, generatedAt: now, issuer: ctx.settings().companyName });
  const methodLine = signature.method ? METHOD_LINE[signature.method]?.(signature) : undefined;
  const lines = [...certificate.lines];
  if (methodLine) {
    const i = lines.findIndex((l) => l.startsWith('Identity verified by') || l.startsWith('Wet-ink signature'));
    if (i >= 0) lines[i] = methodLine;
    else lines.push(methodLine);
  }
  if (signature.method) lines.push(`Signing method: ${signature.method}`);
  if (signature.drawnSignatureSha256) lines.push(`Drawn signature image SHA-256: ${signature.drawnSignatureSha256}`);
  if (signature.evidenceId) lines.push(`Evidence: ${signature.evidenceId}`);
  if (signature.packId) lines.push(`Signed as part of pack ${signature.packId}${signature.packSha256 ? ` (pack SHA-256 ${signature.packSha256})` : ''}`);
  const json = { ...certificate.json, lines, provenance: { method: signature.method ?? 'otp', drawnSignatureSha256: signature.drawnSignatureSha256 ?? null, evidenceId: signature.evidenceId ?? null, packId: signature.packId ?? null, packSha256: signature.packSha256 ?? null } };

  const { absolute } = documentPdfPath(ctx, doc);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const certJsonPath = absolute.replace(/\.pdf$/, `.${certificateId}.json`);
  writeFileSync(certJsonPath, JSON.stringify(json, null, 2), { flag: 'wx' });
  let certificatePdfPath: string | undefined;
  if (hasTemplate('certificate.signature')) {
    try {
      const settings = companySettings(ctx.settings(), { id: input.actor.userId, name: ctx.repos.getUser(ctx.db, input.actor.userId)?.name ?? 'ClaimDesk', role: 'handler' });
      const claim = doc.claimId ? ctx.repos.getClaim(ctx.db, doc.claimId) : undefined;
      const certData = {
        settings,
        date: now,
        claim: claim ? { ourReference: claim.reference, claimantName: signature.signerName, vehicleRegistration: '', accidentDate: claim.accident.occurredAt } : { ourReference: doc.id, claimantName: signature.signerName, vehicleRegistration: '', accidentDate: now },
        certificate: certificate.json,
        lines,
        document: certificate.json.document,
        signer: certificate.json.signer,
        integrity: certificate.json.integrity,
        certificateId,
      };
      const html = renderTemplate('certificate.signature', certData).html;
      const pdf = await renderPdf(html, { reference: claim?.reference ?? doc.id });
      const rel = path.posix.join(doc.claimId ?? '_standalone', `${doc.id}.${certificateId}.pdf`);
      writeFileSync(path.join(ctx.config.documentsDir, rel), pdf.pdf);
      certificatePdfPath = rel;
    } catch (err) {
      ctx.logger.warn('certificate.signature render failed; JSON certificate kept', { error: String(err) });
    }
  }
  signature.certificatePdfPath = certificatePdfPath;
  const signed = ctx.db.transaction((tx) => {
    const s = ctx.repos.attachSignature(tx, doc.id, signature, input.actor);
    ctx.repos.setSignatureProvenance(tx, certificateId, { method: signature.method, drawnSignatureSha256: signature.drawnSignatureSha256, evidenceId: signature.evidenceId, packId: signature.packId, packSha256: signature.packSha256 });
    ctx.repos.appendAudit(tx, { actor: input.actor, action: 'document.sign.verify', entity: 'documents', entityId: doc.id, after: { certificateId, certificateJson: path.basename(certJsonPath), certificatePdfPath, method: signature.method ?? 'otp', packId: signature.packId ?? null, evidenceId: signature.evidenceId ?? null, ipAddress: signature.ipAddress }, at: now });
    return s;
  });
  let duplicate: ConsistencyFlag | undefined;
  if (signed.claimId) {
    const docs = ctx.repos.listDocuments(ctx.db, { claimId: signed.claimId, includeHtml: false });
    // A pack signed in one sitting legitimately shares a date: only documents outside this pack count as duplicates.
    const others = signature.packId ? docs.filter((d) => d.id === signed.id || d.signature?.packId !== signature.packId) : docs;
    duplicate = signatureDateChecks(others, signed.claimId).find((f) => f.code === 'DUPLICATE_SIGNATURE_DATE');
    if (duplicate) {
      const claim = ctx.repos.requireClaim(ctx.db, signed.claimId);
      if (!claim.flags.some((f) => f.code === 'DUPLICATE_SIGNATURE_DATE' && !f.clearedAt && f.message === duplicate!.message)) {
        ctx.repos.addClaimFlag(ctx.db, signed.claimId, { code: 'DUPLICATE_SIGNATURE_DATE', severity: 'warn', message: duplicate.message, raisedBy: 'system', raisedAt: now });
        ctx.repos.appendAudit(ctx.db, { actor: input.actor, action: 'claim.flag.raise', entity: 'claims', entityId: signed.claimId, after: { code: 'DUPLICATE_SIGNATURE_DATE', documentId: doc.id }, at: now });
      }
    }
  }
  return { document: signed, certificateId, ...(certificatePdfPath ? { certificatePdfPath } : {}), ...(duplicate ? { duplicateSignatureDate: duplicate } : {}) };
}
