/**
 * @ccguk/kb types.
 *
 * The content types (KbEntry, InsurerDirectoryEntry, GtaRate, Verification, PlaybookAction) are owned by
 * @ccguk/domain and re-exported here so consumers can import everything KB-related from one place. The
 * types that only the knowledge base needs (PlaybookRule, CourtFeeBand, search/advice results) live here.
 */
import type { ISODate, KbEntry, PlaybookAction, Verification } from '@ccguk/domain';

export type {
  KbEntry,
  KbEntryType,
  InsurerDirectoryEntry,
  GtaRate,
  Verification,
  PlaybookAction,
  Pence,
  ISODate,
  ISODateTime,
} from '@ccguk/domain';
/** Domain fee band (issue / small-claims hearing) consumed by `quantum.courtFee`. */
export type { FeeBand, FeeKind } from '@ccguk/domain';

export type VerificationStatus = Verification['status'];

/** All KbEntry types the loaders accept — mirrors `KbEntryType` in the domain so the validator can enumerate it. */
export const KB_ENTRY_TYPES = [
  'case',
  'statute',
  'cpr',
  'practice_direction',
  'gta',
  'fca_handbook',
  'fos',
  'guidance',
  'code_of_practice',
  'fee',
] as const;

export const VERIFICATION_STATUSES = ['verified', 'unverified', 'failed', 'stale'] as const;

export const LICENCES = ['OGL', 'Open Justice Licence', 'link_only', 'quote_only'] as const;
export type Licence = (typeof LICENCES)[number];

// ---------------------------------------------------------------------------
// Court fees (kb/data/court-fees.json)
// ---------------------------------------------------------------------------

/** Every fee kind the EX50 table carries. The domain's `FeeKind` is the subset `issue | hearing_small_claims`. */
export type CourtFeeKind = 'issue' | 'hearing_small_claims' | 'hearing_fast' | 'application';
export const COURT_FEE_KINDS: readonly CourtFeeKind[] = ['issue', 'hearing_small_claims', 'hearing_fast', 'application'];

/**
 * A row of the court-fee table as stored in JSON. `toPence: null` means an open-ended band. Either a fixed
 * `feePence` or an ad valorem `pct` (with optional `capPence`) is present. Convert to the domain shape with
 * `toDomainFeeBands()` before handing it to `quantum.courtFee`.
 */
export interface CourtFeeBand {
  kind: CourtFeeKind;
  fromPence: number;
  toPence: number | null;
  feePence?: number;
  pct?: number;
  capPence?: number;
  verification: Verification;
  note?: string;
}

// ---------------------------------------------------------------------------
// Playbook rules (kb/data/playbook-rules.json) — BLUEPRINT §7, consumed by domain/playbook via injection
// ---------------------------------------------------------------------------

export type PlaybookStage =
  | 'day_1'
  | 'days_1_7'
  | 'sign_up'
  | 'during_hire'
  | 'hire_end'
  | 'payment'
  | 'chase'
  | 'escalation'
  | 'litigation'
  | 'onboarding'
  | 'perimeter';

export const PLAYBOOK_STAGES: readonly PlaybookStage[] = [
  'day_1',
  'days_1_7',
  'sign_up',
  'during_hire',
  'hire_end',
  'payment',
  'chase',
  'escalation',
  'litigation',
  'onboarding',
  'perimeter',
];

export const PLAYBOOK_PRIORITIES: readonly PlaybookAction['priority'][] = ['now', 'today', 'this_week', 'scheduled'];

export type DueKind = 'working_days' | 'calendar_days' | 'calendar_months' | 'immediate';
export const DUE_KINDS: readonly DueKind[] = ['working_days', 'calendar_days', 'calendar_months', 'immediate'];

export interface PlaybookDue {
  kind: DueKind;
  /** Count of units; absent for `immediate`. */
  n?: number;
  /** Anchor event name in the claim chronology (e.g. 'hire_start', 'payment_pack_sent'). */
  from: string;
}

