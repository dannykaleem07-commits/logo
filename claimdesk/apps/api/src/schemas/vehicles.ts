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

export type VehicleInput = z.infer<typeof vehicleInput>;
export type VehicleRef = z.infer<typeof vehicleRef>;
