/**
 * Merge fields, mappings and fill plans for the DOCX templates (design doc §B). Re-exported from
 * packages/documents/src/index.ts.
 *
 *   const scan = scanDocx(builtinAssetBytes(id));
 *   const plan = buildFillPlan(scan, builtinMapping(id), source, { values, confirm, variant });
 *   const { docx } = fillDocx(builtinAssetBytes(id), plan.instructions, { removeBlocks: plan.removeBlocks, coreProps, now });
 */
export type {
  BlockRule,
  BuiltinDocxTemplate,
  BuiltinRecipientRole,
  BuiltinTemplateKind,
  FieldDef,
  FieldGroup,
  FieldType,
  FieldValue,
  FillPlan,
  FillPlanIssue,
  FillPolicy,
  FormatName,
  GuardContext,
  GuardId,
  GuardResult,
  MappingEntry,
  MappingIssue,
  OptionBlankEntry,
  PlanInputType,
  PlanInputs,
  PlanOrigin,
  PlanRow,
  SlotInput,
  SlotSelector,
  SubjectKind,
  SuggestedEntry,
  TemplateMapping,
  TemplateVariant,
  VerificationStatus
} from './types.js';
export { sampleMergeSource, type MergeCompany, type MergeDocumentRef, type MergeEvidenceRef, type MergeHead, type MergeHire, type MergeRecipient, type MergeSource, type MergeUser } from './source.js';
export { CONDITION_PANELS, FIELD_DEFS, getFieldDef, listFieldGroups } from './dictionary.js';
export { resolveField } from './resolve.js';
export { formatForSlot, slotValueDisplay } from './format.js';
export { isStricterOrEqual, matchSelector, mergeMappings, POLICY_RANK, resolveSelectors, unmappedSlots, validateMapping } from './mapping.js';
export { PRINTED_ACCOUNT_NAME, PRINTED_RATES, runTemplateGuards } from './guards.js';
export { ACCEPT_SCORE, suggestMapping } from './automap.js';
export { buildFillPlan, DOCX_GTA_BENCHMARK_NOTE, OPTION_BLANK_SEPARATOR } from './plan.js';
export { composeLetterheadDocx } from './letterhead.js';
export { BUILTIN_DOCX_TEMPLATES, builtinAssetBytes, builtinAssetPath, builtinMapping, isBuiltinDocxTemplate, LETTERHEAD_TEMPLATE_ID } from './builtin/index.js';
