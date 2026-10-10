// owned by knowledge-learners
/**
 * Persistence for knowledge-learners (docs/SUPREME-KNOWLEDGE-BUILDER.md §5, §6): contact_observations,
 * offer_observations and corrections (append-only — the DB refuses UPDATE and DELETE; inserts are idempotent through
 * their unique indexes), claim_outcomes (rebuilt per claim nightly) and knowledge_watermarks (one row per learner
 * source). Rows only; the learners in apps/api/src/knowledge/learners decide what to write. Private: these rows live
 * only in the owner's DATA_DIR database.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { claimOutcomes, contactObservations, corrections, knowledgeWatermarks, offerObservations, type ClaimOutcomeRow, type ContactObservationRow, type CorrectionRow, type OfferObservationRow } from '../schema.js';
import { newId } from '../util.js';

// ---------------------------------------------------------------------------
// Contact observations (append-only)
// ---------------------------------------------------------------------------

export type ContactObservationRecord = Omit<ContactObservationRow, 'dmarc' | 'domainCheck'> & {
  dmarc: 'pass' | 'fail' | 'none' | 'unknown';
  domainCheck: 'own_domain' | 'unknown_domain' | 'copycat' | 'spoof_suspect';
};
export type ContactObservationInput = Omit<ContactObservationRecord, 'id'> & { id?: string };

const toContactObs = (r: ContactObservationRow): ContactObservationRecord => r as ContactObservationRecord;

/** Insert unless the same (message, signature) is already stored. Returns the row and whether it is new. */
export function insertContactObservation(db: Db, input: ContactObservationInput): { observation: ContactObservationRecord; created: boolean } {
  const existing = db.select().from(contactObservations).where(and(eq(contactObservations.mailMessageId, input.mailMessageId), eq(contactObservations.signatureSha256, input.signatureSha256))).get();
  if (existing) return { observation: toContactObs(existing), created: false };
  const row = db.insert(contactObservations).values({ ...input, id: input.id ?? newId() }).returning().get();
  return { observation: toContactObs(row), created: true };
}

export function listContactObservations(db: Db, f: { insurerSlug?: string; domainCheck?: ContactObservationRecord['domainCheck']; since?: ISODateTime; limit?: number } = {}): ContactObservationRecord[] {
  const conds: SQL[] = [];
  if (f.insurerSlug) conds.push(eq(contactObservations.insurerSlug, f.insurerSlug));
  if (f.domainCheck) conds.push(eq(contactObservations.domainCheck, f.domainCheck));
  if (f.since) conds.push(gte(contactObservations.observedAt, f.since));
  return db
    .select()
    .from(contactObservations)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(contactObservations.observedAt), asc(contactObservations.id))
    .limit(Math.max(1, Math.min(f.limit ?? 5000, 50_000)))
    .all()
    .map(toContactObs);
}

