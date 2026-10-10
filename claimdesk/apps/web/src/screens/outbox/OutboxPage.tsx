// owned by mail
import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Loading } from '../../components/Spinner';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { TextArea, TextInput } from '../../components/Form';
import { DateText } from '../../components/DateText';
import { useToast } from '../../components/Toast';
import { api } from '../../api/client';
import { OUTBOX_STATUS_LABEL, OUTBOX_STATUS_TONE, mailApi, parseAddresses, useMailMutation, useOutbox, type OutboxItem, type OutboxStatus } from '../../api/mailApi';
import { HeldCountdown } from './HeldCountdown';
import { KnowledgeUsedPanel } from '../knowledge/KnowledgeUsedPanel'; // knowledge-ui
import './outbox.css';

/** Which item a deep link names: `/outbox/<id>?undo=1`, `/outbox?focus=<id>&undo=1` or `/outbox?undo=<id>` (toasts). */
export function deepLink(params: { id?: string }, search: URLSearchParams): { focusId?: string; undo: boolean } {
  const undo = search.get('undo');
  const focusId = params.id ?? search.get('focus') ?? (undo && undo !== '1' && undo !== 'true' ? undo : undefined);
  return { ...(focusId ? { focusId } : {}), undo: Boolean(undo && focusId) };
}

const SECTIONS: Array<{ id: string; title: string; statuses: OutboxStatus[]; empty: string }> = [
  { id: 'held', title: 'Held — sending soon', statuses: ['held', 'queued', 'sending'], empty: 'Nothing is waiting to go out.' },
  { id: 'approval', title: 'Waiting for your approval', statuses: ['awaiting_approval'], empty: 'Nothing needs your approval.' },
  { id: 'failed', title: 'Failed', statuses: ['failed'], empty: 'No failed emails.' },
  { id: 'review', title: 'Drafts and in review', statuses: ['draft', 'reviewing'], empty: 'No drafts.' },
  { id: 'sent', title: 'Sent', statuses: ['sent'], empty: 'Nothing sent yet.' },
  { id: 'cancelled', title: 'Undone or rejected', statuses: ['cancelled'], empty: 'None.' },
];

