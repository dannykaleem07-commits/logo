import { useDeferredValue, useEffect, useMemo, useState } from 'react';
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
import { activeFilterCount, distinctOptions, filterClaims, handlerOptions as handlerOptionsOf } from './claimsFilter';

/**
 * Claims list with status / handler / insurer filters and the global search term (?q=). Rows carry the at-fault
 * insurer, the handler's name, the outstanding amount (ledger) and the oldest overdue clock (0.3 §E2). Under 640 px the
 * rows become cards and the three drop-down filters sit behind a Filters toggle.
 */
const SEARCH_ID = 'claims-list-search';
const SEARCH_DEBOUNCE_MS = 250;

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

  // The search box keeps its own text: the URL (?q=) follows it after a short pause. Binding the input straight to
  // the URL redrew it with a stale value after every key (cursor jumped to the end, fast typing lost letters).
  const [qDraft, setQDraft] = useState(q);
  useEffect(() => {
    // The URL changed from elsewhere (top bar search, Clear filters, back button): show it, unless the user is typing.
    if (typeof document === 'undefined' || document.activeElement?.id !== SEARCH_ID) setQDraft(q);
  }, [q]);
  useEffect(() => {
    const next = qDraft.trim();
    if (next === q) return;
    const t = window.setTimeout(() => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next) p.set('q', next);
          else p.delete('q');
          return p;
        },
        { replace: true }
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [qDraft, q, setParams]);
  const qFilter = useDeferredValue(qDraft.trim());

  const rows = useMemo(() => filterClaims(claims.data ?? [], { q: qFilter, status, handler, insurer }), [claims.data, qFilter, status, handler, insurer]);
  const handlerOptions = useMemo(() => handlerOptionsOf(claims.data ?? []), [claims.data]);
  const activeFilters = activeFilterCount({ status, handler, insurer });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const insurerOptions = useMemo(() => distinctOptions(claims.data ?? [], (c) => c.atFaultInsurerId, (c) => c.insurerName), [claims.data]);

  const columns: Column<ClaimSummary>[] = [
    { key: 'ref', header: 'Ref', render: (c) => <Link to={`/claims/${c.id}`} className="strong nowrap" onClick={(e) => e.stopPropagation()}>{c.reference}</Link> },
    { key: 'claimant', header: 'Claimant', render: (c) => c.claimantName ?? <span className="muted">{c.claimantId}</span> },
    { key: 'reg', header: 'Reg', render: (c) => (c.registration ? <span className="reg-plate" style={{ fontSize: '0.8em' }}>{formatRegistration(c.registration)}</span> : <span className="muted">—</span>) },
    {
      key: 'status',
      header: 'Status',
      render: (c) => (
        <span className="row" style={{ gap: 6 }}>
          <StatusBadge status={c.status} />
          {(c.openFlags ?? 0) > 0 && (
            <Badge tone="red" dot>
              {c.openFlags} flag{c.openFlags === 1 ? '' : 's'}
            </Badge>
          )}
        </span>
      )
    },
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
        <div className={`form-grid filters-grid ${filtersOpen ? 'filters-open' : 'filters-closed'}`}>
          <div className="filters-search">
            <TextInput id={SEARCH_ID} label="Search" type="search" value={qDraft} onChange={setQDraft} placeholder="Registration, ref or name" />
            <button type="button" className="btn btn-secondary btn-sm filters-toggle" aria-expanded={filtersOpen} aria-controls="claims-filters" onClick={() => setFiltersOpen((o) => !o)}>
              Filters{activeFilters ? ` (${activeFilters})` : ''} {filtersOpen ? '▴' : '▾'}
            </button>
          </div>
          <Select<ClaimStatus> className="filter-extra" label="Status" value={status} onChange={(v) => setParam('status', v)} placeholder="Any status" options={CLAIM_STATUSES.map((s) => ({ value: s, label: claimStatusLabel(s) }))} id="claims-filters" />
          <Select className="filter-extra" label="Handler" value={handler} onChange={(v) => setParam('handler', v)} placeholder="Any handler" options={handlerOptions} />
          <Select className="filter-extra" label="Insurer" value={insurer} onChange={(v) => setParam('insurer', v)} placeholder="Any insurer" options={insurerOptions} />
        </div>
        {claims.isLoading ? (
          <Loading label="Loading claims…" />
        ) : claims.error ? (
          <div style={{ padding: 16 }}>
            <ApiErrorNotice error={claims.error} what="load claims" />
          </div>
        ) : (
          <div className={rows.length ? 'claims-list has-rows' : 'claims-list'}>
          <ul className="claim-cards" aria-label="Claims">
            {rows.map((c) => (
              <li key={c.id}>
                <Link to={`/claims/${c.id}`} className="claim-card">
                  <span className="claim-card-top">
                    <span className="strong">{c.reference}</span>
                    <span className="row" style={{ gap: 6 }}>
                      <StatusBadge status={c.status} />
                      {(c.openFlags ?? 0) > 0 && (
                        <Badge tone="red" dot>
                          {c.openFlags} flag{c.openFlags === 1 ? '' : 's'}
                        </Badge>
                      )}
                    </span>
                  </span>
                  <span className="claim-card-mid">
                    <span>{c.claimantName ?? '—'}</span>
                    {c.registration && (
                      <span className="reg-plate" style={{ fontSize: '0.75em' }}>
                        {formatRegistration(c.registration)}
                      </span>
                    )}
                  </span>
                  <span className="claim-card-bottom">
                    {c.oldestOverdueClock ? <ClockPill clock={c.oldestOverdueClock} /> : <span className="xs muted">Nothing overdue</span>}
                    <span className="xs">
                      Outstanding <Money pence={c.outstandingPence} showPence={false} />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
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
          </div>
        )}
      </Card>
      {rows.some((c) => (c.openFlags ?? 0) > 0) && (
        <p className="xs muted" style={{ marginTop: 8 }}>
          <Badge tone="red" dot>
            flags
          </Badge>{' '}
          means the claim has open warnings to look at — open the claim to see them.
        </p>
      )}
    </div>
  );
}
