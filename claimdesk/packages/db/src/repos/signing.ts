// owned by ap-paperwork
/**
 * Repository for document_packs, signature_requests (+ the append-only signature_request_events) and kiosk_sessions
 * (docs/SUPREME-AUTOPILOT.md §D.6, §E). The tables exist from migration 0013_autopilot; row types are in ../schema.ts.
 *
 * Every signature-request status change goes through `transitionSignatureRequest`, which writes the history row in the
 * same transaction. A kiosk session stores only the sha256 of its token.
 */
import { and, asc, desc, eq, inArray, isNotNull, lte, sql, type SQL } from 'drizzle-orm';
import type {
  DocumentPack,
  DocumentPackStatus,
  Id,
  ISODateTime,
  KioskSession,
  PackStage,
  SignatureRecord,
  SignatureRequest,
  SignatureRequestEvent,
  SignatureRequestMethod,
  SignatureRequestStatus,
} from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError } from '../errors.js';
import { documentPacks, kioskSessions, signatureRequestEvents, signatureRequests, signatures, type DocumentPackRow, type SignatureRequestRow } from '../schema.js';
import { newId, nowIso } from '../util.js';

// ---------------------------------------------------------------------------
// Document packs
// ---------------------------------------------------------------------------

function toDocumentPack(row: DocumentPackRow): DocumentPack {
  return {
    id: row.id,
    claimId: row.claimId,
    stage: row.stage,
    ...(row.reservationId ? { reservationId: row.reservationId } : {}),
    items: row.items ?? [],
    status: row.status,
    ...(row.approvedBy ? { approvedBy: row.approvedBy } : {}),
    ...(row.approvedAt ? { approvedAt: row.approvedAt } : {}),
    ...(row.sentAt ? { sentAt: row.sentAt } : {}),
    ...(row.outboxId ? { outboxId: row.outboxId } : {}),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface NewDocumentPack {
  id?: Id;
  claimId: Id;
  stage: PackStage;
  reservationId?: Id;
  items: DocumentPack['items'];
  status?: DocumentPackStatus;
  createdBy: string;
  at?: ISODateTime;
}

export function createDocumentPack(db: Db, input: NewDocumentPack): DocumentPack {
  const at = input.at ?? nowIso();
  const id = input.id ?? newId();
  db.insert(documentPacks)
    .values({ id, claimId: input.claimId, stage: input.stage, reservationId: input.reservationId ?? null, items: input.items, status: input.status ?? 'preparing', createdBy: input.createdBy, createdAt: at, updatedAt: at })
    .run();
  return requireDocumentPack(db, id);
}

export function getDocumentPack(db: Db, id: Id): DocumentPack | undefined {
  const row = db.select().from(documentPacks).where(eq(documentPacks.id, id)).get();
  return row ? toDocumentPack(row) : undefined;
}

export function requireDocumentPack(db: Db, id: Id): DocumentPack {
  const pack = getDocumentPack(db, id);
  if (!pack) throw new NotFoundError('document_pack', id);
  return pack;
}

export interface DocumentPackFilter {
  claimId?: Id;
  stage?: PackStage;
  status?: DocumentPackStatus | DocumentPackStatus[];
  reservationId?: Id;
}

export function listDocumentPacks(db: Db, filter: DocumentPackFilter = {}): DocumentPack[] {
  const where: SQL[] = [];
  if (filter.claimId) where.push(eq(documentPacks.claimId, filter.claimId));
  if (filter.stage) where.push(eq(documentPacks.stage, filter.stage));
  if (filter.reservationId) where.push(eq(documentPacks.reservationId, filter.reservationId));
  if (filter.status) where.push(Array.isArray(filter.status) ? inArray(documentPacks.status, filter.status) : eq(documentPacks.status, filter.status));
  return db
    .select()
    .from(documentPacks)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(documentPacks.createdAt), desc(documentPacks.id))
    .all()
    .map(toDocumentPack);
}

export type DocumentPackPatch = Partial<Pick<DocumentPack, 'items' | 'status' | 'approvedBy' | 'approvedAt' | 'sentAt' | 'outboxId' | 'reservationId'>>;

export function updateDocumentPack(db: Db, id: Id, patch: DocumentPackPatch, at: ISODateTime = nowIso()): DocumentPack {
  requireDocumentPack(db, id);
  const set: Partial<typeof documentPacks.$inferInsert> = { updatedAt: at };
  if (patch.items !== undefined) set.items = patch.items;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.approvedBy !== undefined) set.approvedBy = patch.approvedBy;
  if (patch.approvedAt !== undefined) set.approvedAt = patch.approvedAt;
  if (patch.sentAt !== undefined) set.sentAt = patch.sentAt;
  if (patch.outboxId !== undefined) set.outboxId = patch.outboxId;
  if (patch.reservationId !== undefined) set.reservationId = patch.reservationId;
  db.update(documentPacks).set(set).where(eq(documentPacks.id, id)).run();
  return requireDocumentPack(db, id);
}

