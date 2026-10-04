import { asc, eq, sql } from 'drizzle-orm';
import type { HireAgreement, HireEndTrigger, Id, ISODateTime } from '@ccguk/domain';
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

export function createHire(db: Db, input: CreateHireInput): HireAgreement {
  if (!Number.isInteger(input.dailyRatePence) || input.dailyRatePence <= 0) throw new ValidationError('dailyRatePence must be positive integer pence');
  if (!Number.isInteger(input.excessPence) || input.excessPence < 0) throw new ValidationError('excessPence must be integer pence');
  if (input.endAt && input.endAt < input.startAt) throw new ValidationError('hire endAt cannot be before startAt');
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
export function endHire(db: Db, id: Id, input: EndHireInput): HireAgreement {
  const h = requireHire(db, id);
  if (h.endAt) throw new ValidationError(`hire ${id} already ended at ${h.endAt}`);
  if (input.endAt < h.startAt) throw new ValidationError('hire endAt cannot be before startAt');
  return updateHire(db, id, { endAt: input.endAt, endTrigger: input.endTrigger, collectedAt: input.collectedAt, odometerIn: input.odometerIn });
}