/** Distinct insurer slugs with at least one observation. */
export function contactObservationInsurers(db: Db): string[] {
  return db
    .selectDistinct({ slug: contactObservations.insurerSlug })
    .from(contactObservations)
    .where(isNotNull(contactObservations.insurerSlug))
    .orderBy(asc(contactObservations.insurerSlug))
    .all()
    .map((r) => r.slug!)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Offer observations (append-only; a later decision is a new row)
// ---------------------------------------------------------------------------

export type OfferObservationKind = 'settlement' | 'pav' | 'part36' | 'interim' | 'intervention';
export type OfferObservationSource = 'needs_you' | 'ledger' | 'event' | 'intervention_register' | 'settlement_register';
export type OfferObservationDecision = 'accept' | 'counter' | 'reject' | 'hold' | 'lapsed';
export type OfferObservationRecord = Omit<OfferObservationRow, 'offerKind' | 'source' | 'decision'> & {
  offerKind: OfferObservationKind;
  source: OfferObservationSource;
  decision: OfferObservationDecision | null;
};
export type OfferObservationInput = Omit<OfferObservationRecord, 'id'> & { id?: string };

/** Insert unless (source, source_id, decision) is already stored. */
export function insertOfferObservation(db: Db, input: OfferObservationInput): { observation: OfferObservationRecord; created: boolean } {
  const existing = db
    .select()
    .from(offerObservations)
    .where(and(eq(offerObservations.source, input.source), eq(offerObservations.sourceId, input.sourceId), sql`coalesce(${offerObservations.decision}, '') = ${input.decision ?? ''}`))
    .get();
  if (existing) return { observation: existing as OfferObservationRecord, created: false };
  const row = db.insert(offerObservations).values({ ...input, id: input.id ?? newId() }).returning().get();
  return { observation: row as OfferObservationRecord, created: true };
}

export function listOfferObservations(db: Db, f: { claimId?: string; insurerSlug?: string; limit?: number } = {}): OfferObservationRecord[] {
  const conds: SQL[] = [];
  if (f.claimId) conds.push(eq(offerObservations.claimId, f.claimId));
  if (f.insurerSlug) conds.push(eq(offerObservations.insurerSlug, f.insurerSlug));
  return db
    .select()
    .from(offerObservations)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(offerObservations.receivedAt), asc(offerObservations.createdAt), asc(offerObservations.id))
    .limit(Math.max(1, Math.min(f.limit ?? 10_000, 100_000)))
    .all() as OfferObservationRecord[];
}

// ---------------------------------------------------------------------------
// Claim outcomes (rebuilt per claim)
// ---------------------------------------------------------------------------

export type ClaimOutcomeRecord = Omit<ClaimOutcomeRow, 'steps' | 'gtaSubscriber'> & { gtaSubscriber: boolean | null; steps: { step: string; at: ISODateTime }[] };

/** Replace every outcome row of one claim (a claim × head rebuild). */
export function replaceClaimOutcomes(db: Db, claimId: string, rows: readonly Omit<ClaimOutcomeRecord, 'claimId'>[]): void {
  db.delete(claimOutcomes).where(eq(claimOutcomes.claimId, claimId)).run();
  for (const r of rows) db.insert(claimOutcomes).values({ ...r, claimId }).run();
}

export function listClaimOutcomes(db: Db, f: { insurerSlug?: string; claimId?: string } = {}): ClaimOutcomeRecord[] {
  const conds: SQL[] = [];
  if (f.insurerSlug) conds.push(eq(claimOutcomes.insurerSlug, f.insurerSlug));
  if (f.claimId) conds.push(eq(claimOutcomes.claimId, f.claimId));
  return db
    .select()
    .from(claimOutcomes)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(claimOutcomes.claimId), asc(claimOutcomes.head))
    .all() as ClaimOutcomeRecord[];
}

/** Remove outcome rows of claims no longer present (e.g. a claim deleted in a test database). */
export function pruneClaimOutcomes(db: Db, keepClaimIds: readonly string[]): number {
  const keep = new Set(keepClaimIds);
  const ids = db.selectDistinct({ id: claimOutcomes.claimId }).from(claimOutcomes).all().map((r) => r.id).filter((id) => !keep.has(id));
  for (let i = 0; i < ids.length; i += 500) db.delete(claimOutcomes).where(inArray(claimOutcomes.claimId, ids.slice(i, i + 500))).run();
  return ids.length;
}

// ---------------------------------------------------------------------------
// Corrections (append-only)
// ---------------------------------------------------------------------------

export type CorrectionSource = 'needs_you_edit' | 'outbox_edit' | 'document_supersede' | 'memory_item' | 'owner_reject';
export interface CorrectionStats {
  inserted: number;
  deleted: number;
  changedRatio: number;
}
export type CorrectionRecord = Omit<CorrectionRow, 'source' | 'diff' | 'stats'> & {
  source: CorrectionSource;
  diff: { op: 'eq' | 'ins' | 'del'; text: string }[];
  stats: CorrectionStats;
};
export type CorrectionInput = Omit<CorrectionRecord, 'id'> & { id?: string };

