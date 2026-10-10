// owned by knowledge-core
import { describe, expect, it } from 'vitest';
import { contentShaOf, isoWeekOf, itemKeyFor, learnedPackLabel, parseScopeKey, scopeKey, sha8 } from './keys.js';
import { claimTypeTagsFrom, scopeApplies, scopeProblems } from './scope.js';
import type { KnowledgeProposal } from './types.js';

const base = (over: Partial<KnowledgeProposal>): KnowledgeProposal => ({
  kind: 'fact', area: 'procedural', title: 'T', body: 'B', data: { statement: 'S', figure: null, asOf: null, benchmarkOnly: false, kbCheck: null, stat: null },
  tags: [], scope: { kind: 'global' }, business: ['ccguk'], useLimit: 'internal', origin: 'observed', confidence: 0.9, supportN: 2, provenance: [], createdBy: 'agent:supervisor', ...over,
});

describe('item keys (§4.2)', () => {
  it('follows the per-kind key rules', () => {
    expect(itemKeyFor(base({}))).toBe(`fact:global:${sha8('S')}`);
    expect(itemKeyFor(base({ data: { statement: 'x', figure: null, asOf: null, benchmarkOnly: false, kbCheck: { entryId: 'kb-1', citationOk: true, urlOk: true, principleSupported: 'yes', suggestedCorrection: null }, stat: null } }))).toBe('kbcheck:kb-1');
    expect(itemKeyFor(base({ kind: 'contact', area: 'contact', scope: { kind: 'insurer', slug: 'admiral' }, data: { insurerSlug: 'admiral', team: null, name: 'Jo', role: null, phone: null, phoneKind: null, email: 'Jo@Admiral.com', ivr: null, hours: null, observations: 2, independentThreads: 2, lastSeenAt: '2026-10-01T00:00:00Z' } }))).toBe('contact:admiral:jo@admiral.com');
    expect(itemKeyFor(base({ kind: 'insurer_profile', area: 'statistics', origin: 'computed', data: { insurerSlug: 'aviva', window: 'all' } as never }))).toBe('profile:aviva:all');
    expect(itemKeyFor(base({ kind: 'procedure', title: 'Portal upload', scope: { kind: 'insurer', slug: 'esure' } }))).toBe(`procedure:insurer:esure:${sha8('Portal upload')}`);
    expect(itemKeyFor(base({ kind: 'rule', itemKey: 'rule:cluster-7' }))).toBe('rule:cluster-7');
  });

  it('the content sha ignores key order and business order but not content', () => {
    const a = base({ business: ['ccguk', 'fixmyfile'] });
    const b = base({ business: ['fixmyfile', 'ccguk'] });
    expect(contentShaOf(a)).toBe(contentShaOf(b));
    expect(contentShaOf(a)).not.toBe(contentShaOf(base({ body: 'other' })));
    expect(contentShaOf(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('scope keys round-trip; ISO weeks and pack labels', () => {
    for (const s of [{ kind: 'global' }, { kind: 'insurer', slug: 'admiral' }, { kind: 'claim_type', tag: 'credit_hire' }] as const) expect(parseScopeKey(scopeKey(s))).toEqual(s);
    expect(isoWeekOf('2026-10-10')).toBe('2026-W41');
    expect(isoWeekOf('2027-01-01')).toBe('2026-W53');
    expect(learnedPackLabel(3)).toBe('learned@1.3.0');
  });
});

describe('scope', () => {
  it('claimTypeTagsFrom maps claim facts to tags in a stable order', () => {
    expect(claimTypeTagsFrom({ hasHire: true, totalLoss: true, liability: 'denied', track: 'small_claims', injuries: true })).toEqual(['credit_hire', 'total_loss', 'injury_referral', 'liability_dispute', 'small_claims']);
    expect(claimTypeTagsFrom({})).toEqual([]);
  });

  it('scopeApplies and scopeProblems', () => {
    expect(scopeApplies({ kind: 'global' }, null)).toBe(true);
    expect(scopeApplies({ kind: 'insurer', slug: 'admiral' }, { insurerSlug: 'admiral', claimTypes: [] })).toBe(true);
    expect(scopeApplies({ kind: 'insurer', slug: 'admiral' }, { insurerSlug: 'aviva', claimTypes: [] })).toBe(false);
    expect(scopeApplies({ kind: 'claim_type', tag: 'pcn' }, { insurerSlug: null, claimTypes: ['pcn'] })).toBe(true);
    expect(scopeProblems({ kind: 'insurer', slug: 'Bad Slug' })).not.toEqual([]);
    expect(scopeProblems({ kind: 'claim_type', tag: 'nope' })).not.toEqual([]);
    expect(scopeProblems({ kind: 'global' })).toEqual([]);
  });
});
