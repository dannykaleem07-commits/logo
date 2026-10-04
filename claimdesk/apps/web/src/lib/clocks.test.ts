import { describe, expect, it } from 'vitest';
import type { Clock } from '@ccguk/domain';
import { dueState, groupByClaim, isDueToday, isOverdue, oldestOverdue, openClocks } from './clocks';

const now = new Date('2026-10-04T10:00:00Z');
const clock = (over: Partial<Clock>): Clock => ({
  id: over.id ?? 'c1',
  claimId: over.claimId ?? 'claim-1',
  kind: 'gta_4_1_ncaf_1wd',
  label: 'NCAF',
  basis: 'GTA 4.1 (benchmark only)',
  startsAt: '2026-10-01T09:00:00Z',
  dueAt: '2026-10-04T17:00:00Z',
  status: 'running',
  ...over
});

describe('dueState', () => {
  it('buckets by due date relative to now', () => {
    expect(dueState(clock({ dueAt: '2026-10-04T17:00:00Z' }), now)).toBe('today');
    expect(dueState(clock({ dueAt: '2026-10-04T09:00:00Z' }), now)).toBe('overdue');
    expect(dueState(clock({ dueAt: '2026-10-03T17:00:00Z' }), now)).toBe('overdue');
    expect(dueState(clock({ dueAt: '2026-10-06T17:00:00Z' }), now)).toBe('soon');
    expect(dueState(clock({ dueAt: '2026-10-20T17:00:00Z' }), now)).toBe('later');
  });
  it('respects met / stopped / breached statuses', () => {
    expect(dueState(clock({ status: 'met', dueAt: '2026-10-01T00:00:00Z' }), now)).toBe('met');
    expect(dueState(clock({ status: 'stopped' }), now)).toBe('stopped');
    expect(dueState(clock({ status: 'not_applicable' }), now)).toBe('stopped');
    expect(dueState(clock({ status: 'breached', dueAt: '2026-12-01T00:00:00Z' }), now)).toBe('overdue');
  });
  it('helpers', () => {
    expect(isDueToday(clock({ dueAt: '2026-10-04T23:00:00Z' }), now)).toBe(true);
    expect(isOverdue(clock({ dueAt: '2026-10-01T23:00:00Z' }), now)).toBe(true);
  });
});

describe('openClocks / oldestOverdue / groupByClaim', () => {
  const list = [
    clock({ id: 'a', dueAt: '2026-10-10T00:00:00Z' }),
    clock({ id: 'b', dueAt: '2026-10-01T00:00:00Z', status: 'breached' }),
    clock({ id: 'c', dueAt: '2026-09-28T00:00:00Z' }),
    clock({ id: 'd', dueAt: '2026-09-20T00:00:00Z', status: 'met' }),
    clock({ id: 'e', claimId: 'claim-2', dueAt: '2026-10-02T00:00:00Z' })
  ];
  it('sorts open clocks soonest first and drops met/stopped', () => {
    expect(openClocks(list).map((c) => c.id)).toEqual(['c', 'b', 'e', 'a']);
  });
  it('finds the oldest overdue', () => {
    expect(oldestOverdue(list, now)?.id).toBe('c');
    expect(oldestOverdue([clock({ dueAt: '2026-12-01T00:00:00Z' })], now)).toBeUndefined();
  });
  it('groups by claim preserving order', () => {
    const g = groupByClaim(list);
    expect([...g.keys()]).toEqual(['claim-1', 'claim-2']);
    expect(g.get('claim-1')!.map((c) => c.id)).toEqual(['c', 'b', 'a']);
  });
});
