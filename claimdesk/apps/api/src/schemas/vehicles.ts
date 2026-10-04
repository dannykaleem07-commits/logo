import { z } from 'zod';
import { id, isoDate } from './common.js';

export const fuelType = z.enum(['petrol', 'diesel', 'hybrid', 'plugin_hybrid', 'electric', 'lpg', 'other']);
export const transmission = z.enum(['manual', 'automatic', 'unknown']);
export const ownership = z.enum(['client', 'third_party', 'fleet', 'other']);
export const odometerSource = z.enum(['mot', 'accident_report', 'handover', 'collection', 'engineer', 'photo', 'v5c', 'client', 'manual']);
export const salvageCategory = z.enum(['A', 'B', 'S', 'N']);

export const odometerReadingInput = z.object({
  source: odometerSource,
  date: isoDate,
  miles: z.number().int().min(0),
  evidenceId: id.optional(),
  note: z.string().optional(),
});

/** Catalogue pick, segment, equipment (TEMPLATES-VEHICLES-DESKTOP §D.10). */
export const vehicleSpecSchema = z.object({
  catalogue: z
    .object({
      makeSlug: z.string().trim().min(1).max(64),
      modelSlug: z.string().trim().min(1).max(64),
      generationId: z.string().trim().min(1).max(160).optional(),
      trimId: z.string().trim().min(1).max(64).optional(),
      engineId: z.string().trim().min(1).max(64).optional(),
      custom: z.boolean().optional(),
    })
    .optional(),
  segment: z.string().trim().min(1).max(32).optional(),
  doors: z.number().int().min(1).max(9).optional(),
  seats: z.number().int().min(1).max(17).optional(),
  powerPs: z.number().int().min(1).max(2000).optional(),
  drivetrain: z.enum(['fwd', 'rwd', 'awd', '4wd']).optional(),
  features: z.array(z.string().trim().min(1).max(64)).max(300).default([]),
  extras: z.array(z.string().trim().min(1).max(64)).max(300).default([]),
  notes: z.string().max(2000).optional(),
});

/** Maximum pasted text kept on a LookupRecord (§E.4); longer pastes are cut, not refused. */
export const PASTED_TEXT_MAX = 20_000;

/**
 * Who/what supplied hand-entered values (§E.4). Never carries a verification: the server sets it (always unverified).
 * Unknown keys (e.g. a client-sent `verification`) are stripped.
 */
export const vehicleSourceSchema = z.object({
  provider: z.enum(['manual', 'catalogue', 'totalcarcheck_manual']),
  url: z
    .string()
    .trim()
    .max(2000)
    .regex(/^https?:\/\/\S+$/i, 'expected an http(s) URL')
    .optional(),
  pastedText: z
    .string()
    .max(200_000)
    .transform((t) => t.slice(0, PASTED_TEXT_MAX))
    .optional(),
  parsed: z.record(z.unknown()).optional(),
  appliedFields: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
});

export const vehicleInput = z.object({
  registration: z.string().trim().min(2).max(10),
  vin: z.string().optional(),
  make: z.string().trim().min(1).default('UNKNOWN'),
  model: z.string().trim().min(1).default('UNKNOWN'),
  variant: z.string().optional(),
  bodyType: z.string().optional(),
  yearOfManufacture: z.number().int().min(1900).max(2100).optional(),
  monthOfFirstRegistration: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  fuelType: fuelType.optional(),
  transmission: transmission.optional(),
  colour: z.string().optional(),
  engineCapacityCc: z.number().int().optional(),
  co2Gkm: z.number().optional(),
  euroStatus: z.string().optional(),
  taxStatus: z.string().optional(),
  taxDueDate: isoDate.optional(),
  motStatus: z.string().optional(),
  motExpiryDate: isoDate.optional(),
  markedForExport: z.boolean().optional(),
  dateOfLastV5CIssued: isoDate.optional(),
  gtaGroup: z.string().optional(),
  previousWriteOffCategory: salvageCategory.optional(),
  ownership: ownership.default('client'),
  odometer: z.array(odometerReadingInput).optional(),
  spec: vehicleSpecSchema.optional(),
  /** Provenance of hand-entered details; the LookupRecord uses its provider (default manual). */
  source: vehicleSourceSchema.optional(),
});

/** Either an existing vehicle id or details (registration is enough; make/model default to UNKNOWN until a lookup). */
export const vehicleRef = z.union([z.object({ id: z.string().min(1) }), vehicleInput]);

export const vehicleListQuery = z.object({
  q: z.string().optional(),
  ownership: ownership.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const lookupBody = z.object({
  registration: z.string().trim().min(2).max(10),
  ownership: ownership.optional(),
  /** Which providers to query (default both vehicle providers). */
  providers: z.array(z.enum(['dvla_ves', 'dvsa_mot'])).optional(),
});

export const mileageConflictsQuery = z.object({
  toleranceMiles: z.coerce.number().min(0).optional(),
  tolerancePct: z.coerce.number().min(0).optional(),
  varianceWindowDays: z.coerce.number().min(0).optional(),
});

/** PATCH /vehicles/:id (§E.4). `null` clears a field; `source` is required. Registration cannot change. */
export const vehiclePatchFields = z.object({
  make: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  variant: z.string().trim().max(120).nullable().optional(),
  bodyType: z.string().trim().max(60).nullable().optional(),
  yearOfManufacture: z.number().int().min(1900).max(2100).nullable().optional(),
  monthOfFirstRegistration: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
  fuelType: fuelType.nullable().optional(),
  transmission: transmission.nullable().optional(),
  colour: z.string().trim().max(60).nullable().optional(),
  engineCapacityCc: z.number().int().min(1).max(20_000).nullable().optional(),
  vin: z.string().trim().max(20).nullable().optional(),
  co2Gkm: z.number().int().min(0).max(1000).nullable().optional(),
  euroStatus: z.string().trim().max(40).nullable().optional(),
  taxStatus: z.string().trim().max(60).nullable().optional(),
  taxDueDate: isoDate.nullable().optional(),
  motStatus: z.string().trim().max(60).nullable().optional(),
  motExpiryDate: isoDate.nullable().optional(),
  gtaGroup: z
    .string()
    .trim()
    .transform((g) => g.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{1,3}\d{0,2}$/, 'expected a GTA group code like M1'))
    .nullable()
    .optional(),
  spec: vehicleSpecSchema.nullable().optional(),
});
export const vehiclePatchBody = vehiclePatchFields.extend({ source: vehicleSourceSchema });

export const onFileQuery = z.object({
  registration: z.string().trim().min(1).max(12),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export type VehicleInput = z.infer<typeof vehicleInput>;
export type VehicleSpecInput = z.infer<typeof vehicleSpecSchema>;
export type VehicleSourceBody = z.infer<typeof vehicleSourceSchema>;
export type VehiclePatchBody = z.infer<typeof vehiclePatchBody>;
export type VehicleRef = z.infer<typeof vehicleRef>;