/** The BLUEPRINT §7 action codes, in the order the ARCHITECTURE playbook row lists them. */
export const PLAYBOOK_ACTION_CODES = [
  'SEND_NCAF',
  'REQUEST_HANDLING_REF',
  'REQUEST_CCTV',
  'REPLY_TO_INTERVENTION_OFFER',
  'COLLECT_IMPECUNIOSITY_EVIDENCE',
  'FIX_ENFORCEABILITY',
  'SEND_COLLECT_OR_PAY',
  'SEND_DELAY_NOTICE',
  'END_HIRE_NOW',
  'SEND_PAYMENT_PACK',
  'SPLIT_HEADS_INTERIM',
  'CHASER_7',
  'CHASER_14',
  'CHASER_21',
  'COMPLAINT_28',
  'SEND_DSAR',
  'ICOBS_INTEREST_CLAIM',
  'LETTER_BEFORE_CLAIM',
  'PART36_OFFER',
  'DEFAULT_JUDGMENT',
  'VENDOR_VERIFICATION_PACK',
  'REFER_INJURY',
  // Autopilot step codes (SUPREME-AUTOPILOT §A.3)
  'OFFER_HIRE',
  'CONFIRM_BOOKING',
  'SCHEDULE_DELIVERY',
  'PREPARE_HIRE_PACK',
  'SIGNUP_PACK',
  'CHASE_SIGNATURES',
  'NOTIFY_HIRE_START',
  'INSTRUCT_ENGINEER',
  'ARRANGE_RECOVERY',
  'BOOK_COLLECTION',
  'RAISE_INVOICES',
  'PAY_CLIENT',
  'CLOSE_FILE',
  'CHECK_NEED',
  'DRIVER_ELIGIBILITY',
] as const;
export type PlaybookActionCode = (typeof PLAYBOOK_ACTION_CODES)[number];

/**
 * A codified get-paid-faster step. `domain/playbook.nextActions` turns a rule into a `PlaybookAction` by
 * resolving `due` against the claim chronology and `blockedBy` against the evidence gates.
 */
export interface PlaybookRule {
  code: PlaybookActionCode;
  /** Sort key within the plan. */
  order: number;
  /** BLUEPRINT §7 step (1–8) this rule mirrors. */
  blueprintStep: number;
  stage: PlaybookStage;
  title: string;
  /** One or two sentences, cites the basis in words. */
  why: string;
  /** KbEntry ids — every one must resolve in the knowledge base. */
  basis: string[];
  /** Document template to generate, or null when the step is a task/court form with no CCGUK document. */
  templateId: string | null;
  priority: PlaybookAction['priority'];
  /** Human-readable firing condition. */
  trigger: string;
  due: PlaybookDue | null;
  /** Evidence gate names (or action codes) that must be satisfied first. */
  blockedBy?: string[];
  /** True when the basis is a GTA term CCGUK may only quote as an industry benchmark (GTA 2.7(j)). */
  benchmarkOnly?: boolean;
  /** The money.md discipline: what the step is worth or protects. */
  valueNote?: string;
  /** Perimeter / forum-not-open warning the generated document must carry. */
  forumCheck?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Search and advice results
// ---------------------------------------------------------------------------

export interface SearchHit {
  entry: KbEntry;
  score: number;
  /** Short field-prefixed snippets around the matched terms, e.g. "principle: … impecunious claimant …". */
  highlights: string[];
}

export interface SearchOptions {
  types?: KbEntry['type'][];
  topics?: string[];
  /** Default 10. */
  limit?: number;
}

export interface AdvicePoint {
  text: string;
  /** KbEntry ids. */
  citations: string[];
}

export interface Advice {
  topic: string;
  summary: string;
  points: AdvicePoint[];
  caveats: string[];
  /** Forum / perimeter checks (FORUM_NOT_OPEN, GTA benchmark, reserved legal activity, injury referral). */
  forumChecks: string[];
  /** Cited entry ids whose verification is not 'verified' (or that do not exist in the KB). */
  unverifiedCitations: string[];
}

export interface PaidFasterStep {
  step: number;
  /** BLUEPRINT §7 step (1–8). */
  blueprintStep: number;
  code: PlaybookActionCode;
  title: string;
  why: string;
  timing: string;
  citations: string[];
  templateId: string | null;
  benchmarkOnly: boolean;
  unverifiedCitations: string[];
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

export type DirectoryStatus = 'green' | 'amber' | 'red';

export interface CopycatMatch {
  entryId: string;
  name: string;
  kind: 'number' | 'domain';
  /** The blacklist value (or pattern) that matched. */
  pattern: string;
  /** The normalised input that was tested. */
  input: string;
}

export interface DirectoryAgeing {
  status: DirectoryStatus;
  ageDays: number | null;
  reasons: string[];
  today: ISODate;
}
