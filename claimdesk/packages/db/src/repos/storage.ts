import { asc, eq } from 'drizzle-orm';
import type { Id, ISODateTime, StorageRecord } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { storageRecords, type StorageRecordRow } from '../schema.js';
import { compact, denull, newId, nowIso } from '../util.js';

export type CreateStorageInput = Omit<StorageRecord, 'id'> & { id?: Id };
export type StoragePatch = Partial<Omit<StorageRecord, 'id' | 'claimId'>>;

function toStorage(row: StorageRecordRow): StorageRecord {
  const { createdAt: _c, updatedAt: _u, ...rest } = row;
  return denull(rest);
}

export function createStorage(db: Db, input: CreateStorageInput): StorageRecord {
  if (!Number.isInteger(input.dailyRatePence) || input.dailyRatePence < 0) throw new ValidationError('dailyRatePence must be integer pence');
  if (input.endAt && input.endAt < input.startAt) throw new ValidationError('storage endAt cannot be before startAt');
  const id = input.id ?? newId();
  const now = nowIso();
  db.insert(storageRecords)
    .values({ ...input, id, createdAt: now, updatedAt: now })
    .run();
  return requireStorage(db, id);
}

export function getStorage(db: Db, id: Id): StorageRecord | undefined {
  const row = db.select().from(storageRecords).where(eq(storageRecords.id, id)).get();
  return row ? toStorage(row) : undefined;
}

export function requireStorage(db: Db, id: Id): StorageRecord {
  const s = getStorage(db, id);
  if (!s) throw new NotFoundError('storage record', id);
  return s;
}

export function listStorage(db: Db, claimId: Id): StorageRecord[] {
  return db.select().from(storageRecords).where(eq(storageRecords.claimId, claimId)).orderBy(asc(storageRecords.startAt)).all().map(toStorage);
}

export function updateStorage(db: Db, id: Id, patch: StoragePatch): StorageRecord {
  requireStorage(db, id);
  db.update(storageRecords)
    .set({ ...compact(patch), updatedAt: nowIso() })
    .where(eq(storageRecords.id, id))
    .run();
  return requireStorage(db, id);
}

/** End storage on a trigger (report issued / total loss confirmed / payment received / collected / salvage released). */
export function endStorage(db: Db, id: Id, input: { endAt: ISODateTime; endTrigger: NonNullable<StorageRecord['endTrigger']> }): StorageRecord {
  const s = requireStorage(db, id);
  if (s.endAt) throw new ValidationError(`storage ${id} already ended at ${s.endAt}`);
  if (input.endAt < s.startAt) throw new ValidationError('storage endAt cannot be before startAt');
  return updateStorage(db, id, input);
}
