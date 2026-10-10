// owned by knowledge-core
/**
 * Knowledge Builder HTTP DTOs (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.3). Every request and response body of the
 * `/api/knowledge/**` routes is declared once here, so the UI slice (`apps/web/src/api/knowledgeApi.ts`) and the route
 * modules of every knowledge slice code against the same shapes. Pure types.
 */
import type { HeadOfLoss, ISODate, ISODateTime } from '../types.js';
import type {
  Business,
  ItemSummary,
  KnowledgeArea,
  KnowledgeBadge,
  KnowledgeCheck,
  KnowledgeCheckMethod,
  KnowledgeCheckResult,
  KnowledgeConflict,
  KnowledgeData,
  KnowledgeDigest,
  KnowledgeHit,
  KnowledgeItem,
  KnowledgeKind,
  KnowledgeScope,
  KnowledgeSettings,
  KnowledgeStatus,
  KnowledgeUseLimit,
  KnowledgeVerification,
  InsurerProfileData,
  ContactData,
  ProcedureData,
} from './types.js';

/** An item as the API returns it: the stored item plus its display badges. */
export type KnowledgeItemView = KnowledgeItem & { badges: KnowledgeBadge[] };

// ----- items (knowledge-core) -----
export interface KnowledgeItemsQuery {
  status?: KnowledgeStatus | 'all';
  kind?: KnowledgeKind;
  area?: KnowledgeArea;
  /** scopeKey: `global`, `insurer:<slug>`, `claim_type:<tag>` */
  scope?: string;
  verification?: KnowledgeVerification;
  q?: string;
  limit?: number;
  offset?: number;
}
export interface KnowledgeItemsResponse {
  items: KnowledgeItemView[];
  total: number;
}
export interface KnowledgeUsageRow {
  id: string;
  runId: string;
  claimId: string | null;
  ref: string;
  badges: KnowledgeBadge[];
  rank: number;
  injected: boolean;
  cited: boolean;
  targetKind: string | null;
  targetId: string | null;
  at: ISODateTime;
}
export interface KnowledgeChange {
  id: string;
  at: ISODateTime;
  actor: string;
  action: string;
  itemId: string | null;
  itemKey: string | null;
  gapId: string | null;
  packVersion: number | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  ruleIds: string[];
  runId: string | null;
  jobId: string | null;
  needsYouId: string | null;
}
export interface KnowledgeItemDetail {
  item: KnowledgeItemView;
  /** every version of the same itemKey, newest first */
  versions: KnowledgeItemView[];
  checks: KnowledgeCheck[];
  changes: KnowledgeChange[];
  usage: KnowledgeUsageRow[];
  conflicts: KnowledgeConflict[];
  /** member of the active learned-pack version */
  inActiveVersion: boolean;
}
export interface KnowledgeQueueGroup {
  key: string;
  title: string;
  kind: 'contacts' | 'rules' | 'legal' | 'kb_checks' | 'style' | 'procedures' | 'other';
  itemIds: string[];
}
export interface KnowledgeQueueResponse {
  items: KnowledgeItemView[];
  /** stored while learning was paused (KN-01) */
  held: KnowledgeItemView[];
  groups: KnowledgeQueueGroup[];
  conflicts: KnowledgeConflict[];
}
export interface ApproveKnowledgeBody {
  note?: string;
  verification?: 'owner_confirmed' | 'source_verified';
  sourceUrl?: string;
  snapshotId?: string;
}
export interface EditApproveKnowledgeBody {
  title: string;
  body: string;
  data: KnowledgeData;
  scope: KnowledgeScope;
  note?: string;
}
export interface ReasonBody {
  reason: string;
}
export interface RecordCheckBody {
  result: KnowledgeCheckResult;
  method: Exclude<KnowledgeCheckMethod, 'downgrade'>;
  sourceUrl?: string;
  snapshotId?: string;
  quote?: string;
  note?: string;
}
export interface OwnerKnowledgeBody {
  kind: KnowledgeKind;
  area: KnowledgeArea;
  title: string;
  body: string;
  data: KnowledgeData;
  scope: KnowledgeScope;
  gapId?: string;
  tags?: string[];
  business?: Business[];
  useLimit?: KnowledgeUseLimit;
}
export interface KnowledgeItemMutationResponse {
  item: KnowledgeItemView;
  check?: KnowledgeCheck;
  /** a learned-pack publish queued for this change */
  publishJobId?: string | null;
}

