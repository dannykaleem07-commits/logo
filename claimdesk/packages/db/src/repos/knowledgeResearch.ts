// owned by knowledge-research
/**
 * Persistence for knowledge-research (docs/SUPREME-KNOWLEDGE-BUILDER.md §5 research block, §7): knowledge_gaps,
 * knowledge_sources and source_snapshots (append-only: the DB refuses UPDATE and DELETE). Rows only — the rules
 * (scrubbing, triage, licences, rate limits) live in apps/api/src/knowledge/research/**. Private: rows live only in the
 * owner's DATA_DIR database; snapshot files live under DATA_DIR\knowledge-store\snapshots.
 */
import { and, asc, desc, eq, inArray, lte, or, isNull, sql, type SQL } from 'drizzle-orm';
import type { GapKind, GapOrigin, GapStatus, ISODateTime, KnowledgeArea, KnowledgeGapView, KnowledgeScope, SnapshotView, SourceView } from '@ccguk/domain';
import type { Db } from '../client.js';
import { knowledgeGaps, knowledgeSources, sourceSnapshots, type KnowledgeGapRow, type KnowledgeSourceRow, type SourceSnapshotRow } from '../schema.js';
import { newId } from '../util.js';

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

/** Statuses covered by the partial unique index (one open gap per gap key). */
export const OPEN_GAP_STATUSES: readonly GapStatus[] = ['open', 'researching', 'answered_pending', 'needs_owner'];

const scopeOfGap = (kind: string, value: string | null): KnowledgeScope =>
  kind === 'insurer' && value ? { kind: 'insurer', slug: value } : kind === 'claim_type' && value ? { kind: 'claim_type', tag: value as never } : { kind: 'global' };

const gapScopeColumns = (scope: KnowledgeScope): { scopeKind: string; scopeValue: string | null } =>
  scope.kind === 'insurer' ? { scopeKind: 'insurer', scopeValue: scope.slug } : scope.kind === 'claim_type' ? { scopeKind: 'claim_type', scopeValue: scope.tag } : { scopeKind: 'global', scopeValue: null };

export interface KnowledgeGapRecord extends KnowledgeGapView {
  spend: Record<string, unknown>;
  updatedAt: ISODateTime;
}

export function toKnowledgeGap(r: KnowledgeGapRow): KnowledgeGapRecord {
  return {
    id: r.id,
    gapKey: r.gapKey,
    kind: r.kind as GapKind,
    question: r.question,
    area: r.area as KnowledgeArea,
    scope: scopeOfGap(r.scopeKind, r.scopeValue),
    origin: r.origin as GapOrigin,
    originRef: r.originRef,
    claimIds: r.claimIds ?? [],
    blocking: Boolean(r.blocking),
    occurrences: r.occurrences,
    priority: r.priority,
    status: r.status as GapStatus,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    answerItemIds: r.answerItemIds ?? [],
    raisedBy: r.raisedBy,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    closedBy: r.closedBy,
    closedAt: r.closedAt,
    closeNote: r.closeNote,
    needsYouId: r.needsYouId,
    spend: (r.spend && typeof r.spend === 'object' ? r.spend : {}) as Record<string, unknown>,
    updatedAt: r.updatedAt,
  };
}

export interface InsertGapInput {
  gapKey: string;
  kind: GapKind;
  question: string;
  area: KnowledgeArea;
  scope: KnowledgeScope;
  origin: GapOrigin;
  originRef?: string | null;
  claimIds?: string[];
  blocking?: boolean;
  priority: number;
  status?: GapStatus;
  nextAttemptAt?: ISODateTime | null;
  raisedBy: string;
  closeNote?: string | null;
  closedBy?: string | null;
  at: ISODateTime;
}

export function insertKnowledgeGap(db: Db, g: InsertGapInput): KnowledgeGapRecord {
  const closed = g.status && !OPEN_GAP_STATUSES.includes(g.status);
  const row = db
    .insert(knowledgeGaps)
    .values({
      id: newId(),
      gapKey: g.gapKey,
      kind: g.kind,
      question: g.question,
      area: g.area,
      ...gapScopeColumns(g.scope),
      origin: g.origin,
      originRef: g.originRef ?? null,
      claimIds: [...new Set(g.claimIds ?? [])],
      blocking: Boolean(g.blocking),
      occurrences: 1,
      priority: g.priority,
      status: g.status ?? 'open',
      attempts: 0,
      nextAttemptAt: g.nextAttemptAt ?? null,
      answerItemIds: [],
      spend: {},
      raisedBy: g.raisedBy,
      createdAt: g.at,
      lastSeenAt: g.at,
      closedBy: closed ? (g.closedBy ?? g.raisedBy) : null,
      closedAt: closed ? g.at : null,
      closeNote: g.closeNote ?? null,
      needsYouId: null,
      updatedAt: g.at,
    })
    .returning()
    .get();
  return toKnowledgeGap(row);
}

