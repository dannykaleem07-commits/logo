/**
 * Request schemas for big uploads and the import folder (SUPREME-DESIGN §0.3, §N.6 `uploads-desktop`).
 */
import { z } from 'zod';
import { evidenceKind } from './services.js';

export const UPLOAD_PURPOSES = ['evidence', 'intake', 'brain-packs', 'engineer-data'] as const;
export const uploadPurpose = z.enum(UPLOAD_PURPOSES);
export type UploadPurpose = z.infer<typeof uploadPurpose>;

export const IMPORT_PURPOSES = ['evidence', 'intake', 'mail', 'brain-packs', 'engineer-data'] as const;
export const importPurpose = z.enum(IMPORT_PURPOSES);

export const createUploadBody = z
  .object({
    filename: z.string().trim().min(1).max(260),
    /** Declared total size; the session completes only when exactly this many bytes have arrived. */
    bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    mime: z.string().trim().max(200).optional().default('application/octet-stream'),
    purpose: uploadPurpose,
    claimId: z.string().trim().min(1).max(64).optional(),
    /** Evidence text fields (kind, description, capturedAt, captureShot, sourceUrl, sha256) — validated like the multipart route. */
    fields: z.record(z.string().max(4000)).optional(),
  })
  .strict();
export type CreateUploadBody = z.infer<typeof createUploadBody>;

export const chunkQuery = z.object({ offset: z.coerce.number().int().min(0) });

export const completeUploadBody = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).strict();

export const listImportsQuery = z.object({
  purpose: importPurpose.optional(),
  status: z.enum(['staged', 'consumed', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const attachEvidenceBody = z.object({ claimId: z.string().trim().min(1).max(64), kind: evidenceKind.optional(), description: z.string().max(2000).optional() }).strict();
