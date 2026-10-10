// owned by knowledge-core
/**
 * Claim typing and scope matching (docs/SUPREME-KNOWLEDGE-BUILDER.md §4.1 `claimTypeTagsFrom`, §8.1 scope weights).
 * Pure.
 */
import { CLAIM_TYPE_TAGS, type ClaimTypeInput, type ClaimTypeTag, type KnowledgeScope } from './types.js';

/** hire → credit_hire, TL assessment → total_loss, … Output is sorted in CLAIM_TYPE_TAGS order (deterministic). */
export function claimTypeTagsFrom(input: ClaimTypeInput): ClaimTypeTag[] {
  const tags = new Set<ClaimTypeTag>();
  if (input.hasHire) tags.add('credit_hire');
  if (input.hasRepair) tags.add('repair');
  if (input.totalLoss) tags.add('total_loss');
  if (input.hasStorage) tags.add('storage');
  if (input.hasRecovery) tags.add('recovery');
  if (input.pcn) tags.add('pcn');
  if (input.injuries) tags.add('injury_referral');
  const liability = (input.liability ?? '').toString().toLowerCase();
  if (liability === 'denied' || liability === 'disputed' || liability === 'split') tags.add('liability_dispute');
  if (input.fraudAllegation) tags.add('fraud_allegation');
  if ((input.track ?? '').toString().toLowerCase() === 'small_claims') tags.add('small_claims');
  if (input.litigation) tags.add('litigation');
  return CLAIM_TYPE_TAGS.filter((t) => tags.has(t));
}

/** Does an item's scope apply to a claim (insurer slug and claim types)? Global always applies. */
export function scopeApplies(scope: KnowledgeScope, claim: { insurerSlug: string | null; claimTypes: readonly ClaimTypeTag[] } | null): boolean {
  if (scope.kind === 'global') return true;
  if (!claim) return false;
  if (scope.kind === 'insurer') return claim.insurerSlug !== null && claim.insurerSlug === scope.slug;
  return claim.claimTypes.includes(scope.tag);
}

export const isClaimTypeTag = (v: unknown): v is ClaimTypeTag => typeof v === 'string' && (CLAIM_TYPE_TAGS as readonly string[]).includes(v);

/** Validate a scope object; returns problems (empty = valid). */
export function scopeProblems(scope: unknown): string[] {
  if (!scope || typeof scope !== 'object') return ['scope must be an object'];
  const s = scope as { kind?: unknown; slug?: unknown; tag?: unknown };
  if (s.kind === 'global') return [];
  if (s.kind === 'insurer') return typeof s.slug === 'string' && /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(s.slug) ? [] : ['insurer scope needs a lower-case slug'];
  if (s.kind === 'claim_type') return isClaimTypeTag(s.tag) ? [] : [`unknown claim type tag ${String(s.tag)}`];
  return [`unknown scope kind ${String(s.kind)}`];
}
