import { describe, it, expect } from 'vitest';
import {
  isWorkingDay,
  isBankHoliday,
  addWorkingDays,
  workingDaysBetween,
  addCalendarDays,
  addWeeks,
  addCalendarMonths,
  endOfWorkingDay,
  startOfDay,
  endOfDay,
  nextWorkingDay,
  previousWorkingDay,
} from './calendar.js';

describe('isWorkingDay / isBankHoliday', () => {
  it('weekdays are working days, weekends are not', () => {
    expect(isWorkingDay('2026-07-03')).toBe(true); // Friday
    expect(isWorkingDay('2026-07-04')).toBe(false); // Saturday
    expect(isWorkingDay('2026-07-05')).toBe(false); // Sunday
    expect(isWorkingDay('2026-07-06')).toBe(true); // Monday
  });
  it('bank holidays are not working days', () => {
    expect(isWorkingDay('2026-12-25')).toBe(false);
    expect(isWorkingDay('2026-12-28')).toBe(false); // Boxing Day substitute
    expect(isWorkingDay('2026-05-04')).toBe(false); // Early May bank holiday
    expect(isBankHoliday('2026-08-31')).toBe(true);
    expect(isBankHoliday('2026-08-28')).toBe(false);
  });
  it('uses the London date of a date-time (23:30Z in July is the next London day)', () => {
    // 2026-07-03T23:30Z = Sat 4 July 00:30 BST → not a working day
    expect(isWorkingDay('2026-07-03T23:30:00Z')).toBe(false);
    expect(isWorkingDay('2026-07-03T22:30:00Z')).toBe(true);
  });
});

describe('addWorkingDays', () => {
  it('1 WD from a Friday 16:00 lands Monday 16:00', () => {
    expect(addWorkingDays('2026-07-03T16:00:00+01:00', 1)).toBe('2026-07-06T16:00:00+01:00');
  });
  it('keeps the London time of day across the clock change', () => {
    // Friday 27 March 2026 16:00 GMT → Monday 30 March 2026 16:00 BST
    expect(addWorkingDays('2026-03-27T16:00:00+00:00', 1)).toBe('2026-03-30T16:00:00+01:00');
    // The same instant written in Z form gives the same London wall-clock result.
    expect(addWorkingDays('2026-03-27T16:00:00Z', 1)).toBe('2026-03-30T16:00:00+01:00');
  });
  it('skips Christmas Day and the Boxing Day substitute (2026)', () => {
    // Thu 24 Dec 2026 → Fri 25 (BH), Sat, Sun, Mon 28 (substitute BH) → Tue 29 Dec
    expect(addWorkingDays('2026-12-24T10:00:00+00:00', 1)).toBe('2026-12-29T10:00:00+00:00');
    expect(addWorkingDays('2026-12-24', 1)).toBe('2026-12-29');
  });
  it('skips both Christmas substitutes in 2027 and the New Year substitute in 2028', () => {
    // Fri 24 Dec 2027 → Sat, Sun, Mon 27 (sub), Tue 28 (sub) → Wed 29 Dec
    expect(addWorkingDays('2027-12-24', 1)).toBe('2027-12-29');
    // Fri 31 Dec 2027 → Sat 1 Jan, Sun 2, Mon 3 Jan 2028 (sub) → Tue 4 Jan 2028
    expect(addWorkingDays('2027-12-31', 1)).toBe('2028-01-04');
  });
  it('counts 5 working days over the Early May bank holiday', () => {
    // Thu 30 Apr 2026 + 5 WD: Fri 1, (Mon 4 BH), Tue 5, Wed 6, Thu 7, Fri 8 → 8 May
    expect(addWorkingDays('2026-04-30', 5)).toBe('2026-05-08');
  });
  it('ADVERSARIAL: crosses the October clock change keeping 16:00 (Fri 23 Oct BST → Mon 26 Oct GMT) and the March change forwards', () => {
    expect(addWorkingDays('2026-10-23T16:00:00+01:00', 1)).toBe('2026-10-26T16:00:00+00:00');
    // Thu 26 Mar 16:00 GMT + 2 WD: Fri 27, Mon 30 → 16:00 BST
    expect(addWorkingDays('2026-03-26T16:00:00+00:00', 2)).toBe('2026-03-30T16:00:00+01:00');
    // Backwards across October: Mon 26 Oct 09:00 GMT − 1 WD = Fri 23 Oct 09:00 BST
    expect(addWorkingDays('2026-10-26T09:00:00+00:00', -1)).toBe('2026-10-23T09:00:00+01:00');
  });
  it('ADVERSARIAL: Easter 2026 — Thu 2 Apr 16:00 + 1 WD skips Good Friday, the weekend and Easter Monday to Tue 7 Apr', () => {
    expect(addWorkingDays('2026-04-02T16:00:00+01:00', 1)).toBe('2026-04-07T16:00:00+01:00');
    expect(addWorkingDays('2026-04-02', 2)).toBe('2026-04-08');
  });
  it('starts counting from a weekend correctly', () => {
    expect(addWorkingDays('2026-07-04T10:00:00+01:00', 1)).toBe('2026-07-06T10:00:00+01:00'); // Sat → Mon
    expect(addWorkingDays('2026-07-05', 1)).toBe('2026-07-06'); // Sun → Mon
  });
  it('supports negative n', () => {
    expect(addWorkingDays('2026-07-06T09:00:00+01:00', -1)).toBe('2026-07-03T09:00:00+01:00'); // Mon → Fri
    expect(addWorkingDays('2026-12-29', -1)).toBe('2026-12-24');
    expect(addWorkingDays('2026-07-06', -5)).toBe('2026-06-29');
  });
  it('n = 0 returns the normalised input', () => {
    expect(addWorkingDays('2026-07-04', 0)).toBe('2026-07-04');
    expect(addWorkingDays('2026-07-03T15:00:00Z', 0)).toBe('2026-07-03T16:00:00+01:00');
  });
  it('rejects non-integers', () => {
    expect(() => addWorkingDays('2026-07-03', 1.5)).toThrow();
  });
});

