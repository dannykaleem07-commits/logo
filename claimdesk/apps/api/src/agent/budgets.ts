// owned by runtime
/**
 * Usage windows and budgets (docs/SUPREME-DESIGN.md §A.5, §C.3, §C.4). Pure functions: the supervisor reads
 * `ai_usage_state` + `agent_settings` and asks these which AI jobs may start.
 *
 *   five-hour utilisation < 0.6               → all
 *   0.6 – 0.8                                 → priority ≤ 5
 *   0.8 – (1 − reserve)                       → priority ≤ 3   (reserve default 20 %)
 *   ≥ (1 − reserve) or `allowed_warning`      → priority ≤ 1
 *   `rejected`                                → none until resetsAt + 2 min
 *   seven-day ≥ 0.85 / ≥ 0.95                 → priority ≤ 3 / ≤ 1 ("economy mode")
 *
 * Deterministic lanes (io, cpu) never pause for usage.
 */
import type { AgentName, ISODateTime, Lane } from '@ccguk/domain';
import type { AgentSettingsRecord, AiUsageStateRecord } from '@ccguk/db';
import type { RateLimitSnapshot } from '../ai/types.js';

/** "All priorities" (the lease query compares `priority <= maxPriority`). */
export const ALL_PRIORITIES = 1_000;
/** No job may start. */
export const NO_PRIORITY = -1;
/** A usage-limit refusal holds the AI lane until the reset plus this margin (§A.5). */
export const USAGE_RESUME_MARGIN_MS = 2 * 60_000;

export interface AiGate {
  /** Highest priority number an AI job may have to start (NO_PRIORITY = none). */
  maxPriority: number;
  /** Why the gate is where it is ('ok', 'paused', 'five_hour_0.6', 'seven_day_economy', 'daily_cap', …). */
  reason: string;
  /** Seven-day economy banner (§A.5). */
  economy: boolean;
  /** When set, the supervisor stores this pause in `ai_usage_state` (rejected window / daily cap). */
  pauseUntil?: ISODateTime;
  pauseReason?: string;
}

const isSnapshot = (v: unknown): v is RateLimitSnapshot => typeof v === 'object' && v !== null && typeof (v as { status?: unknown }).status === 'string';

/** A snapshot whose window has already reset says nothing about now. */
function current(s: unknown, now: ISODateTime): RateLimitSnapshot | undefined {
  if (!isSnapshot(s)) return undefined;
  if (s.resetsAt && Date.parse(s.resetsAt) <= Date.parse(now)) return undefined;
  return s;
}

const addMs = (iso: ISODateTime, ms: number): ISODateTime => new Date(Date.parse(iso) + ms).toISOString();

/** Five-hour band → priority ceiling (§A.5 table). `reservePercent` is "leave X % for me". */
export function fiveHourCeiling(snapshot: RateLimitSnapshot | undefined, reservePercent: number): { maxPriority: number; reason: string } {
  if (!snapshot) return { maxPriority: ALL_PRIORITIES, reason: 'ok' };
  if (snapshot.status === 'rejected') return { maxPriority: NO_PRIORITY, reason: 'five_hour_rejected' };
  const reserve = Math.min(Math.max(reservePercent, 0), 90) / 100;
  const u = typeof snapshot.utilization === 'number' && Number.isFinite(snapshot.utilization) ? snapshot.utilization : 0;
  if (snapshot.status === 'allowed_warning' || u >= 1 - reserve) return { maxPriority: 1, reason: 'five_hour_reserve' };
  if (u >= 0.8) return { maxPriority: 3, reason: 'five_hour_0.8' };
  if (u >= 0.6) return { maxPriority: 5, reason: 'five_hour_0.6' };
  return { maxPriority: ALL_PRIORITIES, reason: 'ok' };
}

/** Seven-day band → priority ceiling and the economy flag. */
export function sevenDayCeiling(snapshot: RateLimitSnapshot | undefined): { maxPriority: number; reason: string; economy: boolean } {
  if (!snapshot) return { maxPriority: ALL_PRIORITIES, reason: 'ok', economy: false };
  if (snapshot.status === 'rejected') return { maxPriority: NO_PRIORITY, reason: 'seven_day_rejected', economy: true };
  const u = typeof snapshot.utilization === 'number' && Number.isFinite(snapshot.utilization) ? snapshot.utilization : 0;
  if (u >= 0.95) return { maxPriority: 1, reason: 'seven_day_0.95', economy: true };
  if (u >= 0.85) return { maxPriority: 3, reason: 'seven_day_0.85', economy: true };
  return { maxPriority: ALL_PRIORITIES, reason: 'ok', economy: false };
}

