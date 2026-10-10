// owned by runtime
/**
 * Daily log (docs/SUPREME-DESIGN.md §J.2, §L.4): pick a day; the headline and counts; what was sent automatically,
 * what is waiting for you, records updated, deadlines, problems and usage — each line with its link and "why" (rule
 * ids). Compiled at 18:00 London and on demand; print or export as JSON.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { Loading } from '../../components/Spinner';
import { EmptyState } from '../../components/EmptyState';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { useToast } from '../../components/Toast';
import { AGENT_LABEL, agentsApi, percent, useAgentsMutation, useDailyLog, type DailyLog, type LogLine } from '../../api/agentsApi';
import { KnowledgeDigestSection } from '../knowledge/KnowledgeDigestSection'; // knowledge-ui
import '../agents/agents.css';

export function londonToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const hhmm = (iso: string): string => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

export const COUNT_LABELS: Array<[keyof DailyLog['counts'], string]> = [
  ['emailsIn', 'Emails filed'],
  ['autoSent', 'Sent automatically'],
  ['undone', 'Undone'],
  ['emailsSent', 'Emails sent (all)'],
  ['drafts', 'Drafts prepared'],
  ['fieldsPrefilled', 'Details filled in'],
  ['needsYouOpened', 'New for you'],
  ['needsYouResolved', 'You decided'],
  ['tasksDone', 'Tasks done'],
  ['deadlinesMet', 'Deadlines met'],
  ['deadlinesAtRisk', 'Deadlines due soon / overdue'],
  ['aiRuns', 'Agent runs'],
  ['aiFailures', 'Runs that did not finish'],
  ['usagePausedMinutes', 'Minutes AI was paused'],
];

function Lines({ lines, empty }: { lines: LogLine[]; empty: string }) {
  if (!lines.length) return <p className="muted small">{empty}</p>;
  return (
    <ul className="daily-lines">
      {lines.map((l, i) => (
        <li key={`${l.link}-${i}`}>
          <div className="row-between">
            <span>
              <span className="small muted">{hhmm(l.at)}</span> {l.text}
            </span>
            <span className="small muted">{AGENT_LABEL[l.agent] ?? l.agent}</span>
          </div>
          <div className="small muted">
            {l.reference && l.claimId ? <Link to={`/claims/${encodeURIComponent(l.claimId)}`}>{l.reference}</Link> : null}
            {l.why ? `${l.reference ? ' · ' : ''}why: ${l.why}` : ''}
            {l.ruleIds?.length ? ` · rules: ${l.ruleIds.join(', ')}` : ''} · <Link to={l.link}>open</Link>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function DailyLogPage() {
  const [day, setDay] = useState(londonToday());
  const q = useDailyLog(day);
  const toast = useToast();
  const compile = useAgentsMutation((d: string) => agentsApi.compileDailyLog(d));
  const data = q.data;
  const log = data?.log;

  const exportJson = () => {
    if (!log) return;
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `claimdesk-daily-log-${log.day}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="page daily-log-page">
      <PageHeader
        title="Daily log"
        subtitle="What the agents did, what they sent and what is waiting for you."
        actions={
          <div className="row no-print">
            <input type="date" className="input" aria-label="Day" value={day} max={londonToday()} onChange={(e) => e.target.value && setDay(e.target.value)} />
            <Button onClick={() => compile.mutate(day, { onSuccess: () => (toast.success('Daily log compiled'), void q.refetch()), onError: (e) => toast.error((e as Error).message) })} loading={compile.isPending}>
              Compile now
            </Button>
            <Button variant="ghost" onClick={() => window.print()} disabled={!log}>
              Print
            </Button>
            <Button variant="ghost" onClick={exportJson} disabled={!log}>
              Export
            </Button>
          </div>
        }
      />
      {q.isLoading && <Loading />}
      {q.error && <ApiErrorNotice error={q.error} />}
      {log && (
        <div className="stack">
          <Card>
            <p className="daily-headline">
              <strong>{log.headline}</strong>
            </p>
            <p className="small muted">
              {data!.stored ? `Compiled ${hhmm(data!.compiledAt)}` : 'Not compiled yet — showing the live view'} · driver {log.sections.usage.driver}
              {log.sections.usage.fiveHourPeak !== undefined ? ` · five-hour peak ${percent(log.sections.usage.fiveHourPeak)}` : ''}
              {log.sections.usage.sevenDay !== undefined ? ` · seven-day ${percent(log.sections.usage.sevenDay)}` : ''}
              {log.sections.usage.costUsd !== undefined ? ` · API spend $${log.sections.usage.costUsd.toFixed(2)}` : ''}
            </p>
            <div className="daily-counts">
              {COUNT_LABELS.map(([k, label]) => (
                <div key={k} className="stat">
                  <div className="stat-value">{log.counts[k]}</div>
                  <div className="stat-label">{label}</div>
                </div>
              ))}
            </div>
          </Card>
          <Card title={`Sent automatically (${log.sections.sentAutomatically.length})`}>
            <Lines lines={log.sections.sentAutomatically} empty="Nothing was sent automatically." />
          </Card>
          <Card title={`Waiting for you (${log.sections.waitingForYou.length})`} actions={<Link to="/needs-you">Open Needs you</Link>}>
            <Lines lines={log.sections.waitingForYou} empty="Nothing is waiting for you." />
          </Card>
          <Card title={`Records updated (${log.sections.updatedRecords.length})`}>
            <Lines lines={log.sections.updatedRecords} empty="No records were updated by the agents." />
          </Card>
          <Card title={`Deadlines (${log.sections.deadlines.length})`}>
            <Lines lines={log.sections.deadlines} empty="No deadlines met or due." />
          </Card>
          <Card title={`Problems (${log.sections.problems.length})`}>
            <Lines lines={log.sections.problems} empty="No problems." />
          </Card>
          <KnowledgeDigestSection sections={log.sections} />
        </div>
      )}
      {!q.isLoading && !q.error && !log && <EmptyState title="No log">Nothing recorded for this day.</EmptyState>}
    </div>
  );
}
