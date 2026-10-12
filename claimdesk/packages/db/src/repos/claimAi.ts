// owned by claimai-server
/**
 * Claim AI input (docs/CLAIM-AI-INPUT.md §2.3): the owner's updates and catch-ups on one claim, their append-only
 * action log, standing case instructions (retire-only) and off-system correspondence records (append-only;
 * a withdrawal is a new row superseding the old one).
 *
 * The owner's words (`text`, `extra_text`) are immutable (trigger in 0016). `revision` increments on every answer /
 * file override / think-again; the interpret job carries the revision it was queued for. `casAiInputStatus` is the
 * apply lock (one winner).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import {
  claimAiInputLog,
  claimAiInputs,
  claimCorrespondence,
  claimInstructions,
  type ClaimAiInputLogRow,
  type ClaimAiInputRow,
  type ClaimCorrespondenceRow,
  type ClaimInstructionRow,
} from '../schema.js';
import { denull, nowIso } from '../util.js';

export type AiInputKind = 'update' | 'catch_up';
export type AiInputChannel = 'typed' | 'call_note' | 'voice_note' | 'upload';
export type AiInputStatus =
  | 'interpreting' | 'waiting_ai' | 'clarify' | 'preview' | 'reading' | 'applying' | 'applied' | 'partly_applied'
  | 'nothing_to_do' | 'cancelled' | 'failed' | 'undone';
export type AiInputEngine = 'rules' | 'ai' | 'rules_ai' | 'catch_up';
export type AiInputLogKind =
  | 'created' | 'interpreted' | 'question' | 'answered' | 'edited' | 'applied' | 'skipped' | 'failed' | 'needs_you'
  | 'undone' | 'undo_failed' | 'file_override' | 'files_done' | 'cancelled' | 'think_again' | 'instruction_due';

export const AI_INPUT_KINDS: readonly AiInputKind[] = ['update', 'catch_up'];
export const AI_INPUT_CHANNELS: readonly AiInputChannel[] = ['typed', 'call_note', 'voice_note', 'upload'];
export const AI_INPUT_STATUSES: readonly AiInputStatus[] = [
  'interpreting', 'waiting_ai', 'clarify', 'preview', 'reading', 'applying', 'applied', 'partly_applied', 'nothing_to_do', 'cancelled', 'failed', 'undone',
];
/** Inputs that still need the owner (the panel's "open" list). */
export const OPEN_AI_INPUT_STATUSES: readonly AiInputStatus[] = ['interpreting', 'waiting_ai', 'clarify', 'preview', 'reading', 'applying', 'partly_applied'];
export const AI_INPUT_LOG_KINDS: readonly AiInputLogKind[] = [
  'created', 'interpreted', 'question', 'answered', 'edited', 'applied', 'skipped', 'failed', 'needs_you', 'undone', 'undo_failed', 'file_override',
  'files_done', 'cancelled', 'think_again', 'instruction_due',
];
const ENGINES: readonly AiInputEngine[] = ['rules', 'ai', 'rules_ai', 'catch_up'];

export interface ClaimAiInputRecord {
  id: string;
  claimId: string;
  kind: AiInputKind;
  channel: AiInputChannel;
  text: string;
  extraText?: string;
  status: AiInputStatus;
  engine?: AiInputEngine;
  revision: number;
  interpretation?: unknown;
  answers: unknown[];
  bundleId?: string;
  autoApply: boolean;
  filesDone: boolean;
  runId?: string;
  needsYouId?: string;
  error?: string;
  summary?: unknown;
  createdBy: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  appliedBy?: string;
  appliedAt?: ISODateTime;
}

export interface ClaimAiInputLogRecord {
  id: string;
  inputId: string;
  claimId: string;
  seq: number;
  kind: AiInputLogKind;
  actionKey?: string;
  action?: unknown;
  refs?: unknown;
  note?: string;
  actor: string;
  runId?: string;
  at: ISODateTime;
}

export interface ClaimInstructionRecord {
  id: string;
  claimId: string;
  text: string;
  appliesTo: string[];
  effect: unknown | null;
  activeFrom: ISODateTime;
  until?: ISODateTime;
  status: 'active' | 'retired';
  sourceInputId?: string;
  sourceActionKey?: string;
  createdBy: string;
  createdAt: ISODateTime;
  retiredBy?: string;
  retiredAt?: ISODateTime;
  retiredReason?: string;
}

