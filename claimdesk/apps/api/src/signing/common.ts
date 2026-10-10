// owned by ap-paperwork
/**
 * Shared helpers for the paperwork slice (docs/SUPREME-AUTOPILOT.md §D.6, §E): actors and document users, the signer of
 * a pack, the pack hash, chronology events, and the Autopilot settings for signing.
 */
import { createHash } from 'node:crypto';
import type { Actor } from '@ccguk/db';
import { DEFAULT_CHASE_SCHEDULE, type ChaseSchedule, type DocumentPack, type EventType, type GeneratedDocument, type Id, type Party } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { DocUser } from '../services/documents.js';
import { appendClaimEvent } from '../mail/common.js';

export const AUTOPILOT_USER_ID = 'agent:autopilot';
export const AUTOPILOT_ACTOR: Actor = { userId: AUTOPILOT_USER_ID };
export const AUTOPILOT_DOC_USER: DocUser = { id: AUTOPILOT_USER_ID, name: 'Claims Team (Autopilot)', role: 'handler' };

export const isPerson = (actor: Pick<Actor, 'userId'>): boolean => Boolean(actor.userId) && actor.userId !== 'system' && actor.userId !== 'anonymous' && !actor.userId.startsWith('agent:');

/** The document user for an actor (the owner's name prints as the default signatory; agents print as the Claims Team). */
export function docUserFor(ctx: AppContext, actor: Actor): DocUser {
  if (!isPerson(actor)) return actor.userId === AUTOPILOT_USER_ID ? AUTOPILOT_DOC_USER : { id: actor.userId, name: 'Claims Team', role: 'handler' };
  const u = ctx.repos.getUser(ctx.db, actor.userId);
  return { id: actor.userId, name: u?.name ?? 'Claims Team', role: u?.role ?? 'handler' };
}

/** The signing settings (Settings > Autopilot > Signing). */
export function signingSettings(ctx: AppContext): { otpDelivery: 'email' | 'handler'; chase: ChaseSchedule; lanKiosk: boolean; kioskTtlMinutes: number } {
  const s = ctx.repos.getAgentSettings(ctx.db).autopilot?.signing;
  return {
    otpDelivery: s?.otpDelivery ?? 'email',
    chase: { chaseAfterDays: s?.chaseAfterDays?.length ? s.chaseAfterDays : DEFAULT_CHASE_SCHEDULE.chaseAfterDays, callAfterDays: s?.callAfterDays ?? DEFAULT_CHASE_SCHEDULE.callAfterDays },
    lanKiosk: Boolean(s?.lanKiosk),
    kioskTtlMinutes: s?.kioskTtlMinutes && s.kioskTtlMinutes > 0 ? s.kioskTtlMinutes : 30,
  };
}

/** The person who signs a pack: the reservation's hirer for hire paperwork, otherwise the claimant. */
export function packSigner(ctx: AppContext, pack: Pick<DocumentPack, 'claimId' | 'reservationId'>): Party {
  const claim = ctx.repos.requireClaim(ctx.db, pack.claimId);
  const reservation = pack.reservationId ? ctx.repos.getReservation(ctx.db, pack.reservationId) : undefined;
  return ctx.repos.requireParty(ctx.db, reservation?.hirerPartyId ?? claim.claimantId);
}

/** The pack's member documents (items with a document, not `not_needed`), in pack order. */
export function packDocuments(ctx: AppContext, pack: DocumentPack, purposes?: ReadonlyArray<DocumentPack['items'][number]['purpose']>): Array<{ item: DocumentPack['items'][number]; document: GeneratedDocument }> {
  const out: Array<{ item: DocumentPack['items'][number]; document: GeneratedDocument }> = [];
  for (const item of pack.items) {
    if (item.status === 'not_needed' || !item.documentId) continue;
    if (purposes && !purposes.includes(item.purpose)) continue;
    const document = ctx.repos.getDocument(ctx.db, item.documentId, { includeHtml: false });
    if (document) out.push({ item, document });
  }
  return out;
}

/**
 * The pack hash the kiosk code binds to (§E.2 step 3): sha256 of the sorted member document sha256s (documents the
 * client signs or is given). Any change to any member changes it.
 */
export function packSha256(ctx: AppContext, pack: DocumentPack): string {
  const shas = packDocuments(ctx, pack, ['sign', 'give'])
    .map((d) => d.document.sha256.toLowerCase())
    .sort();
  return createHash('sha256').update(shas.join('\n')).digest('hex');
}

/** Append a chronology event as the actor (same audit, side effects and clocks as the events route). */
export function appendPaperworkEvent(ctx: AppContext, claimId: Id, type: EventType, summary: string, data: Record<string, unknown>, actor: Actor, evidenceIds: Id[] = []): void {
  try {
    appendClaimEvent(ctx, claimId, { type, at: ctx.now(), summary, data, evidenceIds, attributableTo: 'ccguk' }, actor);
  } catch (err) {
    ctx.logger.warn('paperwork event could not be appended', { claimId, type, error: String(err) });
  }
}

/** First name / title for a letter: the party's name as recorded. */
export function salutationOf(p: Pick<Party, 'name'>): string {
  return p.name.trim() || 'Sir or Madam';
}

export function audit(ctx: AppContext, actor: Actor, action: string, entity: string, entityId: string, after: unknown): void {
  ctx.repos.appendAudit(ctx.db, { actor, action, entity, entityId, after, at: ctx.now() });
}

export const sha256Of = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

/** Masked email for screens (am***@example.com). */
export function maskEmail(c: string): string {
  if (!c.includes('@')) return `***${c.slice(-3)}`;
  const [u, d] = c.split('@');
  return `${(u ?? '').slice(0, 2)}***@${d ?? ''}`;
}
