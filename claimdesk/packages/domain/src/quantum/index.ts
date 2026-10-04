// quantum module — BLUEPRINT §5.2, money.md §3–§4. Named exports only; pure (no I/O, `now` is a parameter).
export { scheduleOfLoss, scheduleLineFor, liveLedgerEntries, SCHEDULE_HEAD_ORDER, scheduleHeadLabels, SCHEDULE_NON_LOSS_HEADS } from './schedule.js';
export type { ScheduleLine, ScheduleTotals, ScheduleOfLoss, ScheduleOptions } from './schedule.js';

export { interest, interestCitations, DEFAULT_COURT_RATE_PCT, ICOBS_UPLIFT_PCT, LPCDIA_UPLIFT_PCT } from './interest.js';
export type { InterestBasis, InterestOptions, InterestResult } from './interest.js';

export { courtFee, defaultCourtFees, EX50_SOURCE_NOTE } from './fees.js';
export type { FeeBand, FeeKind, CourtFeeResult, CourtFeeOptions } from './fees.js';

export { allocateTrack, trackAllocation, TRACK_LIMITS_PENCE, TRACK_BASIS } from './track.js';
export type { TrackOptions, TrackAllocation } from './track.js';

export { settlementArithmetic, expectedValue, settlementDelayDiscount } from './settlement.js';
export type { SettlementInput, SettlementResult, ExpectedValueInput, ExpectedValueResult } from './settlement.js';

export { part36, PART36_MINIMUM_RELEVANT_PERIOD_DAYS } from './part36.js';
export type { Part36Options, Part36Result } from './part36.js';
