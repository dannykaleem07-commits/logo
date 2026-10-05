import { useMemo, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatGBP } from '@ccguk/domain';
import '../../styles/screens.css';
import type { CycleTimesAnalytics, DebtorDaysSummary, InterventionsAnalytics, ReductionsAnalytics } from '../../api/client';
import { PageHeader } from '../../components/PageHeader';
import { Card } from '../../components/Card';
import { Badge } from '../../components/Badge';
import { DateInput, Select } from '../../components/Form';
import { EmptyState } from '../../components/EmptyState';
import { Loading } from '../../components/Spinner';
import { ApiErrorNotice } from '../../components/ApiErrorNotice';
import { Money } from '../../components/Money';
import { Table, type Column } from '../../components/Table';
import { todayISO } from '../../lib/dates';
import { cycleLabel, debtorDaysTone, describeRange, formatPct, headLabel, pct, RANGE_PRESETS, rangeFromParams, reductionTone, topBars, type BarItem, type RangePreset } from './analytics';
import { BarChart } from './BarChart';
import { useCycleTimesRange, useDebtorDaysRange, useInterventionsRange, useOverviewRange, useReductionsRange } from './analyticsApi';

/** Analytics tuned to credit hire: debtor days by insurer, reductions by head, cycle times, intervention outcomes. */
export function AnalyticsPage() {
  const [params, setParams] = useSearchParams();
  const today = todayISO();
  const { preset, range } = useMemo(() => rangeFromParams(params, today), [params, today]);
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const overview = useOverviewRange(range);
  const debtor = useDebtorDaysRange(range);
  const reductions = useReductionsRange(range);
  const cycles = useCycleTimesRange(range);
  const interventions = useInterventionsRange(range);

  const ov = overview.data;
  const outstanding = ov?.outstandingPence ?? ov?.debtorDays?.outstandingPence ?? debtor.data?.outstandingPence;
  const avgDays = ov?.debtorDays?.overallDays ?? debtor.data?.overallDays;
  const blocked = ov?.blockedDocuments?.length;
  const overdue = ov?.clocks?.overdue?.length;

  return (
    <div className="page">
      <PageHeader title="Analytics" subtitle={`Figures come from the ledger and the chronology · ${describeRange(range)}`} />
      <Card flush>
        <div className="toolbar">
          <Select<RangePreset> label="Period" value={preset} onChange={(v) => v && setParam('range', v)} options={RANGE_PRESETS} />
          {preset === 'custom' && (
            <>
              <DateInput label="From" value={range.from ?? ''} onChange={(v) => setParam('from', v)} />
              <DateInput label="To" value={range.to ?? ''} onChange={(v) => setParam('to', v)} />
            </>
          )}
          <span className="xs muted" style={{ flex: '1 1 240px', paddingBottom: 10 }}>
            Debtor days: <Badge tone="green">≤ 30</Badge> within the GTA 6.7 settlement month (benchmark) · <Badge tone="amber">31–60</Badge> · <Badge tone="red">60+</Badge>
          </span>
        </div>
      </Card>

      {overview.error && (
        <div style={{ marginTop: 12 }}>
          <ApiErrorNotice error={overview.error} what="load the overview" />
        </div>
      )}

      <div className="grid-4" style={{ margin: '16px 0' }}>
        <Tile label="Open claims" value={ov?.claims?.open} loading={overview.isLoading} to="/claims" sub={ov?.claims?.total !== undefined ? `${ov.claims.total} total` : undefined} />
        <Tile label="Outstanding" value={outstanding !== undefined ? formatGBP(outstanding, { showPence: false }) : undefined} loading={overview.isLoading && debtor.isLoading} sub="claimed less paid" />
        <Tile label="Average debtor days" value={avgDays} loading={overview.isLoading && debtor.isLoading} tone={avgDays !== undefined ? debtorDaysTone(avgDays) : undefined} sub="from pack sent to cleared funds" />
        <Tile label="Blocked documents" value={blocked} loading={overview.isLoading} tone={blocked ? 'red' : undefined} to="/#blocked-documents" sub="need a flag cleared by a person" />
        <Tile label="Overdue clocks" value={overdue} loading={overview.isLoading} tone={overdue ? 'red' : undefined} to="/#clocks" sub={ov?.clocks?.dueToday ? `${ov.clocks.dueToday.length} due today` : undefined} />
        <Tile label="Open intervention offers" value={ov?.interventions?.open} loading={overview.isLoading} tone={ov?.interventions?.repliesOverdue ? 'red' : undefined} sub={ov?.interventions ? `${ov.interventions.repliesOverdue} written replies overdue (1 WD)` : undefined} />
      </div>

      <div className="stack">
        <DebtorDaysCard data={debtor.data} loading={debtor.isLoading} error={debtor.error} />
        <ReductionsCard data={reductions.data} loading={reductions.isLoading} error={reductions.error} />
        <CycleTimesCard data={cycles.data} loading={cycles.isLoading} error={cycles.error} />
        <InterventionsCard data={interventions.data} loading={interventions.isLoading} error={interventions.error} />
      </div>
    </div>
  );
}

