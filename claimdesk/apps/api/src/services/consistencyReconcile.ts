/**
 * System reconciliation of consistency flags raised on figures the API itself wrote from the ledger.
 *
 * The position-consistency engine reads the rendered letter as text. In a figures table it sometimes classifies a
 * ledger-derived amount by the *neighbouring* label — "Claimed £151.00; received £0.00 | £151.00" reads the outstanding
 * column as a payment, "£8,531.40 / Received −£1,112.00" reads the claimed total as received, and "received £0.00" on
 * a head with no payment is compared against the total received. Those are not handler inconsistencies: every figure
 * came from `documentData` (ARCHITECTURE convention 4, one source of truth) and the handler cannot override them
 * (`EXTRA_OVERRIDES_LEDGER`).
 *
 * Rules (deliberately narrow — a wrong figure typed by a handler is never cleared here):
 *   1. Only `AMOUNT_PAID_MISMATCH` blocks are considered.
 *   2. The flag must also arise on the ledger-only render (the template rendered without any handler text), so the
 *      offending text was written by the system. Without that render nothing is cleared.
 *   3. The flagged amount must equal a numeric leaf the API derived (never a handler extra).
 *   4. Then: £0.00 "received" is cleared only when the ledger has no payment on that head (or no payment at all); a
 *      figure that is a claimed / outstanding / net / gross leaf and *not* a received leaf is a layout misread and is
 *      cleared; a non-zero received leaf is cleared only when it matches a ledger payment figure exactly.
 * Cleared flags stay on the report with `clearedBy: 'system'` and the reason, and the audit row lists them, so a
 * reviewer still sees every engine complaint. Anything else stays blocked for a human.
 */
import { clearFlag, formatGBP, parseGBP, type ConsistencyFlag, type ConsistencyReport, type HeadOfLoss, type ISODateTime, type LedgerEntry, type Pence } from '@ccguk/domain';

export interface DerivedLeaf {
  path: string;
  value: number;
  /** The `head` sibling when the leaf sits in a per-head row (e.g. heads[2].receivedPence → heads[2].head). */
  head?: HeadOfLoss;
}

export interface ReconcileInput {
  report: ConsistencyReport;
  /** The engine run on the render without handler text. `undefined` → nothing is reconciled. */
  ledgerOnly: ConsistencyReport | undefined;
  /** The document's dataSnapshot (derived + extra). */
  snapshot: Record<string, unknown>;
  /** Top-level/dotted paths the API derived (AssembledData.derivedKeys); leaves under them are candidates. */
  derivedKeys: string[];
  ledger: LedgerEntry[];
  now: ISODateTime;
}

export interface ReconciledFlag {
  code: ConsistencyFlag['code'];
  draftValue: string;
  paths: string[];
  reason: string;
}

export interface ReconcileOutcome {
  report: ConsistencyReport;
  cleared: ReconciledFlag[];
}

