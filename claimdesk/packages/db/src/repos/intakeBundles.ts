// owned by intake-server
/**
 * Smart intake — case bundles (docs/SMART-INTAKE.md §3.3). A bundle is a named working set of intake items; its files
 * carry derived per-file facts (duplicates, page ranges, photo facts, filing result). Owner decisions, AI reasoning
 * results and the claim's damage observations are append-only (database triggers refuse UPDATE/DELETE); everything
 * else on a bundle is recomputable from files + readings + decisions and cached as JSON (`computed`).
 *
 * `revision` increments on every file added/removed/moved and every decision (`bumpBundleRevision`); jobs carry the
 * revision they were queued for and exit early when stale. `casBundleStatus` is the register lock (one winner).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import type { ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import {
  claimDamageObservations,
  intakeBundleDecisions,
  intakeBundleFiles,
  intakeBundleReasonings,
  intakeBundles,
  type ClaimDamageObservationRow,
  type IntakeBundleDecisionRow,
  type IntakeBundleFileRow,
  type IntakeBundleReasoningRow,
  type IntakeBundleRow,
} from '../schema.js';
import { denull, nowIso } from '../util.js';

export type BundleStatus = 'open' | 'reading' | 'reconciling' | 'ready' | 'needs_you' | 'registering' | 'registered' | 'attached' | 'cancelled';
export type BundleFileRole = 'document' | 'pack' | 'segment' | 'attachment' | 'archive' | 'email';
export type BundleDecisionKind =
  | 'create' | 'rename' | 'add_files' | 'move_file' | 'exclude_file' | 'include_file' | 'unsplit'
  | 'set_field' | 'clear_field' | 'choose_conflict' | 'accept_preselected' | 'confirm_new' | 'link_party' | 'tick_timeline' | 'untick_timeline'
  | 'ack_signal' | 'split_off' | 'think_again' | 'register' | 'attach' | 'cancel' | 'reopen';
export type BundleReasoningStatus = 'none' | 'queued' | 'waiting_ai' | 'done' | 'failed' | 'skipped';
export type BundleSource = 'upload' | 'folder' | 'split';
/** 0016: 'catch_up' bundles belong to a claim's AI input panel (docs/CLAIM-AI-INPUT.md §8). */
export type BundleMode = 'intake' | 'catch_up';
export const BUNDLE_MODES: readonly BundleMode[] = ['intake', 'catch_up'];

export const BUNDLE_STATUSES: readonly BundleStatus[] = ['open', 'reading', 'reconciling', 'ready', 'needs_you', 'registering', 'registered', 'attached', 'cancelled'];
export const CLOSED_BUNDLE_STATUSES: readonly BundleStatus[] = ['registered', 'attached', 'cancelled'];
export const BUNDLE_DECISION_KINDS: readonly BundleDecisionKind[] = [
  'create', 'rename', 'add_files', 'move_file', 'exclude_file', 'include_file', 'unsplit', 'set_field', 'clear_field', 'choose_conflict', 'accept_preselected',
  'confirm_new', 'link_party', 'tick_timeline', 'untick_timeline', 'ack_signal', 'split_off', 'think_again', 'register', 'attach', 'cancel', 'reopen',
];
const FILE_ROLES: readonly BundleFileRole[] = ['document', 'pack', 'segment', 'attachment', 'archive', 'email'];

export interface IntakeBundleRecord {
  id: string;
  name: string;
  status: BundleStatus;
  source: BundleSource;
  folderKey?: string;
  parentBundleId?: string;
  splitFromGroup?: string;
  claimId?: string;
  outcome?: 'registered' | 'attached';
  revision: number;
  computedRevision?: number;
  computed?: unknown;
  reasoningStatus: BundleReasoningStatus;
  reasoningFileset?: string;
  autoEligible: boolean;
  needsYouId?: string;
  error?: string;
  createdBy: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  closedBy?: string;
  closedAt?: ISODateTime;
  mode: BundleMode;
  targetClaimId?: string;
}

export interface IntakeBundleFileRecord {
  id: string;
  bundleId: string;
  intakeItemId: string;
  evidenceId: string;
  parentFileId?: string;
  position: number;
  role: BundleFileRole;
  pageFrom?: number;
  pageTo?: number;
  phash?: string;
  facts?: unknown;
  filedEvidenceId?: string;
  filedClaimId?: string;
  filedKind?: string;
  filedAt?: ISODateTime;
  addedBy: string;
  addedAt: ISODateTime;
  updatedAt: ISODateTime;
  /** 0016: per-file catch-up facts (derived). */
  catchUp?: unknown;
}

