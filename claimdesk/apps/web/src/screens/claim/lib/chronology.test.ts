import { describe, expect, it } from 'vitest';
import type { ClaimEvent } from '@ccguk/domain';
import { ATTRIBUTABLE_LABEL, attributableDays, defaultAttribution, EVENT_GROUPS, EVENT_LABEL, eventBodyFrom, eventGroup, emptyEventForm, filterEvents, sortEvents } from './chronology';

const ev = (id: string, type: ClaimEvent['type'], at: string, attributableTo?: ClaimEvent['attributableTo']): ClaimEvent => ({
  id,
  claimId: 'c1',
  type,
  at,
  recordedAt: at,
  summary: `${type} summary`,
  attributableTo,
  evidenceIds: [],
  createdBy: 'u1'
});

describe('event groups', () => {
  it('cover every event type exactly once', () => {
    const all = EVENT_GROUPS.flatMap((g) => g.types);
    expect(new Set(all).size).toBe(all.length);
    for (const type of Object.keys(EVENT_LABEL)) expect(eventGroup(type), type).toBeDefined();
  });
  it('pre-fills the obvious attribution', () => {
    expect(defaultAttribution('repair_delay')).toBe('repairer');
    expect(defaultAttribution('payment_received')).toBe('insurer');
    expect(defaultAttribution('chaser_sent')).toBe('ccguk');
    expect(defaultAttribution('')).toBe('');
    expect(Object.keys(ATTRIBUTABLE_LABEL)).toContain('none');
  });
});

describe('attributableDays', () => {
  it('attributes the gap to the next event to the party named on each event', () => {
    const events = [
      ev('1', 'estimate_received', '2026-09-01T10:00:00Z', 'engineer'),
      ev('2', 'repair_authorised', '2026-09-04T10:00:00Z', 'insurer'), // 3 days with the engineer's estimate → wait, insurer authorised; gap 1→2 belongs to engineer
      ev('3', 'repair_started', '2026-09-11T10:00:00Z', 'repairer'), // 7 days insurer
      ev('4', 'repair_completed', '2026-09-13T22:00:00Z', 'repairer') // 2.5 days repairer, then to `until`
    ];
    const out = attributableDays(events, '2026-09-14T10:00:00Z');
    const byParty = Object.fromEntries(out.map((o) => [o.party, o]));
    expect(byParty.engineer?.days).toBe(3);
    expect(byParty.insurer?.days).toBe(7);
    expect(byParty.repairer?.days).toBe(3); // 2.5 + 0.5
    expect(byParty.repairer?.segments).toBe(2);
    expect(out[0]?.party).toBe('insurer');
  });
  it('ignores unattributed and "none" events and never counts past `until`', () => {
    const events = [ev('1', 'note', '2026-09-01T00:00:00Z'), ev('2', 'call', '2026-09-02T00:00:00Z', 'none'), ev('3', 'chaser_sent', '2026-09-03T00:00:00Z', 'ccguk')];
    expect(attributableDays(events, '2026-09-05T00:00:00Z')).toEqual([{ party: 'ccguk', days: 2, segments: 1 }]);
    expect(attributableDays(events, '2026-09-02T12:00:00Z')).toEqual([]);
  });
});

describe('sort and filter', () => {
  const events = [ev('a', 'fnol', '2026-09-02T09:00:00Z', 'client'), ev('b', 'ncaf_sent', '2026-09-01T09:00:00Z', 'ccguk'), ev('c', 'repair_delay', '2026-09-03T09:00:00Z', 'repairer')];
  it('sorts by at in either direction', () => {
    expect(sortEvents(events).map((e) => e.id)).toEqual(['b', 'a', 'c']);
    expect(sortEvents(events, 'desc').map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });
  it('filters by group, attribution and text', () => {
    expect(filterEvents(events, { group: 'engineering' }).map((e) => e.id)).toEqual(['c']);
    expect(filterEvents(events, { attributableTo: 'ccguk' }).map((e) => e.id)).toEqual(['b']);
    expect(filterEvents(events, { q: 'advice form' }).map((e) => e.id)).toEqual(['b']);
  });
});

describe('eventBodyFrom', () => {
  const now = '2026-10-04T12:00:00.000Z';
  it('requires type, a past time and a summary', () => {
    const r = eventBodyFrom({ ...emptyEventForm(now), at: '2026-10-05T12:00:00.000Z' }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['at', 'summary', 'type']);
  });
  it('builds the body and drops empty optionals', () => {
    const r = eventBodyFrom({ type: 'repair_delay', at: '2026-10-03T09:00:00.000Z', summary: '  Parts on back order  ', attributableTo: 'repairer', evidenceIds: [] }, now);
    expect(r).toEqual({ ok: true, body: { type: 'repair_delay', at: '2026-10-03T09:00:00.000Z', summary: 'Parts on back order', attributableTo: 'repairer', evidenceIds: undefined, documentId: undefined } });
  });
});
