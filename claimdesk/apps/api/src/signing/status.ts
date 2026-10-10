// owned by ap-paperwork
/**
 * Signed-pack status for a reservation (docs/SUPREME-AUTOPILOT.md §B.9, §C.2 SIGNATURES_MISSING): is the hire-start pack
 * signed / provided, and what is missing. Stub created by ap-foundation: never signed.
 */
import type { AppContext } from '../context.js';

export function signedPackStatus(_ctx: AppContext, _reservationId: string): { signed: boolean; missing: string[] } {
  return { signed: false, missing: ['paperwork not built'] };
}
