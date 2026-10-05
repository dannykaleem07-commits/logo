/**
 * Settings → Manager mode (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A.8): the idle switch-off time, the on/off toggle and
 * the recent overrides from GET /auth/manager-mode/log. Rendered by SettingsPage.
 */
import { useEffect, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { MANAGER_MODE_MAX_IDLE_MINUTES, MANAGER_MODE_MIN_IDLE_MINUTES, overrideRule } from '@ccguk/domain';
import { useSettings, useUpdateSettings } from '../../api/hooks';
import { managerQk, useManagerLog, type ManagerLogEntry } from '../../api/managerApi';
import { minutesText, useManagerMode } from '../../app/managerMode';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { DateText } from '../../components/DateText';
import { Table, type Column } from '../../components/Table';
import { useToast } from '../../components/Toast';
import { auditActionLabel, auditReasonText } from '../../lib/managerMode';

/** Parse the idle-minutes box: a whole number 1–480, or an error message. */
export function parseIdleMinutes(text: string): { value?: number; error?: string } {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return { error: `Whole minutes, ${MANAGER_MODE_MIN_IDLE_MINUTES}–${MANAGER_MODE_MAX_IDLE_MINUTES}.` };
  const n = Number(t);
  if (n < MANAGER_MODE_MIN_IDLE_MINUTES || n > MANAGER_MODE_MAX_IDLE_MINUTES) return { error: `Between ${MANAGER_MODE_MIN_IDLE_MINUTES} and ${MANAGER_MODE_MAX_IDLE_MINUTES} minutes.` };
  return { value: n };
}

export function ManagerModeCard(): JSX.Element | null {
  const mm = useManagerMode();
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useSettings();
  const update = useUpdateSettings();
  const saved = typeof settings.data?.managerModeIdleMinutes === 'number' ? settings.data.managerModeIdleMinutes : mm.idleMinutes;
  const [draft, setDraft] = useState(String(saved));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(String(saved));
  }, [saved, dirty]);
  const parsed = parseIdleMinutes(draft);
  const log = useManagerLog(50, mm.allowed);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const save = () => {
    if (parsed.value === undefined) return;
    update.mutate(
      { managerModeIdleMinutes: parsed.value },
      {
        onSuccess: () => {
          setDirty(false);
          void qc.invalidateQueries({ queryKey: managerQk.mode, exact: true });
          toast.success(`Manager mode now switches off after ${minutesText(parsed.value!)} without activity`);
        }
      }
    );
  };
  const toggle = async () => {
    setToggleError(null);
    try {
      if (mm.on) await mm.turnOff('user');
      else await mm.turnOn();
    } catch (e) {
      setToggleError((e as Error)?.message ?? 'Could not change manager mode');
    }
  };

  const columns: Column<ManagerLogEntry>[] = [
    { key: 'when', header: 'When', width: '150px', render: (r) => <DateText value={r.at} time /> },
    { key: 'who', header: 'Who', width: '140px', render: (r) => r.userName ?? r.userId },
    { key: 'rule', header: 'Rule', render: (r) => auditActionLabel(r.action, (code) => overrideRule(code)?.label) },
    { key: 'reason', header: 'Reason', render: (r) => <span className="audit-details">{auditReasonText(r) || '—'}</span> },
    {
      key: 'claim',
      header: 'Claim',
      width: '130px',
      render: (r) => (r.entity === 'claims' ? <Link to={`/claims/${encodeURIComponent(r.entityId)}/flags`}>{r.claimReference ?? 'Open claim'}</Link> : <span className="muted">—</span>)
    }
  ];

  return (
    <Card
      id="manager-mode"
      title="Manager mode"
      actions={
        mm.allowed ? (
          <Badge tone={mm.on ? 'red' : 'grey'} dot>
            {mm.on ? 'ON' : 'off'}
          </Badge>
        ) : undefined
      }
    >
      <div className="stack">
        <p className="small">
          Manager mode lets an admin or approver override anything that would normally stop them — a hard stop, a car that is not cleared for hire, an incomplete checklist, missing intake answers. Every override is recorded in the audit log with the reason. It switches itself off after a period without activity, and always on sign-out.
        </p>
        {!mm.allowed ? (
          <div className="notice notice-info">Only admin and approver users can use manager mode. Ask a manager to override a block for you.</div>
        ) : (
          <>
            <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
              <button type="button" className={`manager-toggle ${mm.on ? 'on' : ''}`} onClick={() => void toggle()} disabled={mm.pending} aria-pressed={mm.on}>
                <span>{mm.on ? 'Manager mode ON — turn off' : 'Turn manager mode on'}</span>
              </button>
              {toggleError && <span className="xs" style={{ color: 'var(--red)' }}>{toggleError}</span>}
            </div>
            <form
              className="row"
              style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
            >
              <label htmlFor="manager-idle-minutes" className="small">
                Switch manager mode off after
              </label>
              <input
                id="manager-idle-minutes"
                className="input"
                style={{ width: 90 }}
                inputMode="numeric"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setDirty(true);
                }}
                aria-invalid={parsed.error ? true : undefined}
                aria-describedby="manager-idle-help"
              />
              <span className="small">minutes without activity</span>
              <Button size="sm" type="submit" variant="primary" disabled={!dirty || parsed.value === undefined} loading={update.isPending}>
                Save
              </Button>
              <span id="manager-idle-help" className="xs" style={{ color: parsed.error ? 'var(--red)' : undefined }}>
                {parsed.error ?? `Default 60, from ${MANAGER_MODE_MIN_IDLE_MINUTES} to ${MANAGER_MODE_MAX_IDLE_MINUTES}.`}
              </span>
            </form>
            <ApiErrorNotice error={update.error} what="save the idle time" />
            <div>
              <h3 style={{ fontSize: 'var(--fs-md)', margin: '8px 0' }}>Recent overrides</h3>
              {log.error ? (
                <ApiErrorNotice error={log.error} what="load the override log" />
              ) : (
                <div className="audit-table">
                  <Table columns={columns} rows={log.data ?? []} rowKey={(r) => r.id} empty={log.isLoading ? 'Loading…' : 'No overrides yet.'} caption="Recent overrides" />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
