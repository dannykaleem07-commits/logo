// owned by gateway
/**
 * Settings > AI `/settings/ai` (docs/SUPREME-DESIGN.md §A.7, §L.6): the driver (subscription via Claude Code / API key /
 * off), Claude Code status and the sign-in token wizard, the API key and daily cap, model + effort per job with
 * Economy / Best quality, concurrency and the "leave X % for me" reserve, the setup checklist with the honest terms
 * notice, the agents on/off switch (refused until the checklist and the driver are ready) and a test run.
 */
import { useEffect, useMemo, useState } from 'react';
import { aiApi, useAiMutation, useAiStatus, type AiDriverChoice, type AiEffort, type AiJobModel, type AiQuality, type AiStatus, type ChecklistItemId, type SecretKind } from '../../../api/aiApi';
import { isApiError } from '../../../api/client';
import { PageHeader } from '../../../components/PageHeader';
import { Card } from '../../../components/Card';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Checkbox, Select, TextInput } from '../../../components/Form';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { agentsLine, aiLaneMax, checklistItems, DRIVER_OPTIONS, EFFORT_OPTIONS, jobRows, minutesToMs, MODEL_OPTIONS, msToMinutes, pausedText, perJobPatch, QUALITY_LABEL, usageBars, wizardSteps } from './aiSettings';
import '../settings.css';
import './ai.css';

