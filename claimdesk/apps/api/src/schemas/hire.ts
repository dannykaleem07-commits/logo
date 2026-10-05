import { z } from 'zod';
import { id, isoDateTime, pence, vatRate } from './common.js';

export const hireEndTrigger = z.enum(['repair_complete_24h', 'tl_payment_5wd', 'insurer_termination_1wd', 'cash_in_lieu', 'client_returned', 'replacement_purchased', 'manual']);
export const fleetUse = z.enum(['credit_hire', 'self_drive', 'pco']);

/** A GTA group code: trimmed, upper-cased, 1–3 letters and up to 2 digits (S1, M, CP2). */
export const gtaGroupCode = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{1,3}\d{0,2}$/, 'Expected a GTA group such as S1, M or CP2'));

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
  /** Pre-0.3 field, still accepted (reason ≥ 3) and recorded in the hire.create audit only: it no longer bypasses
   *  anything by itself — refusals are overridden through manager mode (§A). */
  overrideAllocation: z.object({ reason: z.string().trim().min(3) }).optional(),
  /** A hire that has already ended (entered late): its end, what ended it (default manual) and why. */
  endAt: isoDateTime.optional(),
  endTrigger: hireEndTrigger.optional(),
  endReason: z.string().trim().max(1000).optional(),
  /** The client's car group chosen by hand on the pricing guide (otherwise the recorded/suggested group). */
  clientGtaGroup: gtaGroupCode.optional(),
});

/** PATCH /claims/:id/hire/:hireId — correct the dates, rate or groups of a hire (§C.3). */
export const correctHireBody = z.object({
  startAt: isoDateTime.optional(),
  endAt: isoDateTime.nullable().optional(), // null = re-open (still running)
  endTrigger: hireEndTrigger.optional(), // default: existing trigger, else 'manual' when an end is set
  dailyRatePence: pence.refine((p) => p > 0, 'Daily rate must be more than £0').optional(),
  gtaGroup: gtaGroupCode.optional(),
  clientGtaGroup: gtaGroupCode.nullable().optional(),
  reason: z.string().trim().min(3, 'Give the reason for the change'),
  ledger: z.enum(['auto', 'skip']).default('auto'),
});
export type CorrectHireBody = z.infer<typeof correctHireBody>;

/** GET /claims/:id/hire/pricing-guide query. */
export const pricingGuideQuery = z.object({
  fleetUnitId: id,
  startAt: isoDateTime.optional(),
  clientGroup: gtaGroupCode.optional(),
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
