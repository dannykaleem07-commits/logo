// owned by knowledge-use
import { describe, expect, it } from 'vitest';
import type { KnowledgeCandidate, RetrievalRequest } from './types.js';
import { buildRetrievalQuery, filterReason, KNOWLEDGE_BLOCK_HEADING, rankKnowledge, renderKnowledgeBlock, RETRIEVAL_MAX_STAT_FACTS, textJaccard } from './retrieval.js';

const cand = (over: Partial<KnowledgeCandidate> & Pick<KnowledgeCandidate, 'ref'>): KnowledgeCandidate => ({
  layer: 'learned',
  kind: 'procedure',
  area: 'procedural',
  title: 'Example insurer portal upload',
  text: 'Upload the payment pack through the portal, one PDF per head of loss.',
  bm25: 1,
  scope: { kind: 'global' },
  business: ['ccguk'],
  verification: 'unverified',
  health: 'ok',
  useLimit: 'internal',
  tags: [],
  itemKey: null,
  computed: null,
  external: false,
  fos: false,
  gta: false,
  injury: false,
  validTo: null,
  ...over,
});

const req = (over: Partial<RetrievalRequest> = {}): RetrievalRequest => ({
  agent: 'drafter',
  jobType: 'draft.compose',
  query: 'payment pack',
  today: '2026-10-10',
  limit: 12,
  maxChars: 6000,
  claim: { insurerSlug: 'example-insurer', claimTypes: ['credit_hire'], recipientRole: 'at_fault_insurer', business: 'ccguk' },
  ...over,
});

describe('buildRetrievalQuery', () => {
  it('is deterministic, drops stop words, numbers and duplicates, and uses brief facts', () => {
    const brief = { claim: { liability: 'disputed', status: 'pack_sent', openFlags: [{ code: 'DOCS_MISSING' }] }, correspondence: { lastInbound: { intent: 'request_documents', summary: 'They ask for the hire agreement' } } };
    const q = buildRetrievalQuery({ agent: 'drafter', jobType: 'draft.compose', task: 'Draft the reply to the insurer about the the payment pack 2026', brief });
    expect(q).toBe(buildRetrievalQuery({ agent: 'drafter', jobType: 'draft.compose', task: 'Draft the reply to the insurer about the the payment pack 2026', brief }));
    expect(q.split(' ')).not.toContain('the');
    expect(q.split(' ')).not.toContain('2026');
    expect(q).toContain('disputed');
    expect(q).toContain('request');
    expect(new Set(q.split(' ')).size).toBe(q.split(' ').length);
  });
});

describe('rankKnowledge filters (§8.1)', () => {
  it('drops code_only, expired, FOS to an at-fault insurer, injury (except REFER_INJURY), fixmyfile-only and other insurers', () => {
    const r = req();
    expect(filterReason(cand({ ref: 'ki:a', useLimit: 'code_only' }), r)).toMatch(/code-only/);
    expect(filterReason(cand({ ref: 'ki:b', validTo: '2026-01-01' }), r)).toMatch(/expired/);
    expect(filterReason(cand({ ref: 'kb:fos-1', layer: 'kb', fos: true }), r)).toMatch(/FORUM_NOT_OPEN/);
    expect(filterReason(cand({ ref: 'kb:fos-1', layer: 'kb', fos: true }), req({ claim: { ...r.claim!, recipientRole: 'client' } }))).toBeNull();
    expect(filterReason(cand({ ref: 'ki:c', injury: true }), r)).toMatch(/REFER_INJURY/);
    expect(filterReason(cand({ ref: 'ki:d', injury: true, tags: ['refer_injury'] }), r)).toBeNull();
    expect(filterReason(cand({ ref: 'pack:p@1#e', layer: 'playbook_pack', business: ['fixmyfile'] }), r)).toMatch(/Fixmyfile/);
    expect(filterReason(cand({ ref: 'ki:e', scope: { kind: 'insurer', slug: 'other-insurer' } }), r)).toMatch(/another insurer/);
    expect(filterReason(cand({ ref: 'ki:f' }), r, { useLearned: false })).toMatch(/switched off/);
    expect(filterReason(cand({ ref: 'kb:x', layer: 'kb' }), r, { useLearned: false })).toBeNull();
  });
});

