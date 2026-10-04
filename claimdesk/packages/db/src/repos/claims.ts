import { and, desc, eq, getTableColumns, inArray, like, or, sql, type SQL } from 'drizzle-orm';
import type { Claim, ClaimFlag, ClaimStatus, Id, ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { claimSequences, claims, parties, vehicles, type ClaimRow } from '../schema.js';
import { compact, denull, likeContains, newId, normaliseRegistration, nowIso } from '../util.js';
import { appendAudit, type Actor } from './audit.js';

export type CreateClaimInput = Omit<Claim, 'id' | 'reference' | 'createdAt' | 'updatedAt' | 'status' | 'openedAt' | 'flags' | 'linkedClaimIds' | 'thirdPartyIds' | 'gtaSubscriber'> & {
  id?: Id;
  /** Normally omitted: generated as CCG-YYYY-NNNNN. Provide only when importing legacy files. */
  reference?: string;
  status?: ClaimStatus;
  openedAt?: ISODateTime;
  flags?: ClaimFlag[];
  linkedClaimIds?: Id[];
  thirdPartyIds?: Id[];
  gtaSubscriber?: boolean;
};

export type ClaimPatch = Partial<Omit<Claim, 'id' | 'reference' | 'createdAt' | 'updatedAt' | 'status'>>;

export function toClaim(row: ClaimRow): Claim {
  return denull(row);
}

export const CLAIM_REFERENCE_PREFIX = 'CCG';
export const CLAIM_REFERENCE_PATTERN = /^CCG-(\d{4})-(\d{5})$/;

export function formatClaimReference(year: number, seq: number): string {
  return `${CLAIM_REFERENCE_PREFIX}-${year}-${String(seq).padStart(5, '0')}`;
}

/**
 * Allocate the next sequential reference for the year (atomic upsert on claim_sequences). Call inside the
 * same transaction as the claim insert so a failed insert does not burn a number silently.
 */
export function nextClaimReference(db: Db, year: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 2999) throw new ValidationError(`invalid claim year ${year}`);
  const row = db
    .insert(claimSequences)
    .values({ year, last: 1 })
    .onConflictDoUpdate({ target: claimSequences.year, set: { last: sql`${claimSequences.last} + 1` } })
    .returning({ last: claimSequences.last })
    .get();
  return formatClaimReference(year, row.last);
}

