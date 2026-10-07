import type { FastifyInstance } from 'fastify';
import { compareIso, type Clock, type InterventionOffer } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { conflict, HttpError } from '../errors.js';
import { isAutomatedActor } from '../services/humanOnly.js';
import { parse } from '../schemas/common.js';
import { createOfferBody, patchOfferBody } from '../schemas/offers.js';
import { recomputeClocks } from '../services/claimView.js';
import { params, requireClaim } from './helpers.js';

/** Intervention register (lesson c, m): every offer logged with what/who/when; written reply within 1 working day. */
/** The 1-WD reply clock for an offer: the domain engine keys it on the offer event / receivedAt instant (London ISO). */
export function replyClockFor(clocks: Clock[], offer: InterventionOffer, offerEventId?: string): Clock | undefined {
  return clocks.find((c) => c.kind === 'intervention_reply_1wd' && ((offerEventId && c.sourceEventId === offerEventId) || compareIso(c.startsAt, offer.receivedAt) === 0));
}

export function registerOffersRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/claims/:id/offers', async (request) => {
    const { id } = params<{ id: string }>(request);
    requireClaim(ctx, id);
    const clocks = ctx.repos.listClocks(ctx.db, id).filter((c) => c.kind === 'intervention_reply_1wd');
    return { offers: ctx.repos.listOffers(ctx.db, id), replyClocks: clocks };
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
}
