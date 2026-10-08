// owned by mail
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { DateText } from '../../../components/DateText';
import { useToast } from '../../../components/Toast';
import { OUTBOX_STATUS_LABEL, OUTBOX_STATUS_TONE, mailApi, useClaimMailbox, useMailMutation, type MailboxThread, type OutboxDetail } from '../../../api/mailApi';
import { HeldCountdown } from '../../outbox/HeldCountdown';
import { ComposeDialog, type ComposeDefaults } from './mailbox/ComposeDialog';
import { MessageView } from './mailbox/MessageView';
import type { ClaimView } from '../claimFile';
import '../../outbox/outbox.css';

/** Threads newest first; the selected one defaults to the newest. */
export function pickThread(threads: MailboxThread[], selected: string | undefined): MailboxThread | undefined {
  return threads.find((t) => t.threadKey === selected) ?? threads[0];
}

function JustSent({ sent, onDone }: { sent: OutboxDetail; onDone: () => void }) {
  const toast = useToast();
  const undo = useMailMutation(() => mailApi.undo(sent.item.id));
  if (sent.item.status !== 'held') return null;
  return (
    <div className="ob-undo-banner" role="status">
      <div>
        <strong>“{sent.item.subject}”</strong> to {sent.item.to.join(', ')} — <HeldCountdown holdUntil={sent.item.holdUntil} serverNow={sent.now} />
      </div>
      <Button
        variant="danger"
        loading={undo.isPending}
        onClick={() =>
          void undo
            .mutateAsync(undefined)
            .then(() => {
              toast.success('Undone — the email will not be sent');
              onDone();
            })
            .catch(() => undefined)
        }
      >
        Undo
      </Button>
      <ApiErrorNotice error={undo.error} what="undo this email" />
    </div>
  );
}

/**
 * Mailbox tab of the claim file (docs/SUPREME-DESIGN.md §L.5): threads (newest first), the message viewer (plain text
 * only), attachments linked to evidence, intent chip, "matched because …", drafts and sent items with their status,
 * and Compose (the owner's own email: 30-second Undo; optional "check before sending").
 */
export function MailboxTab({ view }: { view: ClaimView }) {
  const claimId = view.claim.id;
  const q = useClaimMailbox(claimId);
  const [selected, setSelected] = useState<string | undefined>();
  const [compose, setCompose] = useState<ComposeDefaults | null>(null);
  const [justSent, setJustSent] = useState<OutboxDetail | null>(null);
  const threads = useMemo(() => q.data?.threads ?? [], [q.data]);
  const thread = pickThread(threads, selected);
  const outbox = q.data?.outbox ?? [];
  const lastIn = thread ? [...thread.messages].reverse().find((m) => m.direction === 'in') : undefined;

  return (
    <div className="mb-stack">
      <div className="ob-item-top" style={{ justifyContent: 'space-between' }}>
        <span className="ob-meta">Email to and from this claim. Mail is read from the IONOS mailbox and filed here automatically.</span>
        <div className="ob-actions">
          {lastIn && (
            <Button onClick={() => setCompose({ to: lastIn.from ?? '', subject: `Re: ${(lastIn.subject ?? '').replace(/^re:\s*/i, '')}`, inReplyToMessageId: lastIn.id })}>
              Reply
            </Button>
          )}
          <Button variant="primary" onClick={() => setCompose({})}>
            Compose
          </Button>
        </div>
      </div>
      {justSent && <JustSent sent={justSent} onDone={() => setJustSent(null)} />}
      {q.isLoading && <Loading />}
      <ApiErrorNotice error={q.error} what="load the mailbox" />
      {q.data && (
        <div className="mb-layout">
          <Card title={`Threads (${threads.length})`} flush>
            {threads.length ? (
              <ul className="mb-threads">
                {threads.map((t) => {
                  const last = t.messages[t.messages.length - 1]!;
                  return (
                    <li key={t.threadKey}>
                      <button type="button" className={`mb-thread${t.threadKey === thread?.threadKey ? ' selected' : ''}`} onClick={() => setSelected(t.threadKey)} aria-pressed={t.threadKey === thread?.threadKey}>
                        <span className="mb-thread-top">
                          <strong>{t.subject}</strong>
                          <DateText value={t.lastAt} />
                        </span>
                        <span className="ob-item-top">
                          {last.intent && <Badge tone="blue">{last.intent.label}</Badge>}
                          {t.count > 1 && <Badge>{t.count}</Badge>}
                          {t.messages.some((m) => m.hasAttachments) && <Badge tone="grey">attachments</Badge>}
                        </span>
                        <span className="mb-snippet">{last.snippet}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState title="No email on this claim yet">Messages that quote {view.claim.reference}, the insurer’s reference or a registration on the claim are filed here.</EmptyState>
            )}
          </Card>
          <div className="mb-stack">
            {thread ? (
              <Card title={thread.subject}>
                <div className="mb-stack">
                  {thread.messages.map((m) => (
                    <MessageView key={m.id} summary={m} />
                  ))}
                </div>
              </Card>
            ) : null}
            <Card title={`Drafts and sent (${outbox.length})`} actions={<Link to="/outbox">Outbox</Link>} flush>
              {outbox.length ? (
                <ul className="ob-list">
                  {outbox.map((o) => (
                    <li key={o.id} className="ob-item">
                      <div className="ob-item-main">
                        <div className="ob-item-top">
                          <Badge tone={OUTBOX_STATUS_TONE[o.status]}>{OUTBOX_STATUS_LABEL[o.status]}</Badge>
                          <span className="ob-subject">{o.subject}</span>
                        </div>
                        <div className="ob-meta">
                          To {o.to.join(', ')} · {o.kind.replace(/_/g, ' ')} · <DateText value={o.updatedAt} time />
                          {o.recipients.some((r) => !r.verified) && ' · recipient not verified'}
                        </div>
                        {o.policy.reasons.length > 0 && o.status !== 'sent' && <div className="ob-meta">{o.policy.reasons.join('; ')}</div>}
                      </div>
                      <div className="ob-actions">
                        {o.status === 'held' && <HeldCountdown holdUntil={o.holdUntil} serverNow={new Date().toISOString()} />}
                        {(o.status === 'held' || o.status === 'awaiting_approval' || o.status === 'failed') && <Link to={`/outbox?focus=${o.id}`}>Open</Link>}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No drafts or sent email" />
              )}
            </Card>
          </div>
        </div>
      )}
      {compose && <ComposeDialog open onClose={() => setCompose(null)} onSent={setJustSent} claimId={claimId} reference={view.claim.reference} evidence={view.evidence ?? []} defaults={compose} />}
    </div>
  );
}
