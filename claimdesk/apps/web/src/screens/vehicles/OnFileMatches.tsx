import { Link } from 'react-router-dom';
import type { OnFileMatch } from '@ccguk/domain';
import { formatRegistration } from '@ccguk/domain';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { DateText } from '../../components/DateText';
import { LOOKUP_PROVIDER_LABEL } from '../claim/lib/vehicle';
import { useManagerMode } from '../../app/managerMode';
import { MANAGER_WARNING_PREFIX } from '../../lib/managerMode';
import { describeVehicle, fleetMatchHandling, FUEL_LABEL } from './vehiclePickerModel';

/** A fleet vehicle cannot be the client vehicle on a claim (allowed with a warning in manager mode; the claim gets a block flag). */
export function isFleetMatch(m: OnFileMatch): boolean {
  return m.ownership === 'fleet' || Boolean(m.fleetUnit);
}

const OWNERSHIP_LABEL: Record<OnFileMatch['ownership'], string> = { client: 'Client vehicle', third_party: 'Third-party vehicle', fleet: 'CCGUK fleet', other: 'Other' };

/**
 * Vehicles ClaimDesk already holds for a searched registration (§E.1): exact match first, then similar registrations.
 * "Use this vehicle" reuses the record; for a similar registration the host may offer to search that registration.
 */
export function OnFileMatches({
  matches,
  onUse,
  onSearchRegistration,
  blockFleet = false,
  warnFleet = false,
  useLabel = 'Use this vehicle',
  disabled
}: {
  matches: readonly OnFileMatch[];
  onUse?: (m: OnFileMatch) => void;
  /** For a similar (partial) registration: search that registration instead. */
  onSearchRegistration?: (registration: string) => void;
  /** New claim: a fleet vehicle is a hard stop, so it gets no "Use this vehicle" — except in manager mode (0.3 §A.6 B17). */
  blockFleet?: boolean;
  /** Offer "Use this vehicle" for a fleet vehicle with an "Allowed in manager mode" warning. */
  warnFleet?: boolean;
  useLabel?: string;
  disabled?: boolean;
}) {
  const managerOn = useManagerMode().on;
  const handling = fleetMatchHandling({ blockFleet, warnFleet, managerOn });
  const hardBlock = handling === 'block';
  const warn = handling === 'warn';
  if (matches.length === 0) return <p className="small muted">Nothing on file for this registration yet.</p>;
  return (
    <div className="grid-2">
      {matches.map((m) => {
        const latest = m.lookups[0];
        const fleet = isFleetMatch(m);
        return (
          <div className="card" key={m.vehicleId}>
            <div className="card-body stack-sm">
              <div className="row-between">
                <span className="reg-plate" style={{ fontSize: '0.85em' }}>
                  {formatRegistration(m.registration)}
                </span>
                <Badge tone={m.match === 'exact' ? 'green' : 'grey'}>{m.match === 'exact' ? 'on file' : 'similar registration'}</Badge>
              </div>
              <div className="strong">{describeVehicle({ make: m.make === 'UNKNOWN' ? '' : m.make, model: m.model === 'UNKNOWN' ? '' : m.model, variant: m.variant ?? '', yearOfManufacture: m.yearOfManufacture, engineCapacityCc: m.engineCapacityCc }) || 'Make and model not recorded'}</div>
              <div className="xs muted">
                {[m.colour, m.fuelType ? FUEL_LABEL[m.fuelType] : '', m.transmission && m.transmission !== 'unknown' ? m.transmission : '', m.bodyType, OWNERSHIP_LABEL[m.ownership]].filter(Boolean).join(' · ')}
              </div>
              {m.claims.length > 0 && (
                <div className="xs">
                  On {m.claims.length === 1 ? 'claim' : `${m.claims.length} claims`}:{' '}
                  {m.claims.map((c, i) => (
                    <span key={c.id}>
                      {i > 0 && ', '}
                      <Link to={`/claims/${c.id}`} target="_blank" rel="noreferrer">
                        {c.reference}
                      </Link>
                    </span>
                  ))}
                </div>
              )}
              {m.fleetUnit && (
                <div className="xs">
                  <Badge tone="blue">fleet unit · {m.fleetUnit.status.replace(/_/g, ' ')}</Badge> group {m.fleetUnit.gtaGroup}
                </div>
              )}
              {latest && (
                <div className="xs muted">
                  Last details: {LOOKUP_PROVIDER_LABEL[latest.provider] ?? latest.provider} · <DateText value={latest.requestedAt} /> · {latest.verification}
                </div>
              )}
              <div className="row" style={{ marginTop: 4 }}>
                {hardBlock && fleet ? (
                  <span className="xs strong" style={{ color: 'var(--red)' }}>
                    CCGUK fleet vehicle — cannot be the client vehicle. A manager can override this in manager mode.
                  </span>
                ) : m.match === 'partial' && onSearchRegistration ? (
                  <Button size="sm" onClick={() => onSearchRegistration(m.registration)} disabled={disabled}>
                    Search {formatRegistration(m.registration)}
                  </Button>
                ) : onUse ? (
                  <span className="stack-sm" style={{ gap: 4 }}>
                    {warn && fleet && (
                      <span className="xs" role="status" style={{ color: 'var(--amber)' }}>
                        {MANAGER_WARNING_PREFIX}a CCGUK fleet vehicle as the client vehicle — the claim gets a block flag until it is cleared.
                      </span>
                    )}
                    <Button size="sm" variant="primary" onClick={() => onUse(m)} disabled={disabled}>
                      {useLabel}
                    </Button>
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
