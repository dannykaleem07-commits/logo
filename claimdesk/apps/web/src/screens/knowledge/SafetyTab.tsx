// owned by knowledge-ui
/**
 * Knowledge ▸ Safety (docs/SUPREME-KNOWLEDGE-BUILDER.md §11 tab 8, §9.2, §12.3): the switches (learning, use learned
 * knowledge, research, source fetching, web research — off, with the honest notice), the auto-apply toggles (the
 * always-queue categories shown disabled with the reason), thresholds, budgets, replay and drift settings, replay runs,
 * alarms, and the audit log of knowledge changes (filter, CSV export). Every change is human-only and audited.
 */
import { useEffect, useState } from 'react';
import type { KnowledgeSettings, KnowledgeSettingsPatch } from '@ccguk/domain';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Form';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { useToast } from '../../components/Toast';
import { isNotBuilt, knowledgeApi, useEvalRuns, useKnowledgeAlarms, useKnowledgeChanges, useKnowledgeMutation, useKnowledgeSettings, type ChangesQuery } from '../../api/knowledgeApi';
import { NotBuilt, QueryGate } from './parts';
import { ALWAYS_QUEUE, AUTO_APPLY_LABEL, NUMBER_SETTINGS, actorText, changesCsv, humanise, readNumberSetting, whenText, type NumberSetting } from './knowledgeView';

export const WEB_RESEARCH_NOTICE = [
  'The pages are fetched from this PC’s own internet connection (its IP address).',
  'Pages are summarised by Claude Code’s fetch model, so a web run can only find links; every quote is still checked against a copy ClaimDesk stores itself.',
  'Each run uses your Claude subscription usage.',
];

