// estimate module — engineer's estimate arithmetic (BLUEPRINT §4.5): totals by head with the
// paint/materials method stated, pre-existing damage separated and never claimed, reconciliation
// against an imported total, a tolerant text-line parser for imported Audatex/bodyshop estimates,
// the in-house labour-time library (medians of CCGUK's own approved estimates) and a report summary.
// Keep exports named; no default exports.
export { lineAmount as estimateLineAmount, computeTotals, computeTotalsDetailed, reconcile } from './totals.js';
export type { EstimateInput, EstimateBasis, LineAmount, TotalsDetail, ReconcileBasis, ReconcileResult } from './totals.js';

export { canonicalOperation, tokeniseLine, parseEstimateLine, parseEstimateText } from './parser.js';
export type { ParseOptions, CanonicalOperation, ParsedTokens } from './parser.js';

export { LabourLibrary, LIBRARY_MIN_OBSERVATIONS } from './library.js';
export type { LabourLibraryEntry, LabourLibraryJson, LabourMedian, LabourSuggestion, AddResult } from './library.js';

export { summariseLines, paintMaterialsBasis } from './summarise.js';
export type { EstimateLineSummary, EstimateSummary } from './summarise.js';
