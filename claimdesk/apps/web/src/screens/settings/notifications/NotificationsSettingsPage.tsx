// owned by runtime
/**
 * Settings > Notifications (docs/SUPREME-DESIGN.md §J.1, §L.7): Windows pop-ups on/off and a test button, which
 * priorities raise a pop-up, quiet hours, the daily-log time, and (Phase 2) SMS and the daily-log email.
 * Pop-ups never show personal data: only the kind and the claim reference.
 */
import { useEffect, useState } from 'react';
import type { NotificationSettings } from '@ccguk/domain';
import { PageHeader } from '../../../components/PageHeader';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { useToast } from '../../../components/Toast';
import { agentsApi, useAgentsMutation, useNotificationSettings, type NotificationTestResult } from '../../../api/agentsApi';
import '../../agents/agents.css';

/** Plain-English result of the test button. */
export function describeToastTest(r: NotificationTestResult): string {
  const toast = r.result.deliveries.find((d) => d.channel === 'toast');
  if (!toast) return 'Pop-ups are switched off or not used for this level; the notification is in the app.';
  if (toast.status === 'shown') return 'A pop-up was sent to Windows. If you did not see it, check Windows Settings > System > Notifications for ClaimDesk.';
  if (toast.status === 'not_windows') return 'This computer is not running Windows, so no pop-up can be shown; the notification is in the app.';
  if (toast.status === 'quiet_hours') return 'It is quiet hours, so the pop-up was held back; the notification is in the app.';
  if (toast.status === 'disabled') return 'Pop-ups are switched off.';
  return `Windows refused the pop-up (${toast.error ?? toast.status}). The notification is in the app.`;
}

export function NotificationsSettingsPage() {
  const q = useNotificationSettings();
  const toast = useToast();
  const [draft, setDraft] = useState<NotificationSettings | undefined>();
  const [testResult, setTestResult] = useState<string | undefined>();
  useEffect(() => {
    if (q.data) setDraft(q.data.settings);
  }, [q.data]);
  const save = useAgentsMutation((patch: Partial<NotificationSettings>) => agentsApi.patchNotificationSettings(patch));
  const test = useAgentsMutation(() => agentsApi.testNotification());

  if (q.isLoading || (!draft && !q.error)) return <Loading />;
  if (q.error) return <ApiErrorNotice error={q.error} />;
  const s = draft!;
  const set = (next: Partial<NotificationSettings>) => setDraft({ ...s, ...next });
  const dirty = JSON.stringify(s) !== JSON.stringify(q.data!.settings);
  const patch: Partial<NotificationSettings> = { toasts: s.toasts, toastMinPriority: s.toastMinPriority, quietHoursSuppressToasts: s.quietHoursSuppressToasts, dailyLogAt: s.dailyLogAt };

  return (
    <div className="page">
      <PageHeader
        title="Notifications"
        subtitle="Pop-ups, quiet hours and the daily log"
        crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Notifications' }]}
        actions={
          <Button variant="primary" disabled={!dirty || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.dailyLogAt)} loading={save.isPending} onClick={() => save.mutate(patch, { onSuccess: () => toast.success('Notification settings saved'), onError: (e) => toast.error((e as Error).message) })}>
            Save
          </Button>
        }
      />
      <div className="stack">
        <Card title="Windows pop-ups">
          <div className="stack-sm">
            <label className="check">
              <input type="checkbox" checked={s.toasts} onChange={(e) => set({ toasts: e.target.checked })} /> Show Windows pop-ups for items that need me, held emails (with Undo) and AI pauses
            </label>
            <label className="field">
              <span className="field-label">Pop up for items of this priority or higher</span>
              <select className="select" value={s.toastMinPriority} onChange={(e) => set({ toastMinPriority: e.target.value as NotificationSettings['toastMinPriority'] })}>
                <option value="urgent">Urgent only</option>
                <option value="high">High and urgent</option>
                <option value="normal">Normal and above</option>
                <option value="low">Everything</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={s.quietHoursSuppressToasts} onChange={(e) => set({ quietHoursSuppressToasts: e.target.checked })} /> No pop-ups during quiet hours except urgent ones (quiet hours are set under Autonomy)
            </label>
            <p className="small muted">Pop-ups show the kind and the claim reference only — never names, addresses or other personal details.</p>
            <div className="row">
              <Button
                loading={test.isPending}
                onClick={() =>
                  test.mutate(undefined, {
                    onSuccess: (r) => setTestResult(describeToastTest(r)),
                    onError: (e) => toast.error((e as Error).message),
                  })
                }
              >
                Send a test pop-up
              </Button>
              {testResult && <span className="small">{testResult}</span>}
            </div>
          </div>
        </Card>
        <Card title="Daily log">
          <label className="field">
            <span className="field-label">Compile the daily log at (London time)</span>
            <input className="input" type="time" value={s.dailyLogAt} onChange={(e) => set({ dailyLogAt: e.target.value })} />
          </label>
          <p className="small muted">Emailing the daily log to you arrives in a later version.</p>
        </Card>
        <Card title="Text messages (SMS)">
          <p className="small muted">Text messages for urgent items (an offer received, a suspicious email, a deadline at risk) arrive in a later version and will be optional, at most 10 a day.</p>
        </Card>
      </div>
    </div>
  );
}
