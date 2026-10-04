import { eq, inArray, like, or } from 'drizzle-orm';
import type { Claim, Id, ISODateTime, LookupRecord, OdometerReading, Vehicle } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { claims, vehicles, type VehicleRow } from '../schema.js';
import { compact, denull, likeContains, newId, normaliseRegistration, nowIso } from '../util.js';
import { toClaim } from './claims.js';

export type UpsertVehicleInput = Omit<Vehicle, 'id' | 'createdAt' | 'odometer' | 'lookups'> & {
  id?: Id;
  createdAt?: ISODateTime;
  odometer?: OdometerReading[];
  lookups?: LookupRecord[];
};

/** Optional vehicle fields a patch may clear by sending `null` (PATCH /vehicles/:id). */
export type NullableVehicleField =
  | 'vin' | 'variant' | 'bodyType' | 'yearOfManufacture' | 'monthOfFirstRegistration' | 'fuelType' | 'transmission' | 'colour'
  | 'engineCapacityCc' | 'co2Gkm' | 'euroStatus' | 'taxStatus' | 'taxDueDate' | 'motStatus' | 'motExpiryDate' | 'markedForExport'
  | 'dateOfLastV5CIssued' | 'motHistory' | 'gtaGroup' | 'previousWriteOffCategory' | 'spec';

/** Fields to change. `undefined` = leave alone; `null` = clear (only the optional fields). */
export type VehiclePatch = Partial<Omit<Vehicle, 'id' | 'createdAt' | 'registration' | NullableVehicleField>> & { [K in NullableVehicleField]?: Vehicle[K] | null };

function toVehicle(row: VehicleRow): Vehicle {
  const { updatedAt: _u, ...rest } = row;
  return denull(rest);
}

export function getVehicle(db: Db, id: Id): Vehicle | undefined {
  const row = db.select().from(vehicles).where(eq(vehicles.id, id)).get();
  return row ? toVehicle(row) : undefined;
}

export function requireVehicle(db: Db, id: Id): Vehicle {
  const v = getVehicle(db, id);
  if (!v) throw new NotFoundError('vehicle', id);
  return v;
}

export function findByRegistration(db: Db, registration: string): Vehicle | undefined {
  const reg = normaliseRegistration(registration);
  if (!reg) return undefined;
  const row = db.select().from(vehicles).where(eq(vehicles.registration, reg)).get();
  return row ? toVehicle(row) : undefined;
}

/**
 * Insert or update by normalised registration. On update, provided scalar fields overwrite; `odometer` and
 * `lookups` arrays are merged (appended, de-duplicated by content / id) so lookup history is never lost.
 */
export function upsertVehicle(db: Db, input: UpsertVehicleInput): Vehicle {
  const registration = normaliseRegistration(input.registration);
  if (!registration) throw new ValidationError('registration is required');
  const existing = db.select().from(vehicles).where(eq(vehicles.registration, registration)).get();
  const now = nowIso();
  if (!existing) {
    const id = input.id ?? newId();
    db.insert(vehicles)
      .values({
        ...input,
        id,
        registration,
        odometer: input.odometer ?? [],
        lookups: input.lookups ?? [],
        createdAt: input.createdAt ?? now,
        updatedAt: now,
      })
      .run();
    return requireVehicle(db, id);
  }
  const { id: _id, createdAt: _c, odometer, lookups, ...scalars } = input;
  const mergedOdometer = mergeOdometer(existing.odometer, odometer ?? []);
  const mergedLookups = mergeLookups(existing.lookups, lookups ?? []);
  db.update(vehicles)
    .set({ ...compact(scalars), registration, odometer: mergedOdometer, lookups: mergedLookups, updatedAt: now })
    .where(eq(vehicles.id, existing.id))
    .run();
  return requireVehicle(db, existing.id);
}

export function updateVehicle(db: Db, id: Id, patch: VehiclePatch): Vehicle {
  requireVehicle(db, id);
  db.update(vehicles)
    .set({ ...compact(patch), updatedAt: nowIso() })
    .where(eq(vehicles.id, id))
    .run();
  return requireVehicle(db, id);
}

function odometerKey(r: OdometerReading): string {
  return `${r.source}|${r.date}|${r.miles}|${r.evidenceId ?? ''}`;
}

