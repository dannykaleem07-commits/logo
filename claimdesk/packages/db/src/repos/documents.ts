import { and, desc, eq, getTableColumns, inArray, type SQL } from 'drizzle-orm';
import type { ConsistencyReport, DocumentStatus, GeneratedDocument, Id, ISODate, ISODateTime, SignatureRecord } from '@ccguk/domain';
import type { Db } from '../client.js';
import { DocumentStateError, NotFoundError, ValidationError } from '../errors.js';
import { documents, signatures, type DocumentRow } from '../schema.js';
import { compact, denull, newId, nowIso } from '../util.js';
import { appendAudit, type Actor } from './audit.js';

export type CreateDraftInput = Omit<GeneratedDocument, 'id' | 'status' | 'createdAt' | 'approvedAt' | 'approvedBy' | 'sentAt' | 'sentVia' | 'signature'> & {
  id?: Id;
  createdAt?: ISODateTime;
};

export interface GetDocumentOptions {
  /** Default true for single reads, false for lists/bundles (html can be large). When false, `html` is ''. */
  includeHtml?: boolean;
}

function toDocument(row: DocumentRow): GeneratedDocument {
  const { updatedAt: _u, ...rest } = row;
  return denull(rest);
}

const { html: _htmlCol, ...columnsWithoutHtml } = getTableColumns(documents);

function selectDocs(db: Db, includeHtml: boolean) {
  return includeHtml ? db.select().from(documents) : db.select({ ...columnsWithoutHtml, html: documents.id }).from(documents);
}

function finish(row: DocumentRow, includeHtml: boolean): GeneratedDocument {
  return includeHtml ? toDocument(row) : { ...toDocument(row), html: '' };
}

/** Create a draft. Status is 'draft' until `setConsistency` marks it blocked or a human approves it. */
export function createDraft(db: Db, input: CreateDraftInput): GeneratedDocument {
  if (!input.templateId?.trim()) throw new ValidationError('templateId is required');
  if (!input.templateVersion?.trim()) throw new ValidationError('templateVersion is required');
  const id = input.id ?? newId();
  const now = input.createdAt ?? nowIso();
  const blocked = input.consistency?.blocked === true;
  db.insert(documents)
    .values({ ...input, id, status: blocked ? 'blocked' : 'draft', createdAt: now, updatedAt: nowIso() })
    .run();
  return requireDocument(db, id);
}

export function getDocument(db: Db, id: Id, options: GetDocumentOptions = {}): GeneratedDocument | undefined {
  const includeHtml = options.includeHtml ?? true;
  const row = selectDocs(db, includeHtml).where(eq(documents.id, id)).get();
  return row ? finish(row as DocumentRow, includeHtml) : undefined;
}

export function requireDocument(db: Db, id: Id, options: GetDocumentOptions = {}): GeneratedDocument {
  const d = getDocument(db, id, options);
  if (!d) throw new NotFoundError('document', id);
  return d;
}

export interface ListDocumentsFilter {
  claimId?: Id;
  templateId?: string | string[];
  status?: DocumentStatus | DocumentStatus[];
  /** Default false. */
  includeHtml?: boolean;
  limit?: number;
}

export function listDocuments(db: Db, filter: ListDocumentsFilter = {}): GeneratedDocument[] {
  const where: SQL[] = [];
  if (filter.claimId) where.push(eq(documents.claimId, filter.claimId));
  if (filter.templateId) where.push(Array.isArray(filter.templateId) ? inArray(documents.templateId, filter.templateId) : eq(documents.templateId, filter.templateId));
  if (filter.status) where.push(Array.isArray(filter.status) ? inArray(documents.status, filter.status) : eq(documents.status, filter.status));
  const includeHtml = filter.includeHtml ?? false;
  const rows = selectDocs(db, includeHtml)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(documents.createdAt))
    .limit(filter.limit ?? 500)
    .all();
  return rows.map((r) => finish(r as DocumentRow, includeHtml));
}

/** Outgoing documents already sent on a claim — the consistency engine compares a new draft against these. */
export function listSentDocuments(db: Db, claimId: Id, includeHtml = true): GeneratedDocument[] {
  return listDocuments(db, { claimId, status: ['sent', 'signed'], includeHtml });
}

/**
 * Attach the consistency report. A report with an uncleared block moves draft → blocked; a clean report moves
 * blocked → draft. Approved/sent documents are not touched (re-check creates a superseding draft instead).
 */
export function setConsistency(db: Db, id: Id, report: ConsistencyReport): GeneratedDocument {
  const doc = requireDocument(db, id, { includeHtml: false });
  if (doc.status !== 'draft' && doc.status !== 'blocked') {
    throw new DocumentStateError(id, doc.status, `cannot re-check a ${doc.status} document; supersede it with a new draft`);
  }
  const blocked = report.flags.some((f) => f.severity === 'block' && !f.clearedAt);
  db.update(documents)
    .set({ consistency: { ...report, blocked }, status: blocked ? 'blocked' : 'draft', updatedAt: nowIso() })
    .where(eq(documents.id, id))
    .run();
  return requireDocument(db, id);
}

