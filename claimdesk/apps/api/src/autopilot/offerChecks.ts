// owned by ap-autopilot
/**
 * Reviewer tier-a checks for the hire offer (docs/SUPREME-AUTOPILOT.md §D.2), called from the reviewer's rules tier
 * for outbox emails of kind `hire_offer`: HIRE_OFFER_FREE_WORDING (block), HIRE_OFFER_INTERVENTION_GUARD (block),
 * HIRE_OFFER_TERMS_MISMATCH (block — a registration or date that is not the bound offer's) and HIRE_OFFER_RATE_STATED
 * (warn). The terms come from the offer bound to the email (`hire_offers.outbox_id`).
 */
import { hireOfferChecks, type OfferCheckIssue } from '@ccguk/domain';
import type { OutboxRecord } from '@ccguk/db';
import type { AppContext } from '../context.js';

export function autopilotReviewIssues(ctx: AppContext, target: { claimId: string; text: string; outbox?: OutboxRecord }): OfferCheckIssue[] {
  const o = target.outbox;
  if (!o || o.kind !== 'hire_offer') return [];
  try {
    const offer = ctx.repos.getHireOfferByOutbox(ctx.db, o.id);
    const claim = ctx.repos.getClaim(ctx.db, target.claimId);
    const client = claim ? ctx.repos.getVehicle(ctx.db, claim.clientVehicleId) : undefined;
    return hireOfferChecks(target.text, offer?.terms ?? null, {
      allowedDates: [claim?.accident.occurredAt, ctx.now()].filter((x): x is string => Boolean(x)),
      clientRegistration: client?.registration ?? null,
    });
  } catch (err) {
    ctx.logger.warn('autopilot: offer checks failed', { outboxId: o.id, error: String(err) });
    return [];
  }
}
