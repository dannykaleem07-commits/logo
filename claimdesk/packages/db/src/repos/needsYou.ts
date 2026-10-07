/**
 * The Needs-you inbox (docs/SUPREME-DESIGN.md §C.7). Items change status only through `transitionNeedsYou`, which
 * appends a `needs_you_events` row (append-only). An open or snoozed item with the same `dedupe_key` is returned
 * instead of creating a second one.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { ISODateTime, NeedsYouKind, NeedsYouOption, NeedsYouPriority, NeedsYouStatus, Recommendation } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { needsYou, needsYouEvents, type NeedsYouEventRow, type NeedsYouRow } from '../schema.js';
import { denull, nowIso } from '../util.js';

export interface NeedsYouRecord {
  id: string;
  kind: NeedsYouKind;
  claimId?: string;
  title: string;
  summary: string;
  recommendation?: Recommendation;
  options: NeedsYouOption[];
  payload: unknown;
  priority: NeedsYouPriority;
  dueAt?: ISODateTime;
  status: NeedsYouStatus;
  snoozedUntil?: ISODateTime;
  resolution?: unknown;
  dedupeKey?: string;
  correlationId?: string;
  resumesJobId?: string;
  createdBy: string;
  createdAt: ISODateTime;
  resolvedBy?: string;
  resolvedAt?: ISODateTime;
}

export interface NeedsYouEventRecord {
  id: string;
  needsYouId: string;
  fromStatus?: NeedsYouStatus;
  toStatus: NeedsYouStatus;
  actor: string;
  optionId?: string;
  note?: string;
  at: ISODateTime;
}

export interface CreateNeedsYouItemInput {
  kind: NeedsYouKind;
  claimId?: string;
  title: string;
  summary: string;
  recommendation?: Recommendation;
  options?: NeedsYouOption[];
  payload: unknown;
  priority: NeedsYouPriority;
  dueAt?: ISODateTime;
  createdBy: string;
  dedupeKey?: string;
  correlationId?: string;
  resumesJobId?: string;
  id?: string;
  now?: ISODateTime;
}

const OPEN: NeedsYouStatus[] = ['open', 'snoozed'];
const ALLOWED: Readonly<Record<NeedsYouStatus, readonly NeedsYouStatus[]>> = {
  open: ['snoozed', 'resolved', 'expired', 'superseded'],
  snoozed: ['open', 'resolved', 'expired', 'superseded'],
  resolved: [],
  expired: [],
  superseded: [],
};

/** Sort rank: urgent first. */
export const NEEDS_YOU_PRIORITY_RANK: Readonly<Record<NeedsYouPriority, number>> = { urgent: 0, high: 1, normal: 2, low: 3 };

const toItem = (r: NeedsYouRow): NeedsYouRecord => ({ ...(denull(r) as NeedsYouRecord), payload: r.payload ?? null });
const toEvent = (r: NeedsYouEventRow): NeedsYouEventRecord => denull(r) as NeedsYouEventRecord;

export function getNeedsYouItem(db: Db, id: string): NeedsYouRecord | undefined {
  const r = db.select().from(needsYou).where(eq(needsYou.id, id)).get();
  return r ? toItem(r) : undefined;
}

export function requireNeedsYouItem(db: Db, id: string): NeedsYouRecord {
  const item = getNeedsYouItem(db, id);
  if (!item) throw new NotFoundError('needs_you', id);
  return item;
}

/** The open (or snoozed) item carrying `dedupeKey`, if any. */
export function findOpenNeedsYouByDedupeKey(db: Db, dedupeKey: string): NeedsYouRecord | undefined {
  const r = db.select().from(needsYou).where(and(eq(needsYou.dedupeKey, dedupeKey), inArray(needsYou.status, OPEN))).get();
  return r ? toItem(r) : undefined;
}

/** Create an item (status `open`) — or return the open item with the same dedupe key (`created: false`). */
export function createNeedsYouItem(db: Db, input: CreateNeedsYouItemInput): { item: NeedsYouRecord; created: boolean } {
  if (input.dedupeKey) {
    const existing = findOpenNeedsYouByDedupeKey(db, input.dedupeKey);
    if (existing) return { item: existing, created: false };
  }
  const now = input.now ?? nowIso();
  const row = {
    id: input.id ?? randomUUID(),
    kind: input.kind,
    claimId: input.claimId ?? null,
    title: input.title,
    summary: input.summary,
    recommendation: input.recommendation ?? null,
    options: input.options ?? [],
    payload: input.payload ?? null,
    priority: input.priority,
    dueAt: input.dueAt ?? null,
    status: 'open' as const,
    dedupeKey: input.dedupeKey ?? null,
    correlationId: input.correlationId ?? null,
    resumesJobId: input.resumesJobId ?? null,
    createdBy: input.createdBy,
    createdAt: now,
  };
  const inserted = db.insert(needsYou).values(row).onConflictDoNothing().returning().all();
  if (!inserted[0]) {
    const existing = input.dedupeKey ? findOpenNeedsYouByDedupeKey(db, input.dedupeKey) : undefined;
    if (existing) return { item: existing, created: false };
    throw new ValidationError(`Needs-you item ${row.id} could not be created`);
  }
  db.insert(needsYouEvents).values({ id: randomUUID(), needsYouId: row.id, fromStatus: null, toStatus: 'open', actor: input.createdBy, optionId: null, note: null, at: now }).run();
  return { item: toItem(inserted[0]), created: true };
}