export function createClaim(db: Db, input: CreateClaimInput): Claim {
  const now = nowIso();
  const openedAt = input.openedAt ?? now;
  const year = Number(openedAt.slice(0, 4));
  return db.transaction(
    (tx) => {
      const id = input.id ?? newId();
      const reference = input.reference ?? nextClaimReference(tx, year);
      tx.insert(claims)
        .values({
          ...input,
          id,
          reference,
          status: input.status ?? 'fnol',
          openedAt,
          thirdPartyIds: input.thirdPartyIds ?? [],
          linkedClaimIds: input.linkedClaimIds ?? [],
          flags: input.flags ?? [],
          gtaSubscriber: input.gtaSubscriber ?? false,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return requireClaim(tx, id);
    },
    { behavior: 'immediate' },
  );
}

export function getClaim(db: Db, id: Id): Claim | undefined {
  const row = db.select().from(claims).where(eq(claims.id, id)).get();
  return row ? toClaim(row) : undefined;
}

export function getClaimByReference(db: Db, reference: string): Claim | undefined {
  const row = db.select().from(claims).where(eq(claims.reference, reference.trim().toUpperCase())).get();
  return row ? toClaim(row) : undefined;
}

export function requireClaim(db: Db, id: Id): Claim {
  const c = getClaim(db, id);
  if (!c) throw new NotFoundError('claim', id);
  return c;
}

export interface ListClaimsFilter {
  status?: ClaimStatus | ClaimStatus[];
  handlerId?: Id;
  atFaultInsurerId?: Id;
  claimantId?: Id;
  clientVehicleId?: Id;
  /** Matches reference, claimant name, or client vehicle registration. */
  search?: string;
  /** Only claims with an uncleared flag of this severity (or any uncleared flag when `true`). */
  flagged?: boolean | ClaimFlag['severity'];
  limit?: number;
  offset?: number;
}

export function listClaims(db: Db, filter: ListClaimsFilter = {}): Claim[] {
  const where: SQL[] = [];
  if (filter.status) {
    where.push(Array.isArray(filter.status) ? inArray(claims.status, filter.status) : eq(claims.status, filter.status));
  }
  if (filter.handlerId) where.push(eq(claims.handlerId, filter.handlerId));
  if (filter.atFaultInsurerId) where.push(eq(claims.atFaultInsurerId, filter.atFaultInsurerId));
  if (filter.claimantId) where.push(eq(claims.claimantId, filter.claimantId));
  if (filter.clientVehicleId) where.push(eq(claims.clientVehicleId, filter.clientVehicleId));
  if (filter.search?.trim()) {
    const q = filter.search.trim();
    const pattern = likeContains(q);
    const reg = normaliseRegistration(q);
    const conds: SQL[] = [like(claims.reference, pattern), like(parties.name, pattern), like(claims.atFaultInsurerRef, pattern)];
    if (reg.length >= 2) conds.push(like(vehicles.registration, `%${reg}%`));
    where.push(or(...conds)!);
  }
  let rows = db
    .select(getTableColumns(claims))
    .from(claims)
    .leftJoin(parties, eq(parties.id, claims.claimantId))
    .leftJoin(vehicles, eq(vehicles.id, claims.clientVehicleId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(claims.openedAt))
    .limit(filter.flagged ? 100_000 : (filter.limit ?? 200))
    .offset(filter.flagged ? 0 : (filter.offset ?? 0))
    .all();
  if (filter.flagged) {
    const sev = filter.flagged === true ? undefined : filter.flagged;
    rows = rows.filter((r) => r.flags.some((f) => !f.clearedAt && (!sev || f.severity === sev)));
    rows = rows.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 200));
  }
  return rows.map(toClaim);
}

export function updateClaim(db: Db, id: Id, patch: ClaimPatch): Claim {
  requireClaim(db, id);
  const set = compact(patch);
  db.update(claims)
    .set({ ...set, updatedAt: nowIso() })
    .where(eq(claims.id, id))
    .run();
  return requireClaim(db, id);
}

/** Change status and write an audit row (`claim.status`). */
export function setClaimStatus(db: Db, id: Id, status: ClaimStatus, actor: Actor, reason?: string): Claim {
  return db.transaction((tx) => {
    const before = requireClaim(tx, id);
    const at = nowIso();
    tx.update(claims).set({ status, updatedAt: at }).where(eq(claims.id, id)).run();
    appendAudit(tx, {
      actor,
      action: 'claim.status',
      entity: 'claims',
      entityId: id,
      before: { status: before.status },
      after: { status, reason: reason ?? null },
      at,
    });
    return requireClaim(tx, id);
  });
}

/** Raise a flag (deduplicated by code while uncleared). */
export function addClaimFlag(db: Db, id: Id, flag: Omit<ClaimFlag, 'raisedAt'> & { raisedAt?: ISODateTime }): Claim {
  const claim = requireClaim(db, id);
  if (claim.flags.some((f) => f.code === flag.code && !f.clearedAt)) return claim;
  const flags = [...claim.flags, { ...flag, raisedAt: flag.raisedAt ?? nowIso() }];
  db.update(claims).set({ flags, updatedAt: nowIso() }).where(eq(claims.id, id)).run();
  return requireClaim(db, id);
}

/** Clear a flag with a reason; the clearance is audited (`claim.flag.clear`). */
export function clearClaimFlag(db: Db, id: Id, code: string, actor: Actor, reason: string): Claim {
  if (!reason?.trim()) throw new ValidationError('a reason is required to clear a flag');
  return db.transaction((tx) => {
    const claim = requireClaim(tx, id);
    const at = nowIso();
    let cleared: ClaimFlag | undefined;
    const flags = claim.flags.map((f) => {
      if (f.code === code && !f.clearedAt) {
        cleared = { ...f, clearedAt: at, clearedBy: actor.userId, clearedReason: reason };
        return cleared;
      }
      return f;
    });
    if (!cleared) throw new NotFoundError('claim flag', `${id}/${code}`);
    tx.update(claims).set({ flags, updatedAt: at }).where(eq(claims.id, id)).run();
    appendAudit(tx, { actor, action: 'claim.flag.clear', entity: 'claims', entityId: id, before: { code, severity: cleared.severity }, after: { code, reason }, at });
    return requireClaim(tx, id);
  });
}

/** Link two claims both ways (same registration / connected files). */
export function linkClaims(db: Db, aId: Id, bId: Id): void {
  if (aId === bId) return;
  db.transaction((tx) => {
    const a = requireClaim(tx, aId);
    const b = requireClaim(tx, bId);
    const at = nowIso();
    if (!a.linkedClaimIds.includes(bId)) tx.update(claims).set({ linkedClaimIds: [...a.linkedClaimIds, bId], updatedAt: at }).where(eq(claims.id, aId)).run();
    if (!b.linkedClaimIds.includes(aId)) tx.update(claims).set({ linkedClaimIds: [...b.linkedClaimIds, aId], updatedAt: at }).where(eq(claims.id, bId)).run();
  });
}

export function countClaimsByStatus(db: Db): Array<{ status: ClaimStatus; count: number }> {
  return db
    .select({ status: claims.status, count: sql<number>`count(*)`.mapWith(Number) })
    .from(claims)
    .groupBy(claims.status)
    .all();
}
