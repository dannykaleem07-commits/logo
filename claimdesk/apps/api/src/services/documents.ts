/**
 * Documents service: draft → consistency check → (blocked) → approved (PDF rendered) → sent / signed.
 * Nothing is transmitted: `send` records sentAt/sentVia + a chronology event and hands the PDF back to the handler.
 * E-signature is the in-house OTP flow (domain esign): the server keeps only the HMAC token per challenge.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  bannedPhraseCheck,
  buildCertificate,
  certificateIdFor,
  checkDraft,
  clearFlag as clearConsistencyFlag,
  generateOtp,
  isBlocked,
  legacyCheck,
  reExecutionLine,
  signatureDateChecks,
  verifyOtp,
  type ClaimBundle,
  type ConsistencyCode,
  type ConsistencyFlag,
  type ConsistencyReport,
  type EventType,
  type GeneratedDocument,
  type Id,
  type ISODate,
  type ISODateTime,
  type SignatureRecord,
} from '@ccguk/domain';
import { DocumentDataError, TemplateNotFoundError, getTemplate, hasTemplate, htmlToText, listTemplates, mergePdfs, renderPdf, renderTemplate, sha256Hex, type TemplateMeta } from '@ccguk/documents';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { assembleTemplateData, companySettings, defaultRecipientRole, type RecipientRole } from './documentData.js';
import { kbCitations } from './kb.js';
import { reconcileSystemFigures, type ReconciledFlag } from './consistencyReconcile.js';
import { loadBundle, recomputeClocks } from './claimView.js';
import { assertInsideStore } from './evidence.js';

export interface DocUser {
  id: Id;
  name: string;
  role: string;
}

/** Map template-registry errors to HTTP errors. */
export function templateError(err: unknown): never {
  if (err instanceof TemplateNotFoundError) throw new HttpError(404, 'TEMPLATE_NOT_FOUND', `${err.message}. Registered templates: ${listTemplates().map((t) => t.id).join(', ')}`, { templateId: err.templateId });
  if (err instanceof DocumentDataError) throw badRequest(err.message, { code: 'TEMPLATE_DATA_MISSING', templateId: err.templateId, missing: err.missing });
  throw err;
}

export function templateMeta(templateId: string): TemplateMeta | undefined {
  if (!hasTemplate(templateId)) return undefined;
  const t = getTemplate(templateId);
  return { id: t.id, version: t.version, kind: t.kind, title: t.title, recipientRole: t.recipientRole, description: t.description, requiredData: [...t.requiredData] };
}

export function renderOrThrow(templateId: string, data: unknown) {
  try {
    return renderTemplate(templateId, data);
  } catch (err) {
    return templateError(err);
  }
}

/** Where a document's PDF lives (relative to DOCUMENTS_DIR). */
export function documentPdfPath(ctx: AppContext, doc: Pick<GeneratedDocument, 'id' | 'claimId'>): { relative: string; absolute: string } {
  const relative = path.posix.join(doc.claimId ?? '_standalone', `${doc.id}.pdf`);
  return { relative, absolute: path.join(ctx.config.documentsDir, relative) };
}

/** Resolve a stored PDF path under DOCUMENTS_DIR; anything that escapes the store is refused (409 STORE_PATH_INVALID). */
export function resolvePdfPath(ctx: AppContext, pdfPath: string): string {
  const abs = path.isAbsolute(pdfPath) ? pdfPath : path.join(ctx.config.documentsDir, pdfPath);
  return assertInsideStore(ctx.config.documentsDir, abs, 'document pdfPath');
}

export interface VerifiedPdfRead {
  pdf: Buffer;
  computedSha256: string;
  /** True when the stored bytes hash to the document's recorded sha256 (set at approval). */
  intact: boolean;
}

export function readDocumentPdfVerified(ctx: AppContext, doc: GeneratedDocument): VerifiedPdfRead | undefined {
  if (!doc.pdfPath) return undefined;
  const abs = resolvePdfPath(ctx, doc.pdfPath);
  if (!existsSync(abs)) return undefined;
  const pdf = readFileSync(abs);
  const computedSha256 = sha256Hex(pdf);
  return { pdf, computedSha256, intact: computedSha256 === doc.sha256.toLowerCase() };
}

/** The approved PDF — refused (409 DOCUMENT_PDF_TAMPERED) when the bytes on disk no longer hash to the recorded sha256. */
export function readDocumentPdf(ctx: AppContext, doc: GeneratedDocument): Buffer | undefined {
  const read = readDocumentPdfVerified(ctx, doc);
  if (!read) return undefined;
  if (!read.intact) throw conflict('DOCUMENT_PDF_TAMPERED', `The stored PDF for document ${doc.id} does not hash to its recorded sha256 — it is not served`, { recordedSha256: doc.sha256, computedSha256: read.computedSha256 });
  return read.pdf;
}

