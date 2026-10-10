// owned by casework
/**
 * Brain packs, versions and entries (docs/SUPREME-DESIGN.md §E.4, §E.5, §N.4) and the claim corpus `search_docs`.
 *
 *  - `brain_packs`: one row per pack id; `active_version` decides which version retrieval reads (rollback = point it
 *    at an older version). Business tags, precedence and "use for CCGUK" are the owner's choices at activation.
 *  - `brain_pack_versions` + `brain_entries`: written once per imported version (versions sit side by side; entries of a
 *    version are never edited — a new version is a new import).
 *  - `brain_fts` is an external-content FTS5 index over `brain_entries`, kept in sync by the 0011 triggers; it is read
 *    with raw SQL here (FTS5 tables are not declared in schema.ts).
 *  - `search_docs` (FTS5, contentless-style rows keyed by source) holds email / document / evidence text / transcript /
 *    note text per claim for retrieval (`index.fts`).
 *
 * Private pack content lives only in the owner's DATA_DIR (the database and `brain/packs/`); nothing here ships in the
 * repo.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { BrainEntryKind, BrainPackKind, ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { brainEntries, brainPacks, brainPackVersions, type BrainEntryRow, type BrainPackRow, type BrainPackVersionRow } from '../schema.js';
import { denull, nowIso } from '../util.js';

export type BrainBusiness = 'ccguk' | 'fixmyfile';

export interface BrainPackRecord {
  id: string;
  name: string;
  kind: BrainPackKind;
  activeVersion?: string;
  business: string[];
  precedence: number;
  useForCcguk: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface BrainPackVersionRecord {
  packId: string;
  version: string;
  sha256: string;
  source: string;
  storagePath: string;
  manifest: unknown;
  entries: number;
  importedBy: string;
  importedAt: ISODateTime;
}

export interface BrainEntryRecord {
  rowidKey: number;
  id: string;
  packId: string;
  version: string;
  kind: BrainEntryKind | string;
  title: string;
  body: string;
  tags: string;
  /** The entry's own business tags; empty = inherit the pack's. */
  business: string[];
  data: unknown;
  verification?: string;
}

const toPack = (r: BrainPackRow): BrainPackRecord => denull(r) as BrainPackRecord;
const toVersion = (r: BrainPackVersionRow): BrainPackVersionRecord => ({ ...(denull(r) as BrainPackVersionRecord), manifest: r.manifest ?? null });
const toEntry = (r: BrainEntryRow): BrainEntryRecord => ({ ...(denull(r) as BrainEntryRecord), data: r.data ?? null });

// ---------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------

export function getBrainPack(db: Db, id: string): BrainPackRecord | undefined {
  const r = db.select().from(brainPacks).where(eq(brainPacks.id, id)).get();
  return r ? toPack(r) : undefined;
}

export function requireBrainPack(db: Db, id: string): BrainPackRecord {
  const p = getBrainPack(db, id);
  if (!p) throw new NotFoundError('brain_packs', id);
  return p;
}

/** Packs ordered by precedence (lower number = higher authority), then id. */
export function listBrainPacks(db: Db): BrainPackRecord[] {
  return db.select().from(brainPacks).orderBy(asc(brainPacks.precedence), asc(brainPacks.id)).all().map(toPack);
}

export interface EnsureBrainPackInput {
  id: string;
  name: string;
  kind: BrainPackKind;
  business: string[];
  precedence: number;
  /** "Use this pack's strategy for CCGUK claims" (§E.1) — off until the owner ticks it. */
  useForCcguk?: boolean;
  now?: ISODateTime;
}

/** Create the pack row if it does not exist (an existing row keeps the owner's choices); returns it. */
export function ensureBrainPack(db: Db, input: EnsureBrainPackInput): BrainPackRecord {
  const existing = getBrainPack(db, input.id);
  if (existing) return existing;
  const now = input.now ?? nowIso();
  const row = {
    id: input.id,
    name: input.name,
    kind: input.kind,
    activeVersion: null,
    business: [...input.business],
    precedence: Math.round(input.precedence),
    useForCcguk: input.useForCcguk ?? false,
    createdAt: now,
    updatedAt: now,
  };
  return toPack(db.insert(brainPacks).values(row).returning().get());
}

