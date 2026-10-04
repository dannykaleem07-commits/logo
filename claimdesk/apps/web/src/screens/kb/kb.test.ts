import { describe, expect, it } from 'vitest';
import type { KbEntry } from '@ccguk/domain';
import { citationChips, DEFAULT_FORUM_CHECKS, GET_PAID_FASTER_PLAN, planByStage, sortResults, topicLabel, unverifiedCitations } from './kb';

const entries: KbEntry[] = [
  { id: 'gta-4-1', type: 'gta', citation: 'GTA 4.1', title: 'New Claim Advice Form', principle: 'Within 1 working day.', tags: [], topics: ['gta'], verification: { status: 'verified', verifiedAt: '2026-10-01' } },
  { id: 'case-copley', type: 'case', citation: 'Copley v Lawn [2009] EWCA Civ 580', title: 'Copley', principle: 'Reasonable refusal of an offer.', tags: [], topics: ['intervention'], verification: { status: 'unverified' } }
];

describe('citations', () => {
  it('resolves chips against entries and marks unknown or unverified ones', () => {
    const chips = citationChips(['gta-4-1', 'case-copley', 'missing'], entries);
    expect(chips.map((c) => [c.label, c.unverified])).toEqual([
      ['GTA 4.1', false],
      ['Copley v Lawn [2009] EWCA Civ 580', true],
      ['missing', true]
    ]);
  });
  it('lists unverified citations once, preferring the API list when given', () => {
    const advice = { summary: '', caveats: [], entries, points: [{ text: 'a', citations: ['gta-4-1', 'case-copley'] }, { text: 'b', citations: ['case-copley'] }] };
    expect(unverifiedCitations(advice)).toEqual(['case-copley']);
    expect(unverifiedCitations({ ...advice, unverifiedCitations: ['x', 'x', 'y'] })).toEqual(['x', 'y']);
  });
  it('sorts verified results first', () => {
    expect(sortResults([entries[1]!, entries[0]!]).map((e) => e.id)).toEqual(['gta-4-1', 'case-copley']);
  });
});

describe('plan', () => {
  it('runs from day 1 to perimeter in order with every GTA step marked benchmark-only', () => {
    const groups = planByStage();
    expect(groups[0]!.stage).toBe('day_1');
    expect(groups.at(-1)!.stage).toBe('perimeter');
    for (const g of groups) {
      const orders = g.steps.map((s) => s.order);
      expect(orders, g.stage).toEqual([...orders].sort((a, b) => a - b));
    }
    expect(groups.map((g) => g.stage)).toEqual(['day_1', 'days_1_7', 'sign_up', 'during_hire', 'hire_end', 'payment', 'chase', 'escalation', 'litigation', 'onboarding', 'perimeter']);
    expect(groups.flatMap((g) => g.steps)).toHaveLength(GET_PAID_FASTER_PLAN.length);
    for (const s of GET_PAID_FASTER_PLAN) if (s.basis.some((b) => /^GTA/.test(b))) expect(s.benchmarkOnly, s.code).toBe(true);
    expect(GET_PAID_FASTER_PLAN.find((s) => s.code === 'SEND_PAYMENT_PACK')?.templateId).toBe('pack.gta_payment');
  });
  it('never names the FOS as open against the at-fault insurer', () => {
    const fos = DEFAULT_FORUM_CHECKS.find((f) => /Ombudsman/.test(f.forum) && /at-fault/.test(f.forum));
    expect(fos?.open).toBe(false);
    expect(fos?.basis).toMatch(/DISP 2\.7/);
  });
  it('labels topics', () => {
    expect(topicLabel('non_party_costs')).toBe('Non-party costs (Tescher)');
    expect(topicLabel('something_new')).toBe('something new');
  });
});
