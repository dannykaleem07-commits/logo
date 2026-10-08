// owned by mail
import { Badge } from '../../../../components/Badge';
import { DateText } from '../../../../components/DateText';
import { api } from '../../../../api/client';
import { useMailMessage, type MailMessageSummary } from '../../../../api/mailApi';

/** "matched because …" in one line. */
export function matchedBecause(m: Pick<MailMessageSummary, 'match'>): string | null {
  if (!m.match) return null;
  const who = m.match.decidedBy === 'owner' ? 'You filed it' : m.match.decidedBy === 'agent' ? 'An agent filed it' : 'Matched';
  return m.match.because.length ? `${who} because ${m.match.because.join('; ')}` : m.match.decidedBy === 'auto' ? null : who;
}

/** One message: plain text only (HTML was converted to text on arrival; no remote content), attachments → evidence. */
export function MessageView({ summary }: { summary: MailMessageSummary }) {
  const q = useMailMessage(summary.id);
  const m = q.data?.message;
  const because = matchedBecause(summary);
  return (
    <article className={`mb-message${summary.direction === 'out' ? ' out' : ''}`} aria-label={summary.subject ?? 'Email'}>
      <div className="mb-message-head">
        <div>
          <strong>{summary.direction === 'out' ? 'Sent' : summary.fromName || summary.from || 'Unknown sender'}</strong>
          {summary.direction === 'in' && summary.from && summary.fromName && <span className="ob-meta"> &lt;{summary.from}&gt;</span>}
          <div className="ob-meta">To {summary.to.join(', ')}</div>
        </div>
        <div className="ob-item-top">
          {summary.intent && (
            <Badge tone="blue" title={`${Math.round(summary.intent.confidence * 100)}% — ${summary.intent.summary}`}>
              {summary.intent.label}
            </Badge>
          )}
          {summary.spoofSuspect && <Badge tone="red">Suspicious sender</Badge>}
          <DateText value={summary.at} time />
        </div>
      </div>
      {summary.intent?.summary && <div className="mb-because">{summary.intent.summary}</div>}
      {because && <div className="mb-because">{because}</div>}
      <pre className="mb-body">{m ? m.bodyText || '(no text)' : summary.snippet}</pre>
      {q.data && q.data.attachments.length > 0 && (
        <div className="mb-attachments" aria-label="Attachments">
          {q.data.attachments.map((a) => (
            <a key={a.id} className="mb-chip" href={api.evidenceFileUrl(a.claimEvidenceId ?? a.evidenceId)} target="_blank" rel="noreferrer">
              {a.filename} · {Math.max(1, Math.round(a.bytes / 1024))} KB{a.claimEvidenceId ? ' · in evidence' : ''}
            </a>
          ))}
        </div>
      )}
    </article>
  );
}