export type CorrespondenceDirection = 'out' | 'in';
export type CorrespondenceChannel = 'email' | 'post' | 'hand' | 'phone' | 'portal' | 'unknown';
export type CorrespondenceDateSource = 'document' | 'email_header' | 'owner' | 'file_metadata';
export const CORRESPONDENCE_CHANNELS: readonly CorrespondenceChannel[] = ['email', 'post', 'hand', 'phone', 'portal', 'unknown'];
export const CORRESPONDENCE_DATE_SOURCES: readonly CorrespondenceDateSource[] = ['document', 'email_header', 'owner', 'file_metadata'];

export interface ClaimCorrespondenceRecord {
  id: string;
  claimId: string;
  direction: CorrespondenceDirection;
  channel: CorrespondenceChannel;
  kind: string;
  templateId?: string;
  emailKind?: string;
  counterpartyRole?: string;
  counterpartyName?: string;
  at: ISODateTime;
  dateSource: CorrespondenceDateSource;
  subject?: string;
  summary: string;
  evidenceId?: string;
  eventId?: string;
  inputId?: string;
  bundleId?: string;
  bundleFileId?: string;
  supersedesId?: string;
  withdrawn: boolean;
  createdBy: string;
  createdAt: ISODateTime;
}

const toInput = (r: ClaimAiInputRow): ClaimAiInputRecord => {
  const d = denull(r) as unknown as ClaimAiInputRecord;
  return {
    ...d,
    answers: Array.isArray(r.answers) ? r.answers : [],
    autoApply: Boolean(r.autoApply),
    filesDone: Boolean(r.filesDone),
    ...(r.interpretation !== null && r.interpretation !== undefined ? { interpretation: r.interpretation } : {}),
    ...(r.summary !== null && r.summary !== undefined ? { summary: r.summary } : {}),
  };
};
const toLog = (r: ClaimAiInputLogRow): ClaimAiInputLogRecord => {
  const d = denull(r) as unknown as ClaimAiInputLogRecord;
  return { ...d, ...(r.action !== null && r.action !== undefined ? { action: r.action } : {}), ...(r.refs !== null && r.refs !== undefined ? { refs: r.refs } : {}) };
};
const toInstruction = (r: ClaimInstructionRow): ClaimInstructionRecord => {
  const d = denull(r) as unknown as ClaimInstructionRecord;
  return { ...d, appliesTo: Array.isArray(r.appliesTo) ? r.appliesTo : ['all'], effect: r.effect ?? null, status: r.status === 'retired' ? 'retired' : 'active' };
};
const toCorrespondence = (r: ClaimCorrespondenceRow): ClaimCorrespondenceRecord => ({ ...(denull(r) as unknown as ClaimCorrespondenceRecord), withdrawn: Boolean(r.withdrawn) });

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateAiInputInput {
  claimId: string;
  kind: AiInputKind;
  channel: AiInputChannel;
  text: string;
  extraText?: string | null;
  status: AiInputStatus;
  bundleId?: string | null;
  autoApply?: boolean;
  createdBy: string;
  now?: ISODateTime;
  id?: string;
}

