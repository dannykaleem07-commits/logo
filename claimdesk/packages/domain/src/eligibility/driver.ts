// owned by ap-clash
/**
 * Driver eligibility (docs/SUPREME-AUTOPILOT.md §F.1) — pure. Stub created by ap-foundation: until ap-clash fills it,
 * every driver is `unknown` (which never makes a step green and never lets an agent book alone).
 */
import type { Party, ISODate } from '../types.js';
import type { DriverCriteria, DriverEligibility, DriverProfile } from './types.js';

export function assessDriver(
  profile: DriverProfile | undefined,
  _party: Pick<Party, 'dateOfBirth' | 'drivingLicenceNumber' | 'name'>,
  _criteria: DriverCriteria,
  _at: ISODate,
): DriverEligibility {
  return {
    partyId: profile?.partyId ?? '',
    outcome: 'unknown',
    reasons: [{ code: 'NOT_ASSESSED', outcome: 'unknown', message: 'Driver eligibility is not built yet' }],
    missing: ['driver eligibility assessment'],
    criteriaSource: 'settings_default',
    automaticOnly: false,
  };
}