export interface UpdateBrainPackInput {
  name?: string;
  kind?: BrainPackKind;
  business?: string[];
  precedence?: number;
  useForCcguk?: boolean;
  /** `null` deactivates the pack (retrieval ignores it). */
  activeVersion?: string | null;
  now?: ISODateTime;
}

export function updateBrainPack(db: Db, id: string, input: UpdateBrainPackInput): BrainPackRecord {
  requireBrainPack(db, id);
  if (input.activeVersion) requireBrainPackVersion(db, id, input.activeVersion);
  if (input.precedence !== undefined && !Number.isFinite(input.precedence)) throw new ValidationError('precedence must be a number');
  const set: Partial<typeof brainPacks.$inferInsert> = { updatedAt: input.now ?? nowIso() };
  if (input.name !== undefined) set.name = input.name;
  if (input.kind !== undefined) set.kind = input.kind;
  if (input.business !== undefined) set.business = [...input.business];
  if (input.precedence !== undefined) set.precedence = Math.round(input.precedence);
  if (input.useForCcguk !== undefined) set.useForCcguk = input.useForCcguk;
  if (input.activeVersion !== undefined) set.activeVersion = input.activeVersion;
  return toPack(db.update(brainPacks).set(set).where(eq(brainPacks.id, id)).returning().get()!);
}

// ---------------------------------------------------------------------------
// Versions and entries
// ---------------------------------------------------------------------------

export function getBrainPackVersion(db: Db, packId: string, version: string): BrainPackVersionRecord | undefined {
  const r = db.select().from(brainPackVersions).where(and(eq(brainPackVersions.packId, packId), eq(brainPackVersions.version, version))).get();
  return r ? toVersion(r) : undefined;
}

export function requireBrainPackVersion(db: Db, packId: string, version: string): BrainPackVersionRecord {
  const v = getBrainPackVersion(db, packId, version);
  if (!v) throw new NotFoundError('brain_pack_versions', `${packId}@${version}`);
  return v;
}

/** Versions of a pack, newest import first. */
export function listBrainPackVersions(db: Db, packId: string): BrainPackVersionRecord[] {
  return db.select().from(brainPackVersions).where(eq(brainPackVersions.packId, packId)).orderBy(desc(brainPackVersions.importedAt), desc(brainPackVersions.version)).all().map(toVersion);
}

export function findBrainPackVersionBySha(db: Db, sha256: string): BrainPackVersionRecord | undefined {
  const r = db.select().from(brainPackVersions).where(eq(brainPackVersions.sha256, sha256)).get();
  return r ? toVersion(r) : undefined;
}

export interface NewBrainEntry {
  id: string;
  kind: string;
  title: string;
  body: string;
  tags: string[];
  business: string[];
  data: unknown;
  verification?: string | null;
}

export interface InsertBrainPackVersionInput {
  packId: string;
  version: string;
  sha256: string;
  source: string;
  storagePath: string;
  manifest: unknown;
  importedBy: string;
  entries: NewBrainEntry[];
  now?: ISODateTime;
}