export function createAiInput(db: Db, input: CreateAiInputInput): ClaimAiInputRecord {
  if (!AI_INPUT_KINDS.includes(input.kind)) throw new ValidationError(`Unknown AI input kind ${input.kind}`);
  if (!AI_INPUT_CHANNELS.includes(input.channel)) throw new ValidationError(`Unknown AI input channel ${input.channel}`);
  if (!AI_INPUT_STATUSES.includes(input.status)) throw new ValidationError(`Unknown AI input status ${input.status}`);
  const now = input.now ?? nowIso();
  const row = db
    .insert(claimAiInputs)
    .values({
      id: input.id ?? randomUUID(),
      claimId: input.claimId,
      kind: input.kind,
      channel: input.channel,
      text: input.text,
      extraText: input.extraText ?? null,
      status: input.status,
      revision: 0,
      answers: [],
      bundleId: input.bundleId ?? null,
      autoApply: input.autoApply ?? true,
      filesDone: false,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toInput(row);
}

export function getAiInput(db: Db, id: string): ClaimAiInputRecord | undefined {
  const r = db.select().from(claimAiInputs).where(eq(claimAiInputs.id, id)).get();
  return r ? toInput(r) : undefined;
}

export function requireAiInput(db: Db, id: string): ClaimAiInputRecord {
  const r = getAiInput(db, id);
  if (!r) throw new NotFoundError('claim_ai_inputs', id);
  return r;
}

export interface ListAiInputsQuery {
  claimId?: string;
  status?: AiInputStatus[];
  kind?: AiInputKind;
  limit?: number;
  offset?: number;
}

function inputConds(q: Omit<ListAiInputsQuery, 'limit' | 'offset'>): SQL[] {
  const conds: SQL[] = [];
  if (q.claimId) conds.push(eq(claimAiInputs.claimId, q.claimId));
  if (q.status?.length) conds.push(inArray(claimAiInputs.status, q.status));
  if (q.kind) conds.push(eq(claimAiInputs.kind, q.kind));
  return conds;
}

/** Newest first (by creation). */
export function listAiInputs(db: Db, q: ListAiInputsQuery = {}): ClaimAiInputRecord[] {
  const conds = inputConds(q);
  return db
    .select()
    .from(claimAiInputs)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(claimAiInputs.createdAt), desc(sql`rowid`))
    .limit(Math.min(Math.max(q.limit ?? 50, 1), 500))
    .offset(Math.max(q.offset ?? 0, 0))
    .all()
    .map(toInput);
}

export function countAiInputs(db: Db, q: Omit<ListAiInputsQuery, 'limit' | 'offset'> = {}): number {
  const conds = inputConds(q);
  const r = db.select({ n: sql<number>`count(*)` }).from(claimAiInputs).where(conds.length ? and(...conds) : undefined).get();
  return Number(r?.n ?? 0);
}

export function findAiInputByBundle(db: Db, bundleId: string): ClaimAiInputRecord | undefined {
  const r = db.select().from(claimAiInputs).where(eq(claimAiInputs.bundleId, bundleId)).get();
  return r ? toInput(r) : undefined;
}

export interface AiInputPatch {
  status?: AiInputStatus;
  engine?: AiInputEngine | null;
  interpretation?: unknown;
  answers?: unknown[];
  runId?: string | null;
  needsYouId?: string | null;
  error?: string | null;
  summary?: unknown;
  autoApply?: boolean;
  filesDone?: boolean;
  appliedBy?: string | null;
  appliedAt?: string | null;
}

/** Update the mutable fields of an input (never the owner's words, never the revision). */
export function updateAiInput(db: Db, id: string, patch: AiInputPatch, now: ISODateTime = nowIso()): ClaimAiInputRecord {
  if (patch.status && !AI_INPUT_STATUSES.includes(patch.status)) throw new ValidationError(`Unknown AI input status ${patch.status}`);
  if (patch.engine && !ENGINES.includes(patch.engine)) throw new ValidationError(`Unknown AI input engine ${patch.engine}`);
  const set: Record<string, unknown> = { updatedAt: now };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v;
  const row = db.update(claimAiInputs).set(set).where(eq(claimAiInputs.id, id)).returning().get();
  if (!row) throw new NotFoundError('claim_ai_inputs', id);
  return toInput(row);
}

/** revision + 1 (returns the new revision). */
export function bumpAiInputRevision(db: Db, id: string, now: ISODateTime = nowIso()): number {
  const row = db
    .update(claimAiInputs)
    .set({ revision: sql`${claimAiInputs.revision} + 1`, updatedAt: now })
    .where(eq(claimAiInputs.id, id))
    .returning({ revision: claimAiInputs.revision })
    .get();
  if (!row) throw new NotFoundError('claim_ai_inputs', id);
  return row.revision;
}

/** Compare-and-set the status: true only for the one caller that moved it from one of `from` to `to` (apply lock). */
export function casAiInputStatus(db: Db, id: string, from: AiInputStatus[], to: AiInputStatus, now: ISODateTime = nowIso()): boolean {
  const rows = db
    .update(claimAiInputs)
    .set({ status: to, updatedAt: now })
    .where(and(eq(claimAiInputs.id, id), inArray(claimAiInputs.status, from)))
    .returning({ id: claimAiInputs.id })
    .all();
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Log (append-only)
// ---------------------------------------------------------------------------

export interface AppendAiInputLogInput {
  inputId: string;
  claimId: string;
  kind: AiInputLogKind;
  actionKey?: string | null;
  action?: unknown;
  refs?: unknown;
  note?: string | null;
  actor: string;
  runId?: string | null;
  at?: ISODateTime;
  id?: string;
}

/** seq = max(seq) + 1 for the input, computed in the same statement. */
export function appendAiInputLog(db: Db, input: AppendAiInputLogInput): ClaimAiInputLogRecord {
  if (!AI_INPUT_LOG_KINDS.includes(input.kind)) throw new ValidationError(`Unknown AI input log kind ${input.kind}`);
  const id = input.id ?? randomUUID();
  const action = input.action === undefined ? null : JSON.stringify(input.action);
  const refs = input.refs === undefined ? null : JSON.stringify(input.refs);
  db.run(sql`INSERT INTO claim_ai_input_log (id, input_id, claim_id, seq, kind, action_key, action, refs, note, actor, run_id, at)
    SELECT ${id}, ${input.inputId}, ${input.claimId}, coalesce(max(seq), 0) + 1, ${input.kind}, ${input.actionKey ?? null}, ${action}, ${refs},
      ${input.note ? input.note.slice(0, 2000) : null}, ${input.actor}, ${input.runId ?? null}, ${input.at ?? nowIso()}
    FROM claim_ai_input_log WHERE input_id = ${input.inputId}`);
  const row = db.select().from(claimAiInputLog).where(eq(claimAiInputLog.id, id)).get();
  if (!row) throw new ValidationError('The log line could not be written');
  return toLog(row);
}

/** Append order (seq). */
export function listAiInputLog(db: Db, inputId: string): ClaimAiInputLogRecord[] {
  return db.select().from(claimAiInputLog).where(eq(claimAiInputLog.inputId, inputId)).orderBy(asc(claimAiInputLog.seq)).all().map(toLog);
}

/** Every log line of every input on a claim (or of every claim when `claimId` is null), oldest first, in a window. */
export function listAiInputLogForClaim(db: Db, claimId: string | null, opts: { since?: ISODateTime; until?: ISODateTime } = {}): ClaimAiInputLogRecord[] {
  const conds: SQL[] = [];
  if (claimId) conds.push(eq(claimAiInputLog.claimId, claimId));
  if (opts.since) conds.push(gte(claimAiInputLog.at, opts.since));
  if (opts.until) conds.push(lt(claimAiInputLog.at, opts.until));
  return db
    .select()
    .from(claimAiInputLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(claimAiInputLog.at), asc(claimAiInputLog.seq))
    .all()
    .map(toLog);
}

// ---------------------------------------------------------------------------
// Standing instructions (retire-only)
// ---------------------------------------------------------------------------

export interface CreateInstructionInput {
  claimId: string;
  text: string;
  appliesTo?: string[];
  effect?: unknown | null;
  activeFrom?: ISODateTime;
  until?: ISODateTime | null;
  sourceInputId?: string | null;
  sourceActionKey?: string | null;
  createdBy: string;
  now?: ISODateTime;
  id?: string;
}

export function createInstruction(db: Db, input: CreateInstructionInput): ClaimInstructionRecord {
  const text = input.text.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 1000) throw new ValidationError('An instruction is 1–1000 characters');
  const now = input.now ?? nowIso();
  const appliesTo = input.appliesTo?.length ? [...new Set(input.appliesTo)] : ['all'];
  const row = db
    .insert(claimInstructions)
    .values({
      id: input.id ?? randomUUID(),
      claimId: input.claimId,
      text,
      appliesTo,
      effect: input.effect ?? null,
      activeFrom: input.activeFrom ?? now,
      until: input.until ?? null,
      status: 'active',
      sourceInputId: input.sourceInputId ?? null,
      sourceActionKey: input.sourceActionKey ?? null,
      createdBy: input.createdBy,
      createdAt: now,
    })
    .returning()
    .get();
  return toInstruction(row);
}

export function getInstruction(db: Db, id: string): ClaimInstructionRecord | undefined {
  const r = db.select().from(claimInstructions).where(eq(claimInstructions.id, id)).get();
  return r ? toInstruction(r) : undefined;
}

export interface ListInstructionsQuery {
  claimId?: string;
  /** Default 'active'. */
  status?: 'active' | 'retired' | 'all';
  /** Only rows in force at this instant: active_from ≤ t and (until null or until > t). Implies status 'active'. */
  activeAt?: ISODateTime;
}

/** Newest first. */
export function listInstructions(db: Db, q: ListInstructionsQuery = {}): ClaimInstructionRecord[] {
  const conds: SQL[] = [];
  if (q.claimId) conds.push(eq(claimInstructions.claimId, q.claimId));
  const status = q.activeAt ? 'active' : (q.status ?? 'active');
  if (status !== 'all') conds.push(eq(claimInstructions.status, status));
  if (q.activeAt) {
    conds.push(sql`${claimInstructions.activeFrom} <= ${q.activeAt}`);
    conds.push(or(isNull(claimInstructions.until), sql`${claimInstructions.until} > ${q.activeAt}`)!);
  }
  return db
    .select()
    .from(claimInstructions)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(claimInstructions.createdAt), desc(sql`rowid`))
    .all()
    .map(toInstruction);
}

