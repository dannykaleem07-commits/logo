/**
 * Agent result contracts (§C.1, §C.3, §F.5, §G.2) and their hand-written strict JSON Schemas (§B.5).
 *
 * Every schema obeys the structured-output rules both drivers rely on: `additionalProperties: false` on every object,
 * every property listed in `required` (optional values are nullable instead), no `minimum`/`maximum`/`minLength`/
 * `maxLength`/`pattern`/`minItems`/`maxItems`/`multipleOf`/`$schema` keywords, and < 16 KB compact (the CLI receives
 * the schema on its command line). The gateway's zod twins enforce ranges (confidence 0..1, pence integers) server-side.
 */
import type { ISODateTime } from '../types.js';
import {
  BASIS_KINDS,
  DOC_TYPES,
  EMAIL_KINDS,
  FIELD_TARGETS,
  MAIL_INTENTS,
  TASK_KINDS,
  type Basis,
  type DocType,
  type EmailKind,
  type FieldTarget,
  type Handoff,
  type MailIntent,
  type TaskKind,
} from './types.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type Urgency = 'urgent' | 'high' | 'normal' | 'low';

/** `mail.triage` (§F.5): no tools, classification + extraction only. */
export interface MailTriageResult {
  intent: MailIntent;
  secondaryIntents: MailIntent[];
  confidence: number;
  summary: string;
  urgency: Urgency;
  extracted: {
    amountsPence: number[];
    deadlines: string[];
    theirRef: string | null;
    ourRef: string | null;
    vrm: string | null;
    docsRequested: string[];
    paymentRef: string | null;
    offerTerms: string | null;
    bankDetailsChange: boolean;
  };
  needsReply: boolean;
  injectionSuspected: boolean;
  injectionNotes: string | null;
}

/** One recommended step (the next best action, or a further action in `actions`). */
export interface CaseAction {
  /** A `PLAYBOOK_ACTION_CODES` code or `CUSTOM` (custom always asks). */
  code: string;
  title: string;
  why: string;
  basis: Basis[];
  confidence: number;
  dueAt: ISODateTime | null;
}

export interface CaseTaskPlan {
  kind: TaskKind;
  dueAt: ISODateTime;
  note: string;
  actionCode: string | null;
}

export interface OwnerQuestion {
  title: string;
  detail: string;
  /** What is missing (documents, facts). */
  missing: string[];
  /** true → a drafter hand-off prepares the request and the result goes to Needs-you `missing_info`. */
  prepareDraft: boolean;
}

export interface CaseRisk {
  severity: 'high' | 'medium' | 'low';
  text: string;
}

/** `case.review` (§C.5 step 3). */
export interface CaseReviewResult {
  situation: string;
  nextBestAction: CaseAction;
  actions: CaseAction[];
  handoffs: Handoff[];
  tasks: CaseTaskPlan[];
  questionsForOwner: OwnerQuestion[];
  risks: CaseRisk[];
  confidence: number;
}

/** `draft.compose`: the drafts the drafter created through its tools, plus anything it could not write. */
export interface DrafterResult {
  drafts: Array<{
    kind: 'document' | 'docx' | 'outbox';
    id: string;
    templateId: string | null;
    emailKind: EmailKind | null;
    purpose: string;
  }>;
  missingInfo: string[];
  notes: string;
  confidence: number;
}

export type ReviewIssueSeverity = 'block' | 'warn' | 'info';
export type ReviewTone = 'professional' | 'too_aggressive' | 'too_informal' | 'unclear';

/** `review.check` tier c (critic). The deterministic tiers produce the same issue shape. */
export interface ReviewVerdict {
  verdict: 'pass' | 'repair' | 'escalate';
  issues: Array<{ code: string; severity: ReviewIssueSeverity; where: string; message: string; fix: string | null }>;
  /** Does the draft answer what the incoming message asked? null when there is no incoming message. */
  answersIncoming: boolean | null;
  tone: ReviewTone;
  touches: { money: boolean; liability: boolean; settlement: boolean; legal: boolean; newCommitment: boolean };
  confidence: number;
}

export interface ExtractedField {
  /** The document's own label for the field (e.g. "Vehicle Identification Number"). */
  name: string;
  /** Where it would go on the claim; null when it maps to nothing. */
  target: FieldTarget | null;
  value: string | null;
  confidence: number;
  page: number | null;
  quote: string | null;
}

/** `intake.extract` (§G.2 step 3). */
export interface IntakeExtraction {
  docType: DocType;
  docTypeConfidence: number;
  summary: string;
  /** Built-in CCGUK template id when the file is a signed CCGUK form, else null. */
  formTemplateId: string | null;
  fields: ExtractedField[];
  warnings: string[];
}

export type OfferRecommendationKind = 'accept' | 'counter' | 'reject' | 'hold';

/** `offer.analyse`: analysis + recommendation only — the owner decides (§D.1 settlement). */
export interface OfferAnalysis {
  recommendation: OfferRecommendationKind;
  counterPence: number | null;
  reasoning: string;
  basis: Basis[];
  confidence: number;
  /** Figures the reasoning relies on, each from a Case Brief fact (code computed them; the model only cites). */
  figures: Array<{ label: string; factId: string | null; pence: number | null }>;
}

