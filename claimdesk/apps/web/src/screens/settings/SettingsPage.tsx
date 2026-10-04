import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import '../../styles/screens.css';
import { isApiError } from '../../api/client';
import { useSettings, useUpdateSettings } from '../../api/hooks';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { MoneyInput, TextArea, TextInput } from '../../components/Form';
import { EmptyState } from '../../components/EmptyState';
import { Loading } from '../../components/Spinner';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { Table, type Column } from '../../components/Table';
import { useToast } from '../../components/Toast';
import { API_KEYS, apiKeyPresent, buildSettingsPatch, COMPANY_NAME, COMPANY_NUMBER, confirmationOfPayeeCheck, ROLE_LABEL, settingsToForm, usersFrom, validateSettings, type SettingsErrors, type SettingsForm, type UserRow } from './settings';

/** Company details, bank (Confirmation of Payee), rate card, API key presence and the read-only users list. */
export function SettingsPage() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const toast = useToast();
  const [form, setForm] = useState<SettingsForm>(() => settingsToForm(undefined));
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data && !dirty) setForm(settingsToForm(settings.data));
  }, [settings.data, dirty]);

  const set = <K extends keyof SettingsForm>(k: K) => (v: SettingsForm[K]) => {
    setDirty(true);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const cop = confirmationOfPayeeCheck(form.bankAccountName);

  const save = async () => {
    const e = validateSettings(form);
    setErrors(e);
    if (Object.keys(e).length > 0) {
      toast.error('Fix the highlighted fields before saving');
      return;
    }
    setServerError(null);
    try {
      await update.mutateAsync(buildSettingsPatch(form));
      setDirty(false);
      toast.success('Settings saved');
    } catch (err) {
      setServerError(isApiError(err) ? `${err.code}: ${err.message}` : (err as Error).message);
    }
  };

  const users = usersFrom(settings.data);
  const userColumns: Column<UserRow>[] = [
    { key: 'name', header: 'Name', render: (u) => u.name },
    { key: 'email', header: 'Email', render: (u) => u.email },
    { key: 'role', header: 'Role', render: (u) => <Badge tone={u.role === 'admin' ? 'navy' : u.role === 'approver' ? 'blue' : 'grey'}>{ROLE_LABEL[u.role] ?? u.role}</Badge> },
    { key: 'mfa', header: 'MFA', render: (u) => (u.mfaEnabled ? <span className="ok-mark">✓ on</span> : <Badge tone="amber">off</Badge>) }
  ];

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        subtitle={`${COMPANY_NAME} · company number ${COMPANY_NUMBER} · registered in England and Wales`}
        actions={
          <>
            <Link className="btn btn-secondary" to="/watch">
              Counterparty watch
            </Link>
            <Button variant="primary" onClick={save} loading={update.isPending} disabled={!dirty}>
              Save settings
            </Button>
          </>
        }
      />
      {settings.isLoading ? (
        <Loading label="Loading settings…" />
      ) : settings.error ? (
        <ApiErrorNotice error={settings.error} what="load settings" />
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {serverError && (
            <div className="notice notice-danger" role="alert">
              {serverError}
            </div>
          )}
          <div className="grid-2">
            <Card title="Company details">
              <div className="stack">
                <TextInput label="Registered name" value={COMPANY_NAME} onChange={() => undefined} disabled hint="Fixed. The legacy trading name, company number, address and domain are blocked everywhere (lesson i)." />
                <TextInput label="Company number" value={COMPANY_NUMBER} onChange={() => undefined} disabled />
                <TextArea label="Registered office" value={form.registeredOffice} onChange={set('registeredOffice')} rows={3} error={errors.registeredOffice} hint="Printed in every document footer (Companies Act 2006 Part 6 trading disclosures). Never a legacy address." />
                <TextInput label="VAT registration number" value={form.vatNumber} onChange={set('vatNumber')} placeholder="GB123456789 (blank if not registered)" error={errors.vatNumber} />
                <TextInput label="ICO registration reference" value={form.icoRegistration} onChange={set('icoRegistration')} placeholder="ZA123456" error={errors.icoRegistration} hint="Data protection fee registration — required to hold client and third-party personal data." />
              </div>
            </Card>

            <Card title="Bank account (Confirmation of Payee)">
              <div className="stack">
                {!cop.match && (
                  <div className="notice notice-danger" role="alert">
                    <strong>Confirmation of Payee warning.</strong> {cop.message}
                  </div>
                )}
                {cop.match && (
                  <div className="notice notice-success">
                    <strong>Full match expected.</strong> Account name equals the registered name exactly.
                  </div>
                )}
                <TextInput label="Account name" value={form.bankAccountName} onChange={set('bankAccountName')} placeholder={COMPANY_NAME} required error={errors.bankAccountName} hint={`Must be exactly "${COMPANY_NAME}" — a trading name here is what broke File 1's bank validation.`} />
                <div className="form-grid">
                  <TextInput label="Sort code" value={form.bankSortCode} onChange={set('bankSortCode')} placeholder="12-34-56" inputMode="numeric" error={errors.bankSortCode} />
                  <TextInput label="Account number" value={form.bankAccountNumber} onChange={set('bankAccountNumber')} placeholder="12345678" inputMode="numeric" error={errors.bankAccountNumber} />
                </div>
                <TextInput label="Bank" value={form.bankName} onChange={set('bankName')} error={errors.bankName} />
                <p className="basis">Vendor verification pack (BLUEPRINT §7.7): bank letter on bank letterhead, certificate of incorporation ({COMPANY_NUMBER}), proof of registered office, director ID. Generate it from a claim file → Documents → <code>letter.vendor_verification_pack</code>.</p>
              </div>
            </Card>

            <Card title="Rate card">
              <div className="stack">
                <p className="basis">Defaults from the brief: recovery £90 call-out + £3 per loaded mile + £25 admin; storage £45/day; engineer's fee £285. Invoices and the ledger read these; templates never accept free-typed amounts.</p>
                <div className="form-grid">
                  <MoneyInput label="Recovery call-out" value={form.recoveryCalloutPence} onChange={set('recoveryCalloutPence')} error={errors.recoveryCalloutPence} />
                  <MoneyInput label="Recovery per loaded mile" value={form.recoveryPerLoadedMilePence} onChange={set('recoveryPerLoadedMilePence')} error={errors.recoveryPerLoadedMilePence} />
                  <MoneyInput label="Recovery admin" value={form.recoveryAdminPence} onChange={set('recoveryAdminPence')} error={errors.recoveryAdminPence} />
                  <MoneyInput label="Storage per day" value={form.storageDailyPence} onChange={set('storageDailyPence')} error={errors.storageDailyPence} hint="Insurers commonly cap at engineer's report + 48 h (File 2)." />
                  <MoneyInput label="Engineer's fee" value={form.engineerFeePence} onChange={set('engineerFeePence')} error={errors.engineerFeePence} />
                  <TextInput label="VAT rate (%)" value={form.vatRatePct} onChange={set('vatRatePct')} placeholder="20" inputMode="decimal" error={errors.vatRatePct} />
                </div>
                <p className="xs muted">GTA daily rates are not set here: they are an industry benchmark loaded from the knowledge base with their verification status (CCGUK is not a subscriber).</p>
              </div>
            </Card>

            <Card title="API keys" flush>
              <ul className="key-list">
                {API_KEYS.map((k) => {
                  const present = apiKeyPresent(settings.data, k.key);
                  return (
                    <li key={k.key}>
                      <div className="key-name">
                        {k.label}
                        <div className="xs muted">{k.unlocks}</div>
                        <div className="key-env">{k.env}</div>
                      </div>
                      <div className="stack-sm" style={{ alignItems: 'flex-end', gap: 4 }}>
                        {present === undefined ? <Badge tone="grey">unknown</Badge> : present ? <Badge tone="green" dot>present</Badge> : <Badge tone="amber" dot>missing → manual entry</Badge>}
                        <span className="xs muted">{k.cost}</span>
                        {k.registerUrl ? (
                          <a className="xs" href={k.registerUrl} target="_blank" rel="noreferrer noopener" title={k.registerNote}>
                            Register ↗
                          </a>
                        ) : (
                          <span className="xs muted" title={k.registerNote}>
                            licensed gateway
                          </span>
                        )}
                      </div>
                      <div className="xs muted" style={{ flexBasis: '100%' }}>
                        {k.registerNote}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="card-footer xs muted">Keys live in the API's environment, never in the browser. Without a key the matching lookup returns <code>manual_required</code> and the entry is recorded as unverified.</div>
            </Card>
          </div>

          <Card title="Users and roles" actions={<Badge tone="grey">read-only</Badge>} flush>
            {users.length === 0 ? (
              <EmptyState title="User management arrives with authentication">
                Roles: handler (runs files), approver (clears consistency flags and approves documents), engineer (estimates, PAV, reports), admin (settings). MFA is required for every role (BLUEPRINT §9).
              </EmptyState>
            ) : (
              <Table columns={userColumns} rows={users} rowKey={(u) => u.id} caption="Users" />
            )}
          </Card>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {dirty && <span className="xs muted">Unsaved changes</span>}
            <Button variant="primary" type="submit" loading={update.isPending} disabled={!dirty}>
              Save settings
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
