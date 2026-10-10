// owned by ap-booking
/**
 * Repository for fleet_reservations (+ events), fleet_movements, fleet_locations, fleet_readiness_tasks, fleet_damage
 * and claim_hire_needs (docs/SUPREME-AUTOPILOT.md §B). The tables exist from migration 0013_autopilot.
 *
 * Periods are written as epoch milliseconds (`block_start_ms` / `block_end_ms`, computed by the domain's
 * `blockColumns`) so the overlap triggers compare integers, never ISO text. A trigger refusal surfaces as
 * `ReservationOverlapError` (code RESERVATION_OVERLAP). `fleet_reservation_events` is append-only (0013 triggers).
 */
import { and, asc, eq, gt, inArray, isNull, lt, lte, or, type SQL } from 'drizzle-orm';
import { blockColumns, isoToMs, type FleetDamage, type FleetLocation, type HireNeeds, type Id, type ISODateTime, type Movement, type MovementStatus, type ReadinessTask, type Reservation, type ReservationEvent, type ReservationStatus } from '@ccguk/domain';
import type { Db } from '../client.js';
import { DbError, NotFoundError, ValidationError } from '../errors.js';
import {
  claimHireNeeds,
  fleetDamage,
  fleetLocations,
  fleetMovements,
  fleetReadinessTasks,
  fleetReservationEvents,
  fleetReservations,
  type FleetDamageRow,
  type FleetLocationRow,
  type FleetMovementRow,
  type FleetReadinessTaskRow,
  type FleetReservationEventRow,
  type FleetReservationRow,
} from '../schema.js';
import { compact, denull, newId, nowIso } from '../util.js';

/** The overlap trigger refused the write (§B.11, second line of defence). */
export class ReservationOverlapError extends DbError {
  constructor(message = 'The car is held or booked for another claim for part of this period') {
    super('RESERVATION_OVERLAP', message);
  }
}

function isOverlap(err: unknown): boolean {
  return err instanceof Error && /RESERVATION_OVERLAP/.test(err.message);
}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (isOverlap(err)) throw new ReservationOverlapError();
    throw err;
  }
}

const OPEN_END = 9_007_199_254_740_991;

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

function toReservation(row: FleetReservationRow): Reservation {
  const { blockStartMs: _s, blockEndMs: _e, holdExpiresMs: _h, ...rest } = row;
  const r = denull(rest) as Reservation;
  r.expectedEndAt = row.expectedEndAt ?? null;
  return r;
}

export type NewReservation = Omit<Reservation, 'id' | 'createdAt' | 'updatedAt'> & { id?: Id; createdAt?: ISODateTime };

function assertIso(name: string, v: string | null | undefined): void {
  if (v === null || v === undefined) return;
  if (!Number.isFinite(Date.parse(v))) throw new ValidationError(`${name} must be an ISO date-time`);
}

function columnsOf(r: Pick<Reservation, 'status' | 'startAt' | 'expectedEndAt' | 'endAt' | 'collectedAt' | 'holdExpiresAt'>): { blockStartMs: number; blockEndMs: number | null; holdExpiresMs: number | null } {
  const b = blockColumns(r);
  return { ...b, holdExpiresMs: r.holdExpiresAt ? isoToMs(r.holdExpiresAt) : null };
}

export function insertReservation(db: Db, input: NewReservation): Reservation {
  for (const k of ['startAt', 'expectedEndAt', 'endAt', 'collectedAt', 'holdExpiresAt'] as const) assertIso(k, input[k] as string | null | undefined);
  if (!Number.isInteger(input.dailyRatePence) || input.dailyRatePence <= 0) throw new ValidationError('dailyRatePence must be positive integer pence');
  if (input.expectedEndAt && Date.parse(input.expectedEndAt) <= Date.parse(input.startAt)) throw new ValidationError('expectedEndAt must be after startAt');
  const id = input.id ?? newId();
  const now = input.createdAt ?? nowIso();
  const { id: _i, createdAt: _c, ...rest } = input;
  guard(() =>
    db
      .insert(fleetReservations)
      .values({ ...rest, ...columnsOf(input), expectedEndAt: input.expectedEndAt ?? null, id, createdAt: now, updatedAt: now })
      .run(),
  );
  return requireReservation(db, id);
}

