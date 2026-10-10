// owned by ap-booking
/**
 * booking job handlers (docs/SUPREME-AUTOPILOT.md §H.1). Registered by agent/handlers/index.ts. All deterministic (no
 * model): fleet housekeeping is not an agent action, so it still runs while a claim's autopilot is paused (§A.7 step 3).
 *
 *   booking.expire_holds    every 5 min   held reservations past their expiry → expired; the claim's tick re-plans
 *   fleet.status_sync       hourly        fleet status derived from the diary (§B.10)
 *   fleet.compliance_watch  06:30         MOT / tax / service / PHV licence readiness tasks 30 days ahead
 *   movement.remind         16:00         tomorrow's deliveries and collections: a reminder to the client (booking_update,
 *                                          drafted as agent:autopilot through the normal review and send policy)
 */
import { z } from 'zod';
import { addCalendarDays, isoToMs, londonDate, londonDateTime, msToUtcIso } from '@ccguk/domain';
import type { AppContext } from '../../context.js';
import type { JobHandler, NeedsYouResolver } from '../contracts.js';
import { complianceWatch, expireHolds, fleetStatusSync } from '../../booking/service.js';
import { actAsAutopilot } from '../../autopilot/act.js';

const AUTOPILOT_ACTOR = 'agent:autopilot';

const expireHoldsHandler: JobHandler<Record<string, unknown>, unknown> = {
  type: 'booking.expire_holds',
  agent: 'autopilot',
  lane: 'io',
  usesAi: false,
  mutatesClaim: true,
  payload: z.object({}).passthrough(),
  defaultPriority: 1,
  maxAttempts: 3,
  timeoutMs: 5 * 60_000,
  async run({ ctx }) {
    return { kind: 'done', result: expireHolds(ctx, AUTOPILOT_ACTOR) };
  },
};

const statusSyncHandler: JobHandler<Record<string, unknown>, unknown> = {
  type: 'fleet.status_sync',
  agent: 'autopilot',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({}).passthrough(),
  defaultPriority: 5,
  maxAttempts: 3,
  timeoutMs: 5 * 60_000,
  async run({ ctx }) {
    return { kind: 'done', result: fleetStatusSync(ctx) };
  },
};

const complianceWatchHandler: JobHandler<{ aheadDays?: number }, unknown> = {
  type: 'fleet.compliance_watch',
  agent: 'autopilot',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({ aheadDays: z.number().int().min(1).max(120).optional() }).passthrough(),
  defaultPriority: 5,
  maxAttempts: 3,
  timeoutMs: 10 * 60_000,
  async run({ ctx, payload }) {
    return { kind: 'done', result: complianceWatch(ctx, payload.aheadDays ?? 30, AUTOPILOT_ACTOR) };
  },
};

const REMINDER_TEXT: Record<string, { subject: string; body: string }> = {
  delivery: {
    subject: 'Reminder: your replacement car is being delivered tomorrow',
    body: 'This is a reminder that your replacement car is due to be delivered to you tomorrow, in the time window we agreed with you.\n\nPlease have your driving licence ready, and allow a few minutes to look over the car and sign the paperwork with our driver. If the time no longer suits you, simply reply to this email and we will rearrange it.',
  },
  collection: {
    subject: 'Reminder: we are collecting the replacement car tomorrow',
    body: 'This is a reminder that we are due to collect the replacement car from you tomorrow, in the time window we agreed with you.\n\nPlease remove your belongings and have the keys ready. If the time no longer suits you, simply reply to this email and we will rearrange it.',
  },
};

/** The reminders that would go out for movements starting tomorrow (London), skipping any already reminded. */
export function dueReminders(ctx: AppContext): Array<{ movementId: string; claimId: string; kind: string; to: string }> {
  const today = londonDate(ctx.now());
  const tomorrow = addCalendarDays(today, 1);
  const from = msToUtcIso(isoToMs(londonDateTime(tomorrow, 0)));
  const to = msToUtcIso(isoToMs(londonDateTime(addCalendarDays(tomorrow, 1), 0)));
  const out: Array<{ movementId: string; claimId: string; kind: string; to: string }> = [];
  for (const m of ctx.repos.listMovements(ctx.db, { from, to, status: ['planned', 'confirmed'] })) {
    if (m.kind !== 'delivery' && m.kind !== 'collection') continue;
    if (ctx.repos.listAudit(ctx.db, { entityId: m.id, action: 'movement.remind' }).length) continue;
    const claim = ctx.repos.getClaim(ctx.db, m.claimId);
    const email = claim ? ctx.repos.getParty(ctx.db, claim.claimantId)?.email : undefined;
    if (!email) continue;
    out.push({ movementId: m.id, claimId: m.claimId, kind: m.kind, to: email });
  }
  return out;
}

const movementRemindHandler: JobHandler<Record<string, unknown>, unknown> = {
  type: 'movement.remind',
  agent: 'autopilot',
  lane: 'io',
  usesAi: false,
  mutatesClaim: false,
  payload: z.object({}).passthrough(),
  defaultPriority: 4,
  maxAttempts: 3,
  timeoutMs: 10 * 60_000,
  async run({ ctx, job }) {
    const sent: Array<{ movementId: string; ok: boolean; outboxId?: string; error?: string }> = [];
    for (const r of dueReminders(ctx)) {
      const text = REMINDER_TEXT[r.kind]!;
      const res = await actAsAutopilot(ctx, {
        claimId: r.claimId,
        step: null,
        tool: 'email_draft',
        input: { claimId: r.claimId, kind: 'booking_update', to: [r.to], cc: null, subject: text.subject, bodyText: `${text.body}\n\nKind regards,\nClaims Team, Courtesy Cars Group UK Ltd`, attach: [], inReplyToMessageId: null },
        jobId: job.id,
      });
      let outboxId: string | undefined;
      try {
        outboxId = (JSON.parse(res.content) as { outboxId?: string }).outboxId;
      } catch {
        /* non-JSON tool output */
      }
      // One reminder per movement, whatever happened (a failed draft is visible in the run and the daily log).
      ctx.repos.appendAudit(ctx.db, { actor: { userId: AUTOPILOT_ACTOR, runId: res.runId }, action: 'movement.remind', entity: 'fleet_movements', entityId: r.movementId, after: { claimId: r.claimId, kind: r.kind, ok: res.ok, outboxId: outboxId ?? null }, at: ctx.now() });
      sent.push({ movementId: r.movementId, ok: res.ok, ...(outboxId ? { outboxId } : {}), ...(res.ok ? {} : { error: res.content.slice(0, 300) }) });
    }
    return { kind: 'done', result: { reminders: sent } };
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const bookingJobHandlers: JobHandler<any, any>[] = [expireHoldsHandler, statusSyncHandler, complianceWatchHandler, movementRemindHandler];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry
export const bookingNeedsYouResolvers: NeedsYouResolver<any>[] = [];
