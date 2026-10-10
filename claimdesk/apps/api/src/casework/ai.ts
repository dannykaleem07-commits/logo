// owned by casework
/** Shared helpers for the casework AI handlers: AI outcome → job outcome, and the per-claim AI budget (§C.4). */
import { DEFAULT_CLAIM_RUNS_PER_DAY, type ISODateTime } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { AiRunOutcome } from '../ai/types.js';
import type { JobOutcome } from '../agent/contracts.js';
import { authFailedWait, londonDay } from '../agent/core.js';

/** AI switched off / forbidden / fake not allowed: not a failure worth retrying. */
export const isAiOff = (o: AiRunOutcome): boolean => o.kind === 'error' && (o.code === 'AI_OFF' || o.code === 'REAL_AI_FORBIDDEN' || o.code === 'FAKE_AI_NOT_ALLOWED' || o.code === 'DRIVER_UNAVAILABLE');

/** A non-ok AI outcome as a job outcome (null for ok). usage_limited → wait_usage (no attempt used). */
export function aiFailure(ctx: AppContext, o: AiRunOutcome): JobOutcome | null {
  switch (o.kind) {
    case 'ok':
      return null;
    case 'usage_limited':
      return { kind: 'wait_usage', until: o.resetsAt ?? new Date(Date.parse(ctx.now()) + 15 * 60_000).toISOString() };
    case 'auth_failed':
      return authFailedWait(ctx, o.message);
    case 'refused':
      return { kind: 'fail', reason: `The model refused: ${o.explanation ?? o.category ?? 'no reason given'}` };
    case 'invalid_output':
      return { kind: 'retry', afterMs: 60_000, reason: `invalid output: ${o.errors.slice(0, 3).join('; ')}` };
    case 'timeout':
      return { kind: 'retry', afterMs: 60_000, reason: 'the model run timed out' };
    case 'error':
      if (isAiOff(o)) return { kind: 'fail', reason: o.message };
      return o.retryable ? { kind: 'retry', afterMs: 60_000, reason: o.message } : { kind: 'fail', reason: o.message };
  }
}

/** The per-claim AI runs allowed per day (Settings > AI `perClaimRunsPerDay`, default 8). */
export function claimBudget(ctx: AppContext): number {
  const n = ctx.repos.getAgentSettings(ctx.db).ai.perClaimRunsPerDay;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CLAIM_RUNS_PER_DAY;
}

export interface BudgetCheck {
  allowed: boolean;
  used: number;
  limit: number;
  day: string;
}

/** Is another AI run on this claim allowed today? Owner-triggered runs are exempt (`exempt`). */
export function checkClaimBudget(ctx: AppContext, claimId: string, exempt = false, now: ISODateTime = ctx.now()): BudgetCheck {
  const day = londonDay(now);
  const used = ctx.repos.claimRunsToday(ctx.db, claimId, day);
  const limit = claimBudget(ctx);
  return { allowed: exempt || used < limit, used, limit, day };
}

/** Count one AI run against the claim's budget (owner-triggered runs are still counted for the record). */
export function countClaimRun(ctx: AppContext, claimId: string, now: ISODateTime = ctx.now()): number {
  return ctx.repos.countClaimRun(ctx.db, claimId, londonDay(now));
}