describe('workingDaysBetween', () => {
  it('counts working days in (a, b]', () => {
    expect(workingDaysBetween('2026-07-03', '2026-07-06')).toBe(1); // Fri → Mon
    expect(workingDaysBetween('2026-07-03', '2026-07-10')).toBe(5);
    expect(workingDaysBetween('2026-07-03', '2026-07-05')).toBe(0); // Fri → Sun
    expect(workingDaysBetween('2026-07-03', '2026-07-03')).toBe(0);
    expect(workingDaysBetween('2026-12-24', '2026-12-29')).toBe(1); // across Christmas
  });
  it('is negative when b is before a', () => {
    expect(workingDaysBetween('2026-07-10', '2026-07-03')).toBe(-5);
  });
  it('is the inverse of addWorkingDays for working-day targets', () => {
    const a = '2026-04-30';
    const b = addWorkingDays(a, 5);
    expect(workingDaysBetween(a, b)).toBe(5);
  });
  it('a delay from Friday to Tuesday is 2 working days', () => {
    expect(workingDaysBetween('2026-07-03T17:00:00+01:00', '2026-07-07T09:00:00+01:00')).toBe(2);
  });
  it('ADVERSARIAL: Christmas 2027 has two substitute days — Fri 24 Dec → Wed 29 Dec is 1 working day', () => {
    // Sat 25, Sun 26, Mon 27 (Christmas Day substitute), Tue 28 (Boxing Day substitute), Wed 29 is the first working day.
    expect(workingDaysBetween('2027-12-24', '2027-12-29')).toBe(1);
    expect(workingDaysBetween('2027-12-24', '2027-12-28')).toBe(0);
    expect(addWorkingDays('2027-12-23T10:00:00+00:00', 2)).toBe('2027-12-29T10:00:00+00:00');
  });
});

describe('addCalendarDays / addWeeks', () => {
  it('adds days keeping the wall-clock time across DST', () => {
    expect(addCalendarDays('2026-03-20T12:00:00+00:00', 14)).toBe('2026-04-03T12:00:00+01:00');
    expect(addCalendarDays('2026-07-03', 7)).toBe('2026-07-10');
    expect(addCalendarDays('2026-01-01T09:00:00+00:00', -1)).toBe('2025-12-31T09:00:00+00:00');
  });
  it('addWeeks is 7n days', () => {
    expect(addWeeks('2026-07-03T10:00:00+01:00', 8)).toBe('2026-08-28T10:00:00+01:00');
    expect(addWeeks('2026-07-03', 1)).toBe('2026-07-10');
  });
});

