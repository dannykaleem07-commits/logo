/**
 * Merge-field dictionary, mapping and fill-plan types (design doc §B.3, §B.6–§B.9, §C.1).
 *
 * Everything except `FieldDef.resolve` is plain JSON so the API can hand plans, mappings and template metadata to the
 * web app unchanged (the web cannot import this package; apps/web/src/api/templatesApi.ts mirrors these shapes).
 */
import type { ISODate, ISODateTime, Pence, Verification } from '@ccguk/domain';
import type { DocxScan, FillInstruction, RunStyle, SlotKind } from '../types.js';
import type { MergeSource } from './source.js';

export type VerificationStatus = Verification['status'];

// ---------------------------------------------------------------------------
// Field definitions (§B.3)
// ---------------------------------------------------------------------------

export type FieldType = 'text' | 'multiline' | 'date' | 'datetime' | 'time' | 'money' | 'int' | 'bool' | 'choice' | 'list' | 'rows';

export type FillPolicy =
  | 'auto' // always filled from data when present
  | 'auto-if-known' // filled when the data exists; otherwise left blank for the handler
  | 'suggest' // pre-filled from data but the handler must tick "confirm" before it prints
  | 'handler' // only a value typed by the handler; no resolver output is ever printed
  | 'post-event' // filled only from a recorded event; blank at first generation
  | 'signature' // never filled
  | 'never'; // left exactly as printed

export type FormatName =
  | 'auto'
  | 'date-boxes'
  | 'date-compact'
  | 'date-long'
  | 'datetime-boxes'
  | 'datetime-compact'
  | 'time'
  | 'month-year-boxes'
  | 'money'
  | 'money-digits'
  | 'reg'
  | 'upper'
  | 'title'
  | 'ordinal'
  | 'miles'
  | 'int'
  | 'lines'
  | 'inline';

export type FieldValue =
  | { t: 'text'; v: string }
  | { t: 'date'; v: ISODate; precision?: 'day' | 'month' } // precision 'month': v = 'YYYY-MM'
  | { t: 'datetime'; v: ISODateTime }
  | { t: 'time'; v: string } // 'HH:MM' Europe/London
  | { t: 'money'; v: Pence; verification?: VerificationStatus }
  | { t: 'int'; v: number; unit?: string }
  | { t: 'bool'; v: boolean }
  | { t: 'choice'; v: string[] } // canonical option codes from FieldDef.choices
  | { t: 'list'; v: string[] }
  | { t: 'rows'; v: Array<Record<string, string>> };

export type FieldGroup =
  | 'Company'
  | 'Document'
  | 'Handler'
  | 'Claim'
  | 'Client'
  | 'Client vehicle'
  | 'Accident'
  | 'Third party'
  | 'Insurers'
  | 'Hire'
  | 'Hire vehicle'
  | 'Storage'
  | 'Recovery'
  | 'Engineer'
  | 'Payment'
  | 'Witness'
  | 'Intervention'
  | 'Means'
  | 'Evidence'
  | 'Diary'
  | 'Recipient';

export interface FieldDef {
  key: string;
  group: FieldGroup;
  label: string;
  type: FieldType;
  /** Default; a mapping entry may only make it stricter, never laxer. */
  policy: FillPolicy;
  /** Normalised label phrases for auto-mapping uploaded templates (the label itself is always a synonym). */
  synonyms: string[];
  /** Documentation of where the value comes from. */
  sourcePath: string;
  /** code → option-text matchers (slugified prefixes of the template's option slugs). */
  choices?: Record<string, { label: string; matches: string[] }>;
  /** Default true; false = handler input refused (bank details). */
  overridable?: boolean;
  /** GTA rates: printed only when verified or confirmed by the handler. */
  requiresConfirmationUnlessVerified?: boolean;
  /** Aliases accepted by getFieldDef (Appendix 1). */
  aliases?: string[];
  /** 'rows' fields: row key → column-slug prefixes it fills (besides the key itself). */
  columns?: Record<string, string[]>;
  /** Absent for 'handler' fields. */
  resolve?(src: MergeSource): FieldValue | undefined;
}

// ---------------------------------------------------------------------------
// Mappings (§B.6)
// ---------------------------------------------------------------------------

export interface SlotSelector {
  /** Exact slot id (uploaded templates always use this). */
  id?: string;
  /** Prefix match against any element of sectionPath. */
  section?: string;
  /** Prefix match against the slot qualifier. */
  qualifier?: string;
  /** Exact labelSlug. */
  label?: string;
  kind?: SlotKind;
  /** 1-based among the matches. */
  nth?: number;
  part?: 'header' | 'footer' | 'body';
}

/** A blank printed inside one option of a choice slot (`☐ Other: ______`) — fills independently of the ticks. */
export interface OptionBlankEntry {
  key?: string;
  policy?: FillPolicy;
  format?: FormatName;
  onlyIf?: { key: string; equals?: string | boolean };
  label?: string;
  note?: string;
}

export interface MappingEntry {
  /** string = exact id. */
  slot: SlotSelector | string;
  /** FieldDef key; absent = handler free text with `label`. */
  key?: string;
  /** May only be stricter than the FieldDef default. */
  policy?: FillPolicy;
  format?: FormatName;
  /** checkbox: tick when the field value equals/includes this code. */
  when?: string;
  /** Fill only when another field resolves to this. */
  onlyIf?: { key: string; equals?: string | boolean };
  /** Generation blocked (VALUES_REQUIRED) until a value exists. */
  required?: boolean;
  /** Warning only. */
  requiredBeforeSigning?: boolean;
  removeIfEmpty?: 'paragraph' | 'row';
  /** Only in these variants. */
  variants?: string[];
  label?: string;
  group?: string;
  note?: string;
  /** Additive (fields slice): option slug prefix → what fills the blank inside that option. */
  optionBlanks?: Record<string, OptionBlankEntry>;
}