function errorText(e: unknown): string {
  if (isApiError(e)) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export function AiSettingsPage() {
  const status = useAiStatus();
  const s = status.data;
  return (
    <div className="page settings-page ai-settings">
      <PageHeader
        title="AI"
        subtitle="Claude sign-in, models, usage and the agents’ on/off switch"
        actions={s ? <Badge tone={agentsLine(s).tone} dot>{agentsLine(s).text}</Badge> : undefined}
      />
      {status.isLoading && <Loading label="Checking AI set-up…" />}
      <ApiErrorNotice error={status.error} what="load the AI settings" />
      {s && (
        <div className="stack">
          <StatusCard s={s} />
          <DriverCard s={s} />
          {s.settings.driver === 'subscription_cli' || s.settings.driver === 'off' ? <SubscriptionCard s={s} /> : null}
          {s.settings.driver === 'api_key' || s.settings.driver === 'off' ? <ApiKeyCard s={s} /> : null}
          <ModelsCard s={s} />
          <CapacityCard s={s} />
          <ChecklistCard s={s} />
        </div>
      )}
    </div>
  );
}

function StatusCard({ s }: { s: AiStatus }) {
  const toast = useToast();
  const toggle = useAiMutation((on: boolean) => aiApi.patchSettings({ agentsEnabled: on }));
  const check = useAiMutation(() => aiApi.check());
  const paused = pausedText(s);
  const bars = usageBars(s);
  const onToggle = async (on: boolean) => {
    try {
      await toggle.mutateAsync(on);
      toast.success(on ? 'Agents switched on' : 'Agents switched off');
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  return (
    <Card
      title="Status"
      actions={
        <Button size="sm" onClick={() => check.mutate(undefined)} loading={check.isPending}>
          Check
        </Button>
      }
    >
      <div className="stack">
        {paused && <div className="notice notice-warn">{paused}</div>}
        {s.realAiForbidden && <div className="notice notice-info">This copy of ClaimDesk is in test mode: real AI calls are switched off (CLAIMDESK_FORBID_REAL_AI=1).</div>}
        <div className="row-between">
          <div>
            <div>
              Driver: <strong>{DRIVER_OPTIONS.find((d) => d.value === s.driver.selected)?.label ?? s.driver.selected}</strong>
              {s.driver.override && <span className="muted xs"> (set by AI_DRIVER={s.driver.override})</span>}
            </div>
            <div className="xs">
              <Badge tone={s.driver.health.ready ? 'green' : 'amber'} dot>
                {s.driver.health.ready ? 'Ready' : 'Not ready'}
              </Badge>
            </div>
          </div>
          <div className="row">
            {s.agents.enabled ? (
              <Button variant="danger" onClick={() => void onToggle(false)} loading={toggle.isPending}>
                Switch agents off
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void onToggle(true)} loading={toggle.isPending} disabled={!s.canEnableAgents} title={s.canEnableAgents ? undefined : s.blockers.join('; ')}>
                Switch agents on
              </Button>
            )}
          </div>
        </div>
        {!s.agents.enabled && s.blockers.length > 0 && (
          <div className="xs">
            <strong>Before the agents can start:</strong>
            <ul className="ai-list">
              {s.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        )}
        {s.settings.driver === 'api_key' ? (
          <div className="xs">
            API spend today: <strong>${s.usage.costTodayUsd.toFixed(2)}</strong> of the ${s.settings.dailyUsdCap.toFixed(2)} daily cap
          </div>
        ) : (
          <div className="ai-usage" aria-label="Claude usage">
            {bars.map((b) => (
              <div key={b.label} className="ai-usage-row">
                <span className="xs">{b.label}</span>
                <div className={`ai-bar ai-bar-${b.tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={b.percent ?? undefined} aria-label={b.label}>
                  <span style={{ width: `${Math.min(100, b.percent ?? 0)}%` }} />
                </div>
                <span className="xs muted">{b.percent === null ? 'no data yet' : `${b.percent}%${b.resets ? ` · resets ${b.resets}` : ''}`}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function DriverCard({ s }: { s: AiStatus }) {
  const toast = useToast();
  const [driver, setDriver] = useState<AiDriverChoice>(s.settings.driver);
  useEffect(() => setDriver(s.settings.driver), [s.settings.driver]);
  const save = useAiMutation((d: AiDriverChoice) => aiApi.patchSettings({ driver: d, ...(d === 'subscription_cli' && s.settings.lanes.ai > 3 ? { lanes: { ai: 1 } } : {}) }));
  return (
    <Card title="Driver">
      <div className="stack">
        <Select label="How the agents reach Claude" value={driver} onChange={(v) => v && setDriver(v as AiDriverChoice)} options={DRIVER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
        <p className="xs muted ai-notice">{s.notices.terms}</p>
        <div className="row">
          <Button
            variant="primary"
            disabled={driver === s.settings.driver}
            loading={save.isPending}
            onClick={() =>
              save.mutate(driver, {
                onSuccess: () => toast.success('Driver saved'),
                onError: (e) => toast.error(errorText(e)),
              })
            }
          >
            Save driver
          </Button>
        </div>
      </div>
    </Card>
  );
}

function SecretField({ kind, present, label, placeholder }: { kind: SecretKind; present: boolean; label: string; placeholder: string }) {
  const toast = useToast();
  const [value, setValue] = useState('');
  const put = useAiMutation((v: string) => aiApi.putSecret(kind, v));
  const del = useAiMutation(() => aiApi.deleteSecret(kind));
  return (
    <div className="stack-sm">
      <div className="row ai-secret">
        <TextInput label={label} type="password" autoComplete="off" value={value} onChange={setValue} placeholder={present ? 'Saved — paste a new one to replace it' : placeholder} hint={present ? 'Saved and encrypted on this PC. It is never shown again.' : 'Stored encrypted on this PC (never in backups, never shown again).'} />
        <Button
          variant="primary"
          disabled={value.trim().length < 20}
          loading={put.isPending}
          onClick={() =>
            put.mutate(value.trim(), {
              onSuccess: () => {
                setValue('');
                toast.success('Saved');
              },
              onError: (e) => toast.error(errorText(e)),
            })
          }
        >
          Save
        </Button>
        {present && (
          <Button variant="ghost" loading={del.isPending} onClick={() => del.mutate(undefined, { onSuccess: () => toast.success('Removed'), onError: (e) => toast.error(errorText(e)) })}>
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}

function SubscriptionCard({ s }: { s: AiStatus }) {
  const toast = useToast();
  const check = useAiMutation(() => aiApi.check());
  const [opening, setOpening] = useState(false);
  const [testing, setTesting] = useState(false);
  const steps = wizardSteps(s);
  const openWindow = async () => {
    setOpening(true);
    try {
      const r = await aiApi.openSetupToken();
      toast.success(r.instructions);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setOpening(false);
    }
  };
  const testRun = async () => {
    setTesting(true);
    try {
      const r = await aiApi.testRun();
      if (r.outcome === 'ok') toast.success(`Test run OK (${r.model ?? r.driver})`);
      else toast.warn(`Test run: ${r.outcome}${r.message ? ` — ${r.message}` : ''}`);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setTesting(false);
    }
  };
  return (
    <Card title="Claude Code (subscription)">
      <div className="stack">
        <ol className="ai-steps">
          {steps.map((st) => (
            <li key={st.n} className={st.done ? 'done' : ''}>
              <div className="row-between">
                <strong>
                  {st.n}. {st.title}
                </strong>
                {st.done && <Badge tone="green">Done</Badge>}
              </div>
              <div className="xs muted">{st.detail}</div>
              {st.n === 1 && (
                <div className="row">
                  <code className="ai-code">winget install Anthropic.ClaudeCode</code>
                  <Button size="sm" onClick={() => check.mutate(undefined)} loading={check.isPending}>
                    Check again
                  </Button>
                </div>
              )}
              {st.n === 2 && (
                <div className="row">
                  <Button size="sm" onClick={() => void openWindow()} loading={opening} disabled={s.platform !== 'win32' || !s.cli.path}>
                    Open sign-in window
                  </Button>
                  {s.platform !== 'win32' && <span className="xs muted">On this computer run `claude setup-token` in a terminal instead.</span>}
                </div>
              )}
              {st.n === 3 && <SecretField kind="token" present={s.secrets.claudeToken} label="Sign-in token" placeholder="Paste the token from the sign-in window" />}
              {st.n === 4 && (
                <div className="row">
                  <Button size="sm" onClick={() => check.mutate(undefined)} loading={check.isPending}>
                    Check
                  </Button>
                </div>
              )}
              {st.n === 5 && (
                <div className="row">
                  <Button size="sm" onClick={() => void testRun()} loading={testing} disabled={s.realAiForbidden || s.settings.driver === 'off'}>
                    Test run
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ol>
        {s.cli.problems.length > 0 && (
          <div className="notice notice-warn xs">
            <ul className="ai-list">
              {s.cli.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

function ApiKeyCard({ s }: { s: AiStatus }) {
  const toast = useToast();
  const [cap, setCap] = useState(String(s.settings.dailyUsdCap));
  useEffect(() => setCap(String(s.settings.dailyUsdCap)), [s.settings.dailyUsdCap]);
  const save = useAiMutation((v: number) => aiApi.patchSettings({ dailyUsdCap: v }));
  const capNum = Number(cap);
  return (
    <Card title="Anthropic API key">
      <div className="stack">
        <p className="xs muted ai-notice">Create a key at console.anthropic.com and set a monthly spend limit there too. Usage is charged per token; ClaimDesk pauses the agents for the rest of the day when today’s spend reaches the cap.</p>
        <SecretField kind="api-key" present={s.secrets.apiKey} label="API key" placeholder="sk-ant-…" />
        <div className="row ai-secret">
          <TextInput label="Daily spend cap (US dollars)" type="number" min={0} step="1" value={cap} onChange={setCap} error={Number.isFinite(capNum) && capNum >= 0 ? undefined : 'Enter an amount'} />
          <Button disabled={!Number.isFinite(capNum) || capNum < 0 || capNum === s.settings.dailyUsdCap} loading={save.isPending} onClick={() => save.mutate(capNum, { onSuccess: () => toast.success('Daily cap saved'), onError: (e) => toast.error(errorText(e)) })}>
            Save cap
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ModelsCard({ s }: { s: AiStatus }) {
  const toast = useToast();
  const rows = useMemo(() => jobRows(s), [s]);
  const [edits, setEdits] = useState<Record<string, Partial<AiJobModel>>>({});
  useEffect(() => setEdits({}), [s.settings.perJob]);
  const valueOf = (jobType: string, effective: AiJobModel): AiJobModel => ({ ...effective, ...(edits[jobType] ?? {}) });
  const patch = perJobPatch(edits, rows);
  const save = useAiMutation(() => aiApi.patchSettings({ perJob: patch }));
  const quality = useAiMutation((q: AiQuality) => aiApi.patchSettings({ quality: q }));
  const setEdit = (jobType: string, patch: Partial<AiJobModel>) => setEdits((e) => ({ ...e, [jobType]: { ...(e[jobType] ?? {}), ...patch } }));
  const dirty = Object.keys(patch).length > 0;
  return (
    <Card
      title="Models and effort per job"
      actions={
        <>
          {(['economy', 'standard', 'best'] as const).map((q) => (
            <Button key={q} size="sm" variant={s.settings.quality === q ? 'primary' : 'secondary'} loading={quality.isPending && quality.variables === q} onClick={() => quality.mutate(q, { onError: (e) => toast.error(errorText(e)) })} title={QUALITY_LABEL[q]}>
              {q === 'economy' ? 'Economy' : q === 'best' ? 'Best quality' : 'Standard'}
            </Button>
          ))}
        </>
      }
    >
      <div className="stack">
        <p className="xs muted">{QUALITY_LABEL[s.settings.quality]}. The table shows what each job uses now; change a row to override it.</p>
        <div className="ai-table-wrap">
          <table className="table ai-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Model</th>
                <th>Effort</th>
                <th>Max turns</th>
                <th>Time limit (min)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const v = valueOf(r.jobType, r.effective);
                return (
                  <tr key={r.jobType}>
                    <td>
                      {r.label}
                      <div className="xs muted">{r.jobType}</div>
                    </td>
                    <td>
                      <select className="select" aria-label={`${r.label} model`} value={v.model} onChange={(e) => setEdit(r.jobType, { model: e.target.value })}>
                        {[...MODEL_OPTIONS.map((m) => m.value), ...(MODEL_OPTIONS.some((m) => m.value === v.model) ? [] : [v.model])].map((m) => (
                          <option key={m} value={m}>
                            {MODEL_OPTIONS.find((o) => o.value === m)?.label ?? m}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select className="select" aria-label={`${r.label} effort`} value={v.effort} onChange={(e) => setEdit(r.jobType, { effort: e.target.value as AiEffort })}>
                        {EFFORT_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <ClampedNumberInput min={1} max={50} label={`${r.label} max turns`} value={v.maxTurns} onCommit={(n) => setEdit(r.jobType, { maxTurns: n })} />
                    </td>
                    <td>
                      <ClampedNumberInput min={1} max={60} label={`${r.label} time limit`} value={msToMinutes(v.timeoutMs)} onCommit={(n) => setEdit(r.jobType, { timeoutMs: minutesToMs(n) })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="row">
          <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => toast.success('Models saved'), onError: (e) => toast.error(errorText(e)) })}>
            Save models
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => setEdits({})}>
              Undo changes
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/** A whole number typed by the owner, clamped to [min, max]; undefined when it is not a number (keep the old value). */
export function clampInt(text: string, min: number, max: number): number | undefined {
  const t = text.trim();
  if (!/^-?\d+$/.test(t)) return undefined;
  return Math.min(max, Math.max(min, Number(t)));
}

/**
 * A number field that keeps what is typed as text and clamps only when the field is left (blur) or Enter is pressed —
 * clamping on every keystroke turned "8" typed into a cleared field into "18".
 */
export function ClampedNumberInput({ value, min, max, label, onCommit }: { value: number; min: number; max: number; label: string; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState<string | undefined>();
  const commit = () => {
    if (draft === undefined) return;
    const n = clampInt(draft, min, max);
    if (n !== undefined && n !== value) onCommit(n);
    setDraft(undefined);
  };
  return (
    <input
      className="input ai-num"
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      aria-label={label}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

function CapacityCard({ s }: { s: AiStatus }) {
  const toast = useToast();
  const [lane, setLane] = useState(String(s.settings.lanes.ai));
  const [reserve, setReserve] = useState(String(s.settings.reservePercent));
  useEffect(() => {
    setLane(String(s.settings.lanes.ai));
    setReserve(String(s.settings.reservePercent));
  }, [s.settings.lanes.ai, s.settings.reservePercent]);
  const max = aiLaneMax(s.settings.driver);
  const laneN = Number(lane);
  const reserveN = Number(reserve);
  const laneErr = Number.isInteger(laneN) && laneN >= 1 && laneN <= max ? undefined : `1 to ${max}`;
  const reserveErr = Number.isInteger(reserveN) && reserveN >= 0 && reserveN <= 90 ? undefined : '0 to 90';
  const save = useAiMutation(() => aiApi.patchSettings({ lanes: { ai: laneN }, reservePercent: reserveN }));
  return (
    <Card title="Capacity">
      <div className="stack">
        <div className="grid-2">
          <TextInput label="AI jobs at the same time" type="number" min={1} max={max} value={lane} onChange={setLane} error={laneErr} hint={s.settings.driver === 'subscription_cli' ? 'On the subscription keep this low (1 is safest).' : 'API mode allows up to 6.'} />
          <TextInput label="Leave this % of my five-hour window for me" type="number" min={0} max={90} value={reserve} onChange={setReserve} error={reserveErr} hint="Agents slow down and then wait when they reach the rest, so your own Claude use keeps working." />
        </div>
        <div className="row">
          <Button variant="primary" disabled={Boolean(laneErr || reserveErr) || (laneN === s.settings.lanes.ai && reserveN === s.settings.reservePercent)} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => toast.success('Capacity saved'), onError: (e) => toast.error(errorText(e)) })}>
            Save capacity
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ChecklistCard({ s }: { s: AiStatus }) {
  const toast = useToast();
  const set = useAiMutation((a: { item: ChecklistItemId; done: boolean }) => aiApi.setChecklist(a.item, a.done));
  const items = checklistItems(s);
  return (
    <Card title="Setup checklist" actions={<Badge tone={s.checklistComplete ? 'green' : 'amber'}>{s.checklistComplete ? 'Complete' : 'Not complete'}</Badge>}>
      <div className="stack">
        <p className="xs muted">Every item must be ticked before the agents can be switched on. Unticking one switches them off.</p>
        {items.map((it) => (
          <div key={it.id} className="ai-check">
            <Checkbox
              label={<strong>{it.label}</strong>}
              checked={Boolean(s.checklist[it.id]?.done)}
              disabled={set.isPending}
              onChange={(done) => set.mutate({ item: it.id, done }, { onError: (e) => toast.error(errorText(e)) })}
              hint={
                <>
                  {it.detail}{' '}
                  {it.link && (
                    <a href={it.link.href} target="_blank" rel="noopener noreferrer">
                      {it.link.text}
                    </a>
                  )}
                </>
              }
            />
          </div>
        ))}
      </div>
    </Card>
  );
}
