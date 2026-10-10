// owned by ap-autopilot (integration hook, docs/SUPREME-AUTOPILOT.md §C.3)
/**
 * A claim fact the clash checks and the plan depend on changed (claim created or edited, status changed, a vehicle's
 * VIN/details, a party's date of birth / licence, an off-hire trigger event): queue a `clash.check` for every claim
 * concerned (idempotent per minute) and nudge its Autopilot. Best effort — never fails the caller's request.
 */
import { OFF_HIRE_EVENTS, type EventType } from '@ccguk/domain';
import type { AppContext } from '../context.js';
import { queueClashCheck } from '../clash/service.js';
import { nudgeAutopilot } from './nudge.js';

const OFF_HIRE_TYPES = new Set<string>(OFF_HIRE_EVENTS.map(([type]) => type));

/** Event types that change what the clash checks see (the off-hire triggers). */
export function isClashRelevantEvent(type: EventType | string): boolean {
  return OFF_HIRE_TYPES.has(type);
}

export function claimChanged(ctx: AppContext, claimIds: Iterable<string>, actor: string, reason: string): void {
  for (const claimId of new Set(claimIds)) {
    if (!claimId) continue;
    try {
      queueClashCheck(ctx, { kind: 'claim', claimId }, actor);
      nudgeAutopilot(ctx, claimId, reason.slice(0, 200));
    } catch (err) {
      ctx.logger.warn('claim change hook failed', { claimId, reason, error: String(err) });
    }
  }
}

/** Open claims on which the party is the claimant, the driver or a third party. */
export function claimsForParty(ctx: AppContext, partyId: string): string[] {
  const rows = ctx.handle.sqlite
    .prepare(`SELECT id FROM claims WHERE status NOT IN ('closed','settled','declined') AND (claimant_id = ? OR driver_id = ? OR EXISTS (SELECT 1 FROM json_each(claims.third_party_ids) j WHERE j.value = ?))`)
    .all(partyId, partyId, partyId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Open claims on which the vehicle is the client's or the third party's vehicle. */
export function claimsForVehicle(ctx: AppContext, vehicleId: string): string[] {
  const rows = ctx.handle.sqlite
    .prepare(`SELECT id FROM claims WHERE status NOT IN ('closed','settled','declined') AND (client_vehicle_id = ? OR third_party_vehicle_id = ?)`)
    .all(vehicleId, vehicleId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
