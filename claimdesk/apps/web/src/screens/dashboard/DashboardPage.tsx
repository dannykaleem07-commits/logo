import { Link } from 'react-router-dom';
import { useDashboardData } from '../../api/hooks';
import type { DashboardClock, DashboardDocument, DebtorDaysSummary } from '../../api/client';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Loading, Spinner } from '../../components/Spinner';
import { ClockPill } from '../../components/ClockPill';
import { Badge, DocumentStatusBadge } from '../../components/Badge';
import { Money } from '../../components/Money';
import { DateText } from '../../components/DateText';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { Table, type Column } from '../../components/Table';
import { actionGroupTitle, clockRowsByClaim, groupActions, splitActionGroups, todaySummary, type ActionGroup, type ClockRow } from './dashboard';
import './dashboard.css';

/**
 * Dashboard → "Today": the owner's overview. Four big numbers (what needs you, what is due today, money outstanding,
 * claims in progress) and two short lists under them. Every number comes from the API (overview with per-claim
 * fallback); nothing is computed from local assumptions.
 */
export function DashboardPage() {
  const now = new Date();
  const dash = useDashboardData(now);
  const clockRows = clockRowsByClaim(dash.clocksOverdue, dash.clocksToday);
  const actionGroups = groupActions(dash.nextActions).slice(0, 25);
  const split = splitActionGroups(actionGroups);
  const summary = todaySummary({ clockRows, actionGroups, blockedDocuments: dash.blockedDocuments, claims: dash.claims });
  const refFor = (c: DashboardClock) => c.claimReference ?? dash.claims.find((x) => x.id === c.claimId)?.reference ?? c.claimId;
  const overdueRows = clockRows.filter((r) => r.tone === 'red');
  const todayRows = clockRows.filter((r) => r.tone === 'amber');
  const outstanding = dash.debtorDays?.outstandingPence ?? dash.overview?.outstandingPence;
  const loading = dash.isLoading;
  const value = (n: number) => (loading ? '…' : n);

  return (
    <div className="page dash">
      <PageHeader
        title="Today"
        subtitle={
          <>
            <DateText value={now.toISOString()} long />
            {dash.usingFallback && dash.isFetchingFallback && (
              <span className="dash-refreshing">
                <Spinner /> refreshing
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
        <div key={i} className="dash-error">
          <ApiErrorNotice error={e} what="load the dashboard" />
        </div>
      ))}

      <div className="dash-kpis">
        <a href="#needs-you" className={`stat dash-kpi ${summary.needsYou ? 'is-hot' : ''}`}>
          <span className="stat-label">Needs you</span>
          <span className={`stat-value ${summary.needsYou ? 'red' : ''}`}>{value(summary.needsYou)}</span>
          <span className="stat-sub">{needsYouSub(summary)}</span>
        </a>
        <a href="#due-today" className="stat dash-kpi">
          <span className="stat-label">Due today</span>
          <span className={`stat-value ${summary.dueToday ? 'amber' : ''}`}>{value(summary.dueToday)}</span>
          <span className="stat-sub">{summary.dueToday ? 'clocks and actions' : 'nothing else due'}</span>
        </a>
        <a href="#debtor-days" className="stat dash-kpi">
          <span className="stat-label">Money outstanding</span>
          <span className="stat-value">{loading ? '…' : <Money pence={outstanding} showPence={false} />}</span>
          <span className="stat-sub">{dash.debtorDays?.overallDays !== undefined ? `${dash.debtorDays.overallDays} debtor days on average` : 'from the ledger'}</span>
        </a>
        <Link to="/claims" className="stat dash-kpi">
          <span className="stat-label">Claims in progress</span>
          <span className="stat-value">{value(summary.inProgress)}</span>
          <span className="stat-sub">open files</span>
        </Link>
      </div>

      {dash.fleetAlertCount > 0 && (
        <Link to="/fleet" className="dash-fleet">
          <span className="dash-fleet-dot" aria-hidden="true" />
          <span>
            <strong>{dash.fleetAlertCount}</strong> fleet alert{dash.fleetAlertCount === 1 ? '' : 's'} to check — MOT, tax, insurance or cover
          </span>
          <span className="dash-fleet-go" aria-hidden="true">
            →
          </span>
        </Link>
      )}

      {/* the top bar's "Blocked documents" and clocks links land here */}
      <span id="clocks" className="dash-anchor" aria-hidden="true" />
      <span id="blocked-documents" className="dash-anchor" aria-hidden="true" />
      <div className="dash-grid">
        <Card id="needs-you" title="Needs you" actions={summary.needsYou > 0 ? <span className="dash-count">{summary.needsYou}</span> : undefined} flush>
          {loading ? (
            <Loading />
          ) : summary.needsYou === 0 ? (
            <EmptyState title="You're all caught up" icon="✓">
              Nothing is overdue or blocked.
            </EmptyState>
          ) : (
            <ul className="list dash-list">
              {overdueRows.map((row) => (
                <ClockLine key={`clock-${row.claimId}`} row={row} reference={refFor(row.worst)} now={now} />
              ))}
              {dash.blockedDocuments.map((d) => (
                <BlockedLine key={`doc-${d.id}`} doc={d} />
              ))}
              {split.now.map((g) => (
                <ActionLine key={`act-${g.key}`} group={g} />
              ))}
            </ul>
          )}
        </Card>

        <Card id="due-today" title="Due today" actions={summary.dueToday > 0 ? <span className="dash-count dash-count-amber">{summary.dueToday}</span> : undefined} flush>
          {loading ? (
            <Loading />
          ) : summary.dueToday === 0 ? (
            <EmptyState title="Nothing else due today" icon="✓">
              New deadlines appear here as you log events.
            </EmptyState>
          ) : (
            <ul className="list dash-list">
              {todayRows.map((row) => (
                <ClockLine key={`clock-${row.claimId}`} row={row} reference={refFor(row.worst)} now={now} />
              ))}
              {split.today.map((g) => (
                <ActionLine key={`act-${g.key}`} group={g} />
              ))}
            </ul>
          )}
        </Card>

        <Card title="Coming up" flush>
          {loading ? (
            <Loading />
          ) : split.later.length === 0 ? (
            <EmptyState title="Nothing queued">Next steps appear once a claim has services agreed.</EmptyState>
          ) : (
            <ul className="list dash-list">
              {split.later.slice(0, 8).map((g) => (
                <ActionLine key={g.key} group={g} />
              ))}
            </ul>
          )}
        </Card>

        <Card id="debtor-days" title="Money by insurer" flush>
          {loading ? <Loading /> : <DebtorDays summary={dash.debtorDays} />}
        </Card>
      </div>
    </div>
  );
}

