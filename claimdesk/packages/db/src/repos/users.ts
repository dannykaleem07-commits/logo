import { eq } from 'drizzle-orm';
import type { Id, ISODateTime, User } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { users, type UserRow } from '../schema.js';
import { compact, newId, nowIso } from '../util.js';

/**
 * A staff user as the rest of the system sees it. The password hash is deliberately NOT part of this record so it can
 * never leak through a route that spreads a user; read it with `getPasswordHash` (sign-in only).
 */
export interface UserRecord extends User {
  /** Sign-in name (trimmed, lower-cased). Absent for staff who cannot sign in. */
  username?: string;
  /** When the password was last set through `setPassword`. */
  passwordChangedAt?: ISODateTime;
  createdAt: ISODateTime;
}

export type CreateUserInput = Omit<User, 'id' | 'mfaEnabled'> & {
  id?: Id;
  mfaEnabled?: boolean;
  createdAt?: ISODateTime;
  username?: string;
  /** Already-hashed password ("scheme$…"); plain text is refused. */
  passwordHash?: string;
};

export type UserPatch = Partial<Omit<User, 'id'>> & { username?: string };

/** Usernames compare case-insensitively after trim: they are stored in this form. */
export function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Guard against a plain-text password ever reaching the table: only a self-describing hash string
 * ("<scheme>$<param>$…$<salt>$<hash>", at least six `$`-separated parts) is accepted.
 */
export function assertPasswordHash(value: string): void {
  const parts = value.split('$');
  if (parts.length < 6 || !/^[a-z0-9-]+$/.test(parts[0]!) || parts.some((p) => p.length === 0)) {
    throw new ValidationError('password_hash must be a "scheme$…$salt$hash" string — plain-text passwords are never stored');
  }
}

function toRecord(row: UserRow): UserRecord {
  const rec: UserRecord = { id: row.id, name: row.name, email: row.email, role: row.role, mfaEnabled: row.mfaEnabled, createdAt: row.createdAt };
  if (row.username !== null) rec.username = row.username;
  if (row.passwordChangedAt !== null) rec.passwordChangedAt = row.passwordChangedAt;
  return rec;
}

function validUsername(username: string): string {
  const u = normaliseUsername(username);
  if (!u.length || u.length > 100) throw new ValidationError('username must be 1–100 characters');
  return u;
}

export function createUser(db: Db, input: CreateUserInput): UserRecord {
  if (input.passwordHash !== undefined) assertPasswordHash(input.passwordHash);
  const row = {
    id: input.id ?? newId(),
    name: input.name,
    email: input.email.trim().toLowerCase(),
    role: input.role,
    mfaEnabled: input.mfaEnabled ?? false,
    createdAt: input.createdAt ?? nowIso(),
    username: input.username !== undefined ? validUsername(input.username) : null,
    passwordHash: input.passwordHash ?? null,
    passwordChangedAt: null,
  };
  db.insert(users).values(row).run();
  return toRecord(row);
}

export function getUser(db: Db, id: Id): UserRecord | undefined {
  const row = db.select().from(users).where(eq(users.id, id)).get();
  return row ? toRecord(row) : undefined;
}

export function requireUser(db: Db, id: Id): UserRecord {
  const u = getUser(db, id);
  if (!u) throw new NotFoundError('user', id);
  return u;
}

export function getUserByEmail(db: Db, email: string): UserRecord | undefined {
  const row = db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).get();
  return row ? toRecord(row) : undefined;
}

/** Case-insensitive (trimmed) username lookup. */
export function getUserByUsername(db: Db, username: string): UserRecord | undefined {
  const u = normaliseUsername(username);
  if (!u.length) return undefined;
  const row = db.select().from(users).where(eq(users.username, u)).get();
  return row ? toRecord(row) : undefined;
}

/** The stored password hash (sign-in / change-password only). Undefined when the user has no password. */
export function getPasswordHash(db: Db, userId: Id): string | undefined {
  const row = db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).get();
  return row?.passwordHash ?? undefined;
}

/** Store a new password hash and stamp `password_changed_at`. Plain text is refused (`assertPasswordHash`). */
export function setPassword(db: Db, userId: Id, passwordHash: string, at: ISODateTime = nowIso()): UserRecord {
  assertPasswordHash(passwordHash);
  const res = db.update(users).set({ passwordHash, passwordChangedAt: at }).where(eq(users.id, userId)).run();
  if (res.changes === 0) throw new NotFoundError('user', userId);
  return requireUser(db, userId);
}

export function listUsers(db: Db): UserRecord[] {
  return db.select().from(users).orderBy(users.name).all().map(toRecord);
}

export function updateUser(db: Db, id: Id, patch: UserPatch): UserRecord {
  const set = compact({
    ...patch,
    email: patch.email ? patch.email.trim().toLowerCase() : undefined,
    username: patch.username !== undefined ? validUsername(patch.username) : undefined,
  });
  if (Object.keys(set).length) db.update(users).set(set).where(eq(users.id, id)).run();
  return requireUser(db, id);
}