/** Store one imported version with all its entries (the FTS index follows through the triggers). */
export function insertBrainPackVersion(db: Db, input: InsertBrainPackVersionInput): BrainPackVersionRecord {
  requireBrainPack(db, input.packId);
  if (getBrainPackVersion(db, input.packId, input.version)) throw new ValidationError(`Brain pack ${input.packId} already has version ${input.version}; give the new import a new version`);
  const ids = new Set<string>();
  for (const e of input.entries) {
    if (!e.id.trim()) throw new ValidationError('brain entry id is required');
    if (ids.has(e.id)) throw new ValidationError(`duplicate brain entry id ${e.id}`);
    ids.add(e.id);
  }
  const now = input.now ?? nowIso();
  const v = db
    .insert(brainPackVersions)
    .values({ packId: input.packId, version: input.version, sha256: input.sha256, source: input.source, storagePath: input.storagePath, manifest: input.manifest ?? {}, entries: input.entries.length, importedBy: input.importedBy, importedAt: now })
    .returning()
    .get();
  for (const e of input.entries) {
    db.insert(brainEntries)
      .values({ id: e.id, packId: input.packId, version: input.version, kind: e.kind, title: e.title, body: e.body, tags: e.tags.join(' '), business: [...e.business], data: e.data ?? {}, verification: e.verification ?? null })
      .run();
  }
  return toVersion(v);
}

export interface ListBrainEntriesFilter {
  packId: string;
  version: string;
  kinds?: readonly string[];
  limit?: number;
  offset?: number;
}

export function listBrainEntries(db: Db, f: ListBrainEntriesFilter): BrainEntryRecord[] {
  const where = [eq(brainEntries.packId, f.packId), eq(brainEntries.version, f.version)];
  if (f.kinds?.length) where.push(inArray(brainEntries.kind, [...f.kinds]));
  return db
    .select()
    .from(brainEntries)
    .where(and(...where))
    .orderBy(asc(brainEntries.rowidKey))
    .limit(Math.max(1, Math.min(f.limit ?? 500, 5000)))
    .offset(f.offset ?? 0)
    .all()
    .map(toEntry);
}

export function countBrainEntriesByKind(db: Db, packId: string, version: string): Record<string, number> {
  const rows = db
    .select({ kind: brainEntries.kind, n: sql<number>`count(*)` })
    .from(brainEntries)
    .where(and(eq(brainEntries.packId, packId), eq(brainEntries.version, version)))
    .groupBy(brainEntries.kind)
    .orderBy(asc(brainEntries.kind))
    .all();
  return Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
}

export function getBrainEntry(db: Db, packId: string, version: string, id: string): BrainEntryRecord | undefined {
  const r = db.select().from(brainEntries).where(and(eq(brainEntries.packId, packId), eq(brainEntries.version, version), eq(brainEntries.id, id))).get();
  return r ? toEntry(r) : undefined;
}

// ---------------------------------------------------------------------------
// FTS5
// ---------------------------------------------------------------------------

/**
 * A safe FTS5 MATCH expression from free text: words of 2+ letters/digits, each quoted (so FTS syntax in the input is
 * inert), joined with OR. Empty when the text has no usable word.
 */
export function ftsQuery(text: string, opts: { maxTerms?: number } = {}): string {
  const words = (text.normalize('NFKD').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).slice(0, opts.maxTerms ?? 24);
  const unique = [...new Set(words)];
  return unique.map((w) => `"${w.replace(/"/g, '')}"`).join(' OR ');
}

export interface BrainFtsHit {
  entry: BrainEntryRecord;
  /** FTS5 bm25() — lower (more negative) is a better match. */
  bm25: number;
}

export interface SearchBrainFtsInput {
  /** Raw text; turned into a safe MATCH expression with `ftsQuery`. */
  q: string;
  /** (pack, version) pairs to search — normally the active versions. */
  versions: ReadonlyArray<{ packId: string; version: string }>;
  kinds?: readonly string[];
  limit?: number;
}

