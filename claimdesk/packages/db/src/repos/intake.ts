// owned by intake
/**
 * Intake persistence (docs/SUPREME-DESIGN.md §G, §N.3): intake items (any file → normalised text), extractions
 * (append-only — a re-extraction is a new row; database triggers refuse UPDATE/DELETE) and claim update proposals.
 *
 * Proposals move only `pending → applied | rejected | superseded` through `decideClaimUpdateProposal`; the decision
 * notes (validator result, policy rule ids, the owner's rejection reason) live in the `validator` JSON column as
 * `ProposalChecks`. A pending proposal with the same claim, target and value is returned instead of a duplicate.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import {
  claimUpdateProposals,
  intakeExtractions,
  intakeItems,
  type ClaimUpdateProposalRow,
  type IntakeExtractionRow,
  type IntakeItemRow,
  type IntakeItemStatus,
} from '../schema.js';
import { denull, nowIso } from '../util.js';

export type { IntakeItemStatus };
export type IntakeSource = 'upload' | 'email' | 'folder' | 'capture';
export type ProposalPolicy = 'auto' | 'confirm' | 'never';
export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'superseded';

export const INTAKE_ITEM_STATUSES: readonly IntakeItemStatus[] = ['queued', 'normalising', 'extracting', 'proposed', 'applied', 'needs_you', 'failed', 'quota_wait', 'skipped'];
export const INTAKE_SOURCES: readonly IntakeSource[] = ['upload', 'email', 'folder', 'capture'];

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface IntakeItemRecord {
  id: string;
  source: IntakeSource;
  evidenceId: string;
  parentItemId?: string;
  claimId?: string;
  status: IntakeItemStatus;
  sniffedType?: string;
  docType?: string;
  docTypeConfidence?: number;
  pages?: number;
  textSha256?: string;
  /** What normalisation produced (page texts, email headers, skip reason …) — shape owned by apps/api intake. */
  normalised?: unknown;
  error?: string;
  createdBy: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface CreateIntakeItemInput {
  source: IntakeSource;
  evidenceId: string;
  parentItemId?: string;
  claimId?: string;
  status?: IntakeItemStatus;
  createdBy: string;
  id?: string;
  now?: ISODateTime;
}

const toItem = (r: IntakeItemRow): IntakeItemRecord => ({ ...(denull(r) as IntakeItemRecord), ...(r.normalised !== null && r.normalised !== undefined ? { normalised: r.normalised } : {}) });