export interface IntakeBundleDecisionRecord {
  id: string;
  bundleId: string;
  revision: number;
  kind: BundleDecisionKind;
  subject?: string;
  before?: unknown;
  after?: unknown;
  note?: string;
  actor: string;
  runId?: string;
  at: ISODateTime;
}

export interface IntakeBundleReasoningRecord {
  id: string;
  bundleId: string;
  fileset: string;
  engine: 'ai';
  runId?: string;
  result: unknown;
  checks: unknown;
  createdAt: ISODateTime;
}

export interface ClaimDamageObservationRecord {
  id: string;
  claimId: string;
  evidenceId?: string;
  zoneId: string;
  severity: number;
  confidence: number;
  source: 'ai_photo' | 'estimate_text' | 'owner';
  bundleId?: string;
  runId?: string;
  createdBy: string;
  createdAt: ISODateTime;
}

const toBundle = (r: IntakeBundleRow): IntakeBundleRecord => {
  const d = denull(r) as unknown as IntakeBundleRecord;
  return { ...d, autoEligible: Boolean(r.autoEligible), ...(r.computed !== null && r.computed !== undefined ? { computed: r.computed } : {}) };
};
const toFile = (r: IntakeBundleFileRow): IntakeBundleFileRecord => {
  const d = denull(r) as unknown as IntakeBundleFileRecord;
  return { ...d, ...(r.facts !== null && r.facts !== undefined ? { facts: r.facts } : {}), ...(r.catchUp !== null && r.catchUp !== undefined ? { catchUp: r.catchUp } : {}) };
};
const toDecision = (r: IntakeBundleDecisionRow): IntakeBundleDecisionRecord => {
  const d = denull(r) as unknown as IntakeBundleDecisionRecord;
  return { ...d, ...(r.before !== null ? { before: r.before } : {}), ...(r.after !== null ? { after: r.after } : {}) };
};
const toReasoning = (r: IntakeBundleReasoningRow): IntakeBundleReasoningRecord => ({ ...(denull(r) as unknown as IntakeBundleReasoningRecord), result: r.result, checks: r.checks });
const toObservation = (r: ClaimDamageObservationRow): ClaimDamageObservationRecord => denull(r) as unknown as ClaimDamageObservationRecord;

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

export interface CreateIntakeBundleInput {
  name: string;
  source: BundleSource;
  folderKey?: string;
  parentBundleId?: string;
  splitFromGroup?: string;
  /** Default 'intake'. A 'catch_up' bundle needs `targetClaimId`. */
  mode?: BundleMode;
  targetClaimId?: string;
  createdBy: string;
  now?: ISODateTime;
  id?: string;
}

export function createIntakeBundle(db: Db, input: CreateIntakeBundleInput): IntakeBundleRecord {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name || name.length > 120) throw new ValidationError('A bundle name is 1–120 characters');
  if (!['upload', 'folder', 'split'].includes(input.source)) throw new ValidationError(`Unknown bundle source ${input.source}`);
  const mode = input.mode ?? 'intake';
  if (!BUNDLE_MODES.includes(mode)) throw new ValidationError(`Unknown bundle mode ${mode}`);
  if (mode === 'catch_up' && !input.targetClaimId) throw new ValidationError('A catch-up bundle needs its claim');
  const now = input.now ?? nowIso();
  const row = db
    .insert(intakeBundles)
    .values({
      id: input.id ?? randomUUID(),
      name,
      status: 'open',
      source: input.source,
      folderKey: input.folderKey ?? null,
      parentBundleId: input.parentBundleId ?? null,
      splitFromGroup: input.splitFromGroup ?? null,
      revision: 0,
      reasoningStatus: 'none',
      autoEligible: false,
      mode,
      targetClaimId: input.targetClaimId ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toBundle(row);
}

export function getIntakeBundle(db: Db, id: string): IntakeBundleRecord | undefined {
  const r = db.select().from(intakeBundles).where(eq(intakeBundles.id, id)).get();
  return r ? toBundle(r) : undefined;
}

export function requireIntakeBundle(db: Db, id: string): IntakeBundleRecord {
  const b = getIntakeBundle(db, id);
  if (!b) throw new NotFoundError('intake_bundles', id);
  return b;
}

export interface ListIntakeBundlesQuery {
  status?: BundleStatus[];
  claimId?: string;
  /** Default 'intake' (catch-up bundles never show in Intake > Case bundles); 'all' for every mode. */
  mode?: BundleMode | 'all';
  targetClaimId?: string;
  limit?: number;
  offset?: number;
}

function bundleConds(q: Pick<ListIntakeBundlesQuery, 'status' | 'claimId' | 'mode' | 'targetClaimId'>): SQL[] {
  const conds: SQL[] = [];
  if (q.status?.length) conds.push(inArray(intakeBundles.status, q.status));
  if (q.claimId) conds.push(eq(intakeBundles.claimId, q.claimId));
  const mode = q.mode ?? 'intake';
  if (mode !== 'all') conds.push(eq(intakeBundles.mode, mode));
  if (q.targetClaimId) conds.push(eq(intakeBundles.targetClaimId, q.targetClaimId));
  return conds;
}

/** Newest first (by last update). */
export function listIntakeBundles(db: Db, q: ListIntakeBundlesQuery = {}): IntakeBundleRecord[] {
  const conds = bundleConds(q);
  return db
    .select()
    .from(intakeBundles)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(intakeBundles.updatedAt), desc(intakeBundles.id))
    .limit(Math.min(Math.max(q.limit ?? 50, 1), 500))
    .offset(Math.max(q.offset ?? 0, 0))
    .all()
    .map(toBundle);
}

