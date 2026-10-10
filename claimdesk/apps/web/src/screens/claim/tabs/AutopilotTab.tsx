// owned by ap-autopilot
/**
 * Claim tab Autopilot (docs/SUPREME-AUTOPILOT.md §I.1): the 14-stage bar, the mode chip with one-click pause / resume,
 * the Next card and the Waiting-on chips, the clash card, the hire offers (with "Accepted by phone"), then the
 * timeline — one lane per track, each step with its status icon, mode chip ("raised because …"), due countdown, what
 * we wait for, links and a menu (Run now, Always ask me, Skip, Mark done, Snooze). Done steps collapse per lane.
 * Polls every 15 seconds. Offers, settlements, money and legal steps are "Ask me" or "I do it" by floor.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { StepState } from '@ccguk/domain';
import { useAcceptByPhone, useAutopilotView, useHireOffers, usePauseAutopilot, useResumeAutopilot, useStepAction, type StepAction } from '../../../api/autopilotApi';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { DateText } from '../../../components/DateText';
import { Modal } from '../../../components/Modal';
import { TextArea } from '../../../components/Form';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { Loading } from '../../../components/Spinner';
import { useToast } from '../../../components/Toast';
import type { ClaimView } from '../claimFile';
import { ClaimClashesCard } from '../components/ClaimClashesCard';
import { ago, countdown, doneBy, groupByTrack, MODE_LABEL, MODE_TONE, nextCard, STAGES, STATUS_ICON, STATUS_LABEL, stageIndex, stageLabel, WAITING_LABEL, waitingChips, type TimelineRow } from '../lib/autopilot';
import './autopilot.css';

type Prompt = { kind: 'pause' } | { kind: 'step'; stepId: string; action: 'skip' | 'done'; title: string } | { kind: 'phone'; offerId: string; registration: string } | null;

export function AutopilotTab({ view }: { view: ClaimView }) {
  const claimId = view.claim.id;
  const q = useAutopilotView(claimId);
  const offersQ = useHireOffers(claimId);
  const pause = usePauseAutopilot(claimId);
  const resume = useResumeAutopilot(claimId);
  const step = useStepAction(claimId);
  const accept = useAcceptByPhone(claimId);
  const toast = useToast();
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [reason, setReason] = useState('');
  const [showDone, setShowDone] = useState<Record<string, boolean>>({});
  const now = Date.now();
  const data = q.data;
  const groups = useMemo(() => (data ? groupByTrack(data.plan, data.catalogue) : []), [data]);

  if (q.isLoading) return <Loading />;
  if (q.error || !data) return <ApiErrorNotice error={q.error} what="load the autopilot plan" />;
  const { plan, record } = data;
  const idx = stageIndex(plan.stage);
  const next = nextCard(plan, data.catalogue);
  const chips = waitingChips(plan, data.log);

  const runAction = (stepId: string, action: StepAction, extra: { reason?: string } = {}) =>
    step.mutate(
      { stepId, action, ...extra },
      { onSuccess: () => toast.success(action === 'run' ? 'Queued — the autopilot runs it in a moment' : 'Saved'), onError: (e) => toast.error(e instanceof Error ? e.message : String(e)) },
    );

  const submitPrompt = () => {
    if (!prompt) return;
    const r = reason.trim();
    if (prompt.kind === 'pause') pause.mutate(r || 'Paused from the Autopilot tab');
    else if (prompt.kind === 'step') runAction(prompt.stepId, prompt.action, { reason: r });
    else if (prompt.kind === 'phone') accept.mutate({ offerId: prompt.offerId, how: 'phone', ...(r ? { note: r } : {}) });
    setPrompt(null);
    setReason('');
  };

  return (
    <div className="ap-tab">
      <Card
        title="Autopilot"
        actions={
          <div className="ap-row">
            <Badge tone={record.mode === 'on' ? 'green' : record.mode === 'paused' ? 'amber' : 'grey'}>{record.mode === 'on' ? 'On' : record.mode === 'paused' ? 'Paused' : 'Off'}</Badge>
            {record.mode === 'on' ? (
              <Button size="sm" onClick={() => setPrompt({ kind: 'pause' })}>
                Pause autopilot on this claim
              </Button>
            ) : (
              <Button size="sm" variant="primary" loading={resume.isPending} onClick={() => resume.mutate()}>
                Resume
              </Button>
            )}
          </div>
        }
      >
        {data.stopped && <p className="ap-notice">{data.stopped}</p>}
        {record.mode !== 'on' && record.pausedReason && <p className="ap-notice">Paused{record.pausedBy ? ` by ${record.pausedBy}` : ''}: {record.pausedReason}</p>}
        <ol className="ap-stages" aria-label={`Stage: ${stageLabel(plan.stage)}`}>
          {STAGES.map((s, i) => (
            <li key={s.id} className={i < idx ? 'ap-stage ap-stage-done' : i === idx ? 'ap-stage ap-stage-current' : 'ap-stage'} aria-current={i === idx ? 'step' : undefined}>
              {s.label}
            </li>
          ))}
        </ol>
        {idx < 0 && <p className="ap-notice">{stageLabel(plan.stage)}</p>}
        {next && (
          <div className="ap-next" data-testid="ap-next">
            <strong>Next:</strong> {next.text} <Badge tone={MODE_TONE[next.mode]}>{MODE_LABEL[next.mode]}</Badge>
          </div>
        )}
        {chips.length > 0 && (
          <div className="ap-row ap-chips">
            <span className="ap-muted">Waiting on</span>
            {chips.map((c) => (
              <Badge key={c.who} tone="blue">
                {c.who}
                {c.since && ago(c.since, now) ? ` since ${ago(c.since, now)}` : ''}
              </Badge>
            ))}
          </div>
        )}
      </Card>

      <ClaimClashesCard claimId={claimId} />

      <OffersCard offers={offersQ.data?.offers ?? []} onPhone={(offerId, registration) => setPrompt({ kind: 'phone', offerId, registration })} />

      {groups.map((g) => (
        <Card key={g.id} title={g.label} className="ap-lane">
          {g.open.length === 0 && <p className="ap-muted">Nothing open.</p>}
          <ul className="ap-steps">
            {g.open.map((r) => (
              <StepRow key={r.state.id} row={r} now={now} claimId={claimId} onAction={(action) => (action === 'skip' || action === 'done' ? setPrompt({ kind: 'step', stepId: r.state.id, action, title: r.def?.title ?? r.state.id }) : runAction(r.state.id, action))} />
            ))}
          </ul>
          {g.done.length > 0 && (
            <div className="ap-done">
              <button type="button" className="ap-link" aria-expanded={Boolean(showDone[g.id])} onClick={() => setShowDone((s) => ({ ...s, [g.id]: !s[g.id] }))}>
                Done ({g.done.length})
              </button>
              {showDone[g.id] && (
                <ul className="ap-steps">
                  {g.done.map((r) => {
                    const by = doneBy(r.state.id, data.log);
                    return (
                      <li key={r.state.id} className="ap-step ap-step-done">
                        <span className="ap-icon" aria-hidden>
                          {STATUS_ICON[r.state.status]}
                        </span>
                        <span>{r.def?.title ?? r.state.id}</span>
                        {by && (
                          <span className="ap-muted">
                            <DateText value={by.at} time /> · {by.actor}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </Card>
      ))}

      <Modal
        open={prompt !== null}
        title={prompt?.kind === 'pause' ? 'Pause the autopilot on this claim' : prompt?.kind === 'phone' ? `Accepted by phone — ${prompt.registration}` : prompt ? `${prompt.action === 'skip' ? 'Skip' : 'Mark done'}: ${prompt.title}` : ''}
        onClose={() => setPrompt(null)}
        footer={
          <>
            <Button onClick={() => setPrompt(null)}>Cancel</Button>
            <Button variant="primary" disabled={prompt?.kind === 'step' && reason.trim().length < 3} onClick={submitPrompt}>
              {prompt?.kind === 'pause' ? 'Pause' : prompt?.kind === 'phone' ? 'Record acceptance' : 'Save'}
            </Button>
          </>
        }
      >
        <TextArea label={prompt?.kind === 'phone' ? 'Note of the call (optional)' : 'Reason'} value={reason} onChange={setReason} rows={3} />
      </Modal>
    </div>
  );
}

function StepRow({ row, now, claimId, onAction }: { row: TimelineRow; now: number; claimId: string; onAction: (a: StepAction) => void }) {
  const st: StepState = row.state;
  const due = countdown(st.dueAt, now);
  return (
    <li className={`ap-step ap-step-${st.status}`} data-testid={`ap-step-${st.id}`}>
      <span className="ap-icon" aria-label={STATUS_LABEL[st.status]} title={STATUS_LABEL[st.status]}>
        {STATUS_ICON[st.status]}
      </span>
      <div className="ap-step-body">
        <div className="ap-row">
          <strong>{row.def?.title ?? st.id}</strong>
          <Badge tone={MODE_TONE[st.mode]} title={st.modeReasons.length ? `Raised because: ${st.modeReasons.join(' ')}` : undefined}>
            {MODE_LABEL[st.mode]}
          </Badge>
          {due && <span className={due.overdue ? 'ap-overdue' : 'ap-muted'}>{due.text}</span>}
          {st.waitingOn && <span className="ap-muted">waiting on {WAITING_LABEL[st.waitingOn] ?? st.waitingOn}</span>}
        </div>
        <div className="ap-muted">{st.next}</div>
        {st.modeReasons.length > 0 && st.mode !== 'auto' && <div className="ap-reasons">{st.modeReasons.join(' ')}</div>}
        <div className="ap-row ap-links">
          {st.refs.needsYouId && <Link to={`/needs-you/${st.refs.needsYouId}`}>Needs-you card</Link>}
          {st.refs.reservationId && <Link to={`/claims/${claimId}?tab=hire`}>Booking</Link>}
          {st.refs.packId && <Link to={`/claims/${claimId}?tab=documents`}>Paperwork pack</Link>}
          {st.refs.outboxIds?.length ? <Link to={`/outbox/${st.refs.outboxIds[st.refs.outboxIds.length - 1]}`}>Email</Link> : null}
        </div>
      </div>
      <div className="ap-menu" role="group" aria-label={`Actions for ${row.def?.title ?? st.id}`}>
        <Button size="sm" onClick={() => onAction('run')}>Run now</Button>
        <Button size="sm" onClick={() => onAction('ask')}>Always ask me</Button>
        <Button size="sm" onClick={() => onAction('skip')}>Skip</Button>
        <Button size="sm" onClick={() => onAction('done')}>Mark done</Button>
        <Button size="sm" onClick={() => onAction('snooze')}>Snooze</Button>
      </div>
    </li>
  );
}

function OffersCard({ offers, onPhone }: { offers: Array<{ id: string; status: string; terms: { registration: string; makeModel: string }; sentAt?: string; expiresAt: string; authorisedBy: string; response?: { how: string; decision: string } }>; onPhone: (offerId: string, registration: string) => void }) {
  if (!offers.length) return null;
  return (
    <Card title="Hire offers">
      <ul className="ap-steps">
        {offers.slice(0, 5).map((o) => (
          <li key={o.id} className="ap-step">
            <div className="ap-step-body">
              <div className="ap-row">
                <strong>
                  {o.terms.makeModel} ({o.terms.registration})
                </strong>
                <Badge tone={o.status === 'accepted' ? 'green' : o.status === 'sent' ? 'blue' : o.status === 'declined' || o.status === 'expired' ? 'red' : 'grey'}>{o.status}</Badge>
                <span className="ap-muted">{o.authorisedBy === 'autopilot_green' ? 'sent by the autopilot (green)' : `authorised by ${o.authorisedBy}`}</span>
              </div>
              <div className="ap-muted">
                {o.sentAt ? (
                  <>
                    Sent <DateText value={o.sentAt} time /> ·{' '}
                  </>
                ) : null}
                Held until <DateText value={o.expiresAt} time />
                {o.response ? ` · ${o.response.decision === 'accept' ? 'accepted' : 'declined'} (${o.response.how.replace(/_/g, ' ')})` : ''}
              </div>
            </div>
            {(o.status === 'sent' || o.status === 'expired' || o.status === 'draft') && (
              <Button size="sm" variant="primary" onClick={() => onPhone(o.id, o.terms.registration)}>
                Accepted by phone
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
