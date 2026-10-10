import { z } from 'zod';
import { id, isoDateTime, pence } from './common.js';
import { offerChannel } from './claims.js';
import { headOfLoss } from './ledger.js';

export const offerTerms = z.object({
  excessPence: pence.optional(),
  mileageLimitPerDay: z.number().int().min(0).optional(),
  deliveryIncluded: z.boolean().optional(),
  insuranceIncluded: z.boolean().optional(),
  durationStated: z.string().optional(),
  otherTerms: z.string().optional(),
});

export const createOfferBody = z.object({
  receivedAt: isoDateTime,
  channel: offerChannel,
  offerorPartyId: id.optional(),
  offerorName: z.string().trim().min(1),
  vehicleClassOffered: z.string().optional(),
  dailyRatePence: pence.optional(),
  rateIncludesVat: z.boolean().optional(),
  terms: offerTerms.optional(),
  suitable: z.boolean().optional(),
  suitabilityReasons: z.array(z.string()).optional(),
  evidenceIds: z.array(id).optional(),
});

export const patchOfferBody = z
  .object({
    clientDecision: z.enum(['accepted', 'declined']),
    clientReasons: z.string().trim().min(1),
    clientDecisionAt: isoDateTime,
    suitable: z.boolean(),
    suitabilityReasons: z.array(z.string()),
    replySentAt: isoDateTime,
    replyDocumentId: id,
    evidenceIds: z.array(id),
  })
  .partial()
  .strict();

/** Settlement-offer register (docs/SUPREME-AUTOPILOT.md §D.9). */
export const createSettlementOfferBody = z
  .object({
    head: z.union([headOfLoss, z.literal('global')]),
    amountPence: pence.nullable().optional(),
    receivedAt: isoDateTime,
    channel: offerChannel.default('email'),
    offerorName: z.string().trim().min(1).max(200),
    terms: z.string().trim().max(4000).nullable().optional(),
    evidenceIds: z.array(id).max(50).optional(),
    mailMessageId: id.nullable().optional(),
  })
  .strict();

/** The owner's decision on a settlement offer (human-only), or evidence / terms (anyone). */
export const patchSettlementOfferBody = z
  .object({
    status: z.enum(['accepted', 'countered', 'rejected', 'lapsed', 'superseded']),
    decisionNote: z.string().trim().min(1).max(4000),
    decidedAt: isoDateTime,
    terms: z.string().trim().max(4000).nullable(),
    evidenceIds: z.array(id).max(50),
  })
  .partial()
  .strict();
