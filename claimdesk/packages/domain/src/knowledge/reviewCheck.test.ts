// owned by knowledge-use
import { describe, expect, it } from 'vitest';
import type { KnowledgeHit, KnowledgeRef } from './types.js';
import { checkKnowledgeUse } from './reviewCheck.js';

const hit = (over: Partial<KnowledgeHit> & Pick<KnowledgeHit, 'ref'>): KnowledgeHit => ({
  layer: 'learned',
  kind: 'procedure',
  area: 'procedural',
  title: 'A note',
  text: 'The insurer accepts payment packs by email to its claims inbox.',
  bm25: 1,
  scope: { kind: 'global' },
  business: ['ccguk'],
  verification: 'owner_confirmed',
  health: 'ok',
  useLimit: 'outbound_ok',
  tags: [],
  itemKey: null,
  computed: null,
  external: false,
  fos: false,
  gta: false,
  injury: false,
  validTo: null,
  rank: 1,
  score: 1,
  badges: ['owner_confirmed'],
  whyRanked: [],
  mayCiteOutbound: true,
  ...over,
});

function check(text: string, cited: KnowledgeRef[], hits: KnowledgeHit[], extra: { internal?: { ref: KnowledgeRef; text: string }[]; basis?: KnowledgeRef[]; role?: 'at_fault_insurer' | 'client' } = {}) {
  const byRef = new Map(hits.map((h) => [h.ref, h] as const));
  return checkKnowledgeUse({ text, recipientRole: extra.role ?? 'at_fault_insurer', citedRefs: cited, basisRefs: extra.basis ?? [], internalBodies: extra.internal ?? [], resolve: (r) => byRef.get(r) });
}

describe('checkKnowledgeUse (§8.3)', () => {
  it('passes a citable, confirmed item', () => {
    expect(check('We attach the pack.', ['ki:ok'], [hit({ ref: 'ki:ok' })])).toEqual([]);
  });

  it('blocks an unknown or inactive ki: ref, but leaves unknown kb refs to the KB checks', () => {
    const f = check('Text.', ['ki:gone', 'kb:missing'], []);
    expect(f.map((x) => [x.code, x.severity])).toEqual([['KNOWLEDGE_REF_UNKNOWN', 'block']]);
  });

  it('blocks internal, computed, FOS-to-insurer and injury items as not citable', () => {
    const f = check('Text.', ['ki:int', 'ki:comp', 'ki:fos', 'ki:inj'], [
      hit({ ref: 'ki:int', useLimit: 'internal' }),
      hit({ ref: 'ki:comp', useLimit: 'internal', computed: { n: 5, asOf: '2026-10-01' }, kind: 'insurer_profile', area: 'statistics' }),
      hit({ ref: 'ki:fos', fos: true }),
      hit({ ref: 'ki:inj', injury: true }),
    ]);
    expect(f.map((x) => x.code)).toEqual(['KNOWLEDGE_NOT_CITABLE', 'KNOWLEDGE_NOT_CITABLE', 'KNOWLEDGE_NOT_CITABLE', 'KNOWLEDGE_NOT_CITABLE']);
    expect(check('Text.', ['ki:fos'], [hit({ ref: 'ki:fos', fos: true })], { role: 'client' })).toEqual([]);
  });

  it('blocks an unconfirmed legal point (LEGAL_UNCONFIRMED) and not once it is confirmed', () => {
    expect(check('Text.', ['ki:law'], [hit({ ref: 'ki:law', kind: 'precedent', area: 'legal', verification: 'unverified' })]).map((x) => x.code)).toEqual(['KNOWLEDGE_LEGAL_UNCONFIRMED']);
    expect(check('Text.', ['ki:law'], [hit({ ref: 'ki:law', kind: 'precedent', area: 'legal', verification: 'source_verified' })])).toEqual([]);
    // unverified KB entries keep the existing UNVERIFIED_CITATION wording check instead
    expect(check('Text.', ['kb:case-1'], [hit({ ref: 'kb:case-1', layer: 'kb', kind: 'kb_entry', area: 'legal', verification: 'kb_unverified' })])).toEqual([]);
  });

  it('warns on stale and conflicted items', () => {
    const f = check('Text.', ['ki:stale', 'ki:conf', 'kb:old'], [hit({ ref: 'ki:stale', health: 'source_changed' }), hit({ ref: 'ki:conf', health: 'conflicted' }), hit({ ref: 'kb:old', layer: 'kb', kind: 'kb_entry', area: null, verification: 'kb_stale' })]);
    expect(f.map((x) => [x.code, x.severity])).toEqual([
      ['KNOWLEDGE_CONFLICTED', 'warn'],
      ['KNOWLEDGE_STALE', 'warn'],
      ['KNOWLEDGE_STALE', 'warn'],
    ]);
  });

  it('blocks internal leaks: 8-word overlap with an injected internal item, and statistic phrasing', () => {
    const internal = [{ ref: 'ki:profile' as KnowledgeRef, text: 'This insurer pays the hire head in a median of 21 working days after the pack.' }];
    const leak = check('Please note this insurer pays the hire head in a median of 21 working days after the pack.', [], [], { internal });
    expect(leak.map((x) => x.code)).toContain('KNOWLEDGE_INTERNAL_LEAK');
    expect(check('Please pay the hire charges within 14 days.', [], [], { internal })).toEqual([]);
    expect(check('You usually pay in about three weeks, so we expect payment.', [], []).map((x) => x.code)).toEqual(['KNOWLEDGE_INTERNAL_LEAK']);
    expect(check('In 3 of 4 cases this was resolved quickly.', [], []).map((x) => x.code)).toEqual(['KNOWLEDGE_INTERNAL_LEAK']);
  });

  it('warns when an unverified external item is the only basis for a factual sentence', () => {
    const ext = hit({ ref: 'ki:ext', external: true, verification: 'unverified', useLimit: 'outbound_ok', text: 'The form must be sent by recorded post to the central office within 21 days.' });
    const f = check('The form must be sent by recorded post to the central office. We enclose it.', [], [ext], { basis: ['ki:ext'], role: 'client' });
    expect(f.map((x) => [x.code, x.severity])).toEqual([['KNOWLEDGE_UNVERIFIED_STATED_AS_FACT', 'warn']]);
    expect(check('We understand the form must be sent by recorded post to the central office.', [], [ext], { basis: ['ki:ext'], role: 'client' })).toEqual([]);
  });
});
