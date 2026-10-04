/**
 * Manual GTA benchmark rates and segment → group defaults (migration 0003, TEMPLATES-VEHICLES-DESKTOP §F.3).
 *
 * The KB rate file (`packages/kb/data/gta-rates.json`) stays read-only; rows here replace or hide a KB row per
 * (group, period) through `mergeGtaRates` in @ccguk/domain. GTA rates are an industry benchmark only — CCGUK is not a GTA
 * subscriber. A row is `verified` only when a person set it with an https source URL; the API stamps verifiedBy and
 * verifiedAt from the session, and this repository refuses anything else (convention 6). Callers audit their writes.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Id, ISODate, ISODateTime, ManualGtaRateRow, Pence, Verification } from '@ccguk/domain';
import type { Db } from '../client.js';
import { DbError, NotFoundError, ValidationError, VerificationError } from '../errors.js';
import { gtaRates, gtaSegmentDefaults, type GtaRateRow } from '../schema.js';
import { newId, nowIso } from '../util.js';
import type { Actor } from './audit.js';

export const GTA_GROUP_PATTERN = /^[A-Z]{1,3}\d{0,2}$/;
export const GTA_PERIOD_PATTERN = /^\d{4}-\d{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A stored manual row (the domain merge shape plus who/when). */
export interface GtaRateRecord extends ManualGtaRateRow {
  createdAt: ISODateTime;
  createdBy: Id | 'system';
  updatedAt: ISODateTime;
  updatedBy: Id | 'system';
}

export interface GtaRateInput {
  group: string;
  description?: string;
  dailyRatePence: Pence;
  period: string;
  effectiveFrom: ISODate;
  effectiveTo: ISODate;
  verification: Verification;
  note?: string;
}

/** Thrown when a manual row for the same group and period already exists (API: 409 GTA_RATE_EXISTS). */
export class GtaRateExistsError extends DbError {
  constructor(group: string, period: string) {
    super('GTA_RATE_EXISTS', `A rate for group ${group} and period ${period} already exists — edit that row instead`);
  }
}

