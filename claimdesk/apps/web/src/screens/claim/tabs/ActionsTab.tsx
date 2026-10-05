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
import { plainText } from '../../../lib/plainText';

const ORDER: PlaybookAction['priority'][] = ['now', 'today', 'this_week', 'scheduled'];

function dueTone(dueAt: string, now: Date): 'overdue' | 'today' | 'later' {
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return 'later';
  if (due < now.getTime()) return 'overdue';
  return new Date(due).toDateString() === now.toDateString() ? 'today' : 'later';
}

/** Internal references ("(lesson g)", "BLUEPRINT §7.7") are not shown to users (0.3 §E8). */
export { plainText };

const SENTENCE_MAX = 180;

/** First sentence of an explanation, at most ~180 characters (the list shows one; the rest is in Sources). */
export function firstSentence(text: string): string {
  const t = plainText(text);
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const first = m ? m[1]! : t;
  if (first.length <= SENTENCE_MAX) return first;
  const cut = first.slice(0, SENTENCE_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 80))}…`;
}

/** 'SEND_PAYMENT_PACK' → 'Send payment pack' (blocking actions are named, not coded). */
function humaniseCode(code: string): string {
  const s = code.replace(/_/g, ' ').toLowerCase().trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : code;
}

/**
 * The get-paid-faster playbook for this claim, from the API (0.3 §E12): title, one-sentence reason, due pill, £
 * protected and "Generate document". Action codes, template ids and the legal / KB sources sit in a closed
 * "Sources (n)" disclosure that links to the knowledge base. Blocked actions say what blocks them.
 */
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
                const due = a.dueAt ? dueTone(a.dueAt, now) : null;
                const sources = a.basis.length + 1 + (a.templateId ? 1 : 0);
                const shown = firstSentence(a.why);
                const rest = plainText(a.why).slice(shown.endsWith('…') ? shown.length - 1 : shown.length).trim();
                return (
                  <li key={a.code}>
                    <div className="list-main">
                      <div className="list-title row" style={{ gap: 8 }}>
                        {plainText(a.title)}
                        {due && (
                          <Badge tone={due === 'overdue' ? 'red' : due === 'today' ? 'amber' : 'grey'} title={a.dueAt ? new Date(a.dueAt).toLocaleString('en-GB') : undefined}>
                            {describeDue(a.dueAt!, now)}
                          </Badge>
                        )}
                        {a.valuePence ? (
                          <span className="xs muted">
                            protects <Money pence={a.valuePence} showPence={false} />
                          </span>
                        ) : null}
                        {blocked && (
                          <Badge tone="red" dot>
                            blocked
                          </Badge>
                        )}
                      </div>
                      <div className="small" style={{ marginTop: 2 }}>
                        {shown}
                      </div>
                      {blocked && (
                        <div className="xs" style={{ marginTop: 4 }}>
                          Waiting for{' '}
                          {a.blockedBy!.map((b, i) => (
                            <span key={b}>
                              {i > 0 && ', '}
                              {/^(need|use|period|rate|impecuniosity|mitigation|enforceability|liability)$/.test(b) ? (
                                <Link to="../gates">{gateLabel(b)} gate</Link>
                              ) : (
                                <span>{actions.find((x) => x.code === b)?.title ?? humaniseCode(b)}</span>
                              )}
                            </span>
                          ))}
                          . Clear the gate, not the warning.
                        </div>
                      )}
                      <details className="action-sources">
                        <summary className="xs muted">Sources ({sources})</summary>
                        <div className="stack-sm xs" style={{ gap: 2, marginTop: 4 }}>
                          {rest && <div>{rest}</div>}
                          {a.dueAt && (
                            <div className="muted">
                              Due <DateText value={a.dueAt} time />
                            </div>
                          )}
                          {a.basis.map((b) => (
                            <div key={b}>
                              <BasisText basis={b} />{' '}
                              <Link to={`/kb?q=${encodeURIComponent(b)}`} className="xs">
                                look up in the knowledge base
                              </Link>
                            </div>
                          ))}
                          <div className="muted">
                            Action <span className="mono">{a.code}</span>
                            {a.templateId && (
                              <>
                                {' '}
                                · template <span className="mono">{a.templateId}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </details>
                    </div>
                    <div className="stack-sm" style={{ alignItems: 'flex-end' }}>
                      {a.templateId ? (
                        <Button size="sm" variant="primary" disabled={blocked} title={blocked ? 'Blocked — close the gate first' : undefined} onClick={() => generate(a)} loading={create.isPending && create.variables?.templateId === a.templateId}>
                          Generate document
                        </Button>
                      ) : null}
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
