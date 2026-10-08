// owned by mail
import { useEffect, useState } from 'react';
import { PageHeader } from '../../../components/PageHeader';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { Badge } from '../../../components/Badge';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { Checkbox, Select, TextArea, TextInput } from '../../../components/Form';
import { DateText } from '../../../components/DateText';
import { useToast } from '../../../components/Toast';
import { mailApi, useMailAccount, useMailMutation, type MailAccountInput, type MailAccountView, type MailTestResult } from '../../../api/mailApi';
import { emptyForm, formFromView, smtpPresetId, toInput, validateForm, SMTP_PRESETS, type EmailForm } from './emailSettings';
import '../../outbox/outbox.css';

/**
 * Settings > Email (docs/SUPREME-DESIGN.md §F.1, §L.5): IONOS presets (IMAP 993 TLS; SMTP 465 TLS or 587 STARTTLS),
 * mailbox address, password (write-only — saved in the Windows-protected secret store, never shown again), From name
 * (fixed), signature, folders, "move processed mail", Test connection (no email is sent) and Send test to myself.
 */
export function EmailSettingsPage() {
  const toast = useToast();
  const q = useMailAccount();
  const [form, setForm] = useState<EmailForm>(emptyForm());
  const [tried, setTried] = useState(false);
  const [test, setTest] = useState<MailTestResult | null>(null);
  useEffect(() => {
    if (q.data) setForm(formFromView(q.data));
  }, [q.data]);
  const save = useMailMutation((input: MailAccountInput) => mailApi.saveAccount(input));
  const runTest = useMailMutation(() => mailApi.test());
  const testSend = useMailMutation(() => mailApi.testSend());
  const syncNow = useMailMutation(() => mailApi.syncNow());
  const set = <K extends keyof EmailForm>(k: K) => (v: EmailForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const problems = validateForm(form, q.data?.passwordSaved.imap ?? false);
  const view: MailAccountView | undefined = q.data;

  const onSave = async () => {
    setTried(true);
    if (problems.length) return;
    try {
      await save.mutateAsync(toInput(form));
      setForm((f) => ({ ...f, password: '', smtpPassword: '' }));
      toast.success('Email settings saved');
    } catch {
      /* shown below */
    }
  };

  return (
    <div className="page">
      <PageHeader title="Email" subtitle="The IONOS mailbox the agents read and send from" crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Email' }]} />
      {q.isLoading && <Loading />}
      <ApiErrorNotice error={q.error} what="load the email settings" />
      {view && (
        <div className="mb-stack">
          <Card title="Mailbox" actions={view.account ? <Badge tone={view.account.enabled ? 'green' : 'grey'}>{view.account.enabled ? 'On' : 'Off'}</Badge> : <Badge>Not set up</Badge>}>
            <div className="mb-stack">
              <div className="es-grid">
                <TextInput label="Mailbox address" value={form.fromAddress} onChange={(v) => setForm((f) => ({ ...f, fromAddress: v, username: f.username === f.fromAddress ? v : f.username }))} placeholder="claims@yourdomain.co.uk" required />
                <TextInput label="User name" value={form.username} onChange={set('username')} hint="Usually the full mailbox address" required />
                <TextInput
                  label="Password"
                  type="password"
                  value={form.password}
                  onChange={set('password')}
                  autoComplete="new-password"
                  hint={view.passwordSaved.imap ? 'A password is saved. Leave empty to keep it.' : 'Saved in the Windows-protected store on this PC; never shown again.'}
                />
              </div>
              <div className="es-fixed">
                From: <strong>{view.account?.fromName ?? 'Claims Team, Courtesy Cars Group UK Ltd'}</strong> &lt;{form.fromAddress || 'mailbox address'}&gt; — the name is fixed.
              </div>
              <TextArea label="Signature" value={form.signatureText} onChange={set('signatureText')} rows={4} hint="Plain text added under every email (unless the email already contains it)." />
              <Checkbox label="Read and send email automatically" checked={form.enabled} onChange={set('enabled')} hint="Off: nothing is read or sent; the settings are kept." />
            </div>
          </Card>

          <Card title="Servers (IONOS)">
            <div className="es-grid">
              <TextInput label="IMAP server" value={form.imapHost} onChange={set('imapHost')} />
              <TextInput label="IMAP port" value={String(form.imapPort)} onChange={(v) => set('imapPort')(Number(v.replace(/\D/g, '')) || 0)} hint="993 with TLS" />
              <Select
                label="SMTP"
                value={smtpPresetId(form)}
                onChange={(id) => {
                  const p = SMTP_PRESETS.find((x) => x.id === id);
                  if (p) setForm((f) => ({ ...f, smtpHost: p.host, smtpPort: p.port, smtpSecurity: p.security }));
                }}
                options={[...SMTP_PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: 'custom', label: 'Custom' }]}
              />
              <TextInput label="SMTP server" value={form.smtpHost} onChange={set('smtpHost')} />
              <TextInput label="SMTP port" value={String(form.smtpPort)} onChange={(v) => set('smtpPort')(Number(v.replace(/\D/g, '')) || 0)} />
              <TextInput label="SMTP password (only if different)" type="password" value={form.smtpPassword} onChange={set('smtpPassword')} autoComplete="new-password" />
            </div>
          </Card>

          <Card title="Folders">
            <div className="es-grid">
              <TextInput label="Processed mail folder" value={form.processedFolder} onChange={set('processedFolder')} />
              <TextInput label="Quarantine folder" value={form.quarantineFolder} onChange={set('quarantineFolder')} hint="Suspicious email is moved here" />
            </div>
            <Checkbox label="Move processed mail out of the inbox" checked={form.moveAfterIngest} onChange={set('moveAfterIngest')} hint="Off = copy only: mail stays in the inbox. Mail is never marked as read." />
          </Card>

          {tried && problems.length > 0 && (
            <ul className="ob-reasons" role="alert">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <ApiErrorNotice error={save.error} what="save the email settings" />
          <div className="ob-actions" style={{ justifyContent: 'flex-start' }}>
            <Button variant="primary" loading={save.isPending} onClick={() => void onSave()}>
              Save
            </Button>
            <Button
              disabled={!view.account}
              loading={runTest.isPending}
              onClick={() =>
                void runTest
                  .mutateAsync(undefined)
                  .then(setTest)
                  .catch(() => undefined)
              }
            >
              Test connection
            </Button>
            <Button disabled={!view.account} loading={testSend.isPending} onClick={() => void testSend.mutateAsync(undefined).then((r) => toast.success(`Test email queued to ${r.to}`)).catch(() => undefined)}>
              Send test to myself
            </Button>
            <Button variant="ghost" disabled={!view.account?.enabled} loading={syncNow.isPending} onClick={() => void syncNow.mutateAsync(undefined).then(() => toast.success('Checking the mailbox now')).catch(() => undefined)}>
              Check mail now
            </Button>
          </div>
          <ApiErrorNotice error={runTest.error ?? testSend.error ?? syncNow.error} what="reach the mailbox" />
          {test && (
            <Card title="Connection test (nothing was sent)">
              <ul className="es-result">
                <li>
                  IMAP: {test.imap.ok ? <Badge tone="green">OK</Badge> : <Badge tone="red">Failed</Badge>} {test.imap.error ?? (test.imap.folders ? `${test.imap.folders.length} folders: ${test.imap.folders.slice(0, 8).join(', ')}` : '')}
                </li>
                <li>
                  SMTP: {test.smtp.ok ? <Badge tone="green">OK</Badge> : <Badge tone="red">Failed</Badge>} {test.smtp.error ?? ''}
                </li>
              </ul>
            </Card>
          )}
          {view.sync && view.sync.folders.length > 0 && (
            <Card title="Sync">
              <ul className="es-result">
                {view.sync.folders.map((f) => (
                  <li key={f.folder}>
                    {f.folder}: last message {f.lastUid}
                    {f.lastSyncAt && (
                      <>
                        , checked <DateText value={f.lastSyncAt} time />
                      </>
                    )}
                    {f.lastError && ` — ${f.lastError}`}
                  </li>
                ))}
                {view.sync.connectionFailures > 0 && <li>{view.sync.connectionFailures} failed connection(s) in a row</li>}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
