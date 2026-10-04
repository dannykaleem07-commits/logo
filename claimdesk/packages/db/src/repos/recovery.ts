import { asc, eq } from 'drizzle-orm';
import type { Id, Pence, RecoveryRecord } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { recoveryRecords, type RecoveryRecordRow } from '../schema.js';
import { compact, denull, newId, nowIso } from '../util.js';

export type CreateRecoveryInput = Omit<RecoveryRecord, 'id' | 'evidenceIds'> & { id?: Id; evidenceIds?: Id[] };
export type RecoveryPatch = Partial<Omit<RecoveryRecord, 'id' | 'claimId'>>;

function toRecovery(row: RecoveryRecordRow): RecoveryRecord {
  const { createdAt: _c, ...rest } = row;
  return denull(rest);
}

/** Net recovery charge: call-out + loaded miles × per-mile + admin (rate card £90 + £3/mile + £25). */
export function recoveryNetPence(r: Pick<RecoveryRecord, 'calloutPence' | 'loadedMiles' | 'perLoadedMilePence' | 'adminPence'>): Pence {
  return r.calloutPence + Math.round(r.loadedMiles * r.perLoadedMilePence) + r.adminPence;
}

export function createRecovery(db: Db, input: CreateRecoveryInput): RecoveryRecord {
  for (const k of ['calloutPence', 'perLoadedMilePence', 'adminPence'] as const) {
    if (!Number.isInteger(input[k]) || input[k] < 0) throw new ValidationError(`${k} must be non-negative integer pence`);
  }
  if (!Number.isFinite(input.loadedMiles) || input.loadedMiles < 0) throw new ValidationError('loadedMiles must be a non-negative number');
  const id = input.id ?? newId();
  db.insert(recoveryRecords)
    .values({ ...input, id, evidenceIds: input.evidenceIds ?? [], createdAt: nowIso() })
    .run();
  return requireRecovery(db, id);
}

export function getRecovery(db: Db, id: Id): RecoveryRecord | undefined {
  const row = db.select().from(recoveryRecords).where(eq(recoveryRecords.id, id)).get();
  return row ? toRecovery(row) : undefined;
}

export function requireRecovery(db: Db, id: Id): RecoveryRecord {
  const r = getRecovery(db, id);
  if (!r) throw new NotFoundError('recovery record', id);
  return r;
}

export function listRecovery(db: Db, claimId: Id): RecoveryRecord[] {
  return db.select().from(recoveryRecords).where(eq(recoveryRecords.claimId, claimId)).orderBy(asc(recoveryRecords.at)).all().map(toRecovery);
}

export function updateRecovery(db: Db, id: Id, patch: RecoveryPatch): RecoveryRecord {
  requireRecovery(db, id);
  db.update(recoveryRecords).set(compact(patch)).where(eq(recoveryRecords.id, id)).run();
  return requireRecovery(db, id);
}
