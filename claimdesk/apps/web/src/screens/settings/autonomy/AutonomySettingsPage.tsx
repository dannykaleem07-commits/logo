// owned by runtime
/**
 * Settings > Autonomy (docs/SUPREME-DESIGN.md §D.1, §L.7): mode (Automatic / Shadow), the action-class table
 * (always-ask classes read-only), allow-lists of email kinds and templates (always-ask entries shown disabled with the
 * reason), hold window, thresholds, rate limits, quiet hours and the kill switch. Admin / approver only (the API
 * enforces it and refuses always-ask entries whatever this page sends).
 */
import { useEffect, useMemo, useState } from 'react';
import type { AutonomySettings, EmailKind } from '@ccguk/domain';
import { PageHeader } from '../../../components/PageHeader';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { agentsApi, useAgentsMutation, useAutonomySettings } from '../../../api/agentsApi';
import { autonomyPatch, autonomyProblems, CLASS_ROWS, isAlwaysAsk, toggleApproveTemplate, toggleEmailKind, toggleSendTemplate } from './autonomy';
import '../../agents/agents.css';

const EMAIL_KIND_LABEL: Record<EmailKind, string> = {
  ack: 'Acknowledgement',
  info_provided: 'Information provided',
  doc_request_fulfil: 'Sending requested documents',
  doc_request: 'Asking for missing documents',
  chaser: 'Chaser',
  handling_ref_request: 'Handling reference request',
  ncaf_cover: 'NCAF cover email',
  cctv_request: 'CCTV request',
  client_update: 'Client update',
  supplier_instruction: 'Supplier instruction',
  reply_general: 'General reply',
  offer_response: 'Offer response',
  complaint: 'Complaint',
  legal: 'Legal',
};