export function getReservation(db: Db, id: Id): Reservation | undefined {
  const row = db.select().from(fleetReservations).where(eq(fleetReservations.id, id)).get();
  return row ? toReservation(row) : undefined;
}

export function requireReservation(db: Db, id: Id): Reservation {
  const r = getReservation(db, id);
  if (!r) throw new NotFoundError('booking', id);
  return r;
}

export interface ReservationFilter {
  claimId?: Id;
  fleetUnitId?: Id | Id[];
  status?: ReservationStatus | ReservationStatus[];
  /** Overlap with [fromMs, toMs) on the stored block columns (open ends count). */
  fromMs?: number;
  toMs?: number;
  hireAgreementId?: Id;
}

export function listReservations(db: Db, filter: ReservationFilter = {}): Reservation[] {
  const where: SQL[] = [];
  if (filter.claimId) where.push(eq(fleetReservations.claimId, filter.claimId));
  if (filter.fleetUnitId) where.push(Array.isArray(filter.fleetUnitId) ? inArray(fleetReservations.fleetUnitId, filter.fleetUnitId.length ? filter.fleetUnitId : ['']) : eq(fleetReservations.fleetUnitId, filter.fleetUnitId));
  if (filter.status) where.push(Array.isArray(filter.status) ? inArray(fleetReservations.status, filter.status.length ? filter.status : ['held']) : eq(fleetReservations.status, filter.status));
  if (filter.hireAgreementId) where.push(eq(fleetReservations.hireAgreementId, filter.hireAgreementId));
  if (filter.toMs !== undefined) where.push(lt(fleetReservations.blockStartMs, filter.toMs));
  if (filter.fromMs !== undefined) {
    // on-hire rows extend to "now" at read time: keep them whatever their stored end
    where.push(or(isNull(fleetReservations.blockEndMs), gt(fleetReservations.blockEndMs, filter.fromMs), eq(fleetReservations.status, 'on_hire'))!);
  }
  return db
    .select()
    .from(fleetReservations)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(fleetReservations.blockStartMs), asc(fleetReservations.id))
    .all()
    .map(toReservation);
}

/** Held reservations whose hold expiry is at or before `atMs`. */
export function listExpiredHolds(db: Db, atMs: number): Reservation[] {
  return db
    .select()
    .from(fleetReservations)
    .where(and(eq(fleetReservations.status, 'held'), lte(fleetReservations.holdExpiresMs, atMs)))
    .orderBy(asc(fleetReservations.holdExpiresMs))
    .all()
    .map(toReservation);
}

export type ReservationPatch = Partial<Omit<Reservation, 'id' | 'fleetUnitId' | 'claimId' | 'createdAt' | 'createdBy' | 'source'>> & { fleetUnitId?: Id };

/** Update a reservation; the block columns are recomputed from the merged row (the trigger re-checks held/confirmed). */
export function updateReservation(db: Db, id: Id, patch: ReservationPatch): Reservation {
  const current = requireReservation(db, id);
  for (const k of ['startAt', 'expectedEndAt', 'endAt', 'collectedAt', 'holdExpiresAt'] as const) assertIso(k, patch[k] as string | null | undefined);
  const merged = { ...current, ...compact(patch) } as Reservation;
  if (patch.expectedEndAt === null) merged.expectedEndAt = null;
  const set: Record<string, unknown> = { ...compact(patch), ...columnsOf(merged), updatedAt: nowIso() };
  if (patch.expectedEndAt === null) set.expectedEndAt = null;
  guard(() => db.update(fleetReservations).set(set).where(eq(fleetReservations.id, id)).run());
  return requireReservation(db, id);
}

function toEvent(row: FleetReservationEventRow): ReservationEvent {
  return denull(row) as ReservationEvent;
}

export function appendReservationEvent(db: Db, input: Omit<ReservationEvent, 'id'> & { id?: Id }): ReservationEvent {
  const id = input.id ?? newId();
  db.insert(fleetReservationEvents)
    .values({ ...input, id })
    .run();
  return toEvent(db.select().from(fleetReservationEvents).where(eq(fleetReservationEvents.id, id)).get()!);
}

export function listReservationEvents(db: Db, reservationId: Id): ReservationEvent[] {
  return db.select().from(fleetReservationEvents).where(eq(fleetReservationEvents.reservationId, reservationId)).orderBy(asc(fleetReservationEvents.at), asc(fleetReservationEvents.id)).all().map(toEvent);
}

