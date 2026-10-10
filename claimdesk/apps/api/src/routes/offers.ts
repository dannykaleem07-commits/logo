import type { FastifyInstance } from 'fastify';
import { compareIso, type Clock, type InterventionOffer } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { badRequest, conflict, HttpError } from '../errors.js';
import { isAutomatedActor } from '../services/humanOnly.js';
import { parse } from '../schemas/common.js';
import { createOfferBody, createSettlementOfferBody, patchOfferBody, patchSettlementOfferBody } from '../schemas/offers.js';
import { recomputeClocks } from '../services/claimView.js';
import { params, requireClaim } from './helpers.js';

/**
 * Intervention register (lesson c, m): every offer logged with what/who/when; written reply within 1 working day.
 * Settlement offers have their own register (`/claims/:id/settlement-offers`, below).
 */
/** The 1-WD reply clock for an offer: the domain engine keys it on the offer event / receivedAt instant (London ISO). */
export function replyClockFor(clocks: Clock[], offer: InterventionOffer, offerEventId?: string): Clock | undefined {
  return clocks.find((c) => c.kind === 'intervention_reply_1wd' && ((offerEventId && c.sourceEventId === offerEventId) || compareIso(c.startsAt, offer.receivedAt) === 0));
}

export function registerOffersRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/claims/:id/offers', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const clocks = ctx.repos.listClocks(ctx.db, id).filter((c) => c.kind === 'intervention_reply_1wd');
    // both registers: `offers` is the intervention register, `settlementOffers` the settlement-offer register (§D.9)
    return { offers: ctx.repos.listOffers(ctx.db, id), replyClocks: clocks, settlementOffers: ctx.repos.listSettlementOffers(ctx.db, id) };
  });

  app.post('/claims/:id/offers', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(createOfferBody, request.body);
    const now = ctx.now();
    const offer = ctx.db.transaction((tx) => {
      const o = ctx.repos.createOffer(tx, { ...body, claimId: id, terms: body.terms ?? {} });
      ctx.repos.appendEvent(tx, {
        claimId: id,
        type: 'intervention_offer',
        at: body.receivedAt,
        summary: `Intervention offer from ${body.offerorName} via ${body.channel}${body.dailyRatePence !== undefined ? ` at ${(body.dailyRatePence / 100).toFixed(2)}/day` : ''}`,
        data: { offerId: o.id, dailyRatePence: body.dailyRatePence, vehicleClassOffered: body.vehicleClassOffered },
        attributableTo: 'insurer',
        evidenceIds: body.evidenceIds,
        createdBy: request.user.id,
        recordedAt: now,
      });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'offer.create', entity: 'intervention_offers', entityId: o.id, after: { claimId: id, offerorName: o.offerorName, channel: o.channel }, at: now });
      return o;
    });
    const clocks = recomputeClocks(ctx, id);
    return reply.status(201).send({ offer, replyClock: replyClockFor(clocks, offer) });
  });

  app.patch('/claims/:id/offers/:oid', async (request) => {
    const { id, oid } = params<{ id: string; oid: string }>(request);
    requireClaim(ctx, id);
    const body = parse(patchOfferBody, request.body);
    // Offer decisions and replies are the owner's (SUPREME §B.2 rule 4, §D.1): never an agent or the system.
    if (isAutomatedActor(request.actor) && (body.clientDecision !== undefined || body.replySentAt !== undefined)) {
      throw new HttpError(403, 'HUMAN_REQUIRED', 'Offer decisions and replies are recorded by a person, never by an agent', { actor: request.actor.userId });
    }
    const before = ctx.repos.requireOffer(ctx.db, oid);
    if (before.claimId !== id) throw conflict('WRONG_CLAIM', `Offer ${oid} belongs to another claim`);
    const now = ctx.now();
    const offer = ctx.db.transaction((tx) => {
      let o = before;
      if (body.clientDecision) {
        o = ctx.repos.recordOfferDecision(tx, oid, {
          clientDecision: body.clientDecision,
          clientReasons: body.clientReasons ?? '',
          clientDecisionAt: body.clientDecisionAt ?? now,
          suitable: body.suitable,
          suitabilityReasons: body.suitabilityReasons,
        });
      } else if (body.suitable !== undefined || body.suitabilityReasons || body.evidenceIds) {
        o = ctx.repos.updateOffer(tx, oid, { suitable: body.suitable, suitabilityReasons: body.suitabilityReasons, evidenceIds: body.evidenceIds });
      }
      if (body.replySentAt) {
        if (before.replySentAt) throw conflict('ALREADY_REPLIED', `Reply already recorded at ${before.replySentAt}`);
        o = ctx.repos.recordOfferReply(tx, oid, { replySentAt: body.replySentAt, replyDocumentId: body.replyDocumentId });
        ctx.repos.appendEvent(tx, {
          claimId: id,
          type: 'intervention_reply_sent',
          at: body.replySentAt,
          summary: `Written reply sent to ${o.offerorName} regarding the intervention offer of ${o.receivedAt.slice(0, 10)}`,
          data: { offerId: oid, replyDocumentId: body.replyDocumentId },
          attributableTo: 'ccguk',
          documentId: body.replyDocumentId,
          createdBy: request.user.id,
          recordedAt: now,
        });
      }
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'offer.patch', entity: 'intervention_offers', entityId: oid, before: { clientDecision: before.clientDecision, replySentAt: before.replySentAt ?? null }, after: body, at: now });
      return o;
    });
    const clocks = recomputeClocks(ctx, id);
    return { offer, replyClock: replyClockFor(clocks, offer) };
  });

  // -------------------------------------------------------------------------------------------------------------------
  // Settlement-offer register (docs/SUPREME-AUTOPILOT.md §D.9): an insurer's offer to settle a head of loss. Kept out of
  // the intervention register above: no intervention_reply_1wd clock, no part in the mitigation gate.
  // -------------------------------------------------------------------------------------------------------------------

  app.get('/claims/:id/settlement-offers', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    return { offers: ctx.repos.listSettlementOffers(ctx.db, id) };
  });

  app.post('/claims/:id/settlement-offers', async (request, reply) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const body = parse(createSettlementOfferBody, request.body);
    const now = ctx.now();
    const amountPence = body.amountPence ?? null;
    const offer = ctx.db.transaction((tx) => {
      const o = ctx.repos.createSettlementOffer(tx, {
        claimId: id,
        head: body.head,
        amountPence,
        receivedAt: body.receivedAt,
        channel: body.channel,
        offerorName: body.offerorName,
        terms: body.terms ?? null,
        evidenceIds: body.evidenceIds ?? [],
        mailMessageId: body.mailMessageId ?? null,
        createdBy: request.actor.userId,
      });
      ctx.repos.appendEvent(tx, {
        claimId: id,
        type: 'settlement_offer_received',
        at: body.receivedAt,
        summary: `Settlement offer from ${body.offerorName} on ${body.head === 'global' ? 'the whole claim' : body.head.replace(/_/g, ' ')}${amountPence !== null ? `: £${(amountPence / 100).toFixed(2)}` : ' (no figure stated)'}`,
        data: { settlementOfferId: o.id, head: body.head, amountPence },
        attributableTo: 'insurer',
        evidenceIds: body.evidenceIds ?? [],
        createdBy: request.user.id,
        recordedAt: now,
      });
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'settlement_offer.create', entity: 'settlement_offers', entityId: o.id, after: { claimId: id, head: o.head, amountPence: o.amountPence, offerorName: o.offerorName, channel: o.channel }, at: now });
      return o;
    });
    return reply.status(201).send({ offer });
  });

  app.patch('/claims/:id/settlement-offers/:oid', async (request) => {
    const { id, oid } = params<{ id: string; oid: string }>(request);
    requireClaim(ctx, id);
    const body = parse(patchSettlementOfferBody, request.body);
    // Settlement decisions are the owner's (SUPREME §B.2 rule 4, §D.1): never an agent or the system.
    if (isAutomatedActor(request.actor) && (body.status !== undefined || body.decisionNote !== undefined || body.decidedAt !== undefined)) {
      throw new HttpError(403, 'HUMAN_REQUIRED', 'Settlement offer decisions are recorded by a person, never by an agent', { actor: request.actor.userId });
    }
    if ((body.decisionNote !== undefined || body.decidedAt !== undefined) && body.status === undefined) throw badRequest('A decision note or date needs the decision (status)');
    const before = ctx.repos.requireSettlementOffer(ctx.db, oid);
    if (before.claimId !== id) throw conflict('WRONG_CLAIM', `Settlement offer ${oid} belongs to another claim`);
    const now = ctx.now();
    const offer = ctx.db.transaction((tx) => {
      let o = before;
      if (body.terms !== undefined || body.evidenceIds !== undefined) o = ctx.repos.updateSettlementOffer(tx, oid, { ...(body.terms !== undefined ? { terms: body.terms } : {}), ...(body.evidenceIds ? { evidenceIds: body.evidenceIds } : {}) });
      if (body.status) {
        if (before.status !== 'open') throw conflict('ALREADY_DECIDED', `Settlement offer ${oid} is already ${before.status}`);
        o = ctx.repos.decideSettlementOffer(tx, oid, { status: body.status, decidedBy: request.user.id, decidedAt: body.decidedAt ?? now, ...(body.decisionNote ? { decisionNote: body.decisionNote } : {}) });
      }
      ctx.repos.appendAudit(tx, { actor: request.actor, action: 'settlement_offer.patch', entity: 'settlement_offers', entityId: oid, before: { status: before.status }, after: { claimId: id, ...body }, at: now });
      return o;
    });
    return { offer };
  });
}
