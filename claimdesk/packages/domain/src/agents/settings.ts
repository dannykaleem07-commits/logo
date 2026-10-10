/**
 * Agent settings stored in `agent_settings` (one row, §N.1): AI (§A.5, §A.6, §C.3), notifications (§J.1), agents
 * (enable / per-agent pause / per-agent caps), and the Settings > AI setup checklist (§A.7). Autonomy settings live in
 * `../autonomy`. The db repo merges stored JSON over these defaults, so a new key never needs a migration.
 */
import type { AgentName, JobType } from './types.js';

export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AiDriverChoice = 'subscription_cli' | 'api_key' | 'off';

export interface AiJobModel {
  model: string;
  effort: AiEffort;
  maxTurns: number;
  timeoutMs: number;
}

/** §A.6 defaults (both drivers). Only AI job types appear; `review.check` is the critic tier. */
export const AI_JOB_DEFAULTS: Readonly<Partial<Record<JobType, AiJobModel & { agent: AgentName }>>> = {
  'mail.triage': { agent: 'mail', model: 'claude-sonnet-5-5', effort: 'low', maxTurns: 1, timeoutMs: 3 * 60_000 },
  'mail.reply': { agent: 'mail', model: 'claude-opus-5-5', effort: 'medium', maxTurns: 12, timeoutMs: 8 * 60_000 },
  'intake.extract': { agent: 'intake', model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 6, timeoutMs: 6 * 60_000 },
  'case.review': { agent: 'case_manager', model: 'claude-opus-5-5', effort: 'medium', maxTurns: 16, timeoutMs: 10 * 60_000 },
  'offer.analyse': { agent: 'case_manager', model: 'claude-opus-5-5', effort: 'high', maxTurns: 12, timeoutMs: 10 * 60_000 },
  'draft.compose': { agent: 'drafter', model: 'claude-opus-5-5', effort: 'medium', maxTurns: 16, timeoutMs: 10 * 60_000 },
  'review.check': { agent: 'reviewer', model: 'claude-opus-5-5', effort: 'high', maxTurns: 6, timeoutMs: 8 * 60_000 },
  'research.ask': { agent: 'researcher', model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 10, timeoutMs: 6 * 60_000 },
  'dailylog.compile': { agent: 'supervisor', model: 'claude-sonnet-5-5', effort: 'low', maxTurns: 1, timeoutMs: 2 * 60_000 },
  // Autopilot (docs/SUPREME-AUTOPILOT.md §H.1)
  'autopilot.judge': { agent: 'case_manager', model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 6, timeoutMs: 5 * 60_000 },
  'hire_offer.parse_reply': { agent: 'mail', model: 'claude-sonnet-5-5', effort: 'low', maxTurns: 1, timeoutMs: 2 * 60_000 },
  // Knowledge Builder (docs/SUPREME-KNOWLEDGE-BUILDER.md §10.1)
  'knowledge.research': { agent: 'researcher', model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 12, timeoutMs: 8 * 60_000 },
  'knowledge.research_web': { agent: 'researcher', model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 12, timeoutMs: 10 * 60_000 },
  'knowledge.curate': { agent: 'researcher', model: 'claude-opus-5-5', effort: 'medium', maxTurns: 6, timeoutMs: 8 * 60_000 },
  'knowledge.replay_drafts': { agent: 'drafter', model: 'claude-opus-5-5', effort: 'medium', maxTurns: 8, timeoutMs: 10 * 60_000 },
};

export interface ModelPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  cacheReadPerMTokUsd: number;
}

export interface AiSettings {
  /** Which driver runs agents. 'off' (default after install/upgrade) until the owner completes Settings > AI. */
  driver: AiDriverChoice;
  /** 'economy' moves every Opus row to Sonnet; 'best' moves every Sonnet row to Opus (§A.6). */
  quality: 'standard' | 'economy' | 'best';
  /** Per-job overrides of AI_JOB_DEFAULTS. */
  perJob: Partial<Record<JobType, Partial<AiJobModel>>>;
  /** Lane concurrency (§C.3). `ai` default 1 on the subscription, 3 on the API. */
  lanes: { ai: number; io: number; cpu: number };
  /** Five-hour usage reserve left for the owner's own Claude use (§A.5), percent. */
  reservePercent: number;
  /** API mode: daily spend cap in USD (§A.3). */
  dailyUsdCap: number;
  /** Price table (owner should re-check current prices). */
  prices: Record<string, ModelPrice>;
  /** Per-claim AI runs per day (§C.4; owner-triggered runs exempt). */
  perClaimRunsPerDay: number;
  /** Keep full transcripts (30-day retention, §K.3). */
  debugTranscripts: boolean;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  driver: 'off',
  quality: 'standard',
  perJob: {},
  lanes: { ai: 1, io: 4, cpu: 2 },
  reservePercent: 20,
  dailyUsdCap: 20,
  prices: {
    'claude-opus-5-5': { inputPerMTokUsd: 4, outputPerMTokUsd: 20, cacheReadPerMTokUsd: 0.2 },
    'claude-sonnet-5-5': { inputPerMTokUsd: 2, outputPerMTokUsd: 10, cacheReadPerMTokUsd: 0.2 },
  },
  perClaimRunsPerDay: 8,
  debugTranscripts: false,
};

