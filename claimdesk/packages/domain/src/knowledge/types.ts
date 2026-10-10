// owned by knowledge-core
/**
 * Knowledge Builder — the store's vocabulary (docs/SUPREME-KNOWLEDGE-BUILDER.md §4.1, §4.2, §7.2, §8.1, §9, §10.4).
 * Pure types and constants. Every knowledge slice (core, learners, research, use, ui) codes against these; the
 * contract types other slices' stub files need (KnowledgeHit, SourcePolicy, DomainCheck, ClaimDictionary, EvalCase,
 * KnowledgeSettings) live here so a slice rewriting its own stub can never break the core.
 */
import type { HeadOfLoss, ISODate, ISODateTime } from '../types.js';
import type { AgentName, JobType, MailIntent, NeedsYouPriority, RecipientRole } from '../agents/types.js';

/** A playbook action code (`@ccguk/kb` PLAYBOOK_ACTION_CODES). Kept as a string here: the domain package does not depend on the KB. */
export type KnowledgeActionCode = string;

// ---------------------------------------------------------------------------
// Kinds, areas, statuses (§4.1)
// ---------------------------------------------------------------------------

export const KNOWLEDGE_KINDS = ['fact', 'rule', 'strategy', 'contact', 'insurer_profile', 'template_snippet', 'engineering_figure', 'precedent', 'procedure'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export const KNOWLEDGE_AREAS = ['legal', 'quantum', 'procedural', 'contact', 'statistics', 'style', 'engineering', 'strategy'] as const;
export type KnowledgeArea = (typeof KNOWLEDGE_AREAS)[number];
export const KNOWLEDGE_VERIFICATIONS = ['unverified', 'owner_confirmed', 'source_verified'] as const;
export type KnowledgeVerification = (typeof KNOWLEDGE_VERIFICATIONS)[number];
export const KNOWLEDGE_STATUSES = ['proposed', 'active', 'rejected', 'superseded', 'retired', 'quarantined'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];
export const KNOWLEDGE_HEALTHS = ['ok', 'stale', 'source_changed', 'conflicted', 'expired'] as const;
export type KnowledgeHealth = (typeof KNOWLEDGE_HEALTHS)[number];
export const KNOWLEDGE_ORIGINS = ['computed', 'observed', 'owner', 'curated', 'researched', 'imported'] as const;
export type KnowledgeOrigin = (typeof KNOWLEDGE_ORIGINS)[number];
/** outbound_ok: may be cited in letters/emails (subject to §8.3); internal: agents may reason with it; code_only: never in prompts. */
export const KNOWLEDGE_USE_LIMITS = ['outbound_ok', 'internal', 'code_only'] as const;
export type KnowledgeUseLimit = (typeof KNOWLEDGE_USE_LIMITS)[number];
export const BUSINESSES = ['ccguk', 'fixmyfile'] as const;
export type Business = (typeof BUSINESSES)[number];
export const CLAIM_TYPE_TAGS = ['credit_hire', 'repair', 'total_loss', 'storage', 'recovery', 'pcn', 'injury_referral', 'liability_dispute', 'fraud_allegation', 'small_claims', 'litigation'] as const;
export type ClaimTypeTag = (typeof CLAIM_TYPE_TAGS)[number];
export type KnowledgeScope = { kind: 'global' } | { kind: 'insurer'; slug: string } | { kind: 'claim_type'; tag: ClaimTypeTag };

export type KnowledgeProvenance =
  | { kind: 'claim_stats'; n: number; claimIds: string[]; computedAt: ISODateTime; method: string }
  | { kind: 'email'; mailMessageId: string; fromDomain: string; dmarc: 'pass' | 'fail' | 'none' | 'unknown'; observedAt: ISODateTime }
  | { kind: 'document'; documentId: string | null; evidenceId: string | null; page: number | null; quote: string | null }
  | { kind: 'correction'; correctionIds: string[] }
  | { kind: 'snapshot'; snapshotId: string; url: string; fetchedAt: ISODateTime; quote: string; anchor: string | null; quoteMatch: 'exact' | 'normalised' }
  /** discovered by research_web; not yet snapshotted → cannot activate */
  | { kind: 'url'; url: string; seenAt: ISODateTime; note: string }
  | { kind: 'kb'; entryId: string }
  | { kind: 'pack'; packId: string; version: string; entryId: string }
  | { kind: 'owner'; userId: string; at: ISODateTime; note: string | null }
  | { kind: 'engineering'; source: 'approved_estimate' | 'confirmed_report' | 'engineer_learning'; ids: string[]; n: number };

export interface KnowledgeItem<D = KnowledgeData> {
  id: string;
  itemKey: string;
  version: number;
  kind: KnowledgeKind;
  area: KnowledgeArea;
  title: string;
  body: string;
  data: D;
  tags: string[];
  scope: KnowledgeScope;
  business: Business[];
  useLimit: KnowledgeUseLimit;
  origin: KnowledgeOrigin;
  verification: KnowledgeVerification;
  lastCheckId: string | null;
  confidence: number;
  supportN: number;
  status: KnowledgeStatus;
  health: KnowledgeHealth;
  validFrom: ISODate | null;
  validTo: ISODate | null;
  reviewBy: ISODate | null;
  provenance: KnowledgeProvenance[];
  supersedesId: string | null;
  gapId: string | null;
  contentSha256: string;
  autonomy: KnowledgeDecision;
  createdBy: string;
  createdAt: ISODateTime;
  originJobId: string | null;
  originRunId: string | null;
  decidedBy: string | null;
  decidedAt: ISODateTime | null;
  decisionNote: string | null;
  needsYouId: string | null;
  updatedAt: ISODateTime;
}

/** What a learner, the researcher or the owner hands to the store. The store computes itemKey, version, sha, decision. */
export interface KnowledgeProposal<D = KnowledgeData> {
  kind: KnowledgeKind;
  area: KnowledgeArea;
  title: string;
  body: string;
  data: D;
  tags: string[];
  scope: KnowledgeScope;
  business: Business[];
  useLimit: KnowledgeUseLimit;
  origin: KnowledgeOrigin;
  confidence: number;
  supportN: number;
  validFrom?: ISODate | null;
  validTo?: ISODate | null;
  reviewBy?: ISODate | null;
  provenance: KnowledgeProvenance[];
  itemKey?: string;
  supersedesId?: string | null;
  gapId?: string | null;
  createdBy: string;
  originJobId?: string | null;
  originRunId?: string | null;
}

// ----- kind-specific data (validated by proposalProblems in autonomy.ts and the API's zod twins) -----
export interface FactData {
  statement: string;
  figure: { value: number; unit: string } | null;
  asOf: ISODate | null;
  benchmarkOnly: boolean;
  kbCheck: KbCheckEvidence | null;
  stat: StatFactData | null;
}
export interface KbCheckEvidence {
  entryId: string;
  citationOk: boolean;
  urlOk: boolean;
  principleSupported: 'yes' | 'partly' | 'no';
  suggestedCorrection: { citation?: string; url?: string; principle?: string } | null;
}
export interface StatFactData {
  metric: 'step_effectiveness';
  /** template id | email kind | action code */
  step: string;
  outcome: 'insurer_reply' | 'handling_ref' | 'payment' | 'offer';
  withinWorkingDays: number;
  hits: number;
  n: number;
  baselinePct: number | null;
  insurerSlug: string | null;
  window: '12m' | 'all';
}
export interface ContactData {
  insurerSlug: string;
  team: string | null;
  name: string | null;
  role: string | null;
  phone: string | null;
  phoneKind: 'direct' | 'team' | 'switchboard' | 'mobile' | null;
  email: string | null;
  ivr: string | null;
  hours: string | null;
  observations: number;
  independentThreads: number;
  lastSeenAt: ISODateTime;
}
export interface Dist {
  median: number;
  p25: number;
  p75: number;
  n: number;
}
export interface InsurerProfileData {
  insurerSlug: string;
  window: '12m' | 'all';
  minN: number;
  computedAt: ISODateTime;
  n: { claims: number; settled: number };
  daysToPay: { medianWorkingDays: number | null; p90WorkingDays: number | null; n: number };
  heads: Partial<Record<HeadOfLoss, { paidOfClaimedPct: Dist | null; firstOfferOfClaimedPct: Dist | null; reductionRatePct: number | null; n: number }>>;
  objections: { intent: MailIntent; claims: number; pct: number }[];
  docsRequested: { doc: string; claims: number }[];
  gta: { subscriberClaims: number; hirePaidAtGtaRatePct: number | null; firstNotificationDisputePct: number | null };
  responseHours: { median: number | null; n: number };
  chasersBeforePay: { median: number | null; n: number };
}
/** Closed JSONLogic subset (ruleLogic.ts validates it). */
export type JsonLogic = { [op in '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or' | '!' | 'in' | 'var' | 'missing']?: unknown };
export type RuleEffect =
  /** restrictive: gate a step */
  | { kind: 'require_document'; doc: string; beforeStep: KnowledgeActionCode }
  /** restrictive: more asking */
  | { kind: 'ask_owner'; reason: string }
  /** restrictive: reviewer flag */
  | { kind: 'add_check'; code: string; message: string; severity: 'warn' | 'block' }
  /** restrictive: reviewer flag */
  | { kind: 'avoid_phrase'; phrase: string }
  /** advisory: shown to the case manager */
  | { kind: 'prefer_step'; actionCode: KnowledgeActionCode; note: string }
  /** advisory: task suggestion only */
  | { kind: 'suggest_followup'; afterWorkingDays: number; note: string };
export interface RuleData {
  when: JsonLogic;
  then: RuleEffect[];
  why: string;
  severity: 'info' | 'warn' | 'block';
}
export interface StrategyData {
  situation: string;
  goal: string;
  steps: string[];
  leverage: string[];
  counterArguments: string[];
  evidenceNeeded: string[];
  appliesTo: ClaimTypeTag[];
}
export interface TemplateSnippetData {
  purpose: string;
  emailKind: string | null;
  templateId: string | null;
  recipientRole: RecipientRole | null;
  /** literals generalised to [amount] [date] [ref] [name] */
  text: string;
  tokens: string[];
}
export interface EngineeringFigureData {
  vehicle: { make: string; modelFamily: string | null; yearFrom: number | null; yearTo: number | null };
  panel: string;
  operation: string;
  metric: 'labour_hours' | 'paint_hours' | 'repair_working_days' | 'adas_calibration_rate' | 'salvage_ratio';
  median: number;
  p25: number;
  p75: number;
  n: number;
}
export interface PrecedentData {
  citation: string;
  neutralCitation: string | null;
  court: string | null;
  year: number | null;
  principle: string;
  kbEntryId: string | null;
  url: string;
  licence: 'OGL' | 'Open Justice Licence' | 'link_only' | 'quote_only';
}
export interface ProcedureData {
  steps: string[];
  forWhom: 'insurer' | 'dvla' | 'court' | 'police' | 'mib' | 'other';
  channel: 'phone' | 'email' | 'portal' | 'post' | null;
  insurerSlug: string | null;
}
export type KnowledgeData = FactData | RuleData | StrategyData | ContactData | InsurerProfileData | TemplateSnippetData | EngineeringFigureData | PrecedentData | ProcedureData;

// ---------------------------------------------------------------------------
// Kind rules (§4.2)
// ---------------------------------------------------------------------------

export interface KindRules {
  allowedAreas: readonly KnowledgeArea[];
  allowedOrigins: readonly KnowledgeOrigin[];
  allowedUse: readonly KnowledgeUseLimit[];
  maxBodyChars: number;
  minSupportForAuto: number;
}

const ANY_USE: readonly KnowledgeUseLimit[] = KNOWLEDGE_USE_LIMITS;

/** §4.2 table. Research can never create `rule`, `strategy` or `template_snippet` (KR-9): their origins exclude `researched`. */
export const KIND_RULES: Readonly<Record<KnowledgeKind, KindRules>> = {
  fact: { allowedAreas: ['legal', 'quantum', 'procedural', 'statistics', 'engineering', 'style'], allowedOrigins: ['computed', 'observed', 'owner', 'curated', 'researched', 'imported'], allowedUse: ANY_USE, maxBodyChars: 4000, minSupportForAuto: 1 },
  rule: { allowedAreas: ['strategy', 'procedural', 'style', 'legal', 'quantum'], allowedOrigins: ['owner', 'curated'], allowedUse: ['internal'], maxBodyChars: 2000, minSupportForAuto: 3 },
  strategy: { allowedAreas: ['strategy'], allowedOrigins: ['owner', 'curated', 'imported'], allowedUse: ['internal'], maxBodyChars: 6000, minSupportForAuto: 3 },
  contact: { allowedAreas: ['contact'], allowedOrigins: ['observed', 'owner', 'researched'], allowedUse: ['internal'], maxBodyChars: 1000, minSupportForAuto: 2 },
  insurer_profile: { allowedAreas: ['statistics'], allowedOrigins: ['computed'], allowedUse: ['internal'], maxBodyChars: 4000, minSupportForAuto: 3 },
  template_snippet: { allowedAreas: ['style'], allowedOrigins: ['owner', 'curated', 'observed'], allowedUse: ['internal'], maxBodyChars: 4000, minSupportForAuto: 1 },
  engineering_figure: { allowedAreas: ['engineering'], allowedOrigins: ['computed', 'owner'], allowedUse: ['internal', 'code_only'], maxBodyChars: 1000, minSupportForAuto: 3 },
  precedent: { allowedAreas: ['legal', 'quantum'], allowedOrigins: ['owner', 'researched', 'imported'], allowedUse: ANY_USE, maxBodyChars: 4000, minSupportForAuto: 1 },
  procedure: { allowedAreas: ['procedural', 'contact'], allowedOrigins: ['observed', 'owner', 'researched', 'curated'], allowedUse: ['internal', 'outbound_ok'], maxBodyChars: 4000, minSupportForAuto: 2 },
};

// ---------------------------------------------------------------------------
// Verification (§4.4) and decisions (§9.1)
// ---------------------------------------------------------------------------

export type KnowledgeCheckResult = 'unverified' | 'owner_confirmed' | 'source_verified' | 'failed';
export type KnowledgeCheckMethod = 'owner_review' | 'source_compare' | 'owner_answer' | 'downgrade';
export type QuoteMatch = 'exact' | 'normalised' | 'not_found' | 'not_applicable';
export interface KnowledgeCheck {
  id: string;
  target: `item:${string}` | `kb:${string}`;
  result: KnowledgeCheckResult;
  method: KnowledgeCheckMethod;
  snapshotId: string | null;
  sourceUrl: string | null;
  quote: string | null;
  quoteMatch: QuoteMatch;
  note: string | null;
  checkedBy: string;
  checkedAt: ISODateTime;
  needsYouId: string | null;
}

export type KnowledgeBadge = 'source_verified' | 'owner_confirmed' | 'unverified' | 'computed' | 'benchmark_only' | 'stale' | 'source_changed' | 'conflicted' | 'external';

export type KnowledgeRuleId = 'KN-01' | 'KN-02' | 'KN-03' | 'KN-04' | 'KN-05' | 'KN-06' | 'KN-07' | 'KN-08' | 'KN-09' | 'KN-10' | 'KN-11' | 'KN-12' | 'KN-13' | 'KN-14' | 'KN-15' | 'KN-16' | 'KN-17' | 'KN-18' | 'KN-19';
export interface KnowledgeDecision {
  outcome: 'auto_apply' | 'queue' | 'reject' | 'hold';
  ruleIds: KnowledgeRuleId[];
  reasons: string[];
  priority: NeedsYouPriority;
}

/** Sender classification for contacts learned from mail (§6.2; the parser lives in signature.ts, learners). */
export type DomainCheck = 'own_domain' | 'unknown_domain' | 'copycat' | 'spoof_suspect';

export type ConflictKind = 'contradicts' | 'duplicate' | 'directory_mismatch' | 'red_line' | 'perimeter' | 'kb_contradiction' | 'stats_vs_note';
export const CONFLICT_KINDS: readonly ConflictKind[] = ['contradicts', 'duplicate', 'directory_mismatch', 'red_line', 'perimeter', 'kb_contradiction', 'stats_vs_note'];
/** A conflict found by code (conflicts.ts, learners) before it is stored. `leftRef` is the new/learned side. */
export interface ConflictFinding {
  kind: ConflictKind;
  leftRef: string;
  rightRef: string;
  detail: string;
}
/** A stored `knowledge_conflicts` row. */
export interface KnowledgeConflict extends ConflictFinding {
  id: string;
  detectedBy: string;
  status: 'open' | 'resolved' | 'dismissed';
  resolution: string | null;
  needsYouId: string | null;
  createdAt: ISODateTime;
  resolvedBy: string | null;
  resolvedAt: ISODateTime | null;
}

// ---------------------------------------------------------------------------
// Sources (§7.2; the table lives in sources.ts, research)
// ---------------------------------------------------------------------------

export type SourcePolicyKind = 'api' | 'code_fetch' | 'agent_fetch' | 'link_only' | 'deny';
export interface SourcePolicy {
  domain: string;
  policy: SourcePolicyKind;
  access: string;
  licence: string;
  extractAllowed: boolean;
  maxQuoteWords: number;
  tags: string[];
  perMinute: number;
  perDay: number;
  search: 'gov_uk' | 'legislation' | 'fca_handbook' | 'fcl' | null;
  purpose: string;
}

export interface KnowledgeDecisionContext {
  settings: KnowledgeSettings;
  conflicts: ConflictFinding[];
  perimeterFlags: string[];
  directiveFlags: string[];
  replaces: Pick<KnowledgeItem, 'verification' | 'origin'> | null;
  contact: { domainCheck: DomainCheck; dmarc: string; independentThreads: number } | null;
  snapshot: { policy: SourcePolicyKind; quoteMatch: 'exact' | 'normalised' } | null;
  /** Additive (§6.6, KN-17): an owner-written snippet and whether every literal was generalised. */
  snippet?: { ownerAuthored: boolean; fullyGeneralised: boolean } | null;
}

// ---------------------------------------------------------------------------
// Settings (§10.4)
// ---------------------------------------------------------------------------

export interface KnowledgeSettings {
  /** kill switch for learning + research (default true) */
  learningEnabled: boolean;
  /** retrieval of L5 (default true) */
  useLearnedKnowledge: boolean;
  /** knowledge.research, no web tools (default true) */
  researchEnabled: boolean;
  /** deterministic fetching (default true) */
  sourceFetchEnabled: boolean;
  /** knowledge.research_web (default false) */
  webResearchEnabled: boolean;
  autoApply: { statistics: boolean; contacts: boolean; procedures: boolean; engineering: boolean; snippets: boolean; curatedStyle: boolean };
  thresholds: { autoApplyConfidence: number; contactObservations: number; engineeringMinN: number; statsMinN: number; styleSupport: number };
  budgets: { researchRunsPerDay: number; curateRunsPerDay: number; webRunsPerDay: number; replayDraftsPerWeek: number; fetchesPerDay: number; perDomainPerMinute: number; gapMaxAttempts: number; apiUsdPerDay: number };
  needsYouPerDay: number;
  fclTransactionalLicence: { recorded: boolean; reference: string | null; at: string | null; by: string | null };
  /** owner's contact for the fetcher User-Agent (stored locally only) */
  userAgentContact: string | null;
  replay: { gateRules: boolean; worseTolerancePct: number; minCases: number; draftsEnabled: boolean };
  drift: { windowDays: number; baselineDays: number; minN: number; dropPctPoints: number; autoQuarantineOnPerimeter: boolean };
}

export const DEFAULT_KNOWLEDGE_SETTINGS: KnowledgeSettings = {
  learningEnabled: true,
  useLearnedKnowledge: true,
  researchEnabled: true,
  sourceFetchEnabled: true,
  webResearchEnabled: false,
  autoApply: { statistics: true, contacts: true, procedures: true, engineering: true, snippets: true, curatedStyle: true },
  thresholds: { autoApplyConfidence: 0.8, contactObservations: 2, engineeringMinN: 3, statsMinN: 3, styleSupport: 3 },
  budgets: { researchRunsPerDay: 6, curateRunsPerDay: 2, webRunsPerDay: 2, replayDraftsPerWeek: 1, fetchesPerDay: 200, perDomainPerMinute: 6, gapMaxAttempts: 3, apiUsdPerDay: 2 },
  needsYouPerDay: 5,
  fclTransactionalLicence: { recorded: false, reference: null, at: null, by: null },
  userAgentContact: null,
  replay: { gateRules: true, worseTolerancePct: 5, minCases: 10, draftsEnabled: false },
  drift: { windowDays: 14, baselineDays: 28, minN: 10, dropPctPoints: 15, autoQuarantineOnPerimeter: true },
};

// ---------------------------------------------------------------------------
// Retrieval contract (§8.1; ranking lives in retrieval.ts, knowledge-use)
// ---------------------------------------------------------------------------

export type KnowledgeRef = `ki:${string}` | `kb:${string}` | `pack:${string}` | `mem:${string}`;
export interface KnowledgeCandidate {
  ref: KnowledgeRef;
  layer: 'kb' | 'ccguk_pack' | 'playbook_pack' | 'learned' | 'memory';
  kind: KnowledgeKind | 'kb_entry' | 'pack_entry' | 'memory';
  area: KnowledgeArea | null;
  title: string;
  text: string;
  bm25: number;
  scope: KnowledgeScope;
  business: Business[];
  verification: KnowledgeVerification | 'kb_verified' | 'kb_unverified' | 'kb_stale';
  health: KnowledgeHealth;
  useLimit: KnowledgeUseLimit;
  tags: string[];
  itemKey: string | null;
  computed: { n: number; asOf: string } | null;
  external: boolean;
  fos: boolean;
  gta: boolean;
  injury: boolean;
  validTo: string | null;
}
export interface RetrievalRequest {
  agent: AgentName;
  jobType: JobType;
  query: string;
  today: ISODate;
  limit: number;
  maxChars: number;
  claim: { insurerSlug: string | null; claimTypes: ClaimTypeTag[]; recipientRole: RecipientRole | null; business: Business } | null;
}
export interface KnowledgeHit extends KnowledgeCandidate {
  rank: number;
  score: number;
  badges: KnowledgeBadge[];
  whyRanked: string[];
  mayCiteOutbound: boolean;
}

/** The fields mayCiteOutbound (verification.ts) and the reviewer need from an item or a hit. */
export interface KnowledgeItemLike {
  kind: KnowledgeKind | 'kb_entry' | 'pack_entry' | 'memory';
  area: KnowledgeArea | null;
  origin?: KnowledgeOrigin;
  verification: KnowledgeVerification | 'kb_verified' | 'kb_unverified' | 'kb_stale';
  health: KnowledgeHealth;
  useLimit: KnowledgeUseLimit;
  tags: string[];
  business: Business[];
  status?: KnowledgeStatus;
  provenance?: KnowledgeProvenance[];
}

// ---------------------------------------------------------------------------
// Claim typing (scope.ts) and research privacy (scrub.ts, research)
// ---------------------------------------------------------------------------

/** What claimTypeTagsFrom needs to know about a claim (all optional: a missing fact adds no tag). */
export interface ClaimTypeInput {
  hasHire?: boolean;
  hasRepair?: boolean;
  totalLoss?: boolean;
  hasStorage?: boolean;
  hasRecovery?: boolean;
  pcn?: boolean;
  injuries?: boolean;
  liability?: 'admitted' | 'denied' | 'disputed' | 'split' | 'unknown' | string | null;
  fraudAllegation?: boolean;
  track?: 'small_claims' | 'fast' | 'intermediate' | 'multi' | string | null;
  litigation?: boolean;
}

/** Hashed tokens of every party name, VRM, our refs and insurer refs in the DB (built per research run, never sent). */
export interface ClaimDictionary {
  /** sha256 hex of each normalised (lower-case, single-spaced) token */
  hashes: ReadonlySet<string>;
  /** longest token length in words (lets the scrubber bound its n-gram window) */
  maxWords: number;
}

// ---------------------------------------------------------------------------
// Evals (§12.1; replay.ts, knowledge-use)
// ---------------------------------------------------------------------------

export type EvalDecisionPoint = 'after_pack_sent' | 'on_offer' | 'on_docs_request' | 'at_stage';
export interface EvalCase {
  id: string;
  claimId: string;
  decisionPoint: EvalDecisionPoint;
  at: ISODateTime;
  /** facts over RULE_FACT_IDS as of that moment */
  facts: Record<string, unknown>;
  /** what was historically done: action codes / steps taken */
  historic: { actionCodes: string[]; steps: string[] };
  outcome: { workingDaysToPay: number | null; paidOfClaimedPct: number | null };
  insurerSlug: string | null;
  outcomeQuartile: number | null;
}
export interface OutcomeStats {
  n: number;
  medianWorkingDaysToPay: number | null;
  medianPaidOfClaimedPct: number | null;
}

/** One line of a learned-pack diff (§4.6). */
export interface ItemSummary {
  id: string;
  itemKey: string;
  kind: KnowledgeKind;
  area: KnowledgeArea;
  title: string;
  version: number;
}

// ---------------------------------------------------------------------------
// Needs-you payload (§9.3) and the daily digest (§9.4)
// ---------------------------------------------------------------------------

export type KnowledgeReviewPayload =
  | { variant: 'items'; groupTitle: string; itemIds: string[]; replayRunId: string | null }
  | { variant: 'conflict'; conflictId: string }
  | { variant: 'alarm'; alarmId: string; suggestedRollbackTo: number | null }
  | { variant: 'gap'; gapId: string; question: string; preparedItemId: string | null; looked: { domain: string; url: string | null }[] };

export interface DigestLine {
  at: ISODateTime;
  text: string;
  badges: KnowledgeBadge[];
  itemId?: string;
  gapId?: string;
  link: string;
  undoRoute?: string;
}
export interface KnowledgeDigest {
  day: string;
  learningEnabled: boolean;
  activeVersion: number | null;
  publishedToday: number[];
  /** each with Undo (retire) link */
  learnedAutomatically: DigestLine[];
  waitingForYou: { count: number; lines: DigestLine[] };
  gaps: { opened: number; filled: number; open: number; lines: DigestLine[] };
  sources: { fetched: number; changed: number; refused: number };
  research: { runs: number; proposals: number; ownerRejected: number };
  alarms: DigestLine[];
  /** e.g. "Learned 9 things automatically, 3 wait for you, 2 gaps filled" */
  headline: string;
}

/** Audit / knowledge_changes actions (§10.5). */
export const KNOWLEDGE_AUDIT_ACTIONS = [
  'knowledge.item.propose', 'knowledge.item.auto_apply', 'knowledge.item.approve', 'knowledge.item.edit_approve', 'knowledge.item.reject',
  'knowledge.item.retire', 'knowledge.item.quarantine', 'knowledge.item.health', 'knowledge.item.hold', 'knowledge.item.activate',
  'knowledge.check',
  'knowledge.pack.publish', 'knowledge.pack.activate', 'knowledge.pack.export',
  'knowledge.gap.open', 'knowledge.gap.close',
  'knowledge.source.fetch', 'knowledge.source.refused', 'knowledge.source.prune', 'knowledge.source.add', 'knowledge.source.toggle',
  'knowledge.settings', 'knowledge.learning.pause', 'knowledge.learning.resume',
  'knowledge.alarm.raise', 'knowledge.alarm.ack', 'knowledge.alarm.resolve', 'knowledge.replay.run',
  'knowledge.learn.run',
  'knowledge.link.set',
  'knowledge.conflict.open', 'knowledge.conflict.resolve',
] as const;
export type KnowledgeAuditAction = (typeof KNOWLEDGE_AUDIT_ACTIONS)[number];