export function getKnowledgeGap(db: Db, id: string): KnowledgeGapRecord | undefined {
  const r = db.select().from(knowledgeGaps).where(eq(knowledgeGaps.id, id)).get();
  return r ? toKnowledgeGap(r) : undefined;
}

/** The open gap (open / researching / answered_pending / needs_owner) with this key, if any. */
export function findOpenKnowledgeGap(db: Db, gapKey: string): KnowledgeGapRecord | undefined {
  const r = db
    .select()
    .from(knowledgeGaps)
    .where(and(eq(knowledgeGaps.gapKey, gapKey), inArray(knowledgeGaps.status, [...OPEN_GAP_STATUSES])))
    .get();
  return r ? toKnowledgeGap(r) : undefined;
}

/** The most recent gap with this key whatever its status (dedupe of closed gaps). */
export function latestKnowledgeGapByKey(db: Db, gapKey: string): KnowledgeGapRecord | undefined {
  const r = db.select().from(knowledgeGaps).where(eq(knowledgeGaps.gapKey, gapKey)).orderBy(desc(knowledgeGaps.createdAt), desc(knowledgeGaps.id)).limit(1).get();
  return r ? toKnowledgeGap(r) : undefined;
}

export interface ListGapsFilter {
  status?: GapStatus | 'open_any' | 'all';
  kind?: GapKind;
  origin?: GapOrigin;
  limit?: number;
  offset?: number;
}

export function listKnowledgeGaps(db: Db, f: ListGapsFilter = {}): { gaps: KnowledgeGapRecord[]; total: number } {
  const conds: SQL[] = [];
  if (f.status === 'open_any') conds.push(inArray(knowledgeGaps.status, [...OPEN_GAP_STATUSES]));
  else if (f.status && f.status !== 'all') conds.push(eq(knowledgeGaps.status, f.status));
  if (f.kind) conds.push(eq(knowledgeGaps.kind, f.kind));
  if (f.origin) conds.push(eq(knowledgeGaps.origin, f.origin));
  const where = conds.length ? and(...conds) : undefined;
  const total = Number(db.select({ c: sql<number>`count(*)` }).from(knowledgeGaps).where(where).get()?.c ?? 0);
  const gaps = db
    .select()
    .from(knowledgeGaps)
    .where(where)
    .orderBy(asc(knowledgeGaps.priority), desc(knowledgeGaps.lastSeenAt), asc(knowledgeGaps.id))
    .limit(Math.max(1, Math.min(f.limit ?? 100, 1000)))
    .offset(Math.max(0, f.offset ?? 0))
    .all()
    .map(toKnowledgeGap);
  return { gaps, total };
}

/** Open gaps due for research now (status open, next attempt passed or unset), best priority first. */
export function dueKnowledgeGaps(db: Db, now: ISODateTime, limit = 20): KnowledgeGapRecord[] {
  return db
    .select()
    .from(knowledgeGaps)
    .where(and(eq(knowledgeGaps.status, 'open'), or(isNull(knowledgeGaps.nextAttemptAt), lte(knowledgeGaps.nextAttemptAt, now))))
    .orderBy(asc(knowledgeGaps.priority), desc(knowledgeGaps.blocking), asc(knowledgeGaps.createdAt))
    .limit(Math.max(1, Math.min(limit, 500)))
    .all()
    .map(toKnowledgeGap);
}

export interface GapPatch {
  status?: GapStatus;
  priority?: number;
  blocking?: boolean;
  occurrences?: number;
  claimIds?: string[];
  attempts?: number;
  nextAttemptAt?: ISODateTime | null;
  answerItemIds?: string[];
  spend?: Record<string, unknown>;
  lastSeenAt?: ISODateTime;
  closedBy?: string | null;
  closedAt?: ISODateTime | null;
  closeNote?: string | null;
  needsYouId?: string | null;
  updatedAt: ISODateTime;
}

