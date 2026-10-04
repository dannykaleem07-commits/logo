import { describe, expect, it } from 'vitest';
import type { Clock } from '@ccguk/domain';
import { clockCounts, filterClocks, isGtaBasis, offHireClocks, sortClocks } from './clocksView';

const clock = (over: Partial<Clock> & Pick<Clock, 'id' | 'dueAt' | 'status'>): Clock => ({
  claimId: 'c1',
  kind: 'custom',
  label: over.id,
  basis: 'basis',
  startsAt: '2026-09-01T00:00:00Z',
  ...over
});

const now = new Date('2026-10-04T12:00:00Z');

describe('clocks view', () => {
  const clocks = [
    clock({ id: 'met', dueAt: '2026-09-02T00:00:00Z', status: 'met', metAt: '2026-09-01T12:00:00Z' }),
    clock({ id: 'overdue', dueAt: '2026-10-01T00:00:00Z', status: 'breached', basis: 'GTA 4.2 — benchmark only', attributableTo: 'insurer' }),
    clock({ id: 'soon', dueAt: '2026-10-06T00:00:00Z', status: 'running', attributableTo: 'ccguk' }),
    clock({ id: 'stopped', dueAt: '2026-10-09T00:00:00Z', status: 'stopped' }),
    clock({ id: 'offhire', dueAt: '2026-10-05T00:00:00Z', status: 'running', kind: 'gta_4_8_offhire_repair_24h', basis: 'GTA 4.8' })
  ];
  it('filters by status bucket, attribution, GTA basis and text', () => {
    expect(filterClocks(clocks, { status: 'open' }, now).map((c) => c.id)).toEqual(['overdue', 'soon', 'offhire']);
    expect(filterClocks(clocks, { status: 'overdue' }, now).map((c) => c.id)).toEqual(['overdue']);
    expect(filterClocks(clocks, { status: 'met' }, now).map((c) => c.id)).toEqual(['met']);
    expect(filterClocks(clocks, { status: 'stopped' }, now).map((c) => c.id)).toEqual(['stopped']);
    expect(filterClocks(clocks, { status: 'all', attributableTo: 'insurer' }, now).map((c) => c.id)).toEqual(['overdue']);
    expect(filterClocks(clocks, { status: 'all', gtaOnly: true }, now).map((c) => c.id)).toEqual(['overdue', 'offhire']);
    expect(filterClocks(clocks, { status: 'all', q: 'OFFHIRE' }, now).map((c) => c.id)).toEqual(['offhire']);
  });
  it('sorts open clocks soonest first, then met, then stopped', () => {
    expect(sortClocks(clocks).map((c) => c.id)).toEqual(['overdue', 'offhire', 'soon', 'met', 'stopped']);
  });
  it('counts and picks off-hire clocks', () => {
    expect(clockCounts(clocks, now)).toEqual({ open: 3, overdue: 1, dueToday: 0, met: 1 });
    expect(offHireClocks(clocks).map((c) => c.id)).toEqual(['offhire']);
    expect(isGtaBasis('GTA 4.8 — off-hire within 24 hours')).toBe(true);
    expect(isGtaBasis('ICOBS 8.2.6R')).toBe(false);
  });
});