export interface NotificationSettings {
  /** Windows toasts (§J.1). */
  toasts: boolean;
  /** Lowest Needs-you priority that raises a toast. */
  toastMinPriority: 'urgent' | 'high' | 'normal' | 'low';
  /** Quiet hours suppress toasts below `urgent`. */
  quietHoursSuppressToasts: boolean;
  /** Phase 2: Twilio SMS for `urgent` only. */
  sms: { enabled: boolean; to: string | null; maxPerDay: number };
  /** Daily log compile time, London (HH:MM). */
  dailyLogAt: string;
  /** Phase 2: email the daily log to the owner. */
  dailyLogEmail: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  toasts: true,
  toastMinPriority: 'normal',
  quietHoursSuppressToasts: true,
  sms: { enabled: false, to: null, maxPerDay: 10 },
  dailyLogAt: '18:00',
  dailyLogEmail: false,
};

export interface AgentsSettings {
  /** Master switch: agents run only when true (off after an upgrade until Settings > AI is complete). */
  enabled: boolean;
  /** Agents the owner paused (§C.6). */
  paused: AgentName[];
  /** Per-agent concurrency caps (§C.3, subscription mode). */
  caps: Partial<Record<AgentName, number>>;
}

export const DEFAULT_AGENTS_SETTINGS: AgentsSettings = {
  enabled: false,
  paused: [],
  caps: { mail: 1, case_manager: 1, drafter: 1, reviewer: 1, intake: 1 },
};

/** Settings > AI setup checklist (§A.7): every item must be done before agents can be switched on. */
export type ChecklistItemId = 'training_opt_out' | 'subscription_terms' | 'mailbox_connected' | 'background_running';
export const CHECKLIST_ITEM_IDS: readonly ChecklistItemId[] = ['training_opt_out', 'subscription_terms', 'mailbox_connected', 'background_running'];
export interface ChecklistItemState {
  done: boolean;
  at: string | null;
  by: string | null;
}
export type ChecklistState = Record<ChecklistItemId, ChecklistItemState>;

export const DEFAULT_CHECKLIST: ChecklistState = {
  training_opt_out: { done: false, at: null, by: null },
  subscription_terms: { done: false, at: null, by: null },
  mailbox_connected: { done: false, at: null, by: null },
  background_running: { done: false, at: null, by: null },
};

/** Effective model/effort/turns/timeout for an AI job: defaults ← quality switch ← per-job override. */
export function aiJobModel(settings: Pick<AiSettings, 'quality' | 'perJob'>, type: JobType): AiJobModel | undefined {
  const base = AI_JOB_DEFAULTS[type];
  if (!base) return undefined;
  let model = base.model;
  if (settings.quality === 'economy' && model === 'claude-opus-5-5') model = 'claude-sonnet-5-5';
  if (settings.quality === 'best' && model === 'claude-sonnet-5-5') model = 'claude-opus-5-5';
  const o = settings.perJob[type] ?? {};
  return { model: o.model ?? model, effort: o.effort ?? base.effort, maxTurns: o.maxTurns ?? base.maxTurns, timeoutMs: o.timeoutMs ?? base.timeoutMs };
}

/** Deep merge of stored JSON over defaults: plain objects merge key by key; arrays and scalars replace. */
export function mergeDefaults<T>(defaults: T, stored: unknown): T {
  if (stored === undefined || stored === null) return defaults;
  if (!isPlainObject(defaults)) return stored as T;
  if (!isPlainObject(stored)) return defaults;
  const out: Record<string, unknown> = { ...defaults };
  for (const [k, v] of Object.entries(stored)) {
    if (v === undefined) continue;
    const d = (defaults as Record<string, unknown>)[k];
    // An explicit null is kept (e.g. autonomy quietHours: null = no quiet hours).
    out[k] = v === null ? null : isPlainObject(d) && isPlainObject(v) ? mergeDefaults(d, v) : v;
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
