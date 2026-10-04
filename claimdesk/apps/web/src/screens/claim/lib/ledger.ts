/**
 * Ledger presentation helpers (pure). The ledger is append-only: nothing here edits a row. Sums mirror
 * packages/db repos/ledger.ts `ledgerPosition`: outstanding = claimed − paid − interim paid − written off + adjustment,
 * excluding rows that a later row supersedes.
 */
import type { HeadOfLoss, ISODate, LedgerEntry, LedgerKind, Pence } from '@ccguk/domain';
import type { CreateLedgerBody } from '../../../api/client';
import type { FormResult } from './chronology';

export const HEAD_ORDER: HeadOfLoss[] = [
  'hire',
  'recovery',
  'storage',
  'engineer_fee',
  'pav',
  'repair',
  'salvage',
  'excess',
  'loss_of_use',
  'diminution',
  'personal_effects',
  'loss_of_earnings',
  'travel',
  'misc',
  'interest',
  'court_fee',
  'fixed_costs'
];

export const HEAD_LABEL: Record<HeadOfLoss, string> = {
  hire: 'Hire',
  recovery: 'Recovery',
  storage: 'Storage',
  engineer_fee: "Engineer's fee",
  pav: 'Pre-accident value',
  repair: 'Repair',
  salvage: 'Salvage (credit)',
  excess: 'Excess',
  loss_of_use: 'Loss of use',
  diminution: 'Diminution',
  personal_effects: 'Personal effects',
  loss_of_earnings: 'Loss of earnings',
  travel: 'Travel',
  misc: 'Miscellaneous',
  interest: 'Interest',
  court_fee: 'Court fee',
  fixed_costs: 'Fixed costs'
};

export const KIND_LABEL: Record<LedgerKind, string> = {
  claimed: 'Claimed (our position)',
  invoiced: 'Invoiced',
  offered: "Offered (insurer's offer)",
  reduced: 'Reduced (insurer reduction)',
  paid: 'Paid (cleared funds)',
  interim_paid: 'Interim payment received',
  written_off: 'Written off',
  adjustment: 'Adjustment (signed)'
};

export const HEAD_OPTIONS = HEAD_ORDER.map((value) => ({ value, label: HEAD_LABEL[value] }));
export const KIND_OPTIONS = (Object.keys(KIND_LABEL) as LedgerKind[]).map((value) => ({ value, label: KIND_LABEL[value] }));

export function headLabel(head: HeadOfLoss | string): string {
  return (HEAD_LABEL as Record<string, string>)[head] ?? head.replace(/_/g, ' ');
}
export function kindLabel(kind: LedgerKind | string): string {
  return (KIND_LABEL as Record<string, string>)[kind] ?? kind.replace(/_/g, ' ');
}

/** How a kind moves the outstanding balance: +amount, −amount, or not at all (offers, reductions, invoices are positions, not money). */
export function kindSign(kind: LedgerKind): 1 | -1 | 0 {
  switch (kind) {
    case 'claimed':
    case 'adjustment':
      return 1;
    case 'paid':
    case 'interim_paid':
    case 'written_off':
      return -1;
    case 'invoiced':
    case 'offered':
    case 'reduced':
      return 0;
  }
}

/** Ids of entries that a later entry supersedes. */
export function supersededIds(entries: Array<Pick<LedgerEntry, 'supersedesId'>>): Set<string> {
  const out = new Set<string>();
  for (const e of entries) if (e.supersedesId) out.add(e.supersedesId);
  return out;
}

export function activeEntries<T extends Pick<LedgerEntry, 'id' | 'supersedesId'>>(entries: T[]): T[] {
  const dead = supersededIds(entries);
  return entries.filter((e) => !dead.has(e.id));
}

export interface HeadPosition {
  head: HeadOfLoss;
  claimedPence: Pence;
  invoicedPence: Pence;
  offeredPence: Pence;
  reducedPence: Pence;
  paidPence: Pence;
  writtenOffPence: Pence;
  adjustmentPence: Pence;
  outstandingPence: Pence;
}

export type PositionTotals = Omit<HeadPosition, 'head'>;

function emptyPosition(): PositionTotals {
  return { claimedPence: 0, invoicedPence: 0, offeredPence: 0, reducedPence: 0, paidPence: 0, writtenOffPence: 0, adjustmentPence: 0, outstandingPence: 0 };
}

