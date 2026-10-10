// owned by ap-clash
/**
 * Needs-you clash_review (docs/SUPREME-AUTOPILOT.md §I.7, §H.3): the finding (what, why, the rule basis), the related
 * bookings and claims, and what each action does. The actions are the item's options (resolved / cancel the booking /
 * open the booking); nothing here overrides a clash — a manager overrides in the booking dialog.
 */
import { Link } from 'react-router-dom';
import { Badge } from '../../../components/Badge';
import { useClaimClashes } from '../../../api/clashApi';
import { clashBasis, clashLabel, isOverridable, SEVERITY_LABEL, SEVERITY_TONE } from '../../claim/lib/clashes';
import type { NeedsYouPanelProps } from './types';

interface Payload {
  findingId?: string;
  code?: string;
  severity?: 'block' | 'warn' | 'info';
  overrideClass?: 'A' | 'B' | 'C';
  message?: string;
  reservationId?: string | null;
  related?: { claimIds?: string[]; reservationIds?: string[]; hireIds?: string[] };
}

export function ClashReviewPanel({ item, closed }: NeedsYouPanelProps) {
  const p = (item.payload ?? {}) as Payload;
  const stored = useClaimClashes(item.claimId);
  const finding = stored.data?.findings.find((f) => f.id === p.findingId);
  const severity = p.severity ?? finding?.severity ?? 'block';
  const code = p.code ?? finding?.code ?? '';
  const related = finding?.relatedClaims ?? [];
  return (
    <div className="stack-sm">
      <div className="row">
        <Badge tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</Badge>
        <strong>{clashLabel(code)}</strong>
        {finding && finding.status !== 'open' && <Badge tone="grey">{finding.status}</Badge>}
      </div>
      <p>{p.message ?? finding?.message}</p>
      {clashBasis(code) && <p className="muted small">{clashBasis(code)}</p>}
      {related.length > 0 && (
        <p className="small">
          Related claim{related.length === 1 ? '' : 's'}:{' '}
          {related.map((c, i) => (
            <span key={c.id}>
              {i > 0 ? ', ' : ''}
              <Link to={`/claims/${c.id}`}>{c.reference}</Link>
            </span>
          ))}
        </p>
      )}
      {item.claimId && (
        <p className="small">
          <Link to={`/claims/${item.claimId}`}>Open this claim</Link> · <Link to="/fleet/clashes">All clashes</Link>
        </p>
      )}
      {!closed && (
        <ul className="muted small">
          <li>
            <strong>It is resolved</strong>: the cause is fixed (say how); the finding closes. If it is still there at the next check it comes back.
          </li>
          {p.reservationId && (
            <li>
              <strong>Cancel the booking</strong>: releases the car (reason kept on the booking).
            </li>
          )}
          <li>
            <strong>Open the booking</strong>:{' '}
            {isOverridable({ severity, overrideClass: p.overrideClass ?? 'C' }) ? 'a manager can override it there with a reason (audited).' : 'this clash can never be overridden; change the car or the period.'}
          </li>
        </ul>
      )}
    </div>
  );
}
