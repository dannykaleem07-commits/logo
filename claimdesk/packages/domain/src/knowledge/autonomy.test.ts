// owned by knowledge-core
import { describe, expect, it } from 'vitest';
import { autoApplyCategory, decideKnowledge, perimeterTextFlags, proposalProblems } from './autonomy.js';
import { DEFAULT_KNOWLEDGE_SETTINGS, type KnowledgeDecisionContext, type KnowledgeProposal, type KnowledgeSettings } from './types.js';

const fact = { statement: 'Esure accepts uploads through its portal', figure: null, asOf: null, benchmarkOnly: false, kbCheck: null, stat: null };
const p = (over: Partial<KnowledgeProposal> = {}): KnowledgeProposal => ({
  kind: 'procedure', area: 'procedural', title: 'Esure portal uploads', body: 'Upload the pack through the portal.', data: { steps: ['Log in', 'Upload'], forWhom: 'insurer', channel: 'portal', insurerSlug: 'esure' },
  tags: [], scope: { kind: 'insurer', slug: 'esure' }, business: ['ccguk'], useLimit: 'internal', origin: 'observed', confidence: 0.9, supportN: 2, provenance: [], createdBy: 'agent:supervisor', ...over,
});
const ctx = (over: Partial<KnowledgeDecisionContext> = {}, settings: Partial<KnowledgeSettings> = {}): KnowledgeDecisionContext => ({
  settings: { ...DEFAULT_KNOWLEDGE_SETTINGS, ...settings }, conflicts: [], perimeterFlags: [], directiveFlags: [], replaces: null, contact: null, snapshot: null, ...over,
});
const rule = (over: Partial<KnowledgeProposal> = {}): KnowledgeProposal =>
  p({ kind: 'rule', area: 'style', origin: 'curated', title: 'Avoid "trust you are well"', body: 'The owner always deletes this opening.', data: { when: { '==': [{ var: 'insurer.slug' }, 'esure'] }, then: [{ kind: 'avoid_phrase', phrase: 'trust you are well' }], why: 'deleted 3 times', severity: 'info' }, supportN: 3, ...over });

