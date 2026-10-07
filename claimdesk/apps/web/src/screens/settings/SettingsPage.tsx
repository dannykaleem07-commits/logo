import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import '../../styles/screens.css';
import './settings.css';
import { isApiError } from '../../api/client';
import { useSettings, useUpdateSettings } from '../../api/hooks';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { MoneyInput, TextArea, TextInput } from '../../components/Form';
import { Loading } from '../../components/Spinner';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { Table, type Column } from '../../components/Table';
import { useToast } from '../../components/Toast';
import { ChangePasswordCard } from './ChangePasswordCard';
import { ManagerModeCard } from './ManagerModeCard';
import { UpdatesCard } from './UpdatesCard';
import { ImportFolderCard } from './ImportFolderCard';
import {
  API_KEYS,
  apiKeyPresent,
  buildSettingsPatch,
  COMPANY_DETAILS,
  COMPANY_NAME,
  COMPANY_NUMBER,
  confirmationOfPayeeCheck,
  lookupModeLabel,
  lookupModeOf,
  lookupsSummary,
  ROLE_LABEL,
  sectionFromHash,
  SETTINGS_SECTIONS,
  settingsToForm,
  showUsersCard,
  usersFrom,
  validateSettings,
  type SettingsErrors,
  type SettingsForm,
  type UserRow
} from './settings';

const FORM_ID = 'settings-form';

/**
 * Settings (0.3 §E15): a sub-nav of anchors, then Company · Bank · Rates (one form, one sticky Save) · Manager mode ·
 * Updates · Lookups (one status line, details on click) · Users (only when there are any) · Password.
 */
