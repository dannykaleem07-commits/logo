// owned by knowledge-core
import { describe, expect, it } from 'vitest';
import { ADVISORY_EFFECTS, RESTRICTIVE_EFFECTS, effectsAllowed, evalRule, validateLogic, validateRule } from './ruleLogic.js';
import type { JsonLogic, RuleData } from './types.js';

const rule = (over: Partial<RuleData> = {}): RuleData => ({
  when: { and: [{ '==': [{ var: 'insurer.slug' }, 'admiral'] }, { '>=': [{ var: 'days.sincePackSent' }, 10] }] },
  then: [{ kind: 'ask_owner', reason: 'Admiral usually asks for the hire invoice first' }],
  why: 'seen 4 times',
  severity: 'warn',
  ...over,
});

describe('validateRule — closed vocabulary (KR-5)', () => {
  it('accepts a restrictive rule over RULE_FACT_IDS', () => {
    expect(validateRule(rule())).toEqual([]);
  });

  it('refuses unknown operators, unknown facts and effects outside the restrictive/advisory sets', () => {
    expect(validateRule(rule({ when: { regex: ['x', 'y'] } as unknown as JsonLogic })).join(' ')).toMatch(/not allowed/);
    expect(validateRule(rule({ when: { '==': [{ var: 'claim.clientName' }, 'x'] } })).join(' ')).toMatch(/RULE_FACT_IDS/);
    for (const kind of ['send_email', 'approve', 'skip_review', 'set_threshold', 'accept_offer', 'pay']) {
      expect(validateRule(rule({ then: [{ kind } as never] })).join(' ')).toMatch(/not allowed/);
    }
    expect(validateRule(rule({ then: [] })).join(' ')).toMatch(/at least one effect/);
  });

  it('limits depth to 6 and size to 20 nodes', () => {
    let deep: unknown = { var: 'insurer.slug' };
    for (let i = 0; i < 7; i += 1) deep = { '!': [deep] };
    expect(validateLogic(deep).join(' ')).toMatch(/deeper than 6/);
    const wide = { or: Array.from({ length: 12 }, () => ({ '==': [{ var: 'insurer.slug' }, 'x'] })) };
    expect(validateLogic(wide).join(' ')).toMatch(/nodes \(at most 20\)/);
  });

  it('the effect sets are exactly the four restrictive and two advisory kinds', () => {
    expect([...RESTRICTIVE_EFFECTS].sort()).toEqual(['add_check', 'ask_owner', 'avoid_phrase', 'require_document']);
    expect([...ADVISORY_EFFECTS].sort()).toEqual(['prefer_step', 'suggest_followup']);
    expect(effectsAllowed([{ kind: 'prefer_step' }, { kind: 'ask_owner' }])).toBe(true);
    expect(effectsAllowed([{ kind: 'auto_send' }])).toBe(false);
  });
});

describe('evalRule — pure and total', () => {
  it('evaluates comparisons, and/or/!, in and missing', () => {
    const r = rule();
    expect(evalRule(r.when, { 'insurer.slug': 'admiral', 'days.sincePackSent': 12 })).toBe(true);
    expect(evalRule(r.when, { 'insurer.slug': 'admiral', 'days.sincePackSent': 3 })).toBe(false);
    expect(evalRule({ in: ['credit_hire', { var: 'claim.types' }] }, { 'claim.types': ['repair', 'credit_hire'] })).toBe(true);
    expect(evalRule({ in: [{ var: 'last.inboundIntent' }, ['liability_denied', 'request_documents']] }, { 'last.inboundIntent': 'request_documents' })).toBe(true);
    expect(evalRule({ '!': [{ var: 'claim.gtaSubscriber' }] }, { 'claim.gtaSubscriber': false })).toBe(true);
    expect(evalRule({ missing: ['docs.onFile'] }, {})).toBe(true);
    expect(evalRule({ missing: ['docs.onFile'] }, { 'docs.onFile': ['v5c'] })).toBe(false);
  });

  it('never throws: invalid or mismatched input is false', () => {
    expect(evalRule({ '<': [{ var: 'days.sincePackSent' }, 'ten'] }, { 'days.sincePackSent': 3 })).toBe(false);
    expect(evalRule({ bogus: 1 } as unknown as JsonLogic, {})).toBe(false);
    expect(evalRule({ var: 'process.env' } as JsonLogic, { 'process.env': true })).toBe(false);
    expect(evalRule(null as unknown as JsonLogic, {})).toBe(false);
  });
});
