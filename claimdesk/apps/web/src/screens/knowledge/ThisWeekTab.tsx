// owned by knowledge-ui
/**
 * Knowledge ▸ This week (docs/SUPREME-KNOWLEDGE-BUILDER.md §11 tab 1): the headline, what was learned automatically
 * (badge, why, Undo), the waiting count with a link to Approve, gaps opened and filled, sources fetched and changed,
 * alarms, and the active learned version with "what changed".
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { DigestLine } from '@ccguk/domain';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { useToast } from '../../components/Toast';
import { knowledgeApi, useKnowledgeMutation, useKnowledgeStatus, useKnowledgeVersions, useKnowledgeWeek } from '../../api/knowledgeApi';
import { KnowledgeBadges, QueryGate } from './parts';
import { diffCounts, knowledgeHref, londonToday, safeLink, undoItemId, weekLearned, weekTotals, whenText } from './knowledgeView';

export function DigestLines({ lines, empty, onOpenItem, limit = 50 }: { lines: readonly DigestLine[]; empty: string; onOpenItem?: (id: string) => void; limit?: number }) {
  const toast = useToast();
  const [undone, setUndone] = useState<Record<string, boolean>>({});
  const undo = useKnowledgeMutation((line: DigestLine) => knowledgeApi.undo(line.undoRoute!));
  if (!lines.length) return <p className="muted small">{empty}</p>;
  return (
    <ul className="kn-lines">
      {lines.slice(0, limit).map((l, i) => {
        const id = undoItemId(l);
        const key = `${l.at}-${id ?? l.gapId ?? i}`;
        const link = safeLink(l.link);
        return (
          <li key={key} className="kn-line">
            <div className="row-between">
              <span>
                <span className="small muted">{whenText(l.at)}</span> {l.text} <KnowledgeBadges badges={l.badges} />
              </span>
              <span className="row kn-line-actions">
                {id && onOpenItem ? (
                  <button type="button" className="kn-link" onClick={() => onOpenItem(id)}>
                    open
                  </button>
                ) : link ? (
                  <Link to={link}>open</Link>
                ) : null}
                {l.undoRoute &&
                  (undone[key] ? (
                    <span className="small muted">undone</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={undo.isPending && undo.variables === l}
                      onClick={() =>
                        undo.mutate(l, {
                          onSuccess: () => (setUndone((u) => ({ ...u, [key]: true })), toast.success('Undone — agents stop using it')),
                          onError: (e) => toast.error((e as Error).message),
                        })
                      }
                    >
                      Undo
                    </Button>
                  ))}
              </span>
            </div>
          </li>
        );
      })}
      {lines.length > limit && <li className="small muted">and {lines.length - limit} more</li>}
    </ul>
  );
}

export function ThisWeekTab({ onOpenItem }: { onOpenItem: (id: string) => void }) {
  const week = useKnowledgeWeek(londonToday());
  const status = useKnowledgeStatus();
  const versions = useKnowledgeVersions();
  const w = week.data;
  const totals = weekTotals(w);
  const learned = weekLearned(w);
  const today = w?.days[w.days.length - 1];
  const waiting = status.data ? status.data.items.proposed : (today?.waitingForYou.count ?? 0);
  const active = versions.data?.versions.find((v) => v.active);
  return (
    <QueryGate q={week} what="This week's summary">
      {w && (
        <div className="stack">
          <Card>
            <p className="kn-headline">
              <strong>{w.headline}</strong>
            </p>
            {status.data && !status.data.learningEnabled && <div className="notice notice-warn">Learning is paused. Nothing new is learned or researched until you resume it in Safety.</div>}
            <div className="kn-stats">
              <Stat value={w.learnedAutomatically} label="Learned automatically" />
              <Stat value={waiting} label="Wait for you" link={knowledgeHref('approve')} />
              <Stat value={totals.gapsOpened} label="Gaps opened" link={knowledgeHref('gaps')} />
              <Stat value={totals.gapsFilled} label="Gaps filled" />
              <Stat value={totals.fetched} label="Source pages fetched" link={knowledgeHref('sources')} />
              <Stat value={totals.changed} label="Sources changed" />
              <Stat value={totals.alarms.length} label="Alarms" tone={totals.alarms.length ? 'red' : undefined} link={knowledgeHref('safety')} />
            </div>
          </Card>
          <div className="kn-two">
            <Card title={`Learned automatically (${learned.length})`}>
              <p className="small muted">Each line is already in use. Undo retires it at once.</p>
              <DigestLines lines={learned} empty="Nothing was learned automatically this week." onOpenItem={onOpenItem} />
            </Card>
            <div className="stack">
              <Card title={`Waiting for you (${waiting})`} actions={<Link to={knowledgeHref('approve')}>Open Approve</Link>}>
                <DigestLines lines={today?.waitingForYou.lines ?? []} empty="Nothing is waiting for you." onOpenItem={onOpenItem} limit={8} />
              </Card>
              <Card title="Learned version" actions={<Link to={knowledgeHref('versions')}>All versions</Link>}>
                {active ? (
                  <div className="stack-sm">
                    <div>
                      <strong>v{active.version}</strong> {active.label ? `· ${active.label}` : ''} <span className="small muted">({active.itemCount} items · {whenText(active.createdAt)})</span>
                    </div>
                    <div className="small">
                      What changed: <span className="mono">{diffCounts(active.diff)}</span>
                      {active.reason ? ` · ${active.reason}` : ''}
                    </div>
                    {active.diff.added.slice(0, 5).map((a) => (
                      <div key={a.id} className="small">
                        + <button type="button" className="kn-link" onClick={() => onOpenItem(a.id)}>{a.title}</button>
                      </div>
                    ))}
                    {active.diff.removed.slice(0, 5).map((a) => (
                      <div key={a.id} className="small muted">
                        − {a.title}
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="No learned version yet">The first version is published once something is learned.</EmptyState>
                )}
              </Card>
              <Card title={`Gaps (${totals.gapsOpened} opened, ${totals.gapsFilled} filled)`} actions={<Link to={knowledgeHref('gaps')}>Open Gaps</Link>}>
                <DigestLines lines={(w.days ?? []).flatMap((d) => d.gaps.lines)} empty="No gaps this week." limit={8} />
              </Card>
              <Card title={`Alarms (${totals.alarms.length})`}>
                <DigestLines lines={totals.alarms} empty="No alarms this week." limit={8} />
                <p className="small muted">
                  Research: {totals.researchRuns} runs, {totals.proposals} proposals · sources refused {totals.refused}
                </p>
              </Card>
            </div>
          </div>
        </div>
      )}
    </QueryGate>
  );
}

function Stat({ value, label, link, tone }: { value: number; label: string; link?: string; tone?: 'red' }) {
  const body = (
    <>
      <div className={`stat-value${tone ? ` ${tone}` : ''}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </>
  );
  return link ? (
    <Link className="stat kn-stat-link" to={link}>
      {body}
    </Link>
  ) : (
    <div className="stat">{body}</div>
  );
}
