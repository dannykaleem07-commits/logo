// owned by intake-web
/**
 * Chronology proposals (docs/SMART-INTAKE.md §11.4, improvement 8): entries read from the documents' dates, each with
 * its sources. Ticked entries are written to the claim's chronology when you register. Offers, payments, settlements
 * and hire dates are never written by intake — you record those yourself.
 */
import { Link } from 'react-router-dom';
import { Badge } from '../../../components/Badge';
import { Card } from '../../../components/Card';
import type { FieldSource, TimelineProposal } from '../../../api/bundlesApi';
import { SourceChip } from './bundleParts';
import { chipSources, sortTimeline, TIMELINE_CLASS_LABEL, TIMELINE_CLASS_TONE, whenText } from './bundleModel';

export function TimelineCard({ items, onTick, onSource, busy, closed, claimId }: { items: TimelineProposal[]; onTick: (id: string, ticked: boolean) => void; onSource: (title: string, s: FieldSource) => void; busy: boolean; closed: boolean; claimId: string | null }) {
  const sorted = sortTimeline(items);
  return (
    <Card title="Chronology" actions={<span className="small muted">{items.filter((i) => i.ticked && i.class !== 'owner_only').length} to add</span>}>
      {!sorted.length && <p className="small muted">No dated events found in the documents yet.</p>}
      <ul className="bdl-timeline">
        {sorted.map((t) => {
          const ownerOnly = t.class === 'owner_only';
          return (
            <li key={t.id} className={ownerOnly ? 'bdl-tl-owner' : undefined}>
              <label className="bdl-tl-check">
                <input
                  type="checkbox"
                  checked={!ownerOnly && t.ticked}
                  disabled={ownerOnly || closed || busy}
                  onChange={(e) => onTick(t.id, e.target.checked)}
                  aria-label={`Add “${t.summary}” to the chronology`}
                />
                <span>
                  <span className="small muted">{whenText(t.at, t.precision)}</span> <strong>{t.eventLabel}</strong> — {t.summary}
                </span>
              </label>
              <div className="bdl-chips">
                <Badge tone={TIMELINE_CLASS_TONE[t.class]}>{TIMELINE_CLASS_LABEL[t.class]}</Badge>
                {chipSources(t.sources).map((s, i) => (
                  <SourceChip key={`${s.fileId}-${i}`} source={s} onOpen={(x) => onSource(t.eventLabel, x)} />
                ))}
                {ownerOnly && claimId && <Link to={`/claims/${encodeURIComponent(claimId)}/offers`}>Offers</Link>}
              </div>
              {t.note && <div className="small muted">{t.note}</div>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
