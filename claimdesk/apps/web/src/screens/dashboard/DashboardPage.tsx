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
import { actionGroupTitle, clockRowsByClaim, groupActions, type ActionGroup, type ClockRow } from './dashboard';
import './dashboard.css';
import type { DebtorDaysSummary } from '../../api/client';

/**
 * Dashboard: what needs doing today. Every number comes from the API (overview with per-claim fallback);
 * nothing is computed from local assumptions.
 */
export function DashboardPage() {
  const now = new Date();
  const dash = useDashboardData(now);
  const openClaims = dash.claims.filter((c) => !['settled', 'closed', 'declined'].includes(c.status)).length;
  const clockRows = clockRowsByClaim(dash.clocksOverdue, dash.clocksToday);
  const actionGroups = groupActions(dash.nextActions).slice(0, 25);
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

      <div className="grid-4 kpi-grid" style={{ marginBottom: 20 }}>
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
          ) : clockRows.length === 0 ? (
            <EmptyState title="Nothing due today" icon="✓">
              No running clock is due or overdue. New clocks derive from each event you log.
            </EmptyState>
          ) : (
            <ul className="list">
              {clockRows.map((row) => (
                <ClockLine key={row.claimId} row={row} reference={refFor(row.worst)} now={now} />
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
                      {d.claimReference ?? d.claimId} · <DateText value={d.createdAt} time />
                      {d.blockedFlags ? ` · ${d.blockedFlags} block flag${d.blockedFlags === 1 ? '' : 's'}` : ''}
                    </div>
                  </div>
                  <DocumentStatusBadge status={d.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Next actions" actions={<span className="muted small">most urgent first</span>} flush>
          {dash.isLoading ? (
            <Loading />
          ) : actionGroups.length === 0 ? (
            <EmptyState title="No actions queued">Actions appear once a claim has services agreed.</EmptyState>
          ) : (
            <ul className="list">
              {actionGroups.map((g) => (
                <ActionLine key={g.key} group={g} />
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

/** One claim: its worst clock, and "+n more" for the rest (all on the claim's Clocks tab). */
function ClockLine({ row, reference, now }: { row: ClockRow; reference: string; now: Date }) {
  const c = row.worst;
  return (
    <li className="dash-line">
      <div className="list-main">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Link to={`/claims/${row.claimId}/clocks`} className="strong">
            {reference}
          </Link>
          {c.claimantName && <span className="muted small">{c.claimantName}</span>}
          <ClockPill clock={c} now={now} />
          <span className="small">{c.label}</span>
          {row.more > 0 && (
            <Link to={`/claims/${row.claimId}/clocks`} className="xs muted">
              +{row.more} more
            </Link>
          )}
        </div>
      </div>
      {/* the clock pill already says "overdue by …" */}
      {row.tone !== 'red' && <Badge tone={row.tone}>today</Badge>}
    </li>
  );
}

/** One line per action (or per group of identical actions): title · ref · due · £ protected, with a "Why" disclosure. */
function ActionLine({ group }: { group: ActionGroup }) {
  const first = group.items[0]!;
  const single = group.items.length === 1;
  const blocked = group.items.some((a) => a.blockedBy && a.blockedBy.length > 0);
  return (
    <li className="dash-line">
      <div className="list-main">
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {single ? (
            <Link to={`/claims/${first.claimId}/actions`} className="strong">
              {group.title}
            </Link>
          ) : (
            <span className="strong">{actionGroupTitle(group)}</span>
          )}
          {/* separators are drawn by CSS between items, so a wrapped line never starts with "·" */}
          <span className="dash-meta small muted">
            {single && <span>{first.claimReference ?? first.claimId}</span>}
            {group.dueAt && (
              <span>
                due <DateText value={group.dueAt} time />
              </span>
            )}
            {group.protectedPence ? (
              <span>
                protects <Money pence={group.protectedPence} showPence={false} />
              </span>
            ) : null}
          </span>
          {blocked && (
            <Badge tone="amber" className="small">
              blocked
            </Badge>
          )}
        </div>
        <details className="dash-why">
          <summary>{single ? 'Why' : `Why · the ${new Set(group.items.map((a) => a.claimId)).size} claims`}</summary>
          <div className="small">{first.why}</div>
          {!single && (
            <ul className="dash-claims">
              {group.items.map((a, i) => (
                <li key={`${a.claimId}-${i}`}>
                  <Link to={`/claims/${a.claimId}/actions`}>{a.claimReference ?? a.claimId}</Link>
                  {a.dueAt ? (
                    <span className="xs muted">
                      {' '}
                      · due <DateText value={a.dueAt} time />
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>
      <PriorityBadge priority={group.priority} />
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
