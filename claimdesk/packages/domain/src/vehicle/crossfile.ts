/**
 * Cross-file registration check (live-file lessons f and h, BLUEPRINT §3.2).
 * A second claim on the same registration is a linked-but-separate file (banner on both).
 * A fleet-unit registration appearing as a client vehicle is a hard stop.
 */
import type { Claim, FleetUnit, Id, Vehicle } from '../types.js';
import { formatRegistration, normaliseRegistration } from './registration.js';

export interface CrossFileRegistrationResult {
  registration: string; // normalised
  matchedVehicleIds: Id[];
  duplicateClaimIds: Id[];
  isFleetUnit: boolean;
  hardStop: boolean;
  severity: 'none' | 'warn' | 'block';
  message: string;
}

export interface CrossFileOptions {
  /** Exclude this claim from the duplicate list (the file being checked). */
  excludeClaimId?: Id;
}

export function crossFileRegistrationCheck(
  registration: string,
  claims: Claim[],
  vehicles: Vehicle[],
  fleetUnits: FleetUnit[],
  opts: CrossFileOptions = {}
): CrossFileRegistrationResult {
  const reg = normaliseRegistration(registration);
  const matchedVehicleIds = vehicles.filter((v) => normaliseRegistration(v.registration) === reg).map((v) => v.id);
  const vehicleIdSet = new Set(matchedVehicleIds);

  const duplicateClaimIds = claims
    .filter((c) => c.id !== opts.excludeClaimId)
    .filter((c) => vehicleIdSet.has(c.clientVehicleId) || (c.thirdPartyVehicleId !== undefined && vehicleIdSet.has(c.thirdPartyVehicleId)))
    .map((c) => c.id);

  const fleetByVehicle = fleetUnits.some((fu) => vehicleIdSet.has(fu.vehicleId));
  const fleetByOwnership = vehicles.some((v) => vehicleIdSet.has(v.id) && v.ownership === 'fleet');
  const isFleetUnit = fleetByVehicle || fleetByOwnership;
  const hardStop = isFleetUnit;

  const display = formatRegistration(reg);
  const parts: string[] = [];
  if (isFleetUnit) {
    parts.push(`${display} is a CCGUK fleet unit. It cannot be recorded as a client or third-party vehicle on a claim. Hard stop.`);
  }
  if (duplicateClaimIds.length > 0) {
    parts.push(
      `${display} already appears on ${duplicateClaimIds.length} other claim${duplicateClaimIds.length === 1 ? '' : 's'} (${duplicateClaimIds.join(', ')}). Open a linked but separate file with its own ledger, documents and insurer; a banner is shown on each file.`
    );
  }
  if (parts.length === 0) parts.push(`${display} is not on any other file and is not a fleet unit.`);

  return {
    registration: reg,
    matchedVehicleIds,
    duplicateClaimIds,
    isFleetUnit,
    hardStop,
    severity: hardStop ? 'block' : duplicateClaimIds.length > 0 ? 'warn' : 'none',
    message: parts.join(' ')
  };
}