export interface AiGateInput {
  usage: AiUsageStateRecord;
  settings: Pick<AgentSettingsRecord, 'ai'>;
  now: ISODateTime;
  /** London day (YYYY-MM-DD) of `now`, for the API daily cap. */
  today: string;
  /** London midnight that ends `today` (where a daily-cap pause ends). */
  nextDayStart: ISODateTime;
}

/** The AI-lane gate from the usage state (§A.5). */
export function aiGate(input: AiGateInput): AiGate {
  const { usage, settings, now } = input;
  if (usage.pausedUntil && usage.pausedUntil > now) return { maxPriority: NO_PRIORITY, reason: `paused:${usage.pauseReason ?? 'usage'}`, economy: false };
  const five = current(usage.fiveHour, now);
  const seven = current(usage.sevenDay, now);
  // Rejected window: hold the lane until the reset + 2 minutes.
  for (const [s, label] of [[five, 'five_hour'], [seven, 'seven_day']] as const) {
    if (s?.status === 'rejected') {
      const until = s.resetsAt ? addMs(s.resetsAt, USAGE_RESUME_MARGIN_MS) : addMs(now, 30 * 60_000);
      return { maxPriority: NO_PRIORITY, reason: `${label}_rejected`, economy: label === 'seven_day', pauseUntil: until, pauseReason: 'usage_limited' };
    }
  }
  // API mode: the daily USD cap pauses until London midnight.
  if (settings.ai.driver === 'api_key' && settings.ai.dailyUsdCap > 0 && usage.costDay === input.today && usage.costTodayUsd >= settings.ai.dailyUsdCap) {
    return { maxPriority: NO_PRIORITY, reason: 'daily_cap', economy: false, pauseUntil: input.nextDayStart, pauseReason: 'daily_cap' };
  }
  const f = fiveHourCeiling(five, settings.ai.reservePercent);
  const s = sevenDayCeiling(seven);
  if (s.maxPriority < f.maxPriority) return { maxPriority: s.maxPriority, reason: s.reason, economy: s.economy };
  return { maxPriority: f.maxPriority, reason: f.reason, economy: s.economy };
}

// ---------------------------------------------------------------------------
// Lane concurrency (§C.3)
// ---------------------------------------------------------------------------

export interface LaneLimits {
  lanes: Record<Lane, number>;
  /** Per-agent caps on the AI lane (subscription mode only); empty in API mode. */
  agentCaps: Partial<Record<AgentName | 'system', number>>;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(Math.round(Number.isFinite(n) ? n : lo), lo), hi);

/**
 * Effective concurrency (§C.3): the AI lane is 1 on the subscription (range 1–3) and 3 on the API (range 1–6). The
 * stored settings always carry a value (defaults are merged in), so in API mode the subscription default of 1 reads as
 * "not chosen" → 3; an owner who wants a single AI slot on the API uses the agent caps or pauses agents instead.
 */
export function laneLimits(settings: Pick<AgentSettingsRecord, 'ai' | 'agents'>): LaneLimits {
  const api = settings.ai.driver === 'api_key';
  const stored = settings.ai.lanes.ai;
  const ai = api ? (stored <= 1 ? 3 : clamp(stored, 1, 6)) : clamp(stored, 1, 3);
  return {
    lanes: { ai, io: clamp(settings.ai.lanes.io, 1, 16), cpu: clamp(settings.ai.lanes.cpu, 1, 8) },
    agentCaps: api ? {} : { ...settings.agents.caps },
  };
}

// ---------------------------------------------------------------------------
// Retry backoff
// ---------------------------------------------------------------------------

export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 60 * 60_000;

/**
 * Exponential backoff with jitter for attempt `attempt` (1-based): base·2^(attempt−1), capped, ±20 % jitter, never
 * less than the handler's own `afterMs`.
 */
export function retryDelayMs(attempt: number, afterMs = 0, random: () => number = Math.random): number {
  const exp = Math.min(RETRY_BASE_MS * 2 ** Math.max(attempt - 1, 0), RETRY_MAX_MS);
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.max(Math.round(exp * jitter), Math.max(afterMs, 0));
}
