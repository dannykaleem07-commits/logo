import { describe, it, expect } from 'vitest';
import {
  parseIso,
  isoToMs,
  msToLondonIso,
  toLondonIso,
  toUtcIso,
  londonDate,
  londonOffsetMinutesAt,
  bstStartUtc,
  bstEndUtc,
  lastSundayOfMonth,
  isBst,
  compareIso,
  calendarDaysBetween,
  londonDateTime,
  londonParts,
} from './london.js';

describe('parseIso', () => {
  it('parses date-only, Z, and offset forms', () => {
    expect(parseIso('2026-07-03')).toMatchObject({ year: 2026, month: 7, day: 3, hasTime: false, offsetMinutes: null });
    expect(parseIso('2026-07-03T16:00:00Z')).toMatchObject({ hour: 16, offsetMinutes: 0, hasTime: true });
    expect(parseIso('2026-07-03T16:00:00+01:00')).toMatchObject({ hour: 16, offsetMinutes: 60 });
    expect(parseIso('2026-07-03T16:00:00.123-05:30')).toMatchObject({ millisecond: 123, offsetMinutes: -330 });
    expect(parseIso('2026-07-03T16:00')).toMatchObject({ hour: 16, minute: 0, offsetMinutes: null, hasTime: true });
  });
  it('rejects garbage and impossible dates', () => {
    expect(() => parseIso('3 July 2026')).toThrow();
    expect(() => parseIso('2026-02-30')).toThrow();
    expect(() => parseIso('2026-13-01')).toThrow();
  });
});

describe('BST rule (last Sunday of March/October, 01:00 UTC)', () => {
  it('finds the last Sundays', () => {
    expect(lastSundayOfMonth(2026, 3)).toBe(29);
    expect(lastSundayOfMonth(2026, 10)).toBe(25);
    expect(lastSundayOfMonth(2027, 3)).toBe(28);
    expect(lastSundayOfMonth(2027, 10)).toBe(31);
  });
  it('transitions at the right instants', () => {
    expect(bstStartUtc(2026)).toBe(Date.UTC(2026, 2, 29, 1));
    expect(bstEndUtc(2026)).toBe(Date.UTC(2026, 9, 25, 1));
    expect(londonOffsetMinutesAt(Date.UTC(2026, 2, 29, 0, 59))).toBe(0);
    expect(londonOffsetMinutesAt(Date.UTC(2026, 2, 29, 1, 0))).toBe(60);
    expect(londonOffsetMinutesAt(Date.UTC(2026, 9, 25, 0, 59))).toBe(60);
    expect(londonOffsetMinutesAt(Date.UTC(2026, 9, 25, 1, 0))).toBe(0);
  });
  it('isBst reads any ISO form', () => {
    expect(isBst('2026-07-03T16:00:00Z')).toBe(true);
    expect(isBst('2026-12-24')).toBe(false);
  });
});

describe('conversions', () => {
  it('formats instants as London-local ISO with the right offset', () => {
    expect(msToLondonIso(Date.UTC(2026, 6, 3, 15, 0))).toBe('2026-07-03T16:00:00+01:00');
    expect(msToLondonIso(Date.UTC(2026, 11, 24, 17, 0))).toBe('2026-12-24T17:00:00+00:00');
  });
  it('round-trips Z ↔ London', () => {
    expect(toLondonIso('2026-07-03T15:00:00Z')).toBe('2026-07-03T16:00:00+01:00');
    expect(toUtcIso('2026-07-03T16:00:00+01:00')).toBe('2026-07-03T15:00:00.000Z');
  });
  it('treats an offset-less date-time as London wall clock', () => {
    expect(isoToMs('2026-07-03T16:00:00')).toBe(Date.UTC(2026, 6, 3, 15, 0));
    expect(isoToMs('2026-12-03T16:00:00')).toBe(Date.UTC(2026, 11, 3, 16, 0));
  });
  it('resolves the clock-change edge cases', () => {
    // 00:30 UTC on 29 Mar 2026 is still GMT; 01:30 UTC is 02:30 BST.
    expect(msToLondonIso(Date.UTC(2026, 2, 29, 0, 30))).toBe('2026-03-29T00:30:00+00:00');
    expect(msToLondonIso(Date.UTC(2026, 2, 29, 1, 30))).toBe('2026-03-29T02:30:00+01:00');
    // Ambiguous 01:30 on 25 Oct 2026 resolves to its first (BST) occurrence.
    expect(isoToMs('2026-10-25T01:30:00')).toBe(Date.UTC(2026, 9, 25, 0, 30));
    expect(isoToMs('2026-10-25T02:30:00')).toBe(Date.UTC(2026, 9, 25, 2, 30));
  });
  it('londonDate uses the London calendar date, not the UTC one', () => {
    expect(londonDate('2026-07-03T23:30:00Z')).toBe('2026-07-04');
    expect(londonDate('2026-12-03T23:30:00Z')).toBe('2026-12-03');
    expect(londonDate('2026-07-04')).toBe('2026-07-04');
  });
  it('londonParts reports weekday and offset', () => {
    expect(londonParts('2026-07-03T16:00:00+01:00')).toMatchObject({ weekday: 5, hour: 16, offsetMinutes: 60 });
  });
  it('compareIso compares instants regardless of offset notation', () => {
    expect(compareIso('2026-07-03T16:00:00+01:00', '2026-07-03T15:00:00Z')).toBe(0);
    expect(compareIso('2026-07-03', '2026-07-03T00:00:01+01:00')).toBe(-1);
    expect(compareIso('2026-07-04', '2026-07-03')).toBe(1);
  });
  it('calendarDaysBetween counts London dates', () => {
    expect(calendarDaysBetween('2026-01-01', '2026-02-01')).toBe(31);
    expect(calendarDaysBetween('2026-02-01', '2026-01-01')).toBe(-31);
    expect(calendarDaysBetween('2026-07-03T23:30:00Z', '2026-07-04T01:00:00Z')).toBe(0);
  });
  it('londonDateTime builds a local time with the right offset', () => {
    expect(londonDateTime('2026-07-06', 17)).toBe('2026-07-06T17:00:00+01:00');
    expect(londonDateTime('2026-12-24', 17, 30)).toBe('2026-12-24T17:30:00+00:00');
  });
});