export function createIntakeItem(db: Db, input: CreateIntakeItemInput): IntakeItemRecord {
  if (!INTAKE_SOURCES.includes(input.source)) throw new ValidationError(`Unknown intake source ${input.source}`);
  if (!input.evidenceId) throw new ValidationError('An intake item needs an evidence id');
  const now = input.now ?? nowIso();
  const row = db
    .insert(intakeItems)
    .values({
      id: input.id ?? randomUUID(),
      source: input.source,
      evidenceId: input.evidenceId,
      parentItemId: input.parentItemId ?? null,
      claimId: input.claimId ?? null,
      status: input.status ?? 'queued',
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toItem(row);
}

export function getIntakeItem(db: Db, id: string): IntakeItemRecord | undefined {
  const r = db.select().from(intakeItems).where(eq(intakeItems.id, id)).get();
  return r ? toItem(r) : undefined;
}

export function requireIntakeItem(db: Db, id: string): IntakeItemRecord {
  const r = getIntakeItem(db, id);
  if (!r) throw new NotFoundError('intake_items', id);
  return r;
}

/** The item for an evidence row (the oldest one; with `parentItemId` the child under that parent). */
export function findIntakeItemByEvidence(db: Db, evidenceId: string, opts: { parentItemId?: string | null } = {}): IntakeItemRecord | undefined {
  const conds: SQL[] = [eq(intakeItems.evidenceId, evidenceId)];
  if (opts.parentItemId === null) conds.push(isNull(intakeItems.parentItemId));
  else if (opts.parentItemId !== undefined) conds.push(eq(intakeItems.parentItemId, opts.parentItemId));
  const r = db.select().from(intakeItems).where(and(...conds)).orderBy(asc(intakeItems.createdAt), asc(intakeItems.id)).limit(1).get();
  return r ? toItem(r) : undefined;
}

export interface ListIntakeItemsQuery {
  status?: IntakeItemStatus | IntakeItemStatus[];
  claimId?: string | null;
  parentItemId?: string | null;
  limit?: number;
  offset?: number;
}

export function listIntakeItems(db: Db, q: ListIntakeItemsQuery = {}): IntakeItemRecord[] {
  const conds: SQL[] = [];
  if (q.status) conds.push(Array.isArray(q.status) ? inArray(intakeItems.status, q.status) : eq(intakeItems.status, q.status));
  if (q.claimId === null) conds.push(isNull(intakeItems.claimId));
  else if (q.claimId !== undefined) conds.push(eq(intakeItems.claimId, q.claimId));
  if (q.parentItemId === null) conds.push(isNull(intakeItems.parentItemId));
  else if (q.parentItemId !== undefined) conds.push(eq(intakeItems.parentItemId, q.parentItemId));
  return db
    .select()
    .from(intakeItems)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(intakeItems.createdAt), desc(intakeItems.id))
    .limit(Math.min(Math.max(q.limit ?? 100, 1), 1000))
    .offset(Math.max(q.offset ?? 0, 0))
    .all()
    .map(toItem);
}

export function countIntakeItems(db: Db, q: Pick<ListIntakeItemsQuery, 'status' | 'claimId'> = {}): number {
  const conds: SQL[] = [];
  if (q.status) conds.push(Array.isArray(q.status) ? inArray(intakeItems.status, q.status) : eq(intakeItems.status, q.status));
  if (q.claimId === null) conds.push(isNull(intakeItems.claimId));
  else if (q.claimId !== undefined) conds.push(eq(intakeItems.claimId, q.claimId));
  const r = db.select({ n: sql<number>`count(*)` }).from(intakeItems).where(conds.length ? and(...conds) : undefined).get();
  return Number(r?.n ?? 0);
}

export interface IntakeItemPatch {
  status?: IntakeItemStatus;
  claimId?: string | null;
  sniffedType?: string | null;
  docType?: string | null;
  docTypeConfidence?: number | null;
  pages?: number | null;
  textSha256?: string | null;
  normalised?: unknown;
  error?: string | null;
}

export function updateIntakeItem(db: Db, id: string, patch: IntakeItemPatch, now: ISODateTime = nowIso()): IntakeItemRecord {
  requireIntakeItem(db, id);
  if (patch.status && !INTAKE_ITEM_STATUSES.includes(patch.status)) throw new ValidationError(`Unknown intake status ${patch.status}`);
  const set: Record<string, unknown> = { updatedAt: now };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v;
  const row = db.update(intakeItems).set(set).where(eq(intakeItems.id, id)).returning().get();
  return toItem(row);
}

// ---------------------------------------------------------------------------
// Extractions (append-only)
// ---------------------------------------------------------------------------

export interface IntakeExtractionRecord {
  id: string;
  intakeItemId: string;
  runId?: string;
  schemaId: string;
  fields: unknown;
  summary?: string;
  warnings: string[];
  createdAt: ISODateTime;
}

export interface AppendIntakeExtractionInput {
  intakeItemId: string;
  runId?: string;
  schemaId: string;
  fields: unknown;
  summary?: string;
  warnings?: string[];
  id?: string;
  now?: ISODateTime;
}

const toExtraction = (r: IntakeExtractionRow): IntakeExtractionRecord => ({ ...(denull(r) as IntakeExtractionRecord), fields: r.fields, warnings: r.warnings ?? [] });

export function appendIntakeExtraction(db: Db, input: AppendIntakeExtractionInput): IntakeExtractionRecord {
  requireIntakeItem(db, input.intakeItemId);
  const row = db
    .insert(intakeExtractions)
    .values({
      id: input.id ?? randomUUID(),
      intakeItemId: input.intakeItemId,
      runId: input.runId ?? null,
      schemaId: input.schemaId,
      fields: input.fields ?? [],
      summary: input.summary ?? null,
      warnings: input.warnings ?? [],
      createdAt: input.now ?? nowIso(),
    })
    .returning()
    .get();
  return toExtraction(row);
}

export function getIntakeExtraction(db: Db, id: string): IntakeExtractionRecord | undefined {
  const r = db.select().from(intakeExtractions).where(eq(intakeExtractions.id, id)).get();
  return r ? toExtraction(r) : undefined;
}

/** Oldest first. */
export function listIntakeExtractions(db: Db, intakeItemId: string): IntakeExtractionRecord[] {
  return db.select().from(intakeExtractions).where(eq(intakeExtractions.intakeItemId, intakeItemId)).orderBy(asc(intakeExtractions.createdAt), asc(sql`rowid`)).all().map(toExtraction);
}

export function latestIntakeExtraction(db: Db, intakeItemId: string): IntakeExtractionRecord | undefined {
  const all = listIntakeExtractions(db, intakeItemId);
  return all[all.length - 1];
}

// ---------------------------------------------------------------------------
// Claim update proposals
// ---------------------------------------------------------------------------

/** Where a proposed value came from (§G.2 step 6: cited in the audit `after`). */
export interface ProposalSource {
  intakeItemId?: string;
  evidenceId?: string;
  page?: number | null;
  quote?: string | null;
  /** The document's own label for the field. */
  label?: string | null;
  /** 'extraction' (code built it from the result) or 'tool' (the model called claim_field_propose). */
  via?: 'extraction' | 'tool' | 'owner';
  extractionId?: string;
  runId?: string;
}

/** The `validator` column: validation result, policy reasons and the decision notes. */
export interface ProposalChecks {
  validator?: { name: string; ok: boolean; message?: string; normalised?: string };
  policy?: { ruleIds: string[]; reasons: string[] };
  /** Set when the decision was made: why it was rejected or superseded, or what applying it did. */
  decision?: { reason?: string; note?: string; error?: string };
}

export interface ClaimUpdateProposalRecord {
  id: string;
  claimId: string;
  intakeItemId?: string;
  target: string;
  currentValue?: string;
  proposedValue: string;
  confidence: number;
  sensitive: boolean;
  validator?: ProposalChecks;
  source: ProposalSource;
  policyDecision: ProposalPolicy;
  status: ProposalStatus;
  decidedBy?: string;
  decidedAt?: ISODateTime;
  createdAt: ISODateTime;
}

export interface InsertClaimUpdateProposalInput {
  claimId: string;
  intakeItemId?: string;
  target: string;
  currentValue?: string | null;
  proposedValue: string;
  confidence: number;
  sensitive: boolean;
  checks?: ProposalChecks;
  source: ProposalSource;
  policyDecision: ProposalPolicy;
  id?: string;
  now?: ISODateTime;
}

const toProposal = (r: ClaimUpdateProposalRow): ClaimUpdateProposalRecord => {
  const d = denull(r) as unknown as ClaimUpdateProposalRecord & { validator?: unknown };
  return { ...d, sensitive: Boolean(r.sensitive), source: (r.source ?? {}) as ProposalSource, ...(r.validator ? { validator: r.validator as ProposalChecks } : {}) };
};

export function getClaimUpdateProposal(db: Db, id: string): ClaimUpdateProposalRecord | undefined {
  const r = db.select().from(claimUpdateProposals).where(eq(claimUpdateProposals.id, id)).get();
  return r ? toProposal(r) : undefined;
}

export function requireClaimUpdateProposal(db: Db, id: string): ClaimUpdateProposalRecord {
  const p = getClaimUpdateProposal(db, id);
  if (!p) throw new NotFoundError('claim_update_proposals', id);
  return p;
}

/** A pending proposal with the same claim, target and value (and item, when given). */
export function findPendingClaimUpdateProposal(db: Db, q: { claimId: string; target: string; proposedValue: string; intakeItemId?: string }): ClaimUpdateProposalRecord | undefined {
  const conds: SQL[] = [eq(claimUpdateProposals.claimId, q.claimId), eq(claimUpdateProposals.target, q.target), eq(claimUpdateProposals.proposedValue, q.proposedValue), eq(claimUpdateProposals.status, 'pending')];
  if (q.intakeItemId) conds.push(eq(claimUpdateProposals.intakeItemId, q.intakeItemId));
  const r = db.select().from(claimUpdateProposals).where(and(...conds)).orderBy(asc(claimUpdateProposals.createdAt)).limit(1).get();
  return r ? toProposal(r) : undefined;
}

/** Insert a proposal, or return the pending one with the same claim/target/value/item (`created: false`). */
export function insertClaimUpdateProposal(db: Db, input: InsertClaimUpdateProposalInput): { proposal: ClaimUpdateProposalRecord; created: boolean } {
  if (!input.claimId) throw new ValidationError('A proposal needs a claim');
  if (!input.target) throw new ValidationError('A proposal needs a target');
  if (!(input.confidence >= 0 && input.confidence <= 1)) throw new ValidationError('Confidence must be between 0 and 1');
  const existing = findPendingClaimUpdateProposal(db, { claimId: input.claimId, target: input.target, proposedValue: input.proposedValue, ...(input.intakeItemId ? { intakeItemId: input.intakeItemId } : {}) });
  if (existing) return { proposal: existing, created: false };
  const row = db
    .insert(claimUpdateProposals)
    .values({
      id: input.id ?? randomUUID(),
      claimId: input.claimId,
      intakeItemId: input.intakeItemId ?? null,
      target: input.target,
      currentValue: input.currentValue ?? null,
      proposedValue: input.proposedValue,
      confidence: input.confidence,
      sensitive: input.sensitive,
      validator: input.checks ?? null,
      source: input.source,
      policyDecision: input.policyDecision,
      status: 'pending',
      createdAt: input.now ?? nowIso(),
    })
    .returning()
    .get();
  return { proposal: toProposal(row), created: true };
}

export interface ListClaimUpdateProposalsQuery {
  claimId?: string;
  intakeItemId?: string;
  status?: ProposalStatus | ProposalStatus[];
  policyDecision?: ProposalPolicy | ProposalPolicy[];
  ids?: string[];
}

/** Oldest first. */
export function listClaimUpdateProposals(db: Db, q: ListClaimUpdateProposalsQuery = {}): ClaimUpdateProposalRecord[] {
  const conds: SQL[] = [];
  if (q.claimId) conds.push(eq(claimUpdateProposals.claimId, q.claimId));
  if (q.intakeItemId) conds.push(eq(claimUpdateProposals.intakeItemId, q.intakeItemId));
  if (q.status) conds.push(Array.isArray(q.status) ? inArray(claimUpdateProposals.status, q.status) : eq(claimUpdateProposals.status, q.status));
  if (q.policyDecision) conds.push(Array.isArray(q.policyDecision) ? inArray(claimUpdateProposals.policyDecision, q.policyDecision) : eq(claimUpdateProposals.policyDecision, q.policyDecision));
  if (q.ids) {
    if (!q.ids.length) return [];
    conds.push(inArray(claimUpdateProposals.id, q.ids));
  }
  return db
    .select()
    .from(claimUpdateProposals)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(claimUpdateProposals.createdAt), asc(sql`rowid`))
    .all()
    .map(toProposal);
}

