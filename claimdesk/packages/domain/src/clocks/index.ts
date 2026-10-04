// clocks module — derive every Clock from a claim's chronology (BLUEPRINT §3.3, §3.4, §3.6, §7)
// and the fleet penalty clocks (§3.12). Keep exports named; no default exports.
export { clockDefinitions, clockKinds, GTA_BENCHMARK_SUFFIX } from './definitions.js';
export type { ClockDefinition } from './definitions.js';

export { deriveClocks, clockStatus, dueClocks, GTA_6_8_HIRES_FROM, FOS_NOT_OPEN_REASON } from './derive.js';

export { derivePenaltyClocks } from './penalty.js';
export type { PenaltyClockFacts } from './penalty.js';