/** active → retired only (the trigger refuses anything else). */
export function retireInstruction(db: Db, id: string, opts: { by: string; reason?: string | null; now?: ISODateTime }): ClaimInstructionRecord {
  const cur = getInstruction(db, id);
  if (!cur) throw new NotFoundError('claim_instructions', id);
  if (cur.status === 'retired') throw new ValidationError('This instruction was already removed');
  const row = db
    .update(claimInstructions)
    .set({ status: 'retired', retiredBy: opts.by, retiredAt: opts.now ?? nowIso(), retiredReason: opts.reason ? opts.reason.slice(0, 500) : null })
    .where(and(eq(claimInstructions.id, id), eq(claimInstructions.status, 'active')))
    .returning()
    .get();
  if (!row) throw new ValidationError('This instruction was already removed');
  return toInstruction(row);
}

// ---------------------------------------------------------------------------
// Off-system correspondence (append-only)
// ---------------------------------------------------------------------------

export interface AppendCorrespondenceInput {
  claimId: string;
  direction: CorrespondenceDirection;
  channel?: CorrespondenceChannel;
  kind: string;
  templateId?: string | null;
  emailKind?: string | null;
  counterpartyRole?: string | null;
  counterpartyName?: string | null;
  at: ISODateTime;
  dateSource: CorrespondenceDateSource;
  subject?: string | null;
  summary: string;
  evidenceId?: string | null;
  eventId?: string | null;
  inputId?: string | null;
  bundleId?: string | null;
  bundleFileId?: string | null;
  supersedesId?: string | null;
  withdrawn?: boolean;
  createdBy: string;
  now?: ISODateTime;
  id?: string;
}

