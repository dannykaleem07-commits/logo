// owned by knowledge-ui
/**
 * Knowledge ▸ Gaps (docs/SUPREME-KNOWLEDGE-BUILDER.md §11 tab 3): what the agents could not find. The list shows the
 * question, kind, origin, blocking claims, status and attempts; the detail shows the research timeline (runs, searches,
 * fetched sources, proposals). Research now · I know the answer (saved as knowledge you confirmed) · Dismiss.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { GapKind, GapStatus, KnowledgeGapView, KnowledgeScope } from '@ccguk/domain';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Select, TextArea, TextInput, Checkbox } from '../../components/Form';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { useToast } from '../../components/Toast';
import { knowledgeApi, useKnowledgeGap, useKnowledgeGaps, useKnowledgeMutation } from '../../api/knowledgeApi';
import { KnowledgeBadges, QueryGate, ReasonForm } from './parts';
import { GAP_KINDS_FOR_FORM, GAP_KIND_LABEL, GAP_STATUS_LABEL, GAP_STATUS_TONE, actorText, gapAnswerItem, humanise, scopeLabel, whenText } from './knowledgeView';

const OPEN_STATUSES: GapStatus[] = ['open', 'researching', 'answered_pending', 'needs_owner'];

export function GapsTab({ gapId, onGap, onOpenItem }: { gapId: string | undefined; onGap: (id: string | undefined) => void; onOpenItem: (id: string) => void }) {
  const [status, setStatus] = useState<GapStatus | ''>('');
  const [kind, setKind] = useState<GapKind | ''>('');
  const [raising, setRaising] = useState(false);
  const q = useKnowledgeGaps(status, kind);
  const gaps = q.data?.gaps ?? [];
  const shown = status ? gaps : [...gaps].sort((a, b) => Number(OPEN_STATUSES.includes(b.status)) - Number(OPEN_STATUSES.includes(a.status)));
  return (
    <div className="stack">
      <div className="row kn-filters">
        <select className="select" aria-label="Gap status" value={status} onChange={(e) => setStatus(e.target.value as GapStatus | '')}>
          <option value="">All statuses</option>
          {(Object.keys(GAP_STATUS_LABEL) as GapStatus[]).map((s) => (
            <option key={s} value={s}>
              {GAP_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Gap kind" value={kind} onChange={(e) => setKind(e.target.value as GapKind | '')}>
          <option value="">All kinds</option>
          {(Object.keys(GAP_KIND_LABEL) as GapKind[]).map((k) => (
            <option key={k} value={k}>
              {GAP_KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <Button onClick={() => setRaising((v) => !v)}>{raising ? 'Close' : 'Ask a question'}</Button>
      </div>
      {raising && <RaiseGapForm onDone={() => setRaising(false)} />}
      <div className={gapId ? 'kn-split' : undefined}>
        <QueryGate q={q} what="Gaps">
          {shown.length ? (
            <div className="table-wrap card">
              <table className="table" aria-label="Knowledge gaps">
                <thead>
                  <tr>
                    <th scope="col">Question</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Origin</th>
                    <th scope="col">Claims</th>
                    <th scope="col">Status</th>
                    <th scope="col">Attempts</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((g) => (
                    <tr key={g.id} className={g.id === gapId ? 'kn-row-selected' : undefined}>
                      <td>
                        <button type="button" className="kn-link" onClick={() => onGap(g.id)}>
                          {g.question}
                        </button>
                        {g.blocking && (
                          <>
                            {' '}
                            <Badge tone="amber">blocking</Badge>
                          </>
                        )}
                      </td>
                      <td>{GAP_KIND_LABEL[g.kind] ?? g.kind}</td>
                      <td className="small">{humanise(g.origin)}</td>
                      <td>{g.claimIds.length}</td>
                      <td>
                        <Badge tone={GAP_STATUS_TONE[g.status] ?? 'grey'}>{GAP_STATUS_LABEL[g.status] ?? g.status}</Badge>
                      </td>
                      <td>{g.attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No gaps">When an agent cannot find something it needs, it records the question here and the researcher looks for an official answer.</EmptyState>
          )}
        </QueryGate>
        {gapId && <GapDetail id={gapId} onClose={() => onGap(undefined)} onOpenItem={onOpenItem} />}
      </div>
    </div>
  );
}

function RaiseGapForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<GapKind | ''>('insurer_process');
  const [question, setQuestion] = useState('');
  const [insurer, setInsurer] = useState('');
  const [blocking, setBlocking] = useState(false);
  const add = useKnowledgeMutation(() => {
    const scope: KnowledgeScope = insurer.trim() ? { kind: 'insurer', slug: insurer.trim().toLowerCase() } : { kind: 'global' };
    return knowledgeApi.addGap({ kind: (kind || 'other') as GapKind, question: question.trim(), scope, blocking });
  });
  return (
    <Card title="Ask the researcher a question">
      <div className="kn-form">
        <div className="grid-2">
          <Select label="Kind" value={kind} onChange={setKind} options={GAP_KINDS_FOR_FORM} />
          <TextInput label="Insurer (optional, directory name such as aviva)" value={insurer} onChange={setInsurer} />
        </div>
        <TextArea label="Question" value={question} onChange={setQuestion} rows={2} hint="No names, registrations or references: research never sends claim details out." />
        <Checkbox label="It blocks a claim" checked={blocking} onChange={setBlocking} />
        <div className="row">
          <Button variant="primary" disabled={question.trim().length < 8} loading={add.isPending} onClick={() => add.mutate(undefined, { onSuccess: () => (toast.success('Question recorded'), onDone()), onError: (e) => toast.error((e as Error).message) })}>
            Record the question
          </Button>
        </div>
        <ApiErrorNotice error={add.error} what="record the question" />
      </div>
    </Card>
  );
}

function GapDetail({ id, onClose, onOpenItem }: { id: string; onClose: () => void; onOpenItem: (id: string) => void }) {
  const q = useKnowledgeGap(id);
  const toast = useToast();
  const [mode, setMode] = useState<'none' | 'answer' | 'dismiss'>('none');
  const [answer, setAnswer] = useState('');
  const [title, setTitle] = useState('');
  const research = useKnowledgeMutation(() => knowledgeApi.researchNow(id));
  const dismiss = useKnowledgeMutation((reason: string) => knowledgeApi.dismissGap(id, reason));
  const answerIt = useKnowledgeMutation((g: KnowledgeGapView) => {
    const shaped = gapAnswerItem(g, answer.trim(), title);
    return knowledgeApi.addItem({ ...shaped, data: shaped.data as never, gapId: g.id, tags: [`gap:${g.gapKey}`], note: 'answered a knowledge gap' });
  });
  const d = q.data;
  const g = d?.gap;
  const open = g ? OPEN_STATUSES.includes(g.status) : false;
  return (
    <Card title="Gap" actions={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}>
      <QueryGate q={q} what="This gap">
        {g && d && (
          <div className="stack">
            <div>
              <strong>{g.question}</strong>
              <div className="small muted">
                {GAP_KIND_LABEL[g.kind]} · {scopeLabel(g.scope)} · raised by {actorText(g.raisedBy)} {whenText(g.createdAt)} · seen {g.occurrences} time{g.occurrences === 1 ? '' : 's'} · {g.attempts} attempt{g.attempts === 1 ? '' : 's'}
                {g.nextAttemptAt ? ` · next try ${whenText(g.nextAttemptAt)}` : ''}
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                <Badge tone={GAP_STATUS_TONE[g.status] ?? 'grey'}>{GAP_STATUS_LABEL[g.status] ?? g.status}</Badge>
                {g.blocking && <Badge tone="amber">blocking</Badge>}
                {g.claimIds.slice(0, 5).map((c) => (
                  <Link key={c} className="small" to={`/claims/${encodeURIComponent(c)}`}>
                    claim
                  </Link>
                ))}
              </div>
            </div>
            {d.ownerQuestion && <div className="notice notice-info">The researcher asks: {d.ownerQuestion}</div>}
            {d.lastSummary && <p className="small">{d.lastSummary}</p>}
            {g.closeNote && <p className="small muted">{g.closeNote}</p>}

            {open && mode === 'none' && (
              <div className="row">
                <Button variant="primary" onClick={() => setMode('answer')}>
                  I know the answer
                </Button>
                <Button loading={research.isPending} onClick={() => research.mutate(undefined, { onSuccess: () => toast.success('Research queued'), onError: (e) => toast.error((e as Error).message) })}>
                  Research now
                </Button>
                <Button variant="ghost" onClick={() => setMode('dismiss')}>
                  Dismiss
                </Button>
              </div>
            )}
            {mode === 'answer' && (
              <div className="kn-form">
                <TextInput label="Title (optional)" value={title} onChange={setTitle} />
                <TextArea label="Your answer" value={answer} onChange={setAnswer} rows={4} hint={g.kind === 'insurer_process' || g.kind === 'procedure' ? 'One step per line.' : 'Saved as knowledge you confirmed.'} autoFocus />
                <div className="row">
                  <Button variant="primary" disabled={answer.trim().length < 3} loading={answerIt.isPending} onClick={() => answerIt.mutate(g, { onSuccess: () => (toast.success('Saved as knowledge you confirmed'), setMode('none'), setAnswer('')), onError: (e) => toast.error((e as Error).message) })}>
                    Save the answer
                  </Button>
                  <Button variant="ghost" onClick={() => setMode('none')}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {mode === 'dismiss' && <ReasonForm label="Why dismiss it?" action="Dismiss" danger={false} busy={dismiss.isPending} onCancel={() => setMode('none')} onSubmit={(r) => dismiss.mutate(r, { onSuccess: () => (toast.success('Dismissed'), setMode('none')), onError: (e) => toast.error((e as Error).message) })} />}
            <ApiErrorNotice error={research.error ?? dismiss.error ?? answerIt.error} what="change this gap" />

            {d.answers.length > 0 && (
              <section>
                <h4 className="kn-h">Answers</h4>
                <ul className="kn-lines">
                  {d.answers.map((a) => (
                    <li key={a.id}>
                      <button type="button" className="kn-link" onClick={() => onOpenItem(a.id)}>
                        {a.title}
                      </button>{' '}
                      <KnowledgeBadges badges={a.badges} supportN={a.supportN} /> <span className="small muted">{a.status}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section>
              <h4 className="kn-h">Research timeline</h4>
              <ul className="kn-timeline">
                {timeline(d).map((t, i) => (
                  <li key={i}>
                    <span className="small muted">{whenText(t.at)}</span> {t.text}
                  </li>
                ))}
                {!timeline(d).length && <li className="small muted">Nothing yet.</li>}
              </ul>
            </section>
          </div>
        )}
      </QueryGate>
    </Card>
  );
}

function timeline(d: NonNullable<ReturnType<typeof useKnowledgeGap>['data']>): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  for (const c of d.changes) out.push({ at: c.at, text: `${humanise(c.action.replace(/^knowledge\./, ''))} by ${actorText(c.actor)}${c.reason ? ` — ${c.reason}` : ''}` });
  for (const r of d.runs) out.push({ at: r.startedAt, text: `Research run (${humanise(r.jobType)}) ${r.outcome ? humanise(r.outcome) : 'running'}` });
  for (const s of d.snapshots) out.push({ at: s.fetchedAt, text: `Fetched ${s.title ?? s.url} (${s.domain}${s.changed ? ', changed' : ''})` });
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
