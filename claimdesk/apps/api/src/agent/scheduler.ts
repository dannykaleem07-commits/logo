// owned by runtime
/**
 * Agent schedules (docs/SUPREME-DESIGN.md §C.2, §C.6): `agent_schedules` rows seeded on boot (idempotent) and
 * materialised by the supervisor tick into queue jobs with the §C.2 idempotency keys. Times of day are Europe/London
 * wall-clock times (BST/GMT handled by the domain calendar helpers), so 18:00 stays 18:00 across a clock change.
 */
import { londonWallToUtc, utcToLondonWall, type ISODateTime, type JobType } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { JobRecord } from './contracts.js';
import { enqueueJob, londonDay } from './core.js';
import { getJobHandler } from './handlers/index.js';

export interface ScheduleDef {
  id: string;
  jobType: JobType;
  payload?: unknown;
  /** Every N minutes, aligned to the clock (…:00, :05, :10 for 5). */
  everyMinutes?: number;
  /** HH:MM Europe/London. */
  atLocal?: string;
  /** ISO weekdays 1 = Monday … 7 = Sunday (null/undefined = every day). */
  weekdays?: number[];
}

export interface ScheduleRecord extends ScheduleDef {
  enabled: boolean;
  nextRunAt: ISODateTime;
  lastRunAt?: ISODateTime;
  lastJobId?: string;
  updatedAt: ISODateTime;
}

const WEEKDAYS = [1, 2, 3, 4, 5];

/** The Phase 1 schedules (§C.2). `dailylog.compile` takes its time from notification settings when seeded. */
export const DEFAULT_SCHEDULES: readonly ScheduleDef[] = [
  { id: 'mail.sync', jobType: 'mail.sync', everyMinutes: 5 },
  { id: 'task.due', jobType: 'task.due', everyMinutes: 15 },
  { id: 'case.sweep.am', jobType: 'case.sweep', atLocal: '07:30', weekdays: WEEKDAYS, payload: { slot: 'am' } },
  { id: 'case.sweep.pm', jobType: 'case.sweep', atLocal: '13:30', weekdays: WEEKDAYS, payload: { slot: 'pm' } },
  { id: 'dailylog.compile', jobType: 'dailylog.compile', atLocal: '18:00' },
  { id: 'clocks.refresh', jobType: 'clocks.refresh', everyMinutes: 60 },
  { id: 'watch.poll', jobType: 'watch.poll', atLocal: '02:15' },
  { id: 'retention.cleanup', jobType: 'retention.cleanup', atLocal: '03:00' },
  { id: 'index.fts', jobType: 'index.fts', everyMinutes: 10, payload: { sourceKind: 'sweep' } },
  // Autopilot (docs/SUPREME-AUTOPILOT.md §H.1). A schedule whose job type has no handler yet is advanced without a job.
  { id: 'autopilot.sweep', jobType: 'autopilot.sweep', everyMinutes: 5 },
  { id: 'booking.expire_holds', jobType: 'booking.expire_holds', everyMinutes: 5 },
  { id: 'fleet.status_sync', jobType: 'fleet.status_sync', everyMinutes: 60 },
  { id: 'fleet.compliance_watch', jobType: 'fleet.compliance_watch', atLocal: '06:30' },
  { id: 'clash.sweep', jobType: 'clash.sweep', atLocal: '02:30' },
  { id: 'signing.chase', jobType: 'signing.chase', atLocal: '09:15', weekdays: WEEKDAYS },
  { id: 'signing.match_return', jobType: 'signing.match_return', everyMinutes: 15 },
  { id: 'movement.remind', jobType: 'movement.remind', atLocal: '16:00' },
];

/** The Autopilot schedule ids (§H.1), seeded with the Phase 1 ones. */
export const AUTOPILOT_SCHEDULE_IDS: readonly string[] = ['autopilot.sweep', 'booking.expire_holds', 'fleet.status_sync', 'fleet.compliance_watch', 'clash.sweep', 'signing.chase', 'signing.match_return', 'movement.remind'];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isHhmm = (s: unknown): s is string => typeof s === 'string' && HHMM.test(s);