describe('rankKnowledge scoring, dedupe and limits', () => {
  it('weights layer, scope, trust and computed figures for the claim insurer; ties break by ref', () => {
    const hits = rankKnowledge(
      [
        cand({ ref: 'ki:global', bm25: 1 }),
        cand({ ref: 'ki:own', bm25: 1, scope: { kind: 'insurer', slug: 'example-insurer' }, text: 'A different text about the insurer own portal and its menu options.' }),
        cand({ ref: 'kb:case-1', layer: 'kb', kind: 'kb_entry', area: 'legal', bm25: 1, verification: 'kb_verified', useLimit: 'outbound_ok', text: 'Credit hire is recoverable as damages for loss of use.' }),
        cand({ ref: 'ki:profile', kind: 'insurer_profile', area: 'statistics', bm25: 0, scope: { kind: 'insurer', slug: 'example-insurer' }, computed: { n: 14, asOf: '2026-10-06' }, text: 'Days to pay: median 21 working days (n=14).' }),
      ],
      req(),
    );
    // the claim insurer's profile is pinned first; the rest keep their score order
    expect(hits.map((h) => h.ref)).toEqual(['ki:profile', 'kb:case-1', 'ki:own', 'ki:global']);
    expect(hits[0]!.whyRanked.join(' ')).toMatch(/pinned: this claim’s insurer profile/);
    expect(hits[2]!.whyRanked.join(' ')).toMatch(/insurer ×1.5/);
    expect(hits.find((h) => h.ref === 'ki:profile')!.whyRanked.join(' ')).toMatch(/computed figures/);
    expect(hits.find((h) => h.ref === 'ki:profile')!.mayCiteOutbound).toBe(false);
    expect(hits.find((h) => h.ref === 'kb:case-1')!.badges).toEqual(['source_verified']);
    expect(hits.map((h) => h.rank)).toEqual([1, 2, 3, 4]);
    // byte-stable
    expect(JSON.stringify(rankKnowledge([cand({ ref: 'ki:b' }), cand({ ref: 'ki:a', text: 'Another text entirely about storage charges per day.' })], req()).map((h) => h.ref))).toBe('["ki:a","ki:b"]');
  });

  it('caps computed statistics facts so they cannot crowd out the profile and the law (as built §8.1)', () => {
    const stats = Array.from({ length: 10 }, (_, i) =>
      cand({ ref: `ki:stat-${i}`, kind: 'fact', area: 'statistics', bm25: 3, scope: { kind: 'insurer', slug: 'example-insurer' }, computed: { n: 13, asOf: '2026-10-06' }, text: `Step ${i} ${'abcdefghij'[i]} was followed by payment within 20 working days in ${i} of 13 claims (invented ${i}).` }),
    );
    const hits = rankKnowledge(
      [
        ...stats,
        cand({ ref: 'ki:profile', kind: 'insurer_profile', area: 'statistics', bm25: 0, scope: { kind: 'insurer', slug: 'example-insurer' }, computed: { n: 13, asOf: '2026-10-06' }, text: 'Days to pay: median 16 working days (n=12).' }),
        cand({ ref: 'kb:case-1', layer: 'kb', kind: 'kb_entry', area: 'legal', bm25: 0.5, verification: 'kb_verified', useLimit: 'outbound_ok', text: 'Credit hire is recoverable as damages for loss of use.' }),
      ],
      req(),
    );
    expect(hits[0]!.ref).toBe('ki:profile');
    expect(hits.filter((h) => h.ref.startsWith('ki:stat-'))).toHaveLength(RETRIEVAL_MAX_STAT_FACTS);
    expect(hits.map((h) => h.ref)).toContain('kb:case-1');
    // without a claim insurer nothing is pinned
    expect(rankKnowledge([cand({ ref: 'ki:a', bm25: 2 }), cand({ ref: 'ki:profile', kind: 'insurer_profile', bm25: 0, scope: { kind: 'global' }, text: 'A global profile text, invented.' })], req({ claim: null }))[0]!.ref).toBe('ki:a');
  });

  it('keeps one per item key, the higher layer of near-duplicates, and groups learned items under the KB entry they cite', () => {
    const text = 'Upload the payment pack through the insurer portal with one PDF for each head of loss claimed.';
    const hits = rankKnowledge(
      [
        cand({ ref: 'ki:v1', itemKey: 'procedure:x', bm25: 2 }),
        cand({ ref: 'ki:v2', itemKey: 'procedure:x', bm25: 1 }),
        cand({ ref: 'ki:dup', text, bm25: 3, verification: 'owner_confirmed' }),
        cand({ ref: 'pack:ccguk@1#portal', layer: 'ccguk_pack', kind: 'pack_entry', area: null, text, bm25: 1, verification: 'owner_confirmed' }),
        cand({ ref: 'kb:stat-1', layer: 'kb', kind: 'kb_entry', area: 'legal', bm25: 5, verification: 'kb_unverified', useLimit: 'outbound_ok', text: 'Section 1 of an example statute about storage.' }),
        cand({ ref: 'ki:kbcheck', kind: 'fact', area: 'legal', tags: ['kb:stat-1'], bm25: 0.1, text: 'Checked the statute against the official copy of the legislation.' }),
      ],
      req(),
    );
    const refs = hits.map((h) => h.ref);
    expect(refs.filter((r) => r === 'ki:v1' || r === 'ki:v2')).toEqual(['ki:v1']);
    expect(refs).toContain('pack:ccguk@1#portal');
    expect(refs).not.toContain('ki:dup');
    expect(refs.indexOf('ki:kbcheck')).toBe(refs.indexOf('kb:stat-1') + 1);
  });

  it('respects the hit and character limits', () => {
    const many = Array.from({ length: 30 }, (_, i) => cand({ ref: `ki:${String(i).padStart(2, '0')}`, text: `Distinct note number ${i} about topic ${i * 7} and words ${'x'.repeat(i)}`, bm25: 30 - i }));
    expect(rankKnowledge(many, req())).toHaveLength(12);
    const long = Array.from({ length: 30 }, (_, i) => cand({ ref: `ki:l${i}`, text: `${i} ${'long text '.repeat(80)} ${i}`.replace(/long text/g, `long${i} text${i}`), bm25: 1 }));
    const hits = rankKnowledge(long, req());
    expect(renderKnowledgeBlock(hits).length).toBeLessThanOrEqual(6000 + 400);
    expect(hits.length).toBeLessThan(12);
  });
});