export function SafetyTab({ alarmId }: { alarmId?: string }) {
  const q = useKnowledgeSettings();
  const toast = useToast();
  const patch = useKnowledgeMutation((p: KnowledgeSettingsPatch) => knowledgeApi.patchSettings(p));
  const pause = useKnowledgeMutation((on: boolean) => (on ? knowledgeApi.resumeLearning() : knowledgeApi.pauseLearning('paused from Knowledge ▸ Safety')));
  const [webAck, setWebAck] = useState(false);
  const save = (p: KnowledgeSettingsPatch, msg = 'Saved') => patch.mutate(p, { onSuccess: () => toast.success(msg), onError: (e) => toast.error((e as Error).message) });
  const s = q.data;
  return (
    <QueryGate q={q} what="Knowledge settings">
      {s && (
        <div className="stack">
          <Card title="Switches">
            <div className="stack-sm">
              <Toggle
                label="Learning"
                hint="Off stops every learner and all research at once. Gap reports are still recorded."
                checked={s.learningEnabled}
                busy={pause.isPending}
                onChange={(on) => pause.mutate(on, { onSuccess: () => toast.success(on ? 'Learning resumed' : 'Learning paused'), onError: (e) => toast.error((e as Error).message) })}
              />
              <Toggle label="Use learned knowledge" hint="Off: agents use the knowledge base, packs and approved memory only." checked={s.useLearnedKnowledge} busy={patch.isPending} onChange={(v) => save({ useLearnedKnowledge: v })} />
              <Toggle label="Research" hint="The researcher looks for official answers to gaps (no web browsing)." checked={s.researchEnabled} busy={patch.isPending} onChange={(v) => save({ researchEnabled: v })} />
              <Toggle label="Source fetching" hint="Code fetches pages from the allowed sources only." checked={s.sourceFetchEnabled} busy={patch.isPending} onChange={(v) => save({ sourceFetchEnabled: v })} />
              <div className="kn-web">
                <Toggle label="Web research" hint="Off by default." checked={s.webResearchEnabled} busy={patch.isPending} disabled={!s.webResearchEnabled && !webAck} onChange={(v) => save(v ? { webResearchEnabled: true, acknowledge: true } : { webResearchEnabled: false }, v ? 'Web research switched on' : 'Web research switched off')} />
                {!s.webResearchEnabled && (
                  <div className="notice notice-info">
                    <strong>Before you switch it on:</strong>
                    <ul>
                      {WEB_RESEARCH_NOTICE.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                    <Checkbox label="I have read this" checked={webAck} onChange={setWebAck} />
                  </div>
                )}
              </div>
            </div>
            <ApiErrorNotice error={patch.error ?? pause.error} what="change the settings" />
          </Card>

          <div className="kn-two">
            <Card title="Applied automatically">
              <p className="small muted">These go live without asking, are listed in the daily log with Undo, and can each be switched off.</p>
              <div className="stack-sm">
                {(Object.keys(AUTO_APPLY_LABEL) as (keyof KnowledgeSettings['autoApply'])[]).map((k) => (
                  <Toggle key={k} label={AUTO_APPLY_LABEL[k]} checked={s.autoApply[k]} busy={patch.isPending} onChange={(v) => save({ autoApply: { [k]: v } })} />
                ))}
              </div>
              <h4 className="kn-h">Always wait for you</h4>
              <div className="stack-sm">
                {ALWAYS_QUEUE.map((a) => (
                  <label key={a.label} className="check kn-disabled">
                    <input type="checkbox" checked={false} disabled aria-label={a.label} readOnly />
                    <span>
                      {a.label}
                      <span className="small muted"> — {a.reason}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Card>
            <Card title="Limits">
              <NumberRows settings={s} busy={patch.isPending} onSave={(p) => save(p)} />
              <div className="stack-sm" style={{ marginTop: 12 }}>
                <Toggle label="Replay new rules against past claims before they wait for you" checked={s.replay.gateRules} busy={patch.isPending} onChange={(v) => save({ replay: { gateRules: v } })} />
                <Toggle label="Weekly replay with drafted letters (uses AI)" checked={s.replay.draftsEnabled} busy={patch.isPending} onChange={(v) => save({ replay: { draftsEnabled: v } })} />
                <Toggle label="Quarantine automatically on a safety-related drift alarm" checked={s.drift.autoQuarantineOnPerimeter} busy={patch.isPending} onChange={(v) => save({ drift: { autoQuarantineOnPerimeter: v } })} />
              </div>
            </Card>
          </div>
          <AlarmsCard focusId={alarmId} />
          <ReplayRunsCard />
          <AuditCard />
        </div>
      )}
    </QueryGate>
  );
}

function Toggle({ label, hint, checked, onChange, busy, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; busy?: boolean; disabled?: boolean }) {
  return (
    <label className={`check kn-toggle${disabled ? ' kn-disabled' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={busy || disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span>
        <strong>{label}</strong> <Badge tone={checked ? 'green' : 'grey'}>{checked ? 'on' : 'off'}</Badge>
        {hint && <span className="small muted kn-hint">{hint}</span>}
      </span>
    </label>
  );
}

function NumberRows({ settings, onSave, busy }: { settings: KnowledgeSettings; onSave: (p: KnowledgeSettingsPatch) => void; busy: boolean }) {
  const initial = () => Object.fromEntries([...NUMBER_SETTINGS.map((n) => [`${n.group}.${n.key}`, String(readNumberSetting(settings, n))]), ['needsYouPerDay', String(settings.needsYouPerDay)]]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  useEffect(() => setValues(initial()), [settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const row = (id: string, label: string, n?: NumberSetting) => {
    const current = n ? String(readNumberSetting(settings, n)) : String(settings.needsYouPerDay);
    const v = values[id] ?? current;
    const changed = v !== current && v.trim() !== '' && Number.isFinite(Number(v));
    return (
      <tr key={id}>
        <th scope="row" className="small">
          {label}
        </th>
        <td>
          <input className="input kn-num" type="number" aria-label={label} step={n?.step ?? 1} min={n?.min ?? 0} max={n?.max} value={v} onChange={(e) => setValues((x) => ({ ...x, [id]: e.target.value }))} />
        </td>
        <td>
          {changed && (
            <Button size="sm" loading={busy} onClick={() => onSave(n ? ({ [n.group]: { [n.key]: Number(v) } } as KnowledgeSettingsPatch) : { needsYouPerDay: Number(v) })}>
              Save
            </Button>
          )}
        </td>
      </tr>
    );
  };
  return (
    <div className="table-wrap">
      <table className="table kn-data kn-limits" aria-label="Limits">
        <tbody>
          {row('needsYouPerDay', 'New knowledge cards in Needs-you a day')}
          {NUMBER_SETTINGS.map((n) => row(`${n.group}.${n.key}`, n.label, n))}
        </tbody>
      </table>
    </div>
  );
}

function AlarmsCard({ focusId }: { focusId?: string }) {
  const q = useKnowledgeAlarms('all');
  const toast = useToast();
  const ack = useKnowledgeMutation((id: string) => knowledgeApi.ackAlarm(id));
  const alarms = q.data?.alarms ?? [];
  return (
    <Card title={`Alarms (${alarms.filter((a) => a.status === 'open').length} open)`}>
      {q.error && isNotBuilt(q.error) ? (
        <NotBuilt what="Drift alarms" />
      ) : (
        <QueryGate q={q} what="Alarms">
          {alarms.length ? (
            <ul className="kn-lines">
              {alarms.map((a) => (
                <li key={a.id} className={a.id === focusId ? 'kn-focus' : undefined}>
                  <div className="row-between">
                    <span>
                      <Badge tone={a.severity === 'severe' ? 'red' : 'amber'}>{a.severity}</Badge> {humanise(a.metric)}: {a.current ?? '—'} against {a.baseline ?? '—'} (n {a.n}){a.packVersion !== null ? ` · learned v${a.packVersion}` : ''} <span className="small muted">{whenText(a.raisedAt)} · {a.status}</span>
                    </span>
                    {a.status === 'open' && (
                      <Button size="sm" loading={ack.isPending && ack.variables === a.id} onClick={() => ack.mutate(a.id, { onSuccess: () => toast.success('Acknowledged'), onError: (e) => toast.error((e as Error).message) })}>
                        Acknowledge
                      </Button>
                    )}
                  </div>
                  {a.actionTaken && <div className="small muted">Action taken: {a.actionTaken}</div>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">No alarms.</p>
          )}
        </QueryGate>
      )}
    </Card>
  );
}

function ReplayRunsCard() {
  const q = useEvalRuns();
  const toast = useToast();
  const run = useKnowledgeMutation(() => knowledgeApi.replay({ mode: 'nightly' }));
  const runs = q.data ?? [];
  return (
    <Card
      title="Replay runs"
      actions={
        !q.error ? (
          <Button size="sm" loading={run.isPending} onClick={() => run.mutate(undefined, { onSuccess: () => toast.success('Replay queued'), onError: (e) => toast.error((e as Error).message) })}>
            Replay now
          </Button>
        ) : undefined
      }
    >
      {q.error && isNotBuilt(q.error) ? (
        <NotBuilt what="Golden replay" />
      ) : (
        <QueryGate q={q} what="Replay runs">
          {runs.length ? (
            <ul className="kn-lines">
              {runs.slice(0, 20).map((r) => (
                <li key={r.id} className="small">
                  <Badge tone={r.verdict === 'no_worse' ? 'green' : r.verdict === 'worse' ? 'red' : 'amber'}>{humanise(r.verdict)}</Badge> {humanise(r.mode)} · {r.cases} cases · {whenText(r.startedAt)} · by {actorText(r.createdBy)}
                  {r.baselineVersion !== null ? ` · against v${r.baselineVersion}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">No replay runs yet.</p>
          )}
        </QueryGate>
      )}
      <ApiErrorNotice error={run.error} what="start the replay" />
    </Card>
  );
}

function AuditCard() {
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [since, setSince] = useState('');
  const query: ChangesQuery = { ...(action ? { action } : {}), ...(actor.trim() ? { actor: actor.trim() } : {}), ...(since ? { since } : {}), limit: 500 };
  const q = useKnowledgeChanges(query);
  const changes = q.data?.changes ?? [];
  const exportCsv = () => {
    const blob = new Blob([changesCsv(changes)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `claimdesk-knowledge-changes${since ? `-since-${since}` : ''}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <Card title="Audit of knowledge changes" flush actions={<Button size="sm" variant="ghost" disabled={!changes.length} onClick={exportCsv}>Export CSV</Button>}>
      <div className="row kn-filters kn-pad">
        <select className="select" aria-label="Action" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">Every action</option>
          <option value="knowledge.item.">Items</option>
          <option value="knowledge.check">Checks</option>
          <option value="knowledge.pack.">Learned versions</option>
          <option value="knowledge.gap.">Gaps</option>
          <option value="knowledge.source.">Sources</option>
          <option value="knowledge.settings">Settings</option>
          <option value="knowledge.learning.">Learning on / off</option>
          <option value="knowledge.conflict.">Conflicts</option>
          <option value="knowledge.link.set">Insurer links</option>
        </select>
        <input className="input" placeholder="Who (e.g. agent:researcher)" aria-label="Who" value={actor} onChange={(e) => setActor(e.target.value)} />
        <input className="input" type="date" aria-label="Since" value={since} onChange={(e) => setSince(e.target.value)} />
      </div>
      <QueryGate q={q} what="The audit">
        {changes.length ? (
          <div className="table-wrap kn-audit">
            <table className="table" aria-label="Knowledge changes">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">What</th>
                  <th scope="col">Item</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {changes.slice(0, 200).map((c) => (
                  <tr key={c.id}>
                    <td className="small">{whenText(c.at)}</td>
                    <td className="small">{actorText(c.actor)}</td>
                    <td className="small">{humanise(c.action.replace(/^knowledge\./, ''))}</td>
                    <td className="small mono">{c.itemKey ?? c.gapId ?? (c.packVersion !== null ? `v${c.packVersion}` : '—')}</td>
                    <td className="small">
                      {c.reason ?? ''}
                      {c.ruleIds.length ? ` (${c.ruleIds.join(', ')})` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {changes.length > 200 && <p className="small muted kn-pad">Showing 200 of {changes.length}; the CSV has them all.</p>}
          </div>
        ) : (
          <p className="small muted kn-pad">No changes match.</p>
        )}
      </QueryGate>
    </Card>
  );
}
