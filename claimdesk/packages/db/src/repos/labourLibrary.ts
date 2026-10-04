import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { Id, ISODateTime, Pence } from '@ccguk/domain';
import type { Db } from '../client.js';
import { ValidationError } from '../errors.js';
import { labourLibrary, type LabourLibraryRow } from '../schema.js';
import { denull, newId, nowIso } from '../util.js';

/** One observed labour time from an approved CCGUK estimate (BLUEPRINT §4.5(c): own medians, never copied tables). */
export interface LabourLibraryEntry {
  id: Id;
  make: string;
  model: string;
  panel: string;
  operation: string;
  hours: number;
  ratePence?: Pence;
  source: 'approved_estimate' | 'manual';
  estimateId?: Id;
  createdAt: ISODateTime;
}

export type AddLabourInput = Omit<LabourLibraryEntry, 'id' | 'createdAt'> & { id?: Id; createdAt?: ISODateTime };

export interface LabourFilter {
  make?: string;
  model?: string;
  panel?: string;
  operation?: string;
}

const norm = (s: string) => s.trim().toLowerCase();

function toEntry(row: LabourLibraryRow): LabourLibraryEntry {
  return denull(row);
}

export function addLabourEntry(db: Db, input: AddLabourInput): LabourLibraryEntry {
  if (!Number.isFinite(input.hours) || input.hours <= 0) throw new ValidationError('hours must be a positive number');
  const id = input.id ?? newId();
  db.insert(labourLibrary)
    .values({ ...input, id, make: norm(input.make), model: norm(input.model), panel: norm(input.panel), operation: norm(input.operation), createdAt: input.createdAt ?? nowIso() })
    .run();
  return toEntry(db.select().from(labourLibrary).where(eq(labourLibrary.id, id)).get()!);
}

export function listLabourEntries(db: Db, filter: LabourFilter = {}): LabourLibraryEntry[] {
  const where: SQL[] = [];
  if (filter.make) where.push(eq(labourLibrary.make, norm(filter.make)));
  if (filter.model) where.push(eq(labourLibrary.model, norm(filter.model)));
  if (filter.panel) where.push(eq(labourLibrary.panel, norm(filter.panel)));
  if (filter.operation) where.push(eq(labourLibrary.operation, norm(filter.operation)));
  return db
    .select()
    .from(labourLibrary)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(labourLibrary.make), asc(labourLibrary.model), asc(labourLibrary.panel), asc(labourLibrary.operation), asc(labourLibrary.createdAt))
    .all()
    .map(toEntry);
}

export interface LabourStat {
  make: string;
  model: string;
  panel: string;
  operation: string;
  count: number;
  medianHours: number;
  minHours: number;
  maxHours: number;
}

/** Median hours per (make, model, panel, operation) — the figure the estimate module suggests, flagged by sample size. */
export function labourStats(db: Db, filter: LabourFilter = {}): LabourStat[] {
  const entries = listLabourEntries(db, filter);
  const groups = new Map<string, LabourLibraryEntry[]>();
  for (const e of entries) {
    const key = `${e.make}|${e.model}|${e.panel}|${e.operation}`;
    const g = groups.get(key) ?? [];
    g.push(e);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const hours = g.map((e) => e.hours).sort((a, b) => a - b);
    const mid = Math.floor(hours.length / 2);
    const median = hours.length % 2 ? hours[mid]! : (hours[mid - 1]! + hours[mid]!) / 2;
    const first = g[0]!;
    return { make: first.make, model: first.model, panel: first.panel, operation: first.operation, count: g.length, medianHours: median, minHours: hours[0]!, maxHours: hours[hours.length - 1]! };
  });
}

export function countLabourEntries(db: Db): number {
  return db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(labourLibrary).get()?.n ?? 0;
}