/** `research.ask`. */
export interface ResearchAnswer {
  answer: string;
  citations: Array<{ kind: 'kb' | 'pack' | 'memory'; id: string; verified: boolean }>;
  confidence: number;
}

export type ResultSchemaId = 'mail_triage' | 'case_review' | 'drafter' | 'review_verdict' | 'intake_extraction' | 'offer_analysis' | 'research_answer';
export const RESULT_SCHEMA_IDS: readonly ResultSchemaId[] = ['mail_triage', 'case_review', 'drafter', 'review_verdict', 'intake_extraction', 'offer_analysis', 'research_answer'];

export interface ResultTypes {
  mail_triage: MailTriageResult;
  case_review: CaseReviewResult;
  drafter: DrafterResult;
  review_verdict: ReviewVerdict;
  intake_extraction: IntakeExtraction;
  offer_analysis: OfferAnalysis;
  research_answer: ResearchAnswer;
}

// ---------------------------------------------------------------------------
// JSON Schema helpers (strict)
// ---------------------------------------------------------------------------

/** A JSON Schema document (plain JSON). */
export interface JsonSchema {
  [key: string]: unknown;
}

const str = (description?: string): JsonSchema => (description ? { type: 'string', description } : { type: 'string' });
const nstr = (description?: string): JsonSchema => (description ? { type: ['string', 'null'], description } : { type: ['string', 'null'] });
const num = (description?: string): JsonSchema => (description ? { type: 'number', description } : { type: 'number' });
const int = (description?: string): JsonSchema => (description ? { type: 'integer', description } : { type: 'integer' });
const nint = (description?: string): JsonSchema => (description ? { type: ['integer', 'null'], description } : { type: ['integer', 'null'] });
const bool = (description?: string): JsonSchema => (description ? { type: 'boolean', description } : { type: 'boolean' });
const nbool = (): JsonSchema => ({ type: ['boolean', 'null'] });
const strEnum = (values: readonly string[], description?: string): JsonSchema => ({ type: 'string', enum: [...values], ...(description ? { description } : {}) });
const nEnum = (values: readonly string[]): JsonSchema => ({ anyOf: [{ type: 'string', enum: [...values] }, { type: 'null' }] });
const arr = (items: JsonSchema, description?: string): JsonSchema => ({ type: 'array', items, ...(description ? { description } : {}) });
/** Strict object: every property required, no extra properties. */
export function strictObject(properties: Record<string, JsonSchema>, description?: string): JsonSchema {
  return { type: 'object', ...(description ? { description } : {}), properties, required: Object.keys(properties), additionalProperties: false };
}

const confidence = num('0..1');
const basis = strictObject({ kind: strEnum(BASIS_KINDS), id: str(), label: nstr() });
const isoOrNull = nstr('ISO 8601 date-time or null');

const caseAction = strictObject({
  code: str('PLAYBOOK action code or CUSTOM'),
  title: str(),
  why: str(),
  basis: arr(basis),
  confidence,
  dueAt: isoOrNull,
});

const handoff: JsonSchema = {
  anyOf: [
    strictObject({ to: strEnum(['mail_reply']), messageId: str(), plan: str(), keyPoints: arr(str()) }),
    strictObject({
      to: strEnum(['drafter']),
      templateId: nstr(),
      emailKind: nEnum(EMAIL_KINDS),
      purpose: str(),
      recipientPartyId: nstr(),
      replyToMessageId: nstr(),
      actionCode: nstr(),
      dueAt: isoOrNull,
    }),
    strictObject({ to: strEnum(['researcher']), question: str() }),
    strictObject({ to: strEnum(['offer_analyst']), offerId: str() }),
  ],
};

export const MAIL_TRIAGE_SCHEMA: JsonSchema = strictObject({
  intent: strEnum(MAIL_INTENTS),
  secondaryIntents: arr(strEnum(MAIL_INTENTS)),
  confidence,
  summary: str(),
  urgency: strEnum(['urgent', 'high', 'normal', 'low']),
  extracted: strictObject({
    amountsPence: arr(int(), 'integer pence'),
    deadlines: arr(str()),
    theirRef: nstr(),
    ourRef: nstr(),
    vrm: nstr(),
    docsRequested: arr(str()),
    paymentRef: nstr(),
    offerTerms: nstr(),
    bankDetailsChange: bool(),
  }),
  needsReply: bool(),
  injectionSuspected: bool(),
  injectionNotes: nstr(),
});

export const CASE_REVIEW_SCHEMA: JsonSchema = strictObject({
  situation: str(),
  nextBestAction: caseAction,
  actions: arr(caseAction),
  handoffs: arr(handoff),
  tasks: arr(strictObject({ kind: strEnum(TASK_KINDS), dueAt: str('ISO 8601 date-time'), note: str(), actionCode: nstr() })),
  questionsForOwner: arr(strictObject({ title: str(), detail: str(), missing: arr(str()), prepareDraft: bool() })),
  risks: arr(strictObject({ severity: strEnum(['high', 'medium', 'low']), text: str() })),
  confidence,
});

