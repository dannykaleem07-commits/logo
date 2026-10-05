import { asc, eq, sql } from 'drizzle-orm';
import type { HireAgreement, HireEndTrigger, Id, ISODateTime, Pence } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { hireAgreements, type HireAgreementRow } from '../schema.js';
import { compact, denull, newId, nowIso } from '../util.js';

export type CreateHireInput = Omit<HireAgreement, 'id' | 'additionalDrivers' | 'enforceability' | 'agreementNumber'> & {
  id?: Id;
  /** Generated as CCG-H-NNNNNN when omitted. */
  agreementNumber?: string;
  additionalDrivers?: HireAgreement['additionalDrivers'];
  enforceability?: Partial<HireAgreement['enforceability']>;
};

export type HirePatch = Partial<Omit<HireAgreement, 'id' | 'claimId'>>;

function toHire(row: HireAgreementRow): HireAgreement {
  const { createdAt: _c, updatedAt: _u, ...rest } = row;
  return denull(rest);
}

function nextAgreementNumber(db: Db): string {
  const row = db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(hireAgreements).get();
  let seq = (row?.n ?? 0) + 1;
  // guard against gaps/collisions from imported numbers
  for (;;) {
    const candidate = `CCG-H-${String(seq).padStart(6, '0')}`;
    const clash = db.select({ id: hireAgreements.id }).from(hireAgreements).where(eq(hireAgreements.agreementNumber, candidate)).get();
    if (!clash) return candidate;
    seq += 1;
  }
}

export interface HireDateOptions {
  /** Manager mode (HIRE_END_BEFORE_START overridden): store an end before the start; it is charged as 0 days. */
  allowEndBeforeStart?: boolean;
}

const ms = (iso: string): number => new Date(iso).getTime();

function assertDates(startAt: ISODateTime, endAt: ISODateTime | undefined | null, opts: HireDateOptions): void {
  if (!Number.isFinite(ms(startAt))) throw new ValidationError('hire startAt must be an ISO date-time');
  if (!endAt) return;
  if (!Number.isFinite(ms(endAt))) throw new ValidationError('hire endAt must be an ISO date-time');
  if (!opts.allowEndBeforeStart && ms(endAt) < ms(startAt)) throw new ValidationError('hire endAt cannot be before startAt');
}

function assertPositivePence(name: string, v: unknown): void {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new ValidationError(`${name} must be positive integer pence`);
}

function assertOptionalPence(name: string, v: unknown): void {
  if (v === undefined || v === null) return;
  if (!Number.isInteger(v) || (v as number) < 0) throw new ValidationError(`${name} must be integer pence`);
}

