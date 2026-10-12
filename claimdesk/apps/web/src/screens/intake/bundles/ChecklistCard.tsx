// owned by intake-web
/**
 * Missing documents (docs/SMART-INTAKE.md §11.4, improvement 4): what this kind of case needs, what is here and which
 * file covers it, and a preview of the prepared request to the client. The request is only prepared after you
 * register and waits for your approval in Needs you — nothing is sent on its own.
 */
import { Badge } from '../../../components/Badge';
import { Card } from '../../../components/Card';
import type { BundleDetail } from '../../../api/bundlesApi';
import { CHECK_LABEL, CHECK_TONE, checklistSummary } from './bundleModel';

export function ChecklistCard({ detail }: { detail: BundleDetail }) {
  const { checklist } = detail;
  const name = (id: string) => detail.files.find((f) => f.id === id)?.filename ?? id;
  return (
    <Card title="Missing documents" actions={<span className="small muted">{checklistSummary(checklist.items)}</span>}>
      <div className="small muted">Case kind: {checklist.caseKindLabel || checklist.caseKind}</div>
      <ul className="bdl-checklist">
        {checklist.items.map((i) => (
          <li key={i.id} className={`bdl-check bdl-check-${i.status}`}>
            <Badge tone={CHECK_TONE[i.status]}>{CHECK_LABEL[i.status]}</Badge>
            <div>
              <div>{i.label}</div>
              <div className="small muted">
                {i.fileIds.length ? i.fileIds.map(name).join(', ') : i.why}
                {i.fileIds.length && i.status === 'partial' && i.why ? ` — ${i.why}` : ''}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {checklist.request && (
        <details className="bdl-request">
          <summary>Prepared request to the client{checklist.request.to ? ` (${checklist.request.to})` : ''}</summary>
          <div className="small">
            <strong>{checklist.request.subject}</strong>
          </div>
          <pre className="bdl-email">{checklist.request.body}</pre>
          {!checklist.request.to && <p className="small muted">No email address for the client yet — you will get a reminder to ask them instead.</p>}
        </details>
      )}
      <p className="small muted">It is prepared after you register and waits for your approval.</p>
    </Card>
  );
}
