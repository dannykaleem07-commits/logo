// fleet module — BLUEPRINT §3.12 compliance, class-of-use guard, PCN/NIP workflow, owner-liability transfer, s.172. Named exports only; pure.
export { complianceAlerts, phvEligibility, TFL_ZEC_RULE, DEFAULT_WARN_DAYS } from './compliance.js';
export type { FleetUnitRecord, ComplianceOptions, PhvEligibility } from './compliance.js';

export { canAllocate, COLLINGWOOD_NOTE } from './allocate.js';
export type { AllocationCheck } from './allocate.js';

export { penaltyTransition, allowedPenaltyActions, PENALTY_BASIS } from './penalty.js';
export type { PenaltyStage, PenaltyAction, PenaltyTransitionContext, PenaltyTransitionResult } from './penalty.js';

export {
  liabilityTransferParticulars,
  s172ResponseData,
  hireCovers,
  formatAddress,
  formatLondonDateTime,
  OWNER_LIABILITY_BASIS,
  S172_BASIS,
  S172_DILIGENCE_CHECKLIST,
  NEVER_NOMINATE,
  HIRE_FIRM_NAME,
  HIRE_FIRM_COMPANY_NUMBER,
} from './transfer.js';
export type { TransferParticulars, LiabilityTransfer, S172PersonData, S172ResponseData, S172Options } from './transfer.js';

export { hirePeriodsOverlap, overlappingHires, fleetStatusFromHires } from './hireOverlap.js';
export type { HirePeriod } from './hireOverlap.js';
