import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CompanyWatch } from '@ccguk/domain';
import '../../styles/screens.css';
import { isApiError } from '../../api/client';
import { useAddWatch, usePollWatch, useWatch } from '../../api/hooks';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Select, TextInput } from '../../components/Form';
import { Modal } from '../../components/Modal';
import { EmptyState } from '../../components/EmptyState';
import { Loading } from '../../components/Spinner';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { DateText } from '../../components/DateText';
import { Table, type Column } from '../../components/Table';
import { useToast } from '../../components/Toast';
import { plainText } from '../../lib/plainText';
import { companiesHouseUrl, companyStatusLabel, companyStatusTone, isCompanyNumber, normaliseCompanyNumber, riskTone, sortWatch, strikeOffNotices, supplierRiskBanner, WATCH_ROLES } from './watch';

/** Companies House watch list (BLUEPRINT §3.11, lesson k): status, overdue filings, gazette notices, risk. */
export function WatchPage() {
  const watch = useWatch();
  const poll = usePollWatch();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const rows = sortWatch(watch.data ?? []);
  const banner = supplierRiskBanner(rows);

  const pollNow = async () => {
    try {
      const res = await poll.mutateAsync();
      toast.success(`Polled ${res.polled} compan${res.polled === 1 ? 'y' : 'ies'}; ${res.changed.length} changed`);
    } catch (e) {
      toast.error(isApiError(e) ? `${e.code}: ${e.message}` : (e as Error).message);
    }
  };

  const columns: Column<CompanyWatch>[] = [
    {
      key: 'name',
      header: 'Company',
      render: (w) => (
        <span className="stack-sm" style={{ gap: 2 }}>
          <span className="strong">{w.name}</span>
          <a className="xs mono" href={companiesHouseUrl(w.companyNumber)} target="_blank" rel="noreferrer noopener" title="Open on Companies House">
            {w.companyNumber} ↗
          </a>
        </span>
      )
    },
    { key: 'role', header: 'Role', render: (w) => WATCH_ROLES.find((r) => r.value === w.role)?.label ?? w.role },
    { key: 'status', header: 'Status', render: (w) => <Badge tone={companyStatusTone(w.status)} dot>{companyStatusLabel(w.status)}</Badge> },
    {
      key: 'filings',
      header: 'Filings',
      render: (w) => (
        <span className="stack-sm xs" style={{ gap: 2 }}>
          <span>{w.accountsOverdue ? <span className="bad-mark">✗ accounts overdue</span> : w.accountsOverdue === false ? <span className="ok-mark">✓ accounts</span> : <span className="muted">accounts —</span>}</span>
          <span>{w.confirmationStatementOverdue ? <span className="bad-mark">✗ confirmation statement overdue</span> : w.confirmationStatementOverdue === false ? <span className="ok-mark">✓ confirmation statement</span> : <span className="muted">confirmation statement —</span>}</span>
        </span>
      )
    },
    {
      key: 'gazette',
      header: 'Gazette notices',
      render: (w) => {
        const strike = strikeOffNotices(w);
        return w.gazetteNotices.length === 0 ? (
          <span className="muted">none</span>
        ) : (
          <span className="stack-sm xs" style={{ gap: 2 }}>
            <Badge tone={strike.length ? 'red' : 'amber'}>{w.gazetteNotices.length} notice{w.gazetteNotices.length === 1 ? '' : 's'}</Badge>
            {w.gazetteNotices.slice(0, 3).map((n, i) => (
              <span key={i}>
                <DateText value={n.date} /> · {n.note}
              </span>
            ))}
          </span>
        );
      }
    },
    {
      key: 'risk',
      header: 'Risk',
      render: (w) => (
        <div>
          <Badge tone={riskTone(w.riskLevel)} dot>
            {w.riskLevel}
          </Badge>
          {w.riskReasons.length > 0 && (
            <ul className="risk-reasons">
              {w.riskReasons.map((r, i) => (
                <li key={i}>{plainText(r)}</li>
              ))}
            </ul>
          )}
        </div>
      )
    },
    { key: 'polled', header: 'Last polled', render: (w) => <DateText value={w.lastPolledAt} time /> }
  ];

  return (
    <div className="page">
      <PageHeader
        title="Counterparty watch"
        crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Watch list' }]}
        subtitle="Nightly Companies House poll of every supplier, repairer, engineer and insurer counterparty: status, overdue filings, gazette (strike-off) notices and officer changes."
        actions={
          <>
            <Button onClick={pollNow} loading={poll.isPending}>
              Poll now
            </Button>
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add company
            </Button>
          </>
        }
      />
      {banner && (
        <div className="notice notice-danger" role="alert" style={{ marginBottom: 16 }}>
          <strong>Supplier risk.</strong> {banner}
        </div>
      )}
      <Card flush>
        {watch.isLoading ? (
          <Loading label="Loading watch list…" />
        ) : watch.error ? (
          <div style={{ padding: 16 }}>
            <ApiErrorNotice error={watch.error} what="load the watch list" />
          </div>
        ) : (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(w) => w.companyNumber}
            caption="Companies watched"
            empty={
              <EmptyState title="No companies watched" action={<Button variant="primary" onClick={() => setAdding(true)}>Add the first company</Button>}>
                The seed adds CARFLEX LTD (12640635) as a high-risk supplier. A manual Register of Judgments search (Registry Trust) runs at onboarding and quarterly — record the result in the party's notes.
              </EmptyState>
            }
          />
        )}
      </Card>
      <p className="xs muted" style={{ marginTop: 8 }}>
        Polling needs the Companies House API key (<Link to="/settings">Settings → API keys</Link>). Risk reasons are computed by the API; nothing here edits them.
      </p>
      <AddWatchDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

function AddWatchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const add = useAddWatch();
  const toast = useToast();
  const [companyNumber, setCompanyNumber] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<CompanyWatch['role'] | ''>('supplier');
  const [error, setError] = useState<string | null>(null);
  const valid = isCompanyNumber(companyNumber) && role !== '';
  const submit = async () => {
    if (!valid || !role) return;
    setError(null);
    try {
      const w = await add.mutateAsync({ companyNumber: normaliseCompanyNumber(companyNumber), name: name.trim() || undefined, role });
      toast.success(`${w.name || normaliseCompanyNumber(companyNumber)} added to the watch list`);
      setCompanyNumber('');
      setName('');
      onClose();
    } catch (e) {
      setError(isApiError(e) ? `${e.code}: ${e.message}` : (e as Error).message);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add a company to the watch list" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={!valid} loading={add.isPending}>Add and poll</Button></>}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextInput label="Companies House number" value={companyNumber} onChange={setCompanyNumber} placeholder="12640635" required inputClassName="mono" error={companyNumber && !isCompanyNumber(companyNumber) ? 'Eight characters: 8 digits or a 2-letter prefix + 6 digits' : undefined} hint="The API fetches the profile; the name below is only a label until then." autoFocus />
        <TextInput label="Name (optional)" value={name} onChange={setName} placeholder="As registered" />
        <Select<CompanyWatch['role']> label="Role" value={role} onChange={setRole} options={WATCH_ROLES} required />
        {error && (
          <div className="notice notice-danger" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="sr-only" tabIndex={-1}>
          Add
        </button>
      </form>
    </Modal>
  );
}
