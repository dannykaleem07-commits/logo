// owned by ap-booking
/** Request bodies for the fleet booking routes (docs/SUPREME-AUTOPILOT.md §H.4). */
import { z } from 'zod';
import { addressSchema, id, isoDate, isoDateTime, pence } from './common.js';
import { fleetUse, hireEndTrigger } from './hire.js';

const reason = z.string().trim().min(3, 'Give a reason').max(1000);

export const availabilityBody = z.object({
  claimId: id,
  startAt: isoDateTime.nullable().optional(),
  expectedEndAt: isoDateTime.nullable().optional(),
  use: fleetUse.nullable().optional(),
  limit: z.number().int().min(1).max(50).nullable().optional(),
  fleetUnitIds: z.array(id).max(200).optional(),
});

export const calendarQuery = z.object({
  from: isoDateTime,
  to: isoDateTime,
  unitIds: z.string().optional(),
  group: z.string().max(10).optional(),
  use: fleetUse.optional(),
  locationId: id.optional(),
  claimId: id.optional(),
});

export const holdBody = z.object({
  fleetUnitId: id,
  use: fleetUse.default('credit_hire'),
  startAt: isoDateTime,
  expectedEndAt: isoDateTime,
  hirerPartyId: id.nullable().optional(),
  driverPartyIds: z.array(id).max(5).nullable().optional(),
  dailyRatePence: pence.refine((p) => p > 0, 'Daily rate must be more than £0').nullable().optional(),
  substitutionReason: z.string().trim().max(1000).nullable().optional(),
  replaceReservationId: id.nullable().optional(),
  /** "Book now" (client present): hold and confirm in one step. */
  confirm: z.boolean().optional(),
  /** The availability ranking the caller chose from (informational; the server recomputes the snapshot). */
  rankingRef: z.string().max(200).nullable().optional(),
});

export const confirmBody = z.object({ hireOfferId: id.nullable().optional() }).default({});
export const releaseBody = z.object({ reason });

export const bookingPatchBody = z.object({
  startAt: isoDateTime.nullable().optional(),
  expectedEndAt: isoDateTime.nullable().optional(),
  reason,
  substitutionReason: z.string().trim().max(1000).nullable().optional(),
  dailyRatePence: pence.refine((p) => p > 0).nullable().optional(),
});

export const movementBody = z.object({
  kind: z.enum(['delivery', 'collection', 'swap_out', 'swap_in', 'transfer']),
  windowStart: isoDateTime,
  windowEnd: isoDateTime,
  address: z.union([z.enum(['client_home', 'delivery_address']), addressSchema]).nullable().default('delivery_address'),
  postcode: z.string().max(10).nullable().optional(),
  assignedTo: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const movementPatchBody = z.object({
  status: z.enum(['planned', 'confirmed', 'failed', 'cancelled']).nullable().optional(),
  windowStart: isoDateTime.nullable().optional(),
  windowEnd: isoDateTime.nullable().optional(),
  assignedTo: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  reason: z.string().max(1000).nullable().optional(),
  clientNotifiedAt: isoDateTime.nullable().optional(),
  noticeOutboxId: id.nullable().optional(),
});

export const movementsQuery = z.object({
  day: isoDate.optional(),
  range: z.enum(['day', 'tomorrow', 'week']).optional(),
});

export const handoverBody = z.object({
  at: isoDateTime,
  odometerOut: z.number().int().min(0),
  fuelEighths: z.number().int().min(0).max(8),
  conditionDocumentId: id.nullable().optional(),
  licenceEvidenceId: id.nullable().optional(),
  dvlaCheck: z.object({ checkedAt: isoDateTime, summary: z.string().trim().min(2).max(2000), evidenceId: id.nullable().optional() }).nullable(),
  keys: z.number().int().min(0).max(10).default(1),
  notes: z.string().max(2000).nullable().optional(),
  excessPence: pence.nullable().optional(),
});

export const returnBody = z.object({
  collectedAt: isoDateTime,
  endAt: isoDateTime,
  endTrigger: hireEndTrigger,
  odometerIn: z.number().int().min(0),
  fuelEighths: z.number().int().min(0).max(8),
  conditionDocumentId: id.nullable().optional(),
  damage: z
    .array(z.object({ panel: z.string().trim().min(1).max(100), description: z.string().trim().min(1).max(1000), severity: z.enum(['cosmetic', 'minor', 'major', 'unroadworthy']), evidenceIds: z.array(id).max(30).default([]) }))
    .max(30)
    .default([]),
  notes: z.string().max(2000).nullable().optional(),
});

export const readinessKind = z.enum(['valet', 'inspection', 'service', 'damage_repair', 'mot', 'tax', 'tyres', 'keys', 'phv_licence', 'other']);

export const readinessBody = z.object({
  kind: readinessKind,
  blocksHire: z.boolean().optional(),
  dueAt: isoDateTime.nullable().optional(),
  readyByAt: isoDateTime.nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  reservationId: id.nullable().optional(),
  damageId: id.nullable().optional(),
});

export const readinessPatchBody = z.object({
  status: z.enum(['open', 'done', 'cancelled']).optional(),
  blocksHire: z.boolean().optional(),
  dueAt: isoDateTime.nullable().optional(),
  readyByAt: isoDateTime.nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

export const damageBody = z.object({
  panel: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1000),
  severity: z.enum(['cosmetic', 'minor', 'major', 'unroadworthy']),
  foundAt: isoDateTime.optional(),
  reservationId: id.nullable().optional(),
  evidenceIds: z.array(id).max(30).default([]),
  chargeable: z.enum(['none', 'hirer', 'third_party', 'tbc']).default('tbc'),
  /** Create the repair task with it (blocking when major/unroadworthy). */
  createRepairTask: z.boolean().default(true),
});

export const damagePatchBody = z.object({
  repairedAt: isoDateTime.nullable().optional(),
  chargeable: z.enum(['none', 'hirer', 'third_party', 'tbc']).optional(),
  description: z.string().trim().min(1).max(1000).optional(),
  evidenceIds: z.array(id).max(30).optional(),
});

export const locationBody = z.object({
  name: z.string().trim().min(1).max(200),
  address: addressSchema.nullable().optional(),
  postcode: z.string().trim().max(10).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lon: z.number().min(-180).max(180).nullable().optional(),
  isDefault: z.boolean().optional(),
});

export const locationPatchBody = locationBody.partial();

export const periodAllocateBody = z.object({
  use: fleetUse,
  claimId: id.optional(),
  at: isoDateTime.optional(),
  startAt: isoDateTime.optional(),
  expectedEndAt: isoDateTime.optional(),
});