/** The stored block columns of a reservation (tests and diagnostics). */
export function reservationBlock(db: Db, id: Id): { blockStartMs: number; blockEndMs: number | null; holdExpiresMs: number | null } | undefined {
  return db.select({ blockStartMs: fleetReservations.blockStartMs, blockEndMs: fleetReservations.blockEndMs, holdExpiresMs: fleetReservations.holdExpiresMs }).from(fleetReservations).where(eq(fleetReservations.id, id)).get();
}

export { OPEN_END as RESERVATION_OPEN_END_MS };

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

function toMovement(row: FleetMovementRow): Movement {
  const { createdAt: _c, updatedAt: _u, createdBy: _b, ...rest } = row;
  const m = denull(rest) as Movement;
  m.address = row.address ?? null;
  m.postcode = row.postcode ?? null;
  m.assignedTo = row.assignedTo ?? null;
  return m;
}

export type NewMovement = Omit<Movement, 'id' | 'evidenceIds'> & { id?: Id; evidenceIds?: Id[]; createdBy: string };

export function createMovement(db: Db, input: NewMovement): Movement {
  assertIso('windowStart', input.windowStart);
  assertIso('windowEnd', input.windowEnd);
  if (Date.parse(input.windowEnd) <= Date.parse(input.windowStart)) throw new ValidationError('windowEnd must be after windowStart');
  const id = input.id ?? newId();
  const now = nowIso();
  const { id: _i, ...rest } = input;
  db.insert(fleetMovements)
    .values({ ...rest, evidenceIds: input.evidenceIds ?? [], id, createdAt: now, updatedAt: now })
    .run();
  return requireMovement(db, id);
}

export function getMovement(db: Db, id: Id): Movement | undefined {
  const row = db.select().from(fleetMovements).where(eq(fleetMovements.id, id)).get();
  return row ? toMovement(row) : undefined;
}

export function requireMovement(db: Db, id: Id): Movement {
  const m = getMovement(db, id);
  if (!m) throw new NotFoundError('movement', id);
  return m;
}

export interface MovementFilter {
  reservationId?: Id;
  claimId?: Id;
  fleetUnitId?: Id;
  status?: MovementStatus | MovementStatus[];
  /** windowStart in [from, to). ISO compared as instants via the stored text — callers pass UTC 'Z' values. */
  from?: ISODateTime;
  to?: ISODateTime;
}

export function listMovements(db: Db, filter: MovementFilter = {}): Movement[] {
  const where: SQL[] = [];
  if (filter.reservationId) where.push(eq(fleetMovements.reservationId, filter.reservationId));
  if (filter.claimId) where.push(eq(fleetMovements.claimId, filter.claimId));
  if (filter.fleetUnitId) where.push(eq(fleetMovements.fleetUnitId, filter.fleetUnitId));
  if (filter.status) where.push(Array.isArray(filter.status) ? inArray(fleetMovements.status, filter.status.length ? filter.status : ['planned']) : eq(fleetMovements.status, filter.status));
  const rows = db
    .select()
    .from(fleetMovements)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(fleetMovements.windowStart), asc(fleetMovements.id))
    .all()
    .map(toMovement);
  // Time filtering in JS: stored values may carry different offsets, which do not sort as text.
  const fromMs = filter.from ? Date.parse(filter.from) : -Infinity;
  const toMs = filter.to ? Date.parse(filter.to) : Infinity;
  return rows.filter((m) => Date.parse(m.windowStart) >= fromMs && Date.parse(m.windowStart) < toMs).sort((a, b) => Date.parse(a.windowStart) - Date.parse(b.windowStart));
}

export type MovementPatch = Partial<Omit<Movement, 'id' | 'reservationId' | 'claimId' | 'fleetUnitId'>>;

