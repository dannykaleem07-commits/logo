// owned by ap-clash
/**
 * Means (docs/SUPREME-AUTOPILOT.md §F.4) — pure. Reuses `impecuniosityReadiness`. It does not stop the offer by
 * default (`settings.eligibility.requireMeansBeforeOffer = false`); when the basis is not established the offer card and
 * the billing step carry the basic-hire-rate warning (Dimond v Lovell; Lagden v O'Connor).
 */
import type { ClaimBundle, GateResult } from '../types.js';
import { impecuniosityReadiness } from '../acceptance/assess.js';
import type { MeansAssessment } from './types.js';

export const MEANS_WARNING =
  "Impecuniosity is not evidenced yet: recovery of the credit hire rate may be limited to a basic hire rate (Dimond v Lovell [2002] 1 AC 384; Lagden v O'Connor [2003] UKHL 64). Collect the statement of means and 3 months' bank statements.";

export function assessMeans(bundle: ClaimBundle, gates: GateResult[]): MeansAssessment {
  const r = impecuniosityReadiness(bundle, gates.length ? gates : undefined);
  const notImpecunious = (bundle.flags ?? bundle.claim.flags ?? []).some((f) => f.code === 'NOT_IMPECUNIOUS' && !f.clearedAt);
  const basis: MeansAssessment['basis'] = notImpecunious ? 'not_impecunious' : r.readiness === 'ready' ? 'impecunious' : 'unknown';
  return {
    basis,
    readiness: r.readiness,
    missing: r.missing,
    warning: basis === 'impecunious' ? null : MEANS_WARNING,
  };
}
