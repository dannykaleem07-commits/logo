// pav module — the auditable pre-accident value engine (BLUEPRINT §4.3–4.4): comparable filter with
// radius widening, per-mile factor from the comparables' own regression (fallback band flagged as an
// assumption), normalisation, hard exclusions and 1.5×IQR outliers, median + IQR band, reasoning
// paragraph and a full audit trail. Pure; no clock. Keep exports named; no default exports.
// Generic helpers are re-exported under pav-prefixed names so the domain barrel (`export *`) cannot
// collide with a sibling module's `median` or `quartiles`.
export { median as pavMedian, quartiles as pavQuartiles } from './stats.js';
export type { QuartileStats } from './stats.js';

export {
  DEFAULT_FILTER_OPTIONS,
  resolveFilterOptions,
  filterComparables,
  specificationMismatches,
  mileageWindow as comparableMileageWindow,
  describeRadius,
  describeComparable,
} from './filter.js';
export type { FilterOptions, ResolvedFilterOptions, FilterResult } from './filter.js';

export { FALLBACK_PER_MILE_BANDS, FALLBACK_BAND_NOTE, fallbackPerMile, usableForRegression, ols as olsFit, regressPerMile } from './regression.js';
export type { PerMileResult, RegressionOptions, FallbackBand, OlsFit } from './regression.js';

export {
  CONDITION_ADJUSTMENT_LIMIT_PCT,
  clampConditionPct,
  normalisationBreakdown,
  describeBreakdown,
  normaliseComparables,
  hardExclusionReason,
  excludeOutliers,
} from './normalise.js';
export type { NormalisationBreakdown, HardExclusionSubject, OutlierOptions, OutlierResult } from './normalise.js';

export { PAV_MEASURE_BASIS, vatNoteFor, assessPav, pavReasoning } from './assess.js';
export type { AssessPavOptions, PavAssessmentResult } from './assess.js';
