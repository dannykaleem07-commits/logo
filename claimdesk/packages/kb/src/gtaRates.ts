/**
 * GTA daily-rate lookups over kb/data/gta-rates.json.
 *
 * CCGUK is not a GTA subscriber: every figure is an industry benchmark (GTA 2.7(j)), never evidence of the
 * basic hire rate, and the rows carry their own verification. Where more than one row covers a group and
 * date, a 'verified' row wins, then the latest effectiveFrom — the same rule as domain `gtaRate`.
 */
import type { GtaRate, ISODate, ISODateTime } from '@ccguk/domain';
import { loadGtaRates } from './load.js';

export const GTA_RATES_BENCHMARK_NOTE =
  'GTA rates are an industry benchmark only. CCGUK is not a GTA subscriber; under GTA 2.7(j) the terms have no relevance in law outside the GTA and cannot be cited in legal proceedings.';

function toDate(d: ISODate | ISODateTime): ISODate {
  return d.slice(0, 10);
}

function rank(a: GtaRate, b: GtaRate): number {
  const va = a.verification.status === 'verified' ? 1 : 0;
  const vb = b.verification.status === 'verified' ? 1 : 0;
  if (va !== vb) return vb - va;
  return b.effectiveFrom.localeCompare(a.effectiveFrom);
}

/**
 * The GTA daily rate (integer pence, ex VAT) for a group on a date, or undefined when no loaded row covers the
 * date — callers must not fall back to another period silently.
 */
export function gtaRateFor(group: string, date: ISODate | ISODateTime, rates: readonly GtaRate[] = loadGtaRates()): GtaRate | undefined {
  const g = group.trim().toUpperCase();
  const d = toDate(date);
  const matches = rates.filter((r) => r.group.toUpperCase() === g && r.effectiveFrom <= d && d <= r.effectiveTo);
  if (matches.length === 0) return undefined;
  return [...matches].sort(rank)[0];
}

/** Distinct period labels in the table, latest first (e.g. ['2026-27', '2025-26']). */
export function listPeriods(rates: readonly GtaRate[] = loadGtaRates()): string[] {
  return [...new Set(rates.map((r) => r.period))].sort((a, b) => b.localeCompare(a));
}

/** Distinct group codes with a rate in the period (or in any period when omitted), sorted. */
export function listGroups(period?: string, rates: readonly GtaRate[] = loadGtaRates()): string[] {
  const rows = period ? rates.filter((r) => r.period === period) : rates;
  return [...new Set(rows.map((r) => r.group.toUpperCase()))].sort(compareGroups);
}

/** Every row for a period, sorted by group. */
export function ratesForPeriod(period: string, rates: readonly GtaRate[] = loadGtaRates()): GtaRate[] {
  return rates.filter((r) => r.period === period).sort((a, b) => compareGroups(a.group, b.group));
}

/** The period label whose window contains the date, if any. */
export function periodFor(date: ISODate | ISODateTime, rates: readonly GtaRate[] = loadGtaRates()): string | undefined {
  const d = toDate(date);
  return rates.find((r) => r.effectiveFrom <= d && d <= r.effectiveTo)?.period;
}

/** Sort S1 < S2 < S6 < M < M1 < F6 < CP1 < PV2: by letter prefix in GTA category order, then by number. */
export function compareGroups(a: string, b: string): number {
  const parse = (g: string): [number, string, number] => {
    const m = /^([A-Z]+)(\d*)$/.exec(g.toUpperCase());
    const letters = m?.[1] ?? g;
    const num = m && m[2] ? Number(m[2]) : 0;
    const order = ['S', 'M', 'P', 'F', 'CP', 'PV', 'B'];
    const idx = order.indexOf(letters);
    return [idx === -1 ? order.length : idx, letters, num];
  };
  const [ia, la, na] = parse(a);
  const [ib, lb, nb] = parse(b);
  return ia - ib || la.localeCompare(lb) || na - nb;
}
