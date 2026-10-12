// owned by claimai-server
/**
 * Claim AI input (docs/CLAIM-AI-INPUT.md §3.1): the vocabulary shared by the pure modules in this folder and the API's
 * claimai module. Pure types and constants only.
 */
import type { ISODateTime } from '../types.js';

export const ACTION_TYPES = [
  'event', 'note', 'field_update', 'liability_position', 'hire_end', 'hire_correct', 'hire_start', 'task', 'instruction',
  'pause_agents', 'resume_agents', 'run_job', 'money', 'offer_received', 'offer_decision', 'legal', 'status_change', 'close_or_decline',
  'private_note', 'unsupported', 'file_evidence', 'record_correspondence',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export const isActionType = (v: unknown): v is ActionType => typeof v === 'string' && (ACTION_TYPES as readonly string[]).includes(v);

/** What the AI may propose (catch-up types are made by code only). */
export const AI_ACTION_TYPES: readonly ActionType[] = ACTION_TYPES.filter((t) => t !== 'file_evidence' && t !== 'record_correspondence' && t !== 'unsupported');

export type ActionTier = 'apply' | 'confirm' | 'needs_you' | 'open_screen' | 'refused' | 'private';
export const ACTION_TIERS: readonly ActionTier[] = ['apply', 'confirm', 'needs_you', 'open_screen', 'refused', 'private'];
export type ActionState = 'proposed' | 'applied' | 'not_applied' | 'skipped' | 'failed' | 'needs_you' | 'undone';

export const JOB_KINDS = ['draft_letter', 'send_document', 'chase', 'request_documents', 'review_now', 'replan'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const CONTACT_ROLES = ['client', 'at_fault_insurer', 'engineer', 'repairer', 'supplier', 'solicitor', 'anyone'] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

export const AGENT_SCOPES = ['all', 'autopilot', 'case_manager', 'mail', 'drafter', 'intake'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export type InstructionEffect =
  | { kind: 'hold_contact'; contacts: ContactRole[] } // nothing goes to them (drafts wait; sends ask) until `until`
  | { kind: 'ask_before_sending'; contacts: ContactRole[] } // every send to them asks the owner
  | { kind: 'pause_agents' } // agents paused on the claim until `until` (resumed by claim.instruction_due)
  | { kind: 'none' }; // guidance for the AI agents only

/** Chronology types an owner update may write directly (everything else is another action type or another tier). */
export const OWNER_EVENT_TYPES = [
  'call', 'note', 'letter_in', 'letter_out', 'email_in', 'email_out', 'handling_ref_received', 'engineer_instructed',
  'inspection', 'estimate_received', 'repair_authorised', 'parts_ordered', 'parts_arrived', 'repair_started', 'repair_delay', 'repair_completed',
  'vehicle_returned', 'vehicle_collected', 'recovery', 'storage_started', 'storage_ended', 'total_loss_confirmed', 'ncaf_sent', 'chaser_sent',
  'cctv_request_sent', 'hire_start_notice_sent', 'pcn_received', 'nip_received', 's172_response_sent', 'salvage_released',
] as const;
export type OwnerEventType = (typeof OWNER_EVENT_TYPES)[number];
export const isOwnerEventType = (v: unknown): v is OwnerEventType => typeof v === 'string' && (OWNER_EVENT_TYPES as readonly string[]).includes(v);

/** Event types whose side effects touch other records — undo is "correct it in Chronology" (§6.3). */
export const SIDE_EFFECT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'repair_completed', 'tl_payment_received', 'insurer_termination_notice', 'cash_in_lieu_received', 'report_issued', 'intervention_offer',
]);

/** Statuses only the owner moves a claim into, from the status menu with a reason (mirror of the API perimeter's list). */
export const CLAIM_AI_FORBIDDEN_STATUSES: ReadonlySet<string> = new Set(['settled', 'closed', 'declined', 'pre_action', 'litigation']);

export interface ActionParams {
  eventType?: string;
  at?: string;
  precision?: 'date' | 'datetime';
  summary?: string;
  target?: string;
  value?: string;
  current?: string | null;
  hireId?: string;
  agreementNumber?: string;
  endTrigger?: string;
  startAt?: string;
  endAt?: string;
  taskKind?: string;
  dueAt?: string;
  note?: string;
  text?: string;
  appliesTo?: AgentScope[];
  effect?: InstructionEffect;
  until?: string | null;
  jobKind?: JobKind;
  templateId?: string | null;
  emailKind?: string | null;
  recipient?: ContactRole | null;
  evidenceIds?: string[];
  documentHint?: string | null;
  purpose?: string;
  head?: string;
  amountPence?: number;
  reference?: string | null;
  register?: 'settlement' | 'intervention';
  offeror?: string;
  matter?: string;
  status?: string;
  reason?: string;
  bundleFileId?: string;
  direction?: 'out' | 'in';
  kind?: string;
  channel?: string;
  dateSource?: string;
  counterpartyRole?: string | null;
  counterpartyName?: string | null;
  filename?: string;
  evidenceKind?: string;
  /** record_correspondence: a second event the record implies (first insurer letter → handling_ref_received). */
  alsoEventType?: string | null;
  /** record_correspondence: the claim-side evidence id (once filed / already on file). */
  evidenceId?: string | null;
  label?: string;
}

export type ActionSource = 'rules' | 'ai' | 'catch_up';
export type ActionFrom = 'owner_text' | 'transcript' | 'document';
export type EditableField = 'at' | 'value' | 'dueAt' | 'until' | 'text' | 'appliesTo';

export interface PlannedAction {
  key: string;
  type: ActionType;
  tier: ActionTier;
  ticked: boolean;
  tickable: boolean;
  title: string;
  detail: string | null;
  why: string | null;
  quote: string | null;
  source: ActionSource;
  from: ActionFrom;
  confidence: number;
  params: ActionParams;
  editable: EditableField[];
  undoable: boolean;
  undoWhy: string | null;
  link: string | null;
}

export interface Question {
  id: string;
  text: string;
  options: Array<{ id: string; label: string }>;
  allowText: boolean;
  allowDate: boolean;
  about: string | null;
}

export interface QuestionAnswer {
  optionId: string | null;
  text: string | null;
  date: string | null;
}

/**
 * Accusation words in the owner's own text (whole words only, so "applying" or "supplying" are not caught). Such a
 * clause or line is kept as a private note — never an instruction, event, prompt or outbound text. Output strings are
 * swept with the stricter `BANNED_INTAKE_WORDS` (substring) in tests.
 */
export const ACCUSATION_WORDS = /\b(?:fraud\w*|fake\w*|forg(?:e|ed|er|ers|ery|eries|ing)|dishonest\w*|lie|lies|lied|liar|liars|lying|scam\w*|suspicious\w*|staged)\b/i;

export const CLAIM_AI_DEFAULTS = {
  maxTextChars: 8000,
  maxExtraChars: 20_000,
  catchUpAutoMinConfidence: 0.8,
  filesDoneQuietMinutes: 10,
  lowConfidence: 0.7,
  historyPageSize: 50,
} as const;

/** One instruction as the pure modules see it (`claim_instructions` row → this view). */
export interface InstructionView {
  id: string;
  text: string;
  appliesTo: AgentScope[];
  effect: InstructionEffect | null;
  activeFrom: ISODateTime;
  until: ISODateTime | null;
}

export const isContactRole = (v: unknown): v is ContactRole => typeof v === 'string' && (CONTACT_ROLES as readonly string[]).includes(v);
export const isAgentScope = (v: unknown): v is AgentScope => typeof v === 'string' && (AGENT_SCOPES as readonly string[]).includes(v);
export const isJobKind = (v: unknown): v is JobKind => typeof v === 'string' && (JOB_KINDS as readonly string[]).includes(v);

/** A valid instruction effect (else null). */
export function parseEffect(v: unknown): InstructionEffect | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { kind?: unknown; contacts?: unknown };
  if (o.kind === 'pause_agents' || o.kind === 'none') return { kind: o.kind };
  if (o.kind === 'hold_contact' || o.kind === 'ask_before_sending') {
    const contacts = Array.isArray(o.contacts) ? [...new Set(o.contacts.filter(isContactRole))] : [];
    return contacts.length ? { kind: o.kind, contacts } : null;
  }
  return null;
}