export function updateKnowledgeGap(db: Db, id: string, patch: GapPatch): KnowledgeGapRecord {
  const r = db.update(knowledgeGaps).set(patch).where(eq(knowledgeGaps.id, id)).returning().get();
  if (!r) throw new Error(`knowledge gap ${id} not found`);
  return toKnowledgeGap(r);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type SourceOrigin = 'builtin' | 'insurer_directory' | 'owner';
export interface KnowledgeSourceRecord extends SourceView {
  robots: string | null;
  robotsCheckedAt: ISODateTime | null;
  fetchDay: string | null;
  updatedBy: string;
  updatedAt: ISODateTime;
}

export function toKnowledgeSource(r: KnowledgeSourceRow): KnowledgeSourceRecord {
  return {
    domain: r.domain,
    policy: r.policy as SourceView['policy'],
    access: r.access,
    licence: r.licence,
    extractAllowed: Boolean(r.extractAllowed),
    maxQuoteWords: r.maxQuoteWords,
    tags: r.tags ?? [],
    perMinute: r.perMinute,
    perDay: r.perDay,
    enabled: Boolean(r.enabled),
    origin: r.origin as SourceOrigin,
    selftest: r.selftest ?? null,
    lastFetchAt: r.lastFetchAt,
    lastStatus: r.lastStatus,
    fetchesToday: r.fetchesToday,
    robots: r.robots,
    robotsCheckedAt: r.robotsCheckedAt,
    fetchDay: r.fetchDay,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt,
  };
}

export function getKnowledgeSource(db: Db, domain: string): KnowledgeSourceRecord | undefined {
  const r = db.select().from(knowledgeSources).where(eq(knowledgeSources.domain, domain)).get();
  return r ? toKnowledgeSource(r) : undefined;
}

export function listKnowledgeSources(db: Db, f: { origin?: SourceOrigin; enabled?: boolean } = {}): KnowledgeSourceRecord[] {
  const conds: SQL[] = [];
  if (f.origin) conds.push(eq(knowledgeSources.origin, f.origin));
  if (f.enabled !== undefined) conds.push(eq(knowledgeSources.enabled, f.enabled));
  return db
    .select()
    .from(knowledgeSources)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(knowledgeSources.origin), asc(knowledgeSources.domain))
    .all()
    .map(toKnowledgeSource);
}

export interface InsertSourceInput {
  domain: string;
  policy: SourceView['policy'];
  access: string;
  licence: string;
  extractAllowed: boolean;
  maxQuoteWords: number;
  tags: string[];
  perMinute: number;
  perDay: number;
  enabled?: boolean;
  origin: SourceOrigin;
  updatedBy: string;
  at: ISODateTime;
}

/** Insert a source row when absent (an existing row — and the owner's enabled flag — is kept). */
export function ensureKnowledgeSource(db: Db, s: InsertSourceInput): { source: KnowledgeSourceRecord; created: boolean } {
  const existing = getKnowledgeSource(db, s.domain);
  if (existing) return { source: existing, created: false };
  const row = db
    .insert(knowledgeSources)
    .values({
      domain: s.domain,
      policy: s.policy,
      access: s.access,
      licence: s.licence,
      extractAllowed: s.extractAllowed,
      maxQuoteWords: s.maxQuoteWords,
      tags: s.tags,
      perMinute: s.perMinute,
      perDay: s.perDay,
      enabled: s.enabled ?? true,
      origin: s.origin,
      robots: null,
      robotsCheckedAt: null,
      selftest: null,
      lastFetchAt: null,
      lastStatus: null,
      fetchesToday: 0,
      fetchDay: null,
      updatedBy: s.updatedBy,
      updatedAt: s.at,
    })
    .returning()
    .get();
  return { source: toKnowledgeSource(row), created: true };
}

export interface SourcePatch {
  policy?: SourceView['policy'];
  access?: string;
  licence?: string;
  extractAllowed?: boolean;
  maxQuoteWords?: number;
  tags?: string[];
  perMinute?: number;
  perDay?: number;
  enabled?: boolean;
  robots?: string | null;
  robotsCheckedAt?: ISODateTime | null;
  selftest?: unknown;
  lastFetchAt?: ISODateTime | null;
  lastStatus?: number | null;
  fetchesToday?: number;
  fetchDay?: string | null;
  updatedBy: string;
  updatedAt: ISODateTime;
}

export function updateKnowledgeSource(db: Db, domain: string, patch: SourcePatch): KnowledgeSourceRecord {
  const r = db.update(knowledgeSources).set(patch).where(eq(knowledgeSources.domain, domain)).returning().get();
  if (!r) throw new Error(`knowledge source ${domain} not found`);
  return toKnowledgeSource(r);
}

/** Count one fetch against the source's day (London day string), resetting the counter on a new day. */
export function countKnowledgeSourceFetch(db: Db, domain: string, day: string, at: ISODateTime, status: number | null): KnowledgeSourceRecord | undefined {
  const s = getKnowledgeSource(db, domain);
  if (!s) return undefined;
  const fetchesToday = s.fetchDay === day ? s.fetchesToday + 1 : 1;
  return updateKnowledgeSource(db, domain, { fetchesToday, fetchDay: day, lastFetchAt: at, lastStatus: status, updatedBy: s.updatedBy, updatedAt: s.updatedAt });
}

