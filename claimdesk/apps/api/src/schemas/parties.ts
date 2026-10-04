import { z } from 'zod';
import { addressSchema, bankDetailsSchema, isoDate } from './common.js';

export const partyRole = z.enum([
  'claimant', 'driver', 'keeper', 'third_party', 'third_party_driver', 'witness', 'insurer', 'broker', 'engineer', 'repairer',
  'recovery_agent', 'storage_yard', 'solicitor', 'supplier', 'salvage_buyer', 'council', 'police', 'other',
]);

export const partyInput = z.object({
  kind: z.enum(['individual', 'company', 'public_body']).default('individual'),
  name: z.string().trim().min(1),
  tradingName: z.string().optional(),
  dateOfBirth: isoDate.optional(),
  address: addressSchema.optional(),
  email: z.string().email().optional(),
  phone: z.string().min(5).optional(),
  companyNumber: z.string().optional(),
  vatRegistered: z.boolean().optional(),
  drivingLicenceNumber: z.string().optional(),
  bank: bankDetailsSchema.optional(),
  roles: z.array(partyRole).min(1),
  notes: z.string().optional(),
});

export const partyPatch = partyInput.partial();

/** Either an existing party id or the details for a new party. */
export const partyRef = z.union([z.object({ id: z.string().min(1) }), partyInput]);

export const partyListQuery = z.object({
  q: z.string().optional(),
  role: partyRole.optional(),
  kind: z.enum(['individual', 'company', 'public_body']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const connectionsQuery = z.object({ claimId: z.string().optional() });

export type PartyInput = z.infer<typeof partyInput>;
export type PartyRef = z.infer<typeof partyRef>;
