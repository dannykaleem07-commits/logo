import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import type { FleetUnit, Id, InsurancePolicy, PenaltyNotice } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { fleetUnits, hireAgreements, insurancePolicies, penaltyNotices, vehicles, type FleetUnitRow, type InsurancePolicyRow, type PenaltyNoticeRow } from '../schema.js';
import { compact, denull, newId, normaliseRegistration, nowIso } from '../util.js';

// ---------------------------------------------------------------------------
// Fleet units
// ---------------------------------------------------------------------------

export type CreateFleetUnitInput = Omit<FleetUnit, 'id' | 'status' | 'keeperAddressCurrent'> & { id?: Id; status?: FleetUnit['status']; keeperAddressCurrent?: boolean };
export type FleetUnitPatch = Partial<Omit<FleetUnit, 'id'>>;

function toUnit(row: FleetUnitRow): FleetUnit {
  const { createdAt: _c, updatedAt: _u, ...rest } = row;
  return denull(rest);
}

export function createFleetUnit(db: Db, input: CreateFleetUnitInput): FleetUnit {
  if (!Number.isInteger(input.dailyRatePence) || input.dailyRatePence <= 0) throw new ValidationError('dailyRatePence must be positive integer pence');
  if (!input.declaredUses?.length) throw new ValidationError('declaredUses must name at least one class of use (credit_hire | self_drive | pco)');
  const vehicle = db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.id, input.vehicleId)).get();
  if (!vehicle) throw new NotFoundError('vehicle', input.vehicleId);
  const id = input.id ?? newId();
  const now = nowIso();
  db.insert(fleetUnits)
    .values({ ...input, id, status: input.status ?? 'available', keeperAddressCurrent: input.keeperAddressCurrent ?? true, createdAt: now, updatedAt: now })
    .run();
  return requireFleetUnit(db, id);
}

export function getFleetUnit(db: Db, id: Id): FleetUnit | undefined {
  const row = db.select().from(fleetUnits).where(eq(fleetUnits.id, id)).get();
  return row ? toUnit(row) : undefined;
}

export function requireFleetUnit(db: Db, id: Id): FleetUnit {
  const u = getFleetUnit(db, id);
  if (!u) throw new NotFoundError('fleet unit', id);
  return u;
}

export function listFleetUnits(db: Db, filter: { status?: FleetUnit['status'] | FleetUnit['status'][] } = {}): FleetUnit[] {
  const where: SQL[] = [];
  if (filter.status) where.push(Array.isArray(filter.status) ? inArray(fleetUnits.status, filter.status) : eq(fleetUnits.status, filter.status));
  return db
    .select()
    .from(fleetUnits)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(fleetUnits.gtaGroup))
    .all()
    .map(toUnit);
}

export function updateFleetUnit(db: Db, id: Id, patch: FleetUnitPatch): FleetUnit {
  requireFleetUnit(db, id);
  db.update(fleetUnits)
    .set({ ...compact(patch), updatedAt: nowIso() })
    .where(eq(fleetUnits.id, id))
    .run();
  return requireFleetUnit(db, id);
}

/** Hard delete. Refused while any hire agreement references the unit (mark it 'disposed' instead). */
export function deleteFleetUnit(db: Db, id: Id): void {
  requireFleetUnit(db, id);
  const used = db.select({ id: hireAgreements.id }).from(hireAgreements).where(eq(hireAgreements.fleetUnitId, id)).limit(1).get();
  if (used) throw new ValidationError(`fleet unit ${id} has hire agreements; set status 'disposed' instead of deleting`);
  db.delete(penaltyNotices).where(eq(penaltyNotices.fleetUnitId, id)).run();
  db.delete(fleetUnits).where(eq(fleetUnits.id, id)).run();
}

/** Fleet units whose vehicle carries this registration (cross-file hard stop: a fleet unit used as a "client" vehicle). */
export function findFleetUnitsByRegistration(db: Db, registration: string): FleetUnit[] {
  const reg = normaliseRegistration(registration);
  if (!reg) return [];
  const vehicleIds = db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.registration, reg)).all().map((r) => r.id);
  if (!vehicleIds.length) return [];
  return db.select().from(fleetUnits).where(inArray(fleetUnits.vehicleId, vehicleIds)).all().map(toUnit);
}

// ---------------------------------------------------------------------------
// Insurance policies
// ---------------------------------------------------------------------------

export type CreatePolicyInput = Omit<InsurancePolicy, 'id'> & { id?: Id };

function toPolicy(row: InsurancePolicyRow): InsurancePolicy {
  const { createdAt: _c, ...rest } = row;
  return denull(rest);
}

