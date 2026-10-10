// owned by knowledge-research
/**
 * Allowed sources (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.2, KR-8, KR-14). Pure.
 *
 * The built-in allow-list comes from the research brief. Every entry is confirmed by the first-run self-test on the
 * owner's PC (§7.4); a domain that fails is disabled until the owner re-enables it. Licences:
 *  - BAILII and askMID are denied to automation (their terms forbid it);
 *  - Find Case Law is link-only until the owner records the free transactional licence (`fclTransactionalLicence`);
 *  - Thatcham figures are never extracted (`extractAllowed: false`); Audatex data is never fetched at all;
 *  - quotes stay at or below `maxQuoteWords` (KB convention 60).
 * Owner-added domains (Sources tab, human only) may have at most policy `code_fetch`; agents can never add a domain.
 * `SourcePolicy` is declared in types.ts (core) because decideKnowledge (KN-11, KN-16) reads its policy kind.
 */
import type { KnowledgeSettings, SourcePolicy, SourcePolicyKind } from './types.js';

/** KB convention: a quote is at most 60 words. */
export const DEFAULT_MAX_QUOTE_WORDS = 60;

const p = (domain: string, policy: SourcePolicyKind, rest: Partial<SourcePolicy> & Pick<SourcePolicy, 'access' | 'licence' | 'purpose'>): SourcePolicy => ({
  domain,
  policy,
  extractAllowed: true,
  maxQuoteWords: DEFAULT_MAX_QUOTE_WORDS,
  tags: [],
  perMinute: 6,
  perDay: 60,
  search: null,
  ...rest,
});

/** The built-in allow-list (§7.2). Order is display order. */
export const SOURCE_POLICIES: readonly SourcePolicy[] = [
  p('www.legislation.gov.uk', 'api', { access: '/…/data.xml (CLML), /data.feed (Atom), search feeds', licence: 'OGL', search: 'legislation', perDay: 120, tags: ['legislation', 'statute'], purpose: 'Statutes, statutory instruments and CPR amendment SIs, with point-in-time URLs' }),
  p('www.justice.gov.uk', 'code_fetch', { access: 'HTML pages (CPR parts, practice directions, PD updates)', licence: 'Crown copyright / OGL; short quotes', tags: ['cpr', 'procedure'], purpose: 'Civil Procedure Rules, practice directions and the PD updates page' }),
  p('www.judiciary.uk', 'agent_fetch', { access: 'HTML', licence: 'Link and principle; prefer Find Case Law URIs', tags: ['judiciary'], purpose: 'Civil Justice Council reports and judicial guidance' }),
  p('caselaw.nationalarchives.gov.uk', 'link_only', { access: 'Find Case Law API, Atom, /data.xml (only with the transactional licence)', licence: 'Open Justice Licence; computational analysis needs the free transactional licence; no extract', extractAllowed: false, search: 'fcl', tags: ['case_law'], purpose: 'Judgments (link only until the owner records the licence)' }),
  p('www.bailii.org', 'deny', { access: '–', licence: 'Terms forbid automated access; a person may open links', extractAllowed: false, perMinute: 0, perDay: 0, tags: ['case_law'], purpose: 'Link only, opened by a person' }),
  p('www.financial-ombudsman.org.uk', 'code_fetch', { access: 'HTML (single pages)', licence: 'No clear reuse licence; short quotes', tags: ['fos', 'fixmyfile'], purpose: 'FOS decisions and guidance (Fixmyfile only; never to an at-fault insurer)' }),
  p('handbook.fca.org.uk', 'api', { access: 'FCA Handbook API (key fca_handbook_api_key) or HTML', licence: 'Handbook terms; short quotes', search: 'fca_handbook', tags: ['fca'], purpose: 'FCA Handbook rules (no historic versions: diffed by snapshot)' }),
  p('www.fca.org.uk', 'code_fetch', { access: 'HTML', licence: 'Short quotes', tags: ['fca'], purpose: 'FCA guidance and register pages' }),
  p('www.gov.uk', 'api', { access: 'Content API /api/content/<path>, Search API /api/search.json', licence: 'OGL', search: 'gov_uk', perDay: 120, tags: ['gov_uk'], purpose: 'Government guidance (DVLA, courts, HMCTS fees); the main search route' }),
  p('ico.org.uk', 'code_fetch', { access: 'HTML', licence: 'Mostly OGL', tags: ['data_protection'], purpose: 'DSAR and data-protection guidance' }),
  p('www.abi.org.uk', 'code_fetch', { access: 'HTML/PDF (public pages)', licence: 'Short quotes', tags: ['abi'], purpose: 'ABI codes, including the salvage code' }),
  p('www.gtacredithire.com', 'code_fetch', { access: 'HTML/PDF (public pages only)', licence: 'Public pages; benchmark only', tags: ['gta', 'benchmark_only'], purpose: 'GTA rates and protocol — an industry benchmark, never law (KR-3)' }),
  p('www.mib.org.uk', 'code_fetch', { access: 'HTML/PDF', licence: 'Short quotes', tags: ['mib'], purpose: 'Motor Insurers’ Bureau processes' }),
  p('www.askmid.com', 'deny', { access: '–', licence: 'Terms forbid regular or organisational use', extractAllowed: false, perMinute: 0, perDay: 0, tags: ['mib'], purpose: 'Human only' }),
  p('www.thatcham.org', 'code_fetch', { access: 'HTML (public research pages)', licence: 'No extract of figures (never labour or parts times)', extractAllowed: false, tags: ['engineering'], purpose: 'Public research pages only' }),
  p('tfl.gov.uk', 'code_fetch', { access: 'HTML', licence: 'TfL terms; short quotes', tags: ['pcn'], purpose: 'PCN and congestion-charge processes' }),
  p('www.met.police.uk', 'code_fetch', { access: 'HTML', licence: 'Crown copyright; short quotes', tags: ['police'], purpose: 'Police report and collision-record processes' }),
];

