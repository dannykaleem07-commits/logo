// owned by knowledge-use
/**
 * Persistence for knowledge-use (docs/SUPREME-KNOWLEDGE-BUILDER.md §5 use + evals block): `knowledge_usage`
 * (append-only: which refs a run was given, and which a draft cited), `eval_cases` (append-only, frozen once written),
 * `eval_runs` (append-only: a run is written once, when it finishes), `knowledge_alarms` (status moves), plus the
 * ranked FTS read over `knowledge_items` that retrieval uses. Rows only — the rules live in apps/api/src/knowledge/use
 * and apps/api/src/knowledge/evals. Private: rows live only in the owner's DATA_DIR database.
 */
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { EvalCase, EvalDecisionPoint, ISODateTime, KnowledgeItem, KnowledgeStatus } from '@ccguk/domain';
import type { Db } from '../client.js';
import { evalCases, evalRuns, knowledgeAlarms, knowledgeItems, knowledgeUsage, type EvalCaseRow, type EvalRunRow, type KnowledgeAlarmRow, type KnowledgeUsageRowDb } from '../schema.js';
import { newId } from '../util.js';
import { ftsQuery } from './brain.js';
import { toKnowledgeItem } from './knowledge.js';

// ---------------------------------------------------------------------------
// Ranked FTS over knowledge items (retrieval)
// ---------------------------------------------------------------------------

export interface KnowledgeFtsHit {
  item: KnowledgeItem;
  /** FTS5 bm25() — lower (more negative) is a better match. */
  bm25: number;
}

/** Items matching `q` (FTS5 over title/body/tags), best first; statuses default to active. */
export function searchKnowledgeFts(db: Db, input: { q: string; statuses?: readonly KnowledgeStatus[]; ids?: readonly string[]; limit?: number }): KnowledgeFtsHit[] {
  const match = ftsQuery(input.q);
  if (!match) return [];
  const statuses = input.statuses?.length ? [...input.statuses] : ['active'];
  const conds: SQL[] = [sql`knowledge_items.status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})`];
  if (input.ids) {
    if (!input.ids.length) return [];
    conds.push(sql`knowledge_items.id IN (${sql.join(input.ids.map((s) => sql`${s}`), sql`, `)})`);
  }
  const limit = Math.max(1, Math.min(input.limit ?? 50, 500));
  const rows = db.all<{ rowid_key: number; score: number }>(sql`
    SELECT knowledge_items.rowid_key AS rowid_key, bm25(knowledge_fts) AS score
    FROM knowledge_fts JOIN knowledge_items ON knowledge_items.rowid_key = knowledge_fts.rowid
    WHERE knowledge_fts MATCH ${match} AND ${sql.join(conds, sql` AND `)}
    ORDER BY score, knowledge_items.rowid_key
    LIMIT ${limit}`);
  if (!rows.length) return [];
  const byKey = new Map(
    db
      .select()
      .from(knowledgeItems)
      .where(inArray(knowledgeItems.rowidKey, rows.map((r) => r.rowid_key)))
      .all()
      .map((r) => [r.rowidKey, toKnowledgeItem(r)] as const),
  );
  return rows.flatMap((r) => (byKey.get(r.rowid_key) ? [{ item: byKey.get(r.rowid_key)!, bm25: r.score }] : []));
}

// ---------------------------------------------------------------------------
// knowledge_usage (append-only)
// ---------------------------------------------------------------------------

export interface KnowledgeUsageRecord {
  id: string;
  runId: string;
  claimId: string | null;
  ref: string;
  badges: string[];
  rank: number;
  injected: boolean;
  cited: boolean;
  targetKind: string | null;
  targetId: string | null;
  at: ISODateTime;
}

const toUsage = (r: KnowledgeUsageRowDb): KnowledgeUsageRecord => ({
  id: r.id,
  runId: r.runId,
  claimId: r.claimId,
  ref: r.ref,
  badges: r.badges ?? [],
  rank: r.rank,
  injected: Boolean(r.injected),
  cited: Boolean(r.cited),
  targetKind: r.targetKind,
  targetId: r.targetId,
  at: r.at,
});

export type KnowledgeUsageInput = Omit<KnowledgeUsageRecord, 'id'> & { id?: string };

/** Append usage rows (one transaction is the caller's). */
export function insertKnowledgeUsage(db: Db, rows: readonly KnowledgeUsageInput[]): KnowledgeUsageRecord[] {
  return rows.map((r) => {
    const row = { ...r, id: r.id ?? newId() };
    return toUsage(db.insert(knowledgeUsage).values(row).returning().get());
  });
}

