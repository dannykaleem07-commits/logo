// owned by knowledge-research
/**
 * The source registry on the owner's PC (docs/SUPREME-KNOWLEDGE-BUILDER.md §7.2): `knowledge_sources` rows for the
 * built-in allow-list (seeded once), the insurers' own domains from the directory (code_fetch, origin
 * `insurer_directory`, never a copycat) and owner-added domains (human only, at most `code_fetch`). A row carries the
 * enabled flag (the self-test disables a failing source until the owner re-enables it), robots.txt cache, self-test
 * result and the day's fetch counter. Agents can never add or enable a domain.
 */
import { clampOwnerPolicy, policyFor, SOURCE_POLICIES, sourceHost, type SourcePolicy, type SourcePolicyKind } from '@ccguk/domain';
import { isCopycat, normaliseDomain } from '@ccguk/kb';
import type { Actor, KnowledgeSourceRecord } from '@ccguk/db';
import type { AppContext } from '../../context.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { assertHuman } from '../../services/humanOnly.js';
import { recordKnowledgeChange } from '../changes.js';

const SEEDED = Symbol.for('claimdesk.knowledge.sourcesSeeded');

/** Hosts the directory lists for an insurer (portal, claims, third-party and complaints addresses). */
export function directoryDomains(ctx: AppContext): { slug: string; domain: string }[] {
  const out: { slug: string; domain: string }[] = [];
  const seen = new Set<string>();
  for (const e of ctx.kb.directory()) {
    const raw = [e.portalUrl, e.claimsEmail, e.thirdPartyEmail, e.complaintsEmail].filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    for (const r of raw) {
      const d = normaliseDomain(r);
      if (!d || !d.includes('.') || seen.has(d)) continue;
      if (isCopycat(d, ctx.kb.directory())) continue;
      const existing = policyFor(`https://${d}/`, []);
      if (existing) continue; // a built-in entry (or a built-in deny) wins
      seen.add(d);
      out.push({ slug: e.id, domain: d });
    }
  }
  return out;
}

/** Seed the built-in and insurer-directory rows (once per process per context; existing rows are kept). */
export function ensureResearchSources(ctx: AppContext, force = false): void {
  const s = ctx.services as unknown as Record<symbol, boolean>;
  if (s[SEEDED] && !force) return;
  const at = ctx.now();
  ctx.db.transaction((tx) => {
    for (const p of SOURCE_POLICIES) {
      ctx.repos.ensureKnowledgeSource(tx, { domain: p.domain, policy: p.policy, access: p.access, licence: p.licence, extractAllowed: p.extractAllowed, maxQuoteWords: p.maxQuoteWords, tags: p.tags, perMinute: p.perMinute, perDay: p.perDay, origin: 'builtin', updatedBy: 'system', at });
    }
    for (const d of directoryDomains(ctx)) {
      ctx.repos.ensureKnowledgeSource(tx, { domain: d.domain, policy: 'code_fetch', access: 'HTML (the insurer’s own public pages)', licence: 'Short quotes', extractAllowed: true, maxQuoteWords: 60, tags: ['insurer', `insurer:${d.slug}`], perMinute: 4, perDay: 30, origin: 'insurer_directory', updatedBy: 'system', at });
    }
  });
  s[SEEDED] = true;
}

const toPolicy = (r: KnowledgeSourceRecord): SourcePolicy => ({
  domain: r.domain,
  policy: r.policy,
  access: r.access,
  licence: r.licence,
  extractAllowed: r.extractAllowed,
  maxQuoteWords: r.maxQuoteWords,
  tags: r.tags,
  perMinute: r.perMinute,
  perDay: r.perDay,
  search: null,
  purpose: r.origin === 'insurer_directory' ? 'The insurer’s own public pages' : 'Added by the owner',
});

/** Non-built-in sources as policies (insurer domains, owner domains), enabled or not. */
export function extraPolicies(ctx: AppContext): SourcePolicy[] {
  ensureResearchSources(ctx);
  return ctx.repos.listKnowledgeSources(ctx.db).filter((r) => r.origin !== 'builtin').map(toPolicy);
}

