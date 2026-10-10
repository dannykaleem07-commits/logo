// owned by knowledge-core
/**
 * Knowledge store persistence (docs/SUPREME-KNOWLEDGE-BUILDER.md §4, §5): items (versioned, content-immutable; FTS5
 * `knowledge_fts` read with raw SQL), checks (append-only; DB triggers refuse automated verification), changes
 * (append-only audit of every knowledge write), learned-pack versions/members/state, conflicts, insurer links and the
 * knowledge settings row. Business rules (decisions, who may approve) live in apps/api/src/knowledge/store.ts; these
 * functions only read and write rows. Private: rows live only in the owner's DATA_DIR database.
 */
import { and, asc, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type {
  ConflictFinding,
  ISODateTime,
  KnowledgeArea,
  KnowledgeCheck,
  KnowledgeConflict,
  KnowledgeDecision,
  KnowledgeHealth,
  KnowledgeItem,
  KnowledgeKind,
  KnowledgeProvenance,
  KnowledgeScope,
  KnowledgeStatus,
  KnowledgeVerification,
} from '@ccguk/domain';
import type { Db } from '../client.js';
import {
  insurerLinks,
  knowledgeChanges,
  knowledgeChecks,
  knowledgeConflicts,
  knowledgeItems,
  knowledgePackMembers,
  knowledgePackState,
  knowledgePackVersions,
  knowledgeSettings,
  type InsurerLinkRow,
  type KnowledgeChangeRow,
  type KnowledgeCheckRow,
  type KnowledgeConflictRow,
  type KnowledgeItemRow,
  type KnowledgePackVersionRow,
} from '../schema.js';
import { newId } from '../util.js';
import { ftsQuery } from './brain.js';

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const scopeOf = (kind: string, value: string | null): KnowledgeScope =>
  kind === 'insurer' && value ? { kind: 'insurer', slug: value } : kind === 'claim_type' && value ? { kind: 'claim_type', tag: value as never } : { kind: 'global' };

export function scopeColumns(scope: KnowledgeScope): { scopeKind: string; scopeValue: string | null } {
  return scope.kind === 'insurer' ? { scopeKind: 'insurer', scopeValue: scope.slug } : scope.kind === 'claim_type' ? { scopeKind: 'claim_type', scopeValue: scope.tag } : { scopeKind: 'global', scopeValue: null };
}

export function toKnowledgeItem(r: KnowledgeItemRow): KnowledgeItem {
  return {
    id: r.id,
    itemKey: r.itemKey,
    version: r.version,
    kind: r.kind as KnowledgeKind,
    area: r.area as KnowledgeArea,
    title: r.title,
    body: r.body,
    data: r.data as KnowledgeItem['data'],
    tags: r.tags ?? [],
    scope: scopeOf(r.scopeKind, r.scopeValue),
    business: (r.business ?? ['ccguk']) as KnowledgeItem['business'],
    useLimit: r.useLimit as KnowledgeItem['useLimit'],
    origin: r.origin as KnowledgeItem['origin'],
    verification: r.verification as KnowledgeVerification,
    lastCheckId: r.lastCheckId,
    confidence: r.confidence,
    supportN: r.supportN,
    status: r.status as KnowledgeStatus,
    health: r.health as KnowledgeHealth,
    validFrom: r.validFrom,
    validTo: r.validTo,
    reviewBy: r.reviewBy,
    provenance: (r.provenance ?? []) as KnowledgeProvenance[],
    supersedesId: r.supersedesId,
    gapId: r.gapId,
    contentSha256: r.contentSha256,
    autonomy: r.autonomy as KnowledgeDecision,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    originJobId: r.originJobId,
    originRunId: r.originRunId,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    needsYouId: r.needsYouId,
    updatedAt: r.updatedAt,
  };
}

/** Insert a new item version. `verification` is always 'unverified' on insert (KR-1; the DB refuses anything else). */
export function insertKnowledgeItem(db: Db, item: Omit<KnowledgeItem, 'verification' | 'lastCheckId'> & { verification?: 'unverified' }): KnowledgeItem {
  const row = db
    .insert(knowledgeItems)
    .values({
      id: item.id,
      itemKey: item.itemKey,
      version: item.version,
      kind: item.kind,
      area: item.area,
      title: item.title,
      body: item.body,
      data: item.data as unknown,
      tags: item.tags,
      ...scopeColumns(item.scope),
      business: item.business,
      useLimit: item.useLimit,
      origin: item.origin,
      verification: 'unverified',
      lastCheckId: null,
      confidence: item.confidence,
      supportN: item.supportN,
      status: item.status,
      health: item.health,
      validFrom: item.validFrom,
      validTo: item.validTo,
      reviewBy: item.reviewBy,
      provenance: item.provenance,
      supersedesId: item.supersedesId,
      gapId: item.gapId,
      contentSha256: item.contentSha256,
      autonomy: item.autonomy,
      createdBy: item.createdBy,
      createdAt: item.createdAt,
      originJobId: item.originJobId,
      originRunId: item.originRunId,
      decidedBy: item.decidedBy,
      decidedAt: item.decidedAt,
      decisionNote: item.decisionNote,
      needsYouId: item.needsYouId,
      updatedAt: item.updatedAt,
    })
    .returning()
    .get();
  return toKnowledgeItem(row);
}

export function getKnowledgeItem(db: Db, id: string): KnowledgeItem | undefined {
  const r = db.select().from(knowledgeItems).where(eq(knowledgeItems.id, id)).get();
  return r ? toKnowledgeItem(r) : undefined;
}

export function getKnowledgeItems(db: Db, ids: readonly string[]): KnowledgeItem[] {
  if (!ids.length) return [];
  const out: KnowledgeItem[] = [];
  for (let i = 0; i < ids.length; i += 500) out.push(...db.select().from(knowledgeItems).where(inArray(knowledgeItems.id, ids.slice(i, i + 500) as string[])).all().map(toKnowledgeItem));
  return out;
}

/** Every version of an item key, newest first. */
export function listKnowledgeItemVersions(db: Db, itemKey: string): KnowledgeItem[] {
  return db.select().from(knowledgeItems).where(eq(knowledgeItems.itemKey, itemKey)).orderBy(desc(knowledgeItems.version)).all().map(toKnowledgeItem);
}

export function latestKnowledgeVersion(db: Db, itemKey: string): KnowledgeItem | undefined {
  const r = db.select().from(knowledgeItems).where(eq(knowledgeItems.itemKey, itemKey)).orderBy(desc(knowledgeItems.version)).limit(1).get();
  return r ? toKnowledgeItem(r) : undefined;
}

export function activeKnowledgeByKey(db: Db, itemKey: string): KnowledgeItem | undefined {
  const r = db.select().from(knowledgeItems).where(and(eq(knowledgeItems.itemKey, itemKey), eq(knowledgeItems.status, 'active'))).get();
  return r ? toKnowledgeItem(r) : undefined;
}

export interface ListKnowledgeItemsFilter {
  status?: KnowledgeStatus | readonly KnowledgeStatus[];
  kind?: KnowledgeKind | readonly KnowledgeKind[];
  area?: KnowledgeArea;
  scopeKind?: 'global' | 'insurer' | 'claim_type';
  scopeValue?: string;
  verification?: KnowledgeVerification;
  origin?: string | readonly string[];
  needsYouId?: string;
  /** free text over title/body/tags (FTS5) */
  q?: string;
  limit?: number;
  offset?: number;
}

function itemConditions(f: ListKnowledgeItemsFilter): SQL[] {
  const conds: SQL[] = [];
  const many = <T extends string>(v: T | readonly T[] | undefined): T[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? [...(v as T[])] : [v as T]);
  const statuses = many(f.status);
  if (statuses?.length) conds.push(inArray(knowledgeItems.status, statuses));
  const kinds = many(f.kind);
  if (kinds?.length) conds.push(inArray(knowledgeItems.kind, kinds));
  if (f.area) conds.push(eq(knowledgeItems.area, f.area));
  if (f.scopeKind) conds.push(eq(knowledgeItems.scopeKind, f.scopeKind));
  if (f.scopeValue !== undefined) conds.push(eq(knowledgeItems.scopeValue, f.scopeValue));
  if (f.verification) conds.push(eq(knowledgeItems.verification, f.verification));
  const origins = many(f.origin as string | readonly string[] | undefined);
  if (origins?.length) conds.push(inArray(knowledgeItems.origin, origins));
  if (f.needsYouId) conds.push(eq(knowledgeItems.needsYouId, f.needsYouId));
  return conds;
}

/** Items matching the filter, newest first (FTS-ranked when `q` is given). */
export function listKnowledgeItems(db: Db, f: ListKnowledgeItemsFilter = {}): { items: KnowledgeItem[]; total: number } {
  const conds = itemConditions(f);
  const limit = Math.max(1, Math.min(f.limit ?? 100, 1000));
  const offset = Math.max(0, f.offset ?? 0);
  if (f.q && f.q.trim()) {
    const match = ftsQuery(f.q);
    if (!match) return { items: [], total: 0 };
    const where = conds.length ? sql` AND ${and(...conds)}` : sql``;
    const rows = db.all<{ rowid_key: number }>(sql`
      SELECT knowledge_items.rowid_key AS rowid_key FROM knowledge_fts JOIN knowledge_items ON knowledge_items.rowid_key = knowledge_fts.rowid
      WHERE knowledge_fts MATCH ${match}${where}
      ORDER BY bm25(knowledge_fts), knowledge_items.rowid_key DESC`);
    const page = rows.slice(offset, offset + limit).map((r) => r.rowid_key);
    if (!page.length) return { items: [], total: rows.length };
    const byKey = new Map(db.select().from(knowledgeItems).where(inArray(knowledgeItems.rowidKey, page)).all().map((r) => [r.rowidKey, toKnowledgeItem(r)] as const));
    return { items: page.flatMap((k) => (byKey.get(k) ? [byKey.get(k)!] : [])), total: rows.length };
  }
  const where = conds.length ? and(...conds) : undefined;
  const total = Number(db.select({ n: sql<number>`count(*)` }).from(knowledgeItems).where(where).get()?.n ?? 0);
  const items = db.select().from(knowledgeItems).where(where).orderBy(desc(knowledgeItems.createdAt), desc(knowledgeItems.rowidKey)).limit(limit).offset(offset).all().map(toKnowledgeItem);
  return { items, total };
}

export function countKnowledgeItems(db: Db, f: ListKnowledgeItemsFilter = {}): number {
  const conds = itemConditions(f);
  return Number(db.select({ n: sql<number>`count(*)` }).from(knowledgeItems).where(conds.length ? and(...conds) : undefined).get()?.n ?? 0);
}

export interface KnowledgeItemStatePatch {
  status?: KnowledgeStatus;
  health?: KnowledgeHealth;
  /** only with `lastCheckId` naming a human check on this item with the same result (DB trigger) */
  verification?: KnowledgeVerification;
  lastCheckId?: string | null;
  decidedBy?: string | null;
  decidedAt?: ISODateTime | null;
  decisionNote?: string | null;
  needsYouId?: string | null;
  /** the decision record (re-decided when a held item is proposed again) — not content */
  autonomy?: KnowledgeDecision;
  updatedAt: ISODateTime;
}

/** Update the mutable columns of an item (status, health, verification via a check, decision, card link). */
export function updateKnowledgeItemState(db: Db, id: string, patch: KnowledgeItemStatePatch): KnowledgeItem {
  const set: Partial<typeof knowledgeItems.$inferInsert> = { updatedAt: patch.updatedAt };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.health !== undefined) set.health = patch.health;
  if (patch.lastCheckId !== undefined) set.lastCheckId = patch.lastCheckId;
  if (patch.verification !== undefined) set.verification = patch.verification;
  if (patch.decidedBy !== undefined) set.decidedBy = patch.decidedBy;
  if (patch.decidedAt !== undefined) set.decidedAt = patch.decidedAt;
  if (patch.decisionNote !== undefined) set.decisionNote = patch.decisionNote;
  if (patch.needsYouId !== undefined) set.needsYouId = patch.needsYouId;
  if (patch.autonomy !== undefined) set.autonomy = patch.autonomy;
  const r = db.update(knowledgeItems).set(set).where(eq(knowledgeItems.id, id)).returning().get();
  if (!r) throw new Error(`knowledge item ${id} not found`);
  return toKnowledgeItem(r);
}