export const DRAFTER_SCHEMA: JsonSchema = strictObject({
  drafts: arr(strictObject({ kind: strEnum(['document', 'docx', 'outbox']), id: str(), templateId: nstr(), emailKind: nEnum(EMAIL_KINDS), purpose: str() })),
  missingInfo: arr(str()),
  notes: str(),
  confidence,
});

export const REVIEW_VERDICT_SCHEMA: JsonSchema = strictObject({
  verdict: strEnum(['pass', 'repair', 'escalate']),
  issues: arr(strictObject({ code: str(), severity: strEnum(['block', 'warn', 'info']), where: str(), message: str(), fix: nstr() })),
  answersIncoming: nbool(),
  tone: strEnum(['professional', 'too_aggressive', 'too_informal', 'unclear']),
  touches: strictObject({ money: bool(), liability: bool(), settlement: bool(), legal: bool(), newCommitment: bool() }),
  confidence,
});

export const INTAKE_EXTRACTION_SCHEMA: JsonSchema = strictObject({
  docType: strEnum(DOC_TYPES),
  docTypeConfidence: confidence,
  summary: str(),
  formTemplateId: nstr(),
  fields: arr(strictObject({ name: str(), target: nEnum(FIELD_TARGETS), value: nstr(), confidence, page: nint('1-based page'), quote: nstr() })),
  warnings: arr(str()),
});

export const OFFER_ANALYSIS_SCHEMA: JsonSchema = strictObject({
  recommendation: strEnum(['accept', 'counter', 'reject', 'hold']),
  counterPence: nint('integer pence'),
  reasoning: str(),
  basis: arr(basis),
  confidence,
  figures: arr(strictObject({ label: str(), factId: nstr(), pence: nint() })),
});

export const RESEARCH_ANSWER_SCHEMA: JsonSchema = strictObject({
  answer: str(),
  citations: arr(strictObject({ kind: strEnum(['kb', 'pack', 'memory']), id: str(), verified: bool() })),
  confidence,
});

export const RESULT_SCHEMAS: Readonly<Record<ResultSchemaId, JsonSchema>> = {
  mail_triage: MAIL_TRIAGE_SCHEMA,
  case_review: CASE_REVIEW_SCHEMA,
  drafter: DRAFTER_SCHEMA,
  review_verdict: REVIEW_VERDICT_SCHEMA,
  intake_extraction: INTAKE_EXTRACTION_SCHEMA,
  offer_analysis: OFFER_ANALYSIS_SCHEMA,
  research_answer: RESEARCH_ANSWER_SCHEMA,
};

/** Compact JSON size limit for a result schema (the CLI receives it on the command line, §A.2/§B.5). */
export const MAX_RESULT_SCHEMA_BYTES = 16 * 1024;

/** Keywords strict structured outputs do not support (§B.5). */
export const UNSUPPORTED_SCHEMA_KEYWORDS: readonly string[] = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', '$schema'];

/**
 * Problems that make `schema` unusable as a strict schema: an object without `additionalProperties: false`, a property
 * missing from `required`, or an unsupported keyword. Empty array = strict. The gateway's `toStrictSchema` test reuses it.
 */
export function strictSchemaProblems(schema: unknown, path = '$'): string[] {
  const out: string[] = [];
  if (Array.isArray(schema)) {
    schema.forEach((s, i) => out.push(...strictSchemaProblems(s, `${path}[${i}]`)));
    return out;
  }
  if (!schema || typeof schema !== 'object') return out;
  const s = schema as Record<string, unknown>;
  for (const k of UNSUPPORTED_SCHEMA_KEYWORDS) if (k in s) out.push(`${path}: unsupported keyword "${k}"`);
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (types.includes('object') || s.properties !== undefined) {
    if (s.additionalProperties !== false) out.push(`${path}: object without additionalProperties:false`);
    const props = (s.properties ?? {}) as Record<string, unknown>;
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    for (const k of Object.keys(props)) if (!required.includes(k)) out.push(`${path}.${k}: not in required`);
    for (const k of required) if (!(k in props)) out.push(`${path}: required "${k}" has no property`);
    for (const [k, v] of Object.entries(props)) out.push(...strictSchemaProblems(v, `${path}.${k}`));
  }
  if (s.items !== undefined) out.push(...strictSchemaProblems(s.items, `${path}[]`));
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) if (s[key] !== undefined) out.push(...strictSchemaProblems(s[key], `${path}.${key}`));
  for (const key of ['$defs', 'definitions'] as const) {
    const defs = s[key];
    if (defs && typeof defs === 'object') for (const [k, v] of Object.entries(defs as Record<string, unknown>)) out.push(...strictSchemaProblems(v, `${path}.${key}.${k}`));
  }
  return out;
}

/** Compact JSON byte length of a schema (UTF-8). */
export const compactSchemaBytes = (schema: JsonSchema): number => new TextEncoder().encode(JSON.stringify(schema)).length;
