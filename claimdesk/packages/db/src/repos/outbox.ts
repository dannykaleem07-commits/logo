// owned by mail
/**
 * The outbox (docs/SUPREME-DESIGN.md §D.3, §F.6, §N.2). A row's status changes ONLY through `transitionOutbox`, which
 * validates the state machine, applies the fields that travel with the transition (hold time, policy, approval, SMTP
 * id, attempts, owner edits) and appends an `outbox_events` row (append-only) with the actor and the reason — all in
 * one statement guarded by the expected current status, so an Undo and a release can never both win.
 *
 *   draft → reviewing → awaiting_approval | held → queued → sending → sent | failed | cancelled
 *
 * plus the edges the workflow needs: a repair loop (reviewing → draft), owner compose (draft → held / queued), a
 * release that has to ask after all (held/queued → awaiting_approval), a retry (sending → queued, failed → queued) and
 * Undo / reject (→ cancelled). `sent` and `cancelled` are final.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { DbError, NotFoundError, ValidationError } from '../errors.js';
import { outbox, outboxEvents, type OutboxEventRow, type OutboxRow, type OutboxStatus } from '../schema.js';
import { denull, nowIso } from '../util.js';

export const OUTBOX_STATUSES: readonly OutboxStatus[] = ['draft', 'reviewing', 'awaiting_approval', 'held', 'queued', 'sending', 'sent', 'failed', 'cancelled'];

/** Allowed transitions (§D.3). */
export const OUTBOX_TRANSITIONS: Readonly<Record<OutboxStatus, readonly OutboxStatus[]>> = {
  draft: ['reviewing', 'held', 'queued', 'cancelled'],
  reviewing: ['draft', 'awaiting_approval', 'held', 'cancelled', 'failed'],
  awaiting_approval: ['queued', 'held', 'draft', 'cancelled'],
  held: ['queued', 'awaiting_approval', 'draft', 'cancelled'],
  queued: ['sending', 'held', 'awaiting_approval', 'cancelled'],
  sending: ['sent', 'failed', 'queued'],
  failed: ['queued', 'cancelled'],
  sent: [],
  cancelled: [],
};

export const canTransitionOutbox = (from: OutboxStatus, to: OutboxStatus): boolean => OUTBOX_TRANSITIONS[from].includes(to);

/** A transition the state machine refuses, or a concurrent change of the row (409 in the API). */
export class OutboxStateError extends DbError {
  readonly outboxId: string;
  readonly status: string;
  constructor(outboxId: string, status: string, message: string) {
    super('OUTBOX_STATE', message);
    this.outboxId = outboxId;
    this.status = status;
  }
}

export interface OutboxAttachmentRef {
  /** Evidence on the claim, or a ClaimDesk document (its approved PDF is attached). */
  evidenceId?: string;
  documentId?: string;
  filename?: string;
  mime?: string;
  /** Evidence kind / document template — for the disclosure check (§F.7). */
  role?: string;
}

