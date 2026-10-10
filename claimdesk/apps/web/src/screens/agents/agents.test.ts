import { describe, expect, it } from 'vitest';
import { decisionTone, formatDuration, percent, pillTone, scheduleCadence } from '../../api/agentsApi';
import { describeToastTest } from '../settings/notifications/NotificationsSettingsPage';
import { COUNT_LABELS, londonToday } from '../dailyLog/DailyLogPage';
import { laneReasonLabel } from './AgentsPage';

describe('agents control-room helpers', () => {
  it('pill tones follow §L.1', () => {
    expect(pillTone('running')).toBe('green');
    expect(pillTone('paused')).toBe('amber');
    expect(pillTone('stopped')).toBe('red');
    expect(pillTone('off')).toBe('grey');
  });

  it('lane gate reasons read as words, not codes', () => {
    expect(laneReasonLabel('paused:usage_limited:five_hour')).toBe('Paused — usage limit');
    expect(laneReasonLabel('paused:auth_failed')).toBe('Paused — sign-in needed');
    expect(laneReasonLabel('kill_switch')).toBe('Stopped');
    expect(laneReasonLabel('agents_off')).toBe('Agents off');
    expect(laneReasonLabel(undefined)).toBe('Closed');
  });

  it('formats durations, percentages and schedules', () => {
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(200_000)).toBe('3 min 20 s');
    expect(formatDuration(3_900_000)).toBe('1 h 5 min');
    expect(formatDuration(null)).toBe('—');
    expect(percent(0.423)).toBe('42 %');
    expect(percent(undefined)).toBe('—');
    expect(scheduleCadence({ everyMinutes: 5 })).toBe('every 5 min');
    expect(scheduleCadence({ everyMinutes: 60 })).toBe('every 1 h');
    expect(scheduleCadence({ atLocal: '07:30', weekdays: [1, 2, 3, 4, 5] })).toBe('07:30 Mon–Fri');
    expect(scheduleCadence({ atLocal: '18:00' })).toBe('18:00 daily');
    expect(decisionTone('asked')).toBe('amber');
    expect(decisionTone('denied')).toBe('red');
  });

  it('explains the toast test result and the daily log labels', () => {
    const r = (status: string) => ({ notification: {} as never, platform: 'x', result: { notificationId: 'n', deliveries: [{ channel: 'in_app', ok: true, status: 'shown' }, { channel: 'toast', ok: true, status }] } });
    expect(describeToastTest(r('not_windows'))).toMatch(/not running Windows/);
    expect(describeToastTest(r('shown'))).toMatch(/sent to Windows/);
    expect(COUNT_LABELS.map(([k]) => k)).toContain('autoSent');
    expect(londonToday(new Date('2026-10-05T23:30:00Z'))).toBe('2026-10-06');
  });
});
