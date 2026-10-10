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

export interface RecommendationCheck {
  /** The counter figure shown (null when it is not a sensible counter for this offer). */
  counterPence: number | null;
  warnings: string[];
  dissent?: string;
  capConfidence?: number;
}

/**
 * Check the model's recommendation against the code's own figures (settlementFigures), so the card never shows a
 * recommendation that contradicts the arithmetic on the same card:
 *  - a counter must be above the offer and no more than the outstanding (or claimed) figure for the head;
 *  - a reject / counter when the offer is at or above the walk-away number gets a dissent and a confidence cap.
 */
export function checkRecommendation(input: Pick<OfferRecommendationInput, 'recommendation' | 'counterPence' | 'basis'>, figures: SettlementFigures): RecommendationCheck {
  const warnings: string[] = [];
  let counterPence = input.counterPence;
  let capConfidence: number | undefined;
  let dissent: string | undefined;
  const offer = figures.offerPence;
  const ceiling = Math.max(figures.position.outstandingPence, figures.position.claimedPence);
  if (input.recommendation === 'counter') {
    if (counterPence === null) {
      warnings.push('The analysis recommends a counter-offer but gives no figure.');
      capConfidence = 0.5;
    } else if (offer !== null && !figures.perDay && counterPence <= offer) {
      warnings.push(`The suggested counter (${formatGBP(counterPence)}) is not above the offer (${formatGBP(offer)}), so it is not shown as a counter figure.`);
      counterPence = null;
      capConfidence = 0.5;
    } else if (ceiling > 0 && counterPence > ceiling) {
      warnings.push(`The suggested counter (${formatGBP(counterPence)}) is above the ${figures.head} figure on file (${formatGBP(ceiling)}).`);
      counterPence = null;
      capConfidence = 0.5;
    }
  }
  const otherHead = input.basis.find((b) => typeof b.id === 'string' && /^ledger\.([a-z_]+)\./.test(b.id) && !b.id.startsWith(`ledger.${figures.head}.`));
  if (otherHead) {
    warnings.push(`The analysis cites ${otherHead.id}, which is not the ${figures.head} head this offer is about.`);
    capConfidence = Math.min(capConfidence ?? 1, 0.5);
  }
  const walkAway = figures.settlement?.walkAwayPence;
  if (offer !== null && !figures.perDay && walkAway !== undefined && offer >= walkAway && (input.recommendation === 'reject' || input.recommendation === 'counter')) {
    dissent = `The figures favour accepting: the offer (${formatGBP(offer)}) is at or above the walk-away number (${formatGBP(walkAway)}).`;
    warnings.push(dissent);
    capConfidence = Math.min(capConfidence ?? 1, 0.5);
  }
  return { counterPence, warnings, ...(dissent ? { dissent } : {}), ...(capConfidence !== undefined ? { capConfidence } : {}) };
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
  const check = checkRecommendation(input, figures);
  const confidence = check.capConfidence !== undefined ? Math.min(check.capConfidence, Math.max(0, Math.min(1, input.confidence))) : Math.max(0, Math.min(1, input.confidence));
  const counterPence = check.counterPence;
  const recommendation: Recommendation = {
    action: input.recommendation === 'counter' && counterPence !== null ? `${ACTION_LABEL.counter} at ${formatGBP(counterPence)}` : ACTION_LABEL[input.recommendation],
    why: `${check.warnings.length ? `Warning: ${check.warnings.join(' ')} ` : ''}${input.reasoning}`.slice(0, 2000),
    confidence,
    basis: input.basis.slice(0, 20),
    ...(check.dissent ? { dissent: check.dissent } : {}),
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
      recommended: { action: input.recommendation, counterPence, confidence, ...(check.warnings.length ? { warnings: check.warnings } : {}) },
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
    ...(meta.runId ? { runId: meta.runId } : {}),
  };
}
