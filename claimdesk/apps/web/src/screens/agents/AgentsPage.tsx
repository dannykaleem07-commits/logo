// owned by runtime
/**
 * Agents control room (docs/SUPREME-DESIGN.md §L.3): a card per agent (status, running job, queue depth, last runs,
 * success rate, average duration, Pause/Resume); the kill switch; the usage meter (five-hour / seven-day bars with
 * reset times, or API spend vs the daily cap); lanes busy/limit; and tabs Jobs (filter, retry, cancel), Runs (run
 * detail with the tool-call timeline, each policy decision and its rule ids) and Schedules (enable/disable, run now).
 * Deep links: /agents?run=<id>, /agents?job=<id> (the daily log links here).
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AgentName, JobStatus, JobType } from '@ccguk/domain';
import { JOB_STATUSES, JOB_TYPES } from '@ccguk/domain';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Tabs } from '../../components/Tabs';
import { Loading } from '../../components/Spinner';
import { EmptyState } from '../../components/EmptyState';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import {
  AGENT_LABEL,
  agentsApi,
  decisionTone,
  formatDuration,
  percent,
  pillTone,
  scheduleCadence,
  useAgentJob,
  useAgentJobs,
  useAgentRun,
  useAgentRuns,
  useAgentsMutation,
  useAgentsStatus,
  useSchedules,
  type AgentCard as AgentCardData,
  type AgentsStatus,
  type JobFilters,
  type RateLimitSnapshot,
} from '../../api/agentsApi';
import './agents.css';

const time = (iso: string | null | undefined): string => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—');
const hhmm = (iso: string | null | undefined): string => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—');

const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'grey' | 'blue'> = { succeeded: 'green', queued: 'blue', leased: 'blue', waiting_usage: 'amber', waiting_user: 'amber', failed: 'red', dead: 'red', cancelled: 'grey' };
const OUTCOME_TONE: Record<string, 'green' | 'amber' | 'red' | 'grey'> = { ok: 'green', usage_limited: 'amber', cancelled: 'grey' };

export function AgentsPage() {
  const status = useAgentsStatus(10_000);
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(params.get('run') ? 'runs' : params.get('job') ? 'jobs' : 'jobs');
  const runId = params.get('run') ?? undefined;
  const jobId = params.get('job') ?? undefined;
  const open = (key: 'run' | 'job', id: string | undefined) => {
    const next = new URLSearchParams(params);
    next.delete('run');
    next.delete('job');
    if (id) next.set(key, id);
    setParams(next);
  };

  return (
    <div className="page agents-page">
      <PageHeader title="Agents" subtitle="What the agents are doing, their usage, and the controls to stop or pause them." actions={status.data ? <KillSwitch status={status.data} /> : undefined} />
      {status.isLoading && <Loading />}
      {status.error && <ApiErrorNotice error={status.error} />}
      {status.data && (
        <>
          <Overview s={status.data} />
          <div className="agents-cards">
            {status.data.agents.map((a) => (
              <AgentCard key={a.name} a={a} onRun={(id) => (setTab('runs'), open('run', id))} />
            ))}
          </div>
        </>
      )}
      <Card>
        <Tabs
          ariaLabel="Agents views"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'jobs', label: 'Jobs' },
            { id: 'runs', label: 'Runs' },
            { id: 'schedules', label: 'Schedules' },
          ]}
        />
        <div className="agents-tab">
          {tab === 'jobs' && <JobsTab onOpen={(id) => open('job', id)} />}
          {tab === 'runs' && <RunsTab onOpen={(id) => open('run', id)} />}
          {tab === 'schedules' && <SchedulesTab />}
        </div>
      </Card>
      {runId && <RunDetail id={runId} onClose={() => open('run', undefined)} />}
      {jobId && <JobDetail id={jobId} onClose={() => open('job', undefined)} onRun={(id) => open('run', id)} />}
    </div>
  );
}

function KillSwitch({ status }: { status: AgentsStatus }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const m = useAgentsMutation((on: boolean) => agentsApi.killSwitch(on, on ? 'Stopped from the control room' : undefined));
  const on = status.killSwitch;
  return (
    <>
      <Button variant={on ? 'primary' : 'danger'} onClick={() => (on ? m.mutate(false, { onError: (e) => toast.error(String((e as Error).message ?? e)) }) : setConfirm(true))} loading={m.isPending}>
        {on ? 'Start agents again' : 'Stop all agents'}
      </Button>
      {confirm && (
        <Modal open title="Stop all agents?" onClose={() => setConfirm(false)} footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => m.mutate(true, { onSuccess: () => (setConfirm(false), toast.success('Agents stopped')) })} loading={m.isPending}>
              Stop all agents
            </Button>
          </>
        }>
          <p>No AI work starts and held emails stay held until you start the agents again. Incoming mail is still filed. This is recorded in the audit log.</p>
        </Modal>
      )}
    </>
  );
}

function Meter({ label, snap }: { label: string; snap: RateLimitSnapshot | null }) {
  const u = typeof snap?.utilization === 'number' ? Math.min(Math.max(snap.utilization, 0), 1) : undefined;
  const tone = snap?.status === 'rejected' ? 'red' : u !== undefined && u >= 0.8 ? 'amber' : 'green';
  return (
    <div className="meter">
      <div className="row-between small">
        <span>{label}</span>
        <span>
          {snap ? percent(u) : 'no data yet'}
          {snap?.resetsAt ? ` · resets ${hhmm(snap.resetsAt)}` : ''}
        </span>
      </div>
      <div className="meter-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={u !== undefined ? Math.round(u * 100) : undefined}>
        <span className={`meter-fill meter-${tone}`} style={{ width: `${u !== undefined ? Math.round(u * 100) : 0}%` }} />
      </div>
    </div>
  );
}

function Overview({ s }: { s: AgentsStatus }) {
  return (
    <div className="agents-overview">
      <Card title="Status">
        <div className="stack-sm">
          <div>
            <Badge tone={pillTone(s.pill.state)} dot>
              {s.pill.label}
            </Badge>
          </div>
          <div className="small muted">
            Driver: {s.driver === 'subscription_cli' ? 'Claude subscription (Claude Code)' : s.driver === 'api_key' ? 'Anthropic API key' : s.driver === 'fake' ? 'Test driver' : 'Off'} · {s.enabled ? 'agents switched on' : 'agents switched off'}
            {!s.jobsEnabled && ' · background running is off'}
          </div>
          {s.usage.pausedUntil && (
            <div className="small">
              AI paused until {hhmm(s.usage.pausedUntil)} ({s.usage.pauseReason ?? 'usage'}). Deterministic work (mail filing, clocks, the daily log) carries on.
            </div>
          )}
          {s.usage.economy && <div className="small"><Badge tone="amber">Economy mode</Badge> the seven-day allowance is running low; only important AI work starts.</div>}
          <div className="small muted">
            Queue: {s.queue.queued} waiting · {s.queue.waitingUsage} waiting for usage · {s.queue.waitingUser} waiting for you · {s.queue.dead} stopped
            {s.pausedClaims ? ` · ${s.pausedClaims} claims paused` : ''}
          </div>
          {s.heartbeat?.registryProblems.length ? <div className="small" role="alert">Setup problem: {s.heartbeat.registryProblems.join('; ')}</div> : null}
        </div>
      </Card>
      <Card title="Usage">
        {s.driver === 'api_key' ? (
          <div className="meter">
            <div className="row-between small">
              <span>API spend today</span>
              <span>
                ${s.usage.costTodayUsd.toFixed(2)} of ${s.usage.dailyUsdCap.toFixed(2)}
              </span>
            </div>
            <div className="meter-bar">
              <span className={`meter-fill meter-${s.usage.costTodayUsd >= s.usage.dailyUsdCap ? 'red' : 'green'}`} style={{ width: `${Math.min(100, s.usage.dailyUsdCap ? Math.round((s.usage.costTodayUsd / s.usage.dailyUsdCap) * 100) : 0)}%` }} />
            </div>
          </div>
        ) : (
          <>
            <Meter label="Five-hour window" snap={s.usage.fiveHour} />
            <Meter label="Seven-day window" snap={s.usage.sevenDay} />
            <div className="small muted">{s.usage.reservePercent} % of the five-hour window is left for your own Claude use.</div>
          </>
        )}
      </Card>
      <Card title="Lanes">
        <table className="table ag-lanes">
          <tbody>
            {(['ai', 'io', 'cpu'] as const).map((l) => (
              <tr key={l}>
                <th scope="row">{l === 'ai' ? 'AI' : l === 'io' ? 'Mail, files & notifications' : 'Processing'}</th>
                <td>
                  {s.lanes[l].busy} / {s.lanes[l].limit} busy
                </td>
                <td className="ag-lane-state">
                  {s.lanes[l].open ? (
                    <Badge tone="green">open</Badge>
                  ) : (
                    <Badge tone="amber" title={s.lanes[l].reason ?? undefined}>
                      {laneReasonLabel(s.lanes[l].reason)}
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/** A closed lane's gate reason in plain words ("paused:usage_limited:five_hour" → "Paused — usage limit"). */
export function laneReasonLabel(reason: string | null | undefined): string {
  const r = reason ?? '';
  if (!r) return 'Closed';
  if (r === 'kill_switch') return 'Stopped';
  if (r === 'agents_off') return 'Agents off';
  if (/^paused:auth/.test(r)) return 'Paused — sign-in needed';
  if (/daily_cap/.test(r)) return 'Paused — daily limit';
  if (/^paused:usage|_rejected$/.test(r)) return 'Paused — usage limit';
  if (r.startsWith('paused')) return 'Paused';
  if (/^(five_hour|seven_day)/.test(r)) return 'Urgent work only — usage';
  return r.replace(/[_:]+/g, ' ');
}

