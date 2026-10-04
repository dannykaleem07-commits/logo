// consistency module — BLUEPRINT §3.7, §3.8, §3.10 position-consistency engine. Named exports only.
export {
  checkDraft,
  clearFlag,
  isBlocked,
  amountChecks,
  deadlineChecks,
  offerChecks,
  storageChecks,
  hireChecks,
  payeeChecks,
  creationDateChecks,
  priorLetterChecks,
  forumChecks,
  gtaChecks,
  citationChecks,
  referenceChecks,
  AT_FAULT_INSURER_TEMPLATES,
  TEMPLATE_CLOCKS,
  ROLE_CLOCKS,
  type DraftContext,
  type RecipientRole
} from './checks.js';
export {
  extractAmounts,
  extractDates,
  extractDeadlines,
  extractCitations,
  type AmountContext,
  type ExtractedAmount,
  type ExtractedDate,
  type ExtractedDeadline,
  type ExtractedCitation,
  type DeadlineOptions
} from './extract.js';
export {
  legacyCheck,
  bannedPhraseCheck,
  legacy,
  LEGACY_BLOCKED_STRINGS,
  LEGACY_ALLOWED_EXACT_CASE,
  BANNED_PHRASES,
  REGULATED_STATUS_PHRASES,
  REGULATED_STATUS_WARN_PHRASES,
  REGULATED_STATUS_REGEXES,
  REGISTERED_NAME
} from './legacy.js';
export { toPlainText } from './text.js';
