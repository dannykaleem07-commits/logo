import { and, asc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { HeadOfLoss, Id, ISODateTime, LedgerEntry, LedgerKind, Pence } from '@ccguk/domain';
import type { Db } from '../client.js';
import { LedgerImmutableError, NotFoundError, ValidationError } from '../errors.js';
import { ledgerEntries, type LedgerEntryRow } from '../schema.js';
import { denull, newId, nowIso } from '../util.js';

export type AppendLedgerInput = Omit<LedgerEntry, 'id' | 'createdAt'> & { id?: Id; createdAt?: ISODateTime };

function toEntry(row: LedgerEntryRow): LedgerEntry {
  return denull(row);
}

/** Append a ledger entry. Amounts must be integer pence; positive unless kind is 'adjustment'. */
export function appendLedgerEntry(db: Db, input: AppendLedgerInput): LedgerEntry {
  if (!Number.isInteger(input.amountPence)) throw new ValidationError('amountPence must be integer pence');
  if (input.kind !== 'adjustment' && input.amountPence < 0) throw new ValidationError(`amountPence must be positive for kind '${input.kind}' (sign is implied by kind)`);
  if (input.vatPence !== undefined && !Number.isInteger(input.vatPence)) throw new ValidationError('vatPence must be integer pence');
  if (input.supersedesId) {
    const prior = getLedgerEntry(db, input.supersedesId);
    if (!prior) throw new NotFoundError('ledger entry', input.supersedesId);
    if (prior.claimId !== input.claimId) throw new ValidationError('a correcting entry must be on the same claim as the entry it supersedes');
  }
  const id = input.id ?? newId();
  db.insert(ledgerEntries)
    .values({ ...input, id, createdAt: input.createdAt ?? nowIso() })
    .run();
  return requireLedgerEntry(db, id);
}

export function getLedgerEntry(db: Db, id: Id): LedgerEntry | undefined {
  const row = db.select().from(ledgerEntries).where(eq(ledgerEntries.id, id)).get();
  return row ? toEntry(row) : undefined;
}

export function requireLedgerEntry(db: Db, id: Id): LedgerEntry {
  const e = getLedgerEntry(db, id);
  if (!e) throw new NotFoundError('ledger entry', id);
  return e;
}

export interface ListLedgerFilter {
  head?: HeadOfLoss;
  kind?: LedgerKind;
  /** Default false: superseded entries are hidden. */
  includeSuperseded?: boolean;
}

/** Subquery of ids that have been superseded by a later entry on this claim. */
function supersededIds(claimId: Id) {
  return sql`(select ${ledgerEntries.supersedesId} from ${ledgerEntries} where ${ledgerEntries.claimId} = ${claimId} and ${ledgerEntries.supersedesId} is not null)`;
}

export function listLedger(db: Db, claimId: Id, filter: ListLedgerFilter = {}): LedgerEntry[] {
  const where: SQL[] = [eq(ledgerEntries.claimId, claimId)];
  if (filter.head) where.push(eq(ledgerEntries.head, filter.head));
  if (filter.kind) where.push(eq(ledgerEntries.kind, filter.kind));
  if (!filter.includeSuperseded) where.push(sql`${ledgerEntries.id} not in ${supersededIds(claimId)}`);
  const rows = db
    .select()
    .from(ledgerEntries)
    .where(and(...where))
    .orderBy(asc(ledgerEntries.date), asc(ledgerEntries.createdAt))
    .all();
  return rows.map(toEntry);
}

export interface LedgerSum {
  head: HeadOfLoss;
  kind: LedgerKind;
  amountPence: Pence;
  vatPence: Pence;
  count: number;
}

/** Totals grouped by head and kind, excluding superseded entries. */
export function sumLedger(db: Db, claimId: Id): LedgerSum[] {
  return db
    .select({
      head: ledgerEntries.head,
      kind: ledgerEntries.kind,
      amountPence: sql<number>`coalesce(sum(${ledgerEntries.amountPence}), 0)`.mapWith(Number),
      vatPence: sql<number>`coalesce(sum(${ledgerEntries.vatPence}), 0)`.mapWith(Number),
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.claimId, claimId), sql`${ledgerEntries.id} not in ${supersededIds(claimId)}`))
    .groupBy(ledgerEntries.head, ledgerEntries.kind)
    .orderBy(ledgerEntries.head, ledgerEntries.kind)
    .all();
}