/** The signature certificate PDF rendered at sign/verify (path from the signature record, contained in DOCUMENTS_DIR). */
export function readCertificatePdf(ctx: AppContext, doc: GeneratedDocument): { pdf: Buffer; sha256: string; certificateId: Id } | undefined {
  const rel = doc.signature?.certificatePdfPath;
  if (!rel || !doc.signature) return undefined;
  const abs = resolvePdfPath(ctx, rel);
  if (!existsSync(abs)) return undefined;
  const pdf = readFileSync(abs);
  return { pdf, sha256: sha256Hex(pdf), certificateId: doc.signature.certificateId };
}

function toDraftRole(role: RecipientRole | undefined): 'at_fault_insurer' | 'client' | 'own_insurer' | 'court' | 'other' | undefined {
  if (!role) return undefined;
  return role === 'supplier' ? 'other' : role;
}

function priorOutgoing(ctx: AppContext, claimId: Id): GeneratedDocument[] {
  return ctx.repos.listDocuments(ctx.db, { claimId, status: ['approved', 'sent', 'signed'], includeHtml: true });
}

export function runConsistency(ctx: AppContext, html: string, bundle: ClaimBundle, templateId: string, role: RecipientRole | undefined, createdAt: ISODateTime): ConsistencyReport {
  return checkDraft(html, {
    bundle,
    priorOutgoing: priorOutgoing(ctx, bundle.claim.id),
    draftCreatedAt: createdAt,
    templateId,
    recipientRole: toDraftRole(role),
    kbCitations: kbCitations(ctx),
    registeredName: ctx.settings().companyName,
    now: createdAt,
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateClaimDocumentInput {
  claimId: Id;
  templateId: string;
  extra?: Record<string, unknown>;
  recipientPartyId?: Id;
  user: DocUser;
  actor: Actor;
  /** Supersession: the previous document. */
  supersedes?: GeneratedDocument;
  reExecutedOn?: ISODate;
}

export function createClaimDocument(ctx: AppContext, input: CreateClaimDocumentInput): GeneratedDocument {
  const meta = templateMeta(input.templateId);
  if (!meta) templateError(new TemplateNotFoundError(input.templateId));
  recomputeClocks(ctx, input.claimId);
  const bundle = loadBundle(ctx, input.claimId, true);
  const role = (meta!.recipientRole as RecipientRole | undefined) ?? defaultRecipientRole(input.templateId);
  const assembled = assembleTemplateData(ctx, bundle, input.templateId, role, input.user, { extra: input.extra, recipientPartyId: input.recipientPartyId });
  const now = ctx.now();
  if (input.supersedes) {
    const line = reExecutionLine(input.supersedes, input.reExecutedOn ?? now.slice(0, 10));
    assembled.data.reExecutedOn = input.reExecutedOn ?? now.slice(0, 10);
    assembled.data.reExecutionLine = line;
    assembled.data.supersedesVersion = input.supersedes.templateVersion;
    assembled.data.supersedesDocumentId = input.supersedes.id;
  }
  const rendered = renderOrThrow(input.templateId, assembled.data);
  let html = rendered.html;
  if (input.supersedes && typeof assembled.data.reExecutionLine === 'string' && !html.includes(assembled.data.reExecutionLine)) {
    html = html.replace(/<\/body>/i, `<p class="small muted re-execution">${assembled.data.reExecutionLine}</p></body>`);
  }
  const checked = runConsistency(ctx, html, bundle, input.templateId, assembled.recipientRole, now);
  const reconciled = reconcileLedgerFigures(ctx, bundle, input, assembled, checked, now);
  const cleared = reconciled.cleared;
  const unused = unusedExtraFlags(input.extra, html);
  const report: ConsistencyReport = unused.length ? { ...reconciled.report, flags: [...reconciled.report.flags, ...unused] } : reconciled.report;
  return ctx.db.transaction((tx) => {
    const draftInput = {
      claimId: input.claimId,
      templateId: rendered.templateId,
      templateVersion: rendered.templateVersion,
      title: rendered.title,
      recipientPartyId: assembled.recipientPartyId,
      html,
      sha256: sha256Hex(html),
      dataSnapshot: assembled.data,
      createdBy: input.user.id,
      createdAt: now,
      reExecutedOn: input.supersedes ? (input.reExecutedOn ?? now.slice(0, 10)) : undefined,
    };
    const doc = input.supersedes ? ctx.repos.supersedeDocument(tx, input.supersedes.id, input.actor, draftInput, { reExecutedOn: draftInput.reExecutedOn }) : ctx.repos.createDraft(tx, draftInput);
    const stored = ctx.repos.setConsistency(tx, doc.id, report);
    ctx.repos.appendAudit(tx, {
      actor: input.actor,
      action: 'document.create',
      entity: 'documents',
      entityId: doc.id,
      after: { claimId: input.claimId, templateId: doc.templateId, templateVersion: doc.templateVersion, status: stored.status, blocked: report.blocked, flags: report.flags.map((f) => f.code), systemCleared: cleared.length ? cleared : undefined, supersedes: input.supersedes?.id },
      at: now,
    });
    return stored;
  });
}

/**
 * Handler text the template never prints is a silent loss: the handler believes the paragraph is in the letter.
 * Every free-text leaf of the extras (12+ characters, not an id) must appear in the rendered text; otherwise a warn
 * flag names the field so the handler can move the text to a field the template declares.
 */
export function unusedExtraFlags(extra: Record<string, unknown> | undefined, html: string): ConsistencyFlag[] {
  if (!extra) return [];
  const norm = (s: string): string => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
  const text = norm(htmlToText(html));
  const out: ConsistencyFlag[] = [];
  const walk = (v: unknown, p: string): void => {
    if (typeof v === 'string') {
      if (v.trim().length >= 12 && !/(^|\.)(id|[a-z]+Id)$/.test(p) && !text.includes(norm(v))) {
        out.push({ code: 'UNKNOWN_REFERENCE', severity: 'warn', message: `The text supplied in "${p}" does not appear in the document: this template does not print that field. Use one of the template's declared fields (GET /api/templates).`, draftValue: v.slice(0, 120) });
      }
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
  };
  walk(extra, '');
  return out;
}

/**
 * Engine flags on figures the API wrote from the ledger (table-layout misreads) are cleared by the system with a
 * reason — see services/consistencyReconcile.ts. Requires the ledger-only render (the template without the handler's
 * extra text); when that render is impossible (a required free-text field) nothing is cleared.
 */
function reconcileLedgerFigures(ctx: AppContext, bundle: ClaimBundle, input: CreateClaimDocumentInput, assembled: ReturnType<typeof assembleTemplateData>, report: ConsistencyReport, now: ISODateTime): { report: ConsistencyReport; cleared: ReconciledFlag[] } {
  const hasExtra = Boolean(input.extra && Object.keys(input.extra).length);
  let ledgerOnly: ConsistencyReport | undefined = hasExtra ? undefined : report;
  if (hasExtra) {
    try {
      const plain = assembleTemplateData(ctx, bundle, input.templateId, assembled.recipientRole, input.user, { recipientPartyId: input.recipientPartyId, recipientRole: assembled.recipientRole });
      const rendered = renderTemplate(input.templateId, plain.data);
      ledgerOnly = runConsistency(ctx, rendered.html, bundle, input.templateId, assembled.recipientRole, now);
    } catch {
      ledgerOnly = undefined; // a template that needs the handler's text cannot be rendered ledger-only: leave every flag for a human
    }
  }
  return reconcileSystemFigures({ report, ledgerOnly, snapshot: assembled.data, derivedKeys: assembled.derivedKeys, ledger: bundle.ledger, now });
}

export interface CreateStandaloneDocumentInput {
  templateId: string;
  data: Record<string, unknown>;
  title?: string;
  recipientPartyId?: Id;
  user: DocUser;
  actor: Actor;
  /** Optional claim whose bundle the consistency engine should use (e.g. a penalty linked to a hire on a claim). */
  claimId?: Id;
}

/** Documents not attached to a claim (fleet notices). Legacy/banned-phrase checks always run; the full engine runs when a claim is linked. */
export function createStandaloneDocument(ctx: AppContext, input: CreateStandaloneDocumentInput): GeneratedDocument {
  const meta = templateMeta(input.templateId);
  if (!meta) templateError(new TemplateNotFoundError(input.templateId));
  const now = ctx.now();
  const settings = companySettings(ctx.settings(), input.user);
  const data = { settings, date: now, signatory: { name: settings.signatoryName, role: settings.signatoryRole }, ...input.data };
  const rendered = renderOrThrow(input.templateId, data);
  let report: ConsistencyReport;
  if (input.claimId) {
    const bundle = loadBundle(ctx, input.claimId, true);
    report = runConsistency(ctx, rendered.html, bundle, input.templateId, (meta!.recipientRole as RecipientRole | undefined) ?? 'other', now);
  } else {
    const flags: ConsistencyFlag[] = [...legacyCheck(rendered.html), ...bannedPhraseCheck(rendered.html)];
    report = { checkedAt: now, flags, blocked: isBlocked(flags) };
  }
  return ctx.db.transaction((tx) => {
    const doc = ctx.repos.createDraft(tx, {
      claimId: input.claimId,
      templateId: rendered.templateId,
      templateVersion: rendered.templateVersion,
      title: input.title ?? rendered.title,
      recipientPartyId: input.recipientPartyId,
      html: rendered.html,
      sha256: rendered.htmlSha256,
      dataSnapshot: data,
      createdBy: input.user.id,
      createdAt: now,
    });
    const checked = ctx.repos.setConsistency(tx, doc.id, report);
    ctx.repos.appendAudit(tx, { actor: input.actor, action: 'document.create', entity: 'documents', entityId: doc.id, after: { templateId: doc.templateId, status: checked.status, blocked: report.blocked, flags: report.flags.map((f) => f.code) }, at: now });
    return checked;
  });
}

// ---------------------------------------------------------------------------
// Flags, approval, PDF
// ---------------------------------------------------------------------------

/** Clear one flag with a reason. `excerpt` pins the occurrence; the web client may send `index` (nth open flag with that code) instead. */
export function clearDocumentFlag(ctx: AppContext, id: Id, input: { code: string; excerpt?: string; reason: string; index?: number }, actor: Actor): GeneratedDocument {
  const doc = ctx.repos.requireDocument(ctx.db, id, { includeHtml: false });
  if (!doc.consistency) throw conflict('DOCUMENT_STATE', 'Document has no consistency report');
  if (doc.status !== 'draft' && doc.status !== 'blocked') throw conflict('DOCUMENT_STATE', `Flags can only be cleared on a draft (status is ${doc.status})`);
  if (input.excerpt === undefined && input.index !== undefined) {
    const nth = doc.consistency.flags.filter((f) => f.code === input.code && !f.clearedAt)[input.index];
    if (!nth) throw notFound('consistency flag', `${id}/${input.code}[${input.index}]`);
    input = { ...input, excerpt: nth.excerpt };
  }
  const open = doc.consistency.flags.filter((f) => f.code === input.code && !f.clearedAt && (input.excerpt === undefined || f.excerpt === input.excerpt));
  if (!open.length) throw notFound('consistency flag', `${id}/${input.code}`);
  const now = ctx.now();
  let report: ConsistencyReport;
  try {
    report = clearConsistencyFlag(doc.consistency, input.code as ConsistencyCode, input.excerpt, actor.userId, input.reason, now);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
  return ctx.db.transaction((tx) => {
    const updated = ctx.repos.setConsistency(tx, id, report);
    ctx.repos.appendAudit(tx, { actor, action: 'document.flag.clear', entity: 'documents', entityId: id, before: { status: doc.status, code: input.code }, after: { status: updated.status, code: input.code, excerpt: input.excerpt, reason: input.reason, blocked: report.blocked }, at: now });
    return updated;
  });
}

export interface PdfRender {
  pdf: Buffer;
  sha256: string;
  pages: number;
  relativePath: string;
}

/** Render the PDF (header: our reference; footer: status line + Part 6 disclosure) and, for the GTA pack, merge the component PDFs. */
export async function renderDocumentPdf(ctx: AppContext, doc: GeneratedDocument): Promise<PdfRender> {
  const settings = ctx.settings();
  const ro = settings.registeredOffice;
  const reference = doc.claimId ? (ctx.repos.getClaim(ctx.db, doc.claimId)?.reference ?? doc.id) : doc.id;
  const rendered = await renderPdf(doc.html, {
    reference,
    registeredOffice: ro ? [ro.line1, ro.line2, ro.town, ro.postcode].filter(Boolean).join(', ') : undefined,
  });
  let pdf = rendered.pdf;
  let pages = rendered.pages;
  if (doc.templateId === 'pack.gta_payment') {
    const components = Array.isArray(doc.dataSnapshot.components) ? (doc.dataSnapshot.components as Array<{ documentId?: string }>) : [];
    const buffers: Buffer[] = [pdf];
    for (const c of components) {
      if (!c.documentId) continue;
      const comp = ctx.repos.getDocument(ctx.db, c.documentId, { includeHtml: false });
      const bytes = comp ? readDocumentPdf(ctx, comp) : undefined;
      if (bytes) buffers.push(bytes);
    }
    if (buffers.length > 1) {
      pdf = await mergePdfs(buffers);
      pages = 0;
    }
  }
  const { relative, absolute } = documentPdfPath(ctx, doc);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, pdf);
  return { pdf, sha256: sha256Hex(pdf), pages, relativePath: relative };
}

export async function approveDocument(ctx: AppContext, id: Id, actor: Actor, note?: string): Promise<GeneratedDocument> {
  const doc = ctx.repos.requireDocument(ctx.db, id, { includeHtml: true });
  if (doc.status === 'blocked' || doc.consistency?.blocked) {
    const open = (doc.consistency?.flags ?? []).filter((f) => f.severity === 'block' && !f.clearedAt);
    throw conflict('DOCUMENT_BLOCKED', `Document is blocked by the consistency check: ${open.map((f) => f.code).join(', ')}. Clear each flag with a reason first.`, { flags: open });
  }
  if (doc.status !== 'draft') throw conflict('DOCUMENT_STATE', `Only a draft can be approved (status is ${doc.status})`);
  if (actor.userId === 'system') throw conflict('HUMAN_REQUIRED', 'A human approver is required');
  const pdf = await renderDocumentPdf(ctx, doc);
  const now = ctx.now();
  return ctx.db.transaction((tx) => {
    ctx.repos.setDocumentPdf(tx, id, { pdfPath: pdf.relativePath, sha256: pdf.sha256 });
    const approved = ctx.repos.approveDocument(tx, id, actor, now);
    ctx.repos.appendAudit(tx, { actor, action: 'document.pdf', entity: 'documents', entityId: id, after: { pdfPath: pdf.relativePath, sha256: pdf.sha256, pages: pdf.pages, note }, at: now });
    return approved;
  });
}

// ---------------------------------------------------------------------------
// Send (records only) and supersede
// ---------------------------------------------------------------------------

const SEMANTIC_SEND_EVENT: Record<string, EventType> = {
  'letter.ncaf': 'ncaf_sent',
  'pack.gta_payment': 'payment_pack_sent',
  'letter.chaser_7': 'chaser_sent',
  'letter.chaser_14': 'chaser_sent',
  'letter.chaser_21': 'chaser_sent',
  'letter.complaint_disp': 'complaint_sent',
  'letter.dsar': 'dsar_sent',
  'letter.cctv_preservation': 'cctv_request_sent',
  'letter.letter_before_claim': 'letter_before_claim_sent',
  'letter.part36_offer': 'part36_sent',
  'letter.intervention_reply': 'intervention_reply_sent',
  'letter.collect_or_pay': 'collect_or_pay_notice_sent',
  'notice.s172_response': 's172_response_sent',
  'notice.pcn_liability_transfer': 'pcn_liability_transferred',
};

export interface SendResult {
  document: GeneratedDocument;
  events: Array<{ id: Id; type: string }>;
  pdfUrl: string;
  pdfBase64?: string;
  note: string;
}

/** Record that the handler is sending the document. Nothing is transmitted here. */
export async function sendDocument(ctx: AppContext, id: Id, input: { via: NonNullable<GeneratedDocument['sentVia']>; to?: string; note?: string }, actor: Actor): Promise<SendResult> {
  const doc = ctx.repos.requireDocument(ctx.db, id, { includeHtml: false });
  if (doc.status !== 'approved' && doc.status !== 'signed') throw conflict('DOCUMENT_STATE', `Only an approved (or signed) document can be sent (status is ${doc.status})`);
  const stored = readDocumentPdfVerified(ctx, doc);
  if (stored && !stored.intact) {
    throw conflict('DOCUMENT_PDF_TAMPERED', `The stored PDF for document ${id} does not hash to its approved sha256 — it cannot be sent; supersede and re-approve`, { recordedSha256: doc.sha256, computedSha256: stored.computedSha256 });
  }
  if (!stored) {
    // An approved document whose PDF was never rendered (or has gone) is rendered now; a signed one is not — re-rendering would break the signature's hash chain.
    if (doc.status === 'signed') throw conflict('DOCUMENT_PDF_MISSING', `The signed PDF for document ${id} is missing from the store and cannot be re-rendered without breaking the signature — supersede and re-execute`);
    const full = ctx.repos.requireDocument(ctx.db, id, { includeHtml: true });
    const pdf = await renderDocumentPdf(ctx, full);
    const at = ctx.now();
    ctx.db.transaction((tx) => {
      ctx.repos.setDocumentPdf(tx, id, { pdfPath: pdf.relativePath, sha256: pdf.sha256 });
      ctx.repos.appendAudit(tx, { actor, action: 'document.pdf', entity: 'documents', entityId: id, after: { pdfPath: pdf.relativePath, sha256: pdf.sha256, pages: pdf.pages, reason: 'rendered at send — no stored PDF' }, at });
    });
  }
  const now = ctx.now();
  const result = ctx.db.transaction((tx) => {
    const sent = ctx.repos.markDocumentSent(tx, id, actor, { sentVia: input.via, sentAt: now });
    const events: Array<{ id: Id; type: string }> = [];
    let offerReplyRecorded: Id | undefined;
    if (sent.claimId) {
      const outType = input.via === 'post' || input.via === 'hand' ? 'letter_out' : 'email_out';
      const e1 = ctx.repos.appendEvent(tx, { claimId: sent.claimId, type: outType, at: now, summary: `${sent.title} sent by ${input.via}${input.to ? ` to ${input.to}` : ''}`, data: { documentId: id, templateId: sent.templateId, via: input.via, to: input.to, note: input.note }, attributableTo: 'ccguk', documentId: id, createdBy: actor.userId, recordedAt: now });
      events.push({ id: e1.id, type: e1.type });
      const semantic = SEMANTIC_SEND_EVENT[sent.templateId];
      if (semantic) {
        const e2 = ctx.repos.appendEvent(tx, { claimId: sent.claimId, type: semantic, at: now, summary: `${sent.title} sent (${input.via})`, data: { documentId: id, templateId: sent.templateId, via: input.via }, attributableTo: 'ccguk', documentId: id, createdBy: actor.userId, recordedAt: now });
        events.push({ id: e2.id, type: e2.type });
        const offerId = sent.dataSnapshot?.offer && typeof (sent.dataSnapshot.offer as { offerId?: unknown }).offerId === 'string' ? (sent.dataSnapshot.offer as { offerId: string }).offerId : undefined;
        if (semantic === 'intervention_reply_sent' && offerId) {
          const offer = ctx.repos.getOffer(tx, offerId);
          if (offer && !offer.replySentAt) {
            ctx.repos.recordOfferReply(tx, offerId, { replySentAt: now, replyDocumentId: id });
            offerReplyRecorded = offerId;
          }
        }
      }
    }
    ctx.repos.appendAudit(tx, { actor, action: 'document.send.record', entity: 'documents', entityId: id, after: { via: input.via, to: input.to, sentAt: now, events, offerReplyRecorded, transmitted: false }, at: now });
    return { document: sent, events };
  });
  if (result.document.claimId) recomputeClocks(ctx, result.document.claimId);
  const pdf = readDocumentPdf(ctx, result.document);
  return { ...result, pdfUrl: `/api/documents/${id}/pdf`, pdfBase64: pdf?.toString('base64'), note: 'Recorded only — nothing has been transmitted. Attach the PDF and send it by the recorded channel.' };
}

export function supersedeDocument(ctx: AppContext, id: Id, input: { extra?: Record<string, unknown>; reason?: string; reExecutedOn?: ISODate }, user: DocUser, actor: Actor): GeneratedDocument {
  const old = ctx.repos.requireDocument(ctx.db, id, { includeHtml: false });
  if (old.status === 'void' || old.status === 'superseded') throw conflict('DOCUMENT_STATE', `A ${old.status} document cannot be superseded`);
  if (!old.claimId) throw conflict('DOCUMENT_STATE', 'Standalone documents are re-created rather than superseded');
  const extra = input.extra ?? pickExtra(old.dataSnapshot);
  return createClaimDocument(ctx, { claimId: old.claimId, templateId: old.templateId, extra, recipientPartyId: old.recipientPartyId, user, actor, supersedes: old, reExecutedOn: input.reExecutedOn });
}

/** The free-text fields a previous snapshot carried (everything not derivable is kept; derived blocks are rebuilt). */
function pickExtra(snapshot: Record<string, unknown>): Record<string, unknown> {
  const keep = ['insurerPosition', 'liabilitySummary', 'damageSummary', 'termsExplained', 'collectionContact', 'workDone', 'purpose', 'notes', 'coveringText', 'additionalText'];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (snapshot[k] !== undefined) out[k] = snapshot[k];
  return out;
}

// ---------------------------------------------------------------------------
// E-signature
// ---------------------------------------------------------------------------

export interface SignChallenge {
  challengeId: Id;
  documentId: Id;
  documentSha256: string;
  signerPartyId: Id;
  signerName: string;
  contact: string;
  channel: 'email' | 'sms';
  issuedAt: ISODateTime;
  expiresAt: ISODateTime;
  token: string;
  nonce: string;
  attempts: number;
}

const challenges = new Map<Id, SignChallenge>();
const MAX_ATTEMPTS = 5;

export function signingSecret(ctx: AppContext): string {
  const secret = ctx.config.keys.esignSecret ?? process.env.SIGNING_SECRET;
  if (secret) return secret;
  if (ctx.config.env === 'production') throw conflict('ESIGN_NOT_CONFIGURED', 'SIGNING_SECRET / ESIGN_SECRET must be set in production');
  return 'claimdesk-dev-signing-secret';
}

export interface SignStartResult {
  challengeId: Id;
  channel: 'email' | 'sms';
  expiresAt: ISODateTime;
  contactMasked: string;
  /** Development/test only: the code is echoed because no mail/SMS provider is wired. Never present in production. */
  devCode?: string;
  debugCode?: string;
}

function maskContact(c: string): string {
  if (c.includes('@')) {
    const [u, d] = c.split('@');
    return `${(u ?? '').slice(0, 2)}***@${d ?? ''}`;
  }
  return `***${c.slice(-3)}`;
}

export function startSignature(ctx: AppContext, id: Id, input: { signerPartyId: Id; signerName?: string; contact: string; channel: 'email' | 'sms' }, actor: Actor): SignStartResult {
  const doc = ctx.repos.requireDocument(ctx.db, id, { includeHtml: false });
  if (doc.status !== 'approved' && doc.status !== 'sent') throw conflict('DOCUMENT_STATE', `Only an approved document can be put to signature (status is ${doc.status})`);
  if (doc.signature) throw conflict('DOCUMENT_STATE', 'Document already carries a signature');
  const signer = ctx.repos.requireParty(ctx.db, input.signerPartyId);
  const now = ctx.now();
  const nonce = randomUUID();
  const otp = generateOtp({ secret: signingSecret(ctx), documentId: id, documentSha256: doc.sha256, contact: input.contact, channel: input.channel, issuedAt: now, nonce });
  const challenge: SignChallenge = { challengeId: randomUUID(), documentId: id, documentSha256: doc.sha256, signerPartyId: signer.id, signerName: input.signerName ?? signer.name, contact: input.contact, channel: input.channel, issuedAt: now, expiresAt: otp.expiresAt, token: otp.token, nonce, attempts: 0 };
  for (const [k, c] of challenges) if (c.documentId === id || Date.parse(c.expiresAt) < Date.parse(now)) challenges.delete(k);
  challenges.set(challenge.challengeId, challenge);
  ctx.repos.appendAudit(ctx.db, { actor, action: 'document.sign.start', entity: 'documents', entityId: id, after: { challengeId: challenge.challengeId, signerPartyId: signer.id, channel: input.channel, contact: maskContact(input.contact), expiresAt: otp.expiresAt, tokenSha256: sha256Hex(otp.token) }, at: now });
  const dev = ctx.config.env !== 'production' ? otp.code : undefined;
  return { challengeId: challenge.challengeId, channel: input.channel, expiresAt: otp.expiresAt, contactMasked: maskContact(input.contact), devCode: dev, debugCode: dev };
}

export interface SignVerifyInput {
  challengeId?: Id;
  code: string;
  ipAddress: string;
  userAgent: string;
}

export interface SignVerifyResult {
  document: GeneratedDocument;
  certificateId: Id;
  certificatePdfPath?: string;
  duplicateSignatureDate?: ConsistencyFlag;
}

export async function verifySignature(ctx: AppContext, id: Id, input: SignVerifyInput, actor: Actor): Promise<SignVerifyResult> {
  const doc = ctx.repos.requireDocument(ctx.db, id, { includeHtml: false });
  const challenge = input.challengeId ? challenges.get(input.challengeId) : [...challenges.values()].filter((c) => c.documentId === id).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))[0];
  if (!challenge || challenge.documentId !== id) throw new HttpError(400, 'OTP_NO_CHALLENGE', 'No open signing challenge for this document — start again');
  const now = ctx.now();
  if (challenge.attempts >= MAX_ATTEMPTS) {
    challenges.delete(challenge.challengeId);
    throw new HttpError(400, 'OTP_LOCKED', 'Too many attempts — start a new challenge');
  }
  challenge.attempts += 1;
  const result = verifyOtp({ secret: signingSecret(ctx), token: challenge.token, documentId: id, documentSha256: challenge.documentSha256, contact: challenge.contact, issuedAt: challenge.issuedAt, code: input.code, now, nonce: challenge.nonce });
  if (!result.ok) {
    ctx.repos.appendAudit(ctx.db, { actor, action: 'document.sign.fail', entity: 'documents', entityId: id, after: { challengeId: challenge.challengeId, reason: result.reason, attempts: challenge.attempts }, at: now });
    throw new HttpError(400, 'OTP_INVALID', `One-time code rejected (${result.reason})`, { reason: result.reason, expiresAt: result.expiresAt });
  }
  if (challenge.documentSha256.toLowerCase() !== doc.sha256.toLowerCase()) throw conflict('DOCUMENT_CHANGED', 'The document changed after the code was issued — start again');
  if (Date.parse(now) < Date.parse(doc.createdAt)) throw conflict('DATE_BEFORE_CREATION', `A document cannot be signed (${now}) before it was created (${doc.createdAt})`);
  const signedAt = now;
  const certificateId = certificateIdFor(id, doc.sha256, signedAt, challenge.token);
  const signature: SignatureRecord = {
    signerPartyId: challenge.signerPartyId,
    signerName: challenge.signerName,
    signerContact: challenge.contact,
    otpChannel: challenge.channel,
    otpVerifiedAt: now,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    signedAt,
    documentSha256: doc.sha256,
    certificateId,
  };
  const certificate = buildCertificate({ document: doc, signature, otpToken: challenge.token, generatedAt: now, issuer: ctx.settings().companyName });
  // Certificate: PDF when the certificate.signature template is registered, JSON alongside the document in every case.
  const { absolute } = documentPdfPath(ctx, doc);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const certJsonPath = absolute.replace(/\.pdf$/, `.${certificateId}.json`);
  writeFileSync(certJsonPath, JSON.stringify(certificate.json, null, 2), { flag: 'wx' });
  let certificatePdfPath: string | undefined;
  if (hasTemplate('certificate.signature')) {
    try {
      const settings = companySettings(ctx.settings(), { id: actor.userId, name: ctx.repos.getUser(ctx.db, actor.userId)?.name ?? 'ClaimDesk', role: 'handler' });
      const claim = doc.claimId ? ctx.repos.getClaim(ctx.db, doc.claimId) : undefined;
      const certData = { settings, date: now, claim: claim ? { ourReference: claim.reference, claimantName: challenge.signerName, vehicleRegistration: '', accidentDate: claim.accident.occurredAt } : { ourReference: doc.id, claimantName: challenge.signerName, vehicleRegistration: '', accidentDate: now }, certificate: certificate.json, lines: certificate.lines, document: certificate.json.document, signer: certificate.json.signer, integrity: certificate.json.integrity, certificateId };
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
  challenges.delete(challenge.challengeId);
  const signed = ctx.db.transaction((tx) => {
    const s = ctx.repos.attachSignature(tx, id, signature, actor);
    ctx.repos.appendAudit(tx, { actor, action: 'document.sign.verify', entity: 'documents', entityId: id, after: { certificateId, certificateJson: path.basename(certJsonPath), certificatePdfPath, ipAddress: input.ipAddress }, at: now });
    return s;
  });
  // Duplicate-signature-date alert on the claim (lesson b)
  let duplicate: ConsistencyFlag | undefined;
  if (signed.claimId) {
    const docs = ctx.repos.listDocuments(ctx.db, { claimId: signed.claimId, includeHtml: false });
    duplicate = signatureDateChecks(docs, signed.claimId).find((f) => f.code === 'DUPLICATE_SIGNATURE_DATE');
    if (duplicate) {
      const claim = ctx.repos.requireClaim(ctx.db, signed.claimId);
      if (!claim.flags.some((f) => f.code === 'DUPLICATE_SIGNATURE_DATE' && !f.clearedAt && f.message === duplicate!.message)) {
        ctx.repos.addClaimFlag(ctx.db, signed.claimId, { code: 'DUPLICATE_SIGNATURE_DATE', severity: 'warn', message: duplicate.message, raisedBy: 'system', raisedAt: now });
        ctx.repos.appendAudit(ctx.db, { actor, action: 'claim.flag.raise', entity: 'claims', entityId: signed.claimId, after: { code: 'DUPLICATE_SIGNATURE_DATE', documentId: id }, at: now });
      }
    }
  }
  return { document: signed, certificateId, certificatePdfPath, duplicateSignatureDate: duplicate };
}

/** Test hook. */
export function openChallenges(): SignChallenge[] {
  return [...challenges.values()];
}
