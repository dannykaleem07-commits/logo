// owned by knowledge-use
import { describe, expect, it } from 'vitest';
import type { EvalCase, RuleData } from './types.js';
import { describeReplay, replayRules, ruleHardViolations } from './replay.js';

const mk = (i: number, over: { codes?: string[]; days: number; paid?: number; slug?: string; docs?: string[] }): EvalCase => ({
  id: `case-${String(i).padStart(3, '0')}`,
  claimId: `claim-${i}`,
  decisionPoint: 'after_pack_sent',
  at: '2026-01-01T00:00:00Z',
  facts: { 'insurer.slug': over.slug ?? 'example-insurer', 'docs.onFile': over.docs ?? [] },
  historic: { actionCodes: over.codes ?? [], steps: [] },
  outcome: { workingDaysToPay: over.days, paidOfClaimedPct: over.paid ?? 100 },
  insurerSlug: over.slug ?? 'example-insurer',
  outcomeQuartile: null,
});

const preferChaser: RuleData = { when: { '==': [{ var: 'insurer.slug' }, 'example-insurer'] }, then: [{ kind: 'prefer_step', actionCode: 'CHASER_7', note: 'chase at day 7' }], why: 'faster', severity: 'info' };

describe('replayRules (§12.1)', () => {
  it('is inconclusive below minCases', () => {
    const cases = [mk(1, { codes: ['CHASER_7'], days: 10 }), mk(2, { days: 20 })];
    const r = replayRules(cases, [{ itemId: 'r1', data: preferChaser }], { tolerancePct: 5, minCases: 10 });
    expect(r.verdict).toBe('inconclusive');
    expect(r.casesAffected).toBe(2);
    expect(describeReplay(r, { minCases: 10 })).toMatch(/inconclusive/);
  });

  it('is no_worse when paths that followed the rule were faster, worse when slower', () => {
    const good = [...Array.from({ length: 6 }, (_, i) => mk(i, { codes: ['CHASER_7'], days: 10 })), ...Array.from({ length: 6 }, (_, i) => mk(10 + i, { days: 20 }))];
    const r = replayRules(good, [{ itemId: 'r1', data: preferChaser }], { tolerancePct: 5, minCases: 10 });
    expect(r.verdict).toBe('no_worse');
    expect(r.consistent).toEqual({ n: 6, medianWorkingDaysToPay: 10, medianPaidOfClaimedPct: 100 });
    expect(r.perRule[0]).toMatchObject({ itemId: 'r1', affected: 12, deltaDaysMedian: -10 });
    const bad = [...Array.from({ length: 6 }, (_, i) => mk(i, { codes: ['CHASER_7'], days: 30 })), ...Array.from({ length: 6 }, (_, i) => mk(10 + i, { days: 20 }))];
    expect(replayRules(bad, [{ itemId: 'r1', data: preferChaser }], { tolerancePct: 5, minCases: 10 }).verdict).toBe('worse');
  });

  it('only counts cases where the rule fires and changes or gates the path', () => {
    const other = Array.from({ length: 12 }, (_, i) => mk(i, { slug: 'other', days: 5 }));
    expect(replayRules(other, [{ itemId: 'r1', data: preferChaser }], { tolerancePct: 5, minCases: 10 }).casesAffected).toBe(0);
    const gate: RuleData = { when: { '==': [1, 1] }, then: [{ kind: 'require_document', doc: 'hire_agreement', beforeStep: 'SEND_PAYMENT_PACK' }], why: 'x', severity: 'warn' };
    const cases = [mk(1, { codes: ['SEND_PAYMENT_PACK'], docs: ['hire_agreement'], days: 5 }), mk(2, { codes: ['SEND_PAYMENT_PACK'], days: 9 }), mk(3, { days: 1 })];
    const r = replayRules(cases, [{ itemId: 'g', data: gate }], { tolerancePct: 5, minCases: 1 });
    expect(r.casesAffected).toBe(2);
    expect(r.consistent.n).toBe(1);
    expect(r.inconsistent.n).toBe(1);
    expect(r.verdict).toBe('no_worse');
  });

  it('hard checks: an effect touching an offer or always-ask step (other than ask_owner) makes it worse', () => {
    const offer: RuleData = { when: { '==': [1, 1] }, then: [{ kind: 'prefer_step', actionCode: 'PART36_OFFER', note: 'x' }], why: 'x', severity: 'info' };
    expect(ruleHardViolations('o', offer)).toHaveLength(1);
    const ask: RuleData = { when: { '==': [1, 1] }, then: [{ kind: 'ask_owner', reason: 'offers always ask' }], why: 'x', severity: 'info' };
    expect(ruleHardViolations('a', ask)).toEqual([]);
    const r = replayRules([mk(1, { days: 1 })], [{ itemId: 'o', data: offer }], { tolerancePct: 5, minCases: 10 });
    expect(r.verdict).toBe('worse');
    expect(r.hardViolations[0]).toMatch(/PART36_OFFER/);
  });
});
