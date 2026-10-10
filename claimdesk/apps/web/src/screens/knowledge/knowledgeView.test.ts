import { describe, expect, it } from 'vitest';
import { BADGE_LABEL, DEFAULT_KNOWLEDGE_SETTINGS, type KnowledgeBadge, type KnowledgeChange, type KnowledgeProvenance } from '@ccguk/domain';
import {
  BADGE_TONE,
  KNOWLEDGE_TABS,
  NUMBER_SETTINGS,
  allQuotesMatched,
  aroundQuote,
  badgeText,
  changesCsv,
  currentVersionOf,
  dataRows,
  diffCounts,
  editApproveEdits,
  gapAnswerItem,
  highlightQuote,
  knowledgeHref,
  parseTab,
  provenanceChips,
  readNumberSetting,
  reviewPayload,
  safeLink,
  scopeLabel,
  undoItemId,
  weekLearned,
  weekTotals,
  wordDiff,
} from './knowledgeView';

const snap = (quoteMatch: 'exact' | 'normalised'): KnowledgeProvenance => ({ kind: 'snapshot', snapshotId: 's1', url: 'https://www.gov.uk/x', fetchedAt: '2026-10-01T10:00:00.000Z', quote: 'within 14 days', anchor: null, quoteMatch });

describe('knowledge view helpers', () => {
  it('keeps the tab in the URL and falls back to This week', () => {
    expect(KNOWLEDGE_TABS.map((t) => t.label)).toEqual(['This week', 'Approve', 'Gaps', 'Insurers', 'Library', 'Sources', 'Versions', 'Safety']);
    expect(parseTab('approve')).toBe('approve');
    expect(parseTab('nonsense')).toBe('week');
    expect(parseTab(null)).toBe('week');
    expect(knowledgeHref('gaps', { gap: 'g 1', other: undefined })).toBe('/knowledge?tab=gaps&gap=g+1');
  });

  it('badges are text without emoji, COMPUTED carries n, every badge has a tone', () => {
    for (const b of Object.keys(BADGE_LABEL) as KnowledgeBadge[]) {
      expect(badgeText(b)).toMatch(/^[A-Z][A-Z -]+$/);
      expect(BADGE_TONE[b]).toBeTruthy();
    }
    expect(badgeText('computed', 14)).toBe('COMPUTED n=14');
    expect(badgeText('benchmark_only')).toBe('GTA BENCHMARK');
    expect(badgeText('conflicted')).toBe('CONFLICT');
  });

  it('source-verified approval needs every quote matched exactly', () => {
    expect(allQuotesMatched({ provenance: [snap('exact')] })).toBe(true);
    expect(allQuotesMatched({ provenance: [snap('exact'), snap('normalised')] })).toBe(false);
    expect(allQuotesMatched({ provenance: [{ kind: 'url', url: 'https://x.example', seenAt: '2026-10-01T00:00:00.000Z', note: '' }] })).toBe(false);
    expect(allQuotesMatched({ provenance: [] })).toBe(false);
  });

  it('highlights the quote exactly, then ignoring case and spacing, and says when it is missing', () => {
    const exact = highlightQuote('Pay within 14 days of the claim.', 'within 14 days');
    expect(exact.found).toBe(true);
    expect(exact.segments.filter((s) => s.hit).map((s) => s.text)).toEqual(['within 14 days']);
    const loose = highlightQuote('Pay WITHIN\n14   days of it', 'within 14 days');
    expect(loose.found).toBe(true);
    expect(loose.segments.find((s) => s.hit)!.text).toBe('WITHIN\n14   days');
    expect(highlightQuote('nothing here', 'within 14 days').found).toBe(false);
    expect(highlightQuote('a (b) c', '(b)').found).toBe(true);
    const long = `${'x'.repeat(2000)} within 14 days ${'y'.repeat(2000)}`;
    const w = aroundQuote(long, 'within 14 days', 100);
    expect(w.length).toBeLessThan(260);
    expect(w).toContain('within 14 days');
  });

  it('provenance chips never name a claim, and web-only links say they cannot be approved', () => {
    const chips = provenanceChips([
      { kind: 'claim_stats', n: 12, claimIds: ['c1', 'c2'], computedAt: '2026-10-01T00:00:00.000Z', method: 'median' },
      snap('exact'),
      { kind: 'url', url: 'https://www.example.org/page', seenAt: '2026-10-01T00:00:00.000Z', note: '' },
    ]);
    expect(chips[0]!.label).toBe('12 claims');
    expect(JSON.stringify(chips[0])).not.toContain('c1');
    expect(chips[1]!.snapshotId).toBe('s1');
    expect(chips[1]!.label).toBe('Source: gov.uk');
    expect(chips[2]!.title).toMatch(/cannot be approved/);
  });

  it('word diff, current version and version diff counts', () => {
    const d = wordDiff('call 0300 111', 'call 0300 222');
    expect(d.some((p) => p.op === 'del' && p.text.includes('111'))).toBe(true);
    expect(d.some((p) => p.op === 'ins' && p.text.includes('222'))).toBe(true);
    expect(wordDiff('same', 'same')).toEqual([{ op: 'eq', text: 'same' }]);
    const versions = [
      { id: 'b', status: 'proposed' },
      { id: 'a', status: 'active' },
    ] as never[];
    expect(currentVersionOf({ id: 'b', supersedesId: null }, versions)?.id).toBe('a');
    expect(diffCounts({ added: [{}, {}] as never, removed: [{}] as never, changed: [] })).toBe('+2 −1 ~0');
    expect(diffCounts(null)).toBe('+0 −0 ~0');
  });

  it('reads data rows and scope labels for people, not JSON', () => {
    const rows = dataRows({ insurerSlug: 'aviva', phone: '0300 000 0000', observations: 3, lastSeenAt: '2026-10-01', stat: { n: 1 } });
    expect(rows.map((r) => r.label)).toEqual(['Insurer', 'Phone', 'Seen in emails', 'Last seen']);
    expect(scopeLabel({ kind: 'global' })).toBe('All claims');
    expect(scopeLabel({ kind: 'insurer', slug: 'aviva' })).toBe('Insurer: aviva');
    expect(scopeLabel({ kind: 'claim_type', tag: 'credit_hire' })).toBe('Claim type: credit hire');
  });

  it('digest lines: week totals, Undo item id, and only in-app links', () => {
    const line = { at: '2026-10-02T09:00:00.000Z', text: 'Learned a contact', badges: [] as KnowledgeBadge[], link: '/knowledge?tab=library&item=k1', undoRoute: '/api/knowledge/items/k1/retire' };
    const day = (n: number) => ({ day: `2026-10-0${n}`, learningEnabled: true, activeVersion: 3, publishedToday: [], learnedAutomatically: [{ ...line, at: `2026-10-0${n}T09:00:00.000Z` }], waitingForYou: { count: 1, lines: [] }, gaps: { opened: 1, filled: n % 2, open: 2, lines: [] }, sources: { fetched: 3, changed: 1, refused: 0 }, research: { runs: 1, proposals: 2, ownerRejected: 0 }, alarms: [], headline: '' });
    const week = { days: [day(1), day(2)] };
    expect(weekLearned(week).map((l) => l.at)).toEqual(['2026-10-02T09:00:00.000Z', '2026-10-01T09:00:00.000Z']);
    expect(weekTotals(week)).toMatchObject({ gapsOpened: 2, gapsFilled: 1, fetched: 6, changed: 2, researchRuns: 2, proposals: 4 });
    expect(undoItemId({ undoRoute: '/api/knowledge/items/k%201/retire' })).toBe('k 1');
    expect(undoItemId({ itemId: 'x', undoRoute: '/api/knowledge/items/k1/retire' })).toBe('x');
    expect(safeLink('/knowledge?tab=gaps')).toBe('/knowledge?tab=gaps');
    expect(safeLink('//evil.example')).toBeUndefined();
    expect(safeLink('/api/knowledge/items/k1/retire')).toBeUndefined();
    expect(safeLink('https://evil.example')).toBeUndefined();
  });

  it('reads knowledge_review payloads defensively', () => {
    expect(reviewPayload({ variant: 'items', groupTitle: 'Contacts', itemIds: ['a', 2, 'b'], replayRunId: null })).toEqual({ variant: 'items', groupTitle: 'Contacts', itemIds: ['a', 'b'], replayRunId: null });
    expect(reviewPayload({ variant: 'gap', gapId: 'g1', question: 'Q?', looked: [{ domain: 'gov.uk', url: null }, { nope: 1 }] })).toEqual({ variant: 'gap', gapId: 'g1', question: 'Q?', preparedItemId: null, looked: [{ domain: 'gov.uk', url: null }] });
    expect(reviewPayload({ variant: 'alarm', alarmId: 'a1', suggestedRollbackTo: 4 })).toEqual({ variant: 'alarm', alarmId: 'a1', suggestedRollbackTo: 4 });
    expect(reviewPayload({ variant: 'conflict' })).toBeUndefined();
    expect(reviewPayload(null)).toBeUndefined();
  });

  it('edit then approve needs a title and a JSON object, and keeps the scope', () => {
    const item = { id: 'k1', scope: { kind: 'insurer' as const, slug: 'aviva' } };
    expect(editApproveEdits(item, { title: ' ', body: '', dataJson: '{}' })).toEqual({ ok: false, error: 'Give it a title.' });
    expect(editApproveEdits(item, { title: 'T', body: '', dataJson: '{bad' }).ok).toBe(false);
    expect(editApproveEdits(item, { title: 'T', body: '', dataJson: '[1]' }).ok).toBe(false);
    expect(editApproveEdits(item, { title: ' T ', body: 'B', dataJson: '{"a":1}' })).toEqual({ ok: true, edits: { itemId: 'k1', title: 'T', body: 'B', data: { a: 1 }, scope: { kind: 'insurer', slug: 'aviva' } } });
  });

  it('a gap answer becomes a procedure (one step per line) or a fact in the right area', () => {
    const p = gapAnswerItem({ kind: 'insurer_process', question: 'How do I get a handling ref?', scope: { kind: 'insurer', slug: 'aviva' } }, '1. Call the team\n- Quote the claim number');
    expect(p.kind).toBe('procedure');
    expect(p.data).toMatchObject({ steps: ['Call the team', 'Quote the claim number'], forWhom: 'insurer', insurerSlug: 'aviva' });
    const f = gapAnswerItem({ kind: 'quantum_point', question: 'Q', scope: { kind: 'global' } }, 'An answer', 'My title');
    expect(f).toMatchObject({ kind: 'fact', area: 'quantum', title: 'My title' });
  });

  it('settings rows read the defaults, within the server ranges', () => {
    for (const n of NUMBER_SETTINGS) {
      const v = readNumberSetting(DEFAULT_KNOWLEDGE_SETTINGS, n);
      expect(Number.isFinite(v), n.key).toBe(true);
      if (n.min !== undefined) expect(v, n.key).toBeGreaterThanOrEqual(n.min);
      if (n.max !== undefined) expect(v, n.key).toBeLessThanOrEqual(n.max);
    }
  });

  it('exports the audit as formula-safe CSV', () => {
    const c: KnowledgeChange = { id: '1', at: '2026-10-01T00:00:00.000Z', actor: 'owner', action: 'knowledge.item.retire', itemId: 'k1', itemKey: 'contact:aviva', gapId: null, packVersion: null, before: null, after: null, reason: '=HYPERLINK("x")', ruleIds: ['KN-03'], runId: null, jobId: null, needsYouId: null };
    const csv = changesCsv([c]);
    expect(csv.split('\r\n')[0]).toBe('at,actor,action,itemKey,itemId,gapId,packVersion,reason,ruleIds,runId,jobId,needsYouId');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"KN-03"');
  });
});
