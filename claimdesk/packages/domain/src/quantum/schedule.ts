/**
 * Schedule of loss from the ledger (money.md §3 "Quantum — building the number on a motor file";
 * BLUEPRINT §1 "One source of truth"). Every line is derived from ledger entries, never typed:
 *
 *   claimed      = Σ 'claimed' entries (gross: amount + VAT); falls back to Σ 'invoiced' when no
 *                  'claimed' entry exists for the head; 'adjustment' entries are added with their sign
 *   paid         = Σ 'paid' + 'interim_paid'
 *   outstanding  = claimed − paid − written_off
 *   salvage      = a credit: its amounts are negated so the totals net it off (money.md §3)
 *
 * Superseded entries (another entry's `supersedesId` points at them) are excluded; so are entries dated
 * after `now`, so the schedule is "the position at time T". Each line carries the source document or
 * evidence id of its first claimed entry: "a schedule with evidence references settles for more".
 */
import type { ClaimBundle, HeadOfLoss, Id, ISODate, ISODateTime, LedgerEntry, Pence } from '../types.js';
import { londonDate } from '../calendar/index.js';
import { interest, type InterestBasis, type InterestResult } from './interest.js';

export interface ScheduleLine {
  head: HeadOfLoss;
  description: string;
  /** Gross claimed (net + VAT). Negative for the salvage credit. */
  claimedPence: Pence;
  netPence: Pence;
  vatPence: Pence;
  offeredPence?: Pence;
  reducedPence?: Pence;
  paidPence?: Pence;
  writtenOffPence?: Pence;
  outstandingPence: Pence;
  sourceDocumentId?: Id;
  sourceEvidenceId?: Id;
  /** Ledger entries the line was built from, for the audit trail. */
  entryIds: Id[];
}

export interface ScheduleTotals {
  claimed: Pence;
  offered: Pence;
  paid: Pence;
  outstanding: Pence;
}

export interface ScheduleOfLoss {
  claimId: Id;
  asOf: ISODate;
  lines: ScheduleLine[];
  totals: ScheduleTotals;
  interest?: InterestResult;
  notes: string[];
}

export interface ScheduleOptions {
  /** Add an interest computation on the outstanding total from `from` to `now`. */
  interest?: {
    basis: InterestBasis;
    from: ISODate | ISODateTime;
    annualRatePct?: number;
    baseRatePct?: number;
  };
}

/** Presentation order and letter labels for each head (money.md §3 table order). */
export const SCHEDULE_HEAD_ORDER: readonly HeadOfLoss[] = [
  'repair',
  'pav',
  'salvage',
  'diminution',
  'recovery',
  'storage',
  'hire',
  'engineer_fee',
  'excess',
  'loss_of_use',
  'personal_effects',
  'loss_of_earnings',
  'travel',
  'misc',
  'interest',
  'court_fee',
  'fixed_costs',
];

export const scheduleHeadLabels: Record<HeadOfLoss, string> = {
  repair: 'Repair costs',
  pav: 'Pre-accident value',
  salvage: 'Salvage (credit)',
  diminution: 'Diminution in value',
  recovery: 'Recovery',
  storage: 'Storage',
  hire: 'Credit hire charges',
  engineer_fee: "Engineer's fee",
  excess: 'Policy excess',
  loss_of_use: 'Loss of use',
  personal_effects: 'Personal effects',
  loss_of_earnings: 'Loss of earnings',
  travel: 'Travel and incidentals',
  misc: 'Miscellaneous',
  interest: 'Interest',
  court_fee: 'Court fee',
  fixed_costs: 'Fixed costs',
};

/** Heads that are consequences of the claim rather than loss (excluded from "other heads" comparisons). */
export const SCHEDULE_NON_LOSS_HEADS: readonly HeadOfLoss[] = ['interest', 'court_fee', 'fixed_costs'];

const gross = (e: LedgerEntry): Pence => e.amountPence + (e.vatPence ?? 0);
const sum = (xs: LedgerEntry[], f: (e: LedgerEntry) => Pence): Pence => xs.reduce((acc, e) => acc + f(e), 0);

/** Ledger entries that are live at `asOf`: not superseded and not dated after the as-of date. */
export function liveLedgerEntries(ledger: LedgerEntry[], asOf: ISODate): LedgerEntry[] {
  const superseded = new Set(ledger.map((e) => e.supersedesId).filter((x): x is string => !!x));
  return ledger.filter((e) => !superseded.has(e.id) && e.date <= asOf);
}