// ----- versions (knowledge-core) -----
export interface KnowledgePackVersion {
  version: number;
  label: string;
  itemsSha256: string;
  itemCount: number;
  diff: KnowledgeVersionDiff;
  reason: string;
  basedOnVersion: number | null;
  rollbackOf: number | null;
  replayRunId: string | null;
  createdBy: string;
  createdAt: ISODateTime;
  active: boolean;
}
export interface KnowledgeVersionDiff {
  added: ItemSummary[];
  removed: ItemSummary[];
  changed: { itemKey: string; fromId: string; toId: string; fields: string[] }[];
}
export interface KnowledgeVersionsResponse {
  activeVersion: number | null;
  versions: KnowledgePackVersion[];
}
export interface ActivateVersionBody {
  reason: string;
}
export interface ExportVersionResponse {
  version: number;
  file: string;
  bytes: number;
  sha256: string;
}

// ----- conflicts (knowledge-core) -----
export interface ConflictsResponse {
  conflicts: KnowledgeConflict[];
}
export interface ResolveConflictBody {
  keep: 'left' | 'right' | 'both' | 'retire_both' | 'dismiss';
  note?: string;
}

// ----- digest, status, settings (knowledge-core) -----
export type KnowledgeDigestResponse = KnowledgeDigest;
export interface KnowledgeWeekDigest {
  start: ISODate;
  end: ISODate;
  days: KnowledgeDigest[];
  learnedAutomatically: number;
  waitingForYou: number;
  gapsFilled: number;
  headline: string;
}
export interface KnowledgeStatusResponse {
  learningEnabled: boolean;
  useLearnedKnowledge: boolean;
  webResearchEnabled: boolean;
  activeVersion: number | null;
  items: { proposed: number; active: number; held: number };
  conflictsOpen: number;
  gapsOpen: number | null;
  alarmsOpen: number | null;
  needsYouOpen: number;
}
export type KnowledgeSettingsResponse = KnowledgeSettings;
export type KnowledgeSettingsPatch = { [K in keyof KnowledgeSettings]?: KnowledgeSettings[K] extends object ? Partial<KnowledgeSettings[K]> : KnowledgeSettings[K] } & {
  /** required (true) to switch web research on */
  acknowledge?: boolean;
};
export interface InsurerLinkBody {
  insurerSlug: string;
}
export interface InsurerLink {
  partyId: string;
  insurerSlug: string;
  method: 'exact_name' | 'brand' | 'email_domain' | 'owner';
  confidence: number;
  decidedBy: string;
  decidedAt: ISODateTime;
}

// ----- learners (knowledge-learners; routes/knowledgeLearning.ts) -----
export interface InsurerProfileListRow {
  insurerSlug: string;
  name: string | null;
  claims: number;
  medianWorkingDaysToPay: number | null;
  paidOfClaimedPct: number | null;
  topObjection: string | null;
  computedAt: ISODateTime | null;
}
export interface InsurerProfileView {
  insurerSlug: string;
  name: string | null;
  profile12m: InsurerProfileData | null;
  profileAll: InsurerProfileData | null;
  contacts: { item: KnowledgeItemView | null; directory: Partial<ContactData> | null; badges: KnowledgeBadge[] }[];
  procedures: { item: KnowledgeItemView; data: ProcedureData }[];
  docsRequested: { doc: string; claims: number }[];
  stepEffectiveness: KnowledgeItemView[];
  unlinkedParties: { partyId: string; name: string; claims: number }[];
  tooFewClaims: boolean;
  heads?: HeadOfLoss[];
}
export interface CorrectionView {
  id: string;
  source: string;
  claimId: string | null;
  agent: string | null;
  templateId: string | null;
  emailKind: string | null;
  insurerSlug: string | null;
  categories: string[];
  clusterKey: string | null;
  stats: { inserted: number; deleted: number; changedRatio: number };
  capturedAt: ISODateTime;
}
export interface CorrectionClusterView {
  clusterKey: string;
  corrections: number;
  sinceLastCuration: number;
  lastCapturedAt: ISODateTime;
  categories: string[];
}
export interface LearnRunBody {
  learner: 'observe' | 'consolidate' | 'learn_stats' | 'curate';
}

