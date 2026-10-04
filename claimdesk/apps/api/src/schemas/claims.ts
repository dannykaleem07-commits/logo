import { z } from 'zod';
import { id, isoDateTime } from './common.js';
import { partyRef } from './parties.js';
import { vehicleRef } from './vehicles.js';

export const claimStatus = z.enum([
  'fnol', 'triage', 'declined', 'accepted', 'hire_active', 'repair', 'total_loss', 'payment_pack', 'chasing', 'disputed',
  'complaint', 'pre_action', 'litigation', 'settled', 'closed',
]);
export const liabilityPosition = z.enum(['admitted', 'denied', 'split', 'unknown', 'disputed']);
export const track = z.enum(['small_claims', 'fast', 'intermediate', 'multi']);

export const accidentDetails = z.object({
  occurredAt: isoDateTime,
  location: z.string().trim().min(1),
  postcode: z.string().optional(),
  circumstances: z.string().trim().min(1),
  thirdPartyAccount: z.string().optional(),
  highwayCodeRules: z.array(z.number().int()).optional(),
  policeAttended: z.boolean().optional(),
  policeReference: z.string().optional(),
  cctvAvailable: z.boolean().optional(),
  dashcamAvailable: z.boolean().optional(),
  independentWitness: z.boolean().optional(),
  injuries: z.boolean().optional(),
  roadworthyAfter: z.boolean().optional(),
  airbagsDeployed: z.boolean().optional(),
  driveable: z.boolean().optional(),
});

export const offerChannel = z.enum(['phone', 'email', 'letter', 'sms', 'whatsapp', 'portal', 'via_client']);

/** Script guard (lesson m): the FNOL asks what was offered, by whom and when — never "ignore it". */
export const fnolOffer = z.object({
  offerorName: z.string().trim().min(1),
  receivedAt: isoDateTime.optional(),
  channel: offerChannel.default('via_client'),
  offerorPartyId: id.optional(),
  vehicleClassOffered: z.string().optional(),
  dailyRatePence: z.number().int().min(0).optional(),
  rateIncludesVat: z.boolean().optional(),
  terms: z
    .object({
      excessPence: z.number().int().min(0).optional(),
      mileageLimitPerDay: z.number().int().min(0).optional(),
      deliveryIncluded: z.boolean().optional(),
      insuranceIncluded: z.boolean().optional(),
      durationStated: z.string().optional(),
      otherTerms: z.string().optional(),
    })
    .optional(),
  clientToldToIgnore: z.literal(false).optional(),
});

export const createClaimBody = z.object({
  claimant: partyRef,
  driver: partyRef.optional(),
  vehicle: vehicleRef,
  thirdParties: z.array(partyRef).optional(),
  thirdPartyVehicle: vehicleRef.optional(),
  atFaultInsurer: partyRef.optional(),
  atFaultInsurerRef: z.string().optional(),
  clientInsurer: partyRef.optional(),
  clientPolicyNumber: z.string().optional(),
  accident: accidentDetails,
  liability: liabilityPosition.default('unknown'),
  handlerId: id.optional(),
  /** Where an injury element is to be referred (external PI solicitor); fee is never taken. */
  injuryReferralTo: z.string().optional(),
  interventionOffer: fnolOffer.optional(),
  servicesAgreedAt: isoDateTime.optional(),
  fnolAt: isoDateTime.optional(),
  callRecordingDisclosed: z.boolean().optional(),
  notes: z.string().optional(),
});

export const claimPatchBody = z
  .object({
    accident: accidentDetails.partial(),
    liability: liabilityPosition,
    liabilityScore: z.number().min(0).max(100),
    driverId: id.nullable(),
    thirdPartyIds: z.array(id),
    thirdPartyVehicleId: id.nullable(),
    atFaultInsurerId: id.nullable(),
    atFaultInsurerRef: z.string().nullable(),
    clientInsurerId: id.nullable(),
    clientPolicyNumber: z.string().nullable(),
    handlerId: id.nullable(),
    track: track.nullable(),
  })
  .partial()
  .strict();

export const statusBody = z.object({ status: claimStatus, reason: z.string().optional() });

export const clearFlagBody = z.object({ reason: z.string().trim().min(3) });

export const claimListQuery = z.object({
  status: z.union([claimStatus, z.string()]).optional(),
  handlerId: z.string().optional(),
  atFaultInsurerId: z.string().optional(),
  claimantId: z.string().optional(),
  search: z.string().optional(),
  q: z.string().optional(),
  flagged: z.enum(['true', 'false', 'info', 'warn', 'block']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type CreateClaimBody = z.infer<typeof createClaimBody>;
export type ClaimPatchBody = z.infer<typeof claimPatchBody>;