export function scheduleLineFor(head: HeadOfLoss, entries: LedgerEntry[]): ScheduleLine | undefined {
  const mine = entries.filter((e) => e.head === head);
  if (mine.length === 0) return undefined;
  const claimedEntries = mine.filter((e) => e.kind === 'claimed');
  const invoiced = mine.filter((e) => e.kind === 'invoiced');
  const positionEntries = claimedEntries.length > 0 ? claimedEntries : invoiced;
  const adjustments = mine.filter((e) => e.kind === 'adjustment');
  const offered = mine.filter((e) => e.kind === 'offered');
  const reduced = mine.filter((e) => e.kind === 'reduced');
  const paid = mine.filter((e) => e.kind === 'paid' || e.kind === 'interim_paid');
  const writtenOff = mine.filter((e) => e.kind === 'written_off');

  const sign = head === 'salvage' ? -1 : 1;
  const netPence = sign * (sum(positionEntries, (e) => e.amountPence) + sum(adjustments, (e) => e.amountPence));
  const vatPence = sign * (sum(positionEntries, (e) => e.vatPence ?? 0) + sum(adjustments, (e) => e.vatPence ?? 0));
  const claimedPence = netPence + vatPence;
  const paidPence = sign * sum(paid, gross);
  const writtenOffPence = sign * sum(writtenOff, gross);
  const offeredPence = sign * sum(offered, gross);
  const reducedPence = sign * sum(reduced, gross);
  const outstandingPence = claimedPence - paidPence - writtenOffPence;

  const descriptions = Array.from(new Set(positionEntries.map((e) => e.description.trim()).filter((d) => d.length > 0)));
  const description = descriptions.length > 0 ? descriptions.join('; ') : scheduleHeadLabels[head];
  const source = positionEntries.find((e) => e.sourceDocumentId || e.sourceEvidenceId);

  const line: ScheduleLine = {
    head,
    description,
    claimedPence,
    netPence,
    vatPence,
    outstandingPence,
    entryIds: mine.map((e) => e.id),
  };
  if (offered.length > 0) line.offeredPence = offeredPence;
  if (reduced.length > 0) line.reducedPence = reducedPence;
  if (paid.length > 0) line.paidPence = paidPence;
  if (writtenOff.length > 0) line.writtenOffPence = writtenOffPence;
  if (source?.sourceDocumentId) line.sourceDocumentId = source.sourceDocumentId;
  if (source?.sourceEvidenceId) line.sourceEvidenceId = source.sourceEvidenceId;
  return line;
}

export function scheduleOfLoss(bundle: ClaimBundle, now: ISODateTime, opts: ScheduleOptions = {}): ScheduleOfLoss {
  const asOf = londonDate(now);
  const entries = liveLedgerEntries(bundle.ledger, asOf);
  const lines: ScheduleLine[] = [];
  for (const head of SCHEDULE_HEAD_ORDER) {
    const line = scheduleLineFor(head, entries);
    if (line) lines.push(line);
  }
  const totals: ScheduleTotals = {
    claimed: lines.reduce((a, l) => a + l.claimedPence, 0),
    offered: lines.reduce((a, l) => a + (l.offeredPence ?? 0), 0),
    paid: lines.reduce((a, l) => a + (l.paidPence ?? 0), 0),
    outstanding: lines.reduce((a, l) => a + l.outstandingPence, 0),
  };
  const notes: string[] = [];
  if (lines.some((l) => !l.sourceDocumentId && !l.sourceEvidenceId)) {
    notes.push(
      `No source document against: ${lines
        .filter((l) => !l.sourceDocumentId && !l.sourceEvidenceId)
        .map((l) => scheduleHeadLabels[l.head])
        .join(', ')}. A schedule with a source document against every line settles for more (money.md §3).`,
    );
  }
  if (lines.some((l) => l.head === 'salvage')) notes.push('Salvage is shown as a credit (retained by the claimant) and netted off the totals.');
  if (!lines.some((l) => l.head === 'interest') && !opts.interest) notes.push('Interest is not yet on the schedule: claim it (money.md §3).');
  if (lines.some((l) => l.head === 'hire')) notes.push('Hire is claimed at the agreement rate; GTA rates are a commercial benchmark only (GTA 2.7(j)) — CCGUK is not a subscriber.');

  const out: ScheduleOfLoss = { claimId: bundle.claim.id, asOf, lines, totals, notes };
  if (opts.interest && totals.outstanding > 0) {
    out.interest = interest({
      principalPence: totals.outstanding,
      from: opts.interest.from,
      to: now,
      basis: opts.interest.basis,
      ...(opts.interest.annualRatePct !== undefined ? { annualRatePct: opts.interest.annualRatePct } : {}),
      ...(opts.interest.baseRatePct !== undefined ? { baseRatePct: opts.interest.baseRatePct } : {}),
    });
  }
  return out;
}