/** ISO weekday (1..7) of a London calendar date given as wall-ms. */
const isoWeekday = (wallMs: number): number => {
  const d = new Date(wallMs).getUTCDay();
  return d === 0 ? 7 : d;
};

/** The next run strictly after `after`. */
export function nextRunAfter(def: Pick<ScheduleDef, 'everyMinutes' | 'atLocal' | 'weekdays'>, after: ISODateTime): ISODateTime {
  const t = Date.parse(after);
  if (def.everyMinutes && def.everyMinutes > 0) {
    const period = def.everyMinutes * 60_000;
    return new Date((Math.floor(t / period) + 1) * period).toISOString();
  }
  if (!isHhmm(def.atLocal)) throw new Error(`schedule needs everyMinutes or atLocal HH:MM (got ${String(def.atLocal)})`);
  const [hh, mm] = def.atLocal.split(':').map(Number) as [number, number];
  const wall = new Date(utcToLondonWall(t));
  const days = def.weekdays?.length ? def.weekdays : [1, 2, 3, 4, 5, 6, 7];
  for (let d = 0; d <= 8; d += 1) {
    const dayWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + d);
    if (!days.includes(isoWeekday(dayWall))) continue;
    const candidate = londonWallToUtc(dayWall + hh * 3_600_000 + mm * 60_000);
    if (candidate > t) return new Date(candidate).toISOString();
  }
  throw new Error('schedule has no valid weekday');
}

/** §C.2 idempotency key for a scheduled slot. */
export function scheduleIdempotencyKey(def: Pick<ScheduleDef, 'id' | 'jobType' | 'payload'>, slot: ISODateTime): string {
  const minute = slot.slice(0, 16);
  const day = londonDay(slot);
  switch (def.jobType) {
    case 'mail.sync': {
      const account = typeof (def.payload as { accountId?: unknown } | undefined)?.accountId === 'string' ? (def.payload as { accountId: string }).accountId : 'default';
      return `mail.sync:${account}:${minute}`;
    }
    case 'case.sweep':
      return `case.sweep:${day}:${String((def.payload as { slot?: unknown } | undefined)?.slot ?? def.id)}`;
    case 'dailylog.compile':
      return `dailylog.compile:${day}`;
    case 'clocks.refresh':
      return `clocks.refresh:${slot.slice(0, 13)}`;
    case 'watch.poll':
      return `watch.poll:${day}`;
    case 'retention.cleanup':
      return `retention:${day}`;
    case 'index.fts':
      return `index.fts:sweep:${minute}`;
    // Autopilot (§H.1)
    case 'autopilot.sweep':
    case 'booking.expire_holds':
    case 'signing.match_return':
      return `${def.jobType}:${minute}`;
    case 'fleet.status_sync':
      return `fleet.status_sync:${slot.slice(0, 13)}`;
    case 'fleet.compliance_watch':
    case 'clash.sweep':
    case 'signing.chase':
    case 'movement.remind':
      return `${def.jobType}:${day}`;
    default:
      return `${def.jobType}:${def.id}:${minute}`;
  }
}

interface Row {
  id: string;
  job_type: string;
  payload: string;
  every_minutes: number | null;
  at_local: string | null;
  weekdays: string | null;
  enabled: number;
  next_run_at: string;
  last_run_at: string | null;
  last_job_id: string | null;
  updated_at: string;
}