export function updateMovement(db: Db, id: Id, patch: MovementPatch): Movement {
  requireMovement(db, id);
  const set: Record<string, unknown> = { ...compact(patch), updatedAt: nowIso() };
  for (const k of ['address', 'postcode', 'assignedTo'] as const) if (patch[k] === null) set[k] = null;
  db.update(fleetMovements).set(set).where(eq(fleetMovements.id, id)).run();
  return requireMovement(db, id);
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

function toLocation(row: FleetLocationRow): FleetLocation {
  return { id: row.id, name: row.name, address: row.address ?? null, postcode: row.postcode ?? null, lat: row.lat ?? null, lon: row.lon ?? null, isDefault: row.isDefault };
}

export function listLocations(db: Db): FleetLocation[] {
  return db.select().from(fleetLocations).orderBy(asc(fleetLocations.name)).all().map(toLocation);
}

export function getLocation(db: Db, id: Id): FleetLocation | undefined {
  const row = db.select().from(fleetLocations).where(eq(fleetLocations.id, id)).get();
  return row ? toLocation(row) : undefined;
}

export function requireLocation(db: Db, id: Id): FleetLocation {
  const l = getLocation(db, id);
  if (!l) throw new NotFoundError('fleet location', id);
  return l;
}

export function defaultLocation(db: Db): FleetLocation | undefined {
  const row = db.select().from(fleetLocations).where(eq(fleetLocations.isDefault, true)).get();
  return row ? toLocation(row) : undefined;
}

/** Create a location; `isDefault` clears the flag on every other location (one default). The first location is the default. */
export function createLocation(db: Db, input: Omit<FleetLocation, 'id' | 'isDefault'> & { id?: Id; isDefault?: boolean }): FleetLocation {
  if (!input.name?.trim()) throw new ValidationError('A location needs a name');
  const id = input.id ?? newId();
  const now = nowIso();
  const first = !db.select({ id: fleetLocations.id }).from(fleetLocations).limit(1).get();
  const isDefault = input.isDefault ?? first;
  if (isDefault) db.update(fleetLocations).set({ isDefault: false, updatedAt: now }).run();
  db.insert(fleetLocations)
    .values({ id, name: input.name.trim(), address: input.address ?? null, postcode: input.postcode ?? null, lat: input.lat ?? null, lon: input.lon ?? null, isDefault, createdAt: now, updatedAt: now })
    .run();
  return requireLocation(db, id);
}

export function updateLocation(db: Db, id: Id, patch: Partial<Omit<FleetLocation, 'id'>>): FleetLocation {
  requireLocation(db, id);
  const now = nowIso();
  if (patch.isDefault === true) db.update(fleetLocations).set({ isDefault: false, updatedAt: now }).run();
  const set: Record<string, unknown> = { ...compact(patch), updatedAt: now };
  for (const k of ['address', 'postcode', 'lat', 'lon'] as const) if (patch[k] === null) set[k] = null;
  db.update(fleetLocations).set(set).where(eq(fleetLocations.id, id)).run();
  return requireLocation(db, id);
}

// ---------------------------------------------------------------------------
// Readiness tasks
// ---------------------------------------------------------------------------

function toTask(row: FleetReadinessTaskRow): ReadinessTask {
  return denull(row) as ReadinessTask;
}

export function createReadinessTask(db: Db, input: Omit<ReadinessTask, 'id' | 'createdAt' | 'status'> & { id?: Id; status?: ReadinessTask['status']; createdAt?: ISODateTime }): ReadinessTask {
  assertIso('dueAt', input.dueAt);
  assertIso('readyByAt', input.readyByAt);
  const id = input.id ?? newId();
  db.insert(fleetReadinessTasks)
    .values({ ...input, id, status: input.status ?? 'open', createdAt: input.createdAt ?? nowIso() })
    .run();
  return requireReadinessTask(db, id);
}

export function getReadinessTask(db: Db, id: Id): ReadinessTask | undefined {
  const row = db.select().from(fleetReadinessTasks).where(eq(fleetReadinessTasks.id, id)).get();
  return row ? toTask(row) : undefined;
}

export function requireReadinessTask(db: Db, id: Id): ReadinessTask {
  const t = getReadinessTask(db, id);
  if (!t) throw new NotFoundError('readiness task', id);
  return t;
}

export function listReadinessTasks(db: Db, filter: { fleetUnitId?: Id | Id[]; status?: ReadinessTask['status'] | ReadinessTask['status'][] } = {}): ReadinessTask[] {
  const where: SQL[] = [];
  if (filter.fleetUnitId) where.push(Array.isArray(filter.fleetUnitId) ? inArray(fleetReadinessTasks.fleetUnitId, filter.fleetUnitId.length ? filter.fleetUnitId : ['']) : eq(fleetReadinessTasks.fleetUnitId, filter.fleetUnitId));
  if (filter.status) where.push(Array.isArray(filter.status) ? inArray(fleetReadinessTasks.status, filter.status) : eq(fleetReadinessTasks.status, filter.status));
  return db
    .select()
    .from(fleetReadinessTasks)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(fleetReadinessTasks.createdAt), asc(fleetReadinessTasks.id))
    .all()
    .map(toTask);
}

