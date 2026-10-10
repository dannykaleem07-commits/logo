// owned by ap-autopilot
/**
 * Repository for claim_autopilot, autopilot_log and hire_offers (docs/SUPREME-AUTOPILOT.md §A.2, §A.7, §D.2;
 * migration 0013_autopilot). autopilot_log is append-only (database triggers refuse UPDATE / DELETE).
 */
import { and, asc, desc, eq, gte, inArray, lt, lte, or, isNull, sql, type SQL } from 'drizzle-orm';
import type {
  AutopilotLogEntry,
  AutopilotOverride,
  AutopilotPlan,
  AutopilotStepId,
  ClaimAutopilotMode,
  ClaimAutopilotRecord,
  HireOffer,
  HireOfferChannel,
  HireOfferResponse,
  HireOfferStatus,
  HireOfferTerms,
  ISODateTime,
  Id,
  StepRefs,
} from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { autopilotLog, claimAutopilot, hireOffers, outbox, type AutopilotLogRow, type ClaimAutopilotRow, type HireOfferRow } from '../schema.js';
import { newId, nowIso } from '../util.js';

// ---------------------------------------------------------------------------
// claim_autopilot
// ---------------------------------------------------------------------------

function toRecord(row: ClaimAutopilotRow): ClaimAutopilotRecord {
  return {
    claimId: row.claimId,
    mode: row.mode,
    ...(row.pausedBy ? { pausedBy: row.pausedBy } : {}),
    ...(row.pausedReason ? { pausedReason: row.pausedReason } : {}),
    ...(row.pausedAt ? { pausedAt: row.pausedAt } : {}),
    stepOverrides: (row.stepOverrides ?? {}) as ClaimAutopilotRecord['stepOverrides'],
    ...(row.stage ? { stage: row.stage } : {}),
    ...(row.plan ? { plan: row.plan } : {}),
    ...(row.planHash ? { planHash: row.planHash } : {}),
    ...(row.planVersion ? { planVersion: row.planVersion } : {}),
    ...(row.lastEvaluatedAt ? { lastEvaluatedAt: row.lastEvaluatedAt } : {}),
    ...(row.nextCheckAt ? { nextCheckAt: row.nextCheckAt } : {}),
    updatedAt: row.updatedAt,
  };
}

export function getClaimAutopilot(db: Db, claimId: Id): ClaimAutopilotRecord | undefined {
  const row = db.select().from(claimAutopilot).where(eq(claimAutopilot.claimId, claimId)).get();
  return row ? toRecord(row) : undefined;
}

/** The claim's row, created with `mode` (Settings > Autopilot "new claims") when missing. */
export function ensureClaimAutopilot(db: Db, claimId: Id, mode: ClaimAutopilotMode, at: ISODateTime = nowIso()): ClaimAutopilotRecord {
  const existing = getClaimAutopilot(db, claimId);
  if (existing) return existing;
  db.insert(claimAutopilot).values({ claimId, mode, stepOverrides: {}, updatedAt: at }).onConflictDoNothing().run();
  return getClaimAutopilot(db, claimId)!;
}

export function setClaimAutopilotMode(db: Db, claimId: Id, mode: ClaimAutopilotMode, by: { userId: string; reason?: string }, at: ISODateTime = nowIso()): ClaimAutopilotRecord {
  ensureClaimAutopilot(db, claimId, mode, at);
  db.update(claimAutopilot)
    .set(mode === 'on' ? { mode, pausedBy: null, pausedReason: null, pausedAt: null, updatedAt: at } : { mode, pausedBy: by.userId, pausedReason: by.reason ?? null, pausedAt: at, updatedAt: at })
    .where(eq(claimAutopilot.claimId, claimId))
    .run();
  return getClaimAutopilot(db, claimId)!;
}

/** Set (or clear with null) one step override. */
export function setStepOverride(db: Db, claimId: Id, stepId: AutopilotStepId, override: AutopilotOverride | null, at: ISODateTime = nowIso()): ClaimAutopilotRecord {
  const rec = getClaimAutopilot(db, claimId);
  if (!rec) throw new NotFoundError('claim_autopilot', claimId);
  const next: Record<string, AutopilotOverride> = { ...(rec.stepOverrides as Record<string, AutopilotOverride>) };
  if (override) next[stepId] = override;
  else delete next[stepId];
  db.update(claimAutopilot).set({ stepOverrides: next, updatedAt: at }).where(eq(claimAutopilot.claimId, claimId)).run();
  return getClaimAutopilot(db, claimId)!;
}

/** Store the evaluated plan. */
export function saveAutopilotPlan(db: Db, claimId: Id, plan: AutopilotPlan, at: ISODateTime = nowIso()): void {
  db.update(claimAutopilot)
    .set({ plan, planHash: plan.planHash, planVersion: plan.version, stage: plan.stage, lastEvaluatedAt: plan.evaluatedAt, nextCheckAt: plan.nextCheckAt, updatedAt: at })
    .where(eq(claimAutopilot.claimId, claimId))
    .run();
}

