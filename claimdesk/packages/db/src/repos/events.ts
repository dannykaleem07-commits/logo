import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { ClaimEvent, EventType, Id, ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { EventImmutableError, NotFoundError, ValidationError } from '../errors.js';
import { claimEvents, type ClaimEventRow } from '../schema.js';
import { denull, newId, nowIso } from '../util.js';

export type AppendEventInput = Omit<ClaimEvent, 'id' | 'recordedAt' | 'evidenceIds'> & {
  id?: Id;
  /** Defaults to now. */
  recordedAt?: ISODateTime;
  evidenceIds?: Id[];
};

function toEvent(row: ClaimEventRow): ClaimEvent {
  return denull(row);
}

/** Append to the chronology. `recordedAt` defaults to now and is never earlier than the row's creation. */
export function appendEvent(db: Db, input: AppendEventInput): ClaimEvent {
  if (Number.isNaN(Date.parse(input.at))) throw new ValidationError(`event.at is not a valid ISO date-time: ${input.at}`);
  const id = input.id ?? newId();
  db.insert(claimEvents)
    .values({ ...input, id, recordedAt: input.recordedAt ?? nowIso(), evidenceIds: input.evidenceIds ?? [] })
    .run();
  return requireEvent(db, id);
}

export function getEvent(db: Db, id: Id): ClaimEvent | undefined {
  const row = db.select().from(claimEvents).where(eq(claimEvents.id, id)).get();
  return row ? toEvent(row) : undefined;
}

export function requireEvent(db: Db, id: Id): ClaimEvent {
  const e = getEvent(db, id);
  if (!e) throw new NotFoundError('claim event', id);
  return e;
}

export interface ListEventsFilter {
  type?: EventType | EventType[];
  /** Inclusive ISO bounds on `at`. */
  from?: ISODateTime;
  to?: ISODateTime;
}

/** Chronology ordered by `at` ascending (then recordedAt), regardless of insertion order. */
export function listEvents(db: Db, claimId: Id, filter: ListEventsFilter = {}): ClaimEvent[] {
  const where: SQL[] = [eq(claimEvents.claimId, claimId)];
  if (filter.type) where.push(Array.isArray(filter.type) ? inArray(claimEvents.type, filter.type) : eq(claimEvents.type, filter.type));
  const rows = db
    .select()
    .from(claimEvents)
    .where(and(...where))
    .orderBy(asc(claimEvents.at), asc(claimEvents.recordedAt), asc(sql`rowid`))
    .all();
  return rows.filter((r) => (!filter.from || r.at >= filter.from) && (!filter.to || r.at <= filter.to)).map(toEvent);
}

/** The most recent event (by `at`) of a type, or undefined. */
export function latestEventOfType(db: Db, claimId: Id, type: EventType): ClaimEvent | undefined {
  const row = db
    .select()
    .from(claimEvents)
    .where(and(eq(claimEvents.claimId, claimId), eq(claimEvents.type, type)))
    .orderBy(desc(claimEvents.at), desc(claimEvents.recordedAt))
    .limit(1)
    .get();
  return row ? toEvent(row) : undefined;
}

/** The earliest event (by `at`) of a type — e.g. the first `ncaf_sent` starts the GTA 3.6 clock. */
export function firstEventOfType(db: Db, claimId: Id, type: EventType): ClaimEvent | undefined {
  const row = db
    .select()
    .from(claimEvents)
    .where(and(eq(claimEvents.claimId, claimId), eq(claimEvents.type, type)))
    .orderBy(asc(claimEvents.at), asc(claimEvents.recordedAt))
    .limit(1)
    .get();
  return row ? toEvent(row) : undefined;
}

/** Always throws — events are append-only. Record a `note` event that explains the correction instead. */
export function updateEvent(_db: Db, _id: Id, _patch: unknown): never {
  throw new EventImmutableError('update');
}

/** Always throws — events are append-only. */
export function deleteEvent(_db: Db, _id: Id): never {
  throw new EventImmutableError('delete');
}
