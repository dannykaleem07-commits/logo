// owned by ap-booking
// booking module — reservations, availability, readiness, movements (docs/SUPREME-AUTOPILOT.md §B). Pure.
export * from './types.js';
export {
  OPEN_END_MS,
  ReservationStateError,
  canTransition,
  assertTransition,
  isBlockingStatus,
  occupiedPeriod,
  blockColumns,
  periodsOverlapMs,
  overlappingReservations,
  fleetStatusFromReservations,
  holdExpired,
  RESERVATION_STATUS_TEXT,
} from './reservation.js';
export { defaultBlocksHire, damageBlocksHire, unitReadiness, readyByTime, returnReadinessTasks, READINESS_KIND_TEXT } from './readiness.js';
export type { ReturnTaskPlan } from './readiness.js';
export { canAllocateForPeriod, policyChain, coveredUntil, lastDayOfPeriod } from './periodCompliance.js';
export type { ComplianceFinding, PeriodAllocationDetail } from './periodCompliance.js';
export { likeForLike, bodyFamily, fuelFamily } from './likeForLike.js';
export type { BodyFamily, FuelFamily } from './likeForLike.js';
export { searchAvailability, normaliseWeights, unitLabel, postcodeParts } from './availability.js';
export type { AvailabilityEnv } from './availability.js';
export { candidateGreen, greenTest, GREEN_BLOCKING_WARN_CODES, DEFAULT_MIN_LIKE_FOR_LIKE } from './green.js';
export type { GreenInput, GreenResult } from './green.js';
export { projectHirePeriod } from './projection.js';
export type { ProjectedPeriod, ProjectionBasis, ProjectionBundle } from './projection.js';
export { proposeSlots, DEFAULT_BUSINESS_HOURS, isBusinessDay, isoWeekday, windowInBusinessHours, movementsInWindow, slotLabel } from './delivery.js';
export type { ProposeSlotsInput } from './delivery.js';
export { blankHireNeeds, withHireNeedsDefaults } from './needs.js';