const RECEIVED_LEAF = /(received|paid|payment|remitt)/i;
const PAID_KINDS = new Set<LedgerEntry['kind']>(['paid', 'interim_paid']);
const HEADS = new Set<string>(['hire', 'recovery', 'storage', 'engineer_fee', 'pav', 'repair', 'excess', 'salvage', 'diminution', 'loss_of_use', 'other', 'interest', 'costs']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getPath(obj: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = obj;
  for (const k of dotted.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function collect(value: unknown, path: string, out: DerivedLeaf[], head?: HeadOfLoss): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push(head ? { path, value, head } : { path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collect(v, `${path}[${i}]`, out, head));
    return;
  }
  if (isPlainObject(value)) {
    const rowHead = typeof value.head === 'string' && HEADS.has(value.head) ? (value.head as HeadOfLoss) : head;
    for (const [k, v] of Object.entries(value)) collect(v, `${path}.${k}`, out, rowHead);
  }
}

/** Every numeric leaf under the derived paths of the snapshot, with its per-head context where the row carries one. */
export function derivedNumericLeaves(snapshot: Record<string, unknown>, derivedKeys: string[]): DerivedLeaf[] {
  const out: DerivedLeaf[] = [];
  const roots = [...new Set(derivedKeys.map((k) => k.split('.')[0]!))];
  for (const root of roots) collect(getPath(snapshot, root), root, out);
  return out;
}

/** Figures the ledger can vouch for as received: each payment (net/gross), each head's sum, the total. */
export function ledgerPaidFigures(ledger: LedgerEntry[]): Set<Pence> {
  const paid = ledger.filter((e) => PAID_KINDS.has(e.kind));
  const set = new Set<Pence>();
  const gross = (e: LedgerEntry): Pence => e.amountPence + (e.vatPence ?? 0);
  let net = 0;
  let grs = 0;
  const byHead = new Map<HeadOfLoss, { net: number; gross: number }>();
  for (const e of paid) {
    set.add(e.amountPence);
    set.add(gross(e));
    net += e.amountPence;
    grs += gross(e);
    const h = byHead.get(e.head) ?? { net: 0, gross: 0 };
    h.net += e.amountPence;
    h.gross += gross(e);
    byHead.set(e.head, h);
  }
  if (paid.length) {
    set.add(net);
    set.add(grs);
    for (const h of byHead.values()) {
      set.add(h.net);
      set.add(h.gross);
    }
  }
  return set;
}

function excerptPrefix(f: ConsistencyFlag): string | undefined {
  if (!f.excerpt || !f.draftValue) return undefined;
  const i = f.excerpt.indexOf(f.draftValue);
  return i >= 0 ? f.excerpt.slice(0, i) : f.excerpt;
}

function arisesOnLedgerOnly(f: ConsistencyFlag, ledgerOnly: ConsistencyReport): boolean {
  const prefix = excerptPrefix(f);
  return ledgerOnly.flags.some((g) => g.code === f.code && g.draftValue === f.draftValue && (prefix === undefined || excerptPrefix(g) === prefix));
}

export function reconcileSystemFigures(input: ReconcileInput): ReconcileOutcome {
  const cleared: ReconciledFlag[] = [];
  if (!input.ledgerOnly) return { report: input.report, cleared };
  const leaves = derivedNumericLeaves(input.snapshot, input.derivedKeys);
  const paidFigures = ledgerPaidFigures(input.ledger);
  const paidHeads = new Set(input.ledger.filter((e) => PAID_KINDS.has(e.kind)).map((e) => e.head));
  let report = input.report;

  for (const f of input.report.flags) {
    if (f.code !== 'AMOUNT_PAID_MISMATCH' || f.severity !== 'block' || f.clearedAt || !f.draftValue) continue;
    const pence = parseGBP(f.draftValue);
    if (pence === null) continue;
    if (!arisesOnLedgerOnly(f, input.ledgerOnly)) continue;
    const matching = leaves.filter((l) => l.value === pence);
    if (!matching.length) continue;
    const receivedLeaves = matching.filter((l) => RECEIVED_LEAF.test(l.path.split('.').pop() ?? l.path));
    const otherLeaves = matching.filter((l) => !RECEIVED_LEAF.test(l.path.split('.').pop() ?? l.path));

    let reason: string | undefined;
    if (pence === 0 && receivedLeaves.length) {
      const consistent = receivedLeaves.some((l) => (l.head ? !paidHeads.has(l.head) : paidHeads.size === 0));
      if (consistent) reason = `System: "received ${formatGBP(0)}" is the ledger position for ${receivedLeaves.map((l) => l.path).join(', ')} — no payment is recorded against that head. The engine compared it with the total received.`;
    } else if (otherLeaves.length && !receivedLeaves.length) {
      reason = `System: ${formatGBP(pence)} is the ledger-derived figure at ${otherLeaves.map((l) => l.path).join(', ')} (a claimed/outstanding column), read as a payment because of the adjacent "received" label in the table. No handler text contributed.`;
    } else if (receivedLeaves.length && paidFigures.has(pence)) {
      reason = `System: ${formatGBP(pence)} at ${receivedLeaves.map((l) => l.path).join(', ')} matches a payment recorded in the ledger (net/gross).`;
    }
    if (!reason) continue;
    report = clearFlag(report, f.code, f.excerpt, 'system', reason, input.now);
    cleared.push({ code: f.code, draftValue: f.draftValue, paths: matching.map((l) => l.path), reason });
  }
  return { report, cleared };
}
