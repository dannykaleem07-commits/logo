import type { ExternalVehicleLink } from '@ccguk/domain';
import { externalVehicleLinks, formatRegistration, normaliseRegistration, totalCarCheckUrl } from '@ccguk/domain';

/** Button label and note (docs/TEMPLATES-VEHICLES-DESKTOP.md §E.2). */
export const TCC_LABEL = 'Open on Total Car Check';
export const TCC_NOTE = 'Free check in your browser. Copy the details back into ClaimDesk; they are saved as unverified.';

/**
 * The Total Car Check URL to open: the API's link when the lookup reply carried one (its template can be corrected
 * with TOTALCARCHECK_URL_TEMPLATE), else the default template. '' without a registration.
 */
export function tccUrlFor(registration: string, links?: readonly ExternalVehicleLink[]): string {
  const fromApi = links?.find((l) => l.id === 'totalcarcheck')?.url;
  return fromApi || totalCarCheckUrl(registration);
}

/**
 * Opens the free Total Car Check page for the registration in a new browser tab. ClaimDesk never requests the page
 * itself: the handler reads it and copies the details back (PastedDetailsPanel).
 */
export function TotalCarCheckPanel({ registration, links }: { registration: string; links?: readonly ExternalVehicleLink[] }) {
  const reg = normaliseRegistration(registration);
  if (!reg) return <p className="xs muted">Enter the registration to open the free check.</p>;
  const url = tccUrlFor(reg, links);
  const others = (links?.length ? links : externalVehicleLinks(reg)).filter((l) => l.id !== 'totalcarcheck');
  return (
    <div className="stack-sm">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <a className="btn btn-secondary" href={url} target="_blank" rel="noreferrer noopener">
          {TCC_LABEL}
        </a>
        <span className="xs muted">
          for <span className="mono">{formatRegistration(reg)}</span>
        </span>
      </div>
      <p className="xs muted" style={{ margin: 0 }}>
        {TCC_NOTE}
      </p>
      {others.length > 0 && (
        <p className="xs" style={{ margin: 0 }}>
          Official services:{' '}
          {others.map((l, i) => (
            <span key={l.id}>
              {i > 0 && ' · '}
              <a href={l.url} target="_blank" rel="noreferrer noopener" title={l.note}>
                {l.label}
              </a>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