/** Hosts that are always denied whatever is listed elsewhere (advert sites, vehicle-check scrapers). */
export const DENIED_HOSTS: readonly string[] = ['totalcarcheck.co.uk', 'www.totalcarcheck.co.uk', 'bailii.org', 'askmid.com', 'audatex.co.uk', 'audatex.com'];

const FCL_DOMAIN = 'caselaw.nationalarchives.gov.uk';

/** Lower-case host without a trailing dot, or null when `url` is not an http(s) URL. Bare hosts are accepted. */
export function sourceHost(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

const bare = (host: string): string => host.replace(/^www\./, '');

/** Does `host` match a policy domain? Exact (www-insensitive), or a subdomain of a `*.`-listed domain. */
function hostMatches(host: string, domain: string): boolean {
  const d = domain.toLowerCase();
  if (d.startsWith('*.')) return host === d.slice(2) || host.endsWith(d.slice(1));
  return bare(host) === bare(d);
}

const isDeniedHost = (host: string): boolean => DENIED_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));

/**
 * The policy for `url`: exact host or listed subdomain. A built-in deny wins over anything (BAILII, askMID and their
 * subdomains); otherwise a built-in entry wins over an extra (owner / insurer-directory) entry for the same host, so
 * an owner row can never loosen a built-in licence.
 */
export function policyFor(url: string, extra: readonly SourcePolicy[]): SourcePolicy | undefined {
  const host = sourceHost(url);
  if (!host) return undefined;
  const builtinDeny = SOURCE_POLICIES.find((s) => s.policy === 'deny' && (hostMatches(host, s.domain) || host.endsWith(`.${bare(s.domain)}`)));
  if (builtinDeny) return builtinDeny;
  if (isDeniedHost(host)) return { domain: host, policy: 'deny', access: '–', licence: 'Not allowed for automation', extractAllowed: false, maxQuoteWords: 0, tags: [], perMinute: 0, perDay: 0, search: null, purpose: 'Denied' };
  return SOURCE_POLICIES.find((s) => hostMatches(host, s.domain)) ?? extra.find((s) => hostMatches(host, s.domain));
}

/** The policy an owner-added domain may have: at most `code_fetch` (never api/agent_fetch, §7.2). */
export function clampOwnerPolicy(policy: SourcePolicyKind): SourcePolicyKind {
  return policy === 'deny' || policy === 'link_only' ? policy : 'code_fetch';
}

/**
 * May this URL be fetched? `code` = ClaimDesk's own fetcher (source_fetch, watch, self-test); `agent` = a model's
 * WebFetch in `knowledge.research_web` (owner-enabled only). Pure: rate limits and per-source enabled flags are the
 * API's job. https only; deny → refuse; link_only → refuse (Find Case Law only once the licence is recorded).
 */
export function fetchAllowed(url: string, mode: 'code' | 'agent', extra: readonly SourcePolicy[], settings: KnowledgeSettings): { ok: boolean; reason: string } {
  const host = sourceHost(url);
  if (!host) return { ok: false, reason: 'not a web address' };
  if (!/^https:\/\//i.test(url.trim())) return { ok: false, reason: 'only https addresses are fetched' };
  if (!settings.learningEnabled) return { ok: false, reason: 'learning is paused' };
  if (!settings.sourceFetchEnabled) return { ok: false, reason: 'source fetching is switched off (Knowledge ▸ Safety)' };
  if (mode === 'agent' && !settings.webResearchEnabled) return { ok: false, reason: 'web research is switched off (Knowledge ▸ Safety)' };
  const policy = policyFor(url, extra);
  if (!policy) return { ok: false, reason: `${host} is not on the allow-list` };
  switch (policy.policy) {
    case 'deny':
      return { ok: false, reason: `${host} does not allow automated access (a person may open the link)` };
    case 'link_only':
      if (bare(policy.domain) === bare(FCL_DOMAIN) && settings.fclTransactionalLicence.recorded) return { ok: true, reason: 'Find Case Law under the recorded transactional licence' };
      return { ok: false, reason: `${host} is link-only: open it yourself${bare(policy.domain) === bare(FCL_DOMAIN) ? ' (or record the Find Case Law transactional licence in Knowledge ▸ Sources)' : ''}` };
    default:
      return { ok: true, reason: `${policy.policy} (${policy.licence})` };
  }
}

/** Effective policy kind after the FCL licence (link_only → api once recorded). */
export function effectivePolicyKind(policy: SourcePolicy, settings: Pick<KnowledgeSettings, 'fclTransactionalLicence'>): SourcePolicyKind {
  if (policy.policy === 'link_only' && bare(policy.domain) === bare(FCL_DOMAIN) && settings.fclTransactionalLicence.recorded) return 'api';
  return policy.policy;
}