function needsYouSub(s: ReturnType<typeof todaySummary>): string {
  const parts = [s.overdueClaims ? `${s.overdueClaims} overdue` : '', s.blocked ? `${s.blocked} blocked` : '', s.urgentActions ? `${s.urgentActions} urgent` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'all clear';
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
        <div className="dash-line-title">
          <Link to={`/claims/${row.claimId}/clocks`}>{reference}</Link>
          {c.claimantName && <span className="muted"> · {c.claimantName}</span>}
        </div>
        <div className="list-sub">
          {c.label}
          {row.more > 0 && (
            <>
              {' · '}
              <Link to={`/claims/${row.claimId}/clocks`} className="muted">
                +{row.more} more
              </Link>
            </>
          )}
        </div>
      </div>
      <ClockPill clock={c} now={now} />
    </li>
  );
}

function BlockedLine({ doc }: { doc: DashboardDocument }) {
  return (
    <li className="dash-line">
      <div className="list-main">
        <div className="dash-line-title">
          <Link to={doc.claimId ? `/claims/${doc.claimId}/documents` : '#'}>{doc.title}</Link>
        </div>
        <div className="list-sub">
          {doc.claimReference ?? doc.claimId}
          {doc.blockedFlags ? ` · ${doc.blockedFlags} flag${doc.blockedFlags === 1 ? '' : 's'} to clear` : ''}
        </div>
      </div>
      <DocumentStatusBadge status={doc.status} />
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
        <div className="dash-line-title">
          {single ? <Link to={`/claims/${first.claimId}/actions`}>{group.title}</Link> : <span>{actionGroupTitle(group)}</span>}
        </div>
        {/* separators are drawn by CSS between items, so a wrapped line never starts with "·" */}
        <div className="dash-meta list-sub">
          {single && <span>{first.claimReference ?? first.claimId}</span>}
          {group.dueAt && (
            <span>
              due <DateText value={group.dueAt} />
            </span>
          )}
          {group.protectedPence ? (
            <span>
              protects <Money pence={group.protectedPence} showPence={false} />
            </span>
          ) : null}
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
      {blocked && <Badge tone="amber">blocked</Badge>}
    </li>
  );
}

function DebtorDays({ summary }: { summary: DebtorDaysSummary | undefined }) {
  const rows = summary?.byInsurer ?? [];
  if (!summary || (rows.length === 0 && summary.overallDays === undefined)) {
    return <EmptyState title="No payments tracked yet">Shows once payment packs are sent.</EmptyState>;
  }
  type Row = NonNullable<DebtorDaysSummary['byInsurer']>[number];
  const columns: Column<Row>[] = [
    { key: 'insurer', header: 'Insurer', render: (r) => r.insurerName },
    { key: 'claims', header: 'Claims', numeric: true, className: 'col-hide-phone', render: (r) => r.claims },
    { key: 'days', header: 'Days', numeric: true, render: (r) => r.days },
    { key: 'outstanding', header: 'Outstanding', numeric: true, render: (r) => <Money pence={r.outstandingPence} showPence={false} /> }
  ];
  return (
    <>
      <div className="dash-debtor-total">
        <span className="muted">Overall</span>
        <span>
          <strong>{summary.overallDays ?? '—'} days</strong> · <Money pence={summary.outstandingPence} showPence={false} />
        </span>
      </div>
      {rows.length > 0 && <Table columns={columns} rows={rows} rowKey={(r) => r.insurerId ?? r.insurerName} />}
    </>
  );
}
