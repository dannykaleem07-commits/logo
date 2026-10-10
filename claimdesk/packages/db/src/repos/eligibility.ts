// owned by ap-clash
/**
 * Repository for driver_profiles and eligibility_assessments (docs/SUPREME-AUTOPILOT.md §F). The tables exist from
 * migration 0013_autopilot; `eligibility_assessments` is append-only (0013 triggers refuse UPDATE and DELETE).
 * (claim_hire_needs lives in repos/bookings.ts: getHireNeeds / putHireNeeds.)
 */
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { DriverProfile, EligibilityAssessmentKind, EligibilityAssessmentRecord, Id, ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { driverProfiles, eligibilityAssessments, type EligibilityAssessmentRow } from '../schema.js';
import { newId, nowIso } from '../util.js';

export function getDriverProfile(db: Db, partyId: Id): DriverProfile | undefined {
  const row = db.select().from(driverProfiles).where(eq(driverProfiles.partyId, partyId)).get();
  return row ? { ...row.profile, partyId: row.partyId, source: row.source, updatedBy: row.updatedBy, updatedAt: row.updatedAt } : undefined;
}

export function listDriverProfiles(db: Db, partyIds?: readonly Id[]): DriverProfile[] {
  const q = db.select().from(driverProfiles);
  const rows = partyIds ? (partyIds.length ? q.where(inArray(driverProfiles.partyId, [...partyIds])).all() : []) : q.all();
  return rows.map((row) => ({ ...row.profile, partyId: row.partyId, source: row.source, updatedBy: row.updatedBy, updatedAt: row.updatedAt }));
}

/** Insert or replace a party's driver profile (the API audits the change and keeps the before/after). */
export function putDriverProfile(db: Db, profile: DriverProfile): DriverProfile {
  const at = profile.updatedAt || nowIso();
  const value = { ...profile, updatedAt: at };
  db.insert(driverProfiles)
    .values({ partyId: profile.partyId, profile: value, source: profile.source, updatedBy: profile.updatedBy, updatedAt: at })
    .onConflictDoUpdate({ target: driverProfiles.partyId, set: { profile: value, source: profile.source, updatedBy: profile.updatedBy, updatedAt: at } })
    .run();
  return getDriverProfile(db, profile.partyId)!;
}

function toAssessment(row: EligibilityAssessmentRow): EligibilityAssessmentRecord {
  return {
    id: row.id,
    claimId: row.claimId,
    ...(row.partyId ? { partyId: row.partyId } : {}),
    ...(row.policyId ? { policyId: row.policyId } : {}),
    kind: row.kind,
    outcome: row.outcome,
    reasons: row.reasons,
    inputsSha256: row.inputsSha256,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export type NewEligibilityAssessment = Omit<EligibilityAssessmentRecord, 'id' | 'createdAt'> & { id?: Id; createdAt?: ISODateTime };

/** Append one assessment (append-only). */
export function appendEligibilityAssessment(db: Db, input: NewEligibilityAssessment): EligibilityAssessmentRecord {
  const id = input.id ?? newId();
  db.insert(eligibilityAssessments)
    .values({
      id,
      claimId: input.claimId,
      partyId: input.partyId ?? null,
      policyId: input.policyId ?? null,
      kind: input.kind,
      outcome: input.outcome,
      reasons: input.reasons ?? [],
      inputsSha256: input.inputsSha256,
      createdBy: input.createdBy,
      createdAt: input.createdAt ?? nowIso(),
    })
    .run();
  return toAssessment(db.select().from(eligibilityAssessments).where(eq(eligibilityAssessments.id, id)).get()!);
}

export function listEligibilityAssessments(db: Db, claimId: Id, filter: { kind?: EligibilityAssessmentKind; partyId?: Id } = {}): EligibilityAssessmentRecord[] {
  const where: SQL[] = [eq(eligibilityAssessments.claimId, claimId)];
  if (filter.kind) where.push(eq(eligibilityAssessments.kind, filter.kind));
  if (filter.partyId) where.push(eq(eligibilityAssessments.partyId, filter.partyId));
  return db.select().from(eligibilityAssessments).where(and(...where)).orderBy(asc(eligibilityAssessments.createdAt), asc(eligibilityAssessments.id)).all().map(toAssessment);
}

/** The latest assessment of a kind on a claim (optionally for one party). */
export function latestEligibilityAssessment(db: Db, claimId: Id, kind: EligibilityAssessmentKind, partyId?: Id): EligibilityAssessmentRecord | undefined {
  const where: SQL[] = [eq(eligibilityAssessments.claimId, claimId), eq(eligibilityAssessments.kind, kind)];
  if (partyId) where.push(eq(eligibilityAssessments.partyId, partyId));
  const row = db.select().from(eligibilityAssessments).where(and(...where)).orderBy(desc(eligibilityAssessments.createdAt), desc(eligibilityAssessments.id)).get();
  return row ? toAssessment(row) : undefined;
}