/** Active items, optionally excluding an origin (learned-pack members exclude `computed`). Ordered by item key. */
export function listActiveKnowledge(db: Db, opts: { excludeOrigin?: string; kinds?: readonly KnowledgeKind[] } = {}): KnowledgeItem[] {
  const conds: SQL[] = [eq(knowledgeItems.status, 'active')];
  if (opts.excludeOrigin) conds.push(sql`${knowledgeItems.origin} <> ${opts.excludeOrigin}`);
  if (opts.kinds?.length) conds.push(inArray(knowledgeItems.kind, [...opts.kinds]));
  return db.select().from(knowledgeItems).where(and(...conds)).orderBy(asc(knowledgeItems.itemKey)).all().map(toKnowledgeItem);
}

/** Rebuild the knowledge FTS index (repair after a restore; the triggers keep it current otherwise). */
export function rebuildKnowledgeFts(db: Db): void {
  db.run(sql`INSERT INTO knowledge_fts(knowledge_fts) VALUES ('rebuild')`);
}

// ---------------------------------------------------------------------------
// Checks (append-only)
// ---------------------------------------------------------------------------

const toCheck = (r: KnowledgeCheckRow): KnowledgeCheck => ({
  id: r.id,
  target: r.target as KnowledgeCheck['target'],
  result: r.result as KnowledgeCheck['result'],
  method: r.method as KnowledgeCheck['method'],
  snapshotId: r.snapshotId,
  sourceUrl: r.sourceUrl,
  quote: r.quote,
  quoteMatch: r.quoteMatch as KnowledgeCheck['quoteMatch'],
  note: r.note,
  checkedBy: r.checkedBy,
  checkedAt: r.checkedAt,
  needsYouId: r.needsYouId,
});

