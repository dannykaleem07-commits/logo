import { and, eq, lte, ne } from 'drizzle-orm';
import type { Id, ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { ValidationError } from '../errors.js';
import { sessions, type SessionRow } from '../schema.js';
import { nowIso } from '../util.js';

/**
 * Signed-in sessions. The primary key is the sha256 hex digest of the session token: the database never sees the token
 * itself, so a copy of the database cannot be replayed as a cookie. Not append-only — rows are deleted on logout,
 * password change and expiry.
 */
export interface SessionRecord {
  /** sha256(token), lower-case hex. */
  id: string;
  userId: Id;
  createdAt: ISODateTime;
  expiresAt: ISODateTime;
  lastSeenAt: ISODateTime;
  ip?: string;
  userAgent?: string;
}

export interface CreateSessionInput {
  /** sha256 hex digest of the token (64 hex characters). Anything else — e.g. the raw token — is refused. */
  tokenHash: string;
  userId: Id;
  expiresAt: ISODateTime;
  createdAt?: ISODateTime;
  ip?: string;
  userAgent?: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const USER_AGENT_MAX = 512;

function checkHash(tokenHash: string): string {
  const h = tokenHash.toLowerCase();
  if (!SHA256_HEX.test(h)) throw new ValidationError('session id must be the sha256 hex digest of the token');
  return h;
}

function toRecord(row: SessionRow): SessionRecord {
  const rec: SessionRecord = { id: row.id, userId: row.userId, createdAt: row.createdAt, expiresAt: row.expiresAt, lastSeenAt: row.lastSeenAt };
  if (row.ip !== null) rec.ip = row.ip;
  if (row.userAgent !== null) rec.userAgent = row.userAgent;
  return rec;
}

export function createSession(db: Db, input: CreateSessionInput): SessionRecord {
  const createdAt = input.createdAt ?? nowIso();
  if (!(Date.parse(input.expiresAt) > Date.parse(createdAt))) throw new ValidationError('session expiresAt must be after createdAt');
  const row = {
    id: checkHash(input.tokenHash),
    userId: input.userId,
    createdAt,
    expiresAt: input.expiresAt,
    lastSeenAt: createdAt,
    ip: input.ip ?? null,
    userAgent: input.userAgent ? input.userAgent.slice(0, USER_AGENT_MAX) : null,
  };
  db.insert(sessions).values(row).run();
  return toRecord(row);
}

/** The session row for a token digest, expired or not (callers check `expiresAt`). */
export function getSessionByTokenHash(db: Db, tokenHash: string): SessionRecord | undefined {
  const h = tokenHash.toLowerCase();
  if (!SHA256_HEX.test(h)) return undefined;
  const row = db.select().from(sessions).where(eq(sessions.id, h)).get();
  return row ? toRecord(row) : undefined;
}

export function touchSession(db: Db, id: string, at: ISODateTime = nowIso()): void {
  db.update(sessions).set({ lastSeenAt: at }).where(eq(sessions.id, id)).run();
}

/** Delete one session. Returns true when a row was removed. */
export function deleteSession(db: Db, id: string): boolean {
  return db.delete(sessions).where(eq(sessions.id, id)).run().changes > 0;
}

/** Delete every session of a user, optionally keeping one (the caller's own). Returns the number removed. */
export function deleteUserSessions(db: Db, userId: Id, exceptId?: string): number {
  const where = exceptId ? and(eq(sessions.userId, userId), ne(sessions.id, exceptId)) : eq(sessions.userId, userId);
  return db.delete(sessions).where(where).run().changes;
}

/** Delete every session whose absolute expiry is at or before `now`. Returns the number removed. */
export function deleteExpiredSessions(db: Db, now: ISODateTime = nowIso()): number {
  return db.delete(sessions).where(lte(sessions.expiresAt, now)).run().changes;
}

export function listUserSessions(db: Db, userId: Id): SessionRecord[] {
  return db.select().from(sessions).where(eq(sessions.userId, userId)).orderBy(sessions.createdAt).all().map(toRecord);
}
