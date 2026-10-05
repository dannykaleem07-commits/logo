import { describe, it, expect } from 'vitest';
import { fleetStatusFromHires, hirePeriodsOverlap, overlappingHires } from './hireOverlap.js';

const d = (day: number, hh = '10:00'): string => `2026-09-${String(day).padStart(2, '0')}T${hh}:00+01:00`;

describe('hirePeriodsOverlap (half-open, open end = +∞)', () => {
  it('overlapping and disjoint periods', () => {
    expect(hirePeriodsOverlap({ startAt: d(1), endAt: d(5) }, { startAt: d(4), endAt: d(8) })).toBe(true);
    expect(hirePeriodsOverlap({ startAt: d(1), endAt: d(3) }, { startAt: d(4), endAt: d(8) })).toBe(false);
    expect(hirePeriodsOverlap({ startAt: d(2), endAt: d(3) }, { startAt: d(1), endAt: d(8) })).toBe(true);
  });
  it('touching periods (one ends when the next starts) do not overlap', () => {
    expect(hirePeriodsOverlap({ startAt: d(1), endAt: d(4) }, { startAt: d(4), endAt: d(8) })).toBe(false);
    expect(hirePeriodsOverlap({ startAt: d(4), endAt: d(8) }, { startAt: d(1), endAt: d(4) })).toBe(false);
    // same instant written in UTC
    expect(hirePeriodsOverlap({ startAt: d(1), endAt: '2026-09-04T09:00:00Z' }, { startAt: d(4) })).toBe(false);
  });
  it('an open end runs forever', () => {
    expect(hirePeriodsOverlap({ startAt: d(1) }, { startAt: d(20), endAt: d(25) })).toBe(true);
    expect(hirePeriodsOverlap({ startAt: d(10), endAt: null }, { startAt: d(1), endAt: d(9) })).toBe(false);
    expect(hirePeriodsOverlap({ startAt: d(1) }, { startAt: d(2) })).toBe(true);
  });
});

describe('overlappingHires', () => {
  const hires = [
    { id: 'h1', startAt: d(1), endAt: d(5) },
    { id: 'h2', startAt: d(5), endAt: d(9) },
    { id: 'h3', startAt: d(20) },
  ];
  it('returns the clashing hires', () => {
    expect(overlappingHires({ startAt: d(4), endAt: d(6) }, hires).map((h) => h.id)).toEqual(['h1', 'h2']);
    expect(overlappingHires({ startAt: d(10), endAt: d(20) }, hires)).toEqual([]);
    expect(overlappingHires({ startAt: d(10) }, hires).map((h) => h.id)).toEqual(['h3']);
  });
  it('excludeId leaves the hire being corrected out', () => {
    expect(overlappingHires({ startAt: d(2), endAt: d(4) }, hires, 'h1')).toEqual([]);
  });
  it('a backdated, finished hire fits before a hire that is running today', () => {
    expect(overlappingHires({ startAt: d(10), endAt: d(15) }, hires)).toEqual([]);
  });
});

describe('fleetStatusFromHires', () => {
  const now = d(12);
  it('off_road and disposed are kept', () => {
    expect(fleetStatusFromHires({ status: 'off_road' }, [{ startAt: d(1) }], now)).toBe('off_road');
    expect(fleetStatusFromHires({ status: 'disposed' }, [], now)).toBe('disposed');
  });
  it('on_hire while a hire has no end or ends after now', () => {
    expect(fleetStatusFromHires({ status: 'available' }, [{ startAt: d(1) }], now)).toBe('on_hire');
    expect(fleetStatusFromHires({ status: 'available' }, [{ startAt: d(1), endAt: d(14) }], now)).toBe('on_hire');
  });
  it('a hire booked to start later counts', () => {
    expect(fleetStatusFromHires({ status: 'available' }, [{ startAt: d(20) }], now)).toBe('on_hire');
  });
  it('a backdated, finished hire leaves the car available (and frees an on_hire unit)', () => {
    expect(fleetStatusFromHires({ status: 'available' }, [{ startAt: d(1), endAt: d(8) }], now)).toBe('available');
    expect(fleetStatusFromHires({ status: 'on_hire' }, [{ startAt: d(1), endAt: d(8) }], now)).toBe('available');
    expect(fleetStatusFromHires({ status: 'on_hire' }, [{ startAt: d(1), endAt: now }], now)).toBe('available');
    expect(fleetStatusFromHires({ status: 'on_hire' }, [], now)).toBe('available');
  });
});
