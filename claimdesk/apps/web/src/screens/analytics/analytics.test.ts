import { describe, expect, it } from 'vitest';
import { cycleLabel, debtorDaysTone, describeRange, headLabel, niceMax, pct, presetRange, rangeFromParams, reductionTone, topBars } from './analytics';

const today = '2026-10-04';

describe('ranges', () => {
  it('builds preset ranges anchored on today', () => {
    expect(presetRange('30d', today)).toEqual({ from: '2026-09-04', to: today });
    expect(presetRange('90d', today)).toEqual({ from: '2026-07-06', to: today });
    expect(presetRange('ytd', today)).toEqual({ from: '2026-01-01', to: today });
    expect(presetRange('12m', today)).toEqual({ from: '2025-10-04', to: today });
    expect(presetRange('all', today)).toEqual({});
  });
  it('reads params, defaulting to 90 days and honouring custom dates', () => {
    expect(rangeFromParams(new URLSearchParams(''), today)).toEqual({ preset: '90d', range: { from: '2026-07-06', to: today } });
    expect(rangeFromParams(new URLSearchParams('range=bogus'), today).preset).toBe('90d');
    expect(rangeFromParams(new URLSearchParams('range=custom&from=2026-01-01'), today)).toEqual({ preset: 'custom', range: { from: '2026-01-01', to: undefined } });
    expect(describeRange({})).toBe('all time');
    expect(describeRange({ from: '2026-01-01', to: '2026-02-01' })).toBe('2026-01-01 → 2026-02-01');
  });
});

describe('labels and numbers', () => {
  it('labels heads and cycle stages', () => {
    expect(headLabel('engineer_fee')).toBe('Engineer fee');
    expect(headLabel('new_head')).toBe('new head');
    expect(cycleLabel('fnol', 'ncaf_sent')).toBe('FNOL → NCAF');
    expect(cycleLabel('hire_ended', 'payment_pack_sent')).toBe('Hire end → Payment pack');
  });
  it('percentages, nice maxima and tones', () => {
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(1, 0)).toBe(0);
    expect(niceMax(0)).toBe(1);
    expect(niceMax(73)).toBe(100);
    expect(niceMax(42)).toBe(50);
    expect(niceMax(1287)).toBe(2000);
    expect(debtorDaysTone(30)).toBe('green');
    expect(debtorDaysTone(45)).toBe('amber');
    expect(debtorDaysTone(61)).toBe('red');
    expect(reductionTone(13.6)).toBe('amber');
  });
  it('tops bars and folds the tail', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ key: String(i), label: `I${i}`, value: i + 1 }));
    expect(topBars(items, 3).map((b) => b.value)).toEqual([6, 5, 4]);
    const folded = topBars(items, 3, true);
    expect(folded.map((b) => b.label)).toEqual(['I5', 'I4', 'Other (4)']);
    expect(folded[2]!.value).toBe(1 + 2 + 3 + 4);
  });
});
