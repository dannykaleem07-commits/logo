/**
 * England & Wales bank holidays, 2024–2030.
 *
 * VERIFICATION: the authoritative list is https://www.gov.uk/bank-holidays.json (division
 * "england-and-wales"). That URL could not be fetched from the build environment on
 * 2026-10-04 (network egress denied), so the list below is encoded from the statutory pattern:
 *   - New Year’s Day (1 Jan; substitute Monday when on a weekend)
 *   - Good Friday and Easter Monday (computed from the Gregorian Easter algorithm)
 *   - Early May bank holiday (first Monday in May)
 *   - Spring bank holiday (last Monday in May)
 *   - Summer bank holiday (last Monday in August)
 *   - Christmas Day and Boxing Day (25/26 Dec; substitute weekdays when on a weekend)
 * One-off proclaimed holidays (e.g. a coronation or jubilee) are NOT predictable from the
 * pattern. None is known for 2024–2030 at the time of writing. A human verifies the list
 * against gov.uk and upgrades `bankHolidayVerification` — code never does.
 */
import type { ISODate, Verification } from '../types.js';
import { daysInMonth } from './london.js';

export interface BankHoliday {
  date: ISODate;
  title: string;
  /** True when the day is a substitute for a holiday that fell on a weekend. */
  substitute: boolean;
  notes?: string;
}

export const BANK_HOLIDAY_SOURCE_URL = 'https://www.gov.uk/bank-holidays.json';
export const BANK_HOLIDAY_YEARS: readonly number[] = [2024, 2025, 2026, 2027, 2028, 2029, 2030];

export const bankHolidayVerification: Verification = {
  status: 'unverified',
  sourceUrl: BANK_HOLIDAY_SOURCE_URL,
  sourceNote:
    'England & Wales division. Encoded from the statutory pattern (fixed days, computed Easter, substitute days); gov.uk could not be fetched from the build environment on 2026-10-04. Verify against the gov.uk JSON before relying on dates in letters.',
};

const pad = (n: number): string => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number): ISODate => `${y}-${pad(m)}-${pad(d)}`;

/** Gregorian Easter Sunday (Anonymous / Meeus–Jones–Butcher algorithm). Month is 1..12. */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function weekday(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
}

function firstMondayOfMonth(y: number, m: number): number {
  const w = weekday(y, m, 1);
  return 1 + ((8 - w) % 7);
}

function lastMondayOfMonth(y: number, m: number): number {
  const last = daysInMonth(y, m);
  const w = weekday(y, m, last);
  return last - ((w + 6) % 7);
}

