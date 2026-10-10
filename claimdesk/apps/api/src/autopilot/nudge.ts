// owned by ap-foundation
/**
 * nudgeAutopilot (docs/SUPREME-AUTOPILOT.md §0.5, §H.1): ask for an `autopilot.tick` on one claim now — called by the
 * booking / offer / pack / signing / event routes and Needs-you resolutions when something the plan depends on changed.
 *
 * Idempotent per claim per London minute (`autopilot.tick:<claimId>:<YYYY-MM-DDTHH:MM London>`), so a burst of writes
 * makes one tick. Best effort: until a handler for `autopilot.tick` is registered (ap-autopilot) nothing is queued —
 * the 5-minute `autopilot.sweep` catches every claim up anyway — and a failure to enqueue never fails the caller.
 */
import type { AppContext } from '../context.js';
import type { JobRecord } from '../agent/contracts.js';
import { enqueueJob, londonDay, londonHhmm } from '../agent/core.js';
import { getJobHandler } from '../agent/handlers/index.js';

/** Who a nudge is recorded as (the deterministic Autopilot principal). */
export const AUTOPILOT_ACTOR = 'agent:autopilot';

export interface NudgeOptions {
  /** Queue the tick after this instant instead of now (e.g. a hold that expires later). */
  runAfter?: string;
  /** The job that caused the nudge (correlation and hand-off depth). */
  parentJobId?: string;
  /** Who asked (default agent:autopilot); a person's "Run now" passes their user id. */
  createdBy?: string;
  /** A step the tick should treat as due (§A.8 "Run now"). */
  forceStepId?: string;
}

/** The §H.1 idempotency key for a tick on `claimId` at `at`. */
export function autopilotTickKey(claimId: string, at: string): string {
  return `autopilot.tick:${claimId}:${londonDay(at)}T${londonHhmm(at)}`;
}

/** Enqueue `autopilot.tick` for the claim (or return the tick already queued this minute). */
export function nudgeAutopilot(ctx: AppContext, claimId: string, reason: string, opts: NudgeOptions = {}): JobRecord | undefined {
  if (!claimId) return undefined;
  if (!getJobHandler('autopilot.tick')) return undefined;
  const at = opts.runAfter ?? ctx.now();
  try {
    return enqueueJob(ctx, {
      type: 'autopilot.tick',
      claimId,
      payload: { claimId, reason: reason.slice(0, 200), ...(opts.forceStepId ? { forceStepId: opts.forceStepId } : {}) },
      idempotencyKey: `${autopilotTickKey(claimId, at)}${opts.forceStepId ? `:run:${opts.forceStepId}` : ''}`,
      ...(opts.runAfter ? { runAfter: opts.runAfter } : {}),
      ...(opts.parentJobId ? { parentJobId: opts.parentJobId } : {}),
      createdBy: opts.createdBy ?? AUTOPILOT_ACTOR,
    });
  } catch (err) {
    ctx.logger.warn('could not nudge the autopilot', { claimId, reason, error: String(err) });
    return undefined;
  }
}
