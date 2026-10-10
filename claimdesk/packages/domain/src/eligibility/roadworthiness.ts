// owned by ap-clash
/**
 * Roadworthiness and the hire start (docs/SUPREME-AUTOPILOT.md §F.5) — pure.
 *
 * Not driveable → hire from now; driveable → hire from the repair start (mitigation), unless the owner confirms
 * otherwise. The client's car MOT/tax on the accident date comes from the recorded vehicle data (DVLA/DVSA lookup);
 * insurance on the day is not verifiable by ClaimDesk and is never flagged.
 */
import type { ClaimBundle, Vehicle } from '../types.js';
import type { HireNeeds } from '../booking/types.js';
import type { RoadworthinessAssessment } from './types.js';

const day = (iso: string | undefined): string | undefined => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined);

/** MOT and tax of the client's car on the accident date, from the recorded lookups. */
export function clientCarOnDate(vehicle: Pick<Vehicle, 'motExpiryDate' | 'motHistory' | 'taxDueDate' | 'taxStatus'> | undefined, accidentAt: string): RoadworthinessAssessment['clientCarOnAccidentDate'] {
  const at = day(accidentAt);
  if (!vehicle || !at) return { mot: 'unknown', tax: 'unknown' };
  let mot: 'valid' | 'expired' | 'unknown' = 'unknown';
  const tests = (vehicle.motHistory ?? []).filter((t) => (t.result === 'PASSED' || t.result === 'PRS') && day(t.completedDate) && day(t.expiryDate));
  const expiry = day(vehicle.motExpiryDate);
  if (tests.some((t) => day(t.completedDate)! <= at && day(t.expiryDate)! >= at)) mot = 'valid';
  else if (tests.length) {
    // A test history that does not cover the date: expired when an earlier certificate had run out by then.
    if (tests.some((t) => day(t.expiryDate)! < at)) mot = 'expired';
  } else if (expiry) mot = expiry >= at ? 'valid' : 'expired';
  let tax: 'valid' | 'untaxed' | 'unknown' = 'unknown';
  const due = day(vehicle.taxDueDate);
  if (due) tax = due >= at ? 'valid' : 'untaxed';
  return { mot, tax };
}

export function assessRoadworthiness(bundle: ClaimBundle, needs: HireNeeds | null): RoadworthinessAssessment {
  const warnings: string[] = [];
  const a = bundle.claim.accident;
  let driveable: boolean | null = null;
  if (bundle.report && typeof bundle.report.roadworthy === 'boolean') driveable = bundle.report.roadworthy;
  else if (typeof a.driveable === 'boolean') driveable = a.driveable;
  else if (typeof a.roadworthyAfter === 'boolean') driveable = a.roadworthyAfter;

  const repairStart = bundle.events.filter((e) => e.type === 'repair_started').sort((x, y) => x.at.localeCompare(y.at))[0]?.at ?? null;
  let hireFrom: RoadworthinessAssessment['hireFrom'] = 'unknown';
  if (driveable === false) hireFrom = 'now';
  else if (driveable === true) {
    hireFrom = 'repair_start';
    warnings.push('The client’s car is driveable: hire should start when the repair starts (mitigation), unless you decide otherwise.');
  } else warnings.push('Not yet known whether the client’s car is driveable.');
  if (needs?.neededFrom && driveable === true && repairStart && needs.neededFrom < repairStart) warnings.push('The client asked for a car before the repair starts.');

  const clientCarOnAccidentDate = clientCarOnDate(bundle.vehicle, a.occurredAt);
  if (clientCarOnAccidentDate.mot === 'expired') warnings.push('The client’s car had no valid MOT on the accident date.');
  if (clientCarOnAccidentDate.tax === 'untaxed') warnings.push('The client’s car was not taxed on the accident date.');
  return { driveable, hireFrom, repairStartAt: repairStart, clientCarOnAccidentDate, warnings };
}
