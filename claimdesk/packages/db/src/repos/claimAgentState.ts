/**
 * Per-claim agent state (docs/SUPREME-DESIGN.md §C.4, §C.6): pause/resume (audited 'agents.pause' / 'agents.resume'),
 * last review, and the per-claim AI run budget counter.
 */
import { eq } from 'drizzle-orm';
import type { ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { claimAgentState, type ClaimAgentStateRow } from '../schema.js';
import { denull, nowIso } from '../util.js';
import { appendAudit, type Actor } from './audit.js';

export interface ClaimAgentStateRecord {
  claimId: string;
  paused: boolean;
  pausedBy?: string;
  pausedReason?: string;
  pausedAt?: ISODateTime;
  lastReviewAt?: ISODateTime;
  lastReviewRunId?: string;
  nextReviewAt?: ISODateTime;
  runsToday: number;
  /** YYYY-MM-DD the counter belongs to. */
  runsDay?: string;
}

const toState = (r: ClaimAgentStateRow): ClaimAgentStateRecord => denull(r) as ClaimAgentStateRecord;

export function getClaimAgentState(db: Db, claimId: string): ClaimAgentStateRecord {
  const r = db.select().from(claimAgentState).where(eq(claimAgentState.claimId, claimId)).get();
  return r ? toState(r) : { claimId, paused: false, runsToday: 0 };
}

function upsert(db: Db, claimId: string, set: Partial<typeof claimAgentState.$inferInsert>): ClaimAgentStateRecord {
  const r = db
    .insert(claimAgentState)
    .values({ claimId, ...set })
    .onConflictDoUpdate({ target: claimAgentState.claimId, set })
    .returning()
    .get();
  return toState(r);
}

export function pauseClaimAgents(db: Db, claimId: string, input: { actor: Actor; reason?: string; now?: ISODateTime }): ClaimAgentStateRecord {
  const now = input.now ?? nowIso();
  const s = upsert(db, claimId, { paused: true, pausedBy: input.actor.userId, pausedReason: input.reason ?? null, pausedAt: now });
  appendAudit(db, { actor: input.actor, action: 'agents.pause', entity: 'claims', entityId: claimId, after: { scope: 'claim', claimId, reason: input.reason ?? null }, at: now });
  return s;
}

export function resumeClaimAgents(db: Db, claimId: string, input: { actor: Actor; now?: ISODateTime }): ClaimAgentStateRecord {
  const now = input.now ?? nowIso();
  const s = upsert(db, claimId, { paused: false, pausedBy: null, pausedReason: null, pausedAt: null });
  appendAudit(db, { actor: input.actor, action: 'agents.resume', entity: 'claims', entityId: claimId, after: { scope: 'claim', claimId }, at: now });
  return s;
}

export function listPausedClaims(db: Db): string[] {
  return db.select({ id: claimAgentState.claimId }).from(claimAgentState).where(eq(claimAgentState.paused, true)).all().map((r) => r.id);
}

export function markClaimReviewed(db: Db, claimId: string, input: { runId?: string; at?: ISODateTime; nextReviewAt?: ISODateTime }): ClaimAgentStateRecord {
  return upsert(db, claimId, { lastReviewAt: input.at ?? nowIso(), lastReviewRunId: input.runId ?? null, ...(input.nextReviewAt !== undefined ? { nextReviewAt: input.nextReviewAt } : {}) });
}

/** Count one AI run against the claim's daily budget; the counter resets when `day` changes. Returns the new count. */
export function countClaimRun(db: Db, claimId: string, day: string): number {
  const cur = getClaimAgentState(db, claimId);
  const runsToday = cur.runsDay === day ? cur.runsToday + 1 : 1;
  return upsert(db, claimId, { runsToday, runsDay: day }).runsToday;
}

/** Runs counted today (0 when the stored counter belongs to another day). */
export function claimRunsToday(db: Db, claimId: string, day: string): number {
  const cur = getClaimAgentState(db, claimId);
  return cur.runsDay === day ? cur.runsToday : 0;
}