export function SettingsPage() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const toast = useToast();
  const location = useLocation();
  const [form, setForm] = useState<SettingsForm>(() => settingsToForm(undefined));
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const lookupsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (settings.data && !dirty) setForm(settingsToForm(settings.data));
  }, [settings.data, dirty]);

  // Anchors (#updates from the side-bar notice, the sub-nav): scroll once the section exists; #lookups opens itself.
  const loaded = Boolean(settings.data) || Boolean(settings.error);
  useEffect(() => {
    const id = sectionFromHash(location.hash);
    if (!id) return;
    if (id === 'lookups' && lookupsRef.current) lookupsRef.current.open = true;
    const el = document.getElementById(id);
    el?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [location.hash, loaded]);

  const set = <K extends keyof SettingsForm>(k: K) => (v: SettingsForm[K]) => {
    setDirty(true);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const cop = confirmationOfPayeeCheck(form.bankAccountName);
  const lookupMode = lookupModeOf(settings.data);

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
      setServerError(isApiError(err) ? err.message : (err as Error).message);
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
    <div className="page settings-page">
      <PageHeader
        title="Settings"
        subtitle={`${COMPANY_NAME} · company number ${COMPANY_NUMBER} · registered in England and Wales`}
        actions={
          <Link className="btn btn-secondary" to="/watch">
            Counterparty watch
          </Link>
        }
      />
      <nav aria-label="Settings sections">
        <ul className="settings-subnav">
          {SETTINGS_SECTIONS.map((s) => (
            <li key={s.label}>{s.to ? <Link to={s.to}>{s.label}</Link> : <Link to={{ hash: s.id }}>{s.label}</Link>}</li>
          ))}
        </ul>
      </nav>

      {/* ClaimDesk Supreme (docs/SUPREME-DESIGN.md §L.6–L.10): each screen is built by its own slice. */}
      <Card title="Agents & AI">
        <ul className="settings-subnav" aria-label="Agents and AI settings">
          <li><Link to="/settings/ai">AI (Claude sign-in and models)</Link></li>
          <li><Link to="/settings/email">Email (IONOS mailbox)</Link></li>
          <li><Link to="/settings/autonomy">Autonomy</Link></li>
          <li><Link to="/settings/notifications">Notifications</Link></li>
          <li><Link to="/settings/brain">Brain packs</Link></li>
        </ul>
      </Card>

      {settings.isLoading ? (
        <Loading label="Loading settings…" />
      ) : settings.error ? (
        <ApiErrorNotice error={settings.error} what="load settings" />
      ) : (
        <form
          id={FORM_ID}
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
            <Card id="company" title="Company details">
              <div className="stack">
                <TextInput label="Registered name" value={COMPANY_NAME} onChange={() => undefined} disabled hint="Fixed. Old trading names, company numbers, addresses and web addresses are blocked everywhere." />
                <TextInput label="Company number" value={COMPANY_NUMBER} onChange={() => undefined} disabled hint={`Registered in England & Wales. Trading as ${COMPANY_DETAILS.tradingName}.`} />
                <TextArea label="Registered office" value={form.registeredOffice} onChange={set('registeredOffice')} rows={4} error={errors.registeredOffice} hint={`One part per line, postcode last. Printed in every document footer. Default: ${COMPANY_DETAILS.registeredOffice}.`} />
                <dl className="xs" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px', margin: 0 }}>
                  {(
                    [
                      ['Case handler', COMPANY_DETAILS.caseHandlerPhone],
                      ['Office', COMPANY_DETAILS.officePhone],
                      ['Email', COMPANY_DETAILS.claimsEmail],
                      ['Website', COMPANY_DETAILS.website],
                      ['Director', COMPANY_DETAILS.director]
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} style={{ display: 'contents' }}>
                      <dt className="muted">{label}</dt>
                      <dd style={{ margin: 0 }}>{value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="xs muted">These contact details print on every letter and document. Bank, VAT and ICO numbers are not pre-filled: enter them when you have them.</p>
                <TextInput label="VAT registration number" value={form.vatNumber} onChange={set('vatNumber')} placeholder="GB123456789 (blank if not registered)" error={errors.vatNumber} />
                <TextInput label="ICO registration reference" value={form.icoRegistration} onChange={set('icoRegistration')} placeholder="ZA123456" error={errors.icoRegistration} hint="Data protection fee registration — required to hold client and third-party personal data." />
              </div>
            </Card>

            <Card id="bank" title="Bank account (Confirmation of Payee)">
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
                <TextInput label="Account name" value={form.bankAccountName} onChange={set('bankAccountName')} placeholder={COMPANY_NAME} required error={errors.bankAccountName} hint={`Must be exactly "${COMPANY_NAME}" — a trading name here makes insurers' bank validation fail.`} />
                <div className="form-grid">
                  <TextInput label="Sort code" value={form.bankSortCode} onChange={set('bankSortCode')} placeholder="12-34-56" inputMode="numeric" error={errors.bankSortCode} />
                  <TextInput label="Account number" value={form.bankAccountNumber} onChange={set('bankAccountNumber')} placeholder="12345678" inputMode="numeric" error={errors.bankAccountNumber} />
                </div>
                <TextInput label="Bank" value={form.bankName} onChange={set('bankName')} error={errors.bankName} />
                <p className="basis">Insurers may ask for a vendor verification pack: a bank letter on bank letterhead, the certificate of incorporation ({COMPANY_NUMBER}), proof of the registered office and the director's ID. Make it from a claim file → Documents → New document.</p>
              </div>
            </Card>

            <Card id="rates" title="Rate card">
              <div className="stack">
                <p className="basis">Defaults: recovery £90 call-out + £3 per loaded mile + £25 admin; storage £45/day; engineer's fee £285. Invoices and the ledger use these.</p>
                <div className="form-grid">
                  <MoneyInput label="Recovery call-out" value={form.recoveryCalloutPence} onChange={set('recoveryCalloutPence')} error={errors.recoveryCalloutPence} />
                  <MoneyInput label="Recovery per loaded mile" value={form.recoveryPerLoadedMilePence} onChange={set('recoveryPerLoadedMilePence')} error={errors.recoveryPerLoadedMilePence} />
                  <MoneyInput label="Recovery admin" value={form.recoveryAdminPence} onChange={set('recoveryAdminPence')} error={errors.recoveryAdminPence} />
                  <MoneyInput label="Storage per day" value={form.storageDailyPence} onChange={set('storageDailyPence')} error={errors.storageDailyPence} hint="Insurers commonly cap storage at the engineer's report + 48 hours." />
                  <MoneyInput label="Engineer's fee" value={form.engineerFeePence} onChange={set('engineerFeePence')} error={errors.engineerFeePence} />
                  <TextInput label="VAT rate (%)" value={form.vatRatePct} onChange={set('vatRatePct')} placeholder="20" inputMode="decimal" error={errors.vatRatePct} />
                </div>
                <p className="xs muted">
                  GTA daily rates are not set here: they are an industry benchmark with their verification status (CCGUK is not a subscriber) — see <Link to="/settings/gta-rates">GTA rates</Link>.
                </p>
              </div>
            </Card>
          </div>
        </form>
      )}

      {/* Outside the settings <form> (forms cannot nest; these cards save themselves) and shown even when settings fail to load. */}
      <div className="stack" style={{ marginTop: 'var(--s-4)' }}>
        <ManagerModeCard />
        <UpdatesCard id="updates" />
        <ImportFolderCard />

        <section className="card" id="lookups">
          <details className="settings-lookups" ref={lookupsRef}>
            <summary>{lookupsSummary(settings.data)}</summary>
            <div className={`notice ${lookupMode === 'live' ? 'notice-success' : 'notice-info'}`} role="status" style={{ margin: '0 var(--s-3) var(--s-3)' }}>
              {lookupModeLabel(lookupMode)}
            </div>
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
                      {present === undefined ? <Badge tone="grey">unknown</Badge> : present ? <Badge tone="green" dot>set</Badge> : <Badge tone="amber" dot>not set → manual entry</Badge>}
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
            <div className="card-footer xs muted">Keys live on this computer's ClaimDesk set-up, never in the browser. Without a key you type the details in yourself and they are recorded as unverified.</div>
          </details>
        </section>

        {showUsersCard(settings.data) && (
          <Card title="Users and roles" actions={<Badge tone="grey">read-only</Badge>} flush>
            <Table columns={userColumns} rows={users} rowKey={(u) => u.id} caption="Users" />
          </Card>
        )}

        <div id="password" className="grid-2 settings-password">
          <ChangePasswordCard />
        </div>
      </div>

      {!settings.isLoading && !settings.error && (
        <div className="settings-savebar" role="region" aria-label="Save settings">
          {dirty ? <span className="xs muted">Unsaved changes</span> : <span className="xs muted">Company, bank and rates</span>}
          <Button variant="primary" type="submit" form={FORM_ID} loading={update.isPending} disabled={!dirty}>
            Save settings
          </Button>
        </div>
      )}
    </div>
  );
}
