// owned by casework
import { Link } from 'react-router-dom';
import { Card } from '../../../components/Card';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { DateText } from '../../../components/DateText';
import { EmptyState } from '../../../components/EmptyState';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { caseworkApi, jobLabel, useCaseworkMutation, useClaimAgent, useClaimBrief } from '../../../api/caseworkApi';
import type { ClaimView } from '../claimFile';
import { BasisChips } from './agent/BasisChips';
import { TasksCard } from './agent/TasksCard';
import { AskBrainCard } from './agent/AskBrainCard';
import { confidenceLabel, confidenceTone, historyRows, nextBest, outcomeTone } from './agent/agentView';
import { InsurerProfileCard } from '../../knowledge/InsurerProfileCard'; // knowledge-ui
import './agent/agent.css';

/**
 * Agent tab of the claim file (docs/SUPREME-DESIGN.md §L.9): the next best action with its reason and "Based on"
 * chips, the case manager's plan, open tasks and follow-ups, the agent history for this claim, pause / resume,
 * "Review now" and "Ask the brain".
 */
export function AgentTab({ view }: { view: ClaimView }) {
  const claimId = view.claim.id;
  const toast = useToast();
  const brief = useClaimBrief(claimId);
  const agent = useClaimAgent(claimId);
  const reviewNow = useCaseworkMutation(claimId, () => caseworkApi.reviewNow(claimId));
  const pause = useCaseworkMutation(claimId, () => caseworkApi.pause(claimId, 'Paused from the Agent tab'));
  const resume = useCaseworkMutation(claimId, () => caseworkApi.resume(claimId));

  const review = brief.data?.review ?? null;
  const nba = brief.data ? nextBest(review?.result, brief.data.brief.nextActions) : null;
  const state = agent.data?.state;
  const history = agent.data ? historyRows(agent.data.runs, agent.data.jobs) : [];

  return (
    <div className="stack">
      <div className="row-between">
        <span className="muted small">The agents work this claim automatically; anything that needs you appears in Needs-you. {state?.lastReviewAt && <>Last reviewed <DateText value={state.lastReviewAt} time />.</>}</span>
        <div className="row">
          <Button
            variant="primary"
            loading={reviewNow.isPending}
            disabled={state?.paused}
            onClick={() =>
              void reviewNow
                .mutateAsync(undefined)
                .then(() => toast.success('Review queued — the case manager will look at the claim now'))
                .catch(() => undefined)
            }
          >
            Review now
          </Button>
          {state?.paused ? (
            <Button loading={resume.isPending} onClick={() => void resume.mutateAsync(undefined).catch(() => undefined)}>
              Resume agents on this claim
            </Button>
          ) : (
            <Button variant="ghost" loading={pause.isPending} onClick={() => void pause.mutateAsync(undefined).catch(() => undefined)}>
              Pause agents on this claim
            </Button>
          )}
        </div>
      </div>
      <ApiErrorNotice error={reviewNow.error ?? pause.error ?? resume.error} what="change the agents on this claim" />
      {state?.paused && (
        <div className="ag-paused" role="status">
          Agents are paused on this claim{state.pausedBy ? ` by ${state.pausedBy}` : ''}{state.pausedAt ? ' since ' : ''}
          {state.pausedAt && <DateText value={state.pausedAt} time />}. Nothing is drafted or sent automatically until you resume.
        </div>
      )}
      {(brief.isLoading || agent.isLoading) && <Loading />}
      <ApiErrorNotice error={brief.error ?? agent.error} what="load the Agent tab" />

      {brief.data && (
        <div className="ag-layout">
          <div className="stack">
            <Card title="Next best action" actions={nba ? <Badge tone={nba.source === 'case_review' ? 'blue' : 'grey'}>{nba.source === 'case_review' ? 'case manager' : 'playbook'}</Badge> : undefined}>
              {nba ? (
                <div className="stack-sm">
                  <div className="row">
                    <span className="ag-nba-title">{nba.title}</span>
                    <Badge tone="navy">{nba.code}</Badge>
                    {nba.source === 'case_review' && <Badge tone={confidenceTone(nba.confidence)}>{confidenceLabel(nba.confidence)} sure</Badge>}
                  </div>
                  <div className="ag-why">{nba.why}</div>
                  {nba.dueAt && (
                    <div className="ag-meta">
                      Due <DateText value={nba.dueAt} time />
                    </div>
                  )}
                  <BasisChips basis={nba.basis} />
                </div>
              ) : (
                <EmptyState title="Nothing due">The playbook has no action for this claim right now.</EmptyState>
              )}
            </Card>

            <Card title="The plan" actions={review ? <span className="ag-meta"><DateText value={review.at} time /></span> : undefined}>
              {review ? (
                <div className="stack-sm">
                  <div className="ag-why">{review.result.situation}</div>
                  {review.result.actions.length > 0 && (
                    <ul className="list">
                      {review.result.actions.map((a, i) => (
                        <li key={`${a.code}:${i}`}>
                          <div className="list-main stack-sm">
                            <div className="row">
                              <span className="list-title">{a.title}</span>
                              <Badge tone="grey">{a.code}</Badge>
                            </div>
                            <div className="list-sub">{a.why}</div>
                            <BasisChips basis={a.basis} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {review.result.risks.length > 0 && (
                    <div className="stack-sm">
                      {review.result.risks.map((r, i) => (
                        <div key={i} className="row">
                          <Badge tone={r.severity === 'high' ? 'red' : r.severity === 'medium' ? 'amber' : 'grey'}>{r.severity} risk</Badge>
                          <span className="small">{r.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {review.result.questionsForOwner.length > 0 && <div className="small muted">Questions for you are in Needs-you.</div>}
                </div>
              ) : (
                <EmptyState title="No case review yet">Press “Review now”, or wait for the next inbound email, task or the morning sweep.</EmptyState>
              )}
            </Card>

            <TasksCard claimId={claimId} tasks={agent.data?.tasks ?? []} />
          </div>

          <div className="stack">
            {agent.data && agent.data.needsYou.length > 0 && (
              <Card title={`Waiting for you (${agent.data.needsYou.length})`} flush>
                <ul className="list">
                  {agent.data.needsYou.map((n) => (
                    <li key={n.id}>
                      <div className="list-main">
                        <Link className="list-title" to={`/needs-you/${n.id}`}>
                          {n.title}
                        </Link>
                        <div className="list-sub">{n.kind.replace(/_/g, ' ')}</div>
                      </div>
                      <Badge tone={n.priority === 'urgent' ? 'red' : n.priority === 'high' ? 'amber' : 'grey'}>{n.priority}</Badge>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            <InsurerProfileCard partyId={view.atFaultInsurer?.id} partyName={view.atFaultInsurer?.name} />
            <AskBrainCard claimId={claimId} notes={brief.data.notes} />
            <Card title="Agent history" flush>
              {history.length ? (
                <ul className="list">
                  {history.map((h) => (
                    <li key={`${h.kind}:${h.id}`}>
                      <div className="list-main">
                        <div className="row">
                          <span className="list-title">{jobLabel(h.type)}</span>
                          <Badge tone={outcomeTone(h.status)}>{h.status.replace(/_/g, ' ')}</Badge>
                        </div>
                        <div className="list-sub">
                          <DateText value={h.at} time /> · {h.detail}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No agent activity yet" />
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