export interface ListNeedsYouFilter {
  status?: NeedsYouStatus | readonly NeedsYouStatus[];
  priority?: NeedsYouPriority | readonly NeedsYouPriority[];
  kind?: NeedsYouKind | readonly NeedsYouKind[];
  claimId?: string;
  limit?: number;
  offset?: number;
}

function many<T>(v: T | readonly T[] | undefined): T[] | undefined {
  return v === undefined ? undefined : Array.isArray(v) ? [...(v as T[])] : [v as T];
}

function needsYouWhere(f: ListNeedsYouFilter): SQL | undefined {
  const where: SQL[] = [];
  const st = many(f.status);
  if (st?.length) where.push(inArray(needsYou.status, st));
  const pr = many(f.priority);
  if (pr?.length) where.push(inArray(needsYou.priority, pr));
  const kd = many(f.kind);
  if (kd?.length) where.push(inArray(needsYou.kind, kd));
  if (f.claimId) where.push(eq(needsYou.claimId, f.claimId));
  return where.length ? and(...where) : undefined;
}

const priorityOrder = sql`case ${needsYou.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`;

/** Urgent first, then oldest first within a priority. */
export function listNeedsYou(db: Db, filter: ListNeedsYouFilter = {}): NeedsYouRecord[] {
  return db
    .select()
    .from(needsYou)
    .where(needsYouWhere(filter))
    .orderBy(asc(priorityOrder), asc(needsYou.createdAt), desc(sql`rowid`))
    .limit(Math.max(1, Math.min(filter.limit ?? 200, 1000)))
    .offset(filter.offset ?? 0)
    .all()
    .map(toItem);
}

export interface NeedsYouCount {
  total: number;
  byPriority: Record<NeedsYouPriority, number>;
}

/** Count by priority (default: open items only — the top-bar badge). */
export function countNeedsYou(db: Db, filter: Omit<ListNeedsYouFilter, 'limit' | 'offset'> = { status: 'open' }): NeedsYouCount {
  const rows = db.select({ priority: needsYou.priority, n: sql<number>`count(*)` }).from(needsYou).where(needsYouWhere(filter)).groupBy(needsYou.priority).all();
  const byPriority: Record<NeedsYouPriority, number> = { urgent: 0, high: 0, normal: 0, low: 0 };
  for (const r of rows) byPriority[r.priority] = Number(r.n);
  return { total: Object.values(byPriority).reduce((a, b) => a + b, 0), byPriority };
}

export interface TransitionNeedsYouInput {
  to: NeedsYouStatus;
  actor: string;
  optionId?: string;
  note?: string;
  resolution?: unknown;
  snoozedUntil?: ISODateTime;
  now?: ISODateTime;
}

/** Move an item to another status (validated) and append the event. */
export function transitionNeedsYou(db: Db, id: string, input: TransitionNeedsYouInput): NeedsYouRecord {
  const item = requireNeedsYouItem(db, id);
  if (!ALLOWED[item.status].includes(input.to)) throw new ValidationError(`Needs-you item ${id} cannot move from ${item.status} to ${input.to}`);
  const now = input.now ?? nowIso();
  const closing = input.to === 'resolved' || input.to === 'expired' || input.to === 'superseded';
  const set: Partial<typeof needsYou.$inferInsert> = {
    status: input.to,
    snoozedUntil: input.to === 'snoozed' ? (input.snoozedUntil ?? null) : null,
    ...(closing ? { resolvedBy: input.actor, resolvedAt: now, resolution: input.resolution ?? (input.optionId ? { optionId: input.optionId, note: input.note ?? null } : null) } : {}),
  };
  const rows = db.update(needsYou).set(set).where(eq(needsYou.id, id)).returning().all();
  db.insert(needsYouEvents).values({ id: randomUUID(), needsYouId: id, fromStatus: item.status, toStatus: input.to, actor: input.actor, optionId: input.optionId ?? null, note: input.note ?? null, at: now }).run();
  return toItem(rows[0]!);
}

export function snoozeNeedsYou(db: Db, id: string, input: { until: ISODateTime; actor: string; note?: string; now?: ISODateTime }): NeedsYouRecord {
  return transitionNeedsYou(db, id, { to: 'snoozed', actor: input.actor, snoozedUntil: input.until, note: input.note, now: input.now });
}

export function resolveNeedsYou(db: Db, id: string, input: { actor: string; optionId?: string; note?: string; resolution?: unknown; now?: ISODateTime }): NeedsYouRecord {
  return transitionNeedsYou(db, id, { to: 'resolved', ...input });
}

/** Snoozed items whose time has come go back to `open` (actor 'system'). Returns the woken items. */
export function wakeSnoozedNeedsYou(db: Db, now: ISODateTime): NeedsYouRecord[] {
  const due = db.select({ id: needsYou.id }).from(needsYou).where(and(eq(needsYou.status, 'snoozed'), lte(needsYou.snoozedUntil, now))).all();
  return due.map((d) => transitionNeedsYou(db, d.id, { to: 'open', actor: 'system', note: 'snooze ended', now }));
}

export function listNeedsYouEvents(db: Db, needsYouId: string): NeedsYouEventRecord[] {
  return db.select().from(needsYouEvents).where(eq(needsYouEvents.needsYouId, needsYouId)).orderBy(asc(needsYouEvents.at), asc(sql`rowid`)).all().map(toEvent);
}
