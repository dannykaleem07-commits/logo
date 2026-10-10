// owned by knowledge-learners
/**
 * Shared plumbing for the learners (docs/SUPREME-KNOWLEDGE-BUILDER.md §6). Every learner reads Phase 1 tables
 * read-only (raw SQL through `ctx.handle.sqlite`, because they scan across claims), writes only its own tables, and
 * proposes knowledge through the store as `agent:supervisor` — an automated actor, so nothing a learner does can pass
 * a human-only check (KR-1).
 */
import type { Actor } from '@ccguk/db';
import type { InsurerDirectoryEntry, ISODateTime } from '@ccguk/domain';
import { normaliseSenderDomain } from '@ccguk/domain';
import type { AppContext } from '../../context.js';

export const LEARNER = 'agent:supervisor';
export const LEARNER_ACTOR: Actor = { userId: LEARNER };

/** Parse a JSON text column (null on anything unparsable). */
export function json<T = unknown>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

export function hasTable(ctx: AppContext, name: string): boolean {
  return Boolean(ctx.handle.sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

export function all<T>(ctx: AppContext, sqlText: string, ...params: unknown[]): T[] {
  return ctx.handle.sqlite.prepare(sqlText).all(...params) as T[];
}

export function one<T>(ctx: AppContext, sqlText: string, ...params: unknown[]): T | undefined {
  return ctx.handle.sqlite.prepare(sqlText).get(...params) as T | undefined;
}

export const isPerson = (userId: string | null | undefined): boolean => Boolean(userId) && userId !== 'system' && !String(userId).startsWith('agent:');

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

export function directoryEntry(ctx: AppContext, slug: string | null | undefined): InsurerDirectoryEntry | undefined {
  if (!slug) return undefined;
  return ctx.kb.directory().find((d) => d.id === slug);
}

const hostOf = (v: string | undefined): string | null => {
  if (!v) return null;
  const h = normaliseSenderDomain(v);
  return h && h.includes('.') ? h : null;
};

/**
 * The insurer's own domains (§6.2): the hosts of portalUrl, claimsEmail, thirdPartyEmail and complaintsEmail, plus the
 * domains of owner-confirmed contact items for that insurer.
 */
export function ownDomainsOf(ctx: AppContext, entry: InsurerDirectoryEntry): string[] {
  const out = new Set<string>();
  for (const v of [entry.portalUrl, entry.claimsEmail, entry.thirdPartyEmail, entry.complaintsEmail]) {
    const h = hostOf(v);
    if (h) out.add(h);
  }
  const confirmed = all<{ data: string }>(ctx, `SELECT data FROM knowledge_items WHERE kind = 'contact' AND status = 'active' AND scope_kind = 'insurer' AND scope_value = ? AND verification <> 'unverified'`, entry.id);
  for (const r of confirmed) {
    const email = json<{ email?: string | null }>(r.data)?.email;
    const h = hostOf(email ?? undefined);
    if (h) out.add(h);
  }
  return [...out].sort();
}

/** The directory values a learned contact is compared with (directory_mismatch, §6.2). */
export function directoryValues(entry: InsurerDirectoryEntry): { slug: string; phones: string[]; emails: string[] } {
  return {
    slug: entry.id,
    phones: [entry.thirdPartyClaimsPhone, entry.policyholderClaimsPhone].filter((x): x is string => Boolean(x)),
    emails: [entry.claimsEmail, entry.thirdPartyEmail, entry.complaintsEmail].filter((x): x is string => Boolean(x)),
  };
}

/** The directory entry whose own domains include `host` — only when exactly one matches. */
export function entryForDomain(ctx: AppContext, host: string): InsurerDirectoryEntry | undefined {
  const h = normaliseSenderDomain(host);
  if (!h) return undefined;
  const hits = ctx.kb.directory().filter((e) => ownDomainsOf(ctx, e).some((d) => h === d || h.endsWith(`.${d}`)));
  return hits.length === 1 ? hits[0] : undefined;
}

// ---------------------------------------------------------------------------
// Insurer of a claim
// ---------------------------------------------------------------------------

/** claim id → insurer slug through `insurer_links` (null when unlinked). One query for every claim. */
export function insurerSlugsByClaim(ctx: AppContext): Map<string, string | null> {
  const rows = all<{ id: string; slug: string | null }>(ctx, `SELECT c.id AS id, l.insurer_slug AS slug FROM claims c LEFT JOIN insurer_links l ON l.party_id = c.at_fault_insurer_id`);
  return new Map(rows.map((r) => [r.id, r.slug]));
}

// ---------------------------------------------------------------------------
// Watermarks
// ---------------------------------------------------------------------------

export function watermark(ctx: AppContext, source: string): { lastAt: ISODateTime; lastId: string | null } {
  const w = ctx.repos.getKnowledgeWatermark(ctx.db, source);
  return w ? { lastAt: w.lastAt, lastId: w.lastId } : { lastAt: '', lastId: null };
}

export function advanceWatermark(ctx: AppContext, source: string, lastAt: ISODateTime, lastId: string | null): void {
  ctx.repos.putKnowledgeWatermark(ctx.db, { source, lastAt, lastId, updatedAt: ctx.now() });
}

/** Rows strictly after the watermark (ordered by `at`, then `id`). */
export const afterWatermark = (w: { lastAt: string; lastId: string | null }, at: string, id: string): boolean => at > w.lastAt || (at === w.lastAt && (w.lastId === null ? false : id > w.lastId));

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };

/** Minimal HTML → text for our own generated documents (paragraph breaks kept). Never used on web pages. */
export function documentHtmlToText(html: string): string {
  return (html ?? '')
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|section|article|header|footer)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e.startsWith('#x') || e.startsWith('#X')) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
