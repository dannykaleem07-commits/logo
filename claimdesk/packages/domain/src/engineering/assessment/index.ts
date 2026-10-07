/**
 * AI visual damage assessment — knowledge-driven pure logic (no model calls).
 * Barrel for the integrator; the package index does not export it yet.
 */
export * from './types.js';
export * from './regions.js';
export * from './labour.js';
export * from './schema.js';
export * from './knockOn.js';
export * from './checks.js';
export * from './consistency.js';
export * from './schedule.js';
export * from './prompt.js';
export { buildContext, featureFitment, fillTokens, whenHolds, RULE_TOKENS, type RuleContext } from './conditions.js';
