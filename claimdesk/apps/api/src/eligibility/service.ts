// owned by ap-clash
/**
 * Eligibility service (docs/SUPREME-AUTOPILOT.md §F.7): loads driver profiles, hire needs and criteria for a claim and
 * runs the pure assessments. Stub created by ap-foundation: everything `unknown` (never green, never books alone).
 */
import type { DriverEligibility, EligibilitySummary } from '@ccguk/domain';
import type { AppContext } from '../context.js';

const unknownDriver = (partyId: string): DriverEligibility => ({
  partyId,
  outcome: 'unknown',
  reasons: [{ code: 'NOT_ASSESSED', outcome: 'unknown', message: 'Driver eligibility is not built yet' }],
  missing: ['driver eligibility assessment'],
  criteriaSource: 'settings_default',
  automaticOnly: false,
});

/** The claim's drivers (main driver first) with their eligibility. */
export function driversFor(ctx: AppContext, claimId: string): DriverEligibility[] {
  const claim = ctx.repos.getClaim(ctx.db, claimId);
  return claim ? [unknownDriver(claim.driverId ?? claim.claimantId)] : [];
}

export function eligibilityFor(ctx: AppContext, claimId: string): EligibilitySummary {
  const [driver = unknownDriver(''), ...additionalDrivers] = driversFor(ctx, claimId);
  return {
    overall: 'unknown',
    driver,
    additionalDrivers,
    need: { level: 'unknown', reasons: [], missing: ['hire needs'], mitigationRisks: [], automaticOnly: false, use: 'credit_hire' },
    means: { basis: 'unknown', readiness: 'none', missing: [], warning: null },
    roadworthiness: { driveable: null, hireFrom: 'unknown', repairStartAt: null, clientCarOnAccidentDate: { mot: 'unknown', tax: 'unknown' }, warnings: [] },
    injury: { referralNeeded: false, referred: false },
    green: false,
    reasons: ['Eligibility is not built yet'],
  };
}
