import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
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
  /** agent_runs.id when an agent principal acted (SUPREME §B.1). */
  runId?: string;
}

/** Who is acting — passed to every audited mutation. */
export interface Actor {
  /** A user id, 'system', or 'agent:<name>' for an agent principal (SUPREME §B.1). */
  userId: Id | 'system';
  ip?: string;
  /** The agent run that acted (agent principals only); written to audit_log.run_id. */
  runId?: string;
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
    runId: input.actor.runId ?? null,
  };
  db.insert(auditLog).values(row).run();
  return denull(row);
}

export interface ListAuditFilter {
  entity?: string;
  entityId?: Id;
  userId?: Id | 'system';
  action?: string;
  /** Rows written during one agent run. */
  runId?: string;
  /** user_id prefix, e.g. 'agent:' for every agent write (the daily log). */
  userIdPrefix?: string;
  limit?: number;
  offset?: number;
}

const likePrefix = (p: string): string => `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function listAudit(db: Db, filter: ListAuditFilter = {}): AuditEntry[] {
  const where: SQL[] = [];
  if (filter.entity) where.push(eq(auditLog.entity, filter.entity));
  if (filter.entityId) where.push(eq(auditLog.entityId, filter.entityId));
  if (filter.userId) where.push(eq(auditLog.userId, filter.userId));
  if (filter.action) where.push(eq(auditLog.action, filter.action));
  if (filter.runId) where.push(eq(auditLog.runId, filter.runId));
  if (filter.userIdPrefix) where.push(sql`${auditLog.userId} like ${likePrefix(filter.userIdPrefix)} escape '\\'`);
  const rows = db
    .select()
    .from(auditLog)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(auditLog.at), desc(sql`rowid`))
    .limit(filter.limit ?? 200)
    .offset(filter.offset ?? 0)
    .all();
  return rows.map(denull);
}

/**
 * Audit trail of one claim (0.3 §A.6 B44): rows whose entityId is the claim or one of `relatedIds` (its hires, storage,
 * recovery, offers, documents, estimates, PAVs, engineer reports…), or whose `after.claimId` is the claim. Newest first.
 */
export function listAuditForClaim(db: Db, claimId: Id, relatedIds: readonly Id[] = [], limit = 500): AuditEntry[] {
  const ids = [...new Set([claimId, ...relatedIds.filter((x) => typeof x === 'string' && x.length > 0)])];
  // SQLite caps bound parameters per statement; chunk large id lists into OR'd IN clauses.
  const chunks: SQL[] = [];
  for (let i = 0; i < ids.length; i += 500) chunks.push(inArray(auditLog.entityId, ids.slice(i, i + 500)));
  const byClaimId = sql`(json_valid(${auditLog.after}) and json_extract(${auditLog.after}, '$.claimId') = ${claimId})`;
  const rows = db
    .select()
    .from(auditLog)
    .where(or(...chunks, byClaimId))
    .orderBy(desc(auditLog.at), desc(sql`rowid`))
    .limit(Math.max(1, Math.min(limit, 5000)))
    .all();
  return rows.map(denull);
}

export interface ListAuditByActionsFilter {
  /** Action prefixes, e.g. `['override.']`. */
  prefixes?: readonly string[];
  /** Exact actions, e.g. `['manager_mode.on', 'manager_mode.off']`. */
  actions?: readonly string[];
  limit?: number;
}

/** Audit rows whose action starts with one of `prefixes` or equals one of `actions`, newest first. */
export function listAuditByActions(db: Db, filter: ListAuditByActionsFilter): AuditEntry[] {
  const conds: SQL[] = [];
  for (const p of filter.prefixes ?? []) {
    if (!p) continue;
    // Escape LIKE wildcards so a prefix such as 'override.' matches literally.
    conds.push(sql`${auditLog.action} like ${`${p.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} escape '\\'`);
  }
  if (filter.actions?.length) conds.push(inArray(auditLog.action, [...filter.actions]));
  if (!conds.length) return [];
  const rows = db
    .select()
    .from(auditLog)
    .where(or(...conds))
    .orderBy(desc(auditLog.at), desc(sql`rowid`))
    .limit(Math.max(1, Math.min(filter.limit ?? 50, 1000)))
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
