/**
 * GTA daily rate table (injected data).
 *
 * CCGUK is NOT a GTA subscriber. Under GTA 2.7(j) the terms "have no relevance in law" for
 * claims outside the GTA and "cannot be cited in any legal proceedings". Every figure here is a
 * commercial benchmark, never evidence of the basic hire rate.
 *
 * Verified 2026–27 figures (BLUEPRINT §2 Key Finding 2): S1 £42.32, M £56.66, M1 £65.49, ex VAT,
 * for new hires from 1 July 2026 to 30 June 2027. CP1/CP2 come from a rates page labelled 2025–26
 * (BLUEPRINT §10) and stay `unverified` until the full spreadsheet is checked.
 */
import type { GtaRate, ISODate, ISODateTime } from '../types.js';
import { londonDate } from '../calendar/index.js';

/** Operative date of the current GTA wording (source file v11.1, amendments dated 10 February 2026). */
export const GTA_WORDING_DATE: ISODate = '2026-03-16';

export const GTA_NON_SUBSCRIBER_NOTE =
  'GTA terms are an industry benchmark only. CCGUK is not a GTA subscriber; under GTA 2.7(j) the terms have no relevance in law for claims outside the GTA and cannot be cited in legal proceedings.';

export const defaultGtaRates: GtaRate[] = [
  {
    group: 'S1',
    description: 'Small car (GTA group S1)',
    dailyRatePence: 4232,
    period: '2026-27',
    effectiveFrom: '2026-07-01',
    effectiveTo: '2027-06-30',
    verification: { status: 'unverified', sourceUrl: 'https://www.gtacredithire.com/rates/', sourceNote: 'Blueprint figure (GTA 2026–27 rate table). Fallback only — the API serves @ccguk/kb gta-rates.json. Confirm against the 2026–27 rate spreadsheet.' },
  },
  {
    group: 'M',
    description: 'Medium car (GTA group M)',
    dailyRatePence: 5666,
    period: '2026-27',
    effectiveFrom: '2026-07-01',
    effectiveTo: '2027-06-30',
    verification: { status: 'unverified', sourceUrl: 'https://www.gtacredithire.com/rates/', sourceNote: 'Blueprint figure (GTA 2026–27 rate table). Fallback only — the API serves @ccguk/kb gta-rates.json. Confirm against the 2026–27 rate spreadsheet.' },
  },
  {
    group: 'M1',
    description: 'Medium car, upper (GTA group M1)',
    dailyRatePence: 6549,
    period: '2026-27',
    effectiveFrom: '2026-07-01',
    effectiveTo: '2027-06-30',
    verification: { status: 'unverified', sourceUrl: 'https://www.gtacredithire.com/rates/', sourceNote: 'Blueprint figure (GTA 2026–27 rate table). Fallback only — the API serves @ccguk/kb gta-rates.json. Confirm against the 2026–27 rate spreadsheet.' },
  },
  {
    group: 'CP1',
    description: 'Commercial / panel van, small (GTA group CP1)',
    dailyRatePence: 6464,
    period: '2025-26',
    effectiveFrom: '2025-07-01',
    effectiveTo: '2026-06-30',
    verification: {
      status: 'unverified',
      sourceNote: 'Rates page labelled 2025–26 (BLUEPRINT §10). Confirm against the full GTA rate spreadsheet before use; no 2026–27 figure held.',
    },
  },
  {
    group: 'CP2',
    description: 'Commercial / panel van, medium (GTA group CP2)',
    dailyRatePence: 7334,
    period: '2025-26',
    effectiveFrom: '2025-07-01',
    effectiveTo: '2026-06-30',
    verification: {
      status: 'unverified',
      sourceNote: 'Rates page labelled 2025–26 (BLUEPRINT §10). Confirm against the full GTA rate spreadsheet before use; no 2026–27 figure held.',
    },
  },
];

/**
 * Look up the GTA daily rate (ex VAT) for a group on a date. Returns undefined when no rate in
 * the table covers that date — callers must not fall back to a stale period silently.
 * Where more than one row covers the date, a verified row wins, then the latest `effectiveFrom`.
 */
export function gtaRate(group: string, onDate: ISODate | ISODateTime, rates: GtaRate[] = defaultGtaRates): GtaRate | undefined {
  const g = group.trim().toUpperCase();
  const d = londonDate(onDate);
  const matches = rates.filter((r) => r.group.toUpperCase() === g && r.effectiveFrom <= d && d <= r.effectiveTo);
  if (matches.length === 0) return undefined;
  return matches.sort((a, b) => {
    const va = a.verification.status === 'verified' ? 1 : 0;
    const vb = b.verification.status === 'verified' ? 1 : 0;
    if (va !== vb) return vb - va;
    return b.effectiveFrom.localeCompare(a.effectiveFrom);
  })[0];
}

/** Every group that has a rate for the date (for pickers). */
export function gtaGroupsOn(onDate: ISODate | ISODateTime, rates: GtaRate[] = defaultGtaRates): string[] {
  const d = londonDate(onDate);
  return [...new Set(rates.filter((r) => r.effectiveFrom <= d && d <= r.effectiveTo).map((r) => r.group.toUpperCase()))].sort();
}
