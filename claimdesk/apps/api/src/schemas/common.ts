import { z } from 'zod';

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const isoDateTime = z
  .string()
  .min(10)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'expected an ISO 8601 date-time');
export const pence = z.number().int().min(0);
export const signedPence = z.number().int();
export const id = z.string().min(1).max(128);
export const vatRate = z.number().min(0).max(1);

export const verificationSchema = z.object({
  status: z.enum(['verified', 'unverified', 'failed', 'stale']),
  sourceUrl: z.string().url().optional(),
  sourceNote: z.string().optional(),
  verifiedAt: isoDate.optional(),
  verifiedBy: z.string().optional(),
});

export const addressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  town: z.string().optional(),
  county: z.string().optional(),
  postcode: z.string().min(2),
  country: z.string().optional(),
});

export const bankDetailsSchema = z.object({
  accountName: z.string().min(1),
  sortCode: z.string().min(6),
  accountNumber: z.string().min(6),
  bankName: z.string().optional(),
});

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const idParams = z.object({ id: id });

/** Parse with zod; a ZodError propagates to the app error handler (→ 400 VALIDATION). */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}
