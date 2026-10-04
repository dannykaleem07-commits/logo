import { asc, eq } from 'drizzle-orm';
import type { CompanyWatch, ISODateTime } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { companyWatch, type CompanyWatchRow } from '../schema.js';
import { compact, denull, nowIso } from '../util.js';

export type UpsertCompanyWatchInput = Omit<CompanyWatch, 'gazetteNotices' | 'officerChanges' | 'riskLevel' | 'riskReasons'> & {
  gazetteNotices?: CompanyWatch['gazetteNotices'];
  officerChanges?: CompanyWatch['officerChanges'];
  riskLevel?: CompanyWatch['riskLevel'];
  riskReasons?: string[];
};

function toWatch(row: CompanyWatchRow): CompanyWatch {
  const { createdAt: _c, updatedAt: _u, ...rest } = row;
  return denull(rest);
}

export function normaliseCompanyNumber(n: string): string {
  const s = n.trim().toUpperCase();
  return /^\d{1,7}$/.test(s) ? s.padStart(8, '0') : s;
}

/** Add or update a company on the watch list (e.g. CARFLEX LTD 12640635 as high risk). */
export function upsertCompanyWatch(db: Db, input: UpsertCompanyWatchInput): CompanyWatch {
  const companyNumber = normaliseCompanyNumber(input.companyNumber);
  if (!companyNumber) throw new ValidationError('companyNumber is required');
  const now = nowIso();
  const existing = db.select().from(companyWatch).where(eq(companyWatch.companyNumber, companyNumber)).get();
  if (existing) {
    db.update(companyWatch)
      .set({ ...compact({ ...input, companyNumber }), updatedAt: now })
      .where(eq(companyWatch.companyNumber, companyNumber))
      .run();
  } else {
    db.insert(companyWatch)
      .values({
        ...input,
        companyNumber,
        gazetteNotices: input.gazetteNotices ?? [],
        officerChanges: input.officerChanges ?? [],
        riskLevel: input.riskLevel ?? 'low',
        riskReasons: input.riskReasons ?? [],
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  return requireCompanyWatch(db, companyNumber);
}

export function getCompanyWatch(db: Db, companyNumber: string): CompanyWatch | undefined {
  const row = db.select().from(companyWatch).where(eq(companyWatch.companyNumber, normaliseCompanyNumber(companyNumber))).get();
  return row ? toWatch(row) : undefined;
}

export function requireCompanyWatch(db: Db, companyNumber: string): CompanyWatch {
  const w = getCompanyWatch(db, companyNumber);
  if (!w) throw new NotFoundError('company watch', companyNumber);
  return w;
}

export function listCompanyWatch(db: Db, filter: { riskLevel?: CompanyWatch['riskLevel'] } = {}): CompanyWatch[] {
  return db
    .select()
    .from(companyWatch)
    .where(filter.riskLevel ? eq(companyWatch.riskLevel, filter.riskLevel) : undefined)
    .orderBy(asc(companyWatch.name))
    .all()
    .map(toWatch);
}

export interface PollResult {
  status?: string;
  accountsOverdue?: boolean;
  confirmationStatementOverdue?: boolean;
  /** New notices/changes are merged (de-duplicated by date+type/note). */
  gazetteNotices?: CompanyWatch['gazetteNotices'];
  officerChanges?: CompanyWatch['officerChanges'];
  riskLevel?: CompanyWatch['riskLevel'];
  riskReasons?: string[];
  polledAt?: ISODateTime;
}

/** Record the outcome of a Companies House poll; merges notices and sets lastPolledAt. */
export function recordCompanyPoll(db: Db, companyNumber: string, result: PollResult): CompanyWatch {
  const current = requireCompanyWatch(db, companyNumber);
  const gazette = [...current.gazetteNotices];
  for (const n of result.gazetteNotices ?? []) {
    if (!gazette.some((g) => g.date === n.date && g.type === n.type && g.note === n.note)) gazette.push(n);
  }
  const officers = [...current.officerChanges];
  for (const o of result.officerChanges ?? []) {
    if (!officers.some((x) => x.date === o.date && x.note === o.note)) officers.push(o);
  }
  db.update(companyWatch)
    .set({
      ...compact({
        status: result.status,
        accountsOverdue: result.accountsOverdue,
        confirmationStatementOverdue: result.confirmationStatementOverdue,
        riskLevel: result.riskLevel,
        riskReasons: result.riskReasons,
      }),
      gazetteNotices: gazette,
      officerChanges: officers,
      lastPolledAt: result.polledAt ?? nowIso(),
      updatedAt: nowIso(),
    })
    .where(eq(companyWatch.companyNumber, current.companyNumber))
    .run();
  return requireCompanyWatch(db, current.companyNumber);
}

export function removeCompanyWatch(db: Db, companyNumber: string): void {
  db.delete(companyWatch).where(eq(companyWatch.companyNumber, normaliseCompanyNumber(companyNumber))).run();
}