function toRecord(row: GtaRateRow): GtaRateRecord {
  const out: GtaRateRecord = {
    id: row.id,
    group: row.groupCode,
    period: row.period,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    verification: row.verification,
    suppressed: row.suppressed,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
  if (row.description !== null) out.description = row.description;
  if (row.dailyRatePence !== null) out.dailyRatePence = row.dailyRatePence;
  if (row.note !== null) out.note = row.note;
  return out;
}

function normaliseGroup(group: string): string {
  return (group ?? '').trim().toUpperCase();
}

function isRealDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function checkKey(group: string, period: string): void {
  if (!GTA_GROUP_PATTERN.test(group)) throw new ValidationError(`GTA group "${group}" must look like S1, M, M1 or CP2 (1–3 capital letters, up to 2 digits)`);
  if (!GTA_PERIOD_PATTERN.test(period)) throw new ValidationError(`period "${period}" must look like 2026-27`);
}

function checkDates(from: string, to: string): void {
  if (!isRealDate(from) || !isRealDate(to)) throw new ValidationError('effectiveFrom and effectiveTo must be dates (YYYY-MM-DD)');
  if (from > to) throw new ValidationError('effectiveFrom must be on or before effectiveTo');
}

/** Convention 6: a stored 'verified' needs a person and an https source. Never set here on anyone's behalf. */
function checkVerification(v: Verification, actor: Actor): void {
  if (v.status !== 'verified') return;
  if (actor.userId === 'system') throw new VerificationError('only a person can mark a GTA rate verified');
  if (!v.sourceUrl || !/^https:\/\/\S+$/i.test(v.sourceUrl)) throw new VerificationError('a verified GTA rate needs an https:// source URL');
  if (!v.verifiedBy || !v.verifiedAt) throw new VerificationError('a verified GTA rate records who verified it and when');
}

function checkInput(input: GtaRateInput, actor: Actor): { group: string } {
  const group = normaliseGroup(input.group);
  checkKey(group, input.period);
  checkDates(input.effectiveFrom, input.effectiveTo);
  if (!Number.isInteger(input.dailyRatePence) || input.dailyRatePence <= 0) throw new ValidationError('dailyRatePence must be a positive whole number of pence');
  checkVerification(input.verification, actor);
  return { group };
}

export function listGtaRates(db: Db): GtaRateRecord[] {
  return db.select().from(gtaRates).orderBy(asc(gtaRates.groupCode), asc(gtaRates.period)).all().map(toRecord);
}

export function getGtaRate(db: Db, id: Id): GtaRateRecord | undefined {
  const row = db.select().from(gtaRates).where(eq(gtaRates.id, id)).get();
  return row ? toRecord(row) : undefined;
}

export function requireGtaRate(db: Db, id: Id): GtaRateRecord {
  const r = getGtaRate(db, id);
  if (!r) throw new NotFoundError('gta rate', id);
  return r;
}

export function findGtaRate(db: Db, group: string, period: string): GtaRateRecord | undefined {
  const row = db
    .select()
    .from(gtaRates)
    .where(and(eq(gtaRates.groupCode, normaliseGroup(group)), eq(gtaRates.period, period.trim())))
    .get();
  return row ? toRecord(row) : undefined;
}

export function createGtaRate(db: Db, input: GtaRateInput, actor: Actor): GtaRateRecord {
  const { group } = checkInput(input, actor);
  if (findGtaRate(db, group, input.period)) throw new GtaRateExistsError(group, input.period);
  const id = newId();
  const now = nowIso();
  db.insert(gtaRates)
    .values({
      id,
      groupCode: group,
      description: input.description ?? null,
      dailyRatePence: input.dailyRatePence,
      period: input.period,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      verification: input.verification,
      suppressed: false,
      note: input.note ?? null,
      createdAt: now,
      createdBy: actor.userId,
      updatedAt: now,
      updatedBy: actor.userId,
    })
    .run();
  return requireGtaRate(db, id);
}

/** Replace a row's values (the suppressed flag is kept). Moving it onto another row's (group, period) is refused. */
export function updateGtaRate(db: Db, id: Id, input: GtaRateInput, actor: Actor): GtaRateRecord {
  const before = requireGtaRate(db, id);
  const { group } = checkInput(input, actor);
  const clash = findGtaRate(db, group, input.period);
  if (clash && clash.id !== id) throw new GtaRateExistsError(group, input.period);
  db.update(gtaRates)
    .set({
      groupCode: group,
      description: input.description ?? null,
      dailyRatePence: input.dailyRatePence,
      period: input.period,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      verification: input.verification,
      suppressed: before.suppressed,
      note: input.note ?? null,
      updatedAt: nowIso(),
      updatedBy: actor.userId,
    })
    .where(eq(gtaRates.id, id))
    .run();
  return requireGtaRate(db, id);
}

/** Hard delete (the KB row, if any, shows again). */
export function deleteGtaRate(db: Db, id: Id): GtaRateRecord {
  const before = requireGtaRate(db, id);
  db.delete(gtaRates).where(eq(gtaRates.id, id)).run();
  return before;
}

/**
 * Hide (or show again) the rate for a group and period. Hiding with no row stores a suppress row (no daily rate) using
 * `fallback` for the dates (the KB row's); showing again deletes a pure suppress row, or clears the flag on a row that
 * carries its own rate. Returns the row as stored, or undefined when it was deleted.
 */
export function setGtaRateSuppressed(
  db: Db,
  input: { group: string; period: string; suppressed: boolean },
  actor: Actor,
  fallback?: { effectiveFrom: ISODate; effectiveTo: ISODate; description?: string },
): GtaRateRecord | undefined {
  const group = normaliseGroup(input.group);
  checkKey(group, input.period);
  const existing = findGtaRate(db, group, input.period);
  const now = nowIso();
  if (existing) {
    if (!input.suppressed && existing.dailyRatePence === undefined) {
      db.delete(gtaRates).where(eq(gtaRates.id, existing.id)).run();
      return undefined;
    }
    db.update(gtaRates).set({ suppressed: input.suppressed, updatedAt: now, updatedBy: actor.userId }).where(eq(gtaRates.id, existing.id)).run();
    return requireGtaRate(db, existing.id);
  }
  if (!input.suppressed) return undefined;
  if (!fallback) throw new NotFoundError('gta rate', `${group} ${input.period}`);
  checkDates(fallback.effectiveFrom, fallback.effectiveTo);
  const id = newId();
  db.insert(gtaRates)
    .values({
      id,
      groupCode: group,
      description: fallback.description ?? null,
      dailyRatePence: null,
      period: input.period,
      effectiveFrom: fallback.effectiveFrom,
      effectiveTo: fallback.effectiveTo,
      verification: { status: 'unverified', sourceNote: 'Hidden in Settings → GTA benchmark rates' },
      suppressed: true,
      note: null,
      createdAt: now,
      createdBy: actor.userId,
      updatedAt: now,
      updatedBy: actor.userId,
    })
    .run();
  return requireGtaRate(db, id);
}

// ---------------------------------------------------------------------------
// Segment → group defaults (overrides of packages/kb/data/gta-segment-defaults.json)
// ---------------------------------------------------------------------------

export interface GtaSegmentDefault {
  segment: string;
  group: string;
  updatedAt: ISODateTime;
  updatedBy: Id | 'system';
}

export function listGtaSegmentDefaults(db: Db): GtaSegmentDefault[] {
  return db
    .select()
    .from(gtaSegmentDefaults)
    .orderBy(asc(gtaSegmentDefaults.segment))
    .all()
    .map((r) => ({ segment: r.segment, group: r.groupCode, updatedAt: r.updatedAt, updatedBy: r.updatedBy }));
}

export function setGtaSegmentDefault(db: Db, segment: string, group: string, actor: Actor): GtaSegmentDefault {
  const seg = (segment ?? '').trim();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(seg)) throw new ValidationError(`segment "${segment}" is not a catalogue segment id`);
  const g = normaliseGroup(group);
  if (!GTA_GROUP_PATTERN.test(g)) throw new ValidationError(`GTA group "${group}" must look like S1, M, M1 or CP2`);
  const row = { segment: seg, groupCode: g, updatedAt: nowIso(), updatedBy: actor.userId };
  db.insert(gtaSegmentDefaults).values(row).onConflictDoUpdate({ target: gtaSegmentDefaults.segment, set: { groupCode: row.groupCode, updatedAt: row.updatedAt, updatedBy: row.updatedBy } }).run();
  return { segment: seg, group: g, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
}

/** Back to the KB default. Returns false when there was no override. */
export function deleteGtaSegmentDefault(db: Db, segment: string): boolean {
  const res = db.delete(gtaSegmentDefaults).where(eq(gtaSegmentDefaults.segment, segment)).run();
  return res.changes > 0;
}