export interface OutboxRecord {
  id: string;
  claimId?: string;
  accountId: string;
  kind: string;
  toJson: string[];
  ccJson: string[];
  bccJson: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  attachmentsJson: OutboxAttachmentRef[];
  inReplyTo?: string;
  referencesJson?: string[];
  threadKey?: string;
  /** The stored policy Decision (JSON) — `{outcome, ruleIds, reasons, holdMinutes?, …}`. */
  policy?: unknown;
  reviewId?: string;
  confidence?: number;
  status: OutboxStatus;
  holdUntil?: ISODateTime;
  approvedBy?: string;
  approvedAt?: ISODateTime;
  smtpMessageId?: string;
  rawSentEvidenceId?: string;
  attempts: number;
  lastError?: string;
  createdBy: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface OutboxEventRecord {
  id: string;
  outboxId: string;
  fromStatus?: OutboxStatus;
  toStatus: OutboxStatus;
  actor: string;
  reason?: string;
  at: ISODateTime;
}

const toOutbox = (r: OutboxRow): OutboxRecord => ({ ...(denull(r) as OutboxRecord), attachmentsJson: (r.attachmentsJson ?? []) as OutboxAttachmentRef[], policy: r.policy ?? undefined });
const toEvent = (r: OutboxEventRow): OutboxEventRecord => denull(r) as OutboxEventRecord;

export interface CreateOutboxInput {
  id?: string;
  claimId?: string | null;
  accountId: string;
  kind: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  attachments?: OutboxAttachmentRef[];
  inReplyTo?: string | null;
  references?: string[] | null;
  threadKey?: string | null;
  confidence?: number | null;
  createdBy: string;
  reason?: string;
  now?: ISODateTime;
}

/** A new outbox row in `draft`, with its first outbox_events row (null → draft). */
export function createOutbox(db: Db, input: CreateOutboxInput): OutboxRecord {
  if (!input.to.length) throw new ValidationError('An email needs at least one recipient');
  if (!input.subject.trim()) throw new ValidationError('An email needs a subject');
  const now = input.now ?? nowIso();
  const id = input.id ?? randomUUID();
  const row = db
    .insert(outbox)
    .values({
      id,
      claimId: input.claimId ?? null,
      accountId: input.accountId,
      kind: input.kind,
      toJson: input.to,
      ccJson: input.cc ?? [],
      bccJson: input.bcc ?? [],
      subject: input.subject,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml ?? null,
      attachmentsJson: input.attachments ?? [],
      inReplyTo: input.inReplyTo ?? null,
      referencesJson: input.references ?? null,
      threadKey: input.threadKey ?? null,
      policy: null,
      reviewId: null,
      confidence: input.confidence ?? null,
      status: 'draft',
      attempts: 0,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  db.insert(outboxEvents).values({ id: randomUUID(), outboxId: id, fromStatus: null, toStatus: 'draft', actor: input.createdBy, reason: input.reason ?? 'created', at: now }).run();
  return toOutbox(row);
}

export function getOutbox(db: Db, id: string): OutboxRecord | undefined {
  const r = db.select().from(outbox).where(eq(outbox.id, id)).get();
  return r ? toOutbox(r) : undefined;
}

export function requireOutbox(db: Db, id: string): OutboxRecord {
  const r = getOutbox(db, id);
  if (!r) throw new NotFoundError('outbox', id);
  return r;
}

export interface ListOutboxFilter {
  claimId?: string;
  status?: OutboxStatus | OutboxStatus[];
  limit?: number;
  offset?: number;
}

export function listOutbox(db: Db, f: ListOutboxFilter = {}): OutboxRecord[] {
  const where: SQL[] = [];
  if (f.claimId) where.push(eq(outbox.claimId, f.claimId));
  if (f.status) where.push(Array.isArray(f.status) ? inArray(outbox.status, f.status) : eq(outbox.status, f.status));
  return db
    .select()
    .from(outbox)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(outbox.updatedAt), desc(sql`rowid`))
    .limit(f.limit ?? 200)
    .offset(f.offset ?? 0)
    .all()
    .map(toOutbox);
}

/** Held items whose hold has ended (release candidates). */
export function listDueHeldOutbox(db: Db, now: ISODateTime): OutboxRecord[] {
  return db.select().from(outbox).where(and(eq(outbox.status, 'held'), lte(outbox.holdUntil, now))).orderBy(asc(outbox.holdUntil)).all().map(toOutbox);
}

export function listOutboxEvents(db: Db, outboxId: string): OutboxEventRecord[] {
  return db.select().from(outboxEvents).where(eq(outboxEvents.outboxId, outboxId)).orderBy(asc(outboxEvents.at), asc(sql`rowid`)).all().map(toEvent);
}

/** Fields that may travel with a transition. Content fields (owner edits, repair) only while not yet sending. */
export interface OutboxTransitionPatch {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText?: string;
  bodyHtml?: string | null;
  attachments?: OutboxAttachmentRef[];
  kind?: string;
  policy?: unknown;
  reviewId?: string | null;
  confidence?: number | null;
  holdUntil?: ISODateTime | null;
  approvedBy?: string | null;
  approvedAt?: ISODateTime | null;
  smtpMessageId?: string | null;
  rawSentEvidenceId?: string | null;
  attempts?: number;
  lastError?: string | null;
}

const CONTENT_KEYS: ReadonlyArray<keyof OutboxTransitionPatch> = ['to', 'cc', 'bcc', 'subject', 'bodyText', 'bodyHtml', 'attachments', 'kind'];
const EDITABLE_FROM: ReadonlySet<OutboxStatus> = new Set(['draft', 'reviewing', 'awaiting_approval', 'held', 'queued', 'failed']);

export interface TransitionOutboxOptions {
  /** Refuse unless the row is currently in one of these (guards races: Undo vs release). Default: any status that may move to `to`. */
  from?: OutboxStatus | OutboxStatus[];
  patch?: OutboxTransitionPatch;
  now?: ISODateTime;
}

/**
 * Move an outbox row to `to` (validated against OUTBOX_TRANSITIONS), applying `patch`, and append the outbox_events
 * row. Throws OutboxStateError when the transition is not allowed or the row changed underneath (compare-and-set on
 * the current status).
 */
export function transitionOutbox(db: Db, id: string, to: OutboxStatus, actor: string, reason: string, opts: TransitionOutboxOptions = {}): OutboxRecord {
  if (!OUTBOX_STATUSES.includes(to)) throw new ValidationError(`Unknown outbox status ${String(to)}`);
  if (!actor) throw new ValidationError('An outbox transition needs an actor');
  const now = opts.now ?? nowIso();
  return db.transaction((tx) => {
    const current = requireOutbox(tx, id);
    const from = current.status;
    const allowedFrom = opts.from === undefined ? undefined : Array.isArray(opts.from) ? opts.from : [opts.from];
    if (allowedFrom && !allowedFrom.includes(from)) throw new OutboxStateError(id, from, `This email is ${from.replace('_', ' ')}, not ${allowedFrom.join(' or ').replace(/_/g, ' ')}`);
    if (!canTransitionOutbox(from, to)) throw new OutboxStateError(id, from, `An email cannot go from ${from} to ${to}`);
    const p = opts.patch ?? {};
    if (CONTENT_KEYS.some((k) => p[k] !== undefined) && !EDITABLE_FROM.has(from)) throw new OutboxStateError(id, from, `An email that is ${from} can no longer be edited`);
    if (p.to !== undefined && !p.to.length) throw new ValidationError('An email needs at least one recipient');
    if (p.subject !== undefined && !p.subject.trim()) throw new ValidationError('An email needs a subject');
    const set: Partial<OutboxRow> = { status: to, updatedAt: now };
    if (p.to !== undefined) set.toJson = p.to;
    if (p.cc !== undefined) set.ccJson = p.cc;
    if (p.bcc !== undefined) set.bccJson = p.bcc;
    if (p.subject !== undefined) set.subject = p.subject;
    if (p.bodyText !== undefined) set.bodyText = p.bodyText;
    if (p.bodyHtml !== undefined) set.bodyHtml = p.bodyHtml;
    if (p.attachments !== undefined) set.attachmentsJson = p.attachments;
    if (p.kind !== undefined) set.kind = p.kind;
    if (p.policy !== undefined) set.policy = p.policy;
    if (p.reviewId !== undefined) set.reviewId = p.reviewId;
    if (p.confidence !== undefined) set.confidence = p.confidence;
    if (p.holdUntil !== undefined) set.holdUntil = p.holdUntil;
    if (p.approvedBy !== undefined) set.approvedBy = p.approvedBy;
    if (p.approvedAt !== undefined) set.approvedAt = p.approvedAt;
    if (p.smtpMessageId !== undefined) set.smtpMessageId = p.smtpMessageId;
    if (p.rawSentEvidenceId !== undefined) set.rawSentEvidenceId = p.rawSentEvidenceId;
    if (p.attempts !== undefined) set.attempts = p.attempts;
    if (p.lastError !== undefined) set.lastError = p.lastError;
    const updated = tx.update(outbox).set(set).where(and(eq(outbox.id, id), eq(outbox.status, from))).returning().get();
    if (!updated) throw new OutboxStateError(id, from, 'This email changed while the request was running; reload and try again');
    tx.insert(outboxEvents).values({ id: randomUUID(), outboxId: id, fromStatus: from, toStatus: to, actor, reason: reason.slice(0, 2000), at: now }).run();
    return toOutbox(updated);
  });
}

/** Earlier outbound emails to `address` on `claimId` that actually left (status sent). */
export function countSentOutboxTo(db: Db, claimId: string, address: string, excludeId?: string): number {
  const addr = address.trim().toLowerCase();
  return listOutbox(db, { claimId, status: 'sent', limit: 100_000 }).filter((o) => o.id !== excludeId && [...o.toJson, ...o.ccJson].some((a) => a.trim().toLowerCase() === addr)).length;
}

/** The outbox row that went out with this SMTP Message-ID (threading, §F.4). */
export function findOutboxBySmtpMessageId(db: Db, messageId: string): OutboxRecord | undefined {
  const norm = messageId.trim().replace(/^<+/, '').replace(/>+$/, '').toLowerCase();
  if (!norm) return undefined;
  const r = db
    .select()
    .from(outbox)
    .where(sql`lower(trim(${outbox.smtpMessageId}, '<> ')) = ${norm}`)
    .get();
  return r ? toOutbox(r) : undefined;
}
