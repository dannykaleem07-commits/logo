import { Link, useNavigate } from 'react-router-dom';
import type { PlaybookAction } from '@ccguk/domain';
import { useCreateDocument } from '../../../api/hooks';
import { Card } from '../../../components/Card';
import { Badge, PriorityBadge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { DateText } from '../../../components/DateText';
import { Money } from '../../../components/Money';
import { EmptyState } from '../../../components/EmptyState';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { describeDue } from '../../../lib/dates';
import { PRIORITY_LABEL } from '../../../lib/status';
import type { ClaimView } from '../claimFile';
import { useClaimActions } from '../useClaimDerived';
import { BasisText } from '../components/BasisText';
import { gateLabel } from '../components/GatesRow';

const ORDER: PlaybookAction['priority'][] = ['now', 'today', 'this_week', 'scheduled'];

/** The get-paid-faster playbook (BLUEPRINT §7) for this claim, from the API. Blocked actions say what blocks them. */
export function ActionsTab({ view }: { view: ClaimView }) {
  const { actions, isLoading, error } = useClaimActions(view);
  const create = useCreateDocument(view.claim.id);
  const navigate = useNavigate();
  const toast = useToast();
  const now = new Date();

  const generate = (a: PlaybookAction) => {
    if (!a.templateId) return;
    create.mutate(
      { templateId: a.templateId, data: { actionCode: a.code } },
      {
        onSuccess: (doc) => {
          toast.success(`${doc.title} drafted — review the consistency report before approving`);
          navigate(`/claims/${view.claim.id}/documents/${doc.id}`);
        }
      }
    );
  };

  const groups = ORDER.map((p) => ({ priority: p, items: actions.filter((a) => a.priority === p).sort((a, b) => Date.parse(a.dueAt ?? '2999-01-01') - Date.parse(b.dueAt ?? '2999-01-01')) })).filter((g) => g.items.length > 0);

  return (
    <div className="stack">
      <ApiErrorNotice error={error} what="load the playbook" />
      <ApiErrorNotice error={create.error} what="draft the document" />
      {isLoading ? (
        <Card>
          <Loading />
        </Card>
      ) : actions.length === 0 ? (
        <Card>
          <EmptyState title="Nothing queued">Playbook actions appear once services are agreed: NCAF on day 1, CCTV in the first week, the payment pack when hire ends, chasers at 7 / 14 / 21 days and a complaint at day 28.</EmptyState>
        </Card>
      ) : (
        groups.map((g) => (
          <Card key={g.priority} title={<span className="row">{PRIORITY_LABEL[g.priority]} <PriorityBadge priority={g.priority} /></span>} flush>
            <ul className="list">
              {g.items.map((a) => {
                const blocked = (a.blockedBy ?? []).length > 0;
                return (
                  <li key={a.code}>
                    <div className="list-main">
                      <div className="list-title row" style={{ gap: 8 }}>
                        {a.title}
                        {blocked && (
                          <Badge tone="red" dot title={`Blocked by: ${a.blockedBy!.join(', ')}`}>
                            blocked
                          </Badge>
                        )}
                      </div>
                      <div className="small" style={{ marginTop: 2 }}>
                        {a.why}
                      </div>
                      <div className="row xs muted" style={{ gap: 10, marginTop: 4 }}>
                        {a.dueAt && (
                          <span>
                            due <DateText value={a.dueAt} time /> ({describeDue(a.dueAt, now)})
                          </span>
                        )}
                        {a.valuePence ? (
                          <span>
                            protects <Money pence={a.valuePence} showPence={false} />
                          </span>
                        ) : null}
                        <span className="mono">{a.code}</span>
                      </div>
                      {a.basis.length > 0 && (
                        <div className="stack-sm" style={{ gap: 0, marginTop: 4 }}>
                          {a.basis.map((b) => (
                            <BasisText key={b} basis={b} />
                          ))}
                        </div>
                      )}
                      {blocked && (
                        <div className="xs" style={{ marginTop: 4 }}>
                          Blocked by{' '}
                          {a.blockedBy!.map((b, i) => (
                            <span key={b}>
                              {i > 0 && ', '}
                              {/^(need|use|period|rate|impecuniosity|mitigation|enforceability|liability)$/.test(b) ? (
                                <Link to="../gates">{gateLabel(b)} gate</Link>
                              ) : (
                                <span className="mono">{b}</span>
                              )}
                            </span>
                          ))}
                          . Clear the gate, not the warning.
                        </div>
                      )}
                    </div>
                    <div className="stack-sm" style={{ alignItems: 'flex-end' }}>
                      {a.templateId ? (
                        <Button size="sm" variant="primary" disabled={blocked} title={blocked ? 'Blocked — close the gate first' : `Draft ${a.templateId}`} onClick={() => generate(a)} loading={create.isPending && create.variables?.templateId === a.templateId}>
                          Generate document
                        </Button>
                      ) : null}
                      {a.templateId && <span className="xs muted mono">{a.templateId}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        ))
      )}
      <p className="xs muted">Nothing is sent automatically: a generated document is a draft until the consistency check passes and a person approves it (Documents tab).</p>
    </div>
  );
}
