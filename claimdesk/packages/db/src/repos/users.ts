import { eq } from 'drizzle-orm';
import type { Id, ISODateTime, User } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError } from '../errors.js';
import { users } from '../schema.js';
import { compact, newId, nowIso } from '../util.js';

export interface UserRecord extends User {
  createdAt: ISODateTime;
}

export type CreateUserInput = Omit<User, 'id' | 'mfaEnabled'> & { id?: Id; mfaEnabled?: boolean; createdAt?: ISODateTime };

export function createUser(db: Db, input: CreateUserInput): UserRecord {
  const row = {
    id: input.id ?? newId(),
    name: input.name,
    email: input.email.trim().toLowerCase(),
    role: input.role,
    mfaEnabled: input.mfaEnabled ?? false,
    createdAt: input.createdAt ?? nowIso(),
  };
  db.insert(users).values(row).run();
  return row;
}

export function getUser(db: Db, id: Id): UserRecord | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export function requireUser(db: Db, id: Id): UserRecord {
  const u = getUser(db, id);
  if (!u) throw new NotFoundError('user', id);
  return u;
}

export function getUserByEmail(db: Db, email: string): UserRecord | undefined {
  return db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).get();
}

export function listUsers(db: Db): UserRecord[] {
  return db.select().from(users).orderBy(users.name).all();
}

export function updateUser(db: Db, id: Id, patch: Partial<Omit<User, 'id'>>): UserRecord {
  const set = compact({ ...patch, email: patch.email ? patch.email.trim().toLowerCase() : undefined });
  if (Object.keys(set).length) db.update(users).set(set).where(eq(users.id, id)).run();
  return requireUser(db, id);
}
