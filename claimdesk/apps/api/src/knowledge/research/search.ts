// owned by knowledge-research
/**
 * `source_search` (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.2, §10.2): search an allowed source's own search service —
 * GOV.UK Search API (`/api/search.json`), legislation.gov.uk search feed (Atom) and, only with the owner's recorded
 * licence, Find Case Law's Atom feed. The query passes the egress guard first (KR-7); results are untrusted data
 * (title, url, snippet) and only URLs on allowed sources are returned. Each search counts as a fetch against the
 * domain's per-minute bucket and the day's budget, and robots.txt is honoured.
 */
import { egressGuard, fetchAllowed, htmlToText, policyFor, SOURCE_POLICIES, sourceHost, type ClaimDictionary } from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { londonDay } from '../../agent/core.js';
import { recordKnowledgeChange } from '../changes.js';
import { getKnowledgeSettings } from '../settings.js';
import { claimDictionaryFor } from './dictionary.js';
import { fetchesToday, readBody, robotsCheck, takeToken } from './fetcher.js';
import { FETCH_TIMEOUT_MS, knowledgeFetchOf, knowledgeUserAgent, type KnowledgeFetch } from './net.js';
import { extraPolicies, sourceRowFor } from './sources.js';

export interface SearchResultRow {
  title: string;
  url: string;
  snippet: string;
}
export type SearchOutcome = { ok: true; results: SearchResultRow[] } | { ok: false; code: string; reason: string };

export interface SearchRequest {
  domain: string;
  q: string;
  limit?: number;
  createdBy: string;
  runId?: string | null;
  jobId?: string | null;
  gapId?: string | null;
}

