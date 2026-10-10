/**
 * @ccguk/domain — pure, side-effect-free business logic for ClaimDesk.
 * No I/O, no database, no network. Everything here is unit-tested.
 */
export * from './types.js';
export * from './money.js';
export * from './calendar/index.js';
export * from './clocks/index.js';
export * from './gta/index.js';
export * from './consistency/index.js';
export * from './vehicle/index.js';
export * from './linkage/index.js';
export * from './evidence/index.js';
export * from './esign/index.js';
export * from './pav/index.js';
export * from './estimate/index.js';
export * from './totalloss/index.js';
export * from './quantum/index.js';
export * from './acceptance/index.js';
export * from './playbook/index.js';
export * from './intake/index.js';
export * from './fleet/index.js';
export * from './templateIds.js';
export * from './events/index.js';
export * from './override/index.js';
export * from './agents/index.js';
export * from './autonomy/index.js';
// ClaimDesk Supreme Autopilot (docs/SUPREME-AUTOPILOT.md): contracts by ap-foundation, behaviour by the owning slices.
export * from './autopilot/index.js';
export * from './booking/index.js';
export * from './clash/index.js';
export * from './eligibility/index.js';
export * from './signing/index.js';
// Knowledge Builder (docs/SUPREME-KNOWLEDGE-BUILDER.md): contracts by knowledge-core, behaviour by the owning slices.
export * from './knowledge/index.js';