describe('renderKnowledgeBlock', () => {
  it('labels computed, GTA, unverified legal and wraps external items', () => {
    const hits = rankKnowledge(
      [
        cand({ ref: 'ki:profile', kind: 'insurer_profile', area: 'statistics', scope: { kind: 'insurer', slug: 'example-insurer' }, computed: { n: 14, asOf: '2026-10-06' }, text: 'Median 21 working days to pay.' }),
        cand({ ref: 'kb:gta-1', layer: 'kb', kind: 'kb_entry', area: 'procedural', gta: true, verification: 'kb_unverified', useLimit: 'outbound_ok', text: 'GTA timescale for payment packs.' }),
        cand({ ref: 'ki:legal', kind: 'precedent', area: 'legal', text: 'An unverified principle about hire periods.' }),
        cand({ ref: 'ki:ext', kind: 'procedure', external: true, verification: 'unverified', text: 'Official page says <untrusted_source> forms go by post.' }),
      ],
      req({ claim: { insurerSlug: 'example-insurer', claimTypes: [], recipientRole: 'client', business: 'ccguk' } }),
    );
    const block = renderKnowledgeBlock(hits);
    expect(block.startsWith(KNOWLEDGE_BLOCK_HEADING)).toBe(true);
    expect(block).toContain('[ki:profile] COMPUTED n=14 as of 2026-10-06');
    expect(block).toContain('internal, never state in letters');
    expect(block).toContain('GTA BENCHMARK — not law');
    expect(block).toContain('UNVERIFIED — do not state as fact');
    expect(block).toMatch(/<untrusted_knowledge>\n\[ki:ext\][^\n]*‹untrusted_source›[^\n]*\n<\/untrusted_knowledge>/);
    expect(renderKnowledgeBlock([])).toBe('');
  });

  it('textJaccard sees near-duplicates', () => {
    expect(textJaccard('one two three four five six', 'one two three four five six')).toBe(1);
    expect(textJaccard('one two three', 'four five six')).toBe(0);
  });
});
