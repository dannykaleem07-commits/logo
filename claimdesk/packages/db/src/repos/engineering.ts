import { desc, eq } from 'drizzle-orm';
import type { EngineerReport, Estimate, Id, ISODateTime, PavAssessment } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { engineerReports, estimates, pavAssessments, type EngineerReportRow, type EstimateRow, type PavAssessmentRow } from '../schema.js';
import { compact, denull, newId, nowIso } from '../util.js';

// ---------------------------------------------------------------------------
// PAV assessments
// ---------------------------------------------------------------------------

export type CreatePavInput = Omit<PavAssessment, 'id' | 'createdAt'> & { id?: Id; createdAt?: ISODateTime };

function toPav(row: PavAssessmentRow): PavAssessment {
  return denull(row);
}

export function createPav(db: Db, input: CreatePavInput): PavAssessment {
  for (const k of ['medianPence', 'iqrLowPence', 'iqrHighPence', 'pavPence'] as const) {
    if (!Number.isInteger(input[k])) throw new ValidationError(`${k} must be integer pence`);
  }
  if (input.pavPence !== input.medianPence && !input.overrideReason?.trim()) {
    throw new ValidationError('pavPence differs from the median: overrideReason is required (BLUEPRINT §4.4 step 5)');
  }
  const id = input.id ?? newId();
  db.insert(pavAssessments)
    .values({ ...input, id, createdAt: input.createdAt ?? nowIso() })
    .run();
  return requirePav(db, id);
}

export function getPav(db: Db, id: Id): PavAssessment | undefined {
  const row = db.select().from(pavAssessments).where(eq(pavAssessments.id, id)).get();
  return row ? toPav(row) : undefined;
}

export function requirePav(db: Db, id: Id): PavAssessment {
  const p = getPav(db, id);
  if (!p) throw new NotFoundError('pav assessment', id);
  return p;
}

export function getLatestPav(db: Db, claimId: Id): PavAssessment | undefined {
  const row = db.select().from(pavAssessments).where(eq(pavAssessments.claimId, claimId)).orderBy(desc(pavAssessments.createdAt)).limit(1).get();
  return row ? toPav(row) : undefined;
}

export function listPav(db: Db, claimId: Id): PavAssessment[] {
  return db.select().from(pavAssessments).where(eq(pavAssessments.claimId, claimId)).orderBy(desc(pavAssessments.createdAt)).all().map(toPav);
}

export function approvePav(db: Db, id: Id, approvedBy: Id, approvedAt: ISODateTime = nowIso()): PavAssessment {
  requirePav(db, id);
  db.update(pavAssessments).set({ approvedBy, approvedAt }).where(eq(pavAssessments.id, id)).run();
  return requirePav(db, id);
}

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

export type CreateEstimateInput = Omit<Estimate, 'id' | 'createdAt'> & { id?: Id; createdAt?: ISODateTime };
export type EstimatePatch = Partial<Omit<Estimate, 'id' | 'claimId' | 'createdAt'>>;

function toEstimate(row: EstimateRow): Estimate {
  const { updatedAt: _u, ...rest } = row;
  return denull(rest);
}

export function createEstimate(db: Db, input: CreateEstimateInput): Estimate {
  if (!Number.isInteger(input.labourRatePence) || !Number.isInteger(input.paintRatePence)) throw new ValidationError('labour/paint rates must be integer pence');
  const id = input.id ?? newId();
  const now = nowIso();
  db.insert(estimates)
    .values({ ...input, id, createdAt: input.createdAt ?? now, updatedAt: now })
    .run();
  return requireEstimate(db, id);
}

export function getEstimate(db: Db, id: Id): Estimate | undefined {
  const row = db.select().from(estimates).where(eq(estimates.id, id)).get();
  return row ? toEstimate(row) : undefined;
}