export function countIntakeBundles(db: Db, q: Pick<ListIntakeBundlesQuery, 'status' | 'claimId' | 'mode' | 'targetClaimId'> = {}): number {
  const conds = bundleConds(q);
  const r = db.select({ n: sql<number>`count(*)` }).from(intakeBundles).where(conds.length ? and(...conds) : undefined).get();
  return Number(r?.n ?? 0);
}

/** The open bundle of an inbox folder (case-insensitive: Windows folders differ only by case are the same folder). */
export function findOpenBundleByFolder(db: Db, folderKey: string): IntakeBundleRecord | undefined {
  const r = db
    .select()
    .from(intakeBundles)
    .where(and(sql`lower(${intakeBundles.folderKey}) = lower(${folderKey})`, notInArray(intakeBundles.status, [...CLOSED_BUNDLE_STATUSES])))
    .orderBy(desc(intakeBundles.createdAt))
    .limit(1)
    .get();
  return r ? toBundle(r) : undefined;
}

/** Any bundle (open or closed) whose folder key matches, case-insensitive (for the "(2)" name of a reused folder). */
export function listBundlesByFolder(db: Db, folderKey: string): IntakeBundleRecord[] {
  return db.select().from(intakeBundles).where(sql`lower(${intakeBundles.folderKey}) = lower(${folderKey})`).orderBy(asc(intakeBundles.createdAt)).all().map(toBundle);
}

export interface IntakeBundlePatch {
  name?: string;
  status?: BundleStatus;
  claimId?: string | null;
  outcome?: 'registered' | 'attached' | null;
  computedRevision?: number | null;
  computed?: unknown;
  reasoningStatus?: BundleReasoningStatus;
  reasoningFileset?: string | null;
  autoEligible?: boolean;
  needsYouId?: string | null;
  error?: string | null;
  closedBy?: string | null;
  closedAt?: string | null;
  folderKey?: string | null;
}

/** Update fields of a bundle (never the revision: use bumpBundleRevision). */
export function updateIntakeBundle(db: Db, id: string, patch: IntakeBundlePatch, now: ISODateTime = nowIso()): IntakeBundleRecord {
  requireIntakeBundle(db, id);
  if (patch.status && !BUNDLE_STATUSES.includes(patch.status)) throw new ValidationError(`Unknown bundle status ${patch.status}`);
  const set: Record<string, unknown> = { updatedAt: now };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v;
  const row = db.update(intakeBundles).set(set).where(eq(intakeBundles.id, id)).returning().get();
  return toBundle(row);
}

/** revision + 1 (returns the new revision). */
export function bumpBundleRevision(db: Db, id: string, now: ISODateTime = nowIso()): number {
  const row = db
    .update(intakeBundles)
    .set({ revision: sql`${intakeBundles.revision} + 1`, updatedAt: now })
    .where(eq(intakeBundles.id, id))
    .returning({ revision: intakeBundles.revision })
    .get();
  if (!row) throw new NotFoundError('intake_bundles', id);
  return row.revision;
}

