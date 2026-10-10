// owned by knowledge-core
/**
 * Verification model (docs/SUPREME-KNOWLEDGE-BUILDER.md §4.4, §4.5, KR-1, KR-2, KR-3, KR-4, KR-10).
 *
 *  - `verification` (unverified | owner_confirmed | source_verified) only ever changes through a person's recorded
 *    check (DB-enforced). Code may only downgrade the DISPLAY through `health`; effective trust is the lower of the two.
 *  - `mayCiteOutbound`: legal/quantum/precedent need owner_confirmed or source_verified; computed never; health must be
 *    ok; FOS-tagged never to an at-fault insurer; injury never; GTA (benchmark_only) only with the benchmark wording.
 *  - `kbOverlayStatus`: the KB verification overlay — the latest human check wins; a code-detected source change shows
 *    as `stale`; `failed` excludes. Pure.
 */
import type { RecipientRole } from '../agents/types.js';
import type { KnowledgeBadge, KnowledgeCheck, KnowledgeHealth, KnowledgeItem, KnowledgeItemLike, KnowledgeProvenance } from './types.js';

const GTA_TAG_RE = /^(gta|benchmark_only|gta_benchmark)$/i;
const FOS_TAG_RE = /^(fos|financial_ombudsman)$/i;
const INJURY_TAG_RE = /^(injury|personal_injury|pi)$/i;

export const isGtaTagged = (tags: readonly string[], provenance?: readonly KnowledgeProvenance[]): boolean =>
  tags.some((t) => GTA_TAG_RE.test(t)) || (provenance ?? []).some((p) => (p.kind === 'snapshot' || p.kind === 'url') && /(^|\.)gtacredithire\.com$/i.test(hostOf(p.url)));
export const isFosTagged = (tags: readonly string[], provenance?: readonly KnowledgeProvenance[]): boolean =>
  tags.some((t) => FOS_TAG_RE.test(t)) || (provenance ?? []).some((p) => (p.kind === 'snapshot' || p.kind === 'url') && /(^|\.)financial-ombudsman\.org\.uk$/i.test(hostOf(p.url)));
export const isInjuryTagged = (tags: readonly string[]): boolean => tags.some((t) => INJURY_TAG_RE.test(t));
export const isExternal = (provenance: readonly KnowledgeProvenance[]): boolean => provenance.some((p) => p.kind === 'snapshot' || p.kind === 'url');

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const BADGE_ORDER: readonly KnowledgeBadge[] = ['source_verified', 'owner_confirmed', 'unverified', 'computed', 'benchmark_only', 'external', 'stale', 'source_changed', 'conflicted'];

/** The badges shown for an item (deterministic order). Health problems always show, whatever the verification. */
export function effectiveBadges(i: Pick<KnowledgeItem, 'verification' | 'health' | 'origin' | 'tags' | 'provenance'>): KnowledgeBadge[] {
  const out = new Set<KnowledgeBadge>();
  if (i.origin === 'computed') out.add('computed');
  else out.add(i.verification);
  if (isGtaTagged(i.tags, i.provenance)) out.add('benchmark_only');
  if (isExternal(i.provenance)) out.add('external');
  // Code may only downgrade the display (KR-2): stale/expired both read as stale.
  if (i.health === 'stale' || i.health === 'expired') out.add('stale');
  if (i.health === 'source_changed') out.add('source_changed');
  if (i.health === 'conflicted') out.add('conflicted');
  return BADGE_ORDER.filter((b) => out.has(b));
}

/** Effective trust: the lower of verification and health (KR-2). 0 = untrusted display, 2 = source verified and healthy. */
export function effectiveTrust(i: Pick<KnowledgeItem, 'verification' | 'health'>): 0 | 1 | 2 {
  if (i.health !== 'ok') return 0;
  return i.verification === 'source_verified' ? 2 : i.verification === 'owner_confirmed' ? 1 : 0;
}

