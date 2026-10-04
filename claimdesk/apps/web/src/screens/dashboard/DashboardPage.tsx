import { Link } from 'react-router-dom';
import { useDashboardData } from '../../api/hooks';
import type { DashboardClock } from '../../api/client';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Loading, Spinner } from '../../components/Spinner';
import { ClockPill } from '../../components/ClockPill';
import { PriorityBadge, Badge, DocumentStatusBadge } from '../../components/Badge';
import { Money } from '../../components/Money';
import { DateText } from '../../components/DateText';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { Table, type Column } from '../../components/Table';
import { groupByClaim } from '../../lib/clocks';
import type { DebtorDaysSummary } from '../../api/client';

/**
 * Dashboard: what needs doing today. Every number comes from the API (overview with per-claim fallback);
 * nothing is computed from local assumptions.
 */
export function DashboardPage() {
  const now = new Date();
  const dash = useDashboardData(now);
  const openClaims = dash.claims.filter((c) => !['settled', 'closed', 'declined'].includes(c.status)).length;
  const overdueGroups = groupByClaim(dash.clocksOverdue);
  const todayGroups = groupByClaim(dash.clocksToday);
  const refFor = (c: DashboardClock) => c.claimReference ?? dash.claims.find((x) => x.id === c.claimId)?.reference ?? c.claimId;

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        subtitle={
          <>
            <DateText value={now.toISOString()} long /> · {openClaims} open claim{openClaims === 1 ? '' : 's'}
            {dash.usingFallback && dash.isFetchingFallback && (
              <span style={{ marginLeft: 8 }}>
                <Spinner /> refreshing clocks
              </span>
            )}
          </>
        }
        actions={
          <Link className="btn btn-primary" to="/claims/new">
            New claim
          </Link>
        }
      />

      {dedupeErrors(dash.errors).map((e, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          <ApiErrorNotice error={e} what="load the dashboard" />
        </div>
      ))}

      <div className="grid-4" style={{ marginBottom: 20 }}>
        <Link to="#clocks" className="stat">
          <span className="stat-label">Clocks overdue</span>
          <span className={`stat-value ${dash.clocksOverdue.length ? 'red' : ''}`}>{dash.isLoading ? '…' : dash.clocksOverdue.length}</span>
          <span className="stat-sub">{dash.clocksToday.length} due today</span>
        </Link>
        <Link to="#blocked-documents" className="stat">
          <span className="stat-label">Blocked documents</span>
          <span className={`stat-value ${dash.blockedDocuments.length ? 'red' : ''}`}>{dash.isLoading ? '…' : dash.blockedDocuments.length}</span>
          <span className="stat-sub">need a flag cleared by a person</span>
        </Link>
        <Link to="#debtor-days" className="stat">
          <span className="stat-label">Debtor days</span>
          <span className="stat-value">{dash.debtorDays?.overallDays ?? '—'}</span>
          <span className="stat-sub">
            outstanding <Money pence={dash.debtorDays?.outstandingPence ?? dash.overview?.outstandingPence} showPence={false} />
          </span>
        </Link>
        <Link to="/fleet" className="stat">
          <span className="stat-label">Fleet alerts</span>
          <span className={`stat-value ${dash.fleetAlertCount ? 'amber' : ''}`}>{dash.fleetAlertCount}</span>
          <span className="stat-sub">MOT · tax · insurance · keeper address · cover</span>
        </Link>
      </div>

      <div className="grid-2">
        <Card id="clocks" title="Clocks" actions={<Badge tone={dash.clocksOverdue.length ? 'red' : 'grey'}>{dash.clocksOverdue.length} overdue</Badge>} flush>
          {dash.isLoading ? (
            <Loading />
          ) : overdueGroups.size === 0 && todayGroups.size === 0 ? (
            <EmptyState title="Nothing due today" icon="✓">
              No running clock is due or overdue. New clocks derive from each event you log.
            </EmptyState>
          ) : (
            <ul className="list">
              {[...overdueGroups.entries()].map(([claimId, clocks]) => (
                <ClockGroup key={`o-${claimId}`} claimId={claimId} reference={refFor(clocks[0]!)} clocks={clocks} now={now} tone="red" />
              ))}
              {[...todayGroups.entries()].map(([claimId, clocks]) => (
                <ClockGroup key={`t-${claimId}`} claimId={claimId} reference={refFor(clocks[0]!)} clocks={clocks} now={now} tone="amber" />
              ))}
            </ul>
          )}
        </Card>

        <Card id="blocked-documents" title="Blocked documents" actions={<Badge tone={dash.blockedDocuments.length ? 'red' : 'grey'}>{dash.blockedDocuments.length}</Badge>} flush>
          {dash.isLoading ? (
            <Loading />
          ) : dash.blockedDocuments.length === 0 ? (
            <EmptyState title="No blocked documents" icon="✓">
              Drafts the consistency engine has blocked appear here until each flag is cleared with a reason.
            </EmptyState>
          ) : (
            <ul className="list">
              {dash.blockedDocuments.map((d) => (
                <li key={d.id}>
                  <div className="list-main">
                    <div className="list-title">
                      <Link to={d.claimId ? `/claims/${d.claimId}/documents` : '#'}>{d.title}</Link>
                    </div>
                    <div className="list-sub">
                      {d.claimReference ?? d.claimId} · {d.templateId || 'document'} · <DateText value={d.createdAt} time />
                      {d.blockedFlags ? ` · ${d.blockedFlags} block flag${d.blockedFlags === 1 ? '' : 's'}` : ''}
                    </div>
                  </div>
                  <DocumentStatusBadge status={d.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Next actions" actions={<span className="muted small">get-paid-faster playbook (§7)</span>} flush>
          {dash.isLoading ? (
            <Loading />
          ) : dash.nextActions.length === 0 ? (
            <EmptyState title="No actions queued">Playbook actions appear once a claim has services agreed.</EmptyState>
          ) : (
            <ul className="list">
              {dash.nextActions.slice(0, 25).map((a, i) => (
                <li key={`${a.claimId}-${a.code}-${i}`}>
                  <div className="list-main">
                    <div className="list-title">
                      <Link to={`/claims/${a.claimId}/actions`}>{a.title}</Link>
                      {a.blockedBy && a.blockedBy.length > 0 && (
                        <Badge tone="amber" className="small" title={`Blocked by: ${a.blockedBy.join(', ')}`}>
                          blocked
                        </Badge>
                      )}
                    </div>
                    <div className="list-sub">
                      {a.claimReference ?? a.claimId} · {a.why}
                      {a.dueAt ? (
                        <>
                          {' '}
                          · due <DateText value={a.dueAt} time />
                        </>
                      ) : null}
                      {a.valuePence ? (
                        <>
                          {' '}
                          · protects <Money pence={a.valuePence} showPence={false} />
                        </>
                      ) : null}
                    </div>
                  </div>
                  <PriorityBadge priority={a.priority} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card id="debtor-days" title="Debtor days" flush>
          {dash.isLoading ? <Loading /> : <DebtorDays summary={dash.debtorDays} />}
        </Card>
      </div>
    </div>
  );
}

/** The dashboard fans out to several routes; when the API is down they all fail the same way, so show it once. */
function dedupeErrors(errors: Error[]): Error[] {
  const seen = new Set<string>();
  return errors.filter((e) => {
    const key = `${e.name}:${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ClockGroup({ claimId, reference, clocks, now, tone }: { claimId: string; reference: string; clocks: DashboardClock[]; now: Date; tone: 'red' | 'amber' }) {
  return (
    <li>
      <div className="list-main">
        <div className="list-title">
          <Link to={`/claims/${claimId}/clocks`}>{reference}</Link>
          {clocks[0]?.claimantName && <span className="muted small"> · {clocks[0].claimantName}</span>}
        </div>
        <div className="stack-sm" style={{ marginTop: 6 }}>
          {clocks.map((c) => (
            <div key={c.id} className="row" style={{ gap: 8 }}>
              <ClockPill clock={c} now={now} />
              <span className="small">{c.label}</span>
              {c.attributableTo && (
                <span className="xs muted">on {c.attributableTo}</span>
              )}
            </div>
          ))}
        </div>
      </div>
      <Badge tone={tone}>{clocks.length}</Badge>
    </li>
  );
}

function DebtorDays({ summary }: { summary: DebtorDaysSummary | undefined }) {
  const rows = summary?.byInsurer ?? [];
  if (!summary || (rows.length === 0 && summary.overallDays === undefined)) {
    return <EmptyState title="No debtor data yet">Debtor days are computed from paid vs claimed ledger entries once payment packs are sent.</EmptyState>;
  }
  type Row = NonNullable<DebtorDaysSummary['byInsurer']>[number];
  const columns: Column<Row>[] = [
    { key: 'insurer', header: 'Insurer', render: (r) => r.insurerName },
    { key: 'claims', header: 'Claims', numeric: true, render: (r) => r.claims },
    { key: 'days', header: 'Days', numeric: true, render: (r) => r.days },
    { key: 'outstanding', header: 'Outstanding', numeric: true, render: (r) => <Money pence={r.outstandingPence} showPence={false} /> }
  ];
  return (
    <>
      <div className="row-between" style={{ padding: '12px 20px' }}>
        <span className="small muted">Overall</span>
        <span>
          <strong>{summary.overallDays ?? '—'} days</strong> · <Money pence={summary.outstandingPence} showPence={false} />
        </span>
      </div>
      {rows.length > 0 && <Table columns={columns} rows={rows} rowKey={(r) => r.insurerId ?? r.insurerName} />}
    </>
  );
}