const json = <T>(s: string | null, fallback: T): T => {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const toRecord = (r: Row): ScheduleRecord => {
  const weekdays = json<number[] | null>(r.weekdays, null);
  return {
    id: r.id,
    jobType: r.job_type as JobType,
    payload: json<unknown>(r.payload, {}) ?? {},
    ...(r.every_minutes !== null ? { everyMinutes: r.every_minutes } : {}),
    ...(r.at_local !== null ? { atLocal: r.at_local } : {}),
    ...(weekdays?.length ? { weekdays } : {}),
    enabled: Boolean(r.enabled),
    nextRunAt: r.next_run_at,
    ...(r.last_run_at ? { lastRunAt: r.last_run_at } : {}),
    ...(r.last_job_id ? { lastJobId: r.last_job_id } : {}),
    updatedAt: r.updated_at,
  };
};

export function listSchedules(ctx: AppContext): ScheduleRecord[] {
  return (ctx.handle.sqlite.prepare('SELECT * FROM agent_schedules ORDER BY id').all() as Row[]).map(toRecord);
}

export function getSchedule(ctx: AppContext, id: string): ScheduleRecord | undefined {
  const r = ctx.handle.sqlite.prepare('SELECT * FROM agent_schedules WHERE id = ?').get(id) as Row | undefined;
  return r ? toRecord(r) : undefined;
}

/** Insert the default schedules that are missing (existing rows — the owner's edits — are kept). Idempotent. */
export function seedSchedules(ctx: AppContext, now: ISODateTime = ctx.now()): ScheduleRecord[] {
  const dailyAt = ctx.repos.getAgentSettings(ctx.db).notifications.dailyLogAt;
  const insert = ctx.handle.sqlite.prepare(
    `INSERT INTO agent_schedules (id, job_type, payload, every_minutes, at_local, weekdays, enabled, next_run_at, updated_at)
     VALUES (@id, @jobType, @payload, @everyMinutes, @atLocal, @weekdays, 1, @nextRunAt, @now) ON CONFLICT(id) DO NOTHING`,
  );
  for (const def of DEFAULT_SCHEDULES) {
    const d = def.id === 'dailylog.compile' && isHhmm(dailyAt) ? { ...def, atLocal: dailyAt } : def;
    insert.run({
      id: d.id,
      jobType: d.jobType,
      payload: JSON.stringify(d.payload ?? {}),
      everyMinutes: d.everyMinutes ?? null,
      atLocal: d.atLocal ?? null,
      weekdays: d.weekdays ? JSON.stringify(d.weekdays) : null,
      nextRunAt: nextRunAfter(d, now),
      now,
    });
  }
  return listSchedules(ctx);
}

function writeSchedule(ctx: AppContext, id: string, set: { enabled?: boolean; everyMinutes?: number | null; atLocal?: string | null; weekdays?: number[] | null; nextRunAt?: string; lastRunAt?: string; lastJobId?: string; updatedAt: string }): void {
  const cols: string[] = [];
  const params: Record<string, unknown> = { id };
  const put = (col: string, key: string, v: unknown): void => {
    cols.push(`${col} = @${key}`);
    params[key] = v;
  };
  if (set.enabled !== undefined) put('enabled', 'enabled', set.enabled ? 1 : 0);
  if (set.everyMinutes !== undefined) put('every_minutes', 'everyMinutes', set.everyMinutes);
  if (set.atLocal !== undefined) put('at_local', 'atLocal', set.atLocal);
  if (set.weekdays !== undefined) put('weekdays', 'weekdays', set.weekdays ? JSON.stringify(set.weekdays) : null);
  if (set.nextRunAt !== undefined) put('next_run_at', 'nextRunAt', set.nextRunAt);
  if (set.lastRunAt !== undefined) put('last_run_at', 'lastRunAt', set.lastRunAt);
  if (set.lastJobId !== undefined) put('last_job_id', 'lastJobId', set.lastJobId);
  put('updated_at', 'updatedAt', set.updatedAt);
  ctx.handle.sqlite.prepare(`UPDATE agent_schedules SET ${cols.join(', ')} WHERE id = @id`).run(params);
}

export interface SchedulePatch {
  enabled?: boolean;
  everyMinutes?: number | null;
  atLocal?: string | null;
  weekdays?: number[] | null;
}

/** Owner edit (enable/disable, time). Recomputes the next run. */
export function updateSchedule(ctx: AppContext, id: string, patch: SchedulePatch, now: ISODateTime = ctx.now()): ScheduleRecord | undefined {
  const cur = getSchedule(ctx, id);
  if (!cur) return undefined;
  const next: ScheduleDef = {
    id,
    jobType: cur.jobType,
    payload: cur.payload,
    ...(patch.everyMinutes !== undefined ? (patch.everyMinutes ? { everyMinutes: patch.everyMinutes } : {}) : cur.everyMinutes ? { everyMinutes: cur.everyMinutes } : {}),
    ...(patch.atLocal !== undefined ? (patch.atLocal ? { atLocal: patch.atLocal } : {}) : cur.atLocal ? { atLocal: cur.atLocal } : {}),
    ...(patch.weekdays !== undefined ? (patch.weekdays?.length ? { weekdays: patch.weekdays } : {}) : cur.weekdays ? { weekdays: cur.weekdays } : {}),
  };
  const timingChanged = patch.everyMinutes !== undefined || patch.atLocal !== undefined || patch.weekdays !== undefined;
  writeSchedule(ctx, id, {
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    everyMinutes: next.everyMinutes ?? null,
    atLocal: next.atLocal ?? null,
    weekdays: next.weekdays ?? null,
    ...(timingChanged || patch.enabled === true ? { nextRunAt: nextRunAfter(next, now) } : {}),
    updatedAt: now,
  });
  return getSchedule(ctx, id);
}

export interface MaterialisedRun {
  scheduleId: string;
  slot: ISODateTime;
  jobs: JobRecord[];
  skipped?: string;
}

/** Enqueue the job(s) for one schedule slot. `task.due` fans out one job per due task (`task.due:<taskId>`). */
export function enqueueScheduled(ctx: AppContext, def: ScheduleRecord | ScheduleDef, slot: ISODateTime, opts: { manual?: boolean; createdBy?: string } = {}): JobRecord[] {
  const createdBy = opts.createdBy ?? 'agent:supervisor';
  if (def.jobType === 'task.due') {
    return ctx.repos.listDueTasks(ctx.db, slot).map((t) =>
      enqueueJob(ctx, { type: 'task.due', payload: { taskId: t.id }, claimId: t.claimId, idempotencyKey: `task.due:${t.id}`, createdBy }),
    );
  }
  const key = opts.manual ? `${def.jobType}:manual:${slot}` : scheduleIdempotencyKey(def, slot);
  const payload = def.jobType === 'dailylog.compile' ? { ...((def.payload as object) ?? {}), day: londonDay(slot) } : (def.payload ?? {});
  return [enqueueJob(ctx, { type: def.jobType, payload, idempotencyKey: key, createdBy })];
}

/**
 * Materialise every enabled schedule whose `next_run_at` has come (one job per schedule however many slots were
 * missed while the PC was off). Schedules for job types with no registered handler are advanced without a job.
 */
export function runDueSchedules(ctx: AppContext, now: ISODateTime, opts: { hasHandler?: (t: JobType) => boolean } = {}): MaterialisedRun[] {
  const hasHandler = opts.hasHandler ?? ((t: JobType) => Boolean(getJobHandler(t)));
  const out: MaterialisedRun[] = [];
  for (const s of listSchedules(ctx)) {
    if (!s.enabled || s.nextRunAt > now) continue;
    const slot = s.nextRunAt;
    let jobs: JobRecord[] = [];
    let skipped: string | undefined;
    try {
      if (hasHandler(s.jobType)) jobs = enqueueScheduled(ctx, s, slot);
      else skipped = 'no handler registered';
    } catch (err) {
      skipped = `enqueue failed: ${String(err)}`;
      ctx.logger.warn('schedule enqueue failed', { scheduleId: s.id, error: String(err) });
    }
    writeSchedule(ctx, s.id, { nextRunAt: nextRunAfter(s, now), lastRunAt: now, ...(jobs[0] ? { lastJobId: jobs[0].id } : {}), updatedAt: now });
    out.push({ scheduleId: s.id, slot, jobs, ...(skipped ? { skipped } : {}) });
  }
  return out;
}

/** "Run now" from the control room. */
export function runScheduleNow(ctx: AppContext, id: string, actor: string, now: ISODateTime = ctx.now()): JobRecord[] | undefined {
  const s = getSchedule(ctx, id);
  if (!s) return undefined;
  const jobs = enqueueScheduled(ctx, s, now, { manual: true, createdBy: actor });
  writeSchedule(ctx, id, { lastRunAt: now, ...(jobs[0] ? { lastJobId: jobs[0].id } : {}), updatedAt: now });
  return jobs;
}