/** Money summary by head of loss: claimed / offered / paid / outstanding, superseded rows excluded. */
export function positionByHead(entries: LedgerEntry[]): { heads: HeadPosition[]; totals: PositionTotals } {
  const byHead = new Map<HeadOfLoss, HeadPosition>();
  for (const e of activeEntries(entries)) {
    const pos = byHead.get(e.head) ?? { head: e.head, ...emptyPosition() };
    switch (e.kind) {
      case 'claimed':
        pos.claimedPence += e.amountPence;
        break;
      case 'invoiced':
        pos.invoicedPence += e.amountPence;
        break;
      case 'offered':
        pos.offeredPence += e.amountPence;
        break;
      case 'reduced':
        pos.reducedPence += e.amountPence;
        break;
      case 'paid':
      case 'interim_paid':
        pos.paidPence += e.amountPence;
        break;
      case 'written_off':
        pos.writtenOffPence += e.amountPence;
        break;
      case 'adjustment':
        pos.adjustmentPence += e.amountPence;
        break;
    }
    byHead.set(e.head, pos);
  }
  const totals = emptyPosition();
  const heads = [...byHead.values()]
    .map((h) => {
      h.outstandingPence = h.claimedPence - h.paidPence - h.writtenOffPence + h.adjustmentPence;
      for (const k of Object.keys(totals) as Array<keyof PositionTotals>) totals[k] += h[k];
      return h;
    })
    .sort((a, b) => HEAD_ORDER.indexOf(a.head) - HEAD_ORDER.indexOf(b.head));
  return { heads, totals };
}

export interface LedgerRow {
  entry: LedgerEntry;
  /** Outstanding balance across the claim after this row (superseded rows do not move it). */
  runningPence: Pence;
  superseded: boolean;
  /** This row corrects an earlier one. */
  correction: boolean;
}

/** Entries in date order with the running outstanding balance. */
export function runningTotals(entries: LedgerEntry[]): LedgerRow[] {
  const dead = supersededIds(entries);
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  let running = 0;
  return sorted.map((entry) => {
    const superseded = dead.has(entry.id);
    if (!superseded) running += kindSign(entry.kind) * entry.amountPence;
    return { entry, runningPence: running, superseded, correction: Boolean(entry.supersedesId) };
  });
}

export interface LedgerFilter {
  head?: HeadOfLoss | '';
  kind?: LedgerKind | '';
  q?: string;
  showSuperseded?: boolean;
}

export function filterRows(rows: LedgerRow[], f: LedgerFilter): LedgerRow[] {
  const q = (f.q ?? '').trim().toLowerCase();
  return rows.filter((r) => {
    if (!f.showSuperseded && r.superseded) return false;
    if (f.head && r.entry.head !== f.head) return false;
    if (f.kind && r.entry.kind !== f.kind) return false;
    if (q && !`${r.entry.description} ${r.entry.reference ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export interface LedgerForm {
  head: HeadOfLoss | '';
  kind: LedgerKind | '';
  amountPence: Pence | null;
  vatPence: Pence | null;
  date: ISODate | '';
  description: string;
  reference: string;
  counterpartyId: string;
  supersedesId: string;
  sourceEvidenceId: string;
  sourceDocumentId: string;
}

export function emptyLedgerForm(today: ISODate): LedgerForm {
  return { head: '', kind: '', amountPence: null, vatPence: null, date: today, description: '', reference: '', counterpartyId: '', supersedesId: '', sourceEvidenceId: '', sourceDocumentId: '' };
}

/** Pounds were typed in the box; pence arrive here. Amounts are positive except a signed 'adjustment'. */
export function ledgerBodyFrom(form: LedgerForm, today: ISODate): FormResult<CreateLedgerBody> {
  const errors: Record<string, string> = {};
  if (!form.head) errors.head = 'Choose the head of loss';
  if (!form.kind) errors.kind = 'Choose the kind of entry';
  if (form.amountPence === null) errors.amountPence = 'Enter the amount in pounds';
  else if (form.amountPence === 0) errors.amountPence = 'The amount cannot be zero';
  else if (form.amountPence < 0 && form.kind !== 'adjustment') errors.amountPence = 'Only an adjustment may be negative; other kinds imply their own sign';
  if (form.vatPence !== null && form.vatPence < 0) errors.vatPence = 'VAT cannot be negative';
  if (!form.date) errors.date = 'Enter the date';
  else if (form.date > today) errors.date = 'The date cannot be in the future';
  if (form.description.trim().length < 3) errors.description = 'Describe the entry (what, from whom, which invoice or remittance)';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      head: form.head as HeadOfLoss,
      kind: form.kind as LedgerKind,
      amountPence: form.amountPence as Pence,
      vatPence: form.vatPence ?? undefined,
      date: form.date,
      description: form.description.trim(),
      reference: form.reference.trim() || undefined,
      counterpartyId: form.counterpartyId || undefined,
      supersedesId: form.supersedesId || undefined,
      sourceEvidenceId: form.sourceEvidenceId || undefined,
      sourceDocumentId: form.sourceDocumentId || undefined
    }
  };
}

export const APPEND_ONLY_NOTE = 'The ledger is append-only. Nothing here can be edited or deleted: a correction is a new entry that supersedes the old one, and both stay on the file.';
