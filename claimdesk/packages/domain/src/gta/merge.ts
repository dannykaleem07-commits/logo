/**
 * KB + manual GTA rate merge (TEMPLATES-VEHICLES-DESKTOP §F.3). Pure.
 *
 * The knowledge-base rate file stays the base. A manual row (Settings → GTA benchmark rates) with the same group and
 * period replaces the KB row; a suppressed manual row hides it; manual rows with no KB counterpart are added.
 * Verification travels with each row exactly as stored — nothing here upgrades it. GTA rates are an industry benchmark
 * only (CCGUK is not a GTA subscriber).
 */
import type { GtaRate, ISODate, Pence, Verification } from '../types.js';

export interface ManualGtaRateRow {
  id: string;
  group: string;
  description?: string;
  /** Absent only on a suppress row. */
  dailyRatePence?: Pence;
  period: string;
  effectiveFrom: ISODate;
  effectiveTo: ISODate;
  verification: Verification;
  /** True = hide the KB row with the same group and period. */
  suppressed: boolean;
  note?: string;
}

export type MergedGtaRate = GtaRate & { origin: 'kb' | 'manual'; id?: string; overridesKb?: boolean };

export function gtaRateKey(group: string, period: string): string {
  return `${group.trim().toUpperCase()}|${period.trim()}`;
}

function fromManual(m: ManualGtaRateRow, kb?: GtaRate): MergedGtaRate {
  const out: MergedGtaRate = {
    group: m.group.trim().toUpperCase(),
    dailyRatePence: m.dailyRatePence as Pence,
    period: m.period,
    effectiveFrom: m.effectiveFrom,
    effectiveTo: m.effectiveTo,
    verification: m.verification,
    origin: 'manual',
    id: m.id,
    overridesKb: Boolean(kb),
  };
  const description = m.description ?? kb?.description;
  if (description !== undefined) out.description = description;
  return out;
}

/** manual replaces KB for the same (group, period); suppressed hides it; manual-only rows are added. */
export function mergeGtaRates(kb: GtaRate[], manual: ManualGtaRateRow[]): MergedGtaRate[] {
  const manualByKey = new Map<string, ManualGtaRateRow>();
  for (const m of manual) manualByKey.set(gtaRateKey(m.group, m.period), m);
  const out: MergedGtaRate[] = [];
  const used = new Set<string>();
  for (const r of kb) {
    const key = gtaRateKey(r.group, r.period);
    const m = manualByKey.get(key);
    if (!m) {
      out.push({ ...r, origin: 'kb' });
      continue;
    }
    used.add(key);
    if (m.suppressed) continue;
    if (typeof m.dailyRatePence === 'number' && m.dailyRatePence > 0) out.push(fromManual(m, r));
    else out.push({ ...r, origin: 'kb' });
  }
  for (const [key, m] of manualByKey) {
    if (used.has(key) || m.suppressed) continue;
    if (typeof m.dailyRatePence !== 'number' || m.dailyRatePence <= 0) continue;
    out.push(fromManual(m));
  }
  return out.sort((a, b) => a.group.localeCompare(b.group) || a.effectiveFrom.localeCompare(b.effectiveFrom));
}
