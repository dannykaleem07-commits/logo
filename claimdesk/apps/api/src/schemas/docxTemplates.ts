/**
 * Request schemas for the Word template library and DOCX claim documents (TEMPLATES-VEHICLES-DESKTOP §C.5).
 * Responses are the plain types declared in services/docxTemplates.ts (DocxTemplateSummary, DocxTemplateDetail,
 * ClaimTemplateValues) and GeneratedDocument.
 */
import { z } from 'zod';
import { id } from './common.js';

export const DOCX_TEMPLATE_KIND_VALUES = ['letter', 'form', 'agreement', 'statement', 'report', 'notice'] as const;
export const RECIPIENT_ROLE_VALUES = ['at_fault_insurer', 'client', 'own_insurer', 'court', 'supplier', 'other'] as const;
export const FILL_POLICY_VALUES = ['auto', 'auto-if-known', 'suggest', 'handler', 'post-event', 'signature', 'never'] as const;
export const FORMAT_NAME_VALUES = [
  'auto',
  'date-boxes',
  'date-compact',
  'date-long',
  'datetime-boxes',
  'datetime-compact',
  'time',
  'month-year-boxes',
  'money',
  'money-digits',
  'reg',
  'upper',
  'title',
  'ordinal',
  'miles',
  'int',
  'lines',
  'inline',
] as const;

/** Largest upload accepted (route-level multipart limit, §C.4). */
export const DOCX_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;

const boolString = z.enum(['true', 'false']).optional();

export const docxTemplateListQuery = z.object({ includeInactive: boolString });

export const docxTemplateUploadFields = z.object({
  title: z.string().trim().min(1, 'title is required').max(200),
  kind: z.enum(DOCX_TEMPLATE_KIND_VALUES),
  description: z.string().max(2000).optional(),
  recipientRole: z.enum(RECIPIENT_ROLE_VALUES).optional(),
});

export const docxTemplatePatchBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    active: z.boolean().optional(),
    recipientRole: z.enum(RECIPIENT_ROLE_VALUES).nullable().optional(),
  })
  .strict();

const onlyIf = z.object({ key: z.string().min(1), equals: z.union([z.string(), z.boolean()]).optional() });

const optionBlankEntry = z.object({
  key: z.string().min(1).optional(),
  policy: z.enum(FILL_POLICY_VALUES).optional(),
  format: z.enum(FORMAT_NAME_VALUES).optional(),
  onlyIf: onlyIf.optional(),
  label: z.string().max(200).optional(),
  note: z.string().max(1000).optional(),
});

/** A mapping entry as the editor saves it: `slot` is always an exact slot id. */
export const mappingEntryInput = z.object({
  slot: z.string().min(1).max(512),
  key: z.string().min(1).max(128).optional(),
  policy: z.enum(FILL_POLICY_VALUES).optional(),
  format: z.enum(FORMAT_NAME_VALUES).optional(),
  when: z.string().max(128).optional(),
  onlyIf: onlyIf.optional(),
  required: z.boolean().optional(),
  requiredBeforeSigning: z.boolean().optional(),
  removeIfEmpty: z.enum(['paragraph', 'row']).optional(),
  variants: z.array(z.string().min(1)).optional(),
  label: z.string().max(200).optional(),
  group: z.string().max(100).optional(),
  note: z.string().max(1000).optional(),
  optionBlanks: z.record(optionBlankEntry).optional(),
});

export const docxTemplateMappingBody = z.object({
  entries: z.array(mappingEntryInput).max(5000),
  ignore: z.array(z.string().min(1).max(512)).max(5000).optional(),
});

export const docxTestFillBody = z.object({ claimId: id.optional(), variant: z.string().min(1).max(64).optional() }).default({});

export const docxConvertersQuery = z.object({ refresh: boolString });

/** SlotInput: string | number | boolean | string[] | Array<Record<string, string>> | null. */
export const slotInput = z.union([z.string().max(20_000), z.number().finite(), z.boolean(), z.array(z.string().max(20_000)).max(500), z.array(z.record(z.string().max(5_000))).max(500), z.null()]);

export const docxSubject = z
  .object({
    witnessPartyId: id.optional(),
    offerId: id.optional(),
    hireAgreementId: id.optional(),
    recipientPartyId: id.optional(),
    exhibitEvidenceIds: z.array(id).max(100).optional(),
  })
  .strict();

export const generateDocxBody = z.object({
  templateId: z.string().min(1).max(128),
  variant: z.string().min(1).max(64).optional(),
  subject: docxSubject.optional(),
  values: z.record(slotInput).optional(),
  confirm: z.array(z.string().min(1).max(512)).max(5000).optional(),
});
export type GenerateDocxBody = z.infer<typeof generateDocxBody>;

export const claimTemplateValuesQuery = z.object({
  variant: z.string().min(1).max(64).optional(),
  witnessPartyId: id.optional(),
  offerId: id.optional(),
  hireAgreementId: id.optional(),
  recipientPartyId: id.optional(),
  /** Comma-separated evidence ids, in exhibit order. */
  exhibitEvidenceIds: z.string().max(5000).optional(),
});
export type ClaimTemplateValuesQuery = z.infer<typeof claimTemplateValuesQuery>;

/** Extra fields a DOCX document's supersede may carry (merged over the previous `_docx.inputs` / `confirm`). */
export const supersedeDocxExtra = z
  .object({
    values: z.record(slotInput).optional(),
    confirm: z.array(z.string().min(1).max(512)).max(5000).optional(),
  })
  .passthrough();
