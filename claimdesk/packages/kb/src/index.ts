/**
 * @ccguk/kb — knowledge base content (JSON) + typed loaders + BM25 retrieval + cited advisor.
 *
 * Nothing here sends anything or upgrades a verification status. Named exports only.
 */

// Types (domain re-exports + KB-only types and enums)
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
  FeeBand,
  FeeKind,
  VerificationStatus,
  Licence,
  CourtFeeKind,
  CourtFeeBand,
  PlaybookStage,
  DueKind,
  PlaybookDue,
  PlaybookActionCode,
  PlaybookRule,
  SearchHit,
  SearchOptions,
  AdvicePoint,
  Advice,
  PaidFasterStep,
  DirectoryStatus,
  CopycatMatch,
  DirectoryAgeing,
} from './types.js';
export {
  KB_ENTRY_TYPES,
  VERIFICATION_STATUSES,
  LICENCES,
  COURT_FEE_KINDS,
  PLAYBOOK_STAGES,
  PLAYBOOK_PRIORITIES,
  DUE_KINDS,
  PLAYBOOK_ACTION_CODES,
} from './types.js';

// Loaders and validators
export {
  KbValidationError,
  DATA_FILES,
  KB_ENTRY_FILES,
  MAX_QUOTE_WORDS,
  dataFileUrl,
  readDataFile,
  resetKbCache,
  isIsoDate,
  validateVerification,
  validateKbEntry,
  validateDirectoryEntry,
  validateGtaRate,
  validateCourtFeeBand,
  validatePlaybookRule,
  loadEntries,
  loadCases,
  loadStatutes,
  loadCpr,
  loadGta,
  loadFca,
  loadFos,
  loadGuidance,
  loadAll,
  entryIndex,
  getEntry,
  loadGtaRates,
  loadCourtFees,
  toDomainFeeBands,
  loadDirectory,
  loadPlaybookRules,
  countVerification,
} from './load.js';
export type { KbDataFile, VerificationCounts } from './load.js';

// Search
export {
  stem,
  tokenise,
  buildIndex,
  resetSearchIndex,
  highlightsFor,
  search,
  findByCitation,
  verificationStatus,
  verificationOf,
  unverifiedAmong,
} from './search.js';
export type { SearchIndex } from './search.js';

// Advisor
export {
  ADVICE_TOPICS,
  FORUM_NOT_OPEN,
  GTA_BENCHMARK,
  RESERVED_ACTIVITY,
  INJURY_PERIMETER,
  ICOBS_SCOPE_CAVEAT,
  BENCHMARK_FIGURES_CAVEAT,
  GTA_4_14_CAVEAT,
  COURT_FEES_CAVEAT,
  MEDIATION_CAVEAT,
  BLUEPRINT_STEP_TITLES,
  advise,
  citedEntries,
  getPaidFasterPlan,
} from './advisor.js';
export type { AdviceTopic } from './advisor.js';

// Directory
export {
  DIRECTORY_AMBER_DAYS,
  DIRECTORY_RED_DAYS,
  daysBetween,
  directoryAgeing,
  directoryStatus,
  searchDirectory,
  normalisePhone,
  normaliseDomain,
  phoneMatchesPattern,
  isCopycat,
  findByPhone,
} from './directory.js';
export type { DirectorySearchHit } from './directory.js';

// GTA rates
export {
  GTA_RATES_BENCHMARK_NOTE,
  gtaRateFor,
  listPeriods,
  listGroups,
  ratesForPeriod,
  periodFor,
  compareGroups,
} from './gtaRates.js';
