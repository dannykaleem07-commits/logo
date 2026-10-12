// intake module — BLUEPRINT §3.1 FNOL validation, script guard, injury routing. Named exports only; pure.
export { validateFnol, routeInjury, isValidRegistrationLocal, normaliseRegistrationLocal, MIN_CIRCUMSTANCES_CHARS, INJURY_REFERRAL_TITLE } from './fnol.js';
export type { FnolInput, FnolWitness, FnolOfferDetails, FnolIssue, FnolValidation, InjuryRouting } from './fnol.js';

export { intakeScript, assertScriptGuard, scriptText, recordingDisclosureText, GUARD_QUESTION, BANNED_SCRIPT_PATTERNS } from './script.js';
export type { ScriptStep, ScriptGuardViolation, ScriptGuardResult } from './script.js';

// Smart intake — case bundles (docs/SMART-INTAKE.md §4): pure modules for the bundle engine.
export * from './smart/index.js';