export interface TemplateVariant {
  id: string;
  label: string;
  removeBlocks?: string[];
  default?: boolean;
}

export type SubjectKind = 'witness' | 'offer' | 'hire' | 'recipient';

export type GuardId =
  | 'bankAccountName'
  | 'bankRequired'
  | 'printedRates'
  | 'signatoryDirector'
  | 'signatoryRole'
  | 'openRecordsNoNow'
  | 'hireReference'
  | 'witnessRelationship'
  | 'ratePositionInstruction';

export interface BlockRule {
  block: string;
  removeWhen: { key: string; empty?: true; equals?: string | boolean };
}

export interface TemplateMapping {
  schemaVersion: 1;
  templateId: string;
  /** Built-ins: sha256 of the asset the mapping was curated against. */
  sourceSha256?: string;
  entries: MappingEntry[];
  /** Slots shown as "left as printed". */
  ignore?: Array<SlotSelector | string>;
  variants?: TemplateVariant[];
  blocks?: BlockRule[];
  guards?: GuardId[];
  subjects?: SubjectKind[];
  style?: { valueRun?: RunStyle };
}

export interface MappingIssue {
  code: 'SELECTOR_NO_MATCH' | 'SELECTOR_AMBIGUOUS' | 'UNKNOWN_KEY' | 'KIND_MISMATCH' | 'POLICY_LAXER' | 'DUPLICATE_SLOT';
  /** Index into mapping.entries; -1 for an ignore selector, block rule or variant. */
  entry: number;
  detail: string;
}

// ---------------------------------------------------------------------------
// Guards (§B.7)
// ---------------------------------------------------------------------------

export interface GuardResult {
  code: string;
  severity: 'block' | 'warn';
  message: string;
  slotId?: string;
}

export interface GuardContext {
  scan: DocxScan;
  source: MergeSource;
  /** Field key → the value that will print (undefined = blank). */
  values: Map<string, FieldValue | undefined>;
  /** Additive: the chosen variant (printedRates blocks in the 02 `submission` variant). */
  variant?: string;
  templateId?: string;
  /** Additive: keys whose value was typed by the handler (an explicit entry is not a derived end date). */
  handlerKeys?: Set<string>;
  /** Additive: field key → the first slot that prints it (so a guard issue can point at the row that clears it). */
  slotIdsByKey?: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Auto-mapping (§B.8)
// ---------------------------------------------------------------------------

export interface SuggestedEntry {
  slotId: string;
  key?: string;
  policy: FillPolicy;
  score: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Fill plan (§B.9)
// ---------------------------------------------------------------------------

/** null = leave blank. */
export type SlotInput = string | number | boolean | string[] | Array<Record<string, string>> | null;

export interface PlanInputs {
  /** slot id → input. Option blanks are addressed as `<slotId>|<optionSlug>`. */
  values?: Record<string, SlotInput>;
  /** Slot ids whose suggested / unverified value the handler confirmed. */
  confirm?: string[];
  /**
   * Additive: slot id → the text that was on screen when it was confirmed (re-generation). A confirmation only
   * stands while the value still prints the same; a changed figure needs confirming again.
   */
  confirmedDisplay?: Record<string, string>;
  variant?: string;
}

export type PlanInputType = 'text' | 'multiline' | 'date' | 'datetime' | 'time' | 'money' | 'int' | 'checkbox' | 'choice' | 'rows' | 'paragraphs';
export type PlanOrigin = 'claim' | 'settings' | 'derived' | 'suggested' | 'handler' | 'none';

export interface PlanRow {
  slotId: string;
  section: string;
  sectionTitle: string;
  label: string;
  kind: SlotKind;
  inputType: PlanInputType;
  options?: Array<{ value: string; label: string }>;
  multiple?: boolean;
  columns?: Array<{ id: string; label: string }>;
  key?: string;
  policy: FillPolicy;
  editable: boolean;
  /** Raw (ISO date, pence, boolean, option slugs, text). */
  value: SlotInput;
  /** Exactly what will print ('' = left blank). */
  display: string;
  origin: PlanOrigin;
  sourcePath?: string;
  verification?: VerificationStatus;
  needsConfirmation: boolean;
  confirmed: boolean;
  required: boolean;
  missing: boolean;
  note?: string;
  widthTwips?: number;
  preview: string;
}

export interface FillPlanIssue {
  code: string;
  severity: 'block' | 'warn';
  message: string;
  slotId?: string;
}

export interface FillPlan {
  templateId: string;
  variant?: string;
  rows: PlanRow[];
  instructions: FillInstruction[];
  removeBlocks: string[];
  /** guards + VALUES_REQUIRED + SLOT_NOT_FILLABLE + mapping issues. */
  issues: FillPlanIssue[];
}

// ---------------------------------------------------------------------------
// Built-in templates (§C.1)
// ---------------------------------------------------------------------------

export type BuiltinTemplateKind = 'agreement' | 'statement' | 'form' | 'letter';
export type BuiltinRecipientRole = 'client' | 'at_fault_insurer';

export interface BuiltinDocxTemplate {
  id: string;
  file: string;
  kind: BuiltinTemplateKind;
  title: string;
  recipientRole: BuiltinRecipientRole;
  subjects: SubjectKind[];
  variants: TemplateVariant[];
  knownWarnings: Array<{ code: 'BRAND_CLAIM_IMAGE' | 'LEGACY_DETAIL' | 'REGULATED_STATUS'; message: string }>;
}
