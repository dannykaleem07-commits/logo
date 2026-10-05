import { describe, it, expect } from 'vitest';
import { mkEvent } from '../gta/fixtures.js';
import { CORRECTS_EVENT_KEY, correctedEventId, liveEvents, supersededEventIds } from './corrections.js';

describe('event corrections', () => {
  const a = mkEvent('hire_started', '2026-09-01T10:00:00+01:00', { id: 'A' });
  const b = mkEvent('hire_started', '2026-09-03T10:00:00+01:00', { id: 'B', data: { correctsEventId: 'A' } });
  const c = mkEvent('hire_started', '2026-09-02T10:00:00+01:00', { id: 'C', data: { correctsEventId: 'B' } });
  const other = mkEvent('ncaf_sent', '2026-09-02T09:00:00+01:00', { id: 'X' });

  it('reads data.correctsEventId only when it is a non-empty string', () => {
    expect(CORRECTS_EVENT_KEY).toBe('correctsEventId');
    expect(correctedEventId(b)).toBe('A');
    expect(correctedEventId(a)).toBeUndefined();
    expect(correctedEventId(mkEvent('note', '2026-09-01T10:00:00+01:00', { data: { correctsEventId: 7 } }))).toBeUndefined();
    expect(correctedEventId(mkEvent('note', '2026-09-01T10:00:00+01:00', { data: { correctsEventId: '' } }))).toBeUndefined();
  });

  it('supersededEventIds lists every corrected event', () => {
    expect([...supersededEventIds([a, b, c, other])].sort()).toEqual(['A', 'B']);
    expect(supersededEventIds([a, other]).size).toBe(0);
  });

  it('liveEvents resolves chains (A ← B ← C → only C) and preserves order', () => {
    expect(liveEvents([other, a, b, c]).map((e) => e.id)).toEqual(['X', 'C']);
    expect(liveEvents([c, other, b, a]).map((e) => e.id)).toEqual(['C', 'X']);
  });

  it('returns a copy and keeps everything when nothing is corrected', () => {
    const input = [a, other];
    const out = liveEvents(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('a correction pointing at an unknown event drops nothing', () => {
    const orphan = mkEvent('note', '2026-09-05T10:00:00+01:00', { id: 'N', data: { correctsEventId: 'missing' } });
    expect(liveEvents([a, orphan]).map((e) => e.id)).toEqual(['A', 'N']);
  });
});