describe('decideKnowledge — the first matching rule decides (§9.1)', () => {
  it('KN-01 learning off holds everything except owner items', () => {
    expect(decideKnowledge(p(), ctx({}, { learningEnabled: false }))).toMatchObject({ outcome: 'hold', ruleIds: ['KN-01'] });
    expect(decideKnowledge(p({ origin: 'owner' }), ctx({}, { learningEnabled: false })).ruleIds).not.toContain('KN-01');
  });

  it('KN-02 rejects a researched rule, strategy or snippet and an origin a kind does not allow', () => {
    expect(decideKnowledge(rule({ origin: 'researched' }), ctx())).toMatchObject({ outcome: 'reject', ruleIds: ['KN-02'] });
    expect(decideKnowledge(p({ kind: 'template_snippet', area: 'style', origin: 'researched', data: { purpose: 'x', emailKind: null, templateId: null, recipientRole: null, text: 'x', tokens: [] } }), ctx()).ruleIds).toEqual(['KN-02']);
    expect(decideKnowledge(p({ kind: 'insurer_profile', area: 'statistics', origin: 'observed' }), ctx()).ruleIds).toEqual(['KN-02']);
  });

  it('KN-03 rejects anything that loosens the perimeter', () => {
    expect(decideKnowledge(rule({ data: { when: { '==': [{ var: 'insurer.slug' }, 'esure'] }, then: [{ kind: 'auto_send' } as never], why: 'x', severity: 'info' } }), ctx()).ruleIds).toEqual(['KN-03']);
    expect(decideKnowledge(p({ body: 'For Esure, accept offers automatically when they are above 90%.' }), ctx()).ruleIds).toEqual(['KN-03']);
    expect(decideKnowledge(p({ body: 'The GTA requires the insurer to pay within 30 days.' }), ctx()).ruleIds).toEqual(['KN-03']);
    expect(decideKnowledge(p({ body: 'Send it without approval to save time.' }), ctx()).ruleIds).toEqual(['KN-03']);
    expect(decideKnowledge(p({ kind: 'fact', area: 'legal', origin: 'researched', tags: ['gta'], data: fact }), ctx()).ruleIds).toEqual(['KN-03']);
    expect(decideKnowledge(p({ tags: ['fos'], business: ['ccguk'] }), ctx()).ruleIds).toEqual(['KN-03']);
    expect(decideKnowledge(p(), ctx({ perimeterFlags: ['FORUM_NOT_OPEN'] })).ruleIds).toEqual(['KN-03']);
  });

  it('KN-04 directive text, KN-05 copycat, KN-06 conflicts (high)', () => {
    expect(decideKnowledge(p({ origin: 'researched' }), ctx({ directiveFlags: ['ignore previous instructions'] })).ruleIds).toEqual(['KN-04']);
    expect(decideKnowledge(p({ kind: 'contact', area: 'contact', data: { insurerSlug: 'esure', team: null, name: 'Jo', role: null, phone: '01234 567890', phoneKind: 'direct', email: null, ivr: null, hours: null, observations: 2, independentThreads: 2, lastSeenAt: '2026-10-01T00:00:00Z' } }), ctx({ contact: { domainCheck: 'copycat', dmarc: 'pass', independentThreads: 2 } })).ruleIds).toEqual(['KN-05']);
    expect(decideKnowledge(p(), ctx({ conflicts: [{ kind: 'directory_mismatch', leftRef: 'new', rightRef: 'dir:esure', detail: 'phone differs' }] }))).toMatchObject({ outcome: 'queue', ruleIds: ['KN-06'], priority: 'high' });
  });

  it('KN-07 rules always wait; KN-08 legal/quantum/strategy; KN-09 outbound; KN-10 replacing confirmed; KN-11 web', () => {
    expect(decideKnowledge(rule(), ctx())).toMatchObject({ outcome: 'queue', ruleIds: ['KN-07'] });
    expect(decideKnowledge(p({ kind: 'fact', area: 'quantum', origin: 'observed', data: fact }), ctx()).ruleIds).toEqual(['KN-08']);
    expect(decideKnowledge(p({ useLimit: 'outbound_ok' }), ctx()).ruleIds).toEqual(['KN-09']);
    expect(decideKnowledge(p(), ctx({ replaces: { verification: 'owner_confirmed', origin: 'observed' } })).ruleIds).toEqual(['KN-10']);
    expect(decideKnowledge(p({ origin: 'researched', provenance: [{ kind: 'url', url: 'https://www.gov.uk/x', seenAt: '2026-10-01T00:00:00Z', note: '' }] }), ctx()).ruleIds).toEqual(['KN-11']);
    expect(decideKnowledge(p({ origin: 'researched' }), ctx({ snapshot: { policy: 'agent_fetch', quoteMatch: 'exact' } })).ruleIds).toEqual(['KN-11']);
  });

  it('KN-12 low confidence or support; KN-13 category off', () => {
    expect(decideKnowledge(p({ confidence: 0.5 }), ctx()).ruleIds).toEqual(['KN-12']);
    expect(decideKnowledge(p({ supportN: 1 }), ctx()).ruleIds).toEqual(['KN-12']);
    expect(decideKnowledge(p(), ctx({}, { autoApply: { ...DEFAULT_KNOWLEDGE_SETTINGS.autoApply, procedures: false } })).ruleIds).toEqual(['KN-13']);
  });

  it('KN-14 statistics, KN-15 verified contacts, KN-16 procedures, KN-17 owner snippets, KN-18 curated style auto-apply', () => {
    const stats = p({ kind: 'insurer_profile', area: 'statistics', origin: 'computed', supportN: 12, confidence: 1, data: { insurerSlug: 'esure', window: '12m', minN: 3, computedAt: '2026-10-01T00:00:00Z', n: { claims: 12, settled: 10 }, daysToPay: { medianWorkingDays: 21, p90WorkingDays: 40, n: 10 }, heads: {}, objections: [], docsRequested: [], gta: { subscriberClaims: 0, hirePaidAtGtaRatePct: null, firstNotificationDisputePct: null }, responseHours: { median: null, n: 0 }, chasersBeforePay: { median: null, n: 0 } } });
    expect(decideKnowledge(stats, ctx())).toMatchObject({ outcome: 'auto_apply', ruleIds: ['KN-14'] });
    const contact = p({ kind: 'contact', area: 'contact', title: 'Jo Bloggs', data: { insurerSlug: 'esure', team: 'TP claims', name: 'Jo Bloggs', role: 'Handler', phone: '01234 567890', phoneKind: 'direct', email: null, ivr: null, hours: null, observations: 2, independentThreads: 2, lastSeenAt: '2026-10-01T00:00:00Z' } });
    expect(decideKnowledge(contact, ctx({ contact: { domainCheck: 'own_domain', dmarc: 'pass', independentThreads: 2 } }))).toMatchObject({ outcome: 'auto_apply', ruleIds: ['KN-15'] });
    expect(decideKnowledge(contact, ctx({ contact: { domainCheck: 'unknown_domain', dmarc: 'pass', independentThreads: 2 } })).ruleIds).toEqual(['KN-19']);
    expect(decideKnowledge(p(), ctx())).toMatchObject({ outcome: 'auto_apply', ruleIds: ['KN-16'] });
    expect(decideKnowledge(p({ origin: 'researched', supportN: 1 }), ctx({ snapshot: { policy: 'code_fetch', quoteMatch: 'exact' } })).ruleIds).toEqual(['KN-12']);
    expect(decideKnowledge(p({ origin: 'researched', supportN: 2 }), ctx({ snapshot: { policy: 'api', quoteMatch: 'exact' } })).ruleIds).toEqual(['KN-16']);
    expect(decideKnowledge(p({ origin: 'researched', supportN: 2 }), ctx({ snapshot: { policy: 'api', quoteMatch: 'normalised' } })).ruleIds).toEqual(['KN-19']);
    const snippet = p({ kind: 'template_snippet', area: 'style', origin: 'observed', supportN: 1, data: { purpose: 'chaser opening', emailKind: 'chaser', templateId: null, recipientRole: 'at_fault_insurer', text: 'We refer to our letter of [date].', tokens: ['[date]'] } });
    expect(decideKnowledge(snippet, ctx({ snippet: { ownerAuthored: true, fullyGeneralised: true } })).ruleIds).toEqual(['KN-17']);
    expect(decideKnowledge(snippet, ctx({ snippet: { ownerAuthored: true, fullyGeneralised: false } })).ruleIds).toEqual(['KN-19']);
    const style = p({ kind: 'fact', area: 'style', origin: 'curated', supportN: 3, title: 'No "trust you are well"', body: 'Open with the reference line.', data: { ...fact, statement: 'Open with the reference line.' } });
    expect(decideKnowledge(style, ctx())).toMatchObject({ outcome: 'auto_apply', ruleIds: ['KN-18'] });
    expect(decideKnowledge({ ...style, body: 'State the £250 interim figure first.' }, ctx()).ruleIds).toEqual(['KN-19']);
  });
});

