/**
 * Claim tasks scheduled by the case manager (`task_schedule`) or the owner; `task.due` fires them (§C.2, §C.5 step 7).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { Actor } from './audit.js';
import type { ISODateTime, TaskStatus } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { tasks, type TaskRow } from '../schema.js';
import { denull, nowIso } from '../util.js';

export interface TaskRecord {
  id: string;
  claimId: string;
  kind: string;
  title: string;
  note?: string;
  actionCode?: string;
  dueAt: ISODateTime;
  status: TaskStatus;
  createdBy: string;
  createdAt: ISODateTime;
  completedBy?: string;
  completedAt?: ISODateTime;
  sourceRunId?: string;
}

export interface CreateTaskInput {
  claimId: string;
  kind: string;
  title: string;
  note?: string;
  actionCode?: string;
  dueAt: ISODateTime;
  createdBy: string;
  sourceRunId?: string;
  now?: ISODateTime;
}

const toTask = (r: TaskRow): TaskRecord => denull(r) as TaskRecord;

export function createTask(db: Db, input: CreateTaskInput): TaskRecord {
  if (!input.title.trim()) throw new ValidationError('task title is required');
  const row = {
    id: randomUUID(),
    claimId: input.claimId,
    kind: input.kind,
    title: input.title,
    note: input.note ?? null,
    actionCode: input.actionCode ?? null,
    dueAt: input.dueAt,
    status: 'open' as const,
    createdBy: input.createdBy,
    createdAt: input.now ?? nowIso(),
    sourceRunId: input.sourceRunId ?? null,
  };
  return toTask(db.insert(tasks).values(row).returning().get());
}

export function getTask(db: Db, id: string): TaskRecord | undefined {
  const r = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return r ? toTask(r) : undefined;
}

export function requireTask(db: Db, id: string): TaskRecord {
  const t = getTask(db, id);
  if (!t) throw new NotFoundError('tasks', id);
  return t;
}

export interface ListTasksFilter {
  claimId?: string;
  status?: TaskStatus | readonly TaskStatus[];
  dueBefore?: ISODateTime;
  limit?: number;
  offset?: number;
}

/** Soonest due first. */
export function listTasks(db: Db, filter: ListTasksFilter = {}): TaskRecord[] {
  const where: SQL[] = [];
  if (filter.claimId) where.push(eq(tasks.claimId, filter.claimId));
  const st = filter.status === undefined ? undefined : Array.isArray(filter.status) ? [...filter.status] : [filter.status as TaskStatus];
  if (st?.length) where.push(inArray(tasks.status, st));
  if (filter.dueBefore) where.push(lte(tasks.dueAt, filter.dueBefore));
  return db
    .select()
    .from(tasks)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(tasks.dueAt), asc(sql`rowid`))
    .limit(Math.max(1, Math.min(filter.limit ?? 200, 1000)))
    .offset(filter.offset ?? 0)
    .all()
    .map(toTask);
}

/** Open tasks due at or before `now`. */
export function listDueTasks(db: Db, now: ISODateTime, limit = 200): TaskRecord[] {
  return listTasks(db, { status: 'open', dueBefore: now, limit });
}

function close(db: Db, id: string, status: 'done' | 'cancelled', actor: Actor, now: ISODateTime): TaskRecord {
  const t = requireTask(db, id);
  if (t.status !== 'open') throw new ValidationError(`Task ${id} is already ${t.status}`);
  return toTask(db.update(tasks).set({ status, completedBy: actor.userId, completedAt: now }).where(eq(tasks.id, id)).returning().get()!);
}

export function completeTask(db: Db, id: string, actor: Actor, now: ISODateTime = nowIso()): TaskRecord {
  return close(db, id, 'done', actor, now);
}

export function cancelTask(db: Db, id: string, actor: Actor, now: ISODateTime = nowIso()): TaskRecord {
  return close(db, id, 'cancelled', actor, now);
}

export function rescheduleTask(db: Db, id: string, dueAt: ISODateTime): TaskRecord {
  const t = requireTask(db, id);
  if (t.status !== 'open') throw new ValidationError(`Task ${id} is ${t.status}; only open tasks are rescheduled`);
  return toTask(db.update(tasks).set({ dueAt }).where(eq(tasks.id, id)).returning().get()!);
}
