// owned by mail
/**
 * Mail persistence (docs/SUPREME-DESIGN.md §F, §N.2): the IONOS account (no password — `secret_ref` names the DPAPI
 * secret), per-folder sync state, ingested messages and attachments, claim matches and triage classifications.
 *
 * Append-only (database triggers): `mail_matches` (the latest row per message decides; a re-decision is a new row) and
 * `mail_classifications`. Messages change only in their routing fields (status, claim, folder) — their content and the
 * raw evidence they point at never change.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import {
  mailAccounts,
  mailAttachments,
  mailClassifications,
  mailFolderState,
  mailMatches,
  mailMessages,
  type MailAccountRow,
  type MailAttachmentRow,
  type MailClassificationRow,
  type MailFolderStateRow,
  type MailMatchRow,
  type MailMessageRow,
  type MailMessageStatus,
} from '../schema.js';
import { denull, nowIso } from '../util.js';

/** The fixed outgoing identity (owner's rule). */
export const MAIL_FROM_NAME = 'Claims Team, Courtesy Cars Group UK Ltd';

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface MailAccountRecord {
  id: string;
  label: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: 'tls' | 'starttls';
  username: string;
  secretRef: string;
  fromName: string;
  fromAddress: string;
  signatureText?: string;
  signatureHtml?: string;
  processedFolder: string;
  quarantineFolder: string;
  moveAfterIngest: boolean;
  enabled: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface UpsertMailAccountInput {
  id?: string;
  label?: string;
  imapHost: string;
  imapPort: number;
  imapTls?: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: 'tls' | 'starttls';
  username: string;
  secretRef?: string;
  fromAddress: string;
  signatureText?: string | null;
  signatureHtml?: string | null;
  processedFolder?: string;
  quarantineFolder?: string;
  moveAfterIngest?: boolean;
  enabled?: boolean;
  now?: ISODateTime;
}

const toAccount = (r: MailAccountRow): MailAccountRecord => denull(r) as MailAccountRecord;

export function getMailAccount(db: Db, id: string): MailAccountRecord | undefined {
  const r = db.select().from(mailAccounts).where(eq(mailAccounts.id, id)).get();
  return r ? toAccount(r) : undefined;
}

/** The account the agents use (one in practice): the oldest row. */
export function getDefaultMailAccount(db: Db): MailAccountRecord | undefined {
  const r = db.select().from(mailAccounts).orderBy(asc(mailAccounts.createdAt), asc(mailAccounts.id)).get();
  return r ? toAccount(r) : undefined;
}

export function listMailAccounts(db: Db): MailAccountRecord[] {
  return db.select().from(mailAccounts).orderBy(asc(mailAccounts.createdAt)).all().map(toAccount);
}

/** Create or update an account. The From name is fixed (owner's rule) and never taken from input. */
export function upsertMailAccount(db: Db, input: UpsertMailAccountInput): MailAccountRecord {
  const now = input.now ?? nowIso();
  if (!input.fromAddress.includes('@')) throw new ValidationError('fromAddress must be an email address');
  if (input.smtpSecurity !== 'tls' && input.smtpSecurity !== 'starttls') throw new ValidationError('smtpSecurity must be tls or starttls');
  const existing = input.id ? getMailAccount(db, input.id) : getDefaultMailAccount(db);
  const values = {
    label: input.label ?? existing?.label ?? 'IONOS mailbox',
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapTls: input.imapTls ?? existing?.imapTls ?? true,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecurity: input.smtpSecurity,
    username: input.username,
    secretRef: input.secretRef ?? existing?.secretRef ?? 'imap_password',
    fromName: MAIL_FROM_NAME,
    fromAddress: input.fromAddress,
    signatureText: input.signatureText === undefined ? (existing?.signatureText ?? null) : input.signatureText,
    signatureHtml: input.signatureHtml === undefined ? (existing?.signatureHtml ?? null) : input.signatureHtml,
    processedFolder: input.processedFolder ?? existing?.processedFolder ?? 'ClaimDesk-Processed',
    quarantineFolder: input.quarantineFolder ?? existing?.quarantineFolder ?? 'ClaimDesk-Quarantine',
    moveAfterIngest: input.moveAfterIngest ?? existing?.moveAfterIngest ?? true,
    enabled: input.enabled ?? existing?.enabled ?? false,
    updatedAt: now,
  };
  if (existing) {
    return toAccount(db.update(mailAccounts).set(values).where(eq(mailAccounts.id, existing.id)).returning().get());
  }
  return toAccount(db.insert(mailAccounts).values({ id: input.id ?? randomUUID(), createdAt: now, ...values }).returning().get());
}

// ---------------------------------------------------------------------------
// Folder state
// ---------------------------------------------------------------------------

export interface MailFolderStateRecord {
  accountId: string;
  folder: string;
  uidvalidity?: number;
  lastUid: number;
  highestModseq?: string;
  lastSyncAt?: ISODateTime;
  lastError?: string;
}

const toFolder = (r: MailFolderStateRow): MailFolderStateRecord => denull(r) as MailFolderStateRecord;

export function getMailFolderState(db: Db, accountId: string, folder: string): MailFolderStateRecord | undefined {
  const r = db.select().from(mailFolderState).where(and(eq(mailFolderState.accountId, accountId), eq(mailFolderState.folder, folder))).get();
  return r ? toFolder(r) : undefined;
}

export function listMailFolderStates(db: Db, accountId: string): MailFolderStateRecord[] {
  return db.select().from(mailFolderState).where(eq(mailFolderState.accountId, accountId)).all().map(toFolder);
}

export function saveMailFolderState(
  db: Db,
  input: { accountId: string; folder: string; uidvalidity?: number | null; lastUid?: number; highestModseq?: string | null; lastSyncAt?: ISODateTime | null; lastError?: string | null },
): MailFolderStateRecord {
  const existing = getMailFolderState(db, input.accountId, input.folder);
  const values = {
    uidvalidity: input.uidvalidity === undefined ? (existing?.uidvalidity ?? null) : input.uidvalidity,
    lastUid: input.lastUid ?? existing?.lastUid ?? 0,
    highestModseq: input.highestModseq === undefined ? (existing?.highestModseq ?? null) : input.highestModseq,
    lastSyncAt: input.lastSyncAt === undefined ? (existing?.lastSyncAt ?? null) : input.lastSyncAt,
    lastError: input.lastError === undefined ? (existing?.lastError ?? null) : input.lastError,
  };
  if (existing) {
    return toFolder(db.update(mailFolderState).set(values).where(and(eq(mailFolderState.accountId, input.accountId), eq(mailFolderState.folder, input.folder))).returning().get());
  }
  return toFolder(db.insert(mailFolderState).values({ accountId: input.accountId, folder: input.folder, ...values }).returning().get());
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface MailMessageRecord {
  id: string;
  accountId: string;
  folder?: string;
  uid?: number;
  uidvalidity?: number;
  messageId?: string;
  messageIdNorm?: string;
  inReplyTo?: string;
  referencesJson?: string[];
  threadKey: string;
  direction: 'in' | 'out';
  fromAddr?: string;
  fromName?: string;
  replyTo?: string;
  toJson: string[];
  ccJson: string[];
  subject?: string;
  sentAt?: ISODateTime;
  receivedAt: ISODateTime;
  rawEvidenceId: string;
  rawSha256: string;
  bodyText?: string;
  hasAttachments: boolean;
  authJson?: unknown;
  spoofSuspect: boolean;
  status: MailMessageStatus;
  claimId?: string;
  source: 'imap' | 'file' | 'smtp';
  createdAt: ISODateTime;
}

export interface InsertMailMessageInput {
  id?: string;
  accountId: string;
  folder?: string | null;
  uid?: number | null;
  uidvalidity?: number | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[] | null;
  threadKey: string;
  direction: 'in' | 'out';
  fromAddr?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
  to: string[];
  cc: string[];
  subject?: string | null;
  sentAt?: ISODateTime | null;
  receivedAt: ISODateTime;
  rawEvidenceId: string;
  rawSha256: string;
  bodyText?: string | null;
  hasAttachments?: boolean;
  auth?: unknown;
  spoofSuspect?: boolean;
  status?: MailMessageStatus;
  claimId?: string | null;
  source: 'imap' | 'file' | 'smtp';
  now?: ISODateTime;
}

/** `<ABC@example.com>` → `abc@example.com` (angle brackets and case removed) — the dedupe/thread key. */
export function normaliseMessageId(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  const t = id.trim().replace(/^<+/, '').replace(/>+$/, '').trim().toLowerCase();
  return t.length ? t : undefined;
}

const toMessage = (r: MailMessageRow): MailMessageRecord => denull(r) as MailMessageRecord;

export function insertMailMessage(db: Db, input: InsertMailMessageInput): MailMessageRecord {
  const row = {
    id: input.id ?? randomUUID(),
    accountId: input.accountId,
    folder: input.folder ?? null,
    uid: input.uid ?? null,
    uidvalidity: input.uidvalidity ?? null,
    messageId: input.messageId ?? null,
    messageIdNorm: normaliseMessageId(input.messageId) ?? null,
    inReplyTo: input.inReplyTo ?? null,
    referencesJson: input.references ?? null,
    threadKey: input.threadKey,
    direction: input.direction,
    fromAddr: input.fromAddr ?? null,
    fromName: input.fromName ?? null,
    replyTo: input.replyTo ?? null,
    toJson: input.to,
    ccJson: input.cc,
    subject: input.subject ?? null,
    sentAt: input.sentAt ?? null,
    receivedAt: input.receivedAt,
    rawEvidenceId: input.rawEvidenceId,
    rawSha256: input.rawSha256,
    bodyText: input.bodyText ?? null,
    hasAttachments: input.hasAttachments ?? false,
    authJson: input.auth ?? null,
    spoofSuspect: input.spoofSuspect ?? false,
    status: input.status ?? 'new',
    claimId: input.claimId ?? null,
    source: input.source,
    createdAt: input.now ?? nowIso(),
  };
  return toMessage(db.insert(mailMessages).values(row).returning().get());
}

export function getMailMessage(db: Db, id: string): MailMessageRecord | undefined {
  const r = db.select().from(mailMessages).where(eq(mailMessages.id, id)).get();
  return r ? toMessage(r) : undefined;
}

export function requireMailMessage(db: Db, id: string): MailMessageRecord {
  const m = getMailMessage(db, id);
  if (!m) throw new NotFoundError('mail_message', id);
  return m;
}

/** The stored message with these exact raw bytes (de-duplication on raw sha256). */
export function findMailMessageByRawSha(db: Db, accountId: string, rawSha256: string): MailMessageRecord | undefined {
  const r = db.select().from(mailMessages).where(and(eq(mailMessages.accountId, accountId), eq(mailMessages.rawSha256, rawSha256))).get();
  return r ? toMessage(r) : undefined;
}

/** Messages with this Message-ID (normalised). */
export function findMailMessagesByMessageId(db: Db, messageId: string): MailMessageRecord[] {
  const norm = normaliseMessageId(messageId);
  if (!norm) return [];
  return db.select().from(mailMessages).where(eq(mailMessages.messageIdNorm, norm)).orderBy(asc(mailMessages.receivedAt)).all().map(toMessage);
}

export interface ListMailMessagesFilter {
  accountId?: string;
  claimId?: string;
  status?: MailMessageStatus | MailMessageStatus[];
  direction?: 'in' | 'out';
  threadKey?: string;
  limit?: number;
  offset?: number;
}

export function listMailMessages(db: Db, f: ListMailMessagesFilter = {}): MailMessageRecord[] {
  const where: SQL[] = [];
  if (f.accountId) where.push(eq(mailMessages.accountId, f.accountId));
  if (f.claimId) where.push(eq(mailMessages.claimId, f.claimId));
  if (f.direction) where.push(eq(mailMessages.direction, f.direction));
  if (f.threadKey) where.push(eq(mailMessages.threadKey, f.threadKey));
  if (f.status) where.push(Array.isArray(f.status) ? inArray(mailMessages.status, f.status) : eq(mailMessages.status, f.status));
  return db
    .select()
    .from(mailMessages)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(mailMessages.receivedAt), desc(sql`rowid`))
    .limit(f.limit ?? 200)
    .offset(f.offset ?? 0)
    .all()
    .map(toMessage);
}

export function countMailMessages(db: Db, f: Omit<ListMailMessagesFilter, 'limit' | 'offset'> = {}): number {
  return listMailMessages(db, { ...f, limit: 1_000_000 }).length;
}

/** Messages of one thread, oldest first. */
export function listMailThread(db: Db, threadKey: string): MailMessageRecord[] {
  return db.select().from(mailMessages).where(eq(mailMessages.threadKey, threadKey)).orderBy(asc(mailMessages.receivedAt), asc(sql`rowid`)).all().map(toMessage);
}

/** Routing fields only (status, claim, folder/uid after a move). Content and raw evidence never change. */
export function updateMailMessageRouting(
  db: Db,
  id: string,
  patch: { status?: MailMessageStatus; claimId?: string | null; folder?: string | null; uid?: number | null },
): MailMessageRecord {
  requireMailMessage(db, id);
  const set: Partial<MailMessageRow> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.claimId !== undefined) set.claimId = patch.claimId;
  if (patch.folder !== undefined) set.folder = patch.folder;
  if (patch.uid !== undefined) set.uid = patch.uid;
  if (!Object.keys(set).length) return requireMailMessage(db, id);
  return toMessage(db.update(mailMessages).set(set).where(eq(mailMessages.id, id)).returning().get());
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export interface MailAttachmentRecord {
  id: string;
  mailMessageId: string;
  evidenceId: string;
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  contentId?: string;
  inline: boolean;
  intakeItemId?: string;
}

const toAttachment = (r: MailAttachmentRow): MailAttachmentRecord => denull(r) as MailAttachmentRecord;

export function insertMailAttachment(
  db: Db,
  input: { id?: string; mailMessageId: string; evidenceId: string; filename: string; mime: string; bytes: number; sha256: string; contentId?: string | null; inline?: boolean },
): MailAttachmentRecord {
  return toAttachment(
    db
      .insert(mailAttachments)
      .values({ id: input.id ?? randomUUID(), mailMessageId: input.mailMessageId, evidenceId: input.evidenceId, filename: input.filename, mime: input.mime, bytes: input.bytes, sha256: input.sha256, contentId: input.contentId ?? null, inline: input.inline ?? false, intakeItemId: null })
      .returning()
      .get(),
  );
}

export function getMailAttachment(db: Db, id: string): MailAttachmentRecord | undefined {
  const r = db.select().from(mailAttachments).where(eq(mailAttachments.id, id)).get();
  return r ? toAttachment(r) : undefined;
}

export function listMailAttachments(db: Db, mailMessageId: string): MailAttachmentRecord[] {
  return db.select().from(mailAttachments).where(eq(mailAttachments.mailMessageId, mailMessageId)).orderBy(asc(sql`rowid`)).all().map(toAttachment);
}

export function setMailAttachmentIntakeItem(db: Db, id: string, intakeItemId: string): MailAttachmentRecord {
  const r = db.update(mailAttachments).set({ intakeItemId }).where(eq(mailAttachments.id, id)).returning().get();
  if (!r) throw new NotFoundError('mail_attachment', id);
  return toAttachment(r);
}

// ---------------------------------------------------------------------------
// Matches (append-only)
// ---------------------------------------------------------------------------

export interface MailMatchSignal {
  code: string;
  score: number;
  detail: string;
}

export interface MailMatchRecord {
  id: string;
  mailMessageId: string;
  claimId?: string;
  score: number;
  /** `{ signals: MailMatchSignal[], candidates?: …, reason?: string }` */
  signals: unknown;
  decidedBy: 'auto' | 'agent' | 'owner';
  decidedAt: ISODateTime;
  supersededBy?: string;
}

const toMatch = (r: MailMatchRow): MailMatchRecord => ({ ...(denull(r) as MailMatchRecord), signals: r.signals ?? null });

export function appendMailMatch(db: Db, input: { mailMessageId: string; claimId?: string | null; score: number; signals: unknown; decidedBy: 'auto' | 'agent' | 'owner'; now?: ISODateTime }): MailMatchRecord {
  return toMatch(
    db
      .insert(mailMatches)
      .values({ id: randomUUID(), mailMessageId: input.mailMessageId, claimId: input.claimId ?? null, score: Math.round(input.score), signals: input.signals ?? {}, decidedBy: input.decidedBy, decidedAt: input.now ?? nowIso(), supersededBy: null })
      .returning()
      .get(),
  );
}

export function listMailMatches(db: Db, mailMessageId: string): MailMatchRecord[] {
  return db.select().from(mailMatches).where(eq(mailMatches.mailMessageId, mailMessageId)).orderBy(asc(mailMatches.decidedAt), asc(sql`rowid`)).all().map(toMatch);
}

/** The decision in force: the newest row. */
export function latestMailMatch(db: Db, mailMessageId: string): MailMatchRecord | undefined {
  const r = db.select().from(mailMatches).where(eq(mailMatches.mailMessageId, mailMessageId)).orderBy(desc(mailMatches.decidedAt), desc(sql`rowid`)).get();
  return r ? toMatch(r) : undefined;
}

// ---------------------------------------------------------------------------
// Classifications (append-only)
// ---------------------------------------------------------------------------

export interface MailClassificationRecord {
  id: string;
  mailMessageId: string;
  runId?: string;
  driver?: string;
  model?: string;
  promptVersion?: string;
  intent: string;
  secondary: string[];
  confidence: number;
  extracted: unknown;
  summary: string;
  injection: unknown;
  deterministic: unknown;
  createdAt: ISODateTime;
}

const toClassification = (r: MailClassificationRow): MailClassificationRecord => ({ ...(denull(r) as MailClassificationRecord), extracted: r.extracted ?? null, injection: r.injection ?? null, deterministic: r.deterministic ?? null });

export function appendMailClassification(
  db: Db,
  input: {
    mailMessageId: string;
    runId?: string | null;
    driver?: string | null;
    model?: string | null;
    promptVersion?: string | null;
    intent: string;
    secondary: string[];
    confidence: number;
    extracted: unknown;
    summary: string;
    injection: unknown;
    deterministic: unknown;
    now?: ISODateTime;
  },
): MailClassificationRecord {
  if (!(input.confidence >= 0 && input.confidence <= 1)) throw new ValidationError('confidence must be between 0 and 1');
  return toClassification(
    db
      .insert(mailClassifications)
      .values({
        id: randomUUID(),
        mailMessageId: input.mailMessageId,
        runId: input.runId ?? null,
        driver: input.driver ?? null,
        model: input.model ?? null,
        promptVersion: input.promptVersion ?? null,
        intent: input.intent,
        secondary: input.secondary,
        confidence: input.confidence,
        extracted: input.extracted ?? {},
        summary: input.summary,
        injection: input.injection ?? {},
        deterministic: input.deterministic ?? {},
        createdAt: input.now ?? nowIso(),
      })
      .returning()
      .get(),
  );
}

export function latestMailClassification(db: Db, mailMessageId: string): MailClassificationRecord | undefined {
  const r = db.select().from(mailClassifications).where(eq(mailClassifications.mailMessageId, mailMessageId)).orderBy(desc(mailClassifications.createdAt), desc(sql`rowid`)).get();
  return r ? toClassification(r) : undefined;
}

export function listMailClassifications(db: Db, mailMessageId: string): MailClassificationRecord[] {
  return db.select().from(mailClassifications).where(eq(mailClassifications.mailMessageId, mailMessageId)).orderBy(asc(mailClassifications.createdAt), asc(sql`rowid`)).all().map(toClassification);
}
