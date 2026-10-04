import { describe, it, expect } from 'vitest';
import {
  BANK_HOLIDAYS_EW,
  BANK_HOLIDAY_YEARS,
  bankHolidayVerification,
  bankHolidays,
  bankHolidayOn,
  easterSunday,
  generateStatutoryBankHolidays,
} from './bank-holidays.js';

describe('easterSunday', () => {
  it('matches the known Gregorian Easter dates 2024–2030', () => {
    expect(easterSunday(2024)).toEqual({ month: 3, day: 31 });
    expect(easterSunday(2025)).toEqual({ month: 4, day: 20 });
    expect(easterSunday(2026)).toEqual({ month: 4, day: 5 });
    expect(easterSunday(2027)).toEqual({ month: 3, day: 28 });
    expect(easterSunday(2028)).toEqual({ month: 4, day: 16 });
    expect(easterSunday(2029)).toEqual({ month: 4, day: 1 });
    expect(easterSunday(2030)).toEqual({ month: 4, day: 21 });
  });
});

describe('BANK_HOLIDAYS_EW data', () => {
  it('carries a gov.uk source URL and is marked unverified until a human checks it', () => {
    expect(bankHolidayVerification.status).toBe('unverified');
    expect(bankHolidayVerification.sourceUrl).toBe('https://www.gov.uk/bank-holidays.json');
  });

  it('has exactly eight holidays per year for 2024–2030', () => {
    for (const y of BANK_HOLIDAY_YEARS) expect(bankHolidays(y)).toHaveLength(8);
    expect(BANK_HOLIDAYS_EW).toHaveLength(8 * BANK_HOLIDAY_YEARS.length);
  });

  it('equals the statutory-pattern generator for every shipped year (no drift)', () => {
    for (const y of BANK_HOLIDAY_YEARS) {
      expect(bankHolidays(y)).toEqual(generateStatutoryBankHolidays(y));
    }
  });

  it('is sorted and has no duplicate dates', () => {
    const dates = BANK_HOLIDAYS_EW.map((h) => h.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('encodes the Christmas / Boxing Day / New Year substitute days', () => {
    // 2026: 26 Dec is a Saturday → Boxing Day substitute Monday 28 Dec.
    expect(bankHolidayOn('2026-12-28')).toMatchObject({ title: 'Boxing Day', substitute: true });
    expect(bankHolidayOn('2026-12-26')).toBeUndefined();
    // 2027: 25 Dec Sat, 26 Dec Sun → Mon 27 (Christmas Day) and Tue 28 (Boxing Day).
    expect(bankHolidayOn('2027-12-27')).toMatchObject({ title: 'Christmas Day', substitute: true });
    expect(bankHolidayOn('2027-12-28')).toMatchObject({ title: 'Boxing Day', substitute: true });
    expect(bankHolidayOn('2027-12-25')).toBeUndefined();
    // 2028: 1 Jan is a Saturday → New Year’s Day substitute Monday 3 Jan.
    expect(bankHolidayOn('2028-01-03')).toMatchObject({ title: 'New Year’s Day', substitute: true });
    expect(bankHolidayOn('2028-01-01')).toBeUndefined();
    // Ordinary years keep the real dates.
    expect(bankHolidayOn('2025-12-25')).toMatchObject({ title: 'Christmas Day', substitute: false });
    expect(bankHolidayOn('2025-12-26')).toMatchObject({ title: 'Boxing Day', substitute: false });
  });

  it('has the right Monday holidays in 2026', () => {
    expect(bankHolidays(2026).map((h) => h.date)).toEqual([
      '2026-01-01',
      '2026-04-03',
      '2026-04-06',
      '2026-05-04',
      '2026-05-25',
      '2026-08-31',
      '2026-12-25',
      '2026-12-28',
    ]);
  });

  it('handles the Christmas-on-Sunday pattern in a generated year (2022 style)', () => {
    const g = generateStatutoryBankHolidays(2022).filter((h) => h.date.startsWith('2022-12'));
    expect(g.map((h) => [h.date, h.title, h.substitute])).toEqual([
      ['2022-12-26', 'Boxing Day', false],
      ['2022-12-27', 'Christmas Day', true],
    ]);
  });

  it('falls back to the statutory pattern for years outside the shipped range', () => {
    const g = bankHolidays(2031);
    expect(g).toHaveLength(8);
    expect(g.map((h) => h.date)).toContain('2031-04-11'); // Good Friday 2031 (Easter 13 Apr)
    expect(bankHolidayOn('2031-04-14')?.title).toBe('Easter Monday');
  });
});
