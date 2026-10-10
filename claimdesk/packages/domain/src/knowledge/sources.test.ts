import { describe, expect, it } from 'vitest';
import { DEFAULT_KNOWLEDGE_SETTINGS, type KnowledgeSettings, type SourcePolicy } from './types.js';
import { clampOwnerPolicy, effectivePolicyKind, fetchAllowed, policyFor, SOURCE_POLICIES, sourceHost } from './sources.js';

/** The KB test's PRIMARY_HOSTS (packages/kb/src/load.test.ts): every one must be covered by the allow-list (§7.2). */
const PRIMARY_HOSTS = [
  /(^|\.)legislation\.gov\.uk$/, /(^|\.)caselaw\.nationalarchives\.gov\.uk$/, /(^|\.)bailii\.org$/, /(^|\.)justice\.gov\.uk$/, /(^|\.)handbook\.fca\.org\.uk$/,
  /(^|\.)fca\.org\.uk$/, /(^|\.)gtacredithire\.com$/, /(^|\.)financial-ombudsman\.org\.uk$/, /(^|\.)gov\.uk$/, /(^|\.)abi\.org\.uk$/, /(^|\.)ico\.org\.uk$/,
  /(^|\.)mib\.org\.uk$/, /(^|\.)askmid\.com$/, /(^|\.)met\.police\.uk$/, /(^|\.)tfl\.gov\.uk$/,
];

const S = (patch: Partial<KnowledgeSettings> = {}): KnowledgeSettings => ({ ...DEFAULT_KNOWLEDGE_SETTINGS, ...patch });

describe('SOURCE_POLICIES (§7.2)', () => {
  it('covers every KB primary host', () => {
    for (const re of PRIMARY_HOSTS) expect(SOURCE_POLICIES.some((s) => re.test(s.domain)), String(re)).toBe(true);
  });
  it('has one entry per domain, sane limits and quote caps', () => {
    expect(new Set(SOURCE_POLICIES.map((s) => s.domain)).size).toBe(SOURCE_POLICIES.length);
    for (const s of SOURCE_POLICIES) {
      expect(s.maxQuoteWords).toBeLessThanOrEqual(60);
      if (s.policy !== 'deny') expect(s.perMinute).toBeGreaterThan(0);
    }
  });
  it('denies BAILII and askMID, keeps FCL link-only and Thatcham figures unextracted (KR-14)', () => {
    expect(policyFor('https://www.bailii.org/ew/cases/EWCA/Civ/2020/1.html', [])?.policy).toBe('deny');
    expect(policyFor('https://bailii.org/x', [])?.policy).toBe('deny');
    expect(policyFor('https://www.askmid.com/', [])?.policy).toBe('deny');
    expect(policyFor('https://caselaw.nationalarchives.gov.uk/ewca/civ/2024/1', [])?.policy).toBe('link_only');
    expect(policyFor('https://www.thatcham.org/research', [])?.extractAllowed).toBe(false);
    expect(policyFor('https://www.gtacredithire.com/rates', [])?.tags).toContain('benchmark_only');
  });
});

describe('policyFor', () => {
  it('matches the exact host, www-insensitively, and not other subdomains', () => {
    expect(policyFor('https://legislation.gov.uk/ukpga/1988/52/section/148', [])?.domain).toBe('www.legislation.gov.uk');
    expect(policyFor('https://www.gov.uk/government/publications/x', [])?.policy).toBe('api');
    expect(policyFor('https://evil.gov.uk.example.com/', [])).toBeUndefined();
    expect(policyFor('https://assets.publishing.service.gov.uk/x.pdf', [])).toBeUndefined();
    expect(policyFor('https://totalcarcheck.co.uk/', [])?.policy).toBe('deny');
  });
  it('an owner row cannot loosen a built-in entry; listed wildcard subdomains match', () => {
    const extra: SourcePolicy[] = [
      { ...SOURCE_POLICIES[0]!, domain: 'www.bailii.org', policy: 'code_fetch' },
      { ...SOURCE_POLICIES[0]!, domain: '*.insurer.example', policy: 'code_fetch', search: null },
    ];
    expect(policyFor('https://www.bailii.org/', extra)?.policy).toBe('deny');
    expect(policyFor('https://claims.insurer.example/help', extra)?.domain).toBe('*.insurer.example');
    expect(sourceHost('not a url at all')).toBeNull();
  });
  it('clamps owner policies to code_fetch', () => {
    expect(clampOwnerPolicy('api')).toBe('code_fetch');
    expect(clampOwnerPolicy('agent_fetch')).toBe('code_fetch');
    expect(clampOwnerPolicy('deny')).toBe('deny');
  });
});

describe('fetchAllowed', () => {
  it('allows official https sources and refuses http, unknown hosts and denied hosts', () => {
    expect(fetchAllowed('https://www.legislation.gov.uk/ukpga/1988/52/data.xml', 'code', [], S()).ok).toBe(true);
    expect(fetchAllowed('http://www.legislation.gov.uk/ukpga/1988/52', 'code', [], S()).ok).toBe(false);
    expect(fetchAllowed('https://example.com/', 'code', [], S()).reason).toMatch(/allow-list/);
    expect(fetchAllowed('https://www.bailii.org/x', 'code', [], S()).ok).toBe(false);
    expect(fetchAllowed('https://www.askmid.com/', 'code', [], S()).ok).toBe(false);
  });
  it('refuses FCL until the licence is recorded', () => {
    const url = 'https://caselaw.nationalarchives.gov.uk/ewca/civ/2024/1/data.xml';
    expect(fetchAllowed(url, 'code', [], S()).ok).toBe(false);
    const licensed = S({ fclTransactionalLicence: { recorded: true, reference: 'FCL-TEST', at: '2026-10-01T00:00:00Z', by: 'owner' } });
    expect(fetchAllowed(url, 'code', [], licensed).ok).toBe(true);
    expect(effectivePolicyKind(policyFor(url, [])!, licensed)).toBe('api');
  });
  it('honours the kill switch, the fetch switch and (for agents) the web switch', () => {
    const url = 'https://www.gov.uk/check-mot-history';
    expect(fetchAllowed(url, 'code', [], S({ learningEnabled: false })).reason).toMatch(/paused/);
    expect(fetchAllowed(url, 'code', [], S({ sourceFetchEnabled: false })).ok).toBe(false);
    expect(fetchAllowed(url, 'agent', [], S()).ok).toBe(false);
    expect(fetchAllowed(url, 'agent', [], S({ webResearchEnabled: true })).ok).toBe(true);
  });
});