export interface HeadPosition {
  head: HeadOfLoss;
  claimedPence: Pence;
  invoicedPence: Pence;
  offeredPence: Pence;
  reducedPence: Pence;
  paidPence: Pence; // paid + interim_paid
  writtenOffPence: Pence;
  adjustmentPence: Pence; // signed
  /** claimed − paid − writtenOff + adjustments */
  outstandingPence: Pence;
}

export type ClaimPosition = {
  heads: HeadPosition[];
  totals: Omit<HeadPosition, 'head'>;
};

const KIND_FIELD: Record<LedgerKind, keyof Omit<HeadPosition, 'head' | 'outstandingPence'>> = {
  claimed: 'claimedPence',
  invoiced: 'invoicedPence',
  offered: 'offeredPence',
  reduced: 'reducedPence',
  paid: 'paidPence',
  interim_paid: 'paidPence',
  written_off: 'writtenOffPence',
  adjustment: 'adjustmentPence',
};

function emptyPosition(): Omit<HeadPosition, 'head'> {
  return { claimedPence: 0, invoicedPence: 0, offeredPence: 0, reducedPence: 0, paidPence: 0, writtenOffPence: 0, adjustmentPence: 0, outstandingPence: 0 };
}

/** The claim's money position per head of loss, from the ledger alone (the single source of truth). */
export function ledgerPosition(db: Db, claimId: Id): ClaimPosition {
  const sums = sumLedger(db, claimId);
  const byHead = new Map<HeadOfLoss, HeadPosition>();
  for (const s of sums) {
    const pos = byHead.get(s.head) ?? { head: s.head, ...emptyPosition() };
    pos[KIND_FIELD[s.kind]] += s.amountPence;
    byHead.set(s.head, pos);
  }
  const totals = emptyPosition();
  const heads = [...byHead.values()].map((h) => {
    h.outstandingPence = h.claimedPence - h.paidPence - h.writtenOffPence + h.adjustmentPence;
    for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += h[k];
    return h;
  });
  return { heads, totals };
}

/** Total cleared funds received on the claim (paid + interim_paid), excluding superseded entries. */
export function totalPaid(db: Db, claimId: Id): Pence {
  return sumLedger(db, claimId)
    .filter((s) => s.kind === 'paid' || s.kind === 'interim_paid')
    .reduce((acc, s) => acc + s.amountPence, 0);
}

/** Entries that have been superseded (for audit display). */
export function listSupersededLedger(db: Db, claimId: Id): LedgerEntry[] {
  const ids = db
    .select({ id: ledgerEntries.supersedesId })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.claimId, claimId), isNotNull(ledgerEntries.supersedesId)))
    .all()
    .map((r) => r.id)
    .filter((x): x is string => Boolean(x));
  if (!ids.length) return [];
  return db
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.claimId, claimId), inArray(ledgerEntries.id, ids)))
    .orderBy(asc(ledgerEntries.date), asc(ledgerEntries.createdAt))
    .all()
    .map(toEntry);
}

/** Always throws — the ledger is append-only. Use `appendLedgerEntry` with `supersedesId` to correct. */
export function updateLedgerEntry(_db: Db, _id: Id, _patch: unknown): never {
  throw new LedgerImmutableError('update');
}

/** Always throws — the ledger is append-only. */
export function deleteLedgerEntry(_db: Db, _id: Id): never {
  throw new LedgerImmutableError('delete');
}