function OutboxRow({ item, serverNow, focused }: { item: OutboxItem; serverNow: string; focused: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState(focused);
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [to, setTo] = useState(item.to.join(', '));
  const [subject, setSubject] = useState(item.subject);
  const [body, setBody] = useState(item.bodyText);
  const [reason, setReason] = useState('');
  const undo = useMailMutation(() => mailApi.undo(item.id));
  const sendNow = useMailMutation(() => mailApi.sendNow(item.id));
  const retry = useMailMutation(() => mailApi.retry(item.id));
  const approve = useMailMutation((edits?: { to?: string[]; subject?: string; bodyText?: string }) => mailApi.approve(item.id, edits));
  const reject = useMailMutation((r: string) => mailApi.reject(item.id, r));
  const busy = undo.isPending || sendNow.isPending || retry.isPending || approve.isPending || reject.isPending;
  const error = undo.error ?? sendNow.error ?? retry.error ?? approve.error ?? reject.error;

  const run = (p: Promise<unknown>, ok: string) => p.then(() => toast.success(ok)).catch(() => undefined);

  return (
    <li className={`ob-item${focused ? ' focus' : ''}`} id={`outbox-${item.id}`}>
      <div className="ob-item-main">
        <div className="ob-item-top">
          <Badge tone={OUTBOX_STATUS_TONE[item.status]}>{OUTBOX_STATUS_LABEL[item.status]}</Badge>
          {item.claimReference && item.claimId && <Link to={`/claims/${item.claimId}/mailbox`}>{item.claimReference}</Link>}
          <span className="ob-subject">{item.subject}</span>
        </div>
        <div className="ob-meta">
          To {item.to.join(', ')}
          {item.cc.length > 0 && ` · Cc ${item.cc.join(', ')}`} · {item.kind.replace(/_/g, ' ')} · by {item.createdBy}
          {item.approvedBy && ` · approved by ${item.approvedBy}`} · <DateText value={item.updatedAt} time />
        </div>
        {item.attachments.length > 0 && <div className="ob-meta">Attachments: {item.attachments.map((a) => a.filename ?? a.documentId ?? a.evidenceId).join(', ')}</div>}
        {item.policy.reasons.length > 0 && item.status !== 'sent' && (
          <ul className="ob-reasons" aria-label="Why">
            {item.policy.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
        {item.lastError && item.status !== 'sent' && <div className="ob-meta">Last error: {item.lastError}</div>}
        {open && !editing && <pre className="ob-body">{item.bodyText}</pre>}
        {open && !editing && <KnowledgeUsedPanel targetKind="outbox" targetId={item.id} />}
        {editing && (
          <div className="ob-edit">
            <TextInput label="To" value={to} onChange={setTo} />
            <TextInput label="Subject" value={subject} onChange={setSubject} />
            <TextArea label="Message" value={body} onChange={setBody} rows={10} />
            <div className="ob-actions">
              <Button variant="primary" loading={approve.isPending} disabled={busy} onClick={() => run(approve.mutateAsync({ to: parseAddresses(to), subject, bodyText: body }), 'Approved — sending now')}>
                Approve edited email
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {rejecting && (
          <div className="ob-edit">
            <TextInput label="Why not send it?" value={reason} onChange={setReason} />
            <div className="ob-actions">
              <Button variant="danger" disabled={busy || reason.trim().length < 3} loading={reject.isPending} onClick={() => run(reject.mutateAsync(reason.trim()), 'Rejected — it will not be sent')}>
                Do not send
              </Button>
              <Button variant="ghost" onClick={() => setRejecting(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        <ApiErrorNotice error={error} what="update this email" />
      </div>
      <div className="ob-actions">
        {item.status === 'held' && <HeldCountdown holdUntil={item.holdUntil} serverNow={serverNow} />}
        {(item.status === 'held' || item.status === 'queued') && (
          <>
            <Button variant="danger" size="sm" disabled={busy} loading={undo.isPending} onClick={() => run(undo.mutateAsync(undefined), 'Undone — the email will not be sent')}>
              Undo
            </Button>
            {item.status === 'held' && (
              <Button size="sm" disabled={busy} onClick={() => run(sendNow.mutateAsync(undefined), 'Sending now')}>
                Send now
              </Button>
            )}
          </>
        )}
        {item.status === 'awaiting_approval' && !editing && !rejecting && (
          <>
            <Button variant="primary" size="sm" disabled={busy} loading={approve.isPending} onClick={() => run(approve.mutateAsync(undefined), 'Approved — sending now')}>
              Approve
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setEditing(true)}>
              Edit then approve
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRejecting(true)}>
              Reject
            </Button>
          </>
        )}
        {item.status === 'failed' && (
          <Button variant="primary" size="sm" disabled={busy} loading={retry.isPending} onClick={() => run(retry.mutateAsync(undefined), 'Queued to send again')}>
            Retry
          </Button>
        )}
        {item.status === 'sent' && item.rawSentEvidenceId && (
          <a href={api.evidenceFileUrl(item.rawSentEvidenceId)} target="_blank" rel="noreferrer">
            Sent copy
          </a>
        )}
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
        </Button>
      </div>
    </li>
  );
}

function UndoBanner({ item }: { item: OutboxItem }) {
  const toast = useToast();
  const undo = useMailMutation(() => mailApi.undo(item.id));
  const canUndo = item.status === 'held' || item.status === 'queued' || item.status === 'awaiting_approval';
  return (
    <div className="ob-undo-banner" role="region" aria-label="Undo sending">
      <div>
        <strong>{canUndo ? 'Stop this email?' : item.status === 'cancelled' ? 'This email was stopped.' : 'Too late to undo.'}</strong> “{item.subject}” to {item.to.join(', ')}.
        {!canUndo && item.status !== 'cancelled' && ' It has already gone to the mail server; it cannot be undone.'}
      </div>
      {canUndo && (
        <Button variant="danger" loading={undo.isPending} onClick={() => void undo.mutateAsync(undefined).then(() => toast.success('Undone — the email will not be sent')).catch(() => undefined)}>
          Undo — do not send
        </Button>
      )}
      <ApiErrorNotice error={undo.error} what="undo this email" />
    </div>
  );
}

/** Outbox (docs/SUPREME-DESIGN.md §D.3, §L.5): held with countdown + Undo, awaiting approval, sent, failed + retry. */
export function OutboxPage() {
  const params = useParams<{ id?: string }>();
  const [search] = useSearchParams();
  const link = deepLink(params, search);
  const q = useOutbox();
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const focus = link.focusId ? items.find((i) => i.id === link.focusId) : undefined;

  return (
    <div className="page">
      <PageHeader title="Outbox" subtitle="Emails held before sending, waiting for your approval, sent and failed. Undo stops a held email; once sent it cannot be undone." />
      {q.isLoading && <Loading />}
      <ApiErrorNotice error={q.error} what="load the outbox" />
      {link.undo && focus && <UndoBanner item={focus} />}
      {q.data && (
        <div className="ob-sections">
          {SECTIONS.map((s) => {
            const list = items.filter((i) => s.statuses.includes(i.status));
            if (!list.length && (s.id === 'cancelled' || s.id === 'review')) return null;
            return (
              <Card key={s.id} title={`${s.title} (${list.length})`} flush>
                {list.length ? (
                  <ul className="ob-list">
                    {list.map((i) => (
                      <OutboxRow key={i.id} item={i} serverNow={q.data.now} focused={i.id === link.focusId} />
                    ))}
                  </ul>
                ) : (
                  <EmptyState title={s.empty} />
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
