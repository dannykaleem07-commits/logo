import { and, asc, eq, inArray, lte, type SQL } from 'drizzle-orm';
import type { Clock, Id, ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { clocks, type ClockRow } from '../schema.js';
import { denull, newId, nowIso } from '../util.js';

function toClock(row: ClockRow): Clock {
  const { computedAt: _c, ...rest } = row;
  return denull(rest);
}

/**
 * Replace the materialised clocks for a claim with the output of `deriveClocks()` (@ccguk/domain).
 * The cache exists for dashboard queries ("what is due today across all claims"); the API recomputes it
 * whenever an event is appended. Ids are kept when provided, otherwise generated.
 */
export function replaceClocks(db: Db, claimId: Id, derived: Array<Omit<Clock, 'id' | 'claimId'> & { id?: Id; claimId?: Id }>, computedAt: ISODateTime = nowIso()): Clock[] {
  return db.transaction((tx) => {
    tx.delete(clocks).where(eq(clocks.claimId, claimId)).run();
    if (derived.length) {
      tx.insert(clocks)
        .values(derived.map((c) => ({ ...c, id: c.id ?? newId(), claimId, computedAt })))
        .run();
    }
    return listClocks(tx, claimId);
  });
}

export function listClocks(db: Db, claimId: Id): Clock[] {
  return db.select().from(clocks).where(eq(clocks.claimId, claimId)).orderBy(asc(clocks.dueAt)).all().map(toClock);
}

export interface DueClocksFilter {
  /** Clocks due at or before this instant (default: now + 7 days). */
  dueBefore?: ISODateTime;
  status?: Clock['status'][];
}

/** Cross-claim view for the dashboard: running/breached clocks ordered by due date. */
export function listDueClocks(db: Db, filter: DueClocksFilter = {}): Array<Clock & { computedAt: ISODateTime }> {
  const dueBefore = filter.dueBefore ?? new Date(Date.now() + 7 * 86_400_000).toISOString();
  const where: SQL[] = [lte(clocks.dueAt, dueBefore), inArray(clocks.status, filter.status ?? ['running', 'breached'])];
  return db
    .select()
    .from(clocks)
    .where(and(...where))
    .orderBy(asc(clocks.dueAt))
    .all()
    .map((r) => ({ ...toClock(r), computedAt: r.computedAt }));
}