export function createPolicy(db: Db, input: CreatePolicyInput): InsurancePolicy {
  if (!input.coveredUses?.length) throw new ValidationError('coveredUses must name at least one class of use');
  if (input.endDate < input.startDate) throw new ValidationError('policy endDate is before startDate');
  const id = input.id ?? newId();
  db.insert(insurancePolicies)
    .values({ ...input, id, createdAt: nowIso() })
    .run();
  return requirePolicy(db, id);
}

export function getPolicy(db: Db, id: Id): InsurancePolicy | undefined {
  const row = db.select().from(insurancePolicies).where(eq(insurancePolicies.id, id)).get();
  return row ? toPolicy(row) : undefined;
}

export function requirePolicy(db: Db, id: Id): InsurancePolicy {
  const p = getPolicy(db, id);
  if (!p) throw new NotFoundError('insurance policy', id);
  return p;
}

export function listPolicies(db: Db): InsurancePolicy[] {
  return db.select().from(insurancePolicies).orderBy(asc(insurancePolicies.endDate)).all().map(toPolicy);
}

export function updatePolicy(db: Db, id: Id, patch: Partial<Omit<InsurancePolicy, 'id'>>): InsurancePolicy {
  requirePolicy(db, id);
  db.update(insurancePolicies).set(compact(patch)).where(eq(insurancePolicies.id, id)).run();
  return requirePolicy(db, id);
}

// ---------------------------------------------------------------------------
// Penalty notices (PCN / NIP / s.172)
// ---------------------------------------------------------------------------

export type CreatePenaltyInput = Omit<PenaltyNotice, 'id' | 'stage' | 'documentIds'> & { id?: Id; stage?: PenaltyNotice['stage']; documentIds?: Id[] };
export type PenaltyPatch = Partial<Omit<PenaltyNotice, 'id' | 'fleetUnitId'>>;

function toPenalty(row: PenaltyNoticeRow): PenaltyNotice {
  const { createdAt: _c, updatedAt: _u, ...rest } = row;
  return denull(rest);
}

export function createPenalty(db: Db, input: CreatePenaltyInput): PenaltyNotice {
  if (!Number.isInteger(input.amountPence) || input.amountPence < 0) throw new ValidationError('amountPence must be non-negative integer pence');
  requireFleetUnit(db, input.fleetUnitId);
  const id = input.id ?? newId();
  const now = nowIso();
  db.insert(penaltyNotices)
    .values({ ...input, id, stage: input.stage ?? 'received', documentIds: input.documentIds ?? [], createdAt: now, updatedAt: now })
    .run();
  return requirePenalty(db, id);
}

export function getPenalty(db: Db, id: Id): PenaltyNotice | undefined {
  const row = db.select().from(penaltyNotices).where(eq(penaltyNotices.id, id)).get();
  return row ? toPenalty(row) : undefined;
}

export function requirePenalty(db: Db, id: Id): PenaltyNotice {
  const p = getPenalty(db, id);
  if (!p) throw new NotFoundError('penalty notice', id);
  return p;
}

export function listPenalties(db: Db, filter: { fleetUnitId?: Id; stage?: PenaltyNotice['stage'] | PenaltyNotice['stage'][]; open?: boolean } = {}): PenaltyNotice[] {
  const where: SQL[] = [];
  if (filter.fleetUnitId) where.push(eq(penaltyNotices.fleetUnitId, filter.fleetUnitId));
  if (filter.stage) where.push(Array.isArray(filter.stage) ? inArray(penaltyNotices.stage, filter.stage) : eq(penaltyNotices.stage, filter.stage));
  if (filter.open) where.push(inArray(penaltyNotices.stage, ['received', 'hirer_identified', 'representations', 'appeal', 'escalated']));
  return db
    .select()
    .from(penaltyNotices)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(penaltyNotices.responseDeadline))
    .all()
    .map(toPenalty);
}

export function updatePenalty(db: Db, id: Id, patch: PenaltyPatch): PenaltyNotice {
  requirePenalty(db, id);
  db.update(penaltyNotices)
    .set({ ...compact(patch), updatedAt: nowIso() })
    .where(eq(penaltyNotices.id, id))
    .run();
  return requirePenalty(db, id);
}

/** Move the notice to a new stage. Whether the transition is allowed is decided by the domain `fleet.penaltyTransition`. */
export function setPenaltyStage(db: Db, id: Id, stage: PenaltyNotice['stage'], extra: { hireAgreementId?: Id; documentId?: Id; notes?: string } = {}): PenaltyNotice {
  const p = requirePenalty(db, id);
  return updatePenalty(db, id, {
    stage,
    hireAgreementId: extra.hireAgreementId ?? p.hireAgreementId,
    documentIds: extra.documentId && !p.documentIds.includes(extra.documentId) ? [...p.documentIds, extra.documentId] : p.documentIds,
    notes: extra.notes ?? p.notes,
  });
}
