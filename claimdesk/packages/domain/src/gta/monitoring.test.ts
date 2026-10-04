import { describe, it, expect } from 'vitest';
import { monitoringDiary } from './monitoring.js';
import { mkEvent } from './fixtures.js';

// Mon 6 Jul 2026 estimate; Thu 9 Jul is +3 WD. Repair starts Mon 13 Jul; +5 WD = Mon 20 Jul, +10 WD = Mon 27 Jul.
const estimate = mkEvent('estimate_received', '2026-07-06T10:00:00+01:00', { id: 'ev_est' });
const started = mkEvent('repair_started', '2026-07-13T09:00:00+01:00', { id: 'ev_start' });

describe('monitoringDiary — authorisation check (GTA 4.10)', () => {
  it('is due 3 working days after the estimate and upcoming before then', () => {
    const d = monitoringDiary([estimate], 10, '2026-07-08T12:00:00+01:00');
    expect(d.checks).toEqual([
      expect.objectContaining({ kind: 'authorisation_check', dueAt: '2026-07-09T10:00:00+01:00', status: 'upcoming', sourceEventId: 'ev_est' }),
    ]);
    expect(d.delayNotices).toEqual([]);
  });
  it('is overdue after the due instant but a 1-WD slip does not yet qualify for a delay notice (10 WD estimate)', () => {
    const d = monitoringDiary([estimate], 10, '2026-07-10T12:00:00+01:00');
    expect(d.checks[0]?.status).toBe('overdue');
    expect(d.delayNotices).toEqual([]); // 4 WD elapsed − 3 = 1 WD late, 10% → below both thresholds
  });
  it('raises an insurer-attributable delay notice at 2 WD late while authorisation is outstanding', () => {
    const d = monitoringDiary([estimate], 10, '2026-07-13T12:00:00+01:00');
    expect(d.delayNotices).toEqual([
      expect.objectContaining({ kind: 'authorisation_delay', workingDaysLate: 2, pctOver: 20, attributableTo: 'insurer', concluded: false }),
    ]);
    expect(d.delayNotices[0]?.basis).toMatch(/GTA 4\.10–4\.11/);
    expect(d.delayNotices[0]?.basis).toMatch(/benchmark only/);
  });
  it('marks the check done and concludes the delay notice once authorised (Tue 14 Jul = 3 WD late, 30%)', () => {
    const authorised = mkEvent('repair_authorised', '2026-07-14T11:00:00+01:00', { id: 'ev_auth' });
    const d = monitoringDiary([estimate, authorised], 10, '2026-07-20T12:00:00+01:00');
    expect(d.checks[0]).toMatchObject({ status: 'done', satisfiedByEventId: 'ev_auth' });
    expect(d.delayNotices[0]).toMatchObject({ kind: 'authorisation_delay', workingDaysLate: 3, pctOver: 30, concluded: true });
    expect(d.delayNotices[0]?.reason).toMatch(/3 working days after/);
  });
  it('falls back to report_issued when there is no estimate event', () => {
    const report = mkEvent('report_issued', '2026-07-06T10:00:00+01:00', { id: 'ev_rep' });
    const d = monitoringDiary([report], 10, '2026-07-07T10:00:00+01:00');
    expect(d.checks[0]).toMatchObject({ kind: 'authorisation_check', dueAt: '2026-07-09T10:00:00+01:00', sourceEventId: 'ev_rep' });
  });
});

