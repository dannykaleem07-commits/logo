// owned by ap-foundation (contracts); steps.ts / facts.ts / predicates.ts / plan.ts by ap-autopilot
/**
 * Claim Autopilot contracts (docs/SUPREME-AUTOPILOT.md §A.2, §A.7, §D.2): lifecycle stages, the step catalogue's
 * shape, step modes, per-step plan state, the derived plan, per-claim overrides and hire offers. Pure types and
 * constants only. The plan is derived from records every tick and is never the source of truth.
 */
import type { ClaimStatus, ClockKind, ISODateTime, Id } from '../types.js';
import type { EmailKind, NeedsYouKind, ToolName } from '../agents/types.js';
import type { ClashCode } from '../clash/types.js';
import type { PackStage } from '../signing/types.js';

// ---------------------------------------------------------------------------
// Stages and tracks (§A.1)
// ---------------------------------------------------------------------------

export type StageId =
  | 'enquiry'
  | 'intake'
  | 'qualification'
  | 'sign_up'
  | 'vehicle_secured'
  | 'hire_search'
  | 'hire_offer'
  | 'hire_booked'
  | 'handover'
  | 'on_hire'
  | 'off_hire'
  | 'billing'
  | 'recovery'
  | 'closure';
export type TerminalStage = 'declined' | 'closed' | 'legal';

/** The 14 stages in table order (§A.1). */
export const STAGE_ORDER: readonly StageId[] = [
  'enquiry',
  'intake',
  'qualification',
  'sign_up',
  'vehicle_secured',
  'hire_search',
  'hire_offer',
  'hire_booked',
  'handover',
  'on_hire',
  'off_hire',
  'billing',
  'recovery',
  'closure',
];
export const TERMINAL_STAGES: readonly TerminalStage[] = ['declined', 'closed', 'legal'];

export type TrackId = 'intake' | 'qualify' | 'signup' | 'notify' | 'vehicle' | 'hire' | 'money' | 'close';
export const TRACK_IDS: readonly TrackId[] = ['intake', 'qualify', 'signup', 'notify', 'vehicle', 'hire', 'money', 'close'];

/** auto = act (still through decide()); confirm = prepare + Needs-you; owner = a person does it (agents denied). */
export type StepMode = 'auto' | 'confirm' | 'owner';
export const STEP_MODES: readonly StepMode[] = ['auto', 'confirm', 'owner'];
export const STEP_MODE_RANK: Readonly<Record<StepMode, number>> = { auto: 0, confirm: 1, owner: 2 };
/** The stricter of two modes. */
export const stricterMode = (a: StepMode, b: StepMode): StepMode => (STEP_MODE_RANK[a] >= STEP_MODE_RANK[b] ? a : b);

export type Performer = 'code' | 'ai_wording' | 'ai_judgement' | 'person';
export type StepStatus = 'not_applicable' | 'upcoming' | 'due' | 'in_progress' | 'waiting' | 'blocked' | 'done' | 'skipped' | 'paused' | 'failed';
export type WaitingOn = 'client' | 'insurer' | 'engineer' | 'repairer' | 'supplier' | 'owner' | 'handler' | 'time' | 'agent';

// ---------------------------------------------------------------------------
// Step ids (§A.3, catalogue order)
// ---------------------------------------------------------------------------

/** The 46 step ids of §A.3, in catalogue order. */
export const AUTOPILOT_STEP_IDS = [
  'intake.new_claim',
  'intake.acknowledge',
  'intake.complete_fnol',
  'intake.cross_file',
  'intake.injury_referral',
  'intake.cctv',
  'qualify.acceptance',
  'qualify.decline',
  'qualify.driver',
  'qualify.need',
  'qualify.means',
  'qualify.roadworthiness',
  'signup.pack',
  'signup.signed',
  'notify.ncaf',
  'notify.handling_ref',
  'notify.intervention',
  'vehicle.recovery',
  'vehicle.storage',
  'vehicle.engineer',
  'vehicle.inspection',
  'vehicle.report',
  'vehicle.repair_track',
  'vehicle.total_loss_track',
  'hire.search',
  'hire.choose',
  'hire.hold',
  'hire.offer',
  'hire.acceptance',
  'hire.confirm',
  'hire.delivery',
  'hire.pack',
  'hire.handover',
  'hire.start_notice',
  'hire.monitor',
  'hire.offhire',
  'hire.return',
  'money.invoices',
  'money.payment_pack',
  'money.chasers',
  'money.complaint',
  'money.offer',
  'money.payment',
  'money.client_payout',
  'close.readiness',
  'status.sync',
] as const;
export type AutopilotStepId = (typeof AUTOPILOT_STEP_IDS)[number];
export const isAutopilotStepId = (v: unknown): v is AutopilotStepId => typeof v === 'string' && (AUTOPILOT_STEP_IDS as readonly string[]).includes(v);