/** Clear one block/warn flag with a reason (audited as `document.flag.clear`). Unblocks when no block remains. */
export function clearDocumentFlag(db: Db, id: Id, code: string, actor: Actor, reason: string): GeneratedDocument {
  if (!reason?.trim()) throw new ValidationError('a reason is required to clear a flag');
  return db.transaction((tx) => {
    const doc = requireDocument(tx, id, { includeHtml: false });
    if (!doc.consistency) throw new DocumentStateError(id, doc.status, 'document has no consistency report');
    const at = nowIso();
    let cleared = false;
    const flags = doc.consistency.flags.map((f) => {
      if (f.code === code && !f.clearedAt) {
        cleared = true;
        return { ...f, clearedAt: at, clearedBy: actor.userId, clearedReason: reason };
      }
      return f;
    });
    if (!cleared) throw new NotFoundError('consistency flag', `${id}/${code}`);
    const blocked = flags.some((f) => f.severity === 'block' && !f.clearedAt);
    const status: DocumentStatus = doc.status === 'blocked' && !blocked ? 'draft' : doc.status;
    tx.update(documents)
      .set({ consistency: { ...doc.consistency, flags, blocked }, status, updatedAt: at })
      .where(eq(documents.id, id))
      .run();
    appendAudit(tx, { actor, action: 'document.flag.clear', entity: 'documents', entityId: id, before: { code, status: doc.status }, after: { code, reason, status }, at });
    return requireDocument(tx, id);
  });
}

/** Human approval. Refused while blocked or if not a draft (ARCHITECTURE convention 5). Audited. */
export function approveDocument(db: Db, id: Id, actor: Actor, at?: ISODateTime): GeneratedDocument {
  if (actor.userId === 'system') throw new ValidationError('a human approver is required; documents are never approved by the system');
  return db.transaction((tx) => {
    const doc = requireDocument(tx, id, { includeHtml: false });
    if (doc.status === 'blocked' || doc.consistency?.blocked) {
      throw new DocumentStateError(id, doc.status, 'document is blocked by the consistency check; clear each flag with a reason first');
    }
    if (doc.status !== 'draft') throw new DocumentStateError(id, doc.status, `only a draft can be approved (status is ${doc.status})`);
    const when = at ?? nowIso();
    tx.update(documents).set({ status: 'approved', approvedAt: when, approvedBy: actor.userId, updatedAt: nowIso() }).where(eq(documents.id, id)).run();
    // audit `at` is always the recording time; `approvedAt` may be a supplied business timestamp
    appendAudit(tx, { actor, action: 'document.approve', entity: 'documents', entityId: id, before: { status: doc.status }, after: { status: 'approved', approvedAt: when, sha256: doc.sha256 } });
    return requireDocument(tx, id);
  });
}

/** Mark sent. Only approved (or signed) documents can be sent. Audited. */
export function markDocumentSent(db: Db, id: Id, actor: Actor, input: { sentVia: NonNullable<GeneratedDocument['sentVia']>; sentAt?: ISODateTime }): GeneratedDocument {
  return db.transaction((tx) => {
    const doc = requireDocument(tx, id, { includeHtml: false });
    if (doc.status !== 'approved' && doc.status !== 'signed') {
      throw new DocumentStateError(id, doc.status, `only an approved or signed document can be sent (status is ${doc.status})`);
    }
    const when = input.sentAt ?? nowIso();
    tx.update(documents).set({ status: 'sent', sentAt: when, sentVia: input.sentVia, updatedAt: nowIso() }).where(eq(documents.id, id)).run();
    appendAudit(tx, { actor, action: 'document.send', entity: 'documents', entityId: id, before: { status: doc.status }, after: { status: 'sent', sentVia: input.sentVia, sentAt: when } });
    return requireDocument(tx, id);
  });
}

/** Record the rendered PDF path and its hash. */
export function setDocumentPdf(db: Db, id: Id, pdf: { pdfPath: string; sha256: string }): GeneratedDocument {
  requireDocument(db, id, { includeHtml: false });
  db.update(documents).set({ pdfPath: pdf.pdfPath, sha256: pdf.sha256, updatedAt: nowIso() }).where(eq(documents.id, id)).run();
  return requireDocument(db, id);
}

/**
 * Supersede: the old document becomes 'superseded' and a new draft is created with `supersedesId` and, for
 * re-executed agreements, the actual `reExecutedOn` date (lesson b). Audited.
 */