export function requireEstimate(db: Db, id: Id): Estimate {
  const e = getEstimate(db, id);
  if (!e) throw new NotFoundError('estimate', id);
  return e;
}

export function getLatestEstimate(db: Db, claimId: Id): Estimate | undefined {
  const row = db.select().from(estimates).where(eq(estimates.claimId, claimId)).orderBy(desc(estimates.createdAt)).limit(1).get();
  return row ? toEstimate(row) : undefined;
}

export function listEstimates(db: Db, claimId: Id): Estimate[] {
  return db.select().from(estimates).where(eq(estimates.claimId, claimId)).orderBy(desc(estimates.createdAt)).all().map(toEstimate);
}

/** Update lines/totals/reconciliation/approval. Totals are computed by the domain `estimate.computeTotals`; stored as given. */
export function updateEstimate(db: Db, id: Id, patch: EstimatePatch): Estimate {
  requireEstimate(db, id);
  db.update(estimates)
    .set({ ...compact(patch), updatedAt: nowIso() })
    .where(eq(estimates.id, id))
    .run();
  return requireEstimate(db, id);
}

// ---------------------------------------------------------------------------
// Engineer reports
// ---------------------------------------------------------------------------

export type CreateEngineerReportInput = Omit<EngineerReport, 'id' | 'photoEvidenceIds'> & { id?: Id; photoEvidenceIds?: Id[]; createdAt?: ISODateTime };
export type EngineerReportPatch = Partial<Omit<EngineerReport, 'id' | 'claimId'>>;

function toReport(row: EngineerReportRow): EngineerReport {
  const { createdAt: _c, updatedAt: _u, ...rest } = row;
  return denull(rest);
}

export function createEngineerReport(db: Db, input: CreateEngineerReportInput): EngineerReport {
  if (!Number.isInteger(input.feePence) || input.feePence < 0) throw new ValidationError('feePence must be non-negative integer pence');
  const id = input.id ?? newId();
  const now = nowIso();
  const { createdAt, ...rest } = input;
  db.insert(engineerReports)
    .values({ ...rest, id, photoEvidenceIds: input.photoEvidenceIds ?? [], createdAt: createdAt ?? now, updatedAt: now })
    .run();
  return requireEngineerReport(db, id);
}

export function getEngineerReport(db: Db, id: Id): EngineerReport | undefined {
  const row = db.select().from(engineerReports).where(eq(engineerReports.id, id)).get();
  return row ? toReport(row) : undefined;
}

export function requireEngineerReport(db: Db, id: Id): EngineerReport {
  const r = getEngineerReport(db, id);
  if (!r) throw new NotFoundError('engineer report', id);
  return r;
}

/** Latest report by creation; issued reports first. */
export function getLatestEngineerReport(db: Db, claimId: Id): EngineerReport | undefined {
  const row = db.select().from(engineerReports).where(eq(engineerReports.claimId, claimId)).orderBy(desc(engineerReports.createdAt)).limit(1).get();
  return row ? toReport(row) : undefined;
}

export function listEngineerReports(db: Db, claimId: Id): EngineerReport[] {
  return db.select().from(engineerReports).where(eq(engineerReports.claimId, claimId)).orderBy(desc(engineerReports.createdAt)).all().map(toReport);
}

export function updateEngineerReport(db: Db, id: Id, patch: EngineerReportPatch): EngineerReport {
  requireEngineerReport(db, id);
  db.update(engineerReports)
    .set({ ...compact(patch), updatedAt: nowIso() })
    .where(eq(engineerReports.id, id))
    .run();
  return requireEngineerReport(db, id);
}

/** Mark the report issued (starts the storage report+48h clock via the `report_issued` event appended by the API). */
export function issueEngineerReport(db: Db, id: Id, input: { issuedAt?: ISODateTime; documentId?: Id } = {}): EngineerReport {
  return updateEngineerReport(db, id, { issuedAt: input.issuedAt ?? nowIso(), documentId: input.documentId });
}
