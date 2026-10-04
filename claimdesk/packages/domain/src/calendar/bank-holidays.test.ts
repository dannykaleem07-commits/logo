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

  it('ADVERSARIAL: equals a hand-written oracle of the 56 England & Wales dates (gov.uk as published for 2024–2027; statutory pattern 2028–2030), independent of the generator', () => {
    const oracle = [
      // 2024
      '2024-01-01', '2024-03-29', '2024-04-01', '2024-05-06', '2024-05-27', '2024-08-26', '2024-12-25', '2024-12-26',
      // 2025
      '2025-01-01', '2025-04-18', '2025-04-21', '2025-05-05', '2025-05-26', '2025-08-25', '2025-12-25', '2025-12-26',
      // 2026 (Boxing Day falls on Saturday → substitute Mon 28 Dec)
      '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
      // 2027 (25/26 Dec on the weekend → Mon 27 and Tue 28 Dec)
      '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28',
      // 2028 (1 Jan is a Saturday → Mon 3 Jan)
      '2028-01-03', '2028-04-14', '2028-04-17', '2028-05-01', '2028-05-29', '2028-08-28', '2028-12-25', '2028-12-26',
      // 2029
      '2029-01-01', '2029-03-30', '2029-04-02', '2029-05-07', '2029-05-28', '2029-08-27', '2029-12-25', '2029-12-26',
      // 2030
      '2030-01-01', '2030-04-19', '2030-04-22', '2030-05-06', '2030-05-27', '2030-08-26', '2030-12-25', '2030-12-26',
    ];
    expect(BANK_HOLIDAYS_EW.map((h) => h.date)).toEqual(oracle);
    // Every shipped holiday is a weekday (a bank holiday that falls on a weekend is always substituted).
    for (const h of BANK_HOLIDAYS_EW) {
      const w = new Date(`${h.date}T00:00:00Z`).getUTCDay();
      expect(w, h.date).not.toBe(0);
      expect(w, h.date).not.toBe(6);
    }
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