/** Steps whose mode is raised to `confirm` when the situation is not green (§A.5). */
export const GREEN_GATED_STEPS: readonly AutopilotStepId[] = ['hire.choose', 'hire.offer', 'qualify.driver', 'qualify.need'];

/** Key into PREDICATES (autopilot/predicates.ts); an unknown id is a test failure. */
export type PredicateId = string;
/** Key into REQUIREMENTS (what is missing, in plain English, and how to ask). */
export type RequirementId = string;

export interface StepDeadline {
  /** Use the claim's running clock of this kind. */
  clock?: ClockKind;
  /** Else: from this fact (e.g. 'event.engineer_instructed.at'). */
  fromFact?: string;
  workingDays?: number;
  hours?: number;
  days?: number;
  businessHoursOnly?: boolean;
}

export type JudgeQuestionId = 'choose_car' | 'offer_wording' | 'repair_status_from_message' | 'need_still_exists' | 'delivery_slot_from_reply' | 'choose_recovery_supplier';
export const JUDGE_QUESTION_IDS: readonly JudgeQuestionId[] = ['choose_car', 'offer_wording', 'repair_status_from_message', 'need_still_exists', 'delivery_slot_from_reply', 'choose_recovery_supplier'];

export type StepRecipient = 'client' | 'at_fault_insurer' | 'supplier' | 'engineer';

export type StepAction =
  /** build = InputBuilderId (code builds the input). */
  | { kind: 'tool'; tool: ToolName; build: string }
  | { kind: 'draft'; templateId: string | null; emailKind: EmailKind | null; actionCode: string; recipient: StepRecipient }
  | { kind: 'pack'; stage: PackStage }
  /** options = OptionBuilderId. */
  | { kind: 'judge'; question: JudgeQuestionId; options: string }
  | { kind: 'needs_you'; needsYouKind: NeedsYouKind }
  | { kind: 'status'; status: ClaimStatus }
  | { kind: 'none' };

export interface StepDef {
  id: AutopilotStepId;
  track: TrackId;
  stage: StageId;
  title: string;
  performer: Performer;
  /** Settings can never make the step less strict than this. */
  floor: StepMode;
  /** ≥ floor. */
  defaultMode: StepMode;
  /** false → not_applicable. */
  appliesWhen: PredicateId;
  /** Dependencies (must be done/skipped/not_applicable). */
  after: AutopilotStepId[];
  /** Entry criteria (all). */
  readyWhen: PredicateId[];
  /** Exit criterion (re-evaluated every tick; a done step can re-open). */
  doneWhen: PredicateId;
  waitingOn?: { who: WaitingOn; when: PredicateId };
  /** Missing → blocked + missing_info preparation. */
  requires: RequirementId[];
  /** Open block findings with these codes block the step. */
  blockingClashes: ClashCode[];
  deadline?: StepDeadline;
  action: StepAction;
  /** Playbook code shared with case.review / drafter (§A.10). */
  actionCode?: string;
  templateIds?: string[];
  /** Citations; GTA always labelled as benchmark. */
  basis: string[];
}

export interface StepOption {
  id: string;
  label: string;
  detail: string;
  recommended: boolean;
}

export type StepBlockKind = 'clash' | 'step' | 'requirement' | 'eligibility' | 'acceptance' | 'gate' | 'paused';

export interface StepRefs {
  reservationId?: Id;
  hireOfferId?: Id;
  packId?: Id;
  movementId?: Id;
  hireId?: Id;
  outboxIds?: Id[];
  documentIds?: Id[];
  needsYouId?: Id;
  jobId?: Id;
}

export interface StepState {
  id: AutopilotStepId;
  status: StepStatus;
  mode: StepMode;
  modeReasons: string[];
  green: boolean;
  waitingOn?: WaitingOn;
  dueAt?: ISODateTime;
  overdue: boolean;
  since?: ISODateTime;
  missing: string[];
  blockedBy: Array<{ kind: StepBlockKind; code: string; message: string }>;
  /** For judge / choose_car steps. */
  options?: StepOption[];
  refs: StepRefs;
  /** One plain-English sentence: what happens next / what we are waiting for. */
  next: string;
}

export type ClaimAutopilotMode = 'on' | 'paused' | 'off';

