// owned by ap-autopilot
/**
 * Hire offers (docs/SUPREME-AUTOPILOT.md §D.2–§D.4): the terms bound to a held reservation (built by code), the offer
 * register (`hire_offers`), the client's answer and the life of an offer:
 *
 *   draft    — prepared and bound to its outbox email (`hire_offer_prepare`); the reviewer and the policy decide;
 *   sent     — the email left (synced from the outbox); event `hire_offered`; expires with the hold;
 *   accepted / declined — the client's answer (email reply read by code or the reply reader, or "accepted by phone");
 *   expired  — no answer by the hold expiry; withdrawn / superseded — replaced or cancelled.
 *
 * Every write is audited; nothing here sends anything. A decline releases the hold (reason client_declined_hire).
 */
import type { FastifyRequest } from 'fastify';
import {
  formatRegistration,
  hireOfferTermsSha256,
  type HireOffer,
  type HireOfferResponse,
  type HireOfferTerms,
  type Id,
  type ISODateTime,
  type Movement,
  type Reservation,
} from '@ccguk/domain';
import type { Actor } from '@ccguk/db';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { releaseBooking } from '../booking/service.js';
import { nudgeAutopilot } from './nudge.js';

const AUTOPILOT = 'agent:autopilot';

const isPerson = (userId: string): boolean => !userId.startsWith('agent:') && userId !== 'system' && userId !== 'anonymous';

function audit(ctx: AppContext, actor: Actor, action: string, entityId: string, after: unknown, before?: unknown): void {
  ctx.repos.appendAudit(ctx.db, { actor, action, entity: 'hire_offers', entityId, ...(before !== undefined ? { before } : {}), after, at: ctx.now() });
}

function unitFacts(ctx: AppContext, fleetUnitId: Id): { registration: string; makeModel: string; transmission: string; seats: number | null; fuel: string | null } {
  const unit = ctx.repos.getFleetUnit(ctx.db, fleetUnitId);
  const v = unit ? ctx.repos.getVehicle(ctx.db, unit.vehicleId) : undefined;
  if (!v) return { registration: fleetUnitId, makeModel: 'Replacement car', transmission: 'unknown', seats: null, fuel: null };
  const seats = (v.spec as { seats?: number } | undefined)?.seats ?? null;
  return {
    registration: formatRegistration(v.registration),
    makeModel: [v.make, v.model].filter(Boolean).join(' ') || formatRegistration(v.registration),
    transmission: v.transmission === 'automatic' ? 'automatic' : v.transmission === 'manual' ? 'manual' : 'unknown',
    seats: typeof seats === 'number' ? seats : null,
    fuel: v.fuelType ?? null,
  };
}

function addressShort(m: Pick<Movement, 'address' | 'postcode'>): string {
  const a = m.address as { line1?: string; postcode?: string } | null;
  return [a?.line1, a?.postcode ?? m.postcode].filter((x) => x && String(x).trim()).join(', ') || 'the address we agreed';
}

/** The planned (or confirmed) delivery of a reservation. */
export function deliveryOf(ctx: AppContext, reservationId: Id): Movement | undefined {
  return ctx.repos.listMovements(ctx.db, { reservationId, status: ['planned', 'confirmed', 'done'] }).find((m) => m.kind === 'delivery');
}

/** The terms the client is told, built by code from the held reservation (and its delivery, when planned). */
export function buildHireOfferTerms(ctx: AppContext, r: Reservation, alternatives: HireOfferTerms['alternatives'] = []): HireOfferTerms {
  const u = unitFacts(ctx, r.fleetUnitId);
  const d = deliveryOf(ctx, r.id);
  return {
    reservationId: r.id,
    fleetUnitId: r.fleetUnitId,
    registration: u.registration,
    makeModel: u.makeModel,
    transmission: u.transmission,
    seats: u.seats,
    fuel: u.fuel,
    gtaGroup: r.gtaGroup,
    clientGtaGroup: r.clientGtaGroup ?? null,
    likeForLike: r.ranking?.likeForLike.sentence ?? (r.clientGtaGroup && r.clientGtaGroup === r.gtaGroup ? `It is in the same hire group as your own car (${r.gtaGroup}).` : `It is a ${r.gtaGroup} group car.`),
    startAt: r.startAt,
    expectedEndAt: r.expectedEndAt ?? r.startAt,
    delivery: d ? { windowStart: d.windowStart, windowEnd: d.windowEnd, addressShort: addressShort(d) } : null,
    expiresAt: r.holdExpiresAt ?? r.startAt,
    alternatives,
  };
}