export function updateReadinessTask(db: Db, id: Id, patch: Partial<Omit<ReadinessTask, 'id' | 'fleetUnitId' | 'createdAt' | 'createdBy'>>): ReadinessTask {
  requireReadinessTask(db, id);
  assertIso('dueAt', patch.dueAt);
  assertIso('readyByAt', patch.readyByAt);
  db.update(fleetReadinessTasks).set(compact(patch)).where(eq(fleetReadinessTasks.id, id)).run();
  return requireReadinessTask(db, id);
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

function toDamage(row: FleetDamageRow): FleetDamage {
  const { createdAt: _c, ...rest } = row;
  return denull(rest) as FleetDamage;
}

export function createDamage(db: Db, input: Omit<FleetDamage, 'id' | 'evidenceIds' | 'chargeable'> & { id?: Id; evidenceIds?: Id[]; chargeable?: FleetDamage['chargeable'] }): FleetDamage {
  if (!input.panel?.trim() || !input.description?.trim()) throw new ValidationError('Damage needs a panel and a description');
  const id = input.id ?? newId();
  db.insert(fleetDamage)
    .values({ ...input, id, evidenceIds: input.evidenceIds ?? [], chargeable: input.chargeable ?? 'tbc', createdAt: nowIso() })
    .run();
  return requireDamage(db, id);
}

export function getDamage(db: Db, id: Id): FleetDamage | undefined {
  const row = db.select().from(fleetDamage).where(eq(fleetDamage.id, id)).get();
  return row ? toDamage(row) : undefined;
}

export function requireDamage(db: Db, id: Id): FleetDamage {
  const d = getDamage(db, id);
  if (!d) throw new NotFoundError('fleet damage', id);
  return d;
}

export function listDamage(db: Db, filter: { fleetUnitId?: Id | Id[]; unrepaired?: boolean; reservationId?: Id } = {}): FleetDamage[] {
  const where: SQL[] = [];
  if (filter.fleetUnitId) where.push(Array.isArray(filter.fleetUnitId) ? inArray(fleetDamage.fleetUnitId, filter.fleetUnitId.length ? filter.fleetUnitId : ['']) : eq(fleetDamage.fleetUnitId, filter.fleetUnitId));
  if (filter.unrepaired) where.push(isNull(fleetDamage.repairedAt));
  if (filter.reservationId) where.push(eq(fleetDamage.reservationId, filter.reservationId));
  return db
    .select()
    .from(fleetDamage)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(fleetDamage.foundAt), asc(fleetDamage.id))
    .all()
    .map(toDamage);
}

export function updateDamage(db: Db, id: Id, patch: Partial<Omit<FleetDamage, 'id' | 'fleetUnitId' | 'foundAt' | 'foundBy'>>): FleetDamage {
  requireDamage(db, id);
  db.update(fleetDamage).set(compact(patch)).where(eq(fleetDamage.id, id)).run();
  return requireDamage(db, id);
}

// ---------------------------------------------------------------------------
// Hire needs (§B.5 / §F.3)
// ---------------------------------------------------------------------------

export interface HireNeedsRecord {
  claimId: Id;
  needs: HireNeeds;
  updatedBy: string;
  updatedAt: ISODateTime;
}

export function getHireNeeds(db: Db, claimId: Id): HireNeedsRecord | undefined {
  const row = db.select().from(claimHireNeeds).where(eq(claimHireNeeds.claimId, claimId)).get();
  return row ? { claimId: row.claimId, needs: row.needs, updatedBy: row.updatedBy, updatedAt: row.updatedAt } : undefined;
}

export function putHireNeeds(db: Db, claimId: Id, needs: HireNeeds, updatedBy: string, at: ISODateTime = nowIso()): HireNeedsRecord {
  db.insert(claimHireNeeds)
    .values({ claimId, needs, updatedBy, updatedAt: at })
    .onConflictDoUpdate({ target: claimHireNeeds.claimId, set: { needs, updatedBy, updatedAt: at } })
    .run();
  return getHireNeeds(db, claimId)!;
}