function Tile({ label, value, sub, loading, tone, to }: { label: string; value: number | string | undefined; sub?: string; loading: boolean; tone?: 'red' | 'amber' | 'green' | 'blue' | 'grey' | 'navy'; to?: string }) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone === 'red' || tone === 'amber' || tone === 'green' ? tone : ''}`}>{loading ? '…' : value ?? '—'}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </>
  );
  return to ? (
    <Link to={to} className="stat">
      {body}
    </Link>
  ) : (
    <div className="stat">{body}</div>
  );
}

function Panel({ title, loading, error, empty, what, children, note }: { title: string; loading: boolean; error: unknown; empty: boolean; what: string; children: ReactNode; note?: string }) {
  return (
    <Card title={title} flush actions={note ? <span className="xs muted">{note}</span> : undefined}>
      {loading ? (
        <Loading />
      ) : error ? (
        <div style={{ padding: 16 }}>
          <ApiErrorNotice error={error} what={what} />
        </div>
      ) : empty ? (
        <EmptyState title="Nothing in this period" />
      ) : (
        children
      )}
    </Card>
  );
}

function DebtorDaysCard({ data, loading, error }: { data: DebtorDaysSummary | undefined; loading: boolean; error: unknown }) {
  const rows = data?.byInsurer ?? [];
  type Row = (typeof rows)[number];
  const columns: Column<Row>[] = [
    { key: 'insurer', header: 'Insurer', render: (r) => r.insurerName },
    { key: 'claims', header: 'Claims', numeric: true, render: (r) => r.claims },
    { key: 'days', header: 'Debtor days', numeric: true, render: (r) => <Badge tone={debtorDaysTone(r.days)}>{r.days}</Badge> },
    { key: 'outstanding', header: 'Outstanding', numeric: true, render: (r) => <Money pence={r.outstandingPence} showPence={false} /> }
  ];
  const bars: BarItem[] = topBars(
    rows.map((r) => ({ key: r.insurerId ?? r.insurerName, label: r.insurerName, value: r.days, display: `${r.days} d`, warn: r.days > 30, title: `${r.insurerName}: ${r.days} debtor days · ${formatGBP(r.outstandingPence, { showPence: false })} outstanding · ${r.claims} claims` }))
  );
  return (
    <Panel title="Debtor days by insurer" loading={loading} error={error} empty={rows.length === 0 && data?.overallDays === undefined} what="load debtor days" note={data?.overallDays !== undefined ? `overall ${data.overallDays} days` : undefined}>
      <div className="grid-2" style={{ padding: 16, alignItems: 'start' }}>
        <div>{bars.length > 0 ? <BarChart items={bars} unit=" d" ariaLabel="Debtor days by insurer" /> : <EmptyState title="No insurer breakdown" />}</div>
        <Table columns={columns} rows={rows} rowKey={(r) => r.insurerId ?? r.insurerName} caption="Debtor days by insurer" />
      </div>
      {(data?.byHandler?.length ?? 0) > 0 && (
        <div style={{ padding: '0 16px 16px' }}>
          <h4 style={{ marginBottom: 8 }}>By handler</h4>
          <Table columns={[{ key: 'h', header: 'Handler', render: (r) => r.handlerName }, { key: 'c', header: 'Claims', numeric: true, render: (r) => r.claims }, { key: 'd', header: 'Days', numeric: true, render: (r) => <Badge tone={debtorDaysTone(r.days)}>{r.days}</Badge> }, { key: 'o', header: 'Outstanding', numeric: true, render: (r) => <Money pence={r.outstandingPence} showPence={false} /> }]} rows={data!.byHandler!} rowKey={(r) => r.handlerId ?? r.handlerName} />
        </div>
      )}
    </Panel>
  );
}

function ReductionsCard({ data, loading, error }: { data: ReductionsAnalytics | undefined; loading: boolean; error: unknown }) {
  const rows = data?.byHead ?? [];
  type Row = (typeof rows)[number];
  const columns: Column<Row>[] = [
    { key: 'head', header: 'Head of loss', render: (r) => headLabel(r.head) },
    { key: 'claimed', header: 'Claimed', numeric: true, render: (r) => <Money pence={r.claimedPence} showPence={false} /> },
    { key: 'paid', header: 'Paid', numeric: true, render: (r) => <Money pence={r.paidPence} showPence={false} /> },
    { key: 'reduced', header: 'Reduced', numeric: true, render: (r) => <Money pence={r.reducedPence} showPence={false} /> },
    { key: 'pct', header: 'Reduction', numeric: true, render: (r) => <Badge tone={reductionTone(r.reductionPct)}>{formatPct(r.reductionPct)}</Badge> }
  ];
  const bars: BarItem[] = rows.map((r) => ({ key: r.head, label: headLabel(r.head), value: r.reductionPct, display: formatPct(r.reductionPct), warn: r.reductionPct > 20, title: `${headLabel(r.head)}: ${formatPct(r.reductionPct)} reduced (${formatGBP(r.reducedPence, { showPence: false })} of ${formatGBP(r.claimedPence, { showPence: false })})` }));
  return (
    <Panel title="Reductions by head of claim" loading={loading} error={error} empty={rows.length === 0} what="load reductions" note="insurer reductions vs our claimed position">
      <div className="grid-2" style={{ padding: 16, alignItems: 'start' }}>
        <BarChart items={bars} unit="%" maxValue={100} ariaLabel="Reduction percentage by head of loss" />
        <Table columns={columns} rows={rows} rowKey={(r) => r.head} caption="Reductions by head" />
      </div>
      {(data?.byInsurer?.length ?? 0) > 0 && (
        <div style={{ padding: '0 16px 16px' }}>
          <h4 style={{ marginBottom: 8 }}>By insurer</h4>
          <Table columns={[{ key: 'i', header: 'Insurer', render: (r) => r.insurerName }, { key: 'c', header: 'Claimed', numeric: true, render: (r) => <Money pence={r.claimedPence} showPence={false} /> }, { key: 'p', header: 'Paid', numeric: true, render: (r) => <Money pence={r.paidPence} showPence={false} /> }, { key: 'r', header: 'Reduction', numeric: true, render: (r) => <Badge tone={reductionTone(r.reductionPct)}>{formatPct(r.reductionPct)}</Badge> }]} rows={data!.byInsurer!} rowKey={(r) => r.insurerName} />
        </div>
      )}
    </Panel>
  );
}

function CycleTimesCard({ data, loading, error }: { data: CycleTimesAnalytics | undefined; loading: boolean; error: unknown }) {
  const rows = data?.stages ?? [];
  type Row = (typeof rows)[number];
  const columns: Column<Row>[] = [
    { key: 'stage', header: 'Stage', render: (r) => cycleLabel(r.from, r.to) },
    { key: 'median', header: 'Median days', numeric: true, render: (r) => r.medianDays },
    { key: 'p90', header: 'P90 days', numeric: true, render: (r) => r.p90Days ?? <span className="muted">—</span> },
    { key: 'claims', header: 'Claims', numeric: true, render: (r) => r.claims }
  ];
  const bars: BarItem[] = rows.map((r) => ({ key: `${r.from}-${r.to}`, label: cycleLabel(r.from, r.to), value: r.medianDays, display: `${r.medianDays} d`, title: `${cycleLabel(r.from, r.to)}: median ${r.medianDays} days${r.p90Days !== undefined ? `, P90 ${r.p90Days}` : ''} over ${r.claims} claims` }));
  return (
    <Panel title="Cycle times" loading={loading} error={error} empty={rows.length === 0} what="load cycle times" note="FNOL → NCAF · hire end → pack · pack → payment">
      <div className="grid-2" style={{ padding: 16, alignItems: 'start' }}>
        <BarChart items={bars} unit=" d" ariaLabel="Median cycle time by stage" />
        <Table columns={columns} rows={rows} rowKey={(r) => `${r.from}-${r.to}`} caption="Cycle times" />
      </div>
      <div className="card-footer xs muted">Targets (benchmark, CCGUK is not a subscriber): NCAF within 1 working day of services agreed (GTA 4.1); payment pack the day hire ends (GTA 6.1–6.3); settlement within one month of a clean pack (GTA 6.7).</div>
    </Panel>
  );
}

function InterventionsCard({ data, loading, error }: { data: InterventionsAnalytics | undefined; loading: boolean; error: unknown }) {
  const rows = data?.byInsurer ?? [];
  type Row = (typeof rows)[number];
  const columns: Column<Row>[] = [
    { key: 'insurer', header: 'Insurer', render: (r) => r.insurerName },
    { key: 'offers', header: 'Offers', numeric: true, render: (r) => r.offers },
    { key: 'accepted', header: 'Accepted', numeric: true, render: (r) => r.accepted },
    { key: 'rate', header: 'Acceptance', numeric: true, render: (r) => formatPct(pct(r.accepted, r.offers)) }
  ];
  const d = data;
  return (
    <Panel title="Intervention offers" loading={loading} error={error} empty={!d || d.offers === 0} what="load intervention outcomes" note="logged offers · client decisions · written reply within 1 WD">
      {d && (
        <div style={{ padding: 16 }} className="stack">
          <div className="grid-4">
            <div className="stat">
              <span className="stat-label">Offers logged</span>
              <span className="stat-value">{d.offers}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Accepted by client</span>
              <span className="stat-value">{d.accepted}</span>
              <span className="stat-sub">{formatPct(pct(d.accepted, d.offers))}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Declined with reasons</span>
              <span className="stat-value">{d.declined}</span>
              <span className="stat-sub">{formatPct(pct(d.declined, d.offers))}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Replied within 1 WD</span>
              <span className={`stat-value ${pct(d.repliedWithin1Wd, d.offers) < 100 ? 'amber' : 'green'}`}>{formatPct(pct(d.repliedWithin1Wd, d.offers))}</span>
              <span className="stat-sub">{d.repliedWithin1Wd} of {d.offers} offers</span>
            </div>
          </div>
          {rows.length > 0 && <Table columns={columns} rows={rows} rowKey={(r) => r.insurerName} caption="Intervention offers by insurer" />}
        </div>
      )}
    </Panel>
  );
}