/** Compare-and-set the status: true only for the one caller that moved it from one of `from` to `to`. */
export function casBundleStatus(db: Db, id: string, from: BundleStatus[], to: BundleStatus, now: ISODateTime = nowIso()): boolean {
  const rows = db
    .update(intakeBundles)
    .set({ status: to, updatedAt: now })
    .where(and(eq(intakeBundles.id, id), inArray(intakeBundles.status, from)))
    .returning({ id: intakeBundles.id })
    .all();
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface AddBundleFileInput {
  bundleId: string;
  intakeItemId: string;
  evidenceId: string;
  parentFileId?: string | null;
  role?: BundleFileRole;
  pageFrom?: number | null;
  pageTo?: number | null;
  addedBy: string;
  now?: ISODateTime;
  id?: string;
}

/** Idempotent on (bundle, item): the existing file is returned with `created: false`. Position = next in the bundle. */
export function addBundleFile(db: Db, input: AddBundleFileInput): { file: IntakeBundleFileRecord; created: boolean } {
  const role = input.role ?? 'document';
  if (!FILE_ROLES.includes(role)) throw new ValidationError(`Unknown bundle file role ${role}`);
  const existing = db.select().from(intakeBundleFiles).where(and(eq(intakeBundleFiles.bundleId, input.bundleId), eq(intakeBundleFiles.intakeItemId, input.intakeItemId))).get();
  if (existing) return { file: toFile(existing), created: false };
  const now = input.now ?? nowIso();
  const pos = db.select({ n: sql<number>`coalesce(max(${intakeBundleFiles.position}), 0)` }).from(intakeBundleFiles).where(eq(intakeBundleFiles.bundleId, input.bundleId)).get();
  const inserted = db
    .insert(intakeBundleFiles)
    .values({
      id: input.id ?? randomUUID(),
      bundleId: input.bundleId,
      intakeItemId: input.intakeItemId,
      evidenceId: input.evidenceId,
      parentFileId: input.parentFileId ?? null,
      position: Number(pos?.n ?? 0) + 1,
      role,
      pageFrom: input.pageFrom ?? null,
      pageTo: input.pageTo ?? null,
      addedBy: input.addedBy,
      addedAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning()
    .all();
  if (inserted[0]) return { file: toFile(inserted[0]), created: true };
  const again = db.select().from(intakeBundleFiles).where(and(eq(intakeBundleFiles.bundleId, input.bundleId), eq(intakeBundleFiles.intakeItemId, input.intakeItemId))).get();
  if (!again) throw new ValidationError('The bundle file could not be added');
  return { file: toFile(again), created: false };
}

/** Position order. */
export function listBundleFiles(db: Db, bundleId: string): IntakeBundleFileRecord[] {
  return db.select().from(intakeBundleFiles).where(eq(intakeBundleFiles.bundleId, bundleId)).orderBy(asc(intakeBundleFiles.position), asc(intakeBundleFiles.id)).all().map(toFile);
}

export function getBundleFile(db: Db, id: string): IntakeBundleFileRecord | undefined {
  const r = db.select().from(intakeBundleFiles).where(eq(intakeBundleFiles.id, id)).get();
  return r ? toFile(r) : undefined;
}

export function bundleFilesByItem(db: Db, itemId: string): IntakeBundleFileRecord[] {
  return db.select().from(intakeBundleFiles).where(eq(intakeBundleFiles.intakeItemId, itemId)).orderBy(asc(intakeBundleFiles.addedAt)).all().map(toFile);
}

export interface BundleFilePatch {
  role?: BundleFileRole;
  parentFileId?: string | null;
  pageFrom?: number | null;
  pageTo?: number | null;
  phash?: string | null;
  facts?: unknown;
  filedEvidenceId?: string | null;
  filedClaimId?: string | null;
  filedKind?: string | null;
  filedAt?: string | null;
  bundleId?: string;
  catchUp?: unknown;
}

export function updateBundleFile(db: Db, id: string, patch: BundleFilePatch, now: ISODateTime = nowIso()): IntakeBundleFileRecord {
  if (patch.role && !FILE_ROLES.includes(patch.role)) throw new ValidationError(`Unknown bundle file role ${patch.role}`);
  const set: Record<string, unknown> = { updatedAt: now };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v;
  const row = db.update(intakeBundleFiles).set(set).where(eq(intakeBundleFiles.id, id)).returning().get();
  if (!row) throw new NotFoundError('intake_bundle_files', id);
  return toFile(row);
}

// ---------------------------------------------------------------------------
// Decisions (append-only)
// ---------------------------------------------------------------------------

export interface AppendBundleDecisionInput {
  bundleId: string;
  revision: number;
  kind: BundleDecisionKind;
  subject?: string | null;
  before?: unknown;
  after?: unknown;
  note?: string | null;
  actor: string;
  runId?: string | null;
  at?: ISODateTime;
  id?: string;
}

export function appendBundleDecision(db: Db, input: AppendBundleDecisionInput): IntakeBundleDecisionRecord {
  if (!BUNDLE_DECISION_KINDS.includes(input.kind)) throw new ValidationError(`Unknown bundle decision ${input.kind}`);
  const row = db
    .insert(intakeBundleDecisions)
    .values({
      id: input.id ?? randomUUID(),
      bundleId: input.bundleId,
      revision: input.revision,
      kind: input.kind,
      subject: input.subject ?? null,
      before: input.before === undefined ? null : input.before,
      after: input.after === undefined ? null : input.after,
      note: input.note ? input.note.slice(0, 2000) : null,
      actor: input.actor,
      runId: input.runId ?? null,
      at: input.at ?? nowIso(),
    })
    .returning()
    .get();
  return toDecision(row);
}

/** Oldest first (append order). */
export function listBundleDecisions(db: Db, bundleId: string, opts: { sinceRevision?: number } = {}): IntakeBundleDecisionRecord[] {
  const conds: SQL[] = [eq(intakeBundleDecisions.bundleId, bundleId)];
  if (opts.sinceRevision !== undefined) conds.push(sql`${intakeBundleDecisions.revision} >= ${opts.sinceRevision}`);
  return db.select().from(intakeBundleDecisions).where(and(...conds)).orderBy(asc(intakeBundleDecisions.at), asc(sql`rowid`)).all().map(toDecision);
}

// ---------------------------------------------------------------------------
// AI reasoning results (append-only)
// ---------------------------------------------------------------------------

export function appendBundleReasoning(db: Db, input: { bundleId: string; fileset: string; runId?: string | null; result: unknown; checks: unknown; now?: ISODateTime; id?: string }): IntakeBundleReasoningRecord {
  const row = db
    .insert(intakeBundleReasonings)
    .values({ id: input.id ?? randomUUID(), bundleId: input.bundleId, fileset: input.fileset, engine: 'ai', runId: input.runId ?? null, result: input.result ?? {}, checks: input.checks ?? {}, createdAt: input.now ?? nowIso() })
    .returning()
    .get();
  return toReasoning(row);
}

/** The newest reasoning of a bundle (for one fileset when given). */
export function latestBundleReasoning(db: Db, bundleId: string, fileset?: string): IntakeBundleReasoningRecord | undefined {
  const conds: SQL[] = [eq(intakeBundleReasonings.bundleId, bundleId)];
  if (fileset) conds.push(eq(intakeBundleReasonings.fileset, fileset));
  const r = db.select().from(intakeBundleReasonings).where(and(...conds)).orderBy(desc(intakeBundleReasonings.createdAt), desc(sql`rowid`)).limit(1).get();
  return r ? toReasoning(r) : undefined;
}

export function listBundleReasonings(db: Db, bundleId: string): IntakeBundleReasoningRecord[] {
  return db.select().from(intakeBundleReasonings).where(eq(intakeBundleReasonings.bundleId, bundleId)).orderBy(asc(intakeBundleReasonings.createdAt), asc(sql`rowid`)).all().map(toReasoning);
}

// ---------------------------------------------------------------------------
// Damage observations (append-only, idempotent)
// ---------------------------------------------------------------------------

export interface InsertDamageObservationInput {
  claimId: string;
  evidenceId?: string | null;
  zoneId: string;
  severity: number;
  confidence: number;
  source: 'ai_photo' | 'estimate_text' | 'owner';
  bundleId?: string | null;
  runId?: string | null;
  createdBy: string;
  now?: ISODateTime;
  id?: string;
}

/** ON CONFLICT DO NOTHING on (claim, evidence, zone, source, bundle). */
export function insertDamageObservation(db: Db, input: InsertDamageObservationInput): { created: boolean } {
  const severity = Math.round(input.severity);
  if (!(severity >= 0 && severity <= 3)) throw new ValidationError('Severity is 0–3');
  if (!(input.confidence >= 0 && input.confidence <= 1)) throw new ValidationError('Confidence is 0–1');
  const rows = db
    .insert(claimDamageObservations)
    .values({
      id: input.id ?? randomUUID(),
      claimId: input.claimId,
      evidenceId: input.evidenceId ?? null,
      zoneId: input.zoneId,
      severity,
      confidence: input.confidence,
      source: input.source,
      bundleId: input.bundleId ?? null,
      runId: input.runId ?? null,
      createdBy: input.createdBy,
      createdAt: input.now ?? nowIso(),
    })
    .onConflictDoNothing()
    .returning({ id: claimDamageObservations.id })
    .all();
  return { created: rows.length === 1 };
}

/** Oldest first. */
export function listDamageObservations(db: Db, claimId: string): ClaimDamageObservationRecord[] {
  return db.select().from(claimDamageObservations).where(eq(claimDamageObservations.claimId, claimId)).orderBy(asc(claimDamageObservations.createdAt), asc(sql`rowid`)).all().map(toObservation);
}
