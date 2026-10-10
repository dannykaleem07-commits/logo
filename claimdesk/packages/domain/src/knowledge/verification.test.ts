// owned by knowledge-core
import { describe, expect, it } from 'vitest';
import { effectiveBadges, kbOverlayStatus, mayCiteOutbound } from './verification.js';
import type { KnowledgeCheck, KnowledgeItemLike } from './types.js';

const item = (over: Partial<KnowledgeItemLike> = {}): KnowledgeItemLike => ({ kind: 'fact', area: 'procedural', origin: 'researched', verification: 'unverified', health: 'ok', useLimit: 'outbound_ok', tags: [], business: ['ccguk'], status: 'active', provenance: [], ...over });
const check = (over: Partial<KnowledgeCheck>): KnowledgeCheck => ({ id: 'c', target: 'kb:k1', result: 'source_verified', method: 'source_compare', snapshotId: null, sourceUrl: 'https://www.legislation.gov.uk/x', quote: null, quoteMatch: 'not_applicable', note: null, checkedBy: 'owner', checkedAt: '2026-10-01T10:00:00Z', needsYouId: null, ...over });

describe('effectiveBadges (KR-2: health downgrades the display only)', () => {
  it('shows verification, computed, GTA benchmark, external and health problems', () => {
    expect(effectiveBadges({ verification: 'owner_confirmed', health: 'ok', origin: 'owner', tags: [], provenance: [] })).toEqual(['owner_confirmed']);
    expect(effectiveBadges({ verification: 'unverified', health: 'ok', origin: 'computed', tags: [], provenance: [] })).toEqual(['computed']);
    expect(effectiveBadges({ verification: 'source_verified', health: 'source_changed', origin: 'researched', tags: ['gta'], provenance: [{ kind: 'snapshot', snapshotId: 's', url: 'https://www.gtacredithire.com/rates', fetchedAt: '2026-10-01T00:00:00Z', quote: 'q', anchor: null, quoteMatch: 'exact' }] })).toEqual(['source_verified', 'benchmark_only', 'external', 'source_changed']);
    expect(effectiveBadges({ verification: 'owner_confirmed', health: 'conflicted', origin: 'observed', tags: [], provenance: [] })).toEqual(['owner_confirmed', 'conflicted']);
  });
});

describe('mayCiteOutbound', () => {
  it('legal and quantum points need a human check; computed and internal never; health must be ok', () => {
    expect(mayCiteOutbound(item({ area: 'legal' }), 'at_fault_insurer').ok).toBe(false);
    expect(mayCiteOutbound(item({ area: 'legal', verification: 'owner_confirmed' }), 'at_fault_insurer').ok).toBe(true);
    expect(mayCiteOutbound(item({ kind: 'precedent', area: 'quantum', verification: 'source_verified' }), null).ok).toBe(true);
    expect(mayCiteOutbound(item({ origin: 'computed', area: 'statistics' }), null).ok).toBe(false);
    expect(mayCiteOutbound(item({ useLimit: 'internal' }), null).ok).toBe(false);
    expect(mayCiteOutbound(item({ useLimit: 'code_only' }), null).ok).toBe(false);
    expect(mayCiteOutbound(item({ health: 'stale' }), null).ok).toBe(false);
    expect(mayCiteOutbound(item({ status: 'retired' }), null).ok).toBe(false);
  });

  it('FOS never to an at-fault insurer; injury never; GTA only as a benchmark', () => {
    expect(mayCiteOutbound(item({ tags: ['fos'], business: ['fixmyfile'] }), 'at_fault_insurer').ok).toBe(false);
    expect(mayCiteOutbound(item({ tags: ['fos'], business: ['fixmyfile'] }), 'client').ok).toBe(true);
    expect(mayCiteOutbound(item({ tags: ['injury'] }), 'client').ok).toBe(false);
    expect(mayCiteOutbound(item({ tags: ['gta'] }), 'at_fault_insurer')).toEqual({ ok: true, reason: 'GTA benchmark only — never as law' });
  });
});

describe('kbOverlayStatus (§4.5)', () => {
  it('the latest human check wins; code checks are ignored; failed excludes; a source change shows stale', () => {
    expect(kbOverlayStatus('unverified', [], 'ok')).toBe('unverified');
    expect(kbOverlayStatus('unverified', [check({})], 'ok')).toBe('verified');
    expect(kbOverlayStatus('unverified', [check({ checkedBy: 'agent:researcher' })], 'ok')).toBe('unverified');
    expect(kbOverlayStatus('verified', [check({}), check({ id: 'd', result: 'failed', checkedAt: '2026-10-02T00:00:00Z' })], 'ok')).toBe('failed');
    expect(kbOverlayStatus('unverified', [check({})], 'source_changed')).toBe('stale');
    expect(kbOverlayStatus('failed', [], 'ok')).toBe('failed');
  });
});
