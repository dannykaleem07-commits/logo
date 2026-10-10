// owned by ap-clash
// eligibility module — driver, need, means and roadworthiness assessments (docs/SUPREME-AUTOPILOT.md §F). Pure.
export * from './types.js';
export { assessDriver, worstOutcome, licenceNumberMismatches, licenceSurnameCode, wholeYearsBetween, fractionalYearsBetween } from './driver.js';
export { assessNeed, needLevel } from './need.js';
export type { NeedLevel } from './need.js';
export { assessMeans, MEANS_WARNING } from './means.js';
export { assessRoadworthiness, clientCarOnDate } from './roadworthiness.js';
export { summariseEligibility } from './summary.js';
export type { SummariseInput } from './summary.js';
