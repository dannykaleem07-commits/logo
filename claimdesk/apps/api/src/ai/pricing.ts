/**
 * API-key spend (docs/SUPREME-DESIGN.md §A.3 "Spend cap", §A.5) — owned by `gateway`.
 *
 * Cost = usage × the price table in Settings > AI (defaults in @ccguk/domain DEFAULT_AI_SETTINGS.prices; the owner
 * should re-check current prices). Cache writes are priced at the input rate × 2 (1-hour TTL writes), cache reads at
 * the cache-read rate. The daily USD cap pauses AI until the next London midnight and raises one Needs-you item.
 */
import { DEFAULT_AI_SETTINGS, londonWallToUtc, utcToLondonWall, type ModelPrice } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { createNeedsYou, londonDay } from '../agent/core.js';
import type { AiUsage } from './types.js';

/** Multiplier on the input price for a 1-hour cache write. */
export const CACHE_WRITE_1H_MULTIPLIER = 2;

export function priceFor(model: string, prices: Record<string, ModelPrice> = DEFAULT_AI_SETTINGS.prices): ModelPrice | undefined {
  if (prices[model]) return prices[model];
  // Dated / suffixed ids (e.g. "claude-opus-5-5-20261001", "claude-opus-5-5[1m]") price as their base model.
  const base = Object.keys(prices).find((k) => model.startsWith(k));
  return base ? prices[base] : undefined;
}

/** USD cost of one run's usage (0 when the model has no price row). */
export function costUsd(usage: Pick<AiUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>, model: string, prices?: Record<string, ModelPrice>): number {
  const p = priceFor(model, prices);
  if (!p) return 0;
  const perTok = (perMTok: number) => perMTok / 1_000_000;
  const cost =
    usage.inputTokens * perTok(p.inputPerMTokUsd) +
    usage.outputTokens * perTok(p.outputPerMTokUsd) +
    usage.cacheReadTokens * perTok(p.cacheReadPerMTokUsd) +
    usage.cacheWriteTokens * perTok(p.inputPerMTokUsd * CACHE_WRITE_1H_MULTIPLIER);
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** The UTC instant of the next London midnight after `iso`. */
export function nextLondonMidnight(iso: string): string {
  const w = new Date(utcToLondonWall(Date.parse(iso)));
  return new Date(londonWallToUtc(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() + 1))).toISOString();
}

/**
 * Add an API run's cost to today's total; at or over the daily cap → pause AI until London midnight and raise
 * Needs-you `ai_paused` (once per day). Returns the run cost and whether the cap was hit.
 */
export function recordApiCost(ctx: AppContext, usage: AiUsage, model: string): { costUsd: number; capped: boolean } {
  const settings = ctx.repos.getAgentSettings(ctx.db).ai;
  const cost = usage.costUsd ?? costUsd(usage, model, settings.prices);
  const now = ctx.now();
  const day = londonDay(now);
  const state = ctx.repos.addAiCost(ctx.db, { usd: cost, day, now });
  const capped = settings.dailyUsdCap > 0 && state.costTodayUsd >= settings.dailyUsdCap;
  if (capped) {
    const until = nextLondonMidnight(now);
    ctx.repos.pauseAi(ctx.db, { until, reason: 'daily_cap', now });
    createNeedsYou(ctx, {
      kind: 'ai_paused',
      title: 'AI paused: daily spend cap reached',
      summary: `Anthropic API spend today is $${state.costTodayUsd.toFixed(2)}, at or over the daily cap of $${settings.dailyUsdCap.toFixed(2)}. AI work is paused until midnight (London) and resumes by itself; deterministic work (mail, sends, clocks) continues. Raise the cap in Settings > AI to resume sooner.`,
      payload: { reason: 'daily_cap', costTodayUsd: state.costTodayUsd, capUsd: settings.dailyUsdCap, until },
      priority: 'high',
      createdBy: 'system',
      dedupeKey: `ai_paused:daily_cap:${day}`,
    });
  }
  return { costUsd: cost, capped };
}
