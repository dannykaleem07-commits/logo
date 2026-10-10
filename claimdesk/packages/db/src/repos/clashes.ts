// owned by ap-clash
/**
 * Repository for clash_findings (docs/SUPREME-AUTOPILOT.md §C.4). The table exists from migration 0013_autopilot.
 *
 * A finding is keyed by `dedupe_key` (unique while open or acknowledged). `upsertClashFindings` records one run of
 * the detector over a scope:
 *  - a finding seen again keeps its row (open / acknowledged / overridden, or resolved by a person) and its
 *    `last_seen_at` moves on — an overridden finding stays overridden (the nightly sweep never re-opens it);
 *  - a new finding (or one the system had resolved) gets a new open row, or an overridden row when it was overridden
 *    in this request (or carries a past override's audit id);
 *  - an open or acknowledged finding in the scope that the run no longer sees is resolved by 'system'.
 * Overridden rows that are no longer seen are left as they are (history).
 */
import { and, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { ClashFinding, ClashFindingRecord, ClashFindingStatus, ClashSeverity, Id, ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError } from '../errors.js';
import { clashFindings, type ClashFindingRow } from '../schema.js';
import { newId, nowIso } from '../util.js';

/** Which stored findings a detector run speaks for (what it may resolve when they are no longer seen). */
export type ClashScope =
  | { claimId: Id }
  | { reservationId: Id }
  | { hireId: Id }
  | { fleetUnitId: Id }
  | { proposed: { claimId: Id; fleetUnitId: Id } };

export interface ClashUpsertOptions {
  at?: ISODateTime;
  /** Findings (by dedupe key) a manager overrode in this request: stored as `overridden` with the reason. */
  overridden?: { keys: readonly string[]; reason: string; by: string; auditId?: Id };
}

export interface ClashUpsertResult {
  /** New rows (open or overridden). */
  inserted: ClashFindingRecord[];
  /** Rows seen again. */
  seen: ClashFindingRecord[];
  /** Rows resolved by 'system' because the run no longer sees them. */
  resolved: ClashFindingRecord[];
}

const EMPTY_RELATED: ClashFinding['related'] = { claimIds: [], reservationIds: [], hireIds: [], fleetUnitIds: [], partyIds: [] };

export function toClashFindingRecord(row: ClashFindingRow): ClashFindingRecord {
  return {
    id: row.id,
    code: row.code as ClashFindingRecord['code'],
    severity: row.severity,
    overrideClass: row.overrideClass ?? 'C',
    message: row.message,
    ...(row.claimId ? { claimId: row.claimId } : {}),
    ...(row.fleetUnitId ? { fleetUnitId: row.fleetUnitId } : {}),
    ...(row.reservationId ? { reservationId: row.reservationId } : {}),
    ...(row.hireId ? { hireId: row.hireId } : {}),
    related: { ...EMPTY_RELATED, ...((row.related ?? {}) as Partial<ClashFinding['related']>) },
    dedupeKey: row.dedupeKey,
    ...(row.data ? { data: row.data } : {}),
    status: row.status,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
    ...(row.resolvedBy ? { resolvedBy: row.resolvedBy } : {}),
    ...(row.resolutionNote ? { resolutionNote: row.resolutionNote } : {}),
    ...(row.overrideAuditId ? { overrideAuditId: row.overrideAuditId } : {}),
  };
}

function scopeWhere(scope: ClashScope): SQL {
  if ('proposed' in scope)
    return and(eq(clashFindings.claimId, scope.proposed.claimId), eq(clashFindings.fleetUnitId, scope.proposed.fleetUnitId), isNull(clashFindings.reservationId), isNull(clashFindings.hireId))!;
  if ('claimId' in scope) return eq(clashFindings.claimId, scope.claimId);
  if ('reservationId' in scope) return eq(clashFindings.reservationId, scope.reservationId);
  if ('hireId' in scope) return eq(clashFindings.hireId, scope.hireId);
  return eq(clashFindings.fleetUnitId, scope.fleetUnitId);
}

/** The most recent row for a dedupe key (any status). */
export function latestClashFindingByKey(db: Db, dedupeKey: string): ClashFindingRecord | undefined {
  const row = db.select().from(clashFindings).where(eq(clashFindings.dedupeKey, dedupeKey)).orderBy(desc(clashFindings.lastSeenAt), desc(clashFindings.firstSeenAt)).get();
  return row ? toClashFindingRecord(row) : undefined;
}

export function upsertClashFindings(db: Db, scope: ClashScope, findings: readonly ClashFinding[], opts: ClashUpsertOptions = {}): ClashUpsertResult {
  const at = opts.at ?? nowIso();
  const overriddenKeys = new Set(opts.overridden?.keys ?? []);
  const result: ClashUpsertResult = { inserted: [], seen: [], resolved: [] };
  const seenKeys = new Set<string>();
  for (const f of findings) {
    if (seenKeys.has(f.dedupeKey)) continue;
    seenKeys.add(f.dedupeKey);
    const prev = latestClashFindingByKey(db, f.dedupeKey);
    const overrideNow = overriddenKeys.has(f.dedupeKey) && opts.overridden;
    const content = {
      code: f.code,
      severity: f.severity as ClashSeverity,
      overrideClass: f.severity === 'block' ? f.overrideClass : null,
      claimId: f.claimId ?? null,
      fleetUnitId: f.fleetUnitId ?? null,
      reservationId: f.reservationId ?? null,
      hireId: f.hireId ?? null,
      related: f.related,
      message: f.message,
      data: f.data ?? null,
    };
    const live = prev && (prev.status === 'open' || prev.status === 'acknowledged' || prev.status === 'overridden' || (prev.status === 'resolved' && prev.resolvedBy !== 'system'));
    if (prev && live) {
      const set: Partial<typeof clashFindings.$inferInsert> = { ...content, lastSeenAt: at };
      if (overrideNow && prev.status !== 'overridden') {
        set.status = 'overridden';
        set.resolvedAt = at;
        set.resolvedBy = opts.overridden!.by;
        set.resolutionNote = opts.overridden!.reason;
        if (opts.overridden!.auditId) set.overrideAuditId = opts.overridden!.auditId;
      }
      db.update(clashFindings).set(set).where(eq(clashFindings.id, prev.id)).run();
      result.seen.push(requireClashFinding(db, prev.id));
      continue;
    }
    const pastOverride = typeof f.data?.overrideAuditId === 'string' ? (f.data.overrideAuditId as string) : undefined;
    const status: ClashFindingStatus = overrideNow || pastOverride ? 'overridden' : 'open';
    const id = newId();
    db.insert(clashFindings)
      .values({
        id,
        ...content,
        dedupeKey: f.dedupeKey,
        status,
        firstSeenAt: at,
        lastSeenAt: at,
        ...(status === 'overridden'
          ? {
              resolvedAt: at,
              resolvedBy: overrideNow ? opts.overridden!.by : 'system',
              resolutionNote: overrideNow ? opts.overridden!.reason : 'Overridden before (the booking carries a manager override)',
              overrideAuditId: overrideNow ? (opts.overridden!.auditId ?? null) : pastOverride!,
            }
          : {}),
      })
      .run();
    result.inserted.push(requireClashFinding(db, id));
  }
  const stale = db
    .select()
    .from(clashFindings)
    .where(and(scopeWhere(scope), inArray(clashFindings.status, ['open', 'acknowledged'])))
    .all()
    .filter((r) => !seenKeys.has(r.dedupeKey));
  for (const r of stale) {
    db.update(clashFindings).set({ status: 'resolved', resolvedAt: at, resolvedBy: 'system', resolutionNote: 'No longer detected' }).where(eq(clashFindings.id, r.id)).run();
    result.resolved.push(requireClashFinding(db, r.id));
  }
  return result;
}

export function getClashFinding(db: Db, id: Id): ClashFindingRecord | undefined {
  const row = db.select().from(clashFindings).where(eq(clashFindings.id, id)).get();
  return row ? toClashFindingRecord(row) : undefined;
}

export function requireClashFinding(db: Db, id: Id): ClashFindingRecord {
  const f = getClashFinding(db, id);
  if (!f) throw new NotFoundError('clash finding', id);
  return f;
}

export interface ClashFindingFilter {
  claimId?: Id;
  fleetUnitId?: Id;
  reservationId?: Id;
  status?: ClashFindingStatus | ClashFindingStatus[];
  code?: string;
  severity?: ClashSeverity;
  /** Findings first or last seen at or after this instant (ISO text compare; callers pass UTC). */
  changedSince?: ISODateTime;
  limit?: number;
}

export function listClashFindings(db: Db, filter: ClashFindingFilter = {}): ClashFindingRecord[] {
  const where: SQL[] = [];
  if (filter.claimId) where.push(eq(clashFindings.claimId, filter.claimId));
  if (filter.fleetUnitId) where.push(eq(clashFindings.fleetUnitId, filter.fleetUnitId));
  if (filter.reservationId) where.push(eq(clashFindings.reservationId, filter.reservationId));
  if (filter.status) where.push(Array.isArray(filter.status) ? inArray(clashFindings.status, filter.status.length ? filter.status : ['open']) : eq(clashFindings.status, filter.status));
  if (filter.code) where.push(eq(clashFindings.code, filter.code));
  if (filter.severity) where.push(eq(clashFindings.severity, filter.severity));
  let rows = db
    .select()
    .from(clashFindings)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(clashFindings.lastSeenAt), desc(clashFindings.id))
    .all()
    .map(toClashFindingRecord);
  if (filter.changedSince) {
    const since = Date.parse(filter.changedSince);
    rows = rows.filter((r) => Date.parse(r.firstSeenAt) >= since || (r.resolvedAt !== undefined && Date.parse(r.resolvedAt) >= since));
  }
  return filter.limit ? rows.slice(0, filter.limit) : rows;
}

/** A person (or the override gate) changes a finding's status: acknowledge a warn, resolve, or record an override. */
export function setClashFindingStatus(
  db: Db,
  id: Id,
  change: { status: Exclude<ClashFindingStatus, 'open'>; by: string; note: string; at?: ISODateTime; overrideAuditId?: Id },
): ClashFindingRecord {
  requireClashFinding(db, id);
  db.update(clashFindings)
    .set({ status: change.status, resolvedBy: change.by, resolutionNote: change.note, resolvedAt: change.at ?? nowIso(), ...(change.overrideAuditId ? { overrideAuditId: change.overrideAuditId } : {}) })
    .where(eq(clashFindings.id, id))
    .run();
  return requireClashFinding(db, id);
}