/** Insert a check. The DB refuses owner_confirmed / source_verified / failed from `system` or `agent:*` (KR-1). */
export function insertKnowledgeCheck(db: Db, input: Omit<KnowledgeCheck, 'id'> & { id?: string }): KnowledgeCheck {
  const row = db
    .insert(knowledgeChecks)
    .values({ ...input, id: input.id ?? newId() })
    .returning()
    .get();
  return toCheck(row);
}

export function getKnowledgeCheck(db: Db, id: string): KnowledgeCheck | undefined {
  const r = db.select().from(knowledgeChecks).where(eq(knowledgeChecks.id, id)).get();
  return r ? toCheck(r) : undefined;
}

/** Checks on the given targets (`item:<id>` / `kb:<entryId>`), oldest first. */
export function listKnowledgeChecks(db: Db, targets: readonly string[]): KnowledgeCheck[] {
  if (!targets.length) return [];
  return db.select().from(knowledgeChecks).where(inArray(knowledgeChecks.target, [...targets])).orderBy(asc(knowledgeChecks.checkedAt), asc(knowledgeChecks.id)).all().map(toCheck);
}

/** Every KB-overlay check (target `kb:*`), oldest first — the overlay reads the latest per entry. */
export function listKbChecks(db: Db): KnowledgeCheck[] {
  return db.select().from(knowledgeChecks).where(sql`${knowledgeChecks.target} LIKE 'kb:%'`).orderBy(asc(knowledgeChecks.checkedAt), asc(knowledgeChecks.id)).all().map(toCheck);
}

