// owned by ap-clash
/**
 * Client need (docs/SUPREME-AUTOPILOT.md §F.3) — pure.
 *
 * strong   = no other vehicle and the car is used for work / caring / school / medical journeys (or PHV work);
 * moderate = regular journeys and no other vehicle;
 * weak     = another household vehicle is available, or the own insurer's courtesy car was offered/accepted;
 * none     = the client says no car is needed;
 * unknown  = the need answers are missing (→ ask the client).
 * Weak need is not a refusal: it makes the offer step `confirm` and warns that hire may be challenged (NEED_WEAK).
 */
import type { ClaimBundle } from '../types.js';
import type { HireNeeds } from '../booking/types.js';
import type { DriverEligibility, NeedAssessment } from './types.js';

const ESSENTIAL = /\b(work|job|shift|commut|employ|business|deliver|taxi|uber|courier|driver|care|caring|carer|school|nursery|hospital|medical|doctor|gp|dialysis|clinic|disab|mobility|elderly|relative)/i;

export type NeedLevel = NeedAssessment['level'];

/** The need level and its reasons from the stored needs alone (used by the clash detector for NEED_WEAK). */
export function needLevel(needs: HireNeeds | null | undefined): { level: NeedLevel; reasons: string[]; missing: string[]; mitigationRisks: string[] } {
  const reasons: string[] = [];
  const missing: string[] = [];
  const mitigationRisks: string[] = [];
  if (!needs) return { level: 'unknown', reasons: ['No hire needs recorded yet.'], missing: ['hire needs (occupation, journeys, other vehicles)'], mitigationRisks };
  if (needs.clientWantsHire === false) return { level: 'none', reasons: ['The client says no car is needed.'], missing, mitigationRisks };

  if (needs.ownInsurerCourtesyCar === 'accepted') mitigationRisks.push("The client accepted their own insurer's courtesy car.");
  else if (needs.ownInsurerCourtesyCar === 'offered') mitigationRisks.push("The client's own insurer offered a courtesy car.");
  if (needs.otherVehicles === 'available') mitigationRisks.push('Another vehicle in the household is available.');
  if (needs.clientCoverType === 'comprehensive' && needs.ownInsurerCourtesyCar === 'unknown')
    mitigationRisks.push("Comprehensive cover: ask whether the client's own insurer provides a courtesy car.");

  if (needs.otherVehicles === 'available' || needs.ownInsurerCourtesyCar === 'offered' || needs.ownInsurerCourtesyCar === 'accepted') {
    reasons.push('Hire may be challenged: the client has another car available to them.');
    return { level: 'weak', reasons, missing, mitigationRisks };
  }

  const text = [needs.occupation, needs.journeys, needs.dependants].filter((x): x is string => !!x && x.trim().length > 0).join(' ');
  const essential = needs.phvWork || ESSENTIAL.test(text) || !!(needs.dependants && needs.dependants.trim());
  if (needs.otherVehicles === 'unknown') missing.push('whether another vehicle is available');
  if (!text && !needs.phvWork) missing.push('what the car is used for (occupation, journeys, dependants)');
  if (needs.otherVehicles === 'unknown') return { level: 'unknown', reasons: ['Not yet known whether another vehicle is available.'], missing, mitigationRisks };

  if (essential) {
    reasons.push(needs.phvWork ? 'No other vehicle; the client drives for a living (PHV).' : 'No other vehicle; the car is needed for work, caring, school or medical journeys.');
    return { level: 'strong', reasons, missing: [], mitigationRisks };
  }
  if (needs.journeys && needs.journeys.trim()) {
    reasons.push('No other vehicle; regular journeys.');
    return { level: 'moderate', reasons, missing: [], mitigationRisks };
  }
  return { level: 'unknown', reasons: ['No other vehicle, but what the car is used for is not recorded.'], missing, mitigationRisks };
}

export function assessNeed(needs: HireNeeds | null, bundle: ClaimBundle, driver: DriverEligibility | null): NeedAssessment {
  const base = needLevel(needs);
  const reasons = [...base.reasons];
  if (bundle.claim.accident.driveable === true && base.level !== 'none') reasons.push('The client’s car is driveable: hire should start when the repair starts.');
  const automaticOnly = !!needs?.automaticOnly || !!driver?.automaticOnly;
  if (driver?.automaticOnly && !needs?.automaticOnly) reasons.push('Licence restriction 78: automatic cars only.');
  return { level: base.level, reasons, missing: base.missing, mitigationRisks: base.mitigationRisks, automaticOnly, use: needs?.phvWork ? 'pco' : 'credit_hire' };
}