/** Claims whose next check is due, or never evaluated (the sweep's first pass). */
export function listClaimAutopilotDue(db: Db, now: ISODateTime, limit = 200): ClaimAutopilotRecord[] {
  return db
    .select()
    .from(claimAutopilot)
    .where(and(inArray(claimAutopilot.mode, ['on', 'paused']), or(isNull(claimAutopilot.nextCheckAt), lte(claimAutopilot.nextCheckAt, now))))
    .orderBy(asc(claimAutopilot.nextCheckAt))
    .limit(limit)
    .all()
    .map(toRecord);
}

export function listClaimAutopilot(db: Db): ClaimAutopilotRecord[] {
  return db.select().from(claimAutopilot).all().map(toRecord);
}

// ---------------------------------------------------------------------------
// autopilot_log (append-only)
// ---------------------------------------------------------------------------

function toLog(row: AutopilotLogRow): AutopilotLogEntry {
  return {
    id: row.id,
    claimId: row.claimId,
    stepId: row.stepId,
    ...(row.fromStatus ? { fromStatus: row.fromStatus as AutopilotLogEntry['fromStatus'] } : {}),
    toStatus: row.toStatus as AutopilotLogEntry['toStatus'],
    ...(row.action ? { action: row.action } : {}),
    actor: row.actor,
    ...(row.decision !== null && row.decision !== undefined ? { decision: row.decision } : {}),
    ...(row.jobId ? { jobId: row.jobId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.needsYouId ? { needsYouId: row.needsYouId } : {}),
    refs: (row.refs ?? {}) as StepRefs,
    ...(row.note ? { note: row.note } : {}),
    at: row.at,
  };
}

export type NewAutopilotLogEntry = Omit<AutopilotLogEntry, 'id' | 'refs'> & { id?: Id; refs?: StepRefs };

export function appendAutopilotLog(db: Db, input: NewAutopilotLogEntry): AutopilotLogEntry {
  if (!input.stepId) throw new ValidationError('stepId is required');
  const id = input.id ?? newId();
  db.insert(autopilotLog)
    .values({
      id,
      claimId: input.claimId,
      stepId: input.stepId,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus,
      action: input.action ?? null,
      actor: input.actor,
      decision: (input.decision ?? null) as never,
      jobId: input.jobId ?? null,
      runId: input.runId ?? null,
      needsYouId: input.needsYouId ?? null,
      refs: input.refs ?? {},
      note: input.note ?? null,
      at: input.at,
    })
    .run();
  return toLog(db.select().from(autopilotLog).where(eq(autopilotLog.id, id)).get()!);
}

export interface AutopilotLogFilter {
  claimId?: Id;
  stepId?: string;
  action?: string;
  from?: ISODateTime;
  to?: ISODateTime;
  limit?: number;
  order?: 'asc' | 'desc';
}

export function listAutopilotLog(db: Db, f: AutopilotLogFilter = {}): AutopilotLogEntry[] {
  const where: SQL[] = [];
  if (f.claimId) where.push(eq(autopilotLog.claimId, f.claimId));
  if (f.stepId) where.push(eq(autopilotLog.stepId, f.stepId));
  if (f.action) where.push(eq(autopilotLog.action, f.action));
  if (f.from) where.push(gte(autopilotLog.at, f.from));
  if (f.to) where.push(lt(autopilotLog.at, f.to));
  const q = db.select().from(autopilotLog).where(where.length ? and(...where) : undefined);
  const ordered = f.order === 'desc' ? q.orderBy(desc(autopilotLog.at), sql`rowid DESC`) : q.orderBy(asc(autopilotLog.at), sql`rowid ASC`);
  return (f.limit ? ordered.limit(f.limit) : ordered).all().map(toLog);
}

/** When the runner last acted on each step of a claim (log rows with an action). */
export function lastAutopilotActions(db: Db, claimId: Id): Partial<Record<string, ISODateTime>> {
  const out: Record<string, ISODateTime> = {};
  for (const e of listAutopilotLog(db, { claimId })) if (e.action && e.action !== 'evaluate' && (!out[e.stepId] || e.at > out[e.stepId]!)) out[e.stepId] = e.at;
  return out;
}

// ---------------------------------------------------------------------------
// hire_offers
// ---------------------------------------------------------------------------

function toOffer(row: HireOfferRow): HireOffer {
  return {
    id: row.id,
    claimId: row.claimId,
    reservationId: row.reservationId,
    status: row.status,
    channel: row.channel,
    terms: row.terms,
    termsSha256: row.termsSha256,
    ...(row.outboxId ? { outboxId: row.outboxId } : {}),
    authorisedBy: row.authorisedBy,
    ...(row.sentAt ? { sentAt: row.sentAt } : {}),
    expiresAt: row.expiresAt,
    ...(row.response ? { response: row.response } : {}),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface NewHireOffer {
  id?: Id;
  claimId: Id;
  reservationId: Id;
  channel: HireOfferChannel;
  terms: HireOfferTerms;
  termsSha256: string;
  outboxId?: Id | null;
  authorisedBy: string;
  expiresAt: ISODateTime;
  createdBy: string;
  at: ISODateTime;
}

export function createHireOffer(db: Db, input: NewHireOffer): HireOffer {
  const id = input.id ?? newId();
  db.insert(hireOffers)
    .values({
      id,
      claimId: input.claimId,
      reservationId: input.reservationId,
      status: 'draft',
      channel: input.channel,
      terms: input.terms,
      termsSha256: input.termsSha256,
      outboxId: input.outboxId ?? null,
      authorisedBy: input.authorisedBy,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
      createdAt: input.at,
      updatedAt: input.at,
    })
    .run();
  return requireHireOffer(db, id);
}

export function getHireOffer(db: Db, id: Id): HireOffer | undefined {
  const row = db.select().from(hireOffers).where(eq(hireOffers.id, id)).get();
  return row ? toOffer(row) : undefined;
}

export function requireHireOffer(db: Db, id: Id): HireOffer {
  const o = getHireOffer(db, id);
  if (!o) throw new NotFoundError('hire offer', id);
  return o;
}

export function getHireOfferByOutbox(db: Db, outboxId: Id): HireOffer | undefined {
  const row = db.select().from(hireOffers).where(eq(hireOffers.outboxId, outboxId)).get();
  return row ? toOffer(row) : undefined;
}

export function listHireOffers(db: Db, filter: { claimId?: Id; reservationId?: Id; status?: HireOfferStatus | HireOfferStatus[] } = {}): HireOffer[] {
  const where: SQL[] = [];
  if (filter.claimId) where.push(eq(hireOffers.claimId, filter.claimId));
  if (filter.reservationId) where.push(eq(hireOffers.reservationId, filter.reservationId));
  if (filter.status) where.push(inArray(hireOffers.status, Array.isArray(filter.status) ? filter.status : [filter.status]));
  return db.select().from(hireOffers).where(where.length ? and(...where) : undefined).orderBy(asc(hireOffers.createdAt), asc(hireOffers.id)).all().map(toOffer);
}

export interface HireOfferPatch {
  status?: HireOfferStatus;
  outboxId?: Id | null;
  sentAt?: ISODateTime;
  expiresAt?: ISODateTime;
  response?: HireOfferResponse;
  respondedAt?: ISODateTime;
  authorisedBy?: string;
  terms?: HireOfferTerms;
  termsSha256?: string;
}

export function updateHireOffer(db: Db, id: Id, patch: HireOfferPatch, at: ISODateTime = nowIso()): HireOffer {
  requireHireOffer(db, id);
  const set: Partial<typeof hireOffers.$inferInsert> = { updatedAt: at };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.outboxId !== undefined) set.outboxId = patch.outboxId;
  if (patch.sentAt !== undefined) set.sentAt = patch.sentAt;
  if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
  if (patch.response !== undefined) set.response = patch.response;
  if (patch.respondedAt !== undefined) set.respondedAt = patch.respondedAt;
  if (patch.authorisedBy !== undefined) set.authorisedBy = patch.authorisedBy;
  if (patch.terms !== undefined) set.terms = patch.terms;
  if (patch.termsSha256 !== undefined) set.termsSha256 = patch.termsSha256;
  db.update(hireOffers).set(set).where(eq(hireOffers.id, id)).run();
  return requireHireOffer(db, id);
}

/** Offers sent automatically (authorised by the green test) since an instant — the daily auto-offer cap (§A.8). */
export function countAutoOffersSince(db: Db, since: ISODateTime): number {
  return db
    .select({ id: hireOffers.id })
    .from(hireOffers)
    .where(and(eq(hireOffers.authorisedBy, 'autopilot_green'), gte(hireOffers.createdAt, since), inArray(hireOffers.status, ['draft', 'sent', 'accepted', 'declined', 'expired'])))
    .all().length;
}

// ---------------------------------------------------------------------------
// outbox.autopilot_step_id (column added by 0013_autopilot)
// ---------------------------------------------------------------------------

/** Tag an outbox row with the step that created it (only when not tagged yet). */
export function tagOutboxStep(db: Db, outboxId: Id, stepId: string): void {
  db.update(outbox).set({ autopilotStepId: stepId }).where(and(eq(outbox.id, outboxId), isNull(outbox.autopilotStepId))).run();
}
