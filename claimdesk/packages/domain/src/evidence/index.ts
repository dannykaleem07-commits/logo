// evidence module — BLUEPRINT §3.8, §6. Named exports only. ClaimBundle itself lives in ../types.ts.
export { sha256Hex } from './hash.js';
export { evaluateGates, evaluateGate, EVIDENCE_GATES } from './gates.js';
export { guidedShotList, type GuidedShotInstruction, type GuidedShotListOptions } from './shots.js';