export function searchBrainFts(db: Db, input: SearchBrainFtsInput): BrainFtsHit[] {
  const match = ftsQuery(input.q);
  if (!match || !input.versions.length) return [];
  const pairs = sql.join(
    input.versions.map((v) => sql`(e.pack_id = ${v.packId} AND e.version = ${v.version})`),
    sql` OR `,
  );
  const kinds = input.kinds?.length ? sql` AND e.kind IN (${sql.join(input.kinds.map((k) => sql`${k}`), sql`, `)})` : sql``;
  const limit = Math.max(1, Math.min(input.limit ?? 20, 200));
  const rows = db.all<{ rowid_key: number; score: number }>(sql`
    SELECT e.rowid_key AS rowid_key, bm25(brain_fts) AS score
    FROM brain_fts JOIN brain_entries e ON e.rowid_key = brain_fts.rowid
    WHERE brain_fts MATCH ${match} AND (${pairs})${kinds}
    ORDER BY score, e.rowid_key
    LIMIT ${limit}`);
  if (!rows.length) return [];
  const byKey = new Map(
    db
      .select()
      .from(brainEntries)
      .where(inArray(brainEntries.rowidKey, rows.map((r) => r.rowid_key)))
      .all()
      .map((r) => [r.rowidKey, toEntry(r)] as const),
  );
  return rows.flatMap((r) => {
    const entry = byKey.get(r.rowid_key);
    return entry ? [{ entry, bm25: Number(r.score) }] : [];
  });
}

/** Rebuild the brain FTS index from brain_entries (repair after a restore; the triggers keep it current otherwise). */
export function rebuildBrainFts(db: Db): void {
  db.run(sql`INSERT INTO brain_fts(brain_fts) VALUES ('rebuild')`);
}

// --- search_docs (claim corpus) ---------------------------------------------

export type SearchDocKind = 'email' | 'document' | 'evidence_text' | 'transcript' | 'note';

export interface SearchDocInput {
  sourceKind: SearchDocKind;
  sourceId: string;
  claimId: string | null;
  title: string;
  body: string;
  at: ISODateTime;
}

export interface SearchDocHit {
  sourceKind: SearchDocKind;
  sourceId: string;
  claimId: string | null;
  title: string;
  snippet: string;
  at: string;
  bm25: number;
}

export function hasSearchDoc(db: Db, sourceKind: SearchDocKind, sourceId: string): boolean {
  const r = db.get<{ n: number }>(sql`SELECT count(*) AS n FROM search_docs WHERE source_kind = ${sourceKind} AND source_id = ${sourceId}`);
  return Number(r?.n ?? 0) > 0;
}

/** Index (or re-index) one source: its previous row is replaced. */
export function upsertSearchDoc(db: Db, input: SearchDocInput): void {
  db.run(sql`DELETE FROM search_docs WHERE source_kind = ${input.sourceKind} AND source_id = ${input.sourceId}`);
  db.run(sql`INSERT INTO search_docs (title, body, claim_id, source_kind, source_id, at) VALUES (${input.title}, ${input.body}, ${input.claimId}, ${input.sourceKind}, ${input.sourceId}, ${input.at})`);
}

export function countSearchDocs(db: Db, claimId?: string): number {
  const r = claimId ? db.get<{ n: number }>(sql`SELECT count(*) AS n FROM search_docs WHERE claim_id = ${claimId}`) : db.get<{ n: number }>(sql`SELECT count(*) AS n FROM search_docs`);
  return Number(r?.n ?? 0);
}

export function searchClaimDocs(db: Db, input: { q: string; claimId?: string; limit?: number }): SearchDocHit[] {
  const match = ftsQuery(input.q);
  if (!match) return [];
  const claim = input.claimId ? sql` AND claim_id = ${input.claimId}` : sql``;
  const limit = Math.max(1, Math.min(input.limit ?? 20, 200));
  const rows = db.all<{ source_kind: SearchDocKind; source_id: string; claim_id: string | null; title: string; snippet: string; at: string; score: number }>(sql`
    SELECT source_kind, source_id, claim_id, title, snippet(search_docs, 1, '[', ']', '…', 16) AS snippet, at, bm25(search_docs) AS score
    FROM search_docs WHERE search_docs MATCH ${match}${claim}
    ORDER BY score, source_id LIMIT ${limit}`);
  return rows.map((r) => ({ sourceKind: r.source_kind, sourceId: r.source_id, claimId: r.claim_id, title: r.title, snippet: r.snippet, at: r.at, bm25: Number(r.score) }));
}
