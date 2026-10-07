/**
 * Reviews of outbound drafts (docs/SUPREME-DESIGN.md §C.5 step 5) — append-only: a repair loop adds a new row.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { ISODateTime, ReviewTargetKind } from '@ccguk/domain';
import type { Db } from '../client.js';
import { reviews, type ReviewRow, type ReviewTouchesJson } from '../schema.js';
import { denull, nowIso } from '../util.js';

export type ReviewVerdictValue = 'pass' | 'repair' | 'escalate';

export interface ReviewRecord {
  id: string;
  targetKind: ReviewTargetKind;
  targetId: string;
  claimId?: string;
  loop: number;
  /** Tier a (rules) result. */
  rules: unknown;
  /** Tier b (facts) result. */
  facts: unknown;
  /** Tier c (critic model) verdict, when it ran. */
  critic?: unknown;
  verdict: ReviewVerdictValue;
  touches: ReviewTouchesJson;
  runId?: string;
  createdAt: ISODateTime;
}

export interface AppendReviewInput {
  targetKind: ReviewTargetKind;
  targetId: string;
  claimId?: string;
  loop: number;
  rules: unknown;
  facts: unknown;
  critic?: unknown;
  verdict: ReviewVerdictValue;
  touches: ReviewTouchesJson;
  runId?: string;
  now?: ISODateTime;
}

const toReview = (r: ReviewRow): ReviewRecord => ({ ...(denull(r) as ReviewRecord), rules: r.rules ?? null, facts: r.facts ?? null });

export function appendReview(db: Db, input: AppendReviewInput): ReviewRecord {
  const row = {
    id: randomUUID(),
    targetKind: input.targetKind,
    targetId: input.targetId,
    claimId: input.claimId ?? null,
    loop: input.loop,
    rules: input.rules ?? null,
    facts: input.facts ?? null,
    critic: input.critic ?? null,
    verdict: input.verdict,
    touches: input.touches,
    runId: input.runId ?? null,
    createdAt: input.now ?? nowIso(),
  };
  return toReview(db.insert(reviews).values(row).returning().get());
}

export function getReview(db: Db, id: string): ReviewRecord | undefined {
  const r = db.select().from(reviews).where(eq(reviews.id, id)).get();
  return r ? toReview(r) : undefined;
}

/** The latest review of a target (highest loop, then newest). */
export function latestReviewFor(db: Db, target: { kind: ReviewTargetKind; id: string }): ReviewRecord | undefined {
  const r = db
    .select()
    .from(reviews)
    .where(and(eq(reviews.targetKind, target.kind), eq(reviews.targetId, target.id)))
    .orderBy(desc(reviews.loop), desc(reviews.createdAt), desc(sql`rowid`))
    .get();
  return r ? toReview(r) : undefined;
}

export function listReviewsFor(db: Db, target: { kind: ReviewTargetKind; id: string }): ReviewRecord[] {
  return db
    .select()
    .from(reviews)
    .where(and(eq(reviews.targetKind, target.kind), eq(reviews.targetId, target.id)))
    .orderBy(reviews.loop, reviews.createdAt)
    .all()
    .map(toReview);
}