export function listKnowledgeUsage(db: Db, f: { runIds?: readonly string[]; ref?: string; refs?: readonly string[]; targetKind?: string; targetId?: string; cited?: boolean; limit?: number } = {}): KnowledgeUsageRecord[] {
  const conds: SQL[] = [];
  if (f.runIds) {
    if (!f.runIds.length) return [];
    conds.push(inArray(knowledgeUsage.runId, [...f.runIds]));
  }
  if (f.ref) conds.push(eq(knowledgeUsage.ref, f.ref));
  if (f.refs) {
    if (!f.refs.length) return [];
    conds.push(inArray(knowledgeUsage.ref, [...f.refs]));
  }
  if (f.targetKind) conds.push(eq(knowledgeUsage.targetKind, f.targetKind));
  if (f.targetId) conds.push(eq(knowledgeUsage.targetId, f.targetId));
  if (f.cited !== undefined) conds.push(eq(knowledgeUsage.cited, f.cited));
  return db
    .select()
    .from(knowledgeUsage)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(knowledgeUsage.at), knowledgeUsage.rank, knowledgeUsage.id)
    .limit(Math.max(1, Math.min(f.limit ?? 500, 5000)))
    .all()
    .map(toUsage);
}

// ---------------------------------------------------------------------------
// eval_cases (append-only, frozen once written)
// ---------------------------------------------------------------------------

const toCase = (r: EvalCaseRow): EvalCase => ({
  id: r.id,
  claimId: r.claimId,
  decisionPoint: r.decisionPoint as EvalDecisionPoint,
  at: r.at,
  facts: (r.facts ?? {}) as Record<string, unknown>,
  historic: (r.historic ?? { actionCodes: [], steps: [] }) as EvalCase['historic'],
  outcome: (r.outcome ?? { workingDaysToPay: null, paidOfClaimedPct: null }) as EvalCase['outcome'],
  insurerSlug: r.insurerSlug,
  outcomeQuartile: r.outcomeQuartile,
});

/** Insert a case unless (claim, decision point, at) already exists — cases are frozen once written. */
export function insertEvalCase(db: Db, c: Omit<EvalCase, 'id'> & { id?: string }, createdAt: ISODateTime): { case: EvalCase; created: boolean } {
  const inserted = db
    .insert(evalCases)
    .values({ id: c.id ?? newId(), claimId: c.claimId, decisionPoint: c.decisionPoint, at: c.at, facts: c.facts, historic: c.historic, outcome: c.outcome, insurerSlug: c.insurerSlug, outcomeQuartile: c.outcomeQuartile, createdAt })
    .onConflictDoNothing()
    .returning()
    .all();
  if (inserted[0]) return { case: toCase(inserted[0]), created: true };
  const existing = db.select().from(evalCases).where(and(eq(evalCases.claimId, c.claimId), eq(evalCases.decisionPoint, c.decisionPoint), eq(evalCases.at, c.at))).get();
  return { case: toCase(existing!), created: false };
}

export function listEvalCases(db: Db, f: { insurerSlug?: string; claimIds?: readonly string[]; limit?: number } = {}): EvalCase[] {
  const conds: SQL[] = [];
  if (f.insurerSlug) conds.push(eq(evalCases.insurerSlug, f.insurerSlug));
  if (f.claimIds) {
    if (!f.claimIds.length) return [];
    conds.push(inArray(evalCases.claimId, [...f.claimIds]));
  }
  return db
    .select()
    .from(evalCases)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(evalCases.id)
    .limit(Math.max(1, Math.min(f.limit ?? 10_000, 100_000)))
    .all()
    .map(toCase);
}

export function countEvalCases(db: Db): number {
  return Number(db.select({ n: sql<number>`count(*)` }).from(evalCases).get()?.n ?? 0);
}

// ---------------------------------------------------------------------------
// eval_runs (append-only: written once, finished)
// ---------------------------------------------------------------------------

export type EvalRunMode = 'gate' | 'nightly' | 'drafts';
export type EvalVerdict = 'no_worse' | 'worse' | 'inconclusive' | 'error';
export interface EvalRunRecord {
  id: string;
  mode: EvalRunMode;
  baselineVersion: number | null;
  candidate: unknown;
  cases: number;
  metrics: unknown;
  verdict: EvalVerdict;
  details: unknown;
  startedAt: ISODateTime;
  finishedAt: ISODateTime | null;
  jobId: string | null;
  createdBy: string;
}

const toRun = (r: EvalRunRow): EvalRunRecord => ({
  id: r.id,
  mode: r.mode as EvalRunMode,
  baselineVersion: r.baselineVersion,
  candidate: r.candidate,
  cases: r.cases,
  metrics: r.metrics,
  verdict: r.verdict as EvalVerdict,
  details: r.details,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  jobId: r.jobId,
  createdBy: r.createdBy,
});

export function insertEvalRun(db: Db, run: Omit<EvalRunRecord, 'id'> & { id?: string }): EvalRunRecord {
  return toRun(db.insert(evalRuns).values({ ...run, id: run.id ?? newId() }).returning().get());
}

