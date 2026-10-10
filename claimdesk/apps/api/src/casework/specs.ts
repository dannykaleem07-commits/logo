// owned by casework
/**
 * The casework agents (docs/SUPREME-DESIGN.md §A.6, §B.4 agent → tool subsets, §C.1): case manager (case.review and
 * offer.analyse), drafter, reviewer (critic tier) and researcher. Model / effort / turns / timeout are the §A.6
 * defaults; Settings > AI may override them per job type (runAgent applies that).
 */
import type { ToolName } from '@ccguk/domain';
import type { AgentSpec } from '../agent/contracts.js';

/** Every read tool a claim-scoped agent may use (§B.4 "Read"); `claims_search` is left out — it lists other claims. */
export const READ_TOOLS: readonly ToolName[] = [
  'claim_brief', 'claim_get', 'claim_next_actions', 'claim_clocks', 'claim_gates', 'claim_acceptance', 'events_list', 'ledger_get', 'offers_list',
  'hire_get', 'storage_get', 'recovery_get', 'hire_pricing_guide', 'party_get', 'party_search', 'vehicle_get', 'vehicle_on_file', 'evidence_list',
  'evidence_read', 'documents_list', 'document_get', 'templates_list', 'docx_template_values', 'kb_search', 'kb_entry', 'kb_advise', 'directory_search',
  'directory_get', 'total_loss_assess', 'quantum_settlement', 'mail_thread_get', 'brain_search', 'memory_recall',
  // Knowledge Builder §3.6 (knowledge-use): knowledge_search for every agent with tools; insurer_profile (read)
  'knowledge_search', 'insurer_profile',
];

/** §B.4 case_manager: all read tools + task_schedule, needs_you_create, event_append (note only), memory_note, offer_recommend, payment_received_propose, ledger_propose, legal_escalate. */
export const CASE_MANAGER_TOOLS: readonly ToolName[] = [...READ_TOOLS, 'task_schedule', 'needs_you_create', 'event_append', 'memory_note', 'offer_recommend', 'payment_received_propose', 'ledger_propose', 'legal_escalate', 'knowledge_gap_report'];

/** offer.analyse: read + quantum + offer_recommend (§A.6). */
export const OFFER_ANALYST_TOOLS: readonly ToolName[] = [...READ_TOOLS, 'offer_recommend', 'knowledge_gap_report'];

/** §B.4 drafter. */
export const DRAFTER_TOOLS: readonly ToolName[] = ['claim_brief', 'templates_list', 'docx_template_values', 'documents_list', 'document_get', 'evidence_list', 'kb_search', 'kb_entry', 'brain_search', 'memory_recall', 'document_draft', 'docx_document_draft', 'email_draft', 'knowledge_search', 'knowledge_gap_report', 'insurer_profile'];

/** §B.4 reviewer (critic): read-only, never the drafter's reasoning. */
export const REVIEWER_TOOLS: readonly ToolName[] = ['claim_brief', 'document_get', 'mail_thread_get', 'kb_entry', 'brain_search'];

/** §B.4 researcher. */
export const RESEARCHER_TOOLS: readonly ToolName[] = ['kb_search', 'kb_entry', 'kb_advise', 'brain_search', 'memory_recall', 'claim_brief', 'knowledge_search', 'knowledge_gap_report', 'insurer_profile'];

export const CASE_REVIEW_SPEC: AgentSpec = {
  name: 'case_manager',
  jobType: 'case.review',
  title: 'Case review',
  promptFiles: ['case-manager.md'],
  tools: [...CASE_MANAGER_TOOLS],
  allowRead: true,
  resultSchemaId: 'case_review',
  defaults: { model: 'claude-opus-5-5', effort: 'medium', maxTurns: 16, timeoutMs: 10 * 60_000 },
};

export const OFFER_ANALYSE_SPEC: AgentSpec = {
  name: 'case_manager',
  jobType: 'offer.analyse',
  title: 'Offer analysis',
  promptFiles: ['case-manager.md'],
  tools: [...OFFER_ANALYST_TOOLS],
  allowRead: true,
  resultSchemaId: 'offer_analysis',
  defaults: { model: 'claude-opus-5-5', effort: 'high', maxTurns: 12, timeoutMs: 10 * 60_000 },
};

export const DRAFTER_SPEC: AgentSpec = {
  name: 'drafter',
  jobType: 'draft.compose',
  title: 'Drafter',
  promptFiles: ['drafter.md'],
  tools: [...DRAFTER_TOOLS],
  allowRead: false,
  resultSchemaId: 'drafter',
  defaults: { model: 'claude-opus-5-5', effort: 'medium', maxTurns: 16, timeoutMs: 10 * 60_000 },
};

export const REVIEWER_SPEC: AgentSpec = {
  name: 'reviewer',
  jobType: 'review.check',
  title: 'Reviewer (critic)',
  promptFiles: ['reviewer.md'],
  tools: [...REVIEWER_TOOLS],
  allowRead: false,
  resultSchemaId: 'review_verdict',
  defaults: { model: 'claude-opus-5-5', effort: 'high', maxTurns: 6, timeoutMs: 8 * 60_000 },
};

export const RESEARCHER_SPEC: AgentSpec = {
  name: 'researcher',
  jobType: 'research.ask',
  title: 'Researcher',
  promptFiles: ['researcher.md'],
  tools: [...RESEARCHER_TOOLS],
  allowRead: false,
  resultSchemaId: 'research_answer',
  defaults: { model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 10, timeoutMs: 6 * 60_000 },
};

export const CASEWORK_SPECS: readonly AgentSpec[] = [CASE_REVIEW_SPEC, OFFER_ANALYSE_SPEC, DRAFTER_SPEC, REVIEWER_SPEC, RESEARCHER_SPEC];