export interface AutopilotPlan {
  version: 'autopilot/1';
  claimId: Id;
  evaluatedAt: ISODateTime;
  stage: StageId | TerminalStage;
  /** 1..14, 0 for terminal. */
  stageIndex: number;
  mode: ClaimAutopilotMode;
  /** Catalogue order. */
  steps: StepState[];
  /** Ordered: overdue first, then dueAt, then catalogue order. */
  due: AutopilotStepId[];
  waiting: AutopilotStepId[];
  done: AutopilotStepId[];
  /** Earliest of: next deadline, next wait timeout, now + 6 h. */
  nextCheckAt: ISODateTime;
  /** sha256 of the stable JSON (sorted keys) without evaluatedAt. */
  planHash: string;
}

export type AutopilotOverrideAction = 'skip' | 'ask' | 'auto' | 'done' | 'snooze';
export const AUTOPILOT_OVERRIDE_ACTIONS: readonly AutopilotOverrideAction[] = ['skip', 'ask', 'auto', 'done', 'snooze'];

export interface AutopilotOverride {
  action: AutopilotOverrideAction;
  until?: ISODateTime;
  reason: string;
  by: string;
  at: ISODateTime;
}

/** The step a tool call acts for (RunContext.step / ActionDescriptor.step, §0.6). Set by code only. */
export interface StepContext {
  id: string;
  mode: StepMode;
  green: boolean;
}

/** A commitment the descriptor carries (§D.3). Set by code only (dispatcher / outbox decision path), never from model input. */
export interface CommitmentContext {
  kind: 'hire_offer' | 'delivery_slot';
  refId: string;
  verified: boolean;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Persistence shapes (claim_autopilot, autopilot_log; migration 0013_autopilot)
// ---------------------------------------------------------------------------

export interface ClaimAutopilotRecord {
  claimId: Id;
  mode: ClaimAutopilotMode;
  pausedBy?: string;
  pausedReason?: string;
  pausedAt?: ISODateTime;
  stepOverrides: Partial<Record<AutopilotStepId, AutopilotOverride>>;
  stage?: StageId | TerminalStage;
  plan?: AutopilotPlan;
  planHash?: string;
  planVersion?: string;
  lastEvaluatedAt?: ISODateTime;
  nextCheckAt?: ISODateTime;
  updatedAt: ISODateTime;
}

/** Append-only (`autopilot_log`). */
export interface AutopilotLogEntry {
  id: Id;
  claimId: Id;
  stepId: string;
  fromStatus?: StepStatus | 'reopened';
  toStatus: StepStatus | 'reopened';
  action?: string;
  actor: string;
  decision?: unknown;
  jobId?: Id;
  runId?: Id;
  needsYouId?: Id;
  refs: StepRefs;
  note?: string;
  at: ISODateTime;
}

// ---------------------------------------------------------------------------
// Hire offers (§D.2; `hire_offers`)
// ---------------------------------------------------------------------------

export interface HireOfferTerms {
  reservationId: Id;
  fleetUnitId: Id;
  registration: string;
  makeModel: string;
  transmission: string;
  seats: number | null;
  fuel: string | null;
  gtaGroup: string;
  clientGtaGroup: string | null;
  /** Code-built sentence. */
  likeForLike: string;
  startAt: ISODateTime;
  expectedEndAt: ISODateTime;
  delivery: { windowStart: ISODateTime; windowEnd: ISODateTime; addressShort: string } | null;
  expiresAt: ISODateTime;
  /** Shown, not held. */
  alternatives: Array<{ fleetUnitId: Id; label: string }>;
}

export type HireOfferStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'withdrawn' | 'superseded';
export type HireOfferChannel = 'email' | 'sms' | 'phone' | 'in_person';

export interface HireOfferResponse {
  at: ISODateTime;
  how: 'email_reply' | 'phone' | 'in_person' | 'sms';
  decision: 'accept' | 'decline';
  messageId?: Id;
  recordedBy: string;
  chosenFleetUnitId?: Id;
  note?: string;
  confidence?: number;
}

export interface HireOffer {
  id: Id;
  claimId: Id;
  reservationId: Id;
  status: HireOfferStatus;
  channel: HireOfferChannel;
  terms: HireOfferTerms;
  termsSha256: string;
  outboxId?: Id;
  /** 'autopilot_green' or the owner's user id. */
  authorisedBy: 'autopilot_green' | (string & {});
  sentAt?: ISODateTime;
  expiresAt: ISODateTime;
  response?: HireOfferResponse;
  createdBy: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}
