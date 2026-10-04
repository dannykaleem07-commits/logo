// totalloss module — total-loss economics (BLUEPRINT §4.7–4.8): repair + projected hire + storage vs
// PAV − salvage with a plain-English explanation of both routes, the rules-first logistic predictor
// (calibrated:false until ≥100 outcomes), ABI salvage categories (28 May 2025 Code) with EV notes,
// and the engineer's report checklist (§4.6, CPR 35 / PD 35 and PD 27A fee cap when for court).
// Keep exports named; no default exports.
export {
  DEFAULT_DAYS_TO_TL_PAYMENT,
  DEFAULT_HANDOVER_DAYS,
  DEFAULT_BORDERLINE_PCT,
  WORKING_TO_CALENDAR_FACTOR,
  workingDaysToCalendarDays,
  projectedHireDays,
  assessTotalLoss,
} from './assess.js';
export type { TotalLossInput, TotalLossAssessmentResult } from './assess.js';

export { TL_PREDICTOR_WEIGHTS, TL_PREDICTOR_BANDS, TL_PREDICTOR_MIN_OUTCOMES, TL_PREDICTOR_CALIBRATION_NOTE, sigmoid as tlSigmoid, predictTotalLoss } from './predict.js';
export type { TotalLossPredictionResult } from './predict.js';

export {
  SALVAGE_CODE_TITLE,
  SALVAGE_CODE_DATE,
  SALVAGE_CODE_VERIFICATION,
  SALVAGE_CODE_PRINCIPLES,
  SALVAGE_CATEGORY_ORDER,
  salvageCategories,
  describeSalvageCategory,
  salvageCategoryAffectsPav,
} from './salvage.js';
export type { SalvageCategoryInfo } from './salvage.js';

export { SMALL_CLAIMS_EXPERT_FEE_CAP_PENCE, CPR35_VERIFICATION, PD27A_FEE_CAP_VERIFICATION, engineerReportChecklist } from './checklist.js';
export type { CourtDeclarations, ChecklistOptions, ChecklistResult } from './checklist.js';