function mergeOdometer(current: OdometerReading[], incoming: OdometerReading[]): OdometerReading[] {
  const seen = new Set(current.map(odometerKey));
  const out = [...current];
  for (const r of incoming) {
    const k = odometerKey(r);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function mergeLookups(current: LookupRecord[], incoming: LookupRecord[]): LookupRecord[] {
  const seen = new Set(current.map((l) => l.id));
  const out = [...current];
  for (const l of incoming) {
    const withId = l.id ? l : { ...l, id: newId() };
    if (!seen.has(withId.id)) {
      seen.add(withId.id);
      out.push(withId);
    }
  }
  return out;
}

/** Append an odometer reading (the mileage-conflict engine in @ccguk/domain reads the whole array). */
export function addOdometer(db: Db, vehicleId: Id, reading: OdometerReading): Vehicle {
  const v = requireVehicle(db, vehicleId);
  if (!Number.isFinite(reading.miles) || reading.miles < 0) throw new ValidationError('odometer miles must be a non-negative number');
  const odometer = mergeOdometer(v.odometer, [reading]);
  db.update(vehicles).set({ odometer, updatedAt: nowIso() }).where(eq(vehicles.id, vehicleId)).run();
  return requireVehicle(db, vehicleId);
}

/** Append a lookup record (DVLA VES / DVSA MOT / gateway / manual). Assigns an id when missing. */
export function addLookup(db: Db, vehicleId: Id, lookup: Omit<LookupRecord, 'id'> & { id?: Id }): LookupRecord {
  const v = requireVehicle(db, vehicleId);
  const record: LookupRecord = { ...lookup, id: lookup.id ?? newId() };
  const lookups = mergeLookups(v.lookups, [record]);
  db.update(vehicles).set({ lookups, updatedAt: nowIso() }).where(eq(vehicles.id, vehicleId)).run();
  return record;
}

export function searchVehicles(db: Db, query: string, limit = 50): Vehicle[] {
  const q = query.trim();
  if (!q) return [];
  const reg = normaliseRegistration(q);
  const pattern = likeContains(q);
  const rows = db
    .select()
    .from(vehicles)
    .where(or(reg ? like(vehicles.registration, `%${reg}%`) : undefined, like(vehicles.make, pattern), like(vehicles.model, pattern), like(vehicles.vin, pattern)))
    .orderBy(vehicles.registration)
    .limit(limit)
    .all();
  return rows.map(toVehicle);
}

export function listVehicles(db: Db, options: { ownership?: Vehicle['ownership']; limit?: number; offset?: number } = {}): Vehicle[] {
  const rows = db
    .select()
    .from(vehicles)
    .where(options.ownership ? eq(vehicles.ownership, options.ownership) : undefined)
    .orderBy(vehicles.registration)
    .limit(options.limit ?? 500)
    .offset(options.offset ?? 0)
    .all();
  return rows.map(toVehicle);
}

/**
 * Every claim on which this registration appears as the client vehicle or the third-party vehicle.
 * Feeds the cross-file registration check (BLUEPRINT §3.2, lessons f/h) — a second file is a FLAG, not a constraint.
 */
export function listClaimsForRegistration(db: Db, registration: string): Claim[] {
  const reg = normaliseRegistration(registration);
  if (!reg) return [];
  const vehicleIds = db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(eq(vehicles.registration, reg))
    .all()
    .map((r) => r.id);
  if (!vehicleIds.length) return [];
  const rows = db
    .select()
    .from(claims)
    .where(or(inArray(claims.clientVehicleId, vehicleIds), inArray(claims.thirdPartyVehicleId, vehicleIds)))
    .orderBy(claims.openedAt)
    .all();
  return rows.map(toClaim);
}

/**
 * Vehicles whose normalised registration CONTAINS `fragment` (≥ 4 characters after normalisation), excluding the exact
 * registration. Feeds the on-file search (TEMPLATES-VEHICLES-DESKTOP §E.1). Read-only.
 */
export function findVehiclesByPartialRegistration(db: Db, fragment: string, limit = 10): Vehicle[] {
  const reg = normaliseRegistration(fragment ?? '');
  if (reg.length < 4) return [];
  return db
    .select()
    .from(vehicles)
    .where(like(vehicles.registration, `%${reg}%`))
    .orderBy(vehicles.registration)
    .limit(Math.max(1, limit) + 1)
    .all()
    .filter((r) => r.registration !== reg)
    .slice(0, Math.max(1, limit))
    .map(toVehicle);
}

/** When the vehicle row was last changed (not part of the domain Vehicle). */
export function vehicleUpdatedAt(db: Db, id: Id): ISODateTime | undefined {
  return db.select({ updatedAt: vehicles.updatedAt }).from(vehicles).where(eq(vehicles.id, id)).get()?.updatedAt;
}