// ----- research (knowledge-research; routes/knowledgeResearch.ts) -----
export type GapKind = 'insurer_process' | 'legal_point' | 'quantum_point' | 'missing_contact' | 'unfamiliar_document' | 'procedure' | 'engineering' | 'kb_verification' | 'other';
export type GapStatus = 'open' | 'researching' | 'answered_pending' | 'answered' | 'needs_owner' | 'no_answer' | 'out_of_scope' | 'dismissed';
export type GapOrigin = 'agent_report' | 'review_failure' | 'research_no_answer' | 'needs_you' | 'directory_ageing' | 'kb_unverified' | 'intake_unknown' | 'triage_other' | 'source_changed' | 'owner';
export interface KnowledgeGapView {
  id: string;
  gapKey: string;
  kind: GapKind;
  question: string;
  area: KnowledgeArea;
  scope: KnowledgeScope;
  origin: GapOrigin;
  originRef: string | null;
  claimIds: string[];
  blocking: boolean;
  occurrences: number;
  priority: number;
  status: GapStatus;
  attempts: number;
  nextAttemptAt: ISODateTime | null;
  answerItemIds: string[];
  raisedBy: string;
  createdAt: ISODateTime;
  lastSeenAt: ISODateTime;
  closedBy: string | null;
  closedAt: ISODateTime | null;
  closeNote: string | null;
  needsYouId: string | null;
}
export interface SourceView {
  domain: string;
  policy: 'api' | 'code_fetch' | 'agent_fetch' | 'link_only' | 'deny';
  access: string;
  licence: string;
  extractAllowed: boolean;
  maxQuoteWords: number;
  tags: string[];
  perMinute: number;
  perDay: number;
  enabled: boolean;
  origin: 'builtin' | 'insurer_directory' | 'owner';
  selftest: unknown;
  lastFetchAt: ISODateTime | null;
  lastStatus: number | null;
  fetchesToday: number;
}
export interface SnapshotView {
  id: string;
  url: string;
  finalUrl: string;
  domain: string;
  fetchedAt: ISODateTime;
  httpStatus: number;
  contentType: string | null;
  bytes: number;
  sha256: string;
  title: string | null;
  licence: string;
  extractAllowed: boolean;
  previousId: string | null;
  changed: boolean;
  injectionFlags: string[];
  reason: string;
  gapId: string | null;
  /** only when extract is allowed */
  text?: string;
  pruned?: boolean;
}

// ----- use (knowledge-use; routes/knowledgeUse.ts) -----
export type KnowledgeHitView = Pick<KnowledgeHit, 'ref' | 'layer' | 'kind' | 'area' | 'title' | 'text' | 'badges' | 'rank' | 'score' | 'whyRanked' | 'mayCiteOutbound' | 'itemKey' | 'computed' | 'external'>;
export interface KnowledgeSearchResponse {
  hits: KnowledgeHitView[];
  /** the exact block the agent would see */
  block: string;
}
export interface KnowledgeUsedResponse {
  targetKind: 'outbox' | 'document' | 'docx';
  targetId: string;
  refs: { ref: string; badges: KnowledgeBadge[]; cited: boolean; title: string | null; itemId: string | null }[];
}
export interface EvalRunView {
  id: string;
  mode: 'gate' | 'nightly' | 'drafts';
  baselineVersion: number | null;
  candidate: unknown;
  cases: number;
  metrics: unknown;
  verdict: 'no_worse' | 'worse' | 'inconclusive' | 'error';
  details: unknown;
  startedAt: ISODateTime;
  finishedAt: ISODateTime | null;
  createdBy: string;
}
export interface KnowledgeAlarmView {
  id: string;
  metric: string;
  packVersion: number | null;
  baseline: number | null;
  current: number | null;
  n: number;
  threshold: number;
  severity: 'warn' | 'severe';
  status: 'open' | 'acknowledged' | 'resolved';
  actionTaken: string | null;
  needsYouId: string | null;
  raisedAt: ISODateTime;
  resolvedBy: string | null;
  resolvedAt: ISODateTime | null;
}
export interface ReplayBody {
  mode: 'gate' | 'nightly' | 'drafts';
  itemIds?: string[];
}
