// owned by knowledge-use
import { describe, expect, it } from 'vitest';
import { badMove, describeDrift, detectDrift } from './drift.js';

const opts = { minN: 10, dropPctPoints: 15 };

describe('detectDrift (§12.2)', () => {
  it('raises a warn alarm on a drop of 15 points or more with n ≥ 10', () => {
    const f = detectDrift([{ metric: 'approval_without_edit_rate', key: 'approve_send', baseline: 80, current: 60, n: 20, perimeter: false }], opts);
    expect(f).toEqual([{ metric: 'approval_without_edit_rate', key: 'approve_send', baseline: 80, current: 60, n: 20, dropPctPoints: 20, severity: 'warn' }]);
    expect(describeDrift(f[0]!)).toMatch(/80% to 60%/);
  });

  it('ignores small drops, small samples, missing baselines and improvements', () => {
    expect(detectDrift([{ metric: 'approval_without_edit_rate', key: null, baseline: 80, current: 70, n: 20, perimeter: false }], opts)).toEqual([]);
    expect(detectDrift([{ metric: 'approval_without_edit_rate', key: null, baseline: 80, current: 40, n: 9, perimeter: false }], opts)).toEqual([]);
    expect(detectDrift([{ metric: 'reviewer_first_pass_rate', key: null, baseline: null, current: 40, n: 30, perimeter: false }], opts)).toEqual([]);
    expect(detectDrift([{ metric: 'reduction_rate', key: null, baseline: 40, current: 10, n: 30, perimeter: false }], opts)).toEqual([]);
  });

  it('treats lower-is-better metrics and values correctly', () => {
    expect(badMove('reduction_rate', 10, 30)).toBe(20);
    expect(badMove('median_working_days_to_pay', 20, 24)).toBe(20);
    expect(detectDrift([{ metric: 'median_working_days_to_pay', key: null, baseline: 20, current: 24, n: 12, perimeter: false }], opts)[0]?.severity).toBe('warn');
  });

  it('perimeter samples are severe with any occurrence', () => {
    const f = detectDrift([{ metric: 'knowledge_block_rate', key: 'perimeter', baseline: null, current: 1, n: 1, perimeter: true }], opts);
    expect(f[0]).toMatchObject({ severity: 'severe', current: 1 });
    expect(detectDrift([{ metric: 'knowledge_block_rate', key: 'perimeter', baseline: null, current: 0, n: 3, perimeter: true }], opts)).toEqual([]);
  });
});