export function getEvalRun(db: Db, id: string): EvalRunRecord | undefined {
  const r = db.select().from(evalRuns).where(eq(evalRuns.id, id)).get();
  return r ? toRun(r) : undefined;
}

/** Newest first. `itemId` matches runs whose candidate names that item (JSON text match on the id). */
export function listEvalRuns(db: Db, f: { mode?: EvalRunMode; itemId?: string; limit?: number; offset?: number } = {}): EvalRunRecord[] {
  const conds: SQL[] = [];
  if (f.mode) conds.push(eq(evalRuns.mode, f.mode));
  if (f.itemId) conds.push(sql`instr(${evalRuns.candidate}, ${JSON.stringify(f.itemId)}) > 0`);
  return db
    .select()
    .from(evalRuns)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(evalRuns.startedAt), desc(evalRuns.id))
    .limit(Math.max(1, Math.min(f.limit ?? 50, 500)))
    .offset(Math.max(0, f.offset ?? 0))
    .all()
    .map(toRun);
}

// ---------------------------------------------------------------------------
// knowledge_alarms
// ---------------------------------------------------------------------------

export type AlarmStatus = 'open' | 'acknowledged' | 'resolved';
export interface KnowledgeAlarmRecord {
  id: string;
  metric: string;
  packVersion: number | null;
  baseline: number | null;
  current: number | null;
  n: number;
  threshold: number;
  severity: 'warn' | 'severe';
  status: AlarmStatus;
  actionTaken: string | null;
  needsYouId: string | null;
  raisedAt: ISODateTime;
  resolvedBy: string | null;
  resolvedAt: ISODateTime | null;
}

const toAlarm = (r: KnowledgeAlarmRow): KnowledgeAlarmRecord => ({
  id: r.id,
  metric: r.metric,
  packVersion: r.packVersion,
  baseline: r.baseline,
  current: r.current,
  n: r.n,
  threshold: r.threshold,
  severity: r.severity as KnowledgeAlarmRecord['severity'],
  status: r.status as AlarmStatus,
  actionTaken: r.actionTaken,
  needsYouId: r.needsYouId,
  raisedAt: r.raisedAt,
  resolvedBy: r.resolvedBy,
  resolvedAt: r.resolvedAt,
});

export function insertKnowledgeAlarm(db: Db, a: Omit<KnowledgeAlarmRecord, 'id' | 'status' | 'resolvedBy' | 'resolvedAt' | 'needsYouId' | 'actionTaken'> & { id?: string; actionTaken?: string | null }): KnowledgeAlarmRecord {
  return toAlarm(
    db
      .insert(knowledgeAlarms)
      .values({ ...a, id: a.id ?? newId(), status: 'open', actionTaken: a.actionTaken ?? null, needsYouId: null, resolvedBy: null, resolvedAt: null })
      .returning()
      .get(),
  );
}

export function getKnowledgeAlarm(db: Db, id: string): KnowledgeAlarmRecord | undefined {
  const r = db.select().from(knowledgeAlarms).where(eq(knowledgeAlarms.id, id)).get();
  return r ? toAlarm(r) : undefined;
}

export function listKnowledgeAlarms(db: Db, f: { status?: AlarmStatus | 'all'; metric?: string; packVersion?: number | null; limit?: number } = {}): KnowledgeAlarmRecord[] {
  const conds: SQL[] = [];
  if (f.status && f.status !== 'all') conds.push(eq(knowledgeAlarms.status, f.status));
  if (f.metric) conds.push(eq(knowledgeAlarms.metric, f.metric));
  if (f.packVersion !== undefined) conds.push(f.packVersion === null ? sql`${knowledgeAlarms.packVersion} IS NULL` : eq(knowledgeAlarms.packVersion, f.packVersion));
  return db
    .select()
    .from(knowledgeAlarms)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(knowledgeAlarms.raisedAt), desc(knowledgeAlarms.id))
    .limit(Math.max(1, Math.min(f.limit ?? 100, 1000)))
    .all()
    .map(toAlarm);
}

export function updateKnowledgeAlarm(db: Db, id: string, patch: { status?: AlarmStatus; actionTaken?: string | null; needsYouId?: string | null; resolvedBy?: string | null; resolvedAt?: ISODateTime | null }): KnowledgeAlarmRecord {
  const set: Partial<typeof knowledgeAlarms.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.actionTaken !== undefined) set.actionTaken = patch.actionTaken;
  if (patch.needsYouId !== undefined) set.needsYouId = patch.needsYouId;
  if (patch.resolvedBy !== undefined) set.resolvedBy = patch.resolvedBy;
  if (patch.resolvedAt !== undefined) set.resolvedAt = patch.resolvedAt;
  const r = db.update(knowledgeAlarms).set(set).where(eq(knowledgeAlarms.id, id)).returning().get();
  if (!r) throw new Error(`knowledge alarm ${id} not found`);
  return toAlarm(r);
}
