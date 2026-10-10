// owned by ap-autopilot
/**
 * Daily-log sections for the Autopilot (docs/SUPREME-AUTOPILOT.md §I.9), built from autopilot_log,
 * fleet_reservation_events, fleet_movements, readiness tasks, clash_findings and audit rows of one London day:
 *
 *   autopilot  steps the autopilot acted on (with the policy rule ids of the run), holds placed / expired, offers sent /
 *              accepted / declined / expired, bookings confirmed, packs approved, status changes;
 *   fleet      today's and tomorrow's deliveries and collections, cars returned, readiness tasks due;
 *   clashes    new / overridden / resolved findings with their codes (clash service).
 *
 * Every line carries the claim reference (when there is one), a step id or code in `ruleIds`, and a link. Sections
 * are absent when empty.
 */
import { formatRegistration, stepTitle } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import type { DailyLog, LogLine } from '../agent/dailyLog.js';
import { clashDailyLogLines } from '../clash/service.js';

const DAY = 86_400_000;

/** Notes that only name an internal job ("draft.compose <uuid>", "judge <uuid>"): not shown to the owner. */
const INTERNAL_NOTE = /^(draft\.compose|judge|parse_reply) [0-9a-f-]{36}$/;

export function autopilotDailyLogSections(ctx: AppContext, _day: string, bounds: { start: string; end: string }): Pick<DailyLog['sections'], 'autopilot' | 'fleet' | 'clashes'> {
  const refs = new Map<string, string>();
  const ref = (claimId: string): string => {
    if (!refs.has(claimId)) refs.set(claimId, ctx.repos.getClaim(ctx.db, claimId)?.reference ?? claimId);
    return refs.get(claimId)!;
  };
  const ruleIdsOf = (runId?: string): string[] => {
    if (!runId) return [];
    const ids = new Set<string>();
    for (const a of ctx.repos.listAudit(ctx.db, { entityId: runId, action: 'agent.policy' })) for (const r of ((a.after as { ruleIds?: string[] } | undefined)?.ruleIds ?? [])) ids.add(r);
    return [...ids];
  };
  const inDay = (iso: string | undefined | null): boolean => Boolean(iso) && Date.parse(iso!) >= Date.parse(bounds.start) && Date.parse(iso!) < Date.parse(bounds.end);

  // --- autopilot -----------------------------------------------------------------
  const autopilot: LogLine[] = [];
  for (const e of ctx.repos.listAutopilotLog(ctx.db, { from: bounds.start, to: bounds.end })) {
    if (!e.action || e.action.startsWith('reply:') || e.action.startsWith('seen:')) continue;
    const title = e.stepId === '*' ? 'Autopilot' : stepTitle(e.stepId);
    const what = e.action.startsWith('override:') ? `${e.actor} set "${e.action.slice(9)}"` : e.action === 'pause' ? `paused by ${e.actor}` : e.action === 'resume' ? `resumed by ${e.actor}` : e.action === 'owner_choice' ? `car chosen by ${e.actor}` : e.toStatus === 'failed' ? `failed (${e.action})` : e.action.startsWith('draft:') ? 'draft asked for' : e.action.replace(/^tool:/, '').replace(/_/g, ' ');
    const policy = ruleIdsOf(e.runId);
    autopilot.push({
      at: e.at,
      claimId: e.claimId,
      reference: ref(e.claimId),
      agent: 'autopilot',
      text: `${title}: ${what}${e.note && !INTERNAL_NOTE.test(e.note) ? ` — ${e.note}` : ''}`.slice(0, 500),
      ruleIds: [e.stepId, ...policy],
      link: `/claims/${e.claimId}?tab=autopilot`,
    });
  }
  const resEvents = ctx.handle.sqlite
    .prepare(`SELECT e.reservation_id AS reservationId, e.from_status AS fromStatus, e.to_status AS toStatus, e.actor, e.reason, e.at, r.claim_id AS claimId, r.fleet_unit_id AS fleetUnitId FROM fleet_reservation_events e JOIN fleet_reservations r ON r.id = e.reservation_id WHERE e.at >= ? AND e.at < ? ORDER BY e.at, e.rowid`)
    .all(bounds.start, bounds.end) as Array<{ reservationId: string; fromStatus: string | null; toStatus: string; actor: string; reason: string | null; at: string; claimId: string; fleetUnitId: string }>;
  const regOf = (unitId: string): string => {
    const u = ctx.repos.getFleetUnit(ctx.db, unitId);
    const v = u ? ctx.repos.getVehicle(ctx.db, u.vehicleId) : undefined;
    return v ? formatRegistration(v.registration) : unitId;
  };
  const WORD: Record<string, string> = { held: 'held', confirmed: 'booking confirmed', on_hire: 'on hire', returned: 'returned', cancelled: 'released', expired: 'hold expired' };
  for (const r of resEvents) {
    if (r.fromStatus === r.toStatus) continue;
    autopilot.push({ at: r.at, claimId: r.claimId, reference: ref(r.claimId), agent: 'autopilot', text: `${regOf(r.fleetUnitId)}: ${WORD[r.toStatus] ?? r.toStatus}${r.reason ? ` (${r.reason})` : ''} — by ${r.actor}`.slice(0, 500), ruleIds: [`booking.${r.toStatus}`], link: `/claims/${r.claimId}?tab=hire` });
  }
  for (const a of ctx.repos.listAudit(ctx.db, { entity: 'hire_offers' })) {
    if (!inDay(a.at)) continue;
    const offer = ctx.repos.getHireOffer(ctx.db, a.entityId);
    if (!offer) continue;
    const word = a.action.replace('hire_offer.', '');
    autopilot.push({ at: a.at, claimId: offer.claimId, reference: ref(offer.claimId), agent: 'autopilot', text: `Hire offer of ${offer.terms.registration}: ${word === 'prepare' ? 'prepared' : word === 'accept' ? 'accepted' : word === 'decline' ? 'declined' : word} (${a.userId})`, ruleIds: [`hire_offer.${word}`], link: `/claims/${offer.claimId}?tab=autopilot` });
  }
  for (const a of ctx.repos.listAudit(ctx.db, { action: 'claim.status' })) {
    if (!inDay(a.at) || !a.userId.startsWith('agent:autopilot')) continue;
    autopilot.push({ at: a.at, claimId: a.entityId, reference: ref(a.entityId), agent: 'autopilot', text: `Status set to ${String((a.after as { status?: string } | undefined)?.status ?? '?')}`, ruleIds: ['status.sync'], link: `/claims/${a.entityId}` });
  }
  autopilot.sort((x, y) => x.at.localeCompare(y.at));

  // --- fleet -----------------------------------------------------------------------
  const fleet: LogLine[] = [];
  const horizon = new Date(Date.parse(bounds.end) + DAY).toISOString();
  for (const m of ctx.repos.listMovements(ctx.db, { from: bounds.start, to: horizon })) {
    if (m.status === 'cancelled') continue;
    const when = Date.parse(m.windowStart) < Date.parse(bounds.end) ? 'Today' : 'Tomorrow';
    fleet.push({ at: m.windowStart, claimId: m.claimId, reference: ref(m.claimId), agent: 'autopilot', text: `${when}: ${m.kind} of ${regOf(m.fleetUnitId)} (${m.status})`, ruleIds: [`movement.${m.kind}`], link: '/fleet/movements' });
  }
  for (const t of ctx.repos.listReadinessTasks(ctx.db, { status: 'open' })) {
    if (!t.dueAt || Date.parse(t.dueAt) >= Date.parse(horizon)) continue;
    fleet.push({ at: t.dueAt, agent: 'autopilot', text: `${regOf(t.fleetUnitId)}: ${t.kind.replace(/_/g, ' ')} due${t.blocksHire ? ' (blocks hire)' : ''}${t.note ? ` — ${t.note}` : ''}`.slice(0, 500), ruleIds: [`readiness.${t.kind}`], link: `/fleet/${t.fleetUnitId}` });
  }
  fleet.sort((x, y) => x.at.localeCompare(y.at));

  const clashes: LogLine[] = clashDailyLogLines(ctx, bounds);
  return {
    ...(autopilot.length ? { autopilot } : {}),
    ...(fleet.length ? { fleet } : {}),
    ...(clashes.length ? { clashes } : {}),
  };
}