// ---------------------------------------------------------------------------
// Snapshots (append-only)
// ---------------------------------------------------------------------------

export interface SourceSnapshotRecord extends Omit<SnapshotView, 'text' | 'pruned'> {
  storagePath: string;
  textPath: string | null;
  textSha256: string | null;
  jobId: string | null;
  runId: string | null;
  createdBy: string;
}

export function toSourceSnapshot(r: SourceSnapshotRow): SourceSnapshotRecord {
  return {
    id: r.id,
    url: r.url,
    finalUrl: r.finalUrl,
    domain: r.domain,
    fetchedAt: r.fetchedAt,
    httpStatus: r.httpStatus,
    contentType: r.contentType,
    bytes: r.bytes,
    sha256: r.sha256,
    title: r.title,
    licence: r.licence,
    extractAllowed: Boolean(r.extractAllowed),
    previousId: r.previousId,
    changed: Boolean(r.changed),
    injectionFlags: r.injectionFlags ?? [],
    reason: r.reason,
    gapId: r.gapId,
    storagePath: r.storagePath,
    textPath: r.textPath,
    textSha256: r.textSha256,
    jobId: r.jobId,
    runId: r.runId,
    createdBy: r.createdBy,
  };
}

export type InsertSnapshotInput = Omit<SourceSnapshotRecord, 'id'> & { id?: string };

export function insertSourceSnapshot(db: Db, s: InsertSnapshotInput): SourceSnapshotRecord {
  const row = db
    .insert(sourceSnapshots)
    .values({
      id: s.id ?? newId(),
      url: s.url,
      finalUrl: s.finalUrl,
      domain: s.domain,
      fetchedAt: s.fetchedAt,
      httpStatus: s.httpStatus,
      contentType: s.contentType,
      bytes: s.bytes,
      sha256: s.sha256,
      storagePath: s.storagePath,
      textPath: s.textPath,
      textSha256: s.textSha256,
      title: s.title,
      licence: s.licence,
      extractAllowed: s.extractAllowed,
      previousId: s.previousId,
      changed: s.changed,
      injectionFlags: s.injectionFlags,
      reason: s.reason,
      gapId: s.gapId,
      jobId: s.jobId,
      runId: s.runId,
      createdBy: s.createdBy,
    })
    .returning()
    .get();
  return toSourceSnapshot(row);
}

export function getSourceSnapshot(db: Db, id: string): SourceSnapshotRecord | undefined {
  const r = db.select().from(sourceSnapshots).where(eq(sourceSnapshots.id, id)).get();
  return r ? toSourceSnapshot(r) : undefined;
}

/** The newest snapshot of `url`, if any. */
export function latestSourceSnapshot(db: Db, url: string): SourceSnapshotRecord | undefined {
  const r = db.select().from(sourceSnapshots).where(eq(sourceSnapshots.url, url)).orderBy(desc(sourceSnapshots.fetchedAt), desc(sourceSnapshots.id)).limit(1).get();
  return r ? toSourceSnapshot(r) : undefined;
}

export function listSourceSnapshots(db: Db, f: { url?: string; domain?: string; gapId?: string; since?: ISODateTime; limit?: number } = {}): SourceSnapshotRecord[] {
  const conds: SQL[] = [];
  if (f.url) conds.push(eq(sourceSnapshots.url, f.url));
  if (f.domain) conds.push(eq(sourceSnapshots.domain, f.domain));
  if (f.gapId) conds.push(eq(sourceSnapshots.gapId, f.gapId));
  if (f.since) conds.push(sql`${sourceSnapshots.fetchedAt} >= ${f.since}`);
  return db
    .select()
    .from(sourceSnapshots)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(sourceSnapshots.fetchedAt), desc(sourceSnapshots.id))
    .limit(Math.max(1, Math.min(f.limit ?? 100, 2000)))
    .all()
    .map(toSourceSnapshot);
}

/** Successful snapshots fetched since `since` (the per-day budget and per-minute bucket count these). */
export function countSourceSnapshotsSince(db: Db, since: ISODateTime, domain?: string): number {
  const conds: SQL[] = [sql`${sourceSnapshots.fetchedAt} >= ${since}`];
  if (domain) conds.push(eq(sourceSnapshots.domain, domain));
  return Number(db.select({ c: sql<number>`count(*)` }).from(sourceSnapshots).where(and(...conds)).get()?.c ?? 0);
}
