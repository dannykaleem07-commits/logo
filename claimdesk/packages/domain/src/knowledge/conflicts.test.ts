// owned by knowledge-learners
import { describe, expect, it } from 'vitest';
import { detectConflicts, profileNoteConflicts, type ConflictContext } from './conflicts.js';
import { contentShaOf, itemKeyFor } from './keys.js';
import type { InsurerProfileData, KnowledgeProposal } from './types.js';

const empty: ConflictContext = { active: [], directory: null, redLines: [], kb: [] };

const contact = (over: Partial<KnowledgeProposal['data']> = {}): KnowledgeProposal => ({
  kind: 'contact',
  area: 'contact',
  title: 'Jane Example — example-insurer',
  body: 'Learned from email signatures.',
  data: { insurerSlug: 'example-insurer', team: null, name: 'Jane Example', role: null, phone: '01614960123', phoneKind: 'direct', email: 'jane.example@example-insurer.test', ivr: null, hours: null, observations: 2, independentThreads: 2, lastSeenAt: '2026-10-01T00:00:00.000Z', ...over } as never,
  tags: [],
  scope: { kind: 'insurer', slug: 'example-insurer' },
  business: ['ccguk'],
  useLimit: 'internal',
  origin: 'observed',
  confidence: 0.9,
  supportN: 2,
  provenance: [],
  createdBy: 'agent:supervisor',
});

const fact = (statement: string, over: Partial<KnowledgeProposal> = {}): KnowledgeProposal => ({
  kind: 'fact',
  area: 'procedural',
  title: statement.slice(0, 60),
  body: statement,
  data: { statement, figure: null, asOf: null, benchmarkOnly: false, kbCheck: null, stat: null },
  tags: [],
  scope: { kind: 'global' },
  business: ['ccguk'],
  useLimit: 'internal',
  origin: 'observed',
  confidence: 0.9,
  supportN: 2,
  provenance: [],
  createdBy: 'agent:supervisor',
  ...over,
});

const dir = { slug: 'example-insurer', phones: ['0161 496 0000'], emails: ['claims@example-insurer.test'] };

describe('detectConflicts', () => {
  it('a direct line and an own-domain email do not conflict with the directory', () => {
    expect(detectConflicts(contact(), { ...empty, directory: dir })).toEqual([]);
  });
  it('directory_mismatch for a different switchboard, shared inbox or email domain', () => {
    expect(detectConflicts(contact({ phone: '01614969999', phoneKind: 'switchboard' } as never), { ...empty, directory: dir })[0]).toMatchObject({ kind: 'directory_mismatch', leftRef: 'new', rightRef: 'dir:example-insurer' });
    expect(detectConflicts(contact({ email: 'tpclaims@example-insurer.test' } as never), { ...empty, directory: dir })[0]?.kind).toBe('directory_mismatch');
    expect(detectConflicts(contact({ email: 'jane@elsewhere.test' } as never), { ...empty, directory: dir })[0]?.detail).toMatch(/elsewhere\.test/);
  });
  it('duplicate only against the owner’s, a verified or another origin’s version', () => {
    const p = contact({ role: 'Team Leader' } as never);
    const base = { id: 'old', itemKey: itemKeyFor(p), kind: 'contact' as const, area: 'contact' as const, title: 'old', body: '', data: p.data, scope: p.scope, contentSha256: 'different' };
    expect(detectConflicts(p, { ...empty, active: [{ ...base, verification: 'unverified', origin: 'observed' }] })).toEqual([]);
    expect(detectConflicts(p, { ...empty, active: [{ ...base, verification: 'owner_confirmed', origin: 'observed' }] })[0]).toMatchObject({ kind: 'duplicate', rightRef: 'ki:old' });
    expect(detectConflicts(p, { ...empty, active: [{ ...base, contentSha256: contentShaOf(p), verification: 'owner_confirmed', origin: 'owner' }] })).toEqual([]);
  });
  it('red lines, FOS for CCGUK and KB contradictions', () => {
    expect(detectConflicts(fact('Always offer a discount on hire to speed payment.'), { ...empty, redLines: [{ id: 'playbook@1#rl1', pattern: 'discount\\s+on\\s+hire', scope: null }] })[0]).toMatchObject({ kind: 'red_line', rightRef: 'pack:playbook@1#rl1' });
    expect(detectConflicts(fact('Escalate to the Financial Ombudsman if the insurer delays.'), empty).map((f) => f.rightRef)).toContain('perimeter:FORUM_NOT_OPEN');
    const kb = [{ id: 'k1', citation: 'Example Act 2020 s.1', text: 'Under the Example Act 2020 s.1 a notice must be served within 14 days of the incident.', tags: ['notice'] }];
    expect(detectConflicts(fact('Under the Example Act 2020 s.1 a notice must be served within 21 days of the incident.'), { ...empty, kb })[0]).toMatchObject({ kind: 'kb_contradiction', rightRef: 'kb:k1' });
    expect(detectConflicts(fact('Under the Example Act 2020 s.1 a notice must be served within 14 days of the incident.'), { ...empty, kb })).toEqual([]);
  });
});

describe('stats vs notes', () => {
  const profile: InsurerProfileData = { insurerSlug: 'example-insurer', window: '12m', minN: 3, computedAt: '2026-10-10T00:00:00.000Z', n: { claims: 10, settled: 10 }, daysToPay: { medianWorkingDays: 20, p90WorkingDays: 35, n: 10 }, heads: { hire: { paidOfClaimedPct: { median: 85, p25: 80, p75: 90, n: 10 }, firstOfferOfClaimedPct: null, reductionRatePct: null, n: 10 } }, objections: [], docsRequested: [], gta: { subscriberClaims: 0, hirePaidAtGtaRatePct: null, firstNotificationDisputePct: null }, responseHours: { median: null, n: 0 }, chasersBeforePay: { median: null, n: 0 } };
  const note = fact('Example Insurer usually pays hire in full: about 100% paid.', { scope: { kind: 'insurer', slug: 'example-insurer' }, data: { statement: 'pays hire in full: 100% paid', figure: { value: 100, unit: '%' }, asOf: null, benchmarkOnly: false, kbCheck: null, stat: null } });
  it('note → profile on proposal; profile → confirmed note nightly', () => {
    const active = [{ id: 'prof', itemKey: 'profile:example-insurer:12m', kind: 'insurer_profile' as const, area: 'statistics' as const, title: 'p', body: '', data: profile, scope: note.scope, verification: 'unverified' as const, origin: 'computed' as const, contentSha256: 'x' }];
    expect(detectConflicts(note, { ...empty, active })[0]).toMatchObject({ kind: 'stats_vs_note', rightRef: 'ki:prof' });
    const noteItem = { id: 'n1', itemKey: 'fact:x', kind: 'fact' as const, area: note.area, title: note.title, body: note.body, data: note.data, scope: note.scope, verification: 'owner_confirmed' as const, origin: 'owner' as const, contentSha256: 'y' };
    expect(profileNoteConflicts('ki:prof', profile, [noteItem])).toEqual([expect.objectContaining({ kind: 'stats_vs_note', leftRef: 'ki:n1', rightRef: 'ki:prof' })]);
    expect(profileNoteConflicts('ki:prof', profile, [{ ...noteItem, verification: 'unverified' }])).toEqual([]);
  });
});
