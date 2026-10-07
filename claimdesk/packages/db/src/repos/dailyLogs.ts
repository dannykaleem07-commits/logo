/**
 * Compiled daily logs (docs/SUPREME-DESIGN.md §J.2): one row per London day, re-compiled on demand (upsert).
 */
import { desc, eq } from 'drizzle-orm';
import type { ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { dailyLogs, type DailyLogRow } from '../schema.js';
import { denull, nowIso } from '../util.js';

export interface DailyLogRecord {
  /** YYYY-MM-DD (Europe/London). */
  day: string;
  compiledAt: ISODateTime;
  /** The `DailyLog` document (shape owned by the runtime slice, agent/dailyLog.ts). */
  log: unknown;
  emailedAt?: ISODateTime;
}

const toLog = (r: DailyLogRow): DailyLogRecord => ({ ...(denull(r) as DailyLogRecord), log: r.log ?? null });

export function upsertDailyLog(db: Db, input: { day: string; log: unknown; compiledAt?: ISODateTime }): DailyLogRecord {
  const compiledAt = input.compiledAt ?? nowIso();
  const row = db
    .insert(dailyLogs)
    .values({ day: input.day, compiledAt, log: input.log ?? null })
    .onConflictDoUpdate({ target: dailyLogs.day, set: { compiledAt, log: input.log ?? null } })
    .returning()
    .get();
  return toLog(row);
}

export function getDailyLog(db: Db, day: string): DailyLogRecord | undefined {
  const r = db.select().from(dailyLogs).where(eq(dailyLogs.day, day)).get();
  return r ? toLog(r) : undefined;
}

/** Newest day first. */
export function listDailyLogs(db: Db, limit = 30): DailyLogRecord[] {
  return db.select().from(dailyLogs).orderBy(desc(dailyLogs.day)).limit(Math.max(1, Math.min(limit, 366))).all().map(toLog);
}

export function markDailyLogEmailed(db: Db, day: string, at: ISODateTime = nowIso()): DailyLogRecord | undefined {
  const r = db.update(dailyLogs).set({ emailedAt: at }).where(eq(dailyLogs.day, day)).returning().get();
  return r ? toLog(r) : undefined;
}