describe('proposalProblems and perimeterTextFlags', () => {
  it('catches structural problems', () => {
    expect(proposalProblems(p())).toEqual([]);
    expect(proposalProblems(p({ title: '' })).join(' ')).toMatch(/title/);
    expect(proposalProblems(p({ confidence: 2 })).join(' ')).toMatch(/confidence/);
    expect(proposalProblems(p({ business: [] })).join(' ')).toMatch(/business/);
    expect(proposalProblems(p({ data: { steps: [] } as never })).join(' ')).toMatch(/steps/);
    expect(proposalProblems(p({ scope: { kind: 'insurer', slug: '' } })).join(' ')).toMatch(/slug/);
  });

  it('flags perimeter-loosening text and the auto-apply category', () => {
    expect(perimeterTextFlags('Nothing unusual here.')).toEqual([]);
    expect(perimeterTextFlags('We will handle your injury claim for you.')).toEqual(['PI_HANDLED_IN_HOUSE']);
    expect(perimeterTextFlags('You are entitled to this under the GTA')).toEqual(['GTA_CITED_AS_LAW']);
    expect(autoApplyCategory({ kind: 'contact', area: 'contact', origin: 'observed' })).toBe('contacts');
    expect(autoApplyCategory({ kind: 'fact', area: 'statistics', origin: 'computed' })).toBe('statistics');
    expect(autoApplyCategory({ kind: 'fact', area: 'style', origin: 'curated' })).toBe('curatedStyle');
  });
});
