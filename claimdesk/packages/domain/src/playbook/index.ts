// playbook module — BLUEPRINT §7 get-paid-faster engine. Named exports only; pure. Clocks and gates are inputs.
export { nextActions, sortActions, priorityFor, hireAtRisk, outstandingBalance, ASSUMED_BASE_RATE_PCT, CCTV_LOCATION_PATTERN, PRIORITY_RANK } from './engine.js';
export type { PlaybookContext } from './engine.js';

export { defaultPlaybookRules, playbookRuleCodes, findRule, GTA_BENCHMARK } from './rules.js';
export type { PlaybookRule } from './rules.js';
