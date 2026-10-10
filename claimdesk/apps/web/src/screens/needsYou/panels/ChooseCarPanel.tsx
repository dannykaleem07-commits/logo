// owned by ap-autopilot
/**
 * Needs-you choose_car (docs/SUPREME-AUTOPILOT.md §I.7, §H.3): the ranked cars with their factor chips, why the
 * autopilot did not choose by itself, the recommendation and the cars that are not available. The buttons are the
 * item's options (a car, search again, no hire); choosing a car holds it for the client and the offer then goes out
 * as authorised by you.
 */
import { Link } from 'react-router-dom';
import { Badge } from '../../../components/Badge';
import { DateText } from '../../../components/DateText';
import type { NeedsYouPanelProps } from './types';
import '../../claim/tabs/autopilot.css';

interface RankedCar {
  fleetUnitId: string;
  registration: string;
  label: string;
  score: number;
  likeForLike: string;
  factors?: Record<string, { score: number; weight: number; note: string }>;
  driverOutcome?: string;
  warnings?: string[];
}

interface Payload {
  ranked?: RankedCar[];
  reasons?: string[];
  excluded?: Array<{ registration: string; reasons: Array<{ message: string }> }>;
  protectiveHoldId?: string | null;
  period?: { startAt: string; expectedEndAt: string } | null;
}

const FACTOR_LABEL: Record<string, string> = { likeForLike: 'Like for like', needsFit: 'Needs', readiness: 'Ready', compliance: 'Cover', cost: 'Cost', location: 'Distance' };

export function ChooseCarPanel({ item, closed }: NeedsYouPanelProps) {
  const p = (item.payload ?? {}) as Payload;
  const ranked = p.ranked ?? [];
  const recommended = item.recommendation?.action;
  return (
    <div className="ap-tab" data-testid="choose-car-panel">
      {p.reasons && p.reasons.length > 0 && (
        <div className="ap-notice">
          <strong>Why you are asked:</strong> {p.reasons.join(' ')}
        </div>
      )}
      {p.period && (
        <p className="ap-muted">
          Hire from <DateText value={p.period.startAt} time /> to about <DateText value={p.period.expectedEndAt} />
          {p.protectiveHoldId ? ' — the top car is held so it is not taken while you decide.' : '.'}
        </p>
      )}
      {ranked.length === 0 && <p>No car is free, legal and insured for the whole hire. Search again with other dates or needs, or record that there is no hire.</p>}
      <ul className="ap-cars">
        {ranked.map((c, i) => {
          const isRec = recommended ? recommended.includes(c.registration) : i === 0;
          return (
            <li key={c.fleetUnitId} className={isRec ? 'ap-car ap-car-recommended' : 'ap-car'}>
              <div className="ap-row">
                <strong>{c.registration}</strong>
                <span>{c.label}</span>
                <Badge tone="navy">Score {Math.round(c.score)}</Badge>
                {isRec && <Badge tone="green">Recommended</Badge>}
                {c.driverOutcome && c.driverOutcome !== 'eligible' && <Badge tone="amber">Driver: {c.driverOutcome}</Badge>}
              </div>
              <div className="ap-muted">{c.likeForLike}</div>
              {c.factors && (
                <div className="ap-row">
                  {Object.entries(c.factors).map(([k, f]) => (
                    <Badge key={k} tone="grey" title={f.note}>
                      {FACTOR_LABEL[k] ?? k} {f.score.toFixed(2)}
                    </Badge>
                  ))}
                </div>
              )}
              {c.warnings?.map((w) => (
                <div key={w} className="ap-reasons">
                  {w}
                </div>
              ))}
            </li>
          );
        })}
      </ul>
      {p.excluded && p.excluded.length > 0 && (
        <details>
          <summary>Not available ({p.excluded.length})</summary>
          <ul>
            {p.excluded.map((x) => (
              <li key={x.registration}>
                <strong>{x.registration}</strong>: {x.reasons.map((r) => r.message).join('; ')}
              </li>
            ))}
          </ul>
        </details>
      )}
      {item.claimId && !closed && (
        <p className="ap-muted">
          <Link to={`/claims/${item.claimId}?tab=hire`}>Open the Hire tab</Link> to change the needs or the period, or to book a car yourself. Like for like is judged on GTA benchmark rates — a benchmark only.
        </p>
      )}
    </div>
  );
}
