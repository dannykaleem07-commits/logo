// owned by knowledge-ui
/**
 * Claim ▸ Agent ▸ insurer profile (docs/SUPREME-KNOWLEDGE-BUILDER.md §11 Elsewhere): what your own claims show about
 * this claim's at-fault insurer — median working days to pay, % paid, top objections and contacts — linking to
 * Knowledge ▸ Insurers. COMPUTED figures are internal only. Renders nothing before the learners are installed.
 */
import { Link } from 'react-router-dom';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { useInsurerLinks, useInsurerProfile } from '../../api/knowledgeApi';
import { KnowledgeBadges } from './parts';
import { humanise, knowledgeHref, num1, pct } from './knowledgeView';
import { TOO_FEW } from './InsurersTab';
import './knowledge.css';

export function InsurerProfileCard({ partyId, partyName }: { partyId: string | null | undefined; partyName?: string | null }) {
  const links = useInsurerLinks(false);
  const slug = partyId ? links.data?.links?.find((l) => l.partyId === partyId)?.insurerSlug : undefined;
  const q = useInsurerProfile(slug);
  if (!partyId || links.isLoading) return null;
  // Not installed yet, or the API is unreachable: the Agent tab carries on without the card.
  if (links.error) return null;
  if (!slug)
    return (
      <Card title="Insurer profile">
        <p className="small muted">
          {partyName ?? 'The at-fault insurer'} is not linked to an insurer profile yet. <Link to={knowledgeHref('insurers')}>Link it in Knowledge ▸ Insurers</Link>
        </p>
      </Card>
    );
  const p = q.data;
  const prof = p?.profile12m ?? p?.profileAll ?? null;
  const n = prof?.n.claims ?? 0;
  const few = !prof || n < TOO_FEW;
  const hire = prof?.heads.hire?.paidOfClaimedPct?.median ?? null;
  return (
    <Card title={`Insurer profile · ${p?.name ?? slug}`} actions={<Link to={knowledgeHref('insurers', { insurer: slug })}>Open</Link>}>
      {q.isLoading ? null : !p ? (
        <p className="small muted">No profile yet.</p>
      ) : (
        <div className="stack-sm">
          <div className="row">
            <Badge tone="blue">{`COMPUTED n=${n}`}</Badge>
            <span className="small muted">from your own claims · internal only</span>
          </div>
          {few ? (
            <p className="small muted">Too few claims to say anything yet.</p>
          ) : (
            <div className="kn-insurer-figs">
              <div className="stat">
                <div className="stat-value">{num1(prof!.daysToPay.medianWorkingDays)}</div>
                <div className="stat-label">median working days to pay</div>
              </div>
              <div className="stat">
                <div className="stat-value">{pct(hire)}</div>
                <div className="stat-label">of hire claimed paid</div>
              </div>
            </div>
          )}
          {!few && prof!.objections.length > 0 && <div className="small">Top objections: {prof!.objections.slice(0, 3).map((o) => `${humanise(o.intent)} (${pct(o.pct)})`).join(', ')}</div>}
          {p.contacts.slice(0, 3).map((c, i) => {
            const d = (c.item?.data ?? c.directory ?? {}) as Record<string, unknown>;
            return (
              <div key={c.item?.id ?? `dir-${i}`} className="small">
                <strong>{String(d.team ?? d.name ?? 'Contact')}</strong> {[d.phone, d.email].filter(Boolean).join(' · ')} {c.item ? <KnowledgeBadges badges={c.badges} supportN={c.item.supportN} /> : <Badge tone="grey">DIRECTORY</Badge>}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
