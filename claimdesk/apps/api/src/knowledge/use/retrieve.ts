// owned by knowledge-use
/**
 * Retrieval over every layer (docs/SUPREME-KNOWLEDGE-BUILDER.md §2.1, §8.1): candidates from
 *
 *   L2 KB            @ccguk/kb ranked search, with the owner's verification overlay (failed entries dropped)
 *   L3/L4 packs      brainSearch over the active brain-pack versions (business-filtered)
 *   L5 learned       knowledge_fts over active items that are members of the active learned-pack version, plus
 *                    computed items (insurer profiles, statistics), plus the claim insurer's computed profile and
 *                    learned contacts even when the query does not match them
 *   L6 case memory   approved memory_items for the claim's scopes
 *
 * then the pure `rankKnowledge` / `renderKnowledgeBlock` (domain retrieval.ts). The learned version can be overridden
 * for one async call chain (draft replay, §12.1) with `withKnowledgeVersion`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  buildRetrievalQuery,
  claimTypeTagsFrom,
  isExternal,
  isFosTagged,
  isGtaTagged,
  isInjuryTagged,
  rankKnowledge,
  renderKnowledgeBlock,
  RETRIEVAL_MAX_CHARS,
  RETRIEVAL_MAX_HITS,
  candidateAsItem,
  candidateBadges,
  mayCiteOutbound,
  type AgentName,
  type Business,
  type ClaimTypeTag,
  type FactData,
  type InsurerProfileData,
  type JobType,
  type KbEntry,
  type KnowledgeCandidate,
  type KnowledgeHit,
  type KnowledgeItem,
  type KnowledgeRef,
  type RecipientRole,
  type RetrievalRequest,
} from '@ccguk/domain';
import { search as kbSearch } from '@ccguk/kb';
import type { AppContext } from '../../context.js';
import { londonDay } from '../../agent/core.js';
import { brainSearch, resolveBrainRef } from '../../brain/search.js';
import { scopesForClaim } from '../../brain/memory.js';
import { maskText } from '../../casework/mask.js';
import { getKnowledgeSettings } from '../settings.js';
import { insurerSlugForClaim } from '../store.js';
import { baseKbEntries, kbOverlay, overlayKbEntry } from './kbOverlay.js';
import { tableExists, row } from './sql.js';

// ---------------------------------------------------------------------------
// Version override (draft replay)
// ---------------------------------------------------------------------------

const versionOverride = new AsyncLocalStorage<{ version: number | null }>();

/** Run `fn` with retrieval reading learned-pack version `version` (null = no learned items). */
export function withKnowledgeVersion<T>(version: number | null, fn: () => Promise<T>): Promise<T> {
  return versionOverride.run({ version }, fn);
}

// ---------------------------------------------------------------------------
// Claim context
// ---------------------------------------------------------------------------

export interface RetrievalClaim {
  claimId: string;
  insurerSlug: string | null;
  claimTypes: ClaimTypeTag[];
  recipientRole: RecipientRole | null;
  business: Business;
}

function exists(ctx: AppContext, table: string, claimId: string): boolean {
  try {
    return tableExists(ctx, table) && Boolean(row(ctx, `SELECT 1 AS x FROM ${table} WHERE claim_id = ? LIMIT 1`, claimId));
  } catch {
    return false;
  }
}

