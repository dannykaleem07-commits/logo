// owned by ap-booking
/**
 * Reservations — the fleet diary (docs/SUPREME-AUTOPILOT.md §B.1, §B.10, §B.11). Pure.
 *
 * Every period is compared as epoch milliseconds, half-open `[start, end)`; an open end is +∞. Touching periods (one
 * ends when the next starts — a vehicle swap) do not overlap, exactly as `hirePeriodsOverlap`.
 */
import type { FleetUnit, Id, ISODateTime } from '../types.js';
import { isoToMs } from '../calendar/index.js';
import { BLOCKING_RESERVATION_STATUSES, RESERVATION_TRANSITIONS, type OccupiedPeriod, type Reservation, type ReservationStatus } from './types.js';

/** The largest integer SQLite and JS agree on — the overlap trigger's stand-in for an open end. */
export const OPEN_END_MS = 9_007_199_254_740_991;

/** Thrown by `assertTransition` (the API maps it to 409 RESERVATION_STATE). */
export class ReservationStateError extends Error {
  readonly code = 'RESERVATION_STATE';
  constructor(
    readonly from: ReservationStatus,
    readonly to: ReservationStatus,
  ) {
    super(`A ${from.replace('_', ' ')} booking cannot become ${to.replace('_', ' ')}`);
    this.name = 'ReservationStateError';
  }
}

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return RESERVATION_TRANSITIONS[from].includes(to);
}

/** Throws ReservationStateError (code RESERVATION_STATE) unless `from → to` is in RESERVATION_TRANSITIONS. */
export function assertTransition(from: ReservationStatus, to: ReservationStatus): void {
  if (!canTransition(from, to)) throw new ReservationStateError(from, to);
}

export function isBlockingStatus(status: ReservationStatus): boolean {
  return BLOCKING_RESERVATION_STATUSES.includes(status);
}

type PeriodFields = Pick<Reservation, 'status' | 'startAt' | 'expectedEndAt' | 'endAt' | 'collectedAt'>;

/**
 * The period a reservation occupies (§B.1):
 *  held/confirmed: [startAt, expectedEndAt)
 *  on_hire:        [startAt, max(expectedEndAt, now)) — an overdue car keeps occupying until it is returned; a legacy
 *                  on-hire row with no expected end is open
 *  returned:       [startAt, max(endAt, collectedAt ?? endAt)) — the collection time counts
 *  cancelled/expired: [startAt, startAt) (occupies nothing)
 */
export function occupiedPeriod(r: PeriodFields, now: ISODateTime): OccupiedPeriod {
  const startMs = isoToMs(r.startAt);
  switch (r.status) {
    case 'held':
    case 'confirmed':
      return { startMs, endMs: r.expectedEndAt ? isoToMs(r.expectedEndAt) : null };
    case 'on_hire': {
      if (!r.expectedEndAt) return { startMs, endMs: null };
      return { startMs, endMs: Math.max(isoToMs(r.expectedEndAt), isoToMs(now)) };
    }
    case 'returned': {
      const end = r.endAt ?? r.expectedEndAt;
      if (!end) return { startMs, endMs: r.collectedAt ? isoToMs(r.collectedAt) : null };
      const endMs = isoToMs(end);
      return { startMs, endMs: r.collectedAt ? Math.max(endMs, isoToMs(r.collectedAt)) : endMs };
    }
    default:
      return { startMs, endMs: startMs };
  }
}

/**
 * The stored block columns (`block_start_ms`, `block_end_ms`) for a row. For on-hire rows the stored end is the
 * expected end (or null): the trigger never refuses an on-hire update, and the overdue extension is computed at read
 * time by `occupiedPeriod` (clash detection reports it).
 */
export function blockColumns(r: PeriodFields): { blockStartMs: number; blockEndMs: number | null } {
  const startMs = isoToMs(r.startAt);
  if (r.status === 'returned') {
    const p = occupiedPeriod(r, r.startAt);
    return { blockStartMs: startMs, blockEndMs: p.endMs };
  }
  if (r.status === 'cancelled' || r.status === 'expired') return { blockStartMs: startMs, blockEndMs: startMs };
  return { blockStartMs: startMs, blockEndMs: r.expectedEndAt ? isoToMs(r.expectedEndAt) : null };
}

/** Half-open overlap of two ms periods (null end = open). Touching periods do not overlap. */
export function periodsOverlapMs(a: OccupiedPeriod, b: OccupiedPeriod): boolean {
  const aEnd = a.endMs ?? OPEN_END_MS;
  const bEnd = b.endMs ?? OPEN_END_MS;
  return a.startMs < bEnd && b.startMs < aEnd;
}

/** The blocking reservations (other than `excludeIds`) whose occupied period overlaps `[startAt, endAt)`. */
export function overlappingReservations<T extends PeriodFields & { id: Id }>(
  period: { startAt: ISODateTime; endAt: ISODateTime | null },
  reservations: readonly T[],
  now: ISODateTime,
  excludeIds: readonly Id[] = [],
): T[] {
  const p: OccupiedPeriod = { startMs: isoToMs(period.startAt), endMs: period.endAt ? isoToMs(period.endAt) : null };
  return reservations.filter((r) => !excludeIds.includes(r.id) && isBlockingStatus(r.status) && periodsOverlapMs(p, occupiedPeriod(r, now)));
}

/**
 * Fleet status derived from the diary (§B.10): `off_road` / `disposed` are manual and kept; otherwise `on_hire` iff
 * an `on_hire` reservation covers `now` (a future confirmed booking no longer flips the car to on hire); else
 * `available`.
 */
export function fleetStatusFromReservations(unit: Pick<FleetUnit, 'status'>, reservations: readonly PeriodFields[], now: ISODateTime): FleetUnit['status'] {
  if (unit.status === 'off_road' || unit.status === 'disposed') return unit.status;
  const nowMs = isoToMs(now);
  const onHire = reservations.some((r) => {
    if (r.status !== 'on_hire') return false;
    const p = occupiedPeriod(r, now);
    return p.startMs <= nowMs && (p.endMs === null || p.endMs > nowMs);
  });
  return onHire ? 'on_hire' : 'available';
}

/** A held reservation whose hold has run out at `now`. */
export function holdExpired(r: Pick<Reservation, 'status' | 'holdExpiresAt'>, now: ISODateTime): boolean {
  return r.status === 'held' && !!r.holdExpiresAt && isoToMs(r.holdExpiresAt) <= isoToMs(now);
}

/** "held" → "Held", "on_hire" → "On hire" (owner wording, never the stored code). */
export const RESERVATION_STATUS_TEXT: Readonly<Record<ReservationStatus, string>> = {
  held: 'Held',
  confirmed: 'Confirmed',
  on_hire: 'On hire',
  returned: 'Returned',
  cancelled: 'Cancelled',
  expired: 'Hold expired',
};
