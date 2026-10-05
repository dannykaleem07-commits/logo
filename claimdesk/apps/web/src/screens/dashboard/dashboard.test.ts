import { describe, expect, it } from 'vitest';
import type { DashboardAction, DashboardClock } from '../../api/client';
import { actionGroupTitle, clockRowsByClaim, groupActions } from './dashboard';

const action = (claimId: string, extra: Partial<DashboardAction> = {}): DashboardAction => ({
  code: 'COLLECT_SOM',
  title: 'Collect the Statement of Means',
  why: 'Impecuniosity must be evidenced before the hire is challenged.',
  basis: [],
  priority: 'today',
  claimId,
  claimReference: `CCG-2026-${claimId}`,
  ...extra
});

const clock = (id: string, claimId: string, dueAt: string, extra: Partial<DashboardClock> = {}): DashboardClock =>
  ({ id, claimId, kind: 'ncaf', label: `Clock ${id}`, startedAt: '2026-09-01T09:00:00.000Z', dueAt, status: 'running', claimReference: `CCG-${claimId}`, ...extra }) as DashboardClock;

describe('next actions grouped (0.3 §E11)', () => {
  it('groups identical actions into one line with the claim count, earliest due, best priority and total protected', () => {
    const groups = groupActions([
      action('1', { priority: 'now', dueAt: '2026-10-06T09:00:00.000Z', valuePence: 10000 }),
      action('2', { code: 'SEND_NCAF', title: 'Send the NCAF', priority: 'now' }),
      action('3', { dueAt: '2026-10-05T09:00:00.000Z', valuePence: 5000 }),
      action('4', { priority: 'this_week' })
    ]);
    expect(groups.map((g) => g.title)).toEqual(['Collect the Statement of Means', 'Send the NCAF']);
    const som = groups[0]!;
    expect(som.items.map((i) => i.claimId)).toEqual(['1', '3', '4']);
    expect(som.priority).toBe('now');
    expect(som.dueAt).toBe('2026-10-05T09:00:00.000Z');
    expect(som.protectedPence).toBe(15000);
    expect(actionGroupTitle(som)).toBe('Collect the Statement of Means — 3 claims');
    expect(actionGroupTitle(groups[1]!)).toBe('Send the NCAF');
    expect(groups[1]!.protectedPence).toBeUndefined();
  });
  it('the same claim twice still counts as one claim', () => {
    const [g] = groupActions([action('1'), action('1')]);
    expect(actionGroupTitle(g!)).toBe('Collect the Statement of Means');
  });
});

describe('clocks: one row per claim (0.3 §E11)', () => {
  it('shows each claim once with its worst clock and how many more, overdue claims first', () => {
    const overdue = [clock('a', 'c1', '2026-10-03T09:00:00.000Z'), clock('b', 'c1', '2026-10-01T09:00:00.000Z'), clock('c', 'c2', '2026-10-04T09:00:00.000Z'), clock('x', 'c1', '2026-09-01T09:00:00.000Z', { status: 'stopped' })];
    const dueToday = [clock('d', 'c1', '2026-10-05T15:00:00.000Z'), clock('e', 'c3', '2026-10-05T12:00:00.000Z'), clock('f', 'c3', '2026-10-05T16:00:00.000Z')];
    const rows = clockRowsByClaim(overdue, dueToday);
    expect(rows.map((r) => [r.claimId, r.worst.id, r.more, r.tone])).toEqual([
      ['c1', 'b', 2, 'red'],
      ['c2', 'c', 0, 'red'],
      ['c3', 'e', 1, 'amber']
    ]);
    expect(clockRowsByClaim([], [])).toEqual([]);
  });
});
