// owned by ap-clash
/**
 * detectClashes (docs/SUPREME-AUTOPILOT.md §C.1) — pure. Stub created by ap-foundation: returns no findings until
 * ap-clash fills it with the §C.2 catalogue.
 */
import type { ISODateTime } from '../types.js';
import type { AutopilotSettings } from '../autopilot/settings.js';
import type { ClashFinding, ClashSubject, ClashWorld } from './types.js';

export function detectClashes(_subject: ClashSubject, _world: ClashWorld, _opts: { now: ISODateTime; settings: AutopilotSettings }): ClashFinding[] {
  return [];
}
