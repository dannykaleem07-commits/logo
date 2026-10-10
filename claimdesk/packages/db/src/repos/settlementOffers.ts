import { asc, eq } from 'drizzle-orm';
import type { Id, SettlementOffer } from '@ccguk/domain';
import type { Db } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { settlementOffers, type SettlementOfferRow } from '../schema.js';
import { compact, newId, nowIso } from '../util.js';

/**
 * Settlement-offer register (docs/SUPREME-AUTOPILOT.md §D.9): an insurer's offer to settle a head of loss. Kept apart
 * from the intervention register (offers.ts): no 1-WD intervention reply clock, no part in the mitigation gate.
 */
export type CreateSettlementOfferInput = Omit<SettlementOffer, 'id' | 'status' | 'evidenceIds' | 'terms' | 'mailMessageId' | 'createdAt' | 'decidedBy' | 'decidedAt' | 'decisionNote'> & {
  id?: Id;
  terms?: string | null;
  evidenceIds?: Id[];
  mailMessageId?: Id | null;
};

export type SettlementOfferDecision = Pick<SettlementOffer, 'status'> & { decidedBy: string; decidedAt?: string; decisionNote?: string };

function toSettlementOffer(row: SettlementOfferRow): SettlementOffer {
  const { decidedBy, decidedAt, decisionNote, ...rest } = row;
  return {
    ...rest,
    ...(decidedBy !== null ? { decidedBy } : {}),
    ...(decidedAt !== null ? { decidedAt } : {}),
    ...(decisionNote !== null ? { decisionNote } : {}),
  };
}

export function createSettlementOffer(db: Db, input: CreateSettlementOfferInput): SettlementOffer {
  if (input.amountPence !== null && (!Number.isInteger(input.amountPence) || input.amountPence < 0)) throw new ValidationError('amountPence must be non-negative integer pence or null');
  const id = input.id ?? newId();
  db.insert(settlementOffers)
    .values({
      ...input,
      id,
      terms: input.terms ?? null,
      evidenceIds: input.evidenceIds ?? [],
      mailMessageId: input.mailMessageId ?? null,
      status: 'open',
      createdAt: nowIso(),
    })
    .run();
  return requireSettlementOffer(db, id);
}

export function getSettlementOffer(db: Db, id: Id): SettlementOffer | undefined {
  const row = db.select().from(settlementOffers).where(eq(settlementOffers.id, id)).get();
  return row ? toSettlementOffer(row) : undefined;
}

export function requireSettlementOffer(db: Db, id: Id): SettlementOffer {
  const o = getSettlementOffer(db, id);
  if (!o) throw new NotFoundError('settlement offer', id);
  return o;
}

export function listSettlementOffers(db: Db, claimId: Id): SettlementOffer[] {
  return db.select().from(settlementOffers).where(eq(settlementOffers.claimId, claimId)).orderBy(asc(settlementOffers.receivedAt), asc(settlementOffers.createdAt)).all().map(toSettlementOffer);
}

/** Record the owner's decision (the API refuses this for agents and the system). */
export function decideSettlementOffer(db: Db, id: Id, decision: SettlementOfferDecision): SettlementOffer {
  requireSettlementOffer(db, id);
  db.update(settlementOffers)
    .set(compact({ status: decision.status, decidedBy: decision.decidedBy, decidedAt: decision.decidedAt ?? nowIso(), decisionNote: decision.decisionNote }))
    .where(eq(settlementOffers.id, id))
    .run();
  return requireSettlementOffer(db, id);
}

/** Non-decision fields (evidence, terms). */
export function updateSettlementOffer(db: Db, id: Id, patch: { terms?: string | null; evidenceIds?: Id[] }): SettlementOffer {
  requireSettlementOffer(db, id);
  const set = compact(patch);
  if (Object.keys(set).length) db.update(settlementOffers).set(set).where(eq(settlementOffers.id, id)).run();
  return requireSettlementOffer(db, id);
}