function AgentCard({ a, onRun }: { a: AgentCardData; onRun: (id: string) => void }) {
  const toast = useToast();
  const pause = useAgentsMutation((name: AgentName) => agentsApi.pauseAgent(name, 'Paused from the control room'));
  const resume = useAgentsMutation((name: AgentName) => agentsApi.resumeAgent(name));
  const running = a.running[0];
  return (
    <Card
      title={AGENT_LABEL[a.name] ?? a.name}
      actions={
        a.paused ? (
          <Button size="sm" variant="primary" loading={resume.isPending} onClick={() => resume.mutate(a.name, { onError: (e) => toast.error((e as Error).message) })}>
            Resume
          </Button>
        ) : (
          <Button size="sm" loading={pause.isPending} onClick={() => pause.mutate(a.name, { onError: (e) => toast.error((e as Error).message) })}>
            Pause
          </Button>
        )
      }
    >
      <div className="stack-sm small">
        <div>
          {a.paused ? <Badge tone="amber">Paused</Badge> : running ? <Badge tone="blue">Working</Badge> : <Badge tone="grey">Idle</Badge>}
          {a.cap !== null && <span className="muted"> · up to {a.cap} at once</span>}
        </div>
        {running && (
          <div>
            {running.type}
            {running.claimId ? (
              <>
                {' '}
                on <Link to={`/claims/${encodeURIComponent(running.claimId)}`}>claim</Link>
              </>
            ) : null}{' '}
            · {formatDuration(running.elapsedMs)}
          </div>
        )}
        <div className="muted">
          {a.queued} queued{a.waitingForYou ? ` · ${a.waitingForYou} waiting for you` : ''}
        </div>
        <div className="muted">
          Success {a.successRate === null ? '—' : `${Math.round(a.successRate * 100)} %`} · average {formatDuration(a.avgDurationMs)}
        </div>
        {a.lastRuns.length > 0 && (
          <div className="run-dots" aria-label="Last runs">
            {a.lastRuns.map((r) => (
              <button key={r.id} type="button" className={`run-dot run-dot-${r.outcome ? (OUTCOME_TONE[r.outcome] ?? 'red') : 'blue'}`} title={`${r.jobType} · ${r.outcome ?? 'running'} · ${time(r.startedAt)}`} onClick={() => onRun(r.id)} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function JobsTab({ onOpen }: { onOpen: (id: string) => void }) {
  const [f, setF] = useState<JobFilters>({ status: '', type: '', claimId: '' });
  const jobs = useAgentJobs(f);
  const toast = useToast();
  const retry = useAgentsMutation((id: string) => agentsApi.retryJob(id));
  const cancel = useAgentsMutation((id: string) => agentsApi.cancelJob(id));
  return (
    <div className="stack">
      <div className="row agents-filters">
        <select className="select" aria-label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as JobStatus | '' })}>
          <option value="">Any status</option>
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as JobType | '' })}>
          <option value="">Any type</option>
          {JOB_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input className="input" aria-label="Claim id" placeholder="Claim id" value={f.claimId} onChange={(e) => setF({ ...f, claimId: e.target.value.trim() })} />
      </div>
      {jobs.isLoading && <Loading />}
      {jobs.error && <ApiErrorNotice error={jobs.error} />}
      {jobs.data && (
        <div className="table-wrap">
          <table className="table table-hover">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Agent</th>
                <th scope="col">Attempts</th>
                <th scope="col">Next / finished</th>
                <th scope="col">Error</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {jobs.data.items.length === 0 && (
                <tr>
                  <td colSpan={7} className="table-empty">
                    No jobs match.
                  </td>
                </tr>
              )}
              {jobs.data.items.map((j) => (
                <tr key={j.id}>
                  <td>
                    <button type="button" className="linklike" onClick={() => onOpen(j.id)}>
                      {j.type}
                    </button>
                    {j.depth > 0 && <span className="small muted"> · step {j.depth + 1}</span>}
                  </td>
                  <td>
                    <Badge tone={STATUS_TONE[j.status] ?? 'grey'}>{j.status.replace('_', ' ')}</Badge>
                  </td>
                  <td>{AGENT_LABEL[j.agent] ?? j.agent}</td>
                  <td>
                    {j.attempts}/{j.maxAttempts}
                  </td>
                  <td className="small">{j.finishedAt ? time(j.finishedAt) : time(j.runAfter)}</td>
                  <td className="small agents-error ag-err" title={j.error ?? undefined}>
                    {j.error ?? ''}
                  </td>
                  <td className="row">
                    {['failed', 'dead', 'cancelled', 'waiting_usage', 'waiting_user'].includes(j.status) && (
                      <Button size="sm" onClick={() => retry.mutate(j.id, { onSuccess: () => toast.success('Queued again'), onError: (e) => toast.error((e as Error).message) })}>
                        Retry
                      </Button>
                    )}
                    {['queued', 'waiting_usage', 'waiting_user'].includes(j.status) && (
                      <Button size="sm" variant="ghost" onClick={() => cancel.mutate(j.id, { onSuccess: () => toast.success('Cancelled'), onError: (e) => toast.error((e as Error).message) })}>
                        Cancel
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="small muted">
            {jobs.data.items.length} of {jobs.data.total}
          </div>
        </div>
      )}
    </div>
  );
}

function RunsTab({ onOpen }: { onOpen: (id: string) => void }) {
  const [agent, setAgent] = useState<AgentName | ''>('');
  const runs = useAgentRuns(agent);
  return (
    <div className="stack">
      <div className="row agents-filters">
        <select className="select" aria-label="Agent" value={agent} onChange={(e) => setAgent(e.target.value as AgentName | '')}>
          <option value="">All agents</option>
          {(['intake', 'mail', 'case_manager', 'drafter', 'reviewer', 'researcher', 'supervisor'] as AgentName[]).map((a) => (
            <option key={a} value={a}>
              {AGENT_LABEL[a]}
            </option>
          ))}
        </select>
      </div>
      {runs.isLoading && <Loading />}
      {runs.error && <ApiErrorNotice error={runs.error} />}
      {runs.data && (
        <div className="table-wrap">
          <table className="table table-hover table-clickable">
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">Agent</th>
                <th scope="col">Job</th>
                <th scope="col">Outcome</th>
                <th scope="col">Model</th>
                <th scope="col">Tools</th>
                <th scope="col">Tokens in/out</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.items.length === 0 && (
                <tr>
                  <td colSpan={7} className="table-empty">
                    No runs yet.
                  </td>
                </tr>
              )}
              {runs.data.items.map((r) => (
                <tr key={r.id} onClick={() => onOpen(r.id)}>
                  <td>{time(r.startedAt)}</td>
                  <td>{AGENT_LABEL[r.agent] ?? r.agent}</td>
                  <td>{r.jobType}</td>
                  <td>{r.outcome ? <Badge tone={OUTCOME_TONE[r.outcome] ?? 'red'}>{r.outcome}</Badge> : <Badge tone="blue">running</Badge>}</td>
                  <td className="small">
                    {r.model} · {r.effort}
                  </td>
                  <td>{r.toolCalls}</td>
                  <td className="small">
                    {r.inputTokens ?? '—'} / {r.outputTokens ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SchedulesTab() {
  const schedules = useSchedules();
  const toast = useToast();
  const toggle = useAgentsMutation(({ id, enabled }: { id: string; enabled: boolean }) => agentsApi.patchSchedule(id, { enabled }));
  const runNow = useAgentsMutation((id: string) => agentsApi.runScheduleNow(id));
  if (schedules.isLoading) return <Loading />;
  if (schedules.error) return <ApiErrorNotice error={schedules.error} />;
  const items = schedules.data?.items ?? [];
  if (!items.length) return <EmptyState title="No schedules yet">They are created when background running starts.</EmptyState>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Job</th>
            <th scope="col">When (London time)</th>
            <th scope="col">Next</th>
            <th scope="col">Last</th>
            <th scope="col">On</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id}>
              <td>{s.id}</td>
              <td>{scheduleCadence(s)}</td>
              <td className="small">{s.enabled ? time(s.nextRunAt) : '—'}</td>
              <td className="small">{time(s.lastRunAt)}</td>
              <td>
                <input type="checkbox" aria-label={`Enable ${s.id}`} checked={s.enabled} onChange={(e) => toggle.mutate({ id: s.id, enabled: e.target.checked }, { onError: (err) => toast.error((err as Error).message) })} />
              </td>
              <td>
                <Button size="sm" onClick={() => runNow.mutate(s.id, { onSuccess: () => toast.success(`${s.id} queued`), onError: (e) => toast.error((e as Error).message) })}>
                  Run now
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const run = useAgentRun(id);
  const r = run.data?.run;
  return (
    <Modal open title="Agent run" onClose={onClose} size="lg">
      {run.isLoading && <Loading />}
      {run.error && <ApiErrorNotice error={run.error} />}
      {r && (
        <div className="stack">
          <div className="kv small">
            <div>
              <span className="muted">Agent</span> {AGENT_LABEL[r.agent] ?? r.agent} · {r.jobType}
            </div>
            <div>
              <span className="muted">Model</span> {r.model} · effort {r.effort} · driver {r.driver}
            </div>
            <div>
              <span className="muted">Prompt version</span> <code>{r.promptVersion.slice(0, 16)}</code>
            </div>
            <div>
              <span className="muted">Time</span> {time(r.startedAt)} → {time(r.endedAt)} · {r.numTurns ?? '—'} turns
            </div>
            <div>
              <span className="muted">Tokens</span> in {r.inputTokens ?? '—'} · out {r.outputTokens ?? '—'} · cache read {r.cacheReadTokens ?? '—'} · cache write {r.cacheWriteTokens ?? '—'}
              {typeof r.costUsd === 'number' ? ` · $${r.costUsd.toFixed(4)}` : ''}
            </div>
            <div>
              <span className="muted">Outcome</span> {r.outcome ? <Badge tone={OUTCOME_TONE[r.outcome] ?? 'red'}>{r.outcome}</Badge> : 'running'}
              {r.error ? ` — ${r.error}` : ''}
            </div>
            {r.claimId && (
              <div>
                <Link to={`/claims/${encodeURIComponent(r.claimId)}`}>Open the claim</Link>
              </div>
            )}
          </div>
          <h4>Tool calls</h4>
          {run.data!.toolCalls.length === 0 ? (
            <p className="muted small">No tool calls.</p>
          ) : (
            <ol className="timeline">
              {run.data!.toolCalls.map((c) => (
                <li key={c.id} className="timeline-item">
                  <div className="row-between">
                    <span>
                      <strong>{c.tool}</strong> <span className="small muted">({c.actionClass})</span>
                    </span>
                    <Badge tone={decisionTone(c.decision)}>{c.decision}</Badge>
                  </div>
                  <div className="small muted">
                    {time(c.at)}
                    {typeof c.durationMs === 'number' ? ` · ${formatDuration(c.durationMs)}` : ''}
                    {c.httpStatus ? ` · HTTP ${c.httpStatus}` : ''}
                    {c.ruleIds?.length ? ` · rules: ${c.ruleIds.join(', ')}` : ''}
                    {c.needsYouId ? (
                      <>
                        {' · '}
                        <Link to={`/needs-you/${encodeURIComponent(c.needsYouId)}`}>Needs you</Link>
                      </>
                    ) : null}
                  </div>
                  {c.outputSummary && <div className="small">{c.outputSummary}</div>}
                  {c.inputRedacted !== undefined && (
                    <details className="small">
                      <summary>Input (redacted)</summary>
                      <pre>{JSON.stringify(c.inputRedacted, null, 2)}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ol>
          )}
          {r.result !== undefined && (
            <details className="small">
              <summary>Result (redacted)</summary>
              <pre>{JSON.stringify(r.result, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </Modal>
  );
}

function JobDetail({ id, onClose, onRun }: { id: string; onClose: () => void; onRun: (id: string) => void }) {
  const job = useAgentJob(id);
  const j = job.data?.job;
  return (
    <Modal open title="Agent job" onClose={onClose} size="lg">
      {job.isLoading && <Loading />}
      {job.error && <ApiErrorNotice error={job.error} />}
      {j && (
        <div className="stack small">
          <div className="kv">
            <div>
              <span className="muted">Type</span> {j.type} · {AGENT_LABEL[j.agent] ?? j.agent} · lane {j.lane} · priority {j.priority}
            </div>
            <div>
              <span className="muted">Status</span> <Badge tone={STATUS_TONE[j.status] ?? 'grey'}>{j.status}</Badge> · attempts {j.attempts}/{j.maxAttempts}
            </div>
            <div>
              <span className="muted">Created</span> {time(j.createdAt)} by {j.createdBy} · chain step {j.depth + 1}
            </div>
            {j.error && (
              <div>
                <span className="muted">Error</span> {j.error}
              </div>
            )}
            {j.needsYouId && (
              <div>
                <Link to={`/needs-you/${encodeURIComponent(j.needsYouId)}`}>Waiting for you</Link>
              </div>
            )}
          </div>
          <h4>Attempts</h4>
          <ul>
            {job.data!.attempts.map((a) => (
              <li key={a.id}>
                #{a.attempt} {time(a.startedAt)} — {a.outcome}
                {a.error ? `: ${a.error}` : ''}
                {a.runId && (
                  <>
                    {' '}
                    <button type="button" className="linklike" onClick={() => onRun(a.runId!)}>
                      run
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {job.data!.children.length > 0 && (
            <>
              <h4>Follow-ups</h4>
              <ul>
                {job.data!.children.map((c) => (
                  <li key={c.id}>
                    {c.type} — {c.status}
                  </li>
                ))}
              </ul>
            </>
          )}
          <details>
            <summary>Payload</summary>
            <pre>{JSON.stringify(j.payload, null, 2)}</pre>
          </details>
        </div>
      )}
    </Modal>
  );
}