/** Recompute the terms of an offer from the current reservation (alternatives as offered) and compare hashes. */
export function termsStillMatch(ctx: AppContext, offer: HireOffer): { match: boolean; current?: HireOfferTerms } {
  const r = ctx.repos.getReservation(ctx.db, offer.reservationId);
  if (!r) return { match: false };
  const current = buildHireOfferTerms(ctx, r, offer.terms.alternatives);
  return { match: hireOfferTermsSha256(current) === offer.termsSha256, current };
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

export interface PrepareOfferInput {
  claimId: Id;
  reservationId: Id;
  outboxId: Id | null;
  alternatives: Id[];
  channel?: HireOffer['channel'];
}

/** Bind a held reservation and its offer email (§D.2). The owner's own hold makes the offer owner-authorised. */
export function prepareHireOffer(ctx: AppContext, actor: Actor, input: PrepareOfferInput): HireOffer {
  const now = ctx.now();
  const r = ctx.repos.getReservation(ctx.db, input.reservationId);
  if (!r || r.claimId !== input.claimId) throw notFound('reservation', input.reservationId);
  if (r.status !== 'held') throw conflict('RESERVATION_STATE', 'An offer is made for a held car');
  if (input.outboxId) {
    const o = ctx.repos.getOutbox(ctx.db, input.outboxId);
    if (!o || o.claimId !== input.claimId) throw conflict('WRONG_CLAIM', 'The offer email is not on this claim');
    if (o.kind !== 'hire_offer') throw badRequest('The offer email must be of kind hire_offer');
    if (ctx.repos.getHireOfferByOutbox(ctx.db, o.id)) throw conflict('OFFER_EXISTS', 'This email already carries an offer');
  }
  const alternatives = input.alternatives
    .filter((id) => id !== r.fleetUnitId)
    .slice(0, 5)
    .map((id) => {
      const u = unitFacts(ctx, id);
      return { fleetUnitId: id, label: `${u.makeModel} (${u.registration})` };
    });
  const terms = buildHireOfferTerms(ctx, r, alternatives);
  const ownerHold = isPerson(r.createdBy);
  const authorisedBy = isPerson(actor.userId) ? actor.userId : ownerHold ? r.createdBy : 'autopilot_green';
  // Earlier drafts on this claim are superseded (one live offer per claim).
  for (const old of ctx.repos.listHireOffers(ctx.db, { claimId: input.claimId, status: 'draft' })) ctx.repos.updateHireOffer(ctx.db, old.id, { status: 'superseded' }, now);
  const offer = ctx.repos.createHireOffer(ctx.db, {
    claimId: input.claimId,
    reservationId: r.id,
    channel: input.channel ?? 'email',
    terms,
    termsSha256: hireOfferTermsSha256(terms),
    outboxId: input.outboxId,
    authorisedBy,
    expiresAt: terms.expiresAt,
    createdBy: actor.userId,
    at: now,
  });
  if (input.outboxId) ctx.repos.tagOutboxStep(ctx.db, input.outboxId, 'hire.offer');
  audit(ctx, actor, 'hire_offer.prepare', offer.id, { claimId: input.claimId, reservationId: r.id, outboxId: input.outboxId, registration: terms.registration, authorisedBy, termsSha256: offer.termsSha256 });
  return offer;
}

// ---------------------------------------------------------------------------
// Sync with the outbox and the clock
// ---------------------------------------------------------------------------

/**
 * Offers follow their email: sent → `sent` (event hire_offered, expiry = hold expiry); cancelled / failed → withdrawn;
 * a sent offer past its expiry with the hold gone → expired. Delivery notices sent → the movement records the client
 * was told. Returns what changed.
 */
export function syncHireOffers(ctx: AppContext, claimId: Id): Array<{ offerId: Id; to: HireOffer['status'] }> {
  const now = ctx.now();
  const out: Array<{ offerId: Id; to: HireOffer['status'] }> = [];
  for (const o of ctx.repos.listHireOffers(ctx.db, { claimId, status: ['draft', 'sent'] })) {
    if (o.status === 'draft' && o.outboxId) {
      const ob = ctx.repos.getOutbox(ctx.db, o.outboxId);
      if (ob?.status === 'sent') {
        const sentAt = ob.updatedAt;
        ctx.repos.updateHireOffer(ctx.db, o.id, { status: 'sent', sentAt }, now);
        ctx.repos.appendEvent(ctx.db, {
          claimId,
          type: 'hire_offered',
          at: sentAt,
          summary: `Replacement car ${o.terms.registration} offered to the client by email (held until ${o.expiresAt})`,
          data: { hireOfferId: o.id, reservationId: o.reservationId, outboxId: o.outboxId, registration: o.terms.registration },
          attributableTo: 'ccguk',
          createdBy: AUTOPILOT,
          recordedAt: now,
        });
        audit(ctx, { userId: AUTOPILOT }, 'hire_offer.sent', o.id, { outboxId: o.outboxId, sentAt });
        out.push({ offerId: o.id, to: 'sent' });
      } else if (ob && (ob.status === 'cancelled' || ob.status === 'failed')) {
        ctx.repos.updateHireOffer(ctx.db, o.id, { status: 'withdrawn' }, now);
        audit(ctx, { userId: AUTOPILOT }, 'hire_offer.withdrawn', o.id, { reason: `the offer email was ${ob.status}` });
        out.push({ offerId: o.id, to: 'withdrawn' });
      }
      continue;
    }
    if (o.status === 'sent' && Date.parse(o.expiresAt) <= Date.parse(now)) {
      const r = ctx.repos.getReservation(ctx.db, o.reservationId);
      if (!r || r.status === 'expired' || r.status === 'cancelled' || (r.status === 'held' && r.holdExpiresAt && Date.parse(r.holdExpiresAt) <= Date.parse(now))) {
        ctx.repos.updateHireOffer(ctx.db, o.id, { status: 'expired' }, now);
        audit(ctx, { userId: AUTOPILOT }, 'hire_offer.expired', o.id, { expiresAt: o.expiresAt });
        out.push({ offerId: o.id, to: 'expired' });
      }
    }
  }
  for (const m of ctx.repos.listMovements(ctx.db, { claimId, status: ['planned', 'confirmed'] })) {
    if (m.noticeOutboxId && !m.clientNotifiedAt) {
      const ob = ctx.repos.getOutbox(ctx.db, m.noticeOutboxId);
      if (ob?.status === 'sent') ctx.repos.updateMovement(ctx.db, m.id, { clientNotifiedAt: ob.updatedAt });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The client's answer
// ---------------------------------------------------------------------------

export interface ResponseInput {
  decision: 'accept' | 'decline';
  how: HireOfferResponse['how'];
  messageId?: Id | null;
  chosenFleetUnitId?: Id | null;
  confidence?: number | null;
  note?: string | null;
}

/** Record the client's answer (§D.4). A decline releases the hold; an acceptance lets the booking be confirmed. */
export function recordHireOfferResponse(ctx: AppContext, request: FastifyRequest | null, actor: Actor, id: Id, input: ResponseInput): HireOffer {
  const now = ctx.now();
  const o = ctx.repos.getHireOffer(ctx.db, id);
  if (!o) throw notFound('hire offer', id);
  if (o.status === 'accepted' && input.decision === 'accept') return o;
  if (!['sent', 'expired', 'draft'].includes(o.status)) throw conflict('OFFER_STATE', `A ${o.status} offer cannot take an answer`);
  if (o.status === 'draft' && input.how === 'email_reply') throw conflict('OFFER_STATE', 'The offer has not been sent yet');
  if (input.messageId) {
    const m = ctx.repos.getMailMessage(ctx.db, input.messageId);
    if (!m || m.claimId !== o.claimId) throw conflict('WRONG_CLAIM', 'The reply is not filed on this claim');
  }
  const response: HireOfferResponse = {
    at: now,
    how: input.how,
    decision: input.decision,
    recordedBy: actor.userId,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.chosenFleetUnitId ? { chosenFleetUnitId: input.chosenFleetUnitId } : {}),
    ...(input.note ? { note: input.note.slice(0, 1000) } : {}),
    ...(typeof input.confidence === 'number' ? { confidence: input.confidence } : {}),
  };
  const next = ctx.repos.updateHireOffer(ctx.db, id, { status: input.decision === 'accept' ? 'accepted' : 'declined', response, respondedAt: now }, now);
  ctx.repos.appendEvent(ctx.db, {
    claimId: o.claimId,
    type: input.decision === 'accept' ? 'hire_offer_accepted' : 'hire_offer_declined',
    at: now,
    summary: `${input.decision === 'accept' ? 'The client accepted' : 'The client declined'} the replacement car ${o.terms.registration} (${input.how.replace(/_/g, ' ')})`,
    data: { hireOfferId: id, how: input.how, messageId: input.messageId ?? null, confidence: input.confidence ?? null },
    attributableTo: 'client',
    createdBy: actor.userId,
    recordedAt: now,
  });
  if (input.how === 'phone' || input.how === 'in_person') {
    ctx.repos.appendEvent(ctx.db, { claimId: o.claimId, type: 'call', at: now, summary: `Client ${input.decision === 'accept' ? 'accepted' : 'declined'} the replacement car ${input.how === 'phone' ? 'by phone' : 'in person'}${input.note ? `: ${input.note.slice(0, 200)}` : ''}`, attributableTo: 'client', createdBy: actor.userId, recordedAt: now });
  }
  audit(ctx, actor, `hire_offer.${input.decision}`, id, { how: input.how, messageId: input.messageId ?? null, confidence: input.confidence ?? null }, { status: o.status });
  if (input.decision === 'decline') {
    const r = ctx.repos.getReservation(ctx.db, o.reservationId);
    if (r && (r.status === 'held' || r.status === 'confirmed')) releaseBooking(ctx, request, r.id, 'client_declined_hire');
  }
  nudgeAutopilot(ctx, o.claimId, `hire offer ${input.decision}`);
  return next;
}

export function withdrawHireOffer(ctx: AppContext, actor: Actor, id: Id, reason: string): HireOffer {
  const o = ctx.repos.getHireOffer(ctx.db, id);
  if (!o) throw notFound('hire offer', id);
  if (!['draft', 'sent'].includes(o.status)) throw conflict('OFFER_STATE', `A ${o.status} offer cannot be withdrawn`);
  const next = ctx.repos.updateHireOffer(ctx.db, id, { status: 'withdrawn' }, ctx.now());
  audit(ctx, actor, 'hire_offer.withdraw', id, { reason }, { status: o.status });
  nudgeAutopilot(ctx, o.claimId, 'hire offer withdrawn');
  return next;
}

/** The offers of a claim with their reservation status (newest first). */
export function claimHireOffers(ctx: AppContext, claimId: Id): Array<HireOffer & { reservationStatus: string | null }> {
  return ctx.repos
    .listHireOffers(ctx.db, { claimId })
    .reverse()
    .map((o) => ({ ...o, reservationStatus: ctx.repos.getReservation(ctx.db, o.reservationId)?.status ?? null }));
}

/** Delivery / collection window in owner and client words: "Tuesday 13 October 2026, 10:00–12:00". */
export function windowDisplay(startIso: ISODateTime, endIso: ISODateTime): string {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${fmt.format(new Date(startIso))}, ${time.format(new Date(startIso))}–${time.format(new Date(endIso))}`;
}
