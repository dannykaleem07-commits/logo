import { z } from 'zod';
import { id, isoDateTime, pence } from './common.js';
import { offerChannel } from './claims.js';

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
