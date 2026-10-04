import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { ClaimStatus } from '@ccguk/domain';
import { formatRegistration } from '@ccguk/domain';
import { useClaims } from '../../api/hooks';
import type { ClaimSummary } from '../../api/client';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { Table, type Column } from '../../components/Table';
import { StatusBadge, Badge } from '../../components/Badge';
import { Money } from '../../components/Money';
import { ClockPill } from '../../components/ClockPill';
import { Select, TextInput } from '../../components/Form';
import { Loading } from '../../components/Spinner';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { EmptyState } from '../../components/EmptyState';
import { CLAIM_STATUSES, claimStatusLabel } from '../../lib/status';
import { filterClaims, distinctOptions } from './claimsFilter';

/** Claims list with status / handler / insurer filters and the global search term (?q=). */
export function ClaimsListPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get('q') ?? '';
  const status = (params.get('status') ?? '') as ClaimStatus | '';
  const handler = params.get('handler') ?? '';
  const insurer = params.get('insurer') ?? '';

  // Server-side filters are passed through; the same filters are applied client-side so the list is right
  // even against an API build that ignores a query parameter.
  const claims = useClaims({ q: q || undefined, status: status || undefined, handlerId: handler || undefined, insurerId: insurer || undefined });

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const rows = useMemo(() => filterClaims(claims.data ?? [], { q, status, handler, insurer }), [claims.data, q, status, handler, insurer]);
  const handlerOptions = useMemo(() => distinctOptions(claims.data ?? [], (c) => c.handlerId, (c) => c.handlerName), [claims.data]);
  const insurerOptions = useMemo(() => distinctOptions(claims.data ?? [], (c) => c.atFaultInsurerId, (c) => c.insurerName), [claims.data]);

  const columns: Column<ClaimSummary>[] = [
    { key: 'ref', header: 'Ref', render: (c) => <Link to={`/claims/${c.id}`} className="strong nowrap" onClick={(e) => e.stopPropagation()}>{c.reference}</Link> },
    { key: 'claimant', header: 'Claimant', render: (c) => c.claimantName ?? <span className="muted">{c.claimantId}</span> },
    { key: 'reg', header: 'Reg', render: (c) => (c.registration ? <span className="reg-plate" style={{ fontSize: '0.8em' }}>{formatRegistration(c.registration)}</span> : <span className="muted">—</span>) },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
    { key: 'insurer', header: 'Insurer', render: (c) => c.insurerName ?? (c.atFaultInsurerId ? <span className="muted">{c.atFaultInsurerId}</span> : <span className="muted">—</span>) },
    { key: 'outstanding', header: 'Outstanding', numeric: true, render: (c) => <Money pence={c.outstandingPence} showPence={false} /> },
    {
      key: 'clock',
      header: 'Oldest overdue clock',
      render: (c) =>
        c.oldestOverdueClock ? (
          <span className="row" style={{ gap: 6 }}>
            <ClockPill clock={c.oldestOverdueClock} />
            <span className="xs muted">{c.oldestOverdueClock.label}</span>
          </span>
        ) : c.nextDueClock ? (
          <span className="row" style={{ gap: 6 }}>
            <ClockPill clock={c.nextDueClock} />
            <span className="xs muted">{c.nextDueClock.label}</span>
          </span>
        ) : (
          <span className="muted">—</span>
        )
    }
  ];

  return (
    <div className="page">
      <PageHeader
        title="Claims"
        subtitle={claims.data ? `${rows.length} of ${claims.data.length} claims` : undefined}
        actions={
          <Link className="btn btn-primary" to="/claims/new">
            New claim
          </Link>
        }
      />
      <Card flush>
        <div className="form-grid filters-grid">
          <TextInput label="Search" type="search" value={q} onChange={(v) => setParam('q', v)} placeholder="Registration, ref or name" />
          <Select<ClaimStatus> label="Status" value={status} onChange={(v) => setParam('status', v)} placeholder="Any status" options={CLAIM_STATUSES.map((s) => ({ value: s, label: claimStatusLabel(s) }))} />
          <Select label="Handler" value={handler} onChange={(v) => setParam('handler', v)} placeholder="Any handler" options={handlerOptions} />
          <Select label="Insurer" value={insurer} onChange={(v) => setParam('insurer', v)} placeholder="Any insurer" options={insurerOptions} />
        </div>
        {claims.isLoading ? (
          <Loading label="Loading claims…" />
        ) : claims.error ? (
          <div style={{ padding: 16 }}>
            <ApiErrorNotice error={claims.error} what="load claims" />
          </div>
        ) : (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(c) => c.id}
            onRowClick={(c) => navigate(`/claims/${c.id}`)}
            caption="Claims"
            empty={
              (claims.data?.length ?? 0) === 0 ? (
                <EmptyState title="No claims yet" action={<Link className="btn btn-primary" to="/claims/new">Open the first claim</Link>} />
              ) : (
                <EmptyState title="No claims match these filters">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setParams({}, { replace: true })}>
                    Clear filters
                  </button>
                </EmptyState>
              )
            }
          />
        )}
      </Card>
      {rows.some((c) => (c.openFlags ?? 0) > 0) && (
        <p className="xs muted" style={{ marginTop: 8 }}>
          <Badge tone="red" dot>
            hard stop
          </Badge>{' '}
          marks a claim with an uncleared block flag (duplicate registration, fleet unit as client vehicle, legacy detail).
        </p>
      )}
    </div>
  );
}
