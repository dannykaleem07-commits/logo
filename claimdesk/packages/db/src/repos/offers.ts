import { asc, eq } from 'drizzle-orm';
import type { Id, ISODateTime, InterventionOffer } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { interventionOffers, type InterventionOfferRow } from '../schema.js';
import { compact, denull, newId, nowIso } from '../util.js';

export type CreateOfferInput = Omit<InterventionOffer, 'id' | 'clientDecision' | 'suitabilityReasons' | 'evidenceIds' | 'terms'> & {
  id?: Id;
  clientDecision?: InterventionOffer['clientDecision'];
  suitabilityReasons?: string[];
  evidenceIds?: Id[];
  terms?: InterventionOffer['terms'];
};

export type OfferPatch = Partial<Omit<InterventionOffer, 'id' | 'claimId'>>;

function toOffer(row: InterventionOfferRow): InterventionOffer {
  const { createdAt: _c, updatedAt: _u, ...rest } = row;
  return denull(rest);
}

/** Log an offer in the intervention register (BLUEPRINT §3.6, lesson c). Starts the 1-WD reply clock via the API. */
export function createOffer(db: Db, input: CreateOfferInput): InterventionOffer {
  if (input.dailyRatePence !== undefined && !Number.isInteger(input.dailyRatePence)) throw new ValidationError('dailyRatePence must be integer pence');
  const id = input.id ?? newId();
  const now = nowIso();
  db.insert(interventionOffers)
    .values({
      ...input,
      id,
      terms: input.terms ?? {},
      suitabilityReasons: input.suitabilityReasons ?? [],
      clientDecision: input.clientDecision ?? 'pending',
      evidenceIds: input.evidenceIds ?? [],
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return requireOffer(db, id);
}

export function getOffer(db: Db, id: Id): InterventionOffer | undefined {
  const row = db.select().from(interventionOffers).where(eq(interventionOffers.id, id)).get();
  return row ? toOffer(row) : undefined;
}

export function requireOffer(db: Db, id: Id): InterventionOffer {
  const o = getOffer(db, id);
  if (!o) throw new NotFoundError('intervention offer', id);
  return o;
}

export function listOffers(db: Db, claimId: Id): InterventionOffer[] {
  return db.select().from(interventionOffers).where(eq(interventionOffers.claimId, claimId)).orderBy(asc(interventionOffers.receivedAt)).all().map(toOffer);
}

export function updateOffer(db: Db, id: Id, patch: OfferPatch): InterventionOffer {
  requireOffer(db, id);
  db.update(interventionOffers)
    .set({ ...compact(patch), updatedAt: nowIso() })
    .where(eq(interventionOffers.id, id))
    .run();
  return requireOffer(db, id);
}

/** Record the client's decision and reasons (the Mitigation Questionnaire carries the signed statement). */
export function recordOfferDecision(
  db: Db,
  id: Id,
  decision: { clientDecision: 'accepted' | 'declined'; clientReasons: string; clientDecisionAt?: ISODateTime; suitable?: boolean; suitabilityReasons?: string[] },
): InterventionOffer {
  if (!decision.clientReasons?.trim()) throw new ValidationError('clientReasons is required when recording an offer decision');
  return updateOffer(db, id, { ...decision, clientDecisionAt: decision.clientDecisionAt ?? nowIso() });
}

/** Record that the written reply to the insurer went out (must be within 1 working day of receipt). */
export function recordOfferReply(db: Db, id: Id, reply: { replySentAt?: ISODateTime; replyDocumentId?: Id }): InterventionOffer {
  return updateOffer(db, id, { replySentAt: reply.replySentAt ?? nowIso(), replyDocumentId: reply.replyDocumentId });
}
