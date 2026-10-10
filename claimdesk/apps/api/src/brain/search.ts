// owned by casework
/**
 * Retrieval over the active brain packs (docs/SUPREME-DESIGN.md §E.1, §E.4) and the versioned pack digest for prompts.
 *
 *  - `brainSearch`: FTS5 over the active version of each pack, filtered by business (for CCGUK claims an entry tagged
 *    only `fixmyfile` is excluded unless the owner ticked "use this pack's strategy for CCGUK claims"), merged by pack
 *    precedence (lower number = higher authority: L3 CCGUK rules before L4 playbook) then bm25. Every hit carries the
 *    pack id + version so a citation is traceable (`pack:<id>@<version>#<entry>`).
 *  - `activeRedLines`: red lines from ALL active packs apply together (they only add restrictions).
 *  - `packDigest`: a stable summary block (no timestamps) keyed by the active pack versions — the cacheable prompt
 *    prefix changes only when a pack version changes.
 */
import type { BrainEntryKind } from '@ccguk/domain';
import type { BrainEntryRecord, BrainPackRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import type { AgentSpec } from '../agent/contracts.js';
import type { PackDigest } from '../ai/prompts.js';

export interface BrainHit {
  packId: string;
  packName: string;
  version: string;
  precedence: number;
  entryId: string;
  /** `pack:<packId>@<version>#<entryId>` — the basis / citation id. */
  ref: string;
  kind: string;
  title: string;
  excerpt: string;
  verification: string | null;
  business: string[];
  bm25: number;
}

export interface BrainSearchInput {
  q: string;
  packs?: string[] | null;
  kinds?: BrainEntryKind[] | string[] | null;
  limit?: number;
  business?: 'ccguk' | 'fixmyfile';
}

export const brainRef = (packId: string, version: string, entryId: string): string => `pack:${packId}@${version}#${entryId}`;

/** Packs with an active version (precedence order). */
export function activePacks(ctx: AppContext): BrainPackRecord[] {
  return ctx.repos.listBrainPacks(ctx.db).filter((p) => Boolean(p.activeVersion));
}

/** Entry business tags; an entry without its own tags inherits the pack's. */
export function effectiveBusiness(entry: Pick<BrainEntryRecord, 'business'>, pack: Pick<BrainPackRecord, 'business'>): string[] {
  return entry.business?.length ? entry.business : pack.business;
}

/** May this entry reach work for `business`? (§E.1: fixmyfile-only strategy stays out of CCGUK work unless ticked.) */
export function allowedFor(business: 'ccguk' | 'fixmyfile', entry: Pick<BrainEntryRecord, 'business' | 'kind'>, pack: Pick<BrainPackRecord, 'business' | 'useForCcguk'>): boolean {
  const eff = effectiveBusiness(entry, pack);
  if (business === 'fixmyfile') return eff.includes('fixmyfile');
  return eff.includes('ccguk') || pack.useForCcguk;
}

const excerpt = (s: string, n = 600): string => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

export function brainSearch(ctx: AppContext, input: BrainSearchInput): BrainHit[] {
  const business = input.business ?? 'ccguk';
  const limit = Math.max(1, Math.min(input.limit ?? 8, 50));
  const packs = activePacks(ctx).filter((p) => !input.packs?.length || input.packs.includes(p.id));
  if (!packs.length || !input.q.trim()) return [];
  const byId = new Map(packs.map((p) => [p.id, p]));
  const raw = ctx.repos.searchBrainFts(ctx.db, { q: input.q, versions: packs.map((p) => ({ packId: p.id, version: p.activeVersion! })), ...(input.kinds?.length ? { kinds: input.kinds as string[] } : {}), limit: Math.min(limit * 6, 200) });
  return raw
    .filter((h) => {
      const pack = byId.get(h.entry.packId)!;
      return h.entry.verification !== 'failed' && allowedFor(business, h.entry, pack);
    })
    .map((h) => {
      const pack = byId.get(h.entry.packId)!;
      return {
        packId: pack.id,
        packName: pack.name,
        version: h.entry.version,
        precedence: pack.precedence,
        entryId: h.entry.id,
        ref: brainRef(pack.id, h.entry.version, h.entry.id),
        kind: h.entry.kind,
        title: h.entry.title,
        excerpt: excerpt(h.entry.body),
        verification: h.entry.verification ?? null,
        business: effectiveBusiness(h.entry, pack),
        bm25: h.bm25,
      };
    })
    .sort((a, b) => a.precedence - b.precedence || a.bm25 - b.bm25 || a.packId.localeCompare(b.packId) || a.entryId.localeCompare(b.entryId))
    .slice(0, limit);
}

/** Resolve a `pack:<id>@<version>#<entry>` reference (or `<id>#<entry>` against the active version). */
export function resolveBrainRef(ctx: AppContext, ref: string): (BrainEntryRecord & { pack: BrainPackRecord }) | undefined {
  const m = /^(?:pack:)?([a-z0-9][a-z0-9_-]*)(?:@([^#]+))?#(.+)$/.exec(ref.trim());
  if (!m) return undefined;
  const pack = ctx.repos.getBrainPack(ctx.db, m[1]!);
  const version = m[2] ?? pack?.activeVersion;
  if (!pack || !version) return undefined;
  const e = ctx.repos.getBrainEntry(ctx.db, pack.id, version, m[3]!);
  return e ? { ...e, pack } : undefined;
}

export interface RedLine {
  ref: string;
  packId: string;
  title: string;
  pattern?: string;
  condition?: unknown;
  scope: string;
  action: 'block' | 'escalate';
  message: string;
}

/** Red lines of every active pack (all businesses: they only add restrictions). */
export function activeRedLines(ctx: AppContext): RedLine[] {
  const out: RedLine[] = [];
  for (const p of activePacks(ctx)) {
    for (const e of ctx.repos.listBrainEntries(ctx.db, { packId: p.id, version: p.activeVersion!, kinds: ['redLine'], limit: 5000 })) {
      const d = (e.data ?? {}) as { pattern?: unknown; condition?: unknown; scope?: unknown; action?: unknown; message?: unknown };
      out.push({
        ref: brainRef(p.id, e.version, e.id),
        packId: p.id,
        title: e.title,
        ...(typeof d.pattern === 'string' ? { pattern: d.pattern } : {}),
        ...(d.condition !== undefined ? { condition: d.condition } : {}),
        scope: typeof d.scope === 'string' ? d.scope : 'all',
        action: d.action === 'escalate' ? 'escalate' : 'block',
        message: typeof d.message === 'string' ? d.message : e.title,
      });
    }
  }
  return out;
}

const MAX_DIGEST_CHARS = 12_000;

/**
 * The versioned pack digest (§E.5, §O): which packs are active (id, version, precedence, business), what they hold, the
 * red lines and the letter-style rules. Deterministic for the same active versions. Undefined when no pack is active.
 */
export function packDigest(ctx: AppContext, _spec?: AgentSpec): PackDigest | undefined {
  const packs = activePacks(ctx);
  if (!packs.length) return undefined;
  const id = `pack:${packs.map((p) => `${p.id}@${p.activeVersion}`).join('+')}`;
  const lines: string[] = [
    '# Brain packs (the owner’s private rules and playbooks)',
    '',
    'Authority order: perimeter and engines first, then the knowledge base, then these packs in the order listed (lower precedence number wins), then approved memory. Cite pack entries as `pack:<id>@<version>#<entry>` basis ids (find them with brain_search). Red lines below always apply.',
    '',
  ];
  for (const p of packs) {
    const counts = ctx.repos.countBrainEntriesByKind(ctx.db, p.id, p.activeVersion!);
    const kinds = Object.entries(counts)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
    lines.push(`## ${p.name} — ${p.id}@${p.activeVersion} (precedence ${p.precedence}; business ${p.business.join(', ') || 'none'}${p.useForCcguk ? '; used for CCGUK claims' : ''})`, `Entries: ${kinds || 'none'}.`);
    const styles = ctx.repos.listBrainEntries(ctx.db, { packId: p.id, version: p.activeVersion!, kinds: ['letterStyle'], limit: 20 });
    for (const s of styles) {
      const d = (s.data ?? {}) as { recipientRole?: string; do?: unknown; dont?: unknown };
      const list = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('; ') : '');
      lines.push(`- Letter style (${d.recipientRole ?? 'any'}): do — ${list(d.do) || s.body.slice(0, 200)}${list(d.dont) ? `; don't — ${list(d.dont)}` : ''}`);
    }
    lines.push('');
  }
  const reds = activeRedLines(ctx);
  if (reds.length) {
    lines.push('## Red lines (every pack; a breach blocks or escalates the draft)');
    for (const r of reds) lines.push(`- [${r.action}] ${r.message} (${r.ref})`);
  }
  let text = lines.join('\n').trim();
  if (text.length > MAX_DIGEST_CHARS) text = `${text.slice(0, MAX_DIGEST_CHARS)}\n…(digest truncated; use brain_search)`;
  return { id, text };
}
