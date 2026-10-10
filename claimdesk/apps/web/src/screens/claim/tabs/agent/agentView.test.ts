// owned by casework
import { describe, expect, it } from 'vitest';
import { askError, confidenceLabel, confidenceTone, historyRows, nextBest } from './agentView';

describe('agent tab helpers', () => {
  it('prefers the case review next best action, else the playbook', () => {
    const playbook = [{ code: 'CHASER_7', title: 'Chase', why: 'No reply', dueAt: null }];
    expect(nextBest(null, playbook)).toMatchObject({ code: 'CHASER_7', source: 'playbook', confidence: 1 });
    const review = { nextBestAction: { code: 'SEND_NCAF', title: 'NCAF', why: 'w', basis: [], confidence: 0.7, dueAt: null } } as never;
    expect(nextBest(review, playbook)).toMatchObject({ code: 'SEND_NCAF', source: 'case_review' });
    expect(nextBest(null, [])).toBeNull();
  });
  it('formats confidence and validates questions', () => {
    expect(confidenceLabel(0.934)).toBe('93%');
    expect(confidenceTone(0.9)).toBe('green');
    expect(confidenceTone(0.5)).toBe('red');
    expect(askError(' a ')).toMatch(/at least/);
    expect(askError('Is storage recoverable?')).toBeUndefined();
  });
  it('merges runs and unfinished jobs newest first', () => {
    const rows = historyRows(
      [{ id: 'r1', agent: 'case_manager', jobType: 'case.review', model: 'm', effort: 'medium', startedAt: '2026-10-07T09:00:00Z', endedAt: '2026-10-07T09:01:00Z', outcome: 'ok', toolCalls: 2 }],
      [
        { id: 'j1', type: 'case.review', agent: 'case_manager', status: 'succeeded', priority: 1, attempts: 1, createdAt: '2026-10-07T08:59:00Z', updatedAt: '2026-10-07T09:01:00Z' },
        { id: 'j2', type: 'draft.compose', agent: 'drafter', status: 'waiting_usage', priority: 2, attempts: 0, createdAt: '2026-10-07T09:02:00Z', updatedAt: '2026-10-07T09:02:00Z' },
      ],
    );
    expect(rows.map((r) => r.id)).toEqual(['j2', 'r1']);
  });
});
