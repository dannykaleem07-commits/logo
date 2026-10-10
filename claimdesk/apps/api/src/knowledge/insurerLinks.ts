// owned by knowledge-core
/**
 * Party → insurer links (docs/SUPREME-KNOWLEDGE-BUILDER.md §2.3, §6.1 step 1): `claims.at_fault_insurer_id` points to a
 * `parties` row while the directory uses JSON slugs; `insurer_links` joins them. Learners write exact-name, brand and
 * email-domain links (code never overwrites an `owner` link); the owner sets or corrects a link (human only, audited
 * `knowledge.link.set`).
 */
import type { Actor, InsurerLinkMethod, InsurerLinkRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { assertHuman, isAutomatedActor } from '../services/humanOnly.js';
import { recordKnowledgeChange } from './changes.js';

export interface UpsertInsurerLinkInput {
  partyId: string;
  insurerSlug: string;
  method: InsurerLinkMethod;
  confidence: number;
}

/** True when the slug is a directory entry. */
export function isDirectorySlug(ctx: AppContext, slug: string): boolean {
  return ctx.kb.directory().some((d) => d.id === slug);
}

/**
 * Create or update a link. Code (system / agent:*) may not use method `owner` and never overwrites an owner link;
 * a person always sets method `owner`. Returns the stored link (unchanged when code met an owner link).
 */
export function upsertInsurerLink(ctx: AppContext, input: UpsertInsurerLinkInput, actor: Actor): { link: InsurerLinkRecord; changed: boolean } {
  const automated = isAutomatedActor(actor);
  if (automated && input.method === 'owner') throw conflict('HUMAN_REQUIRED', 'Only a person can set an owner link');
  if (!automated && input.method !== 'owner') throw badRequest('A link set by a person is an owner link');
  if (!isDirectorySlug(ctx, input.insurerSlug)) throw notFound('insurer directory entry', input.insurerSlug);
  if (!ctx.repos.getParty(ctx.db, input.partyId)) throw notFound('party', input.partyId);
  if (!(input.confidence >= 0 && input.confidence <= 1)) throw badRequest('confidence must be 0..1');
  const current = ctx.repos.getInsurerLink(ctx.db, input.partyId);
  if (current && automated && current.method === 'owner') return { link: current, changed: false };
  if (current && current.insurerSlug === input.insurerSlug && current.method === input.method && current.confidence === input.confidence) return { link: current, changed: false };
  const now = ctx.now();
  const link = ctx.db.transaction((tx) => {
    const row = ctx.repos.putInsurerLink(tx, { partyId: input.partyId, insurerSlug: input.insurerSlug, method: input.method, confidence: input.confidence, decidedBy: actor.userId, decidedAt: now });
    recordKnowledgeChange(ctx, tx, actor, now, { action: 'knowledge.link.set', before: current ?? null, after: { partyId: row.partyId, insurerSlug: row.insurerSlug, method: row.method, confidence: row.confidence } });
    return row;
  });
  return { link, changed: true };
}

/** The owner sets a party → insurer link (PUT /knowledge/insurer-links/:partyId). */
export function setOwnerInsurerLink(ctx: AppContext, partyId: string, insurerSlug: string, actor: Actor): InsurerLinkRecord {
  assertHuman(actor, 'link a party to an insurer');
  return upsertInsurerLink(ctx, { partyId, insurerSlug, method: 'owner', confidence: 1 }, actor).link;
}
