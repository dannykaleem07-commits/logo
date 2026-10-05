/**
 * Hire period overlap and derived fleet status (docs/V03-MANAGER-MODE-HIRE-PRICING.md §C.2). "Unit already on hire"
 * used to look at today only; a backdated, finished hire on a car that is out today is legitimate, so the check is a
 * period overlap instead, and a unit's on-hire status is derived from its hires rather than written blindly. Pure.
 */
import type { FleetUnit, Id, ISODateTime } from '../types.js';
import { isoToMs } from '../calendar/index.js';

export interface HirePeriod {
  startAt: ISODateTime;
  endAt?: ISODateTime | null;
}

const endMs = (p: HirePeriod): number => (p.endAt ? isoToMs(p.endAt) : Number.POSITIVE_INFINITY);

/** Half-open [start, end); an open end is +∞. Touching periods (one ends when the next starts) do not overlap. */
export function hirePeriodsOverlap(a: HirePeriod, b: HirePeriod): boolean {
  const aStart = isoToMs(a.startAt);
  const bStart = isoToMs(b.startAt);
  return aStart < endMs(b) && bStart < endMs(a);
}

/** The hires (other than `excludeId`) whose period overlaps the candidate's. */
export function overlappingHires<T extends HirePeriod & { id: Id }>(candidate: HirePeriod, hires: readonly T[], excludeId?: Id): T[] {
  return hires.filter((h) => h.id !== excludeId && hirePeriodsOverlap(candidate, h));
}

/** off_road / disposed are kept; otherwise 'on_hire' iff some hire is not over at `now` (no end, or end > now) —
 *  a hire booked to start later also counts (today's behaviour: creating a hire puts the car on hire); else 'available'. */
export function fleetStatusFromHires(unit: Pick<FleetUnit, 'status'>, hires: readonly HirePeriod[], now: ISODateTime): FleetUnit['status'] {
  if (unit.status === 'off_road' || unit.status === 'disposed') return unit.status;
  const nowMs = isoToMs(now);
  return hires.some((h) => endMs(h) > nowMs) ? 'on_hire' : 'available';
}