// ---------------------------------------------------------------------------
// Changes (append-only)
// ---------------------------------------------------------------------------

export interface KnowledgeChangeRecord {
  id: string;
  at: ISODateTime;
  actor: string;
  action: string;
  itemId: string | null;
  itemKey: string | null;
  gapId: string | null;
  packVersion: number | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  ruleIds: string[];
  runId: string | null;
  jobId: string | null;
  needsYouId: string | null;
}

const toChange = (r: KnowledgeChangeRow): KnowledgeChangeRecord => ({
  id: r.id,
  at: r.at,
  actor: r.actor,
  action: r.action,
  itemId: r.itemId,
  itemKey: r.itemKey,
  gapId: r.gapId,
  packVersion: r.packVersion,
  before: r.before ?? null,
  after: r.after ?? null,
  reason: r.reason,
  ruleIds: r.ruleIds ?? [],
  runId: r.runId,
  jobId: r.jobId,
  needsYouId: r.needsYouId,
});

export type AppendKnowledgeChangeInput = Partial<Omit<KnowledgeChangeRecord, 'at' | 'actor' | 'action'>> & Pick<KnowledgeChangeRecord, 'at' | 'actor' | 'action'>;

export function appendKnowledgeChange(db: Db, input: AppendKnowledgeChangeInput): KnowledgeChangeRecord {
  const row = db
    .insert(knowledgeChanges)
    .values({
      id: input.id ?? newId(),
      at: input.at,
      actor: input.actor,
      action: input.action,
      itemId: input.itemId ?? null,
      itemKey: input.itemKey ?? null,
      gapId: input.gapId ?? null,
      packVersion: input.packVersion ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      reason: input.reason ?? null,
      ruleIds: input.ruleIds ?? [],
      runId: input.runId ?? null,
      jobId: input.jobId ?? null,
      needsYouId: input.needsYouId ?? null,
    })
    .returning()
    .get();
  return toChange(row);
}