/** The row behind a policy (built-in rows are seeded on first use). */
export function sourceRowFor(ctx: AppContext, policy: SourcePolicy): KnowledgeSourceRecord | undefined {
  ensureResearchSources(ctx);
  return ctx.repos.getKnowledgeSource(ctx.db, policy.domain);
}

/** The policy as the owner configured it: a row's (lower) per-day cap and its enabled flag. */
export function effectiveSource(ctx: AppContext, url: string): { policy: SourcePolicy; row: KnowledgeSourceRecord | undefined } | undefined {
  const policy = policyFor(url, extraPolicies(ctx));
  if (!policy) return undefined;
  return { policy, row: sourceRowFor(ctx, policy) };
}

export interface AddSourceInput {
  domain: string;
  policy: SourcePolicyKind;
  licence: string;
  note?: string | null;
  extractAllowed?: boolean;
}

/** POST /knowledge/sources — the owner adds a domain (at most code_fetch; never over a built-in or denied host). */
export function addOwnerSource(ctx: AppContext, input: AddSourceInput, actor: Actor): KnowledgeSourceRecord {
  assertHuman(actor, 'add a research source');
  const host = sourceHost(input.domain);
  if (!host || !host.includes('.')) throw badRequest('Give a web domain such as www.example.gov.uk');
  const existing = policyFor(`https://${host}/`, []);
  if (existing) throw conflict('SOURCE_BUILTIN', existing.policy === 'deny' ? `${host} does not allow automated access and cannot be added` : `${host} is already a built-in source (${existing.policy})`);
  if (isCopycat(host, ctx.kb.directory())) throw conflict('SOURCE_COPYCAT', `${host} matches a known copycat domain and cannot be added`);
  if (ctx.repos.getKnowledgeSource(ctx.db, host)) throw conflict('SOURCE_EXISTS', `${host} is already listed`);
  const policy = clampOwnerPolicy(input.policy);
  const at = ctx.now();
  return ctx.db.transaction((tx) => {
    const { source } = ctx.repos.ensureKnowledgeSource(tx, { domain: host, policy, access: 'HTML', licence: input.licence.trim().slice(0, 300) || 'Short quotes', extractAllowed: input.extractAllowed ?? true, maxQuoteWords: 60, tags: ['owner'], perMinute: 4, perDay: 30, origin: 'owner', updatedBy: actor.userId, at });
    recordKnowledgeChange(ctx, tx, actor, at, { action: 'knowledge.source.add', after: { domain: host, policy, licence: source.licence, requested: input.policy }, reason: input.note ?? null });
    return source;
  });
}

/** PATCH /knowledge/sources/:domain {enabled} — human only, audited. A denied source can never be enabled for fetching. */
export function toggleSource(ctx: AppContext, domain: string, enabled: boolean, actor: Actor, reason: string | null = null): KnowledgeSourceRecord {
  assertHuman(actor, enabled ? 'enable a research source' : 'disable a research source');
  ensureResearchSources(ctx);
  const row = ctx.repos.getKnowledgeSource(ctx.db, domain.toLowerCase());
  if (!row) throw notFound('knowledge source', domain);
  const at = ctx.now();
  return ctx.db.transaction((tx) => {
    const r = ctx.repos.updateKnowledgeSource(tx, row.domain, { enabled, updatedBy: actor.userId, updatedAt: at });
    recordKnowledgeChange(ctx, tx, actor, at, { action: 'knowledge.source.toggle', before: { domain: row.domain, enabled: row.enabled }, after: { domain: row.domain, enabled }, reason });
    return r;
  });
}

/** Code disables a source after a failed self-test (the restrictive direction; the owner re-enables it). */
export function disableSourceAfterSelftest(ctx: AppContext, domain: string, detail: string): void {
  const row = ctx.repos.getKnowledgeSource(ctx.db, domain);
  if (!row || !row.enabled) return;
  const at = ctx.now();
  const actor: Actor = { userId: 'agent:supervisor' };
  ctx.db.transaction((tx) => {
    ctx.repos.updateKnowledgeSource(tx, domain, { enabled: false, updatedBy: actor.userId, updatedAt: at });
    recordKnowledgeChange(ctx, tx, actor, at, { action: 'knowledge.source.toggle', before: { domain, enabled: true }, after: { domain, enabled: false }, reason: `self-test failed: ${detail}`.slice(0, 500) });
  });
}
