import { liveEvents, type ClaimBundle, type Id, type Party } from '@ccguk/domain';
import type { Db } from './client.js';
import { requireClaim } from './repos/claims.js';
import { listClocks } from './repos/clocks.js';
import { listDocuments } from './repos/documents.js';
import { getLatestEngineerReport, getLatestEstimate, getLatestPav } from './repos/engineering.js';
import { listEvents } from './repos/events.js';
import { listEvidenceForClaim } from './repos/evidence.js';
import { listHire } from './repos/hire.js';
import { listLedger } from './repos/ledger.js';
import { listOffers } from './repos/offers.js';
import { getParties, requireParty } from './repos/parties.js';
import { listRecovery } from './repos/recovery.js';
import { listStorage } from './repos/storage.js';
import { getVehicle, requireVehicle } from './repos/vehicles.js';

export interface LoadClaimBundleOptions {
  /** Include each document's rendered html (large). Default false — `html` is '' in the bundle. */
  includeHtml?: boolean;
  /** Include superseded ledger entries. Default false. */
  includeSupersededLedger?: boolean;
  /** Include events replaced by a correcting event (`data.correctsEventId`). Default false — engines read live events. */
  includeSupersededEvents?: boolean;
}

/**
 * Assemble the plain `ClaimBundle` every domain engine reads from (clocks, gates, playbook, acceptance,
 * consistency, quantum). Clocks come from the materialised cache (`replaceClocks`) when present, else [].
 * Throws NotFoundError if the claim, claimant or client vehicle is missing.
 */
export function loadClaimBundle(db: Db, claimId: Id, options: LoadClaimBundleOptions = {}): ClaimBundle {
  const claim = requireClaim(db, claimId);
  const claimant = requireParty(db, claim.claimantId);
  const vehicle = requireVehicle(db, claim.clientVehicleId);

  const otherIds = [claim.driverId, claim.atFaultInsurerId, ...claim.thirdPartyIds].filter((x): x is string => Boolean(x));
  const others = new Map<string, Party>(getParties(db, otherIds).map((p) => [p.id, p]));

  const driver = claim.driverId ? others.get(claim.driverId) : undefined;
  const atFaultInsurer = claim.atFaultInsurerId ? others.get(claim.atFaultInsurerId) : undefined;
  const thirdParties = claim.thirdPartyIds.map((id) => others.get(id)).filter((p): p is Party => Boolean(p));
  const thirdPartyVehicle = claim.thirdPartyVehicleId ? getVehicle(db, claim.thirdPartyVehicleId) : undefined;

  const bundle: ClaimBundle = {
    claim,
    claimant,
    vehicle,
    thirdParties,
    events: options.includeSupersededEvents ? listEvents(db, claimId) : liveEvents(listEvents(db, claimId)),
    ledger: listLedger(db, claimId, { includeSuperseded: options.includeSupersededLedger ?? false }),
    offers: listOffers(db, claimId),
    hire: listHire(db, claimId),
    storage: listStorage(db, claimId),
    recovery: listRecovery(db, claimId),
    evidence: listEvidenceForClaim(db, claimId),
    documents: listDocuments(db, { claimId, includeHtml: options.includeHtml ?? false, limit: 10_000 }),
    clocks: listClocks(db, claimId),
    flags: claim.flags,
  };
  if (driver) bundle.driver = driver;
  if (thirdPartyVehicle) bundle.thirdPartyVehicle = thirdPartyVehicle;
  if (atFaultInsurer) bundle.atFaultInsurer = atFaultInsurer;
  const pav = getLatestPav(db, claimId);
  if (pav) bundle.pav = pav;
  const estimate = getLatestEstimate(db, claimId);
  if (estimate) bundle.estimate = estimate;
  const report = getLatestEngineerReport(db, claimId);
  if (report) bundle.report = report;
  return bundle;
}
