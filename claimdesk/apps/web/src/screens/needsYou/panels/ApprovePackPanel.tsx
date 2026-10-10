// owned by ap-paperwork
/**
 * Needs-you approve_pack (docs/SUPREME-AUTOPILOT.md §H.3, §I.7): every document of the pack with its purpose, the
 * reviewer's verdict and points, the signer and who it goes to. The card's options do the work (as the owner):
 * Approve and send / Approve only (sign in person) / Edit (open the documents; approve later from the claim) / Reject.
 */
import { Link } from 'react-router-dom';
import { Badge } from '../../../components/Badge';
import type { PackItemView } from '../../../api/signingApi';
import { PURPOSE_LABEL, verdictTone } from '../../claim/components/packsView';
import type { NeedsYouPanelProps } from './types';

interface Payload {
  packId?: string;
  stage?: string;
  items?: PackItemView[];
  signer?: { name?: string; email?: string };
  sendTo?: Array<{ target: 'client' | 'at_fault_insurer'; address?: string; documents: number }>;
  money?: boolean;
}

export function ApprovePackPanel({ item, closed }: NeedsYouPanelProps) {
  const p = (item.payload ?? {}) as Payload;
  const items = p.items ?? [];
  return (
    <div className="stack-sm">
      <p>
        Signer: <strong>{p.signer?.name ?? 'the client'}</strong>
        {p.signer?.email ? ` (${p.signer.email})` : ''}
      </p>
      {p.sendTo && p.sendTo.length > 0 && (
        <p className="small">
          “Approve and send” emails{' '}
          {p.sendTo.map((s, i) => (
            <span key={s.target}>
              {i > 0 ? ' and ' : ''}
              {s.documents} document{s.documents === 1 ? '' : 's'} to {s.target === 'client' ? 'the client' : 'the at-fault insurer'}
              {s.address ? ` (${s.address})` : ''}
            </span>
          ))}
          , with a covering letter, after a 30-second Undo.
        </p>
      )}
      {p.money && <p className="small">This pack contains invoices or the payment pack: money always needs you.</p>}
      <ul className="stack-sm">
        {items.map((d) => (
          <li key={d.key}>
            <div className="row">
              {d.documentId && item.claimId ? <Link to={`/claims/${item.claimId}/documents/${d.documentId}`}>{d.title ?? d.templateId}</Link> : <span>{d.title ?? d.templateId}</span>}
              <Badge tone="grey">{PURPOSE_LABEL[d.purpose] ?? d.purpose}</Badge>
              {d.verdict ? <Badge tone={verdictTone(d.verdict)}>review: {d.verdict}</Badge> : <Badge tone="grey">not reviewed</Badge>}
            </div>
            {d.issues && d.issues.length > 0 && (
              <ul className="muted small">
                {d.issues.slice(0, 5).map((x, i) => (
                  <li key={i}>
                    {x.severity ? `${x.severity}: ` : ''}
                    {x.message ?? x.code}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {!closed && (
        <p className="muted small">
          Approving signs off every document as you (agreements, forms and invoices are never approved automatically). To change a document, choose Edit, open it from the claim, then approve the pack from the claim’s Paperwork panel.
        </p>
      )}
    </div>
  );
}