export interface ListKnowledgeChangesFilter {
  since?: ISODateTime;
  until?: ISODateTime;
  actor?: string;
  action?: string | readonly string[];
  /** action prefix, e.g. `knowledge.item.` */
  actionPrefix?: string;
  itemKey?: string;
  itemId?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

export function listKnowledgeChanges(db: Db, f: ListKnowledgeChangesFilter = {}): KnowledgeChangeRecord[] {
  const conds: SQL[] = [];
  if (f.since) conds.push(gte(knowledgeChanges.at, f.since));
  if (f.until) conds.push(lt(knowledgeChanges.at, f.until));
  if (f.actor) conds.push(eq(knowledgeChanges.actor, f.actor));
  if (f.action) conds.push(Array.isArray(f.action) ? inArray(knowledgeChanges.action, [...(f.action as string[])]) : eq(knowledgeChanges.action, f.action as string));
  if (f.actionPrefix) conds.push(sql`${knowledgeChanges.action} LIKE ${`${f.actionPrefix.replace(/[%_]/g, '')}%`}`);
  if (f.itemKey) conds.push(eq(knowledgeChanges.itemKey, f.itemKey));
  if (f.itemId) conds.push(eq(knowledgeChanges.itemId, f.itemId));
  const order = f.order === 'asc' ? [asc(knowledgeChanges.at), asc(knowledgeChanges.id)] : [desc(knowledgeChanges.at), desc(knowledgeChanges.id)];
  return db
    .select()
    .from(knowledgeChanges)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(...order)
    .limit(Math.max(1, Math.min(f.limit ?? 500, 5000)))
    .all()
    .map(toChange);
}

// ---------------------------------------------------------------------------
// Learned-pack versions (append-only versions and members; state is one row)
// ---------------------------------------------------------------------------

export interface KnowledgePackVersionRecord {
  version: number;
  label: string;
  itemsSha256: string;
  itemCount: number;
  diff: unknown;
  reason: string;
  basedOnVersion: number | null;
  rollbackOf: number | null;
  replayRunId: string | null;
  createdBy: string;
  createdAt: ISODateTime;
}

const toVersion = (r: KnowledgePackVersionRow): KnowledgePackVersionRecord => ({ ...r, diff: r.diff });

export function insertKnowledgePackVersion(db: Db, v: KnowledgePackVersionRecord, memberIds: readonly string[]): KnowledgePackVersionRecord {
  const row = db.insert(knowledgePackVersions).values(v).returning().get();
  const unique = [...new Set(memberIds)];
  for (let i = 0; i < unique.length; i += 400) {
    const chunk = unique.slice(i, i + 400);
    if (chunk.length) db.insert(knowledgePackMembers).values(chunk.map((itemId) => ({ version: v.version, itemId }))).run();
  }
  return toVersion(row);
}

export function getKnowledgePackVersion(db: Db, version: number): KnowledgePackVersionRecord | undefined {
  const r = db.select().from(knowledgePackVersions).where(eq(knowledgePackVersions.version, version)).get();
  return r ? toVersion(r) : undefined;
}

export function listKnowledgePackVersions(db: Db): KnowledgePackVersionRecord[] {
  return db.select().from(knowledgePackVersions).orderBy(desc(knowledgePackVersions.version)).all().map(toVersion);
}

export function latestKnowledgePackVersion(db: Db): number {
  return Number(db.select({ v: sql<number>`coalesce(max(${knowledgePackVersions.version}), 0)` }).from(knowledgePackVersions).get()?.v ?? 0);
}

export function listKnowledgePackMembers(db: Db, version: number): string[] {
  return db.select({ itemId: knowledgePackMembers.itemId }).from(knowledgePackMembers).where(eq(knowledgePackMembers.version, version)).orderBy(asc(knowledgePackMembers.itemId)).all().map((r) => r.itemId);
}

export interface KnowledgePackState {
  activeVersion: number | null;
  activatedBy: string | null;
  activatedAt: ISODateTime | null;
}

export function getKnowledgePackState(db: Db): KnowledgePackState {
  const r = db.select().from(knowledgePackState).where(eq(knowledgePackState.id, 'default')).get();
  return { activeVersion: r?.activeVersion ?? null, activatedBy: r?.activatedBy ?? null, activatedAt: r?.activatedAt ?? null };
}

export function setKnowledgePackState(db: Db, state: { activeVersion: number; activatedBy: string; activatedAt: ISODateTime }): void {
  db.insert(knowledgePackState)
    .values({ id: 'default', ...state })
    .onConflictDoUpdate({ target: knowledgePackState.id, set: state })
    .run();
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

const toConflict = (r: KnowledgeConflictRow): KnowledgeConflict => ({
  id: r.id,
  kind: r.kind as KnowledgeConflict['kind'],
  leftRef: r.leftRef,
  rightRef: r.rightRef,
  detail: r.detail,
  detectedBy: r.detectedBy,
  status: r.status as KnowledgeConflict['status'],
  resolution: r.resolution,
  needsYouId: r.needsYouId,
  createdAt: r.createdAt,
  resolvedBy: r.resolvedBy,
  resolvedAt: r.resolvedAt,
});

/** Record a conflict; an identical open one (same refs and kind) is returned instead (`created: false`). */
export function openKnowledgeConflict(db: Db, f: ConflictFinding & { detectedBy: string; at: ISODateTime }): { conflict: KnowledgeConflict; created: boolean } {
  const existing = db
    .select()
    .from(knowledgeConflicts)
    .where(and(eq(knowledgeConflicts.leftRef, f.leftRef), eq(knowledgeConflicts.rightRef, f.rightRef), eq(knowledgeConflicts.kind, f.kind), eq(knowledgeConflicts.status, 'open')))
    .get();
  if (existing) return { conflict: toConflict(existing), created: false };
  const row = db
    .insert(knowledgeConflicts)
    .values({ id: newId(), kind: f.kind, leftRef: f.leftRef, rightRef: f.rightRef, detail: f.detail.slice(0, 2000), detectedBy: f.detectedBy, status: 'open', resolution: null, needsYouId: null, createdAt: f.at, resolvedBy: null, resolvedAt: null })
    .returning()
    .get();
  return { conflict: toConflict(row), created: true };
}

export function getKnowledgeConflict(db: Db, id: string): KnowledgeConflict | undefined {
  const r = db.select().from(knowledgeConflicts).where(eq(knowledgeConflicts.id, id)).get();
  return r ? toConflict(r) : undefined;
}

export function listKnowledgeConflicts(db: Db, f: { status?: KnowledgeConflict['status'] | 'all'; ref?: string; limit?: number } = {}): KnowledgeConflict[] {
  const conds: SQL[] = [];
  if (f.status && f.status !== 'all') conds.push(eq(knowledgeConflicts.status, f.status));
  if (f.ref) conds.push(or(eq(knowledgeConflicts.leftRef, f.ref), eq(knowledgeConflicts.rightRef, f.ref))!);
  return db
    .select()
    .from(knowledgeConflicts)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(knowledgeConflicts.createdAt), desc(knowledgeConflicts.id))
    .limit(Math.max(1, Math.min(f.limit ?? 500, 5000)))
    .all()
    .map(toConflict);
}

export function updateKnowledgeConflict(db: Db, id: string, patch: { status?: KnowledgeConflict['status']; resolution?: string | null; needsYouId?: string | null; resolvedBy?: string | null; resolvedAt?: ISODateTime | null }): KnowledgeConflict {
  const r = db.update(knowledgeConflicts).set(patch).where(eq(knowledgeConflicts.id, id)).returning().get();
  if (!r) throw new Error(`knowledge conflict ${id} not found`);
  return toConflict(r);
}

// ---------------------------------------------------------------------------
// Insurer links (party → directory slug)
// ---------------------------------------------------------------------------

export type InsurerLinkMethod = 'exact_name' | 'brand' | 'email_domain' | 'owner';
export interface InsurerLinkRecord {
  partyId: string;
  insurerSlug: string;
  method: InsurerLinkMethod;
  confidence: number;
  decidedBy: string;
  decidedAt: ISODateTime;
}
const toLink = (r: InsurerLinkRow): InsurerLinkRecord => ({ ...r, method: r.method as InsurerLinkMethod });

export function getInsurerLink(db: Db, partyId: string): InsurerLinkRecord | undefined {
  const r = db.select().from(insurerLinks).where(eq(insurerLinks.partyId, partyId)).get();
  return r ? toLink(r) : undefined;
}

export function listInsurerLinks(db: Db, f: { insurerSlug?: string } = {}): InsurerLinkRecord[] {
  return db
    .select()
    .from(insurerLinks)
    .where(f.insurerSlug ? eq(insurerLinks.insurerSlug, f.insurerSlug) : undefined)
    .orderBy(asc(insurerLinks.insurerSlug), asc(insurerLinks.partyId))
    .all()
    .map(toLink);
}

/** Insert or replace a link row (the API store decides whether an owner link may be replaced). */
export function putInsurerLink(db: Db, link: InsurerLinkRecord): InsurerLinkRecord {
  const row = db
    .insert(insurerLinks)
    .values(link)
    .onConflictDoUpdate({ target: insurerLinks.partyId, set: { insurerSlug: link.insurerSlug, method: link.method, confidence: link.confidence, decidedBy: link.decidedBy, decidedAt: link.decidedAt } })
    .returning()
    .get();
  return toLink(row);
}

// ---------------------------------------------------------------------------
// Settings row (merged over DEFAULT_KNOWLEDGE_SETTINGS by the API)
// ---------------------------------------------------------------------------

export function getStoredKnowledgeSettings(db: Db): { settings: unknown; updatedAt: ISODateTime; updatedBy: string } | undefined {
  const r = db.select().from(knowledgeSettings).where(eq(knowledgeSettings.id, 'default')).get();
  return r ? { settings: r.settings, updatedAt: r.updatedAt, updatedBy: r.updatedBy } : undefined;
}

export function putStoredKnowledgeSettings(db: Db, settings: unknown, by: string, at: ISODateTime): void {
  db.insert(knowledgeSettings)
    .values({ id: 'default', settings, updatedAt: at, updatedBy: by })
    .onConflictDoUpdate({ target: knowledgeSettings.id, set: { settings, updatedAt: at, updatedBy: by } })
    .run();
}