export function AutonomySettingsPage() {
  const q = useAutonomySettings();
  const toast = useToast();
  const [draft, setDraft] = useState<AutonomySettings | undefined>();
  useEffect(() => {
    if (q.data) setDraft(q.data.settings);
  }, [q.data]);
  const save = useAgentsMutation((patch: Partial<AutonomySettings>) => agentsApi.patchAutonomy(patch));
  const alwaysAsk = q.data?.alwaysAsk.templates ?? [];
  const alwaysAskKinds = q.data?.alwaysAsk.emailKinds ?? [];
  const problems = useMemo(() => (draft ? autonomyProblems(draft, alwaysAsk, alwaysAskKinds) : []), [draft, alwaysAsk, alwaysAskKinds]);
  const letters = useMemo(() => (q.data?.templates ?? []).filter((t) => !isAlwaysAsk(t.id, alwaysAsk)), [q.data, alwaysAsk]);
  const askLetters = useMemo(() => (q.data?.templates ?? []).filter((t) => isAlwaysAsk(t.id, alwaysAsk)), [q.data, alwaysAsk]);

  if (q.isLoading || (!draft && !q.error)) return <Loading />;
  if (q.error) return <ApiErrorNotice error={q.error} />;
  const s = draft!;
  const patch = autonomyPatch(q.data!.settings, s);
  const dirty = Object.keys(patch).length > 0;
  const set = (next: Partial<AutonomySettings>) => setDraft({ ...s, ...next });
  const num = (v: string): number => (v.trim() === '' ? NaN : Number(v));

  return (
    <div className="page">
      <PageHeader
        title="Autonomy"
        subtitle="What the agents may do on their own. Money, settlements and legal steps always come to you."
        crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Autonomy' }]}
        actions={
          <Button
            variant="primary"
            disabled={!dirty || problems.length > 0}
            loading={save.isPending}
            onClick={() => save.mutate(patch, { onSuccess: () => toast.success('Autonomy settings saved'), onError: (e) => toast.error((e as Error).message) })}
          >
            Save
          </Button>
        }
      />
      <div className="stack">
        {problems.length > 0 && (
          <div className="notice notice-warn" role="alert">
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        )}
        <Card title="Mode">
          <div className="stack-sm">
            <label className="check">
              <input type="radio" name="mode" checked={s.mode === 'automatic'} onChange={() => set({ mode: 'automatic' })} /> Automatic — routine work happens on its own and appears in the daily log
            </label>
            <label className="check">
              <input type="radio" name="mode" checked={s.mode === 'shadow'} onChange={() => set({ mode: 'shadow' })} /> Shadow — every internal change and every email asks you first (recommended for the first week)
            </label>
            <label className="check">
              <input type="checkbox" checked={s.killSwitch} onChange={(e) => set({ killSwitch: e.target.checked })} /> Kill switch: stop all agents (no AI work, held emails stay held; mail is still filed)
            </label>
          </div>
        </Card>
        <Card title="What needs you" flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Kind of action</th>
                  <th scope="col">Examples</th>
                  <th scope="col">Automatic mode</th>
                  <th scope="col">Shadow mode</th>
                </tr>
              </thead>
              <tbody>
                {CLASS_ROWS.map((r) => (
                  <tr key={r.id}>
                    <th scope="row">
                      {r.label}
                      {!r.editable && <div className="small muted">fixed</div>}
                    </th>
                    <td className="small">{r.examples}</td>
                    <td className="small">{r.automatic}</td>
                    <td className="small">{r.shadow}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Emails the agents may send on their own">
          <div className="settings-checks">
            {q.data!.emailKinds.map((k) => {
              const locked = alwaysAskKinds.includes(k);
              return (
                <label key={k} className="check" title={locked ? 'Always asks you — this cannot be changed' : undefined}>
                  <input type="checkbox" disabled={locked} checked={!locked && s.autoSendEmailKinds.includes(k)} onChange={(e) => setDraft(toggleEmailKind(s, k, e.target.checked, alwaysAskKinds))} /> {EMAIL_KIND_LABEL[k] ?? k}
                  {locked && <span className="small muted"> — always asks you</span>}
                </label>
              );
            })}
          </div>
        </Card>
        <Card title="Letters the agents may send (and approve) on their own">
          <p className="small muted">Approving on their own is only possible for a letter they may also send, with no open consistency flags and a reviewer pass.</p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Template</th>
                  <th scope="col">Send</th>
                  <th scope="col">Approve</th>
                </tr>
              </thead>
              <tbody>
                {letters.map((t) => (
                  <tr key={t.id}>
                    <td>
                      {t.title} <span className="small muted">{t.id}</span>
                    </td>
                    <td>
                      <input type="checkbox" aria-label={`Send ${t.id}`} checked={s.autoSendTemplates.includes(t.id)} onChange={(e) => setDraft(toggleSendTemplate(s, t.id, e.target.checked, alwaysAsk))} />
                    </td>
                    <td>
                      <input type="checkbox" aria-label={`Approve ${t.id}`} disabled={!s.autoSendTemplates.includes(t.id)} checked={s.autoApproveTemplates.includes(t.id)} onChange={(e) => setDraft(toggleApproveTemplate(s, t.id, e.target.checked, alwaysAsk))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {askLetters.length > 0 && (
            <details className="small">
              <summary>{askLetters.length} documents always ask you (cannot be changed)</summary>
              <ul>
                {askLetters.map((t) => (
                  <li key={t.id}>
                    {t.title} <span className="muted">{t.id}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Card>
        <Card title="Hold window, thresholds and limits">
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Hold before sending (minutes, with Undo)</span>
              <input className="input" type="number" min={1} max={1440} value={Number.isFinite(s.holdMinutes) ? s.holdMinutes : ''} onChange={(e) => set({ holdMinutes: num(e.target.value) })} />
            </label>
            <label className="field">
              <span className="field-label">Confidence needed for internal changes (0–1)</span>
              <input className="input" type="number" step={0.01} min={0} max={1} value={Number.isFinite(s.thresholds.internal) ? s.thresholds.internal : ''} onChange={(e) => set({ thresholds: { ...s.thresholds, internal: num(e.target.value) } })} />
            </label>
            <label className="field">
              <span className="field-label">Confidence needed for sending (0–1)</span>
              <input className="input" type="number" step={0.01} min={0} max={1} value={Number.isFinite(s.thresholds.external) ? s.thresholds.external : ''} onChange={(e) => set({ thresholds: { ...s.thresholds, external: num(e.target.value) } })} />
            </label>
            <label className="field">
              <span className="field-label">Automatic sends per claim per day</span>
              <input className="input" type="number" min={0} value={Number.isFinite(s.limits.perClaimPerDay) ? s.limits.perClaimPerDay : ''} onChange={(e) => set({ limits: { ...s.limits, perClaimPerDay: num(e.target.value) } })} />
            </label>
            <label className="field">
              <span className="field-label">Automatic sends per hour</span>
              <input className="input" type="number" min={0} value={Number.isFinite(s.limits.perHour) ? s.limits.perHour : ''} onChange={(e) => set({ limits: { ...s.limits, perHour: num(e.target.value) } })} />
            </label>
            <label className="field">
              <span className="field-label">Automatic sends per day</span>
              <input className="input" type="number" min={0} value={Number.isFinite(s.limits.perDay) ? s.limits.perDay : ''} onChange={(e) => set({ limits: { ...s.limits, perDay: num(e.target.value) } })} />
            </label>
          </div>
        </Card>
        <Card title="Quiet hours">
          <div className="stack-sm">
            <label className="check">
              <input type="checkbox" checked={s.quietHours !== null} onChange={(e) => set({ quietHours: e.target.checked ? { start: '20:00', end: '07:30' } : null })} /> Hold automatic emails overnight (they go at the end of quiet hours)
            </label>
            {s.quietHours && (
              <div className="row">
                <label className="field">
                  <span className="field-label">From</span>
                  <input className="input" type="time" value={s.quietHours.start} onChange={(e) => set({ quietHours: { ...s.quietHours!, start: e.target.value } })} />
                </label>
                <label className="field">
                  <span className="field-label">Until</span>
                  <input className="input" type="time" value={s.quietHours.end} onChange={(e) => set({ quietHours: { ...s.quietHours!, end: e.target.value } })} />
                </label>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