const CHECKED: ReadonlySet<string> = new Set(['owner_confirmed', 'source_verified', 'kb_verified']);

/**
 * Outbound citation allowed? legal/quantum need owner_confirmed|source_verified; computed never; health must be ok;
 * FOS-tagged never to an at-fault insurer; injury never; benchmark_only only with the GTA benchmark wording (the
 * reviewer's GTA_CITED_AS_LAW check enforces the wording; here a GTA item is citable but flagged by reason).
 */
export function mayCiteOutbound(i: KnowledgeItemLike, recipientRole: RecipientRole | null): { ok: boolean; reason: string | null } {
  if (i.status !== undefined && i.status !== 'active') return { ok: false, reason: `item is ${i.status}, not active` };
  if (i.useLimit !== 'outbound_ok') return { ok: false, reason: i.useLimit === 'code_only' ? 'code-only knowledge never reaches text' : 'internal knowledge may not be stated outbound' };
  if (i.origin === 'computed') return { ok: false, reason: 'computed statistics are internal only (KR-10)' };
  if (i.health !== 'ok') return { ok: false, reason: `knowledge health is ${i.health}` };
  if (isInjuryTagged(i.tags)) return { ok: false, reason: 'personal injury is referred out, never handled (KR-4)' };
  if (recipientRole === 'at_fault_insurer' && (isFosTagged(i.tags, i.provenance) || (i.business.includes('fixmyfile') && !i.business.includes('ccguk')))) {
    return { ok: false, reason: 'Financial Ombudsman material is not a forum open against the at-fault insurer (FORUM_NOT_OPEN)' };
  }
  const needsCheck = i.area === 'legal' || i.area === 'quantum' || i.kind === 'precedent';
  if (needsCheck && !CHECKED.has(i.verification)) return { ok: false, reason: 'legal, quantum and precedent points need the owner to confirm or source-verify them first' };
  if (i.verification === 'kb_stale') return { ok: false, reason: 'the KB source changed since it was checked' };
  if (isGtaTagged(i.tags, i.provenance)) return { ok: true, reason: 'GTA benchmark only — never as law' };
  return { ok: true, reason: null };
}

/** KB overlay: latest human check wins; code-detected source change shows as 'stale'; 'failed' excludes. Pure. */
export function kbOverlayStatus(staticStatus: 'verified' | 'unverified' | 'failed' | 'stale', checks: KnowledgeCheck[], health: KnowledgeHealth): 'verified' | 'unverified' | 'failed' | 'stale' {
  const human = checks
    .filter((c) => c.target.startsWith('kb:') && c.checkedBy !== 'system' && !c.checkedBy.startsWith('agent:') && c.method !== 'downgrade')
    .sort((a, b) => (a.checkedAt === b.checkedAt ? a.id.localeCompare(b.id) : a.checkedAt.localeCompare(b.checkedAt)));
  const latest = human[human.length - 1];
  let status: 'verified' | 'unverified' | 'failed' | 'stale' = staticStatus;
  if (latest) status = latest.result === 'failed' ? 'failed' : latest.result === 'source_verified' || latest.result === 'owner_confirmed' ? 'verified' : 'unverified';
  if (status === 'failed') return 'failed';
  if (health === 'source_changed' || health === 'stale' || health === 'expired') return status === 'verified' ? 'stale' : status;
  return status;
}

/** Badge text for the UI and the knowledge block (no emoji, §11). */
export const BADGE_LABEL: Readonly<Record<KnowledgeBadge, string>> = {
  source_verified: 'SOURCE-VERIFIED',
  owner_confirmed: 'OWNER-CONFIRMED',
  unverified: 'UNVERIFIED',
  computed: 'COMPUTED',
  benchmark_only: 'GTA BENCHMARK',
  stale: 'STALE',
  source_changed: 'SOURCE CHANGED',
  conflicted: 'CONFLICT',
  external: 'EXTERNAL',
};