export function createHire(db: Db, input: CreateHireInput, opts: HireDateOptions = {}): HireAgreement {
  assertPositivePence('dailyRatePence', input.dailyRatePence);
  if (!Number.isInteger(input.excessPence) || input.excessPence < 0) throw new ValidationError('excessPence must be integer pence');
  for (const k of ['clientGtaDailyRatePence', 'hireGtaDailyRatePence', 'fleetDailyRatePence'] as const) assertOptionalPence(k, input[k]);
  assertDates(input.startAt, input.endAt, opts);
  return db.transaction((tx) => {
    const id = input.id ?? newId();
    const now = nowIso();
    tx.insert(hireAgreements)
      .values({
        ...input,
        id,
        agreementNumber: input.agreementNumber ?? nextAgreementNumber(tx),
        additionalDrivers: input.additionalDrivers ?? [],
        enforceability: { cca60fCompliant: false, ...input.enforceability },
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return requireHire(tx, id);
  });
}

export function getHire(db: Db, id: Id): HireAgreement | undefined {
  const row = db.select().from(hireAgreements).where(eq(hireAgreements.id, id)).get();
  return row ? toHire(row) : undefined;
}

export function requireHire(db: Db, id: Id): HireAgreement {
  const h = getHire(db, id);
  if (!h) throw new NotFoundError('hire agreement', id);
  return h;
}

export function listHire(db: Db, claimId: Id): HireAgreement[] {
  return db.select().from(hireAgreements).where(eq(hireAgreements.claimId, claimId)).orderBy(asc(hireAgreements.startAt)).all().map(toHire);
}

export function listHireForFleetUnit(db: Db, fleetUnitId: Id): HireAgreement[] {
  return db.select().from(hireAgreements).where(eq(hireAgreements.fleetUnitId, fleetUnitId)).orderBy(asc(hireAgreements.startAt)).all().map(toHire);
}

/** A hire with the instant its row was recorded (for "Entered late" and the hire list). */
export type HireWithRecordedAt = HireAgreement & { recordedAt: ISODateTime };

export function listHireWithRecordedAt(db: Db, claimId: Id): HireWithRecordedAt[] {
  return db
    .select()
    .from(hireAgreements)
    .where(eq(hireAgreements.claimId, claimId))
    .orderBy(asc(hireAgreements.startAt))
    .all()
    .map((row) => ({ ...toHire(row), recordedAt: row.createdAt }));
}

/** The hire currently running on a fleet unit, if any. */
export function activeHireForFleetUnit(db: Db, fleetUnitId: Id): HireAgreement | undefined {
  return listHireForFleetUnit(db, fleetUnitId).find((h) => !h.endAt);
}

export function updateHire(db: Db, id: Id, patch: HirePatch): HireAgreement {
  const current = requireHire(db, id);
  const set = compact(patch);
  if (patch.enforceability) set.enforceability = { ...current.enforceability, ...patch.enforceability };
  db.update(hireAgreements)
    .set({ ...set, updatedAt: nowIso() })
    .where(eq(hireAgreements.id, id))
    .run();
  return requireHire(db, id);
}

export interface EndHireInput {
  endAt: ISODateTime;
  endTrigger: HireEndTrigger;
  collectedAt?: ISODateTime;
  odometerIn?: number;
}

/** Off-hire. The GTA basis for the trigger is applied by the domain `gta.offHireDeadline`; here we just record it. */
export function endHire(db: Db, id: Id, input: EndHireInput, opts: HireDateOptions = {}): HireAgreement {
  const h = requireHire(db, id);
  if (h.endAt) throw new ValidationError(`hire ${id} already ended at ${h.endAt}`);
  assertDates(h.startAt, input.endAt, opts);
  return updateHire(db, id, { endAt: input.endAt, endTrigger: input.endTrigger, collectedAt: input.collectedAt, odometerIn: input.odometerIn });
}

/**
 * A correction to a hire's dates, rate or groups (docs/V03-MANAGER-MODE-HIRE-PRICING.md §C.3). `undefined` leaves a
 * field as it is; `null` clears it (an `endAt: null` re-opens the hire). The hire row is mutable; the events and ledger
 * that record the change are appended by the caller.
 */
export interface HireCorrection {
  startAt?: ISODateTime;
  endAt?: ISODateTime | null;
  endTrigger?: HireEndTrigger | null;
  dailyRatePence?: Pence;
  gtaGroup?: string;
  clientGtaGroup?: string | null;
  clientGtaDailyRatePence?: Pence | null;
  hireGtaDailyRatePence?: Pence | null;
  fleetDailyRatePence?: Pence | null;
  pricingNote?: string | null;
}

export function correctHire(db: Db, id: Id, patch: HireCorrection, opts: HireDateOptions = {}): HireAgreement {
  const current = requireHire(db, id);
  if (patch.dailyRatePence !== undefined) assertPositivePence('dailyRatePence', patch.dailyRatePence);
  for (const k of ['clientGtaDailyRatePence', 'hireGtaDailyRatePence', 'fleetDailyRatePence'] as const) assertOptionalPence(k, patch[k]);
  if (patch.gtaGroup !== undefined && !patch.gtaGroup.trim()) throw new ValidationError('gtaGroup cannot be empty');
  const startAt = patch.startAt ?? current.startAt;
  const endAt = patch.endAt === undefined ? current.endAt : patch.endAt;
  assertDates(startAt, endAt, opts);
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) set[k] = v;
  }
  if (Object.keys(set).length === 0) return current;
  db.update(hireAgreements)
    .set({ ...set, updatedAt: nowIso() })
    .where(eq(hireAgreements.id, id))
    .run();
  return requireHire(db, id);
}
