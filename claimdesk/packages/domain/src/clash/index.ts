// owned by ap-clash
// clash module — the fleet / claim clash catalogue and detector (docs/SUPREME-AUTOPILOT.md §C). Pure.
export * from './types.js';
export { detectClashes, reservationOccupied, hireOccupied } from './detect.js';
export { CLASH_CATALOGUE, CLASH_DEFS, GREEN_BLOCKING_CLASH_CODES, clashDef } from './catalogue.js';
export { personMatch, samePerson, vehicleMatch, normaliseLicence, normalisePersonName, normaliseVin, clashDedupeKey } from './identity.js';
export type { PersonLike, PersonMatch } from './identity.js';
