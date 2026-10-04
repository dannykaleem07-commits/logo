import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { Id, ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { AuditImmutableError } from '../errors.js';
import { auditLog } from '../schema.js';
import { denull, newId, nowIso } from '../util.js';

export interface AuditEntry {
  id: Id;
  at: ISODateTime;
  userId: Id | 'system';
  action: string;
  entity: string;
  entityId: Id;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

/** Who is acting — passed to every audited mutation. */
export interface Actor {
  userId: Id | 'system';
  ip?: string;
}

export const SYSTEM_ACTOR: Actor = { userId: 'system' };

export interface AppendAuditInput {
  actor: Actor;
  action: string;
  entity: string;
  entityId: Id;
  before?: unknown;
  after?: unknown;
  at?: ISODateTime;
}

export function appendAudit(db: Db, input: AppendAuditInput): AuditEntry {
  const row = {
    id: newId(),
    at: input.at ?? nowIso(),
    userId: input.actor.userId,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    before: input.before ?? null,
    after: input.after ?? null,
    ip: input.actor.ip ?? null,
  };
  db.insert(auditLog).values(row).run();
  return denull(row);
}

export interface ListAuditFilter {
  entity?: string;
  entityId?: Id;
  userId?: Id | 'system';
  action?: string;
  limit?: number;
  offset?: number;
}

export function listAudit(db: Db, filter: ListAuditFilter = {}): AuditEntry[] {
  const where: SQL[] = [];
  if (filter.entity) where.push(eq(auditLog.entity, filter.entity));
  if (filter.entityId) where.push(eq(auditLog.entityId, filter.entityId));
  if (filter.userId) where.push(eq(auditLog.userId, filter.userId));
  if (filter.action) where.push(eq(auditLog.action, filter.action));
  const rows = db
    .select()
    .from(auditLog)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(auditLog.at))
    .limit(filter.limit ?? 200)
    .offset(filter.offset ?? 0)
    .all();
  return rows.map(denull);
}

/** Always throws: the audit log is append-only. */
export function updateAudit(_db: Db, _id: Id, _patch: unknown): never {
  throw new AuditImmutableError('update');
}

/** Always throws: the audit log is append-only. */
export function deleteAudit(_db: Db, _id: Id): never {
  throw new AuditImmutableError('delete');
}