describe('monitoringDiary — progress checks every 5 WD (GTA 4.11)', () => {
  it('emits every check up to now plus the next upcoming one', () => {
    const d = monitoringDiary([started], 10, '2026-07-22T12:00:00+01:00');
    const progress = d.checks.filter((c) => c.kind === 'progress_check');
    expect(progress).toEqual([
      expect.objectContaining({ sequence: 1, dueAt: '2026-07-20T09:00:00+01:00', status: 'overdue' }),
      expect.objectContaining({ sequence: 2, dueAt: '2026-07-27T09:00:00+01:00', status: 'upcoming' }),
    ]);
    expect(d.expectedCompletionAt).toBe('2026-07-27T09:00:00+01:00');
  });
  it('a monitoring touch inside the window satisfies the check', () => {
    const touch = mkEvent('call', '2026-07-17T15:00:00+01:00', { id: 'ev_call', data: { kind: 'monitoring_check' } });
    const d = monitoringDiary([started, touch], 10, '2026-07-22T12:00:00+01:00');
    expect(d.checks.find((c) => c.kind === 'progress_check' && c.sequence === 1)).toMatchObject({ status: 'done', satisfiedByEventId: 'ev_call' });
  });
  it('parts and delay events count as touches; a touch outside the window does not', () => {
    const parts = mkEvent('parts_arrived', '2026-07-24T15:00:00+01:00', { id: 'ev_parts' });
    const d = monitoringDiary([started, parts], 10, '2026-07-28T12:00:00+01:00');
    const p = d.checks.filter((c) => c.kind === 'progress_check');
    expect(p[0]).toMatchObject({ sequence: 1, status: 'overdue' });
    expect(p[1]).toMatchObject({ sequence: 2, status: 'done', satisfiedByEventId: 'ev_parts' });
    expect(p[2]).toMatchObject({ sequence: 3, dueAt: '2026-08-03T09:00:00+01:00', status: 'upcoming' });
  });
  it('stops the series at repair completion', () => {
    const completed = mkEvent('repair_completed', '2026-07-31T10:00:00+01:00', { id: 'ev_done' });
    const d = monitoringDiary([started, completed], 10, '2026-08-10T12:00:00+01:00');
    expect(d.checks.filter((c) => c.kind === 'progress_check').map((c) => c.dueAt)).toEqual(['2026-07-20T09:00:00+01:00', '2026-07-27T09:00:00+01:00']);
  });
});

describe('monitoringDiary — delay notices (≥ 2 WD or > 20% of the estimate)', () => {
  it('repair completed Fri 31 Jul against a 10-WD estimate ending Mon 27 Jul: 4 WD late, 40%', () => {
    const completed = mkEvent('repair_completed', '2026-07-31T10:00:00+01:00', { id: 'ev_done' });
    const d = monitoringDiary([started, completed], 10, '2026-08-10T12:00:00+01:00');
    expect(d.delayNotices).toEqual([
      expect.objectContaining({ kind: 'repair_overrun', workingDaysLate: 4, pctOver: 40, attributableTo: 'repairer', concluded: true, sourceEventId: 'ev_start' }),
    ]);
  });
  it('a running repair 1 WD over a 10-WD estimate does not qualify; 1 WD over a 4-WD estimate (25%) does', () => {
    // 10 WD: expected Mon 27 Jul; now Tue 28 Jul → 1 WD, 10%
    expect(monitoringDiary([started], 10, '2026-07-28T12:00:00+01:00').delayNotices).toEqual([]);
    // 4 WD: expected Fri 17 Jul; now Mon 20 Jul → 1 WD, 25%
    const d = monitoringDiary([started], 4, '2026-07-20T12:00:00+01:00');
    expect(d.delayNotices).toEqual([expect.objectContaining({ kind: 'repair_overrun', workingDaysLate: 1, pctOver: 25, concluded: false })]);
  });
  it('logged repair_delay events with data.workingDays produce notices when they qualify', () => {
    const big = mkEvent('repair_delay', '2026-07-21T10:00:00+01:00', { id: 'ev_delay_big', summary: 'Parts on back order', data: { workingDays: 3 }, attributableTo: 'repairer' });
    const small = mkEvent('repair_delay', '2026-07-22T10:00:00+01:00', { id: 'ev_delay_small', summary: 'Paint booth', data: { workingDays: 1 } });
    const d = monitoringDiary([started, big, small], 10, '2026-07-23T12:00:00+01:00');
    const logged = d.delayNotices.filter((n) => n.kind === 'logged_delay');
    expect(logged).toEqual([expect.objectContaining({ reason: 'Parts on back order', workingDaysLate: 3, pctOver: 30, attributableTo: 'repairer', sourceEventId: 'ev_delay_big' })]);
  });
  it('ignores events after now and exposes the thresholds', () => {
    const future = mkEvent('repair_completed', '2026-09-01T10:00:00+01:00');
    const d = monitoringDiary([started, future], 10, '2026-07-15T12:00:00+01:00');
    expect(d.checks.filter((c) => c.kind === 'progress_check')).toHaveLength(1);
    expect(d.thresholds).toEqual({ minWorkingDays: 2, pctOver: 20 });
  });
  it('returns an empty diary with no repair events', () => {
    expect(monitoringDiary([], 10, '2026-07-15T12:00:00+01:00')).toMatchObject({ checks: [], delayNotices: [] });
  });
});
