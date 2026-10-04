import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import type { Evidence, EvidenceKind, Id, ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { EvidenceImmutableError, NotFoundError, ValidationError } from '../errors.js';
import { evidence, type EvidenceRow } from '../schema.js';
import { denull, newId, nowIso } from '../util.js';

export type InsertEvidenceInput = Omit<Evidence, 'id' | 'immutable' | 'uploadedAt'> & { id?: Id; uploadedAt?: ISODateTime };

function toEvidence(row: EvidenceRow): Evidence {
  return { ...denull(row), immutable: true };
}

const SHA256_RE = /^[a-f0-9]{64}$/i;

/** Insert evidence metadata (the bytes live in the write-once store at `storagePath`). Write-once: no update/delete. */
export function insertEvidence(db: Db, input: InsertEvidenceInput): Evidence {
  if (!SHA256_RE.test(input.sha256)) throw new ValidationError('sha256 must be a 64-char hex digest');
  if (!Number.isInteger(input.bytes) || input.bytes < 0) throw new ValidationError('bytes must be a non-negative integer');
  const id = input.id ?? newId();
  db.insert(evidence)
    .values({ ...input, id, sha256: input.sha256.toLowerCase(), uploadedAt: input.uploadedAt ?? nowIso() })
    .run();
  return requireEvidence(db, id);
}

export function getEvidence(db: Db, id: Id): Evidence | undefined {
  const row = db.select().from(evidence).where(eq(evidence.id, id)).get();
  return row ? toEvidence(row) : undefined;
}

export function requireEvidence(db: Db, id: Id): Evidence {
  const e = getEvidence(db, id);
  if (!e) throw new NotFoundError('evidence', id);
  return e;
}

export function getEvidenceMany(db: Db, ids: Id[]): Evidence[] {
  if (!ids.length) return [];
  return db.select().from(evidence).where(inArray(evidence.id, ids)).all().map(toEvidence);
}

export function listEvidenceForClaim(db: Db, claimId: Id, filter: { kind?: EvidenceKind | EvidenceKind[] } = {}): Evidence[] {
  const where: SQL[] = [eq(evidence.claimId, claimId)];
  if (filter.kind) where.push(Array.isArray(filter.kind) ? inArray(evidence.kind, filter.kind) : eq(evidence.kind, filter.kind));
  return db
    .select()
    .from(evidence)
    .where(and(...where))
    .orderBy(asc(evidence.uploadedAt))
    .all()
    .map(toEvidence);
}

/** Same bytes already on file (anywhere) — used to detect re-uploads and cross-file reuse of photos. */
export function findEvidenceBySha256(db: Db, sha256: string): Evidence[] {
  return db.select().from(evidence).where(eq(evidence.sha256, sha256.toLowerCase())).all().map(toEvidence);
}

/** Always throws — evidence is write-once. */
export function updateEvidence(_db: Db, _id: Id, _patch: unknown): never {
  throw new EvidenceImmutableError('update');
}

/** Always throws — evidence is write-once. */
export function deleteEvidence(_db: Db, _id: Id): never {
  throw new EvidenceImmutableError('delete');
}
