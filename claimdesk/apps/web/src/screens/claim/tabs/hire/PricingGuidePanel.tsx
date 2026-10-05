/**
 * Pricing guide (docs/V03-MANAGER-MODE-HIRE-PRICING.md §B.1): the fleet car's own daily rate, the GTA guide for the
 * car we give and for the client's accident-damaged car, the difference, plain-English notices (a higher group in
 * amber) and the benchmark caveat. "change" saves the client's car group on the vehicle and refreshes the panel.
 */
import type { UseQueryResult } from '@tanstack/react-query';
import { formatGBP } from '@ccguk/domain';
import type { HirePricingGuideResponse } from '../../../../api/hireApi';
import { useSaveClientGroup } from '../../../../api/hireApi';
import { ApiErrorNotice } from '../../../../components/ApiErrorNotice';
import { Badge } from '../../../../components/Badge';
import { Spinner } from '../../../../components/Spinner';
import { benchmarkCaveat, clientSourceText, differenceText, displayRegistration, groupChoices, guideLineText, niceName, pricingHeading, pricingNotices } from '../../lib/hirePricing';

export interface PricingGuidePanelProps {
  claimId: string;
  guide: UseQueryResult<HirePricingGuideResponse, Error>;
  /** The client's car group was chosen here (the parent sends it with the hire and keys the guide on it). */
  onClientGroup: (group: string) => void;
}

export function PricingGuidePanel({ claimId, guide, onClientGroup }: PricingGuidePanelProps) {
  const save = useSaveClientGroup(claimId);
  const g = guide.data;
  if (!g) {
    return (
      <section className="pricing-guide" aria-label="Pricing guide">
        <div className="pricing-guide-head">Pricing guide</div>
        {guide.error ? (
          <ApiErrorNotice error={guide.error} what="work out the pricing guide" />
        ) : (
          <div className="small muted row" style={{ gap: 8 }}>
            <Spinner label="Working out the pricing guide" /> Working out the pricing guide…
          </div>
        )}
      </section>
    );
  }
  const unitName = niceName([g.fleetUnit.make, g.fleetUnit.model].filter(Boolean).join(' '));
  const clientName = niceName([g.clientVehicle.make, g.clientVehicle.model].filter(Boolean).join(' '));
  const choices = groupChoices(g);
  // Say each thing once: the client column already carries the "no group / no rate" sentence and the suggestion reason.
  const shown = new Set([g.clientCar.missingReason, g.clientSuggestion?.reason].filter((t): t is string => Boolean(t)).map((t) => t.trim()));
  const notices = pricingNotices(g.notices).filter((n) => !shown.has(n.text.trim()));
  const clientLine =
    g.clientCar.dailyRatePence !== null
      ? `GTA guide ${formatGBP(g.clientCar.dailyRatePence)} · ${clientSourceText(g.clientCar.source)}`
      : !g.clientCar.group
        ? 'No group yet — choose one with change…'
        : (g.clientCar.missingReason ?? 'No guide rate');
  const change = (group: string) => {
    if (!group) return;
    onClientGroup(group);
    save.mutate({ vehicleId: g.clientVehicle.id, gtaGroup: group });
  };
  return (
    <section className="pricing-guide" aria-label="Pricing guide" aria-busy={guide.isFetching || undefined}>
      <div className="pricing-guide-head">
        <span>{pricingHeading(g.date)}</span>
        {(guide.isFetching || save.isPending) && <Spinner label="Updating the pricing guide" />}
      </div>
      <div className="pricing-fleet-line">
        <span className="muted">Fleet car daily rate</span>
        <span>{[displayRegistration(g.fleetUnit.registration), unitName].filter(Boolean).join(' · ')}</span>
        <span className="pricing-rate">{formatGBP(g.fleetDailyRatePence)} / day</span>
      </div>
      <div className="pricing-cols">
        <div className="pricing-col">
          <div className="pricing-col-title">Car we give</div>
          <div>{guideLineText(g.hireCar)}</div>
        </div>
        <div className="pricing-col">
          <div className="pricing-col-title">Client's damaged car</div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span>
              {[clientName, displayRegistration(g.clientVehicle.registration)].filter(Boolean).join(' ')} · {g.clientCar.group ? `Group ${g.clientCar.group}` : 'No group'}
            </span>
            <select className="select" aria-label="Change the client's car group" value="" onChange={(e) => change(e.target.value)} disabled={save.isPending || choices.length === 0}>
              <option value="">change…</option>
              {choices.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>{clientLine}</div>
          {g.clientCar.source === 'suggested' && g.clientSuggestion?.reason && <div className="xs muted">{g.clientSuggestion.reason}</div>}
        </div>
      </div>
      <div className="pricing-diff">
        Difference <strong>{differenceText(g.differencePerDayPence)}</strong> <span className="muted">(car we give − client's car)</span>
        {g.higherGroup && (
          <>
            {' '}
            <Badge tone="amber">higher group</Badge>
          </>
        )}
      </div>
      {notices
        .filter((n) => n.tone === 'warn')
        .map((n) => (
          <div key={n.text} className="notice notice-warn xs" role="alert">
            ⚠ {n.text}
          </div>
        ))}
      {notices.some((n) => n.tone !== 'warn') && (
        <ul className="pricing-info">
          {notices
            .filter((n) => n.tone !== 'warn')
            .map((n) => (
              <li key={n.text}>{n.text}</li>
            ))}
        </ul>
      )}
      <p className="pricing-caveat" title={g.note}>
        {benchmarkCaveat(g.note)} <span aria-hidden="true">ⓘ</span>
      </p>
      <ApiErrorNotice error={save.error} what="save the client's car group" />
    </section>
  );
}