/** ON CONFLICT on (claim, evidence, direction) for a live record: the existing record is returned, `created: false`. */
export function appendCorrespondence(db: Db, input: AppendCorrespondenceInput): { record: ClaimCorrespondenceRecord; created: boolean } {
  if (input.direction !== 'out' && input.direction !== 'in') throw new ValidationError(`Unknown direction ${String(input.direction)}`);
  const channel = input.channel ?? 'unknown';
  if (!CORRESPONDENCE_CHANNELS.includes(channel)) throw new ValidationError(`Unknown channel ${channel}`);
  if (!CORRESPONDENCE_DATE_SOURCES.includes(input.dateSource)) throw new ValidationError(`Unknown date source ${input.dateSource}`);
  if (!input.kind) throw new ValidationError('A correspondence record needs its kind');
  const inserted = db
    .insert(claimCorrespondence)
    .values({
      id: input.id ?? randomUUID(),
      claimId: input.claimId,
      direction: input.direction,
      channel,
      kind: input.kind,
      templateId: input.templateId ?? null,
      emailKind: input.emailKind ?? null,
      counterpartyRole: input.counterpartyRole ?? null,
      counterpartyName: input.counterpartyName ?? null,
      at: input.at,
      dateSource: input.dateSource,
      subject: input.subject ?? null,
      summary: input.summary.slice(0, 1000),
      evidenceId: input.evidenceId ?? null,
      eventId: input.eventId ?? null,
      inputId: input.inputId ?? null,
      bundleId: input.bundleId ?? null,
      bundleFileId: input.bundleFileId ?? null,
      supersedesId: input.supersedesId ?? null,
      withdrawn: input.withdrawn ?? false,
      createdBy: input.createdBy,
      createdAt: input.now ?? nowIso(),
    })
    .onConflictDoNothing()
    .returning()
    .all();
  if (inserted[0]) return { record: toCorrespondence(inserted[0]), created: true };
  const existing = db
    .select()
    .from(claimCorrespondence)
    .where(
      and(
        eq(claimCorrespondence.claimId, input.claimId),
        eq(claimCorrespondence.evidenceId, input.evidenceId ?? ''),
        eq(claimCorrespondence.direction, input.direction),
        isNull(claimCorrespondence.supersedesId),
      ),
    )
    .get();
  if (!existing) throw new ValidationError('The correspondence record could not be written');
  return { record: toCorrespondence(existing), created: false };
}