/** The claim facts retrieval needs (insurer slug through insurer_links, claim-type tags, business). */
export function retrievalClaim(ctx: AppContext, claimId: string, recipientRole: RecipientRole | null, brief?: unknown): RetrievalClaim | null {
  const claim = ctx.repos.getClaim(ctx.db, claimId);
  if (!claim) return null;
  let slug: string | null = null;
  try {
    slug = insurerSlugForClaim(ctx, claimId);
  } catch {
    slug = null;
  }
  if (!slug && brief && typeof brief === 'object') {
    const b = ((brief as { caseBrief?: unknown }).caseBrief ?? brief) as { recipients?: Array<{ role?: string; directoryId?: string | null }> };
    slug = b.recipients?.find((r) => r.role === 'at_fault_insurer' && r.directoryId)?.directoryId ?? null;
  }
  const c = claim as unknown as { liability?: string; track?: string; injuries?: unknown; injuryReferral?: unknown; business?: string };
  const claimTypes = claimTypeTagsFrom({
    hasHire: exists(ctx, 'hire_agreements', claimId),
    hasRepair: exists(ctx, 'estimates', claimId),
    hasStorage: exists(ctx, 'storage_records', claimId),
    hasRecovery: exists(ctx, 'recovery_records', claimId),
    totalLoss: (() => {
      try {
        return tableExists(ctx, 'engineer_reports') && Boolean(row(ctx, `SELECT 1 AS x FROM engineer_reports WHERE claim_id = ? AND total_loss IS NOT NULL LIMIT 1`, claimId));
      } catch {
        return false;
      }
    })(),
    injuries: Boolean(c.injuryReferral),
    liability: c.liability ?? null,
    track: c.track ?? null,
  });
  return { claimId, insurerSlug: slug, claimTypes, recipientRole, business: c.business === 'fixmyfile' ? 'fixmyfile' : 'ccguk' };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

const KB_LEGAL_TYPES = new Set(['case', 'statute', 'cpr', 'practice_direction']);

export function kbCandidate(e: KbEntry, bm25: number): KnowledgeCandidate | null {
  const status = e.verification?.status ?? 'unverified';
  if (status === 'failed') return null;
  const tags = [...(e.tags ?? []), ...(e.topics ?? [])];
  return {
    ref: `kb:${e.id}`,
    layer: 'kb',
    kind: 'kb_entry',
    area: KB_LEGAL_TYPES.has(e.type) ? 'legal' : e.type === 'fee' ? 'quantum' : 'procedural',
    title: `${e.citation}${e.title && e.title !== e.citation ? ` — ${e.title}` : ''}`,
    text: e.principle ?? '',
    bm25,
    scope: { kind: 'global' },
    business: ['ccguk', 'fixmyfile'],
    verification: status === 'verified' ? 'kb_verified' : status === 'stale' ? 'kb_stale' : 'kb_unverified',
    health: 'ok',
    useLimit: 'outbound_ok',
    tags,
    itemKey: null,
    computed: null,
    external: false,
    fos: e.type === 'fos' || tags.some((t) => /^(fos|financial_ombudsman)$/i.test(t)),
    gta: e.type === 'gta' || tags.some((t) => /^gta$/i.test(t)),
    injury: tags.some((t) => /^(injury|personal_injury|pi)$/i.test(t)),
    validTo: null,
  };
}

const asOfOf = (i: KnowledgeItem): string => {
  const d = i.data as Partial<InsurerProfileData> | undefined;
  return (typeof d?.computedAt === 'string' ? d.computedAt : i.createdAt).slice(0, 10);
};

export function itemCandidate(i: KnowledgeItem, bm25: number): KnowledgeCandidate {
  const tags = [...i.tags];
  for (const p of i.provenance) if (p.kind === 'kb') tags.push(`kb:${p.entryId}`);
  const kbCheck = i.kind === 'fact' ? (i.data as Partial<FactData>)?.kbCheck : null;
  if (kbCheck?.entryId) tags.push(`kb:${kbCheck.entryId}`);
  const benchmark = i.kind === 'fact' && Boolean((i.data as Partial<FactData>)?.benchmarkOnly);
  return {
    ref: `ki:${i.id}`,
    layer: 'learned',
    kind: i.kind,
    area: i.area,
    title: i.title,
    text: i.body,
    bm25,
    scope: i.scope,
    business: i.business,
    verification: i.verification,
    health: i.health,
    useLimit: i.useLimit,
    tags: [...new Set(tags)],
    itemKey: i.itemKey,
    computed: i.origin === 'computed' ? { n: i.supportN, asOf: asOfOf(i) } : null,
    external: isExternal(i.provenance),
    fos: isFosTagged(i.tags, i.provenance),
    gta: benchmark || isGtaTagged(i.tags, i.provenance),
    injury: isInjuryTagged(i.tags),
    validTo: i.validTo,
  };
}

function packLayer(kind: string | undefined): KnowledgeCandidate['layer'] {
  return kind === 'ccguk' ? 'ccguk_pack' : 'playbook_pack';
}

/** The learned items retrieval may use: members of the (overridden or active) version that are active, plus computed. */
function learnedPool(ctx: AppContext): { ids: Set<string> | null; version: number | null; allowRetired: boolean } {
  const o = versionOverride.getStore();
  if (o) {
    if (o.version === null) return { ids: new Set(), version: null, allowRetired: false };
    return { ids: new Set(ctx.repos.listKnowledgePackMembers(ctx.db, o.version)), version: o.version, allowRetired: true };
  }
  const state = ctx.repos.getKnowledgePackState(ctx.db);
  return { ids: new Set(state.activeVersion !== null ? ctx.repos.listKnowledgePackMembers(ctx.db, state.activeVersion) : []), version: state.activeVersion, allowRetired: false };
}

export interface CandidateOptions {
  claim: RetrievalClaim | null;
  kinds?: readonly string[] | null;
  /** fetch size per layer */
  perLayer?: number;
}

/** Every candidate for a query, across layers (deterministic order is restored by rankKnowledge). */
export function gatherCandidates(ctx: AppContext, query: string, opts: CandidateOptions): KnowledgeCandidate[] {
  const per = opts.perLayer ?? 30;
  const settings = getKnowledgeSettings(ctx);
  const out: KnowledgeCandidate[] = [];
  const wantKind = (k: string): boolean => !opts.kinds?.length || opts.kinds.includes(k);

  // L2 KB (with the overlay)
  if (wantKind('kb_entry') && query.trim()) {
    const ov = kbOverlay(ctx);
    const base = new Map(baseKbEntries(ctx).map((e) => [e.id, e] as const));
    try {
      for (const h of kbSearch(query, { limit: per })) {
        const entry = overlayKbEntry(base.get(h.entry.id) ?? h.entry, ov.get(h.entry.id));
        const c = kbCandidate(entry, h.score);
        if (c) out.push(c);
      }
    } catch (err) {
      ctx.logger.warn('knowledge retrieval: KB search failed', { error: String(err) });
    }
  }

  // L3 / L4 packs
  if (wantKind('pack_entry') && query.trim()) {
    try {
      const packs = new Map(ctx.repos.listBrainPacks(ctx.db).map((p) => [p.id, p] as const));
      for (const h of brainSearch(ctx, { q: query, limit: per, business: opts.claim?.business ?? 'ccguk' })) {
        const pack = packs.get(h.packId);
        const business = [...new Set([...(h.business as Business[]), ...(pack?.useForCcguk ? (['ccguk'] as Business[]) : [])])];
        out.push({
          ref: h.ref as KnowledgeRef,
          layer: packLayer(pack?.kind),
          kind: 'pack_entry',
          area: null,
          title: `${h.packName}: ${h.title}`,
          text: h.excerpt,
          bm25: Math.max(0, -h.bm25),
          scope: { kind: 'global' },
          business,
          verification: h.verification === 'unverified' ? 'unverified' : 'owner_confirmed',
          health: h.verification === 'stale' ? 'stale' : 'ok',
          useLimit: 'outbound_ok',
          tags: [h.kind],
          itemKey: null,
          computed: null,
          external: false,
          fos: /\bFOS\b|ombudsman/i.test(h.title),
          gta: false,
          injury: false,
          validTo: null,
        });
      }
    } catch (err) {
      ctx.logger.warn('knowledge retrieval: pack search failed', { error: String(err) });
    }
  }

  // L5 learned
  if (settings.useLearnedKnowledge) {
    const pool = learnedPool(ctx);
    const usable = (i: KnowledgeItem): boolean => {
      if (!wantKind(i.kind)) return false;
      if (i.origin === 'computed') return i.status === 'active';
      if (!pool.ids?.has(i.id)) return false;
      return i.status === 'active' || (pool.allowRetired && (i.status === 'retired' || i.status === 'superseded'));
    };
    const seen = new Set<string>();
    if (query.trim()) {
      for (const h of ctx.repos.searchKnowledgeFts(ctx.db, { q: query, statuses: pool.allowRetired ? ['active', 'retired', 'superseded'] : ['active'], limit: per * 3 })) {
        if (!usable(h.item) || seen.has(h.item.id)) continue;
        seen.add(h.item.id);
        out.push(itemCandidate(h.item, Math.max(0, -h.bm25)));
      }
    }
    // the claim's insurer: computed profile and learned contacts always considered
    const slug = opts.claim?.insurerSlug;
    if (slug) {
      const extra = ctx.repos.listKnowledgeItems(ctx.db, { status: 'active', scopeKind: 'insurer', scopeValue: slug, kind: ['insurer_profile', 'contact', 'procedure'], limit: 50 }).items;
      for (const i of extra) {
        if (!usable(i) || seen.has(i.id)) continue;
        if (i.kind === 'insurer_profile' && (i.data as Partial<InsurerProfileData>)?.window === 'all' && extra.some((x) => x.kind === 'insurer_profile' && (x.data as Partial<InsurerProfileData>)?.window === '12m')) continue;
        seen.add(i.id);
        out.push(itemCandidate(i, 0));
      }
    }
  }

  // L6 case memory (approved only)
  if (wantKind('memory') && opts.claim && query.trim()) {
    try {
      for (const m of ctx.repos.recallMemory(ctx.db, { q: query, scopes: scopesForClaim(ctx, opts.claim.claimId), limit: 8 })) {
        out.push({
          ref: `mem:${m.id}`,
          layer: 'memory',
          kind: 'memory',
          area: null,
          title: `${m.kind.replace(/_/g, ' ')} (${m.scope.startsWith('claim:') ? 'this claim' : m.scope})`,
          text: maskText(m.text),
          bm25: m.score,
          scope: { kind: 'global' },
          business: [opts.claim.business],
          verification: 'owner_confirmed',
          health: 'ok',
          useLimit: 'internal',
          tags: [],
          itemKey: null,
          computed: null,
          external: false,
          fos: false,
          gta: false,
          injury: false,
          validTo: null,
        });
      }
    } catch (err) {
      ctx.logger.warn('knowledge retrieval: memory recall failed', { error: String(err) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search (tool, route, agent context)
// ---------------------------------------------------------------------------

export interface SearchInput {
  agent: AgentName;
  jobType: JobType;
  query: string;
  claim: RetrievalClaim | null;
  kinds?: readonly string[] | null;
  limit?: number;
  maxChars?: number;
}

export function retrievalRequest(ctx: AppContext, input: SearchInput): RetrievalRequest {
  return {
    agent: input.agent,
    jobType: input.jobType,
    query: input.query,
    today: londonDay(ctx.now()),
    limit: Math.min(input.limit ?? RETRIEVAL_MAX_HITS, RETRIEVAL_MAX_HITS),
    maxChars: Math.min(input.maxChars ?? RETRIEVAL_MAX_CHARS, RETRIEVAL_MAX_CHARS),
    claim: input.claim ? { insurerSlug: input.claim.insurerSlug, claimTypes: input.claim.claimTypes, recipientRole: input.claim.recipientRole, business: input.claim.business } : null,
  };
}

/** Ranked hits and the exact block an agent would see. */
export function searchKnowledge(ctx: AppContext, input: SearchInput): { hits: KnowledgeHit[]; block: string; request: RetrievalRequest } {
  const request = retrievalRequest(ctx, input);
  const cands = gatherCandidates(ctx, input.query, { claim: input.claim, kinds: input.kinds ?? null });
  const hits = rankKnowledge(cands, request, { useLearned: getKnowledgeSettings(ctx).useLearnedKnowledge });
  return { hits, block: renderKnowledgeBlock(hits), request };
}

export { buildRetrievalQuery };

// ---------------------------------------------------------------------------
// Resolving one ref (the reviewer, /knowledge/used)
// ---------------------------------------------------------------------------

/** A hit for one ref, or undefined when it is unknown, not active, failed or retired. */
export function resolveKnowledgeRef(ctx: AppContext, ref: string, recipientRole: RecipientRole | null, opts: { anyStatus?: boolean } = {}): KnowledgeHit | undefined {
  let c: KnowledgeCandidate | null = null;
  if (ref.startsWith('ki:')) {
    const item = ctx.repos.getKnowledgeItem(ctx.db, ref.slice(3));
    if (!item) return undefined;
    if (item.status !== 'active' && !opts.anyStatus) return undefined;
    c = itemCandidate(item, 0);
  } else if (ref.startsWith('kb:')) {
    const id = ref.slice(3);
    const e = baseKbEntries(ctx).find((x) => x.id === id);
    if (!e) return undefined;
    c = kbCandidate(overlayKbEntry(e, kbOverlay(ctx).get(id)), 0);
  } else if (ref.startsWith('pack:')) {
    const e = resolveBrainRef(ctx, ref);
    if (!e || e.verification === 'failed') return undefined;
    c = {
      ref: ref as KnowledgeRef,
      layer: packLayer(e.pack.kind),
      kind: 'pack_entry',
      area: null,
      title: `${e.pack.name}: ${e.title}`,
      text: e.body.slice(0, 2000),
      bm25: 0,
      scope: { kind: 'global' },
      business: (e.business?.length ? e.business : e.pack.business) as Business[],
      verification: e.verification === 'unverified' ? 'unverified' : 'owner_confirmed',
      health: e.verification === 'stale' ? 'stale' : 'ok',
      useLimit: 'outbound_ok',
      tags: [e.kind],
      itemKey: null,
      computed: null,
      external: false,
      fos: false,
      gta: false,
      injury: false,
      validTo: null,
    };
  } else if (ref.startsWith('mem:')) {
    const m = ctx.repos.getMemoryItem(ctx.db, ref.slice(4));
    if (!m || (m.status !== 'approved' && !opts.anyStatus)) return undefined;
    c = { ref: ref as KnowledgeRef, layer: 'memory', kind: 'memory', area: null, title: m.kind, text: maskText(m.text), bm25: 0, scope: { kind: 'global' }, business: ['ccguk'], verification: 'owner_confirmed', health: 'ok', useLimit: 'internal', tags: [], itemKey: null, computed: null, external: false, fos: false, gta: false, injury: false, validTo: null };
  }
  if (!c) return undefined;
  return { ...c, rank: 0, score: 0, badges: candidateBadges(c), whyRanked: [], mayCiteOutbound: mayCiteOutbound(candidateAsItem(c), recipientRole).ok };
}
