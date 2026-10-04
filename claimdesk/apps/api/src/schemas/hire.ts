import { z } from 'zod';
import { id, isoDateTime, pence, vatRate } from './common.js';

export const hireEndTrigger = z.enum(['repair_complete_24h', 'tl_payment_5wd', 'insurer_termination_1wd', 'cash_in_lieu', 'client_returned', 'replacement_purchased', 'manual']);
export const fleetUse = z.enum(['credit_hire', 'self_drive', 'pco']);

export const enforceabilityInput = z.object({
  cancellationInfoProvidedAt: isoDateTime.optional(),
  schedule3FormProvidedAt: isoDateTime.optional(),
  expressRequestToStartAt: isoDateTime.optional(),
  expressRequestEvidenceId: id.optional(),
  cca60fCompliant: z.boolean().optional(),
  notes: z.string().optional(),
});

export const createHireBody = z.object({
  fleetUnitId: id,
  startAt: isoDateTime,
  use: fleetUse.default('credit_hire'),
  dailyRatePence: pence.optional(),
  vatRate: vatRate.optional(),
  gtaGroup: z.string().optional(),
  excessPence: pence.default(0),
  excessWaiverDailyPence: pence.optional(),
  additionalDrivers: z.array(z.object({ partyId: id, nonStandardRisk: z.boolean().optional(), evidenceIds: z.array(id).default([]) })).optional(),
  deliveredAt: isoDateTime.optional(),
  odometerOut: z.number().int().min(0).optional(),
  signedAt: isoDateTime.optional(),
  enforceability: enforceabilityInput.optional(),
  needStatementEvidenceId: id.optional(),
  /** Allow the hire to be recorded despite an allocation refusal (reason is audited). */
  overrideAllocation: z.object({ reason: z.string().trim().min(3) }).optional(),
});

export const endHireBody = z.object({
  endTrigger: hireEndTrigger,
  endAt: isoDateTime,
  collectedAt: isoDateTime.optional(),
  odometerIn: z.number().int().min(0).optional(),
  reason: z.string().optional(),
});

export const storageEndTrigger = z.enum(['report_issued', 'total_loss_confirmed', 'payment_received', 'collected', 'salvage_released', 'manual']);

export const createStorageBody = z.object({
  location: z.string().trim().min(1),
  startAt: isoDateTime,
  dailyRatePence: pence.optional(),
  vatRate: vatRate.optional(),
});

export const endStorageBody = z.object({ endAt: isoDateTime, endTrigger: storageEndTrigger, reason: z.string().optional() });

export const createRecoveryBody = z.object({
  at: isoDateTime,
  fromLocation: z.string().trim().min(1),
  toLocation: z.string().trim().min(1),
  loadedMiles: z.number().min(0),
  calloutPence: pence.optional(),
  perLoadedMilePence: pence.optional(),
  adminPence: pence.optional(),
  vatRate: vatRate.optional(),
  evidenceIds: z.array(id).optional(),
  /** Counterparty (recovery agent) for the ledger entry. */
  counterpartyId: id.optional(),
});
