// owned by knowledge-core
/**
 * Item keys and content hashes (docs/SUPREME-KNOWLEDGE-BUILDER.md §4.1, §4.2). Pure and deterministic: the same
 * proposal always gives the same key and sha, so learners are idempotent and a re-proposal of identical content is a
 * no-op in the store.
 */
import { sha256Hex } from '../evidence/hash.js';
import type { ContactData, EngineeringFigureData, FactData, InsurerProfileData, KnowledgeProposal, KnowledgeScope, PrecedentData, TemplateSnippetData } from './types.js';

/** Deterministic JSON: object keys sorted, `undefined` dropped (as JSON.stringify does). */
export function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => [k, sort(o[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** First 8 hex characters of sha256 of the normalised text (lower-case, single-spaced, trimmed). */
export function sha8(text: string): string {
  return sha256Hex(normaliseKeyText(text)).slice(0, 8);
}

export function normaliseKeyText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** `global`, `insurer:<slug>` or `claim_type:<tag>`. */
export function scopeKey(scope: KnowledgeScope): string {
  switch (scope.kind) {
    case 'global':
      return 'global';
    case 'insurer':
      return `insurer:${scope.slug}`;
    case 'claim_type':
      return `claim_type:${scope.tag}`;
  }
}

/** Parse a scopeKey back (`global` when unrecognised). */
export function parseScopeKey(key: string): KnowledgeScope {
  if (key.startsWith('insurer:') && key.length > 8) return { kind: 'insurer', slug: key.slice(8) };
  if (key.startsWith('claim_type:') && key.length > 11) return { kind: 'claim_type', tag: key.slice(11) as never };
  return { kind: 'global' };
}

const slugPart = (s: string | null | undefined): string => (s ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || '-';

/** The item key (§4.2 table). A proposal may carry its own key (e.g. `rule:<clusterKey>`); otherwise the kind's rule applies. */
export function itemKeyFor(p: KnowledgeProposal): string {
  if (p.itemKey && p.itemKey.trim()) return p.itemKey.trim();
  const scope = scopeKey(p.scope);
  switch (p.kind) {
    case 'fact': {
      const d = p.data as Partial<FactData>;
      if (d?.stat) return `stat:${d.stat.metric}:${scope}:${d.stat.step}:${d.stat.outcome}:${d.stat.window}`;
      if (d?.kbCheck) return `kbcheck:${d.kbCheck.entryId}`;
      return `fact:${scope}:${sha8(d?.statement ?? p.body)}`;
    }
    case 'rule':
      return `rule:${sha8(p.title)}`;
    case 'strategy':
      return `strategy:${scope}:${sha8(p.title)}`;
    case 'contact': {
      const d = p.data as Partial<ContactData>;
      const ident = d?.email ? d.email.toLowerCase().trim() : d?.phone ? d.phone.replace(/\s+/g, '') : sha8(d?.name ?? p.title);
      return `contact:${d?.insurerSlug ?? (p.scope.kind === 'insurer' ? p.scope.slug : '-')}:${ident}`;
    }
    case 'insurer_profile': {
      const d = p.data as Partial<InsurerProfileData>;
      return `profile:${d?.insurerSlug ?? (p.scope.kind === 'insurer' ? p.scope.slug : '-')}:${d?.window ?? '12m'}`;
    }
    case 'template_snippet': {
      const d = p.data as Partial<TemplateSnippetData>;
      return `snippet:${d?.emailKind ?? d?.templateId ?? '-'}:${sha8(d?.text ?? p.body)}`;
    }
    case 'engineering_figure': {
      const d = p.data as Partial<EngineeringFigureData>;
      return `eng:${slugPart(d?.vehicle?.make)}:${slugPart(d?.vehicle?.modelFamily)}:${slugPart(d?.panel)}:${slugPart(d?.operation)}:${d?.metric ?? '-'}`;
    }
    case 'precedent': {
      const d = p.data as Partial<PrecedentData>;
      return `precedent:${d?.neutralCitation ? normaliseKeyText(d.neutralCitation).replace(/\s+/g, '') : sha8(d?.citation ?? p.title)}`;
    }
    case 'procedure':
      return `procedure:${scope}:${sha8(p.title)}`;
  }
}

/** sha256(stableJson({kind, area, title, body, data, scope, useLimit, business})) — the content identity of a version. */
export function contentShaOf(p: Pick<KnowledgeProposal, 'kind' | 'area' | 'title' | 'body' | 'data' | 'scope' | 'useLimit' | 'business'>): string {
  return sha256Hex(stableStringify({ kind: p.kind, area: p.area, title: p.title, body: p.body, data: p.data, scope: p.scope, useLimit: p.useLimit, business: [...p.business].sort() }));
}

/** ISO 8601 week label of a calendar day, e.g. `2026-W41` (idempotency keys of weekly jobs, §10.1). */
export function isoWeekOf(day: string): string {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The label of a learned-pack version (§4.6). */
export const learnedPackLabel = (version: number): string => `learned@1.${version}.0`;