/** Packs of a claim that list `documentId` among their items (newest first). */
export function listDocumentPacksWithDocument(db: Db, claimId: Id, documentId: Id): DocumentPack[] {
  return listDocumentPacks(db, { claimId }).filter((p) => p.items.some((i) => i.documentId === documentId));
}

// ---------------------------------------------------------------------------
// Signature requests (+ append-only history)
// ---------------------------------------------------------------------------

function toSignatureRequest(row: SignatureRequestRow): SignatureRequest {
  return {
    id: row.id,
    ...(row.packId ? { packId: row.packId } : {}),
    documentId: row.documentId,
    claimId: row.claimId,
    signerPartyId: row.signerPartyId,
    method: row.method,
    status: row.status,
    ...(row.sentAt ? { sentAt: row.sentAt } : {}),
    chaseCount: row.chaseCount,
    ...(row.lastChasedAt ? { lastChasedAt: row.lastChasedAt } : {}),
    ...(row.nextChaseAt ? { nextChaseAt: row.nextChaseAt } : {}),
    ...(row.returnedEvidenceId ? { returnedEvidenceId: row.returnedEvidenceId } : {}),
    ...(row.signedAt ? { signedAt: row.signedAt } : {}),
    ...(row.confirmedBy ? { confirmedBy: row.confirmedBy } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface NewSignatureRequest {
  id?: Id;
  packId?: Id;
  documentId: Id;
  claimId: Id;
  signerPartyId: Id;
  method: SignatureRequestMethod;
  status?: SignatureRequestStatus;
  sentAt?: ISODateTime;
  nextChaseAt?: ISODateTime;
  actor: string;
  note?: string;
  at?: ISODateTime;
}

export function createSignatureRequest(db: Db, input: NewSignatureRequest): SignatureRequest {
  const at = input.at ?? nowIso();
  const id = input.id ?? newId();
  const status = input.status ?? 'prepared';
  db.transaction((tx) => {
    tx.insert(signatureRequests)
      .values({
        id,
        packId: input.packId ?? null,
        documentId: input.documentId,
        claimId: input.claimId,
        signerPartyId: input.signerPartyId,
        method: input.method,
        status,
        sentAt: input.sentAt ?? null,
        chaseCount: 0,
        nextChaseAt: input.nextChaseAt ?? null,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    tx.insert(signatureRequestEvents).values({ id: newId(), signatureRequestId: id, fromStatus: null, toStatus: status, actor: input.actor, note: input.note ?? null, at }).run();
  });
  return requireSignatureRequest(db, id);
}

export function getSignatureRequest(db: Db, id: Id): SignatureRequest | undefined {
  const row = db.select().from(signatureRequests).where(eq(signatureRequests.id, id)).get();
  return row ? toSignatureRequest(row) : undefined;
}

export function requireSignatureRequest(db: Db, id: Id): SignatureRequest {
  const r = getSignatureRequest(db, id);
  if (!r) throw new NotFoundError('signature_request', id);
  return r;
}

export interface SignatureRequestFilter {
  claimId?: Id;
  packId?: Id;
  documentId?: Id;
  status?: SignatureRequestStatus | SignatureRequestStatus[];
}

export function listSignatureRequests(db: Db, filter: SignatureRequestFilter = {}): SignatureRequest[] {
  const where: SQL[] = [];
  if (filter.claimId) where.push(eq(signatureRequests.claimId, filter.claimId));
  if (filter.packId) where.push(eq(signatureRequests.packId, filter.packId));
  if (filter.documentId) where.push(eq(signatureRequests.documentId, filter.documentId));
  if (filter.status) where.push(Array.isArray(filter.status) ? inArray(signatureRequests.status, filter.status) : eq(signatureRequests.status, filter.status));
  return db
    .select()
    .from(signatureRequests)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(signatureRequests.createdAt), asc(signatureRequests.id))
    .all()
    .map(toSignatureRequest);
}

/** Open requests (sent / chased) whose next chase or call is due at `now`. */
export function listDueSignatureRequests(db: Db, now: ISODateTime): SignatureRequest[] {
  return db
    .select()
    .from(signatureRequests)
    .where(and(inArray(signatureRequests.status, ['sent', 'chased']), isNotNull(signatureRequests.nextChaseAt), lte(signatureRequests.nextChaseAt, now)))
    .orderBy(asc(signatureRequests.nextChaseAt))
    .all()
    .map(toSignatureRequest);
}

export type SignatureRequestPatch = Partial<
  Pick<SignatureRequest, 'sentAt' | 'chaseCount' | 'lastChasedAt' | 'signedAt' | 'confirmedBy' | 'method'> & { nextChaseAt: ISODateTime | null; returnedEvidenceId: Id | null }
>;

/**
 * Move a request to `toStatus` (or keep it, with `toStatus` equal to the current one) and record the history row.
 * Returns the updated request.
 */
export function transitionSignatureRequest(db: Db, id: Id, toStatus: SignatureRequestStatus, patch: SignatureRequestPatch, actor: string, note?: string, at: ISODateTime = nowIso()): SignatureRequest {
  return db.transaction((tx) => {
    const before = requireSignatureRequest(tx, id);
    const set: Partial<typeof signatureRequests.$inferInsert> = { status: toStatus, updatedAt: at };
    if (patch.sentAt !== undefined) set.sentAt = patch.sentAt;
    if (patch.chaseCount !== undefined) set.chaseCount = patch.chaseCount;
    if (patch.lastChasedAt !== undefined) set.lastChasedAt = patch.lastChasedAt;
    if (patch.nextChaseAt !== undefined) set.nextChaseAt = patch.nextChaseAt;
    if (patch.returnedEvidenceId !== undefined) set.returnedEvidenceId = patch.returnedEvidenceId;
    if (patch.signedAt !== undefined) set.signedAt = patch.signedAt;
    if (patch.confirmedBy !== undefined) set.confirmedBy = patch.confirmedBy;
    if (patch.method !== undefined) set.method = patch.method;
    tx.update(signatureRequests).set(set).where(eq(signatureRequests.id, id)).run();
    tx.insert(signatureRequestEvents).values({ id: newId(), signatureRequestId: id, fromStatus: before.status, toStatus, actor, note: note ?? null, at }).run();
    return requireSignatureRequest(tx, id);
  });
}

export function listSignatureRequestEvents(db: Db, signatureRequestId: Id): SignatureRequestEvent[] {
  return db
    .select()
    .from(signatureRequestEvents)
    .where(eq(signatureRequestEvents.signatureRequestId, signatureRequestId))
    .orderBy(asc(signatureRequestEvents.at), sql`rowid`)
    .all()
    .map((r) => ({
      id: r.id,
      signatureRequestId: r.signatureRequestId,
      ...(r.fromStatus ? { fromStatus: r.fromStatus } : {}),
      toStatus: r.toStatus,
      actor: r.actor,
      ...(r.note ? { note: r.note } : {}),
      at: r.at,
    }));
}

// ---------------------------------------------------------------------------
// Kiosk sessions (token sha256 only)
// ---------------------------------------------------------------------------

function toKioskSession(row: typeof kioskSessions.$inferSelect): KioskSession {
  return {
    id: row.id,
    packId: row.packId,
    claimId: row.claimId,
    signerPartyId: row.signerPartyId,
    tokenSha256: row.tokenSha256,
    lan: Boolean(row.lan),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.openedAt ? { openedAt: row.openedAt } : {}),
    ...(row.openedIp ? { openedIp: row.openedIp } : {}),
    ...(row.openedUserAgent ? { openedUserAgent: row.openedUserAgent } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.closedReason ? { closedReason: row.closedReason } : {}),
  };
}

export function createKioskSession(db: Db, input: Omit<KioskSession, 'id' | 'openedAt' | 'openedIp' | 'openedUserAgent' | 'completedAt' | 'closedReason'> & { id?: Id }): KioskSession {
  const id = input.id ?? newId();
  db.insert(kioskSessions)
    .values({ id, packId: input.packId, claimId: input.claimId, signerPartyId: input.signerPartyId, tokenSha256: input.tokenSha256, lan: input.lan, createdBy: input.createdBy, createdAt: input.createdAt, expiresAt: input.expiresAt })
    .run();
  return getKioskSession(db, id)!;
}

export function getKioskSession(db: Db, id: Id): KioskSession | undefined {
  const row = db.select().from(kioskSessions).where(eq(kioskSessions.id, id)).get();
  return row ? toKioskSession(row) : undefined;
}

export function getKioskSessionByTokenSha256(db: Db, tokenSha256: string): KioskSession | undefined {
  const row = db.select().from(kioskSessions).where(eq(kioskSessions.tokenSha256, tokenSha256)).get();
  return row ? toKioskSession(row) : undefined;
}

export function listKioskSessions(db: Db, filter: { packId?: Id; claimId?: Id } = {}): KioskSession[] {
  const where: SQL[] = [];
  if (filter.packId) where.push(eq(kioskSessions.packId, filter.packId));
  if (filter.claimId) where.push(eq(kioskSessions.claimId, filter.claimId));
  return db.select().from(kioskSessions).where(where.length ? and(...where) : undefined).orderBy(desc(kioskSessions.createdAt)).all().map(toKioskSession);
}

export function updateKioskSession(db: Db, id: Id, patch: Partial<Pick<KioskSession, 'openedAt' | 'openedIp' | 'openedUserAgent' | 'completedAt' | 'closedReason' | 'expiresAt'>>): KioskSession {
  const set: Partial<typeof kioskSessions.$inferInsert> = {};
  if (patch.openedAt !== undefined) set.openedAt = patch.openedAt;
  if (patch.openedIp !== undefined) set.openedIp = patch.openedIp;
  if (patch.openedUserAgent !== undefined) set.openedUserAgent = patch.openedUserAgent;
  if (patch.completedAt !== undefined) set.completedAt = patch.completedAt;
  if (patch.closedReason !== undefined) set.closedReason = patch.closedReason;
  if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
  if (Object.keys(set).length) db.update(kioskSessions).set(set).where(eq(kioskSessions.id, id)).run();
  const s = getKioskSession(db, id);
  if (!s) throw new NotFoundError('kiosk_session', id);
  return s;
}

// ---------------------------------------------------------------------------
// Signature rows: the 0013 columns (method, drawn signature, evidence, pack) that attachSignature does not write
// ---------------------------------------------------------------------------

export function setSignatureProvenance(db: Db, certificateId: Id, extra: Pick<SignatureRecord, 'method' | 'drawnSignatureSha256' | 'evidenceId' | 'packId' | 'packSha256'>): void {
  const set: Partial<typeof signatures.$inferInsert> = {};
  if (extra.method !== undefined) set.method = extra.method;
  if (extra.drawnSignatureSha256 !== undefined) set.drawnSignatureSha256 = extra.drawnSignatureSha256;
  if (extra.evidenceId !== undefined) set.evidenceId = extra.evidenceId;
  if (extra.packId !== undefined) set.packId = extra.packId;
  if (extra.packSha256 !== undefined) set.packSha256 = extra.packSha256;
  if (Object.keys(set).length) db.update(signatures).set(set).where(eq(signatures.id, certificateId)).run();
}

export function getSignatureProvenance(db: Db, certificateId: Id): Pick<SignatureRecord, 'method' | 'drawnSignatureSha256' | 'evidenceId' | 'packId' | 'packSha256'> | undefined {
  const row = db.select({ method: signatures.method, drawnSignatureSha256: signatures.drawnSignatureSha256, evidenceId: signatures.evidenceId, packId: signatures.packId, packSha256: signatures.packSha256 }).from(signatures).where(eq(signatures.id, certificateId)).get();
  if (!row) return undefined;
  return {
    ...(row.method ? { method: row.method } : {}),
    ...(row.drawnSignatureSha256 ? { drawnSignatureSha256: row.drawnSignatureSha256 } : {}),
    ...(row.evidenceId ? { evidenceId: row.evidenceId } : {}),
    ...(row.packId ? { packId: row.packId } : {}),
    ...(row.packSha256 ? { packSha256: row.packSha256 } : {}),
  };
}
