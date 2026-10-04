import { describe, expect, it } from 'vitest';
import { daysBetween, describeDue, formatDate, fromDateTimeLocalValue, isISODate, isISODateTime, toDateTimeLocalValue } from './dates';

describe('ISO guards', () => {
  it('recognises ISODate and ISODateTime', () => {
    expect(isISODate('2026-10-04')).toBe(true);
    expect(isISODate('04/10/2026')).toBe(false);
    expect(isISODateTime('2026-10-04T10:00:00Z')).toBe(true);
    expect(isISODateTime('2026-10-04')).toBe(false);
  });
});

describe('describeDue', () => {
  const now = '2026-10-04T10:00:00Z';
  it('describes relative due dates', () => {
    expect(describeDue('2026-10-07T10:00:00Z', now)).toBe('due in 3 days');
    expect(describeDue('2026-10-05T10:00:00Z', now)).toBe('due tomorrow');
    expect(describeDue('2026-10-02T10:00:00Z', now)).toBe('overdue by 2 days');
    expect(describeDue('2026-10-03T10:00:00Z', now)).toBe('overdue by 1 day');
    expect(describeDue('not-a-date', now)).toBe('no due date');
  });
  it('same-day wording', () => {
    expect(describeDue('2026-10-04T12:00:00Z', now)).toBe('due in 2 h');
    expect(describeDue('2026-10-04T09:00:00Z', now)).toBe('overdue (today)');
  });
});

describe('daysBetween', () => {
  it('counts whole local days', () => {
    expect(daysBetween('2026-10-01', '2026-10-04')).toBe(3);
    expect(daysBetween('2026-10-04', '2026-10-01')).toBe(-3);
    expect(daysBetween('2026-10-04T23:00:00', '2026-10-05T01:00:00')).toBe(1);
  });
});

describe('datetime-local round trip', () => {
  it('converts both ways', () => {
    const iso = fromDateTimeLocalValue('2026-10-04T09:30');
    expect(iso.endsWith('Z')).toBe(true);
    expect(toDateTimeLocalValue(iso)).toBe('2026-10-04T09:30');
    expect(fromDateTimeLocalValue('')).toBe('');
    expect(toDateTimeLocalValue('')).toBe('');
    expect(toDateTimeLocalValue('garbage')).toBe('');
  });
});

describe('formatDate', () => {
  it('is en-GB and tolerant', () => {
    expect(formatDate('2026-10-04')).toMatch(/04 Oct 2026/);
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('garbage')).toBe('garbage');
  });
});