export function supersedeDocument(db: Db, oldId: Id, actor: Actor, draft: Omit<CreateDraftInput, 'supersedesId'>, options: { reExecutedOn?: ISODate } = {}): GeneratedDocument {
  return db.transaction((tx) => {
    const old = requireDocument(tx, oldId, { includeHtml: false });
    if (old.status === 'void') throw new DocumentStateError(oldId, old.status, 'a void document cannot be superseded');
    const at = nowIso();
    const created = createDraft(tx, { ...draft, supersedesId: oldId, reExecutedOn: options.reExecutedOn ?? draft.reExecutedOn });
    tx.update(documents).set({ status: 'superseded', updatedAt: at }).where(eq(documents.id, oldId)).run();
    appendAudit(tx, { actor, action: 'document.supersede', entity: 'documents', entityId: oldId, before: { status: old.status }, after: { status: 'superseded', supersededBy: created.id }, at });
    return created;
  });
}

/** Void a document that must never be sent (audited). */
export function voidDocument(db: Db, id: Id, actor: Actor, reason: string): GeneratedDocument {
  if (!reason?.trim()) throw new ValidationError('a reason is required to void a document');
  return db.transaction((tx) => {
    const doc = requireDocument(tx, id, { includeHtml: false });
    if (doc.status === 'sent' || doc.status === 'signed') throw new DocumentStateError(id, doc.status, 'a sent or signed document cannot be voided; supersede it');
    const at = nowIso();
    tx.update(documents).set({ status: 'void', updatedAt: at }).where(eq(documents.id, id)).run();
    appendAudit(tx, { actor, action: 'document.void', entity: 'documents', entityId: id, before: { status: doc.status }, after: { status: 'void', reason }, at });
    return requireDocument(tx, id);
  });
}

/**
 * Attach an e-signature record (OTP verified). The signature's document hash must equal the document's hash;
 * `signedAt` may not be before the document was created (BLUEPRINT §3.8). Also stored in `signatures`.
 */
export function attachSignature(db: Db, id: Id, signature: SignatureRecord, actor: Actor = { userId: 'system' }): GeneratedDocument {
  return db.transaction((tx) => {
    const doc = requireDocument(tx, id, { includeHtml: false });
    if (doc.status === 'void' || doc.status === 'superseded') throw new DocumentStateError(id, doc.status, `a ${doc.status} document cannot be signed`);
    if (doc.signature) throw new DocumentStateError(id, doc.status, 'document already carries a signature');
    if (signature.documentSha256.toLowerCase() !== doc.sha256.toLowerCase()) throw new ValidationError('signature.documentSha256 does not match the document hash');
    if (signature.signedAt < doc.createdAt) throw new ValidationError(`signedAt ${signature.signedAt} is before the document was created (${doc.createdAt})`);
    const at = nowIso();
    tx.insert(signatures)
      .values({
        id: signature.certificateId,
        documentId: id,
        signerPartyId: signature.signerPartyId,
        signerName: signature.signerName,
        signerContact: signature.signerContact,
        otpChannel: signature.otpChannel,
        otpVerifiedAt: signature.otpVerifiedAt,
        ipAddress: signature.ipAddress,
        userAgent: signature.userAgent,
        signedAt: signature.signedAt,
        documentSha256: signature.documentSha256,
        certificatePdfPath: signature.certificatePdfPath,
        createdAt: at,
      })
      .run();
    tx.update(documents).set({ signature, status: 'signed', updatedAt: at }).where(eq(documents.id, id)).run();
    appendAudit(tx, { actor, action: 'document.sign', entity: 'documents', entityId: id, before: { status: doc.status }, after: { status: 'signed', certificateId: signature.certificateId, signerPartyId: signature.signerPartyId }, at });
    return requireDocument(tx, id);
  });
}

export interface SignatureListItem extends SignatureRecord {
  documentId: Id;
}

/** All signatures on a claim's documents (duplicate-signature-date alert reads this). */
export function listSignaturesForClaim(db: Db, claimId: Id): SignatureListItem[] {
  const docIds = db.select({ id: documents.id }).from(documents).where(eq(documents.claimId, claimId)).all().map((r) => r.id);
  if (!docIds.length) return [];
  return db
    .select()
    .from(signatures)
    .where(inArray(signatures.documentId, docIds))
    .orderBy(signatures.signedAt)
    .all()
    .map((r) => {
      const { id, createdAt: _c, ...rest } = r;
      return { ...denull(rest), certificateId: id };
    });
}

/** Generic field patch for metadata (title, recipient, pdfPath, dataSnapshot on a draft). */
export function updateDraft(db: Db, id: Id, patch: Partial<Pick<GeneratedDocument, 'title' | 'recipientPartyId' | 'html' | 'sha256' | 'dataSnapshot' | 'pdfPath' | 'reExecutedOn'>>): GeneratedDocument {
  const doc = requireDocument(db, id, { includeHtml: false });
  if (doc.status !== 'draft' && doc.status !== 'blocked') throw new DocumentStateError(id, doc.status, 'only a draft can be edited');
  db.update(documents)
    .set({ ...compact(patch), updatedAt: nowIso() })
    .where(eq(documents.id, id))
    .run();
  return requireDocument(db, id);
}
