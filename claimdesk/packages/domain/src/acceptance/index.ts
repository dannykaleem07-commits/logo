// acceptance module — BLUEPRINT §2 finding 4, §3.1, money.md §1. Named exports only; pure.
export {
  scoreLiability,
  liabilityBand,
  detectRearEndOrClearBreach,
  detectDisputeScenario,
  detectContradiction,
  detectAdmission,
  LIABILITY_BASELINE,
  LIABILITY_WEAK_THRESHOLD,
  LIABILITY_DECLINE_THRESHOLD,
} from './liability.js';
export type { LiabilityExtras, LiabilityFactor, LiabilityScore } from './liability.js';

export {
  assessAcceptance,
  hireFigure,
  otherHeadsFigure,
  acceptanceHireProjection,
  acceptanceHireDays,
  impecuniosityReadiness,
  enforceabilityReadiness,
  TESCHER_RATIO,
  ACCEPTANCE_DEFAULT_HIRE_DAYS,
  CITATIONS as ACCEPTANCE_CITATIONS,
  CONDITIONS as ACCEPTANCE_CONDITIONS,
  PERIMETER_FLAG_INJURY,
  PERIMETER_FLAG_LSA,
} from './assess.js';
export type { AcceptanceOptions, AcceptanceAssessment } from './assess.js';
