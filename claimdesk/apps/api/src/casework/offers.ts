// owned by casework
/**
 * The offer recommendation (docs/SUPREME-DESIGN.md §B.4 `offer_recommend`, §C.1, §D.1 settlement): analysis and a
 * recommendation only — accept / counter / reject / hold with reasons, confidence, basis chips and the figures table
 * code computed. It becomes (or replaces) the Needs-you `offer_decision` card; the owner decides on the offer screen.
 * Nothing here writes an offer decision, a reply or a ledger row.
 */
import { formatGBP, type Basis, type Recommendation } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { NeedsYouInput } from '../agent/contracts.js';
import { settlementFigures, type SettlementFigures } from './quantum.js';

export type OfferAction = 'accept' | 'counter' | 'reject' | 'hold';

export interface OfferRecommendationInput {
  offerId: string;
  recommendation: OfferAction;
  counterPence: number | null;
  reasoning: string;
  basis: Basis[];
  confidence: number;
}

const ACTION_LABEL: Record<OfferAction, string> = { accept: 'Accept the offer', counter: 'Counter-offer', reject: 'Reject the offer', hold: 'Hold — gather more before deciding' };

export function offerClaimId(ctx: AppContext, offerId: string): string | undefined {
  return ctx.repos.getOffer(ctx.db, offerId)?.claimId;
}

/**
 * Build the Needs-you `offer_decision` item with the recommendation (and supersede the earlier open card for this
 * offer, so the owner sees one). `dedupeKey` stays `offer_decision:<offerId>`.
 */
export function offerDecisionItem(ctx: AppContext, input: OfferRecommendationInput, meta: { createdBy: string; correlationId?: string; runId?: string }): NeedsYouInput {
  const offer = ctx.repos.getOffer(ctx.db, input.offerId);
  if (!offer) throw Object.assign(new Error(`Offer ${input.offerId} not found`), { code: 'NOT_FOUND' });
  const figures: SettlementFigures = settlementFigures(ctx, { claimId: offer.claimId, offerId: offer.id });
  const existing = ctx.repos.findOpenNeedsYouByDedupeKey(ctx.db, `offer_decision:${offer.id}`);
  if (existing) {
    ctx.repos.transitionNeedsYou(ctx.db, existing.id, { to: 'superseded', actor: meta.createdBy, note: 'replaced by the analysed recommendation', now: ctx.now() });
  }
  const confidence = Math.max(0, Math.min(1, input.confidence));
  const recommendation: Recommendation = {
    action: input.recommendation === 'counter' && input.counterPence !== null ? `${ACTION_LABEL.counter} at ${formatGBP(input.counterPence)}` : ACTION_LABEL[input.recommendation],
    why: input.reasoning.slice(0, 2000),
    confidence,
    basis: input.basis.slice(0, 20),
  };
  const reference = ctx.repos.getClaim(ctx.db, offer.claimId)?.reference ?? '';
  const prev = (existing?.payload ?? {}) as Record<string, unknown>;
  return {
    kind: 'offer_decision',
    claimId: offer.claimId,
    title: `Offer from ${offer.offerorName}${reference ? ` on ${reference}` : ''}: ${figures.offerPence !== null ? formatGBP(figures.offerPence) + (figures.perDay ? ' a day' : '') : 'amount not stated'} — recommendation: ${input.recommendation}`,
    summary: `Analysed by the case manager. ${figures.assumptions.note} You decide on the offer screen — agents never accept, counter or reject.`.slice(0, 2000),
    recommendation,
    options: [
      { id: 'open_offer', label: 'Open the offer to decide', tone: 'primary' },
      { id: 'dismiss', label: 'Dismiss', tone: 'neutral' },
    ],
    payload: {
      ...prev,
      recorded: true,
      offerId: offer.id,
      head: figures.head,
      amountPence: figures.offerPence,
      perDay: figures.perDay,
      link: `/claims/${offer.claimId}/offers`,
      recommended: { action: input.recommendation, counterPence: input.counterPence, confidence },
      figures: figures.figures,
      assumptions: figures.assumptions,
      settlement: figures.settlement,
      gtaBenchmark: figures.gtaBenchmark,
      ...(meta.runId ? { runId: meta.runId } : {}),
    },
    priority: 'urgent',
    createdBy: meta.createdBy,
    dedupeKey: `offer_decision:${offer.id}`,
    ...(meta.correlationId ? { correlationId: meta.correlationId } : {}),
  };
}