/** Change the policy of a still-pending proposal (e.g. an automatic apply that failed becomes a confirmation). */
export function setClaimUpdateProposalPolicy(db: Db, id: string, policyDecision: ProposalPolicy, checks?: ProposalChecks): ClaimUpdateProposalRecord {
  const p = requireClaimUpdateProposal(db, id);
  if (p.status !== 'pending') throw new ValidationError(`Proposal ${id} is ${p.status}; only a pending proposal changes policy`);
  const row = db
    .update(claimUpdateProposals)
    .set({ policyDecision, ...(checks ? { validator: { ...(p.validator ?? {}), ...checks } } : {}) })
    .where(eq(claimUpdateProposals.id, id))
    .returning()
    .get();
  return toProposal(row);
}

export interface DecideProposalInput {
  status: Exclude<ProposalStatus, 'pending'>;
  decidedBy: string;
  decidedAt?: ISODateTime;
  reason?: string;
  note?: string;
  error?: string;
  /** The value actually applied when the owner edited it before applying. */
  appliedValue?: string;
}

/** pending → applied | rejected | superseded (once). The reason/note is kept in the checks' `decision`. */
export function decideClaimUpdateProposal(db: Db, id: string, input: DecideProposalInput): ClaimUpdateProposalRecord {
  const p = requireClaimUpdateProposal(db, id);
  if (p.status !== 'pending') throw new ValidationError(`Proposal ${id} is already ${p.status}`);
  if (!['applied', 'rejected', 'superseded'].includes(input.status)) throw new ValidationError(`Unknown proposal status ${input.status}`);
  const decision: NonNullable<ProposalChecks['decision']> = {};
  if (input.reason) decision.reason = input.reason.slice(0, 2000);
  if (input.note) decision.note = input.note.slice(0, 2000);
  if (input.error) decision.error = input.error.slice(0, 2000);
  if (input.appliedValue !== undefined && input.appliedValue !== p.proposedValue) decision.note = `${decision.note ? `${decision.note}; ` : ''}applied as edited: ${input.appliedValue}`.slice(0, 2000);
  const checks: ProposalChecks = { ...(p.validator ?? {}), ...(Object.keys(decision).length ? { decision } : {}) };
  const row = db
    .update(claimUpdateProposals)
    .set({ status: input.status, decidedBy: input.decidedBy, decidedAt: input.decidedAt ?? nowIso(), validator: checks })
    .where(and(eq(claimUpdateProposals.id, id), eq(claimUpdateProposals.status, 'pending')))
    .returning()
    .get();
  if (!row) throw new ValidationError(`Proposal ${id} was decided concurrently`);
  return toProposal(row);
}

/** Pending proposals on the same claim + target (other than `keepId`) become superseded. */
export function supersedeClaimUpdateProposals(db: Db, q: { claimId: string; target: string; keepId: string; decidedBy: string; now?: ISODateTime }): number {
  const others = listClaimUpdateProposals(db, { claimId: q.claimId, status: 'pending' }).filter((p) => p.target === q.target && p.id !== q.keepId);
  for (const p of others) decideClaimUpdateProposal(db, p.id, { status: 'superseded', decidedBy: q.decidedBy, decidedAt: q.now, reason: `superseded by proposal ${q.keepId}` });
  return others.length;
}