function addDays(y: number, m: number, d: number, n: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Generate the England & Wales bank holidays for any year from the statutory pattern.
 * Used to build the shipped data and, in tests, to cross-check it. Does not know about
 * one-off proclaimed holidays.
 */
export function generateStatutoryBankHolidays(year: number): BankHoliday[] {
  const out: BankHoliday[] = [];

  // New Year’s Day: 1 Jan, substitute Monday if on a weekend.
  const nyW = weekday(year, 1, 1);
  if (nyW === 6) out.push({ date: iso(year, 1, 3), title: 'New Year’s Day', substitute: true, notes: 'Substitute day' });
  else if (nyW === 0) out.push({ date: iso(year, 1, 2), title: 'New Year’s Day', substitute: true, notes: 'Substitute day' });
  else out.push({ date: iso(year, 1, 1), title: 'New Year’s Day', substitute: false });

  // Easter
  const easter = easterSunday(year);
  const gf = addDays(year, easter.month, easter.day, -2);
  const em = addDays(year, easter.month, easter.day, 1);
  out.push({ date: iso(gf.y, gf.m, gf.d), title: 'Good Friday', substitute: false });
  out.push({ date: iso(em.y, em.m, em.d), title: 'Easter Monday', substitute: false });

  // Early May (first Monday), Spring (last Monday in May), Summer (last Monday in August)
  out.push({ date: iso(year, 5, firstMondayOfMonth(year, 5)), title: 'Early May bank holiday', substitute: false });
  out.push({ date: iso(year, 5, lastMondayOfMonth(year, 5)), title: 'Spring bank holiday', substitute: false });
  out.push({ date: iso(year, 8, lastMondayOfMonth(year, 8)), title: 'Summer bank holiday', substitute: false });

  // Christmas Day and Boxing Day with substitutes.
  const xW = weekday(year, 12, 25);
  if (xW === 6) {
    // Sat 25, Sun 26 → Mon 27 (Christmas), Tue 28 (Boxing Day)
    out.push({ date: iso(year, 12, 27), title: 'Christmas Day', substitute: true, notes: 'Substitute day' });
    out.push({ date: iso(year, 12, 28), title: 'Boxing Day', substitute: true, notes: 'Substitute day' });
  } else if (xW === 0) {
    // Sun 25, Mon 26 → Mon 26 (Boxing Day), Tue 27 (Christmas)
    out.push({ date: iso(year, 12, 26), title: 'Boxing Day', substitute: false });
    out.push({ date: iso(year, 12, 27), title: 'Christmas Day', substitute: true, notes: 'Substitute day' });
  } else if (xW === 5) {
    // Fri 25, Sat 26 → Mon 28 (Boxing Day)
    out.push({ date: iso(year, 12, 25), title: 'Christmas Day', substitute: false });
    out.push({ date: iso(year, 12, 28), title: 'Boxing Day', substitute: true, notes: 'Substitute day' });
  } else {
    out.push({ date: iso(year, 12, 25), title: 'Christmas Day', substitute: false });
    out.push({ date: iso(year, 12, 26), title: 'Boxing Day', substitute: false });
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The shipped data: England & Wales bank holidays 2024–2030, listed explicitly so a human can
 * verify and edit them line by line. `bank-holidays.test.ts` asserts this list equals the
 * statutory-pattern generator so neither can drift from the other unnoticed.
 */
export const BANK_HOLIDAYS_EW: readonly BankHoliday[] = [
  // 2024
  { date: '2024-01-01', title: 'New Year’s Day', substitute: false },
  { date: '2024-03-29', title: 'Good Friday', substitute: false },
  { date: '2024-04-01', title: 'Easter Monday', substitute: false },
  { date: '2024-05-06', title: 'Early May bank holiday', substitute: false },
  { date: '2024-05-27', title: 'Spring bank holiday', substitute: false },
  { date: '2024-08-26', title: 'Summer bank holiday', substitute: false },
  { date: '2024-12-25', title: 'Christmas Day', substitute: false },
  { date: '2024-12-26', title: 'Boxing Day', substitute: false },
  // 2025
  { date: '2025-01-01', title: 'New Year’s Day', substitute: false },
  { date: '2025-04-18', title: 'Good Friday', substitute: false },
  { date: '2025-04-21', title: 'Easter Monday', substitute: false },
  { date: '2025-05-05', title: 'Early May bank holiday', substitute: false },
  { date: '2025-05-26', title: 'Spring bank holiday', substitute: false },
  { date: '2025-08-25', title: 'Summer bank holiday', substitute: false },
  { date: '2025-12-25', title: 'Christmas Day', substitute: false },
  { date: '2025-12-26', title: 'Boxing Day', substitute: false },
  // 2026
  { date: '2026-01-01', title: 'New Year’s Day', substitute: false },
  { date: '2026-04-03', title: 'Good Friday', substitute: false },
  { date: '2026-04-06', title: 'Easter Monday', substitute: false },
  { date: '2026-05-04', title: 'Early May bank holiday', substitute: false },
  { date: '2026-05-25', title: 'Spring bank holiday', substitute: false },
  { date: '2026-08-31', title: 'Summer bank holiday', substitute: false },
  { date: '2026-12-25', title: 'Christmas Day', substitute: false },
  { date: '2026-12-28', title: 'Boxing Day', substitute: true, notes: 'Substitute day' },
  // 2027
  { date: '2027-01-01', title: 'New Year’s Day', substitute: false },
  { date: '2027-03-26', title: 'Good Friday', substitute: false },
  { date: '2027-03-29', title: 'Easter Monday', substitute: false },
  { date: '2027-05-03', title: 'Early May bank holiday', substitute: false },
  { date: '2027-05-31', title: 'Spring bank holiday', substitute: false },
  { date: '2027-08-30', title: 'Summer bank holiday', substitute: false },
  { date: '2027-12-27', title: 'Christmas Day', substitute: true, notes: 'Substitute day' },
  { date: '2027-12-28', title: 'Boxing Day', substitute: true, notes: 'Substitute day' },
  // 2028
  { date: '2028-01-03', title: 'New Year’s Day', substitute: true, notes: 'Substitute day' },
  { date: '2028-04-14', title: 'Good Friday', substitute: false },
  { date: '2028-04-17', title: 'Easter Monday', substitute: false },
  { date: '2028-05-01', title: 'Early May bank holiday', substitute: false },
  { date: '2028-05-29', title: 'Spring bank holiday', substitute: false },
  { date: '2028-08-28', title: 'Summer bank holiday', substitute: false },
  { date: '2028-12-25', title: 'Christmas Day', substitute: false },
  { date: '2028-12-26', title: 'Boxing Day', substitute: false },
  // 2029
  { date: '2029-01-01', title: 'New Year’s Day', substitute: false },
  { date: '2029-03-30', title: 'Good Friday', substitute: false },
  { date: '2029-04-02', title: 'Easter Monday', substitute: false },
  { date: '2029-05-07', title: 'Early May bank holiday', substitute: false },
  { date: '2029-05-28', title: 'Spring bank holiday', substitute: false },
  { date: '2029-08-27', title: 'Summer bank holiday', substitute: false },
  { date: '2029-12-25', title: 'Christmas Day', substitute: false },
  { date: '2029-12-26', title: 'Boxing Day', substitute: false },
  // 2030
  { date: '2030-01-01', title: 'New Year’s Day', substitute: false },
  { date: '2030-04-19', title: 'Good Friday', substitute: false },
  { date: '2030-04-22', title: 'Easter Monday', substitute: false },
  { date: '2030-05-06', title: 'Early May bank holiday', substitute: false },
  { date: '2030-05-27', title: 'Spring bank holiday', substitute: false },
  { date: '2030-08-26', title: 'Summer bank holiday', substitute: false },
  { date: '2030-12-25', title: 'Christmas Day', substitute: false },
  { date: '2030-12-26', title: 'Boxing Day', substitute: false },
];

const BY_DATE: ReadonlyMap<ISODate, BankHoliday> = new Map(BANK_HOLIDAYS_EW.map((h) => [h.date, h]));
const generatedCache = new Map<number, BankHoliday[]>();

/**
 * Bank holidays for a year. 2024–2030 come from the shipped (human-verifiable) data; any other
 * year falls back to the statutory pattern and should be treated as unverified.
 */
export function bankHolidays(year: number): BankHoliday[] {
  if (BANK_HOLIDAY_YEARS.includes(year)) {
    const prefix = `${year}-`;
    return BANK_HOLIDAYS_EW.filter((h) => h.date.startsWith(prefix));
  }
  let g = generatedCache.get(year);
  if (!g) {
    g = generateStatutoryBankHolidays(year);
    generatedCache.set(year, g);
  }
  return g;
}

/** Look up a bank holiday by London calendar date. */
export function bankHolidayOn(date: ISODate): BankHoliday | undefined {
  const year = Number(date.slice(0, 4));
  if (BANK_HOLIDAY_YEARS.includes(year)) return BY_DATE.get(date);
  return bankHolidays(year).find((h) => h.date === date);
}