/** The search URL for a source, or null when it has no search service ClaimDesk can use. */
export function searchUrlFor(search: 'gov_uk' | 'legislation' | 'fca_handbook' | 'fcl' | null, q: string, limit: number): string | null {
  const enc = encodeURIComponent(q);
  switch (search) {
    case 'gov_uk':
      return `https://www.gov.uk/api/search.json?q=${enc}&count=${limit}&fields=title,link,description`;
    case 'legislation':
      return `https://www.legislation.gov.uk/search/data.feed?text=${enc}&results-count=${limit}`;
    case 'fcl':
      return `https://caselaw.nationalarchives.gov.uk/atom.xml?query=${enc}&per_page=${limit}`;
    default:
      return null;
  }
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Parse a GOV.UK search.json body. */
export function parseGovUkSearch(body: string): SearchResultRow[] {
  const json = JSON.parse(body) as { results?: Array<{ title?: string; link?: string; description?: string }> };
  return (json.results ?? [])
    .filter((r) => typeof r.link === 'string')
    .map((r) => ({ title: clip(String(r.title ?? ''), 200), url: r.link!.startsWith('http') ? r.link! : `https://www.gov.uk${r.link}`, snippet: clip(String(r.description ?? ''), 300) }));
}

/** Parse an Atom feed (legislation.gov.uk, Find Case Law). */
export function parseAtomSearch(body: string): SearchResultRow[] {
  const out: SearchResultRow[] = [];
  const entryRe = /<entry\b[\s\S]*?<\/entry>/gi;
  for (const m of body.match(entryRe) ?? []) {
    const title = htmlToText((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(m)?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '')).text;
    const links = [...m.matchAll(/<link\b([^>]*)\/?>/gi)].map((l) => l[1] ?? '');
    const alt = links.find((a) => /rel=["']alternate["']/i.test(a) && !/type=["'][^"']*(xml|pdf)/i.test(a)) ?? links.find((a) => !/rel=/i.test(a)) ?? links[0];
    const href = alt ? /href=["']([^"']+)["']/i.exec(alt)?.[1] : undefined;
    const idUrl = /<id>(https?:[^<]+)<\/id>/i.exec(m)?.[1];
    const url = href ?? idUrl;
    if (!url) continue;
    const summary = htmlToText((/<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(m)?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '')).text;
    out.push({ title: clip(title, 200), url: url.trim(), snippet: clip(summary, 300) });
  }
  return out;
}

export async function searchSource(ctx: AppContext, req: SearchRequest, deps: { fetch?: KnowledgeFetch; dict?: ClaimDictionary; signal?: AbortSignal } = {}): Promise<SearchOutcome> {
  const settings = getKnowledgeSettings(ctx);
  const actor: Actor = { userId: req.createdBy, ...(req.runId && req.createdBy.startsWith('agent:') ? { runId: req.runId } : {}) };
  const at = ctx.now();
  const host = sourceHost(req.domain) ?? req.domain;
  const audit = (action: 'knowledge.source.refused' | 'knowledge.source.fetch', after: Record<string, unknown>, reason: string): void => {
    ctx.db.transaction((tx) => recordKnowledgeChange(ctx, tx, actor, at, { action, after: { host, ...after, gapId: req.gapId ?? null }, reason, runId: req.runId ?? null, jobId: req.jobId ?? null }));
  };
  const refuse = (code: string, reason: string, logQuery = true): SearchOutcome => {
    audit('knowledge.source.refused', { code, kind: 'search', ...(logQuery ? { q: req.q.slice(0, 300) } : {}) }, reason);
    return { ok: false, code, reason };
  };
  const dict = deps.dict ?? claimDictionaryFor(ctx);
  const g = egressGuard(req.q, dict);
  if (!g.ok) return refuse('EGRESS_REFUSED', `the search carries personal data or a claim identifier (${g.kinds.join(', ')}); nothing was sent`, false);
  const policy = SOURCE_POLICIES.find((p) => p.domain === host || p.domain === `www.${host}`) ?? policyFor(`https://${host}/`, extraPolicies(ctx));
  if (!policy) return refuse('NOT_ALLOWED', `${host} is not on the allow-list`);
  const limit = Math.max(1, Math.min(req.limit ?? 5, 10));
  const url = searchUrlFor(policy.search, req.q, limit);
  if (!url) return refuse('NO_SEARCH', `${policy.domain} has no search ClaimDesk can use; search www.gov.uk or www.legislation.gov.uk, or fetch a known page`);
  const allowed = fetchAllowed(url, 'code', [], settings);
  if (!allowed.ok) return refuse('NOT_ALLOWED', allowed.reason);
  const row = sourceRowFor(ctx, policy);
  if (row && !row.enabled) return refuse('SOURCE_DISABLED', `${policy.domain} is switched off in Knowledge ▸ Sources`);
  if (fetchesToday(ctx) >= settings.budgets.fetchesPerDay) return refuse('BUDGET_DAY', `today's fetch budget (${settings.budgets.fetchesPerDay}) is used up`);
  const day = londonDay(at);
  if (row && row.fetchDay === day && row.fetchesToday >= Math.min(policy.perDay, row.perDay)) return refuse('BUDGET_DOMAIN_DAY', `${policy.domain} has had its fetches today`);
  if (!takeToken(ctx, policy.domain, Math.min(policy.perMinute, settings.budgets.perDomainPerMinute))) return refuse('RATE_LIMITED', `${policy.domain} is rate-limited; try again shortly`);

  const doFetch = knowledgeFetchOf(ctx, deps.fetch);
  const ua = knowledgeUserAgent(ctx);
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  deps.signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const u = new URL(url);
    const robots = await robotsCheck(ctx, u, row, doFetch, ac.signal, ua);
    if (robots !== 'allow') return refuse(robots === 'disallow' ? 'ROBOTS_DISALLOWED' : 'ROBOTS_UNAVAILABLE', `${u.host}'s robots.txt ${robots === 'disallow' ? 'does not allow its search' : 'could not be read'}`);
    const res = await doFetch(url, { method: 'GET', headers: { 'User-Agent': ua, Accept: policy.search === 'gov_uk' ? 'application/json' : 'application/atom+xml,application/xml' }, redirect: 'manual', signal: ac.signal, credentials: 'omit' });
    ctx.db.transaction((tx) => {
      recordKnowledgeChange(ctx, tx, actor, at, { action: 'knowledge.source.fetch', after: { kind: 'search', domain: policy.domain, status: res.status, q: req.q.slice(0, 300) }, reason: 'source_search', runId: req.runId ?? null, jobId: req.jobId ?? null });
      if (row) ctx.repos.countKnowledgeSourceFetch(tx, row.domain, day, at, res.status);
    });
    if (res.status < 200 || res.status >= 300) return { ok: false, code: 'HTTP_ERROR', reason: `${policy.domain} search answered ${res.status}` };
    const body = await readBody(res);
    if (!body) return { ok: false, code: 'TOO_LARGE', reason: 'the search answer was too large' };
    const text = new TextDecoder().decode(body);
    let rows: SearchResultRow[];
    try {
      rows = policy.search === 'gov_uk' ? parseGovUkSearch(text) : parseAtomSearch(text);
    } catch {
      return { ok: false, code: 'PARSE', reason: `${policy.domain} search answer could not be read` };
    }
    const extra = extraPolicies(ctx);
    // Only results on allowed sources (a person can still open anything else); never a URL carrying PII.
    const results = rows.filter((r) => policyFor(r.url, extra) && egressGuard(r.url, dict).ok).slice(0, limit);
    return { ok: true, results };
  } catch (err) {
    if ((err as { code?: string }).code === 'NETWORK_FORBIDDEN') return { ok: false, code: 'NETWORK', reason: 'this process may not reach the network' };
    return { ok: false, code: ac.signal.aborted ? 'TIMEOUT' : 'NETWORK', reason: ac.signal.aborted ? 'the search took longer than 20 seconds' : `the search failed (${err instanceof Error ? err.message : String(err)})`.slice(0, 300) };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }
}
