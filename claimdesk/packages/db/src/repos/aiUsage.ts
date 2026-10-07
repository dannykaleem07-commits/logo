/**
 * AI usage state (one row, id 'default', docs/SUPREME-DESIGN.md §A.5): the usage-window pause, the latest rate-limit
 * snapshots and the API driver's spend today.
 */
import { eq } from 'drizzle-orm';
import type { ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { aiUsageState, type AiUsageStateRow } from '../schema.js';
import { nowIso } from '../util.js';

export const AI_USAGE_ID = 'default';

export interface AiUsageStateRecord {
  driver: string;
  pausedUntil?: ISODateTime;
  pauseReason?: string;
  /** Latest five-hour RateLimitSnapshot. */
  fiveHour?: unknown;
  /** Latest seven-day RateLimitSnapshot. */
  sevenDay?: unknown;
  costTodayUsd: number;
  costDay?: string;
  updatedAt?: ISODateTime;
}

function toState(r: AiUsageStateRow | undefined): AiUsageStateRecord {
  if (!r) return { driver: 'off', costTodayUsd: 0 };
  const out: AiUsageStateRecord = { driver: r.driver, costTodayUsd: r.costTodayUsd, updatedAt: r.updatedAt };
  if (r.pausedUntil !== null) out.pausedUntil = r.pausedUntil;
  if (r.pauseReason !== null) out.pauseReason = r.pauseReason;
  if (r.fiveHour !== null && r.fiveHour !== undefined) out.fiveHour = r.fiveHour;
  if (r.sevenDay !== null && r.sevenDay !== undefined) out.sevenDay = r.sevenDay;
  if (r.costDay !== null) out.costDay = r.costDay;
  return out;
}

export function getAiUsageState(db: Db): AiUsageStateRecord {
  return toState(db.select().from(aiUsageState).where(eq(aiUsageState.id, AI_USAGE_ID)).get());
}

function upsert(db: Db, set: Partial<typeof aiUsageState.$inferInsert>, now: ISODateTime): AiUsageStateRecord {
  const cur = getAiUsageState(db);
  const values = { driver: cur.driver, costTodayUsd: cur.costTodayUsd, ...set, updatedAt: now };
  const r = db
    .insert(aiUsageState)
    .values({ id: AI_USAGE_ID, ...values })
    .onConflictDoUpdate({ target: aiUsageState.id, set: values })
    .returning()
    .get();
  return toState(r);
}

/** Store the latest snapshots (and the driver in use). Omitted fields are kept. */
export function setAiUsageSnapshot(db: Db, input: { driver?: string; fiveHour?: unknown; sevenDay?: unknown; now?: ISODateTime }): AiUsageStateRecord {
  return upsert(
    db,
    {
      ...(input.driver !== undefined ? { driver: input.driver } : {}),
      ...(input.fiveHour !== undefined ? { fiveHour: input.fiveHour } : {}),
      ...(input.sevenDay !== undefined ? { sevenDay: input.sevenDay } : {}),
    },
    input.now ?? nowIso(),
  );
}

/** Pause AI leasing until `until` (usage limit, auth failure, daily cap). */
export function pauseAi(db: Db, input: { until: ISODateTime; reason: string; now?: ISODateTime }): AiUsageStateRecord {
  return upsert(db, { pausedUntil: input.until, pauseReason: input.reason }, input.now ?? nowIso());
}

export function unpauseAi(db: Db, now: ISODateTime = nowIso()): AiUsageStateRecord {
  return upsert(db, { pausedUntil: null, pauseReason: null }, now);
}

/** Is AI paused at `now`? */
export function isAiPaused(state: AiUsageStateRecord, now: ISODateTime): boolean {
  return state.pausedUntil !== undefined && state.pausedUntil > now;
}

/** Add API spend; the counter resets when `day` (YYYY-MM-DD, London) changes. */
export function addAiCost(db: Db, input: { usd: number; day: string; now?: ISODateTime }): AiUsageStateRecord {
  const cur = getAiUsageState(db);
  const base = cur.costDay === input.day ? cur.costTodayUsd : 0;
  return upsert(db, { costTodayUsd: base + (Number.isFinite(input.usd) ? input.usd : 0), costDay: input.day }, input.now ?? nowIso());
}