export function getCorrespondence(db: Db, id: string): ClaimCorrespondenceRecord | undefined {
  const r = db.select().from(claimCorrespondence).where(eq(claimCorrespondence.id, id)).get();
  return r ? toCorrespondence(r) : undefined;
}

/** Withdraw a live record: a new row with `supersedes_id` = the old id and `withdrawn = 1`. */
export function withdrawCorrespondence(db: Db, id: string, opts: { by: string; now?: ISODateTime }): ClaimCorrespondenceRecord {
  const cur = getCorrespondence(db, id);
  if (!cur) throw new NotFoundError('claim_correspondence', id);
  const live = listCorrespondence(db, cur.claimId, { includeWithdrawn: false }).some((r) => r.id === id);
  if (!live) throw new ValidationError('This record was already withdrawn');
  const row = db
    .insert(claimCorrespondence)
    .values({
      id: randomUUID(),
      claimId: cur.claimId,
      direction: cur.direction,
      channel: cur.channel,
      kind: cur.kind,
      templateId: cur.templateId ?? null,
      emailKind: cur.emailKind ?? null,
      counterpartyRole: cur.counterpartyRole ?? null,
      counterpartyName: cur.counterpartyName ?? null,
      at: cur.at,
      dateSource: cur.dateSource,
      subject: cur.subject ?? null,
      summary: cur.summary,
      evidenceId: cur.evidenceId ?? null,
      eventId: cur.eventId ?? null,
      inputId: cur.inputId ?? null,
      bundleId: cur.bundleId ?? null,
      bundleFileId: cur.bundleFileId ?? null,
      supersedesId: cur.id,
      withdrawn: true,
      createdBy: opts.by,
      createdAt: opts.now ?? nowIso(),
    })
    .returning()
    .get();
  return toCorrespondence(row);
}

/**
 * Records of a claim ordered by `at`. Default: live rows only — per chain the newest row, withdrawn chains dropped.
 * `includeWithdrawn: true` returns every row (the history).
 */
export function listCorrespondence(db: Db, claimId: string, opts: { direction?: CorrespondenceDirection; includeWithdrawn?: boolean } = {}): ClaimCorrespondenceRecord[] {
  const conds: SQL[] = [eq(claimCorrespondence.claimId, claimId)];
  if (opts.direction) conds.push(eq(claimCorrespondence.direction, opts.direction));
  const all = db.select().from(claimCorrespondence).where(and(...conds)).orderBy(asc(claimCorrespondence.at), asc(sql`rowid`)).all().map(toCorrespondence);
  if (opts.includeWithdrawn) return all;
  const superseded = new Set(all.map((r) => r.supersedesId).filter((x): x is string => Boolean(x)));
  return all.filter((r) => !superseded.has(r.id) && !r.withdrawn);
}