describe('addCalendarMonths (one calendar month semantics)', () => {
  it('31 Jan → 28 Feb in a common year, 29 Feb in a leap year', () => {
    expect(addCalendarMonths('2026-01-31T12:00:00+00:00', 1)).toBe('2026-02-28T12:00:00+00:00');
    expect(addCalendarMonths('2028-01-31', 1)).toBe('2028-02-29');
  });
  it('clamps to month end and keeps time across DST', () => {
    expect(addCalendarMonths('2026-10-31T09:00:00+00:00', 1)).toBe('2026-11-30T09:00:00+00:00');
    expect(addCalendarMonths('2026-03-15T12:00:00+00:00', 1)).toBe('2026-04-15T12:00:00+01:00');
    expect(addCalendarMonths('2026-08-31', 1)).toBe('2026-09-30');
  });
  it('ADVERSARIAL: one month from 30 Sep 10:00 BST is 30 Oct 10:00 GMT — the offset flips, the wall time does not', () => {
    expect(addCalendarMonths('2026-09-30T10:00:00+01:00', 1)).toBe('2026-10-30T10:00:00+00:00');
    // and the Z form of the same instant gives the same London answer
    expect(addCalendarMonths('2026-09-30T09:00:00Z', 1)).toBe('2026-10-30T10:00:00+00:00');
    // 3 months from 30 Nov → 28 Feb (not 2 Mar): clamp, never overflow
    expect(addCalendarMonths('2026-11-30T15:00:00+00:00', 3)).toBe('2027-02-28T15:00:00+00:00');
  });
  it('handles year roll-over and multi-month spans', () => {
    expect(addCalendarMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(addCalendarMonths('2026-12-15T10:00:00+00:00', 1)).toBe('2027-01-15T10:00:00+00:00');
    expect(addCalendarMonths('2026-07-06', 6)).toBe('2027-01-06');
    expect(addCalendarMonths('2026-03-31', -1)).toBe('2026-02-28');
  });
});

describe('endOfWorkingDay / startOfDay / endOfDay', () => {
  it('is 17:00 London with the correct offset', () => {
    expect(endOfWorkingDay('2026-07-06')).toBe('2026-07-06T17:00:00+01:00');
    expect(endOfWorkingDay('2026-12-24')).toBe('2026-12-24T17:00:00+00:00');
    expect(endOfWorkingDay('2026-07-06T09:15:00Z')).toBe('2026-07-06T17:00:00+01:00');
  });
  it('ADVERSARIAL: on the clock-change days themselves 17:00 carries the post-change offset', () => {
    expect(endOfWorkingDay('2026-03-29')).toBe('2026-03-29T17:00:00+01:00');
    expect(endOfWorkingDay('2026-10-25')).toBe('2026-10-25T17:00:00+00:00');
    expect(endOfDay('2026-10-25')).toBe('2026-10-25T23:59:59+00:00');
    // 23:30 UTC on 24 Oct is 00:30 BST on 25 Oct → that London date's end of working day
    expect(endOfWorkingDay('2026-10-24T23:30:00Z')).toBe('2026-10-25T17:00:00+00:00');
  });
  it('startOfDay and endOfDay bracket the London date', () => {
    expect(startOfDay('2026-07-06')).toBe('2026-07-06T00:00:00+01:00');
    expect(endOfDay('2026-07-06')).toBe('2026-07-06T23:59:59+01:00');
    expect(endOfDay('2026-01-06')).toBe('2026-01-06T23:59:59+00:00');
  });
});

describe('nextWorkingDay / previousWorkingDay', () => {
  it('is strictly after by default, inclusive on request', () => {
    expect(nextWorkingDay('2026-07-03')).toBe('2026-07-06');
    expect(nextWorkingDay('2026-07-03', { inclusive: true })).toBe('2026-07-03');
    expect(nextWorkingDay('2026-07-04', { inclusive: true })).toBe('2026-07-06');
    expect(nextWorkingDay('2026-12-25T10:00:00+00:00')).toBe('2026-12-29T10:00:00+00:00');
  });
  it('previousWorkingDay mirrors it', () => {
    expect(previousWorkingDay('2026-07-06')).toBe('2026-07-03');
    expect(previousWorkingDay('2026-12-29')).toBe('2026-12-24');
    expect(previousWorkingDay('2026-07-06', { inclusive: true })).toBe('2026-07-06');
  });
});
