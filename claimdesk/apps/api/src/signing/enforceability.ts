// owned by ap-paperwork
/**
 * Signed paperwork → hire enforceability (docs/SUPREME-AUTOPILOT.md §E.5): returns the HireAgreement fields the signed
 * or sent pack proves (signedAt, documentId, enforceability.*). Stub created by ap-foundation: proves nothing.
 */
import type { HireAgreement, Id } from '@ccguk/domain';
import type { Db } from '@ccguk/db';
import type { AppContext } from '../context.js';

export function syncEnforceabilityFromPack(_ctx: AppContext, _tx: Db, _ref: { reservationId?: Id; hireId?: Id }): Partial<HireAgreement> {
  return {};
}