export function insertCorrection(db: Db, input: CorrectionInput): { correction: CorrectionRecord; created: boolean } {
  const existing = db.select().from(corrections).where(and(eq(corrections.source, input.source), eq(corrections.sourceId, input.sourceId))).get();
  if (existing) return { correction: existing as CorrectionRecord, created: false };
  const row = db.insert(corrections).values({ ...input, id: input.id ?? newId() }).returning().get();
  return { correction: row as CorrectionRecord, created: true };
}

export function getCorrections(db: Db, ids: readonly string[]): CorrectionRecord[] {
  if (!ids.length) return [];
  const out: CorrectionRecord[] = [];
  for (let i = 0; i < ids.length; i += 500) out.push(...(db.select().from(corrections).where(inArray(corrections.id, ids.slice(i, i + 500) as string[])).all() as CorrectionRecord[]));
  return out.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id));
}

export function hasCorrectionSource(db: Db, source: CorrectionSource, sourceId: string): boolean {
  return Boolean(db.select({ id: corrections.id }).from(corrections).where(and(eq(corrections.source, source), eq(corrections.sourceId, sourceId))).get());
}

export function listCorrections(db: Db, f: { since?: ISODateTime; after?: ISODateTime; clusterKey?: string; limit?: number; newestFirst?: boolean } = {}): CorrectionRecord[] {
  const conds: SQL[] = [];
  if (f.since) conds.push(gte(corrections.capturedAt, f.since));
  if (f.after) conds.push(gt(corrections.capturedAt, f.after));
  if (f.clusterKey) conds.push(eq(corrections.clusterKey, f.clusterKey));
  return db
    .select()
    .from(corrections)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(f.newestFirst ? desc(corrections.capturedAt) : asc(corrections.capturedAt), asc(corrections.id))
    .limit(Math.max(1, Math.min(f.limit ?? 1000, 20_000)))
    .all() as CorrectionRecord[];
}

export interface CorrectionClusterRow {
  clusterKey: string;
  corrections: number;
  lastCapturedAt: ISODateTime;
  categories: string[];
}

/** Every cluster with its size, latest capture and the union of its categories. */
export function listCorrectionClusters(db: Db): CorrectionClusterRow[] {
  const rows = db.select({ clusterKey: corrections.clusterKey, capturedAt: corrections.capturedAt, categories: corrections.categories }).from(corrections).where(isNotNull(corrections.clusterKey)).all();
  const m = new Map<string, CorrectionClusterRow>();
  for (const r of rows) {
    const k = r.clusterKey!;
    const cur = m.get(k) ?? { clusterKey: k, corrections: 0, lastCapturedAt: r.capturedAt, categories: [] };
    cur.corrections += 1;
    if (r.capturedAt > cur.lastCapturedAt) cur.lastCapturedAt = r.capturedAt;
    for (const c of r.categories ?? []) if (!cur.categories.includes(c)) cur.categories.push(c);
    m.set(k, cur);
  }
  return [...m.values()].map((c) => ({ ...c, categories: [...c.categories].sort() })).sort((a, b) => b.lastCapturedAt.localeCompare(a.lastCapturedAt) || a.clusterKey.localeCompare(b.clusterKey));
}

// ---------------------------------------------------------------------------
// Watermarks
// ---------------------------------------------------------------------------

export interface KnowledgeWatermark {
  source: string;
  lastAt: ISODateTime;
  lastId: string | null;
  updatedAt: ISODateTime;
}

export function getKnowledgeWatermark(db: Db, source: string): KnowledgeWatermark | undefined {
  return db.select().from(knowledgeWatermarks).where(eq(knowledgeWatermarks.source, source)).get();
}

export function putKnowledgeWatermark(db: Db, w: KnowledgeWatermark): void {
  db.insert(knowledgeWatermarks)
    .values(w)
    .onConflictDoUpdate({ target: knowledgeWatermarks.source, set: { lastAt: w.lastAt, lastId: w.lastId, updatedAt: w.updatedAt } })
    .run();
}

export function listKnowledgeWatermarks(db: Db): KnowledgeWatermark[] {
  return db.select().from(knowledgeWatermarks).orderBy(asc(knowledgeWatermarks.source)).all();
}
