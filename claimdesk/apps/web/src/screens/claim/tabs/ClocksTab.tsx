import { useMemo, useState } from 'react';
import type { Clock } from '@ccguk/domain';
import { Card } from '../../../components/Card';
import { Table, type Column } from '../../../components/Table';
import { ClockStatusBadge } from '../../../components/Badge';
import { ClockPill } from '../../../components/ClockPill';
import { DateText } from '../../../components/DateText';
import { Checkbox, Select, TextInput } from '../../../components/Form';
import { EmptyState } from '../../../components/EmptyState';
import { Loading } from '../../../components/Spinner';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { dueState } from '../../../lib/clocks';
import type { ClaimView } from '../claimFile';
import { useClaimClocks } from '../useClaimDerived';
import { BasisText } from '../components/BasisText';
import { CLOCK_ATTRIBUTABLE_LABEL, CLOCK_STATUS_FILTERS, clockCounts, filterClocks, sortClocks, type ClocksFilter } from '../lib/clocksView';
import { eventLabel } from '../lib/chronology';

/** Every derived clock with its basis, start, due, status and attribution. Overdue rows are highlighted. */
export function ClocksTab({ view }: { view: ClaimView }) {
  const now = new Date();
  const { clocks, isLoading, error } = useClaimClocks(view);
  const [filter, setFilter] = useState<ClocksFilter>({ status: 'open' });
  const rows = useMemo(() => sortClocks(filterClocks(clocks, filter, now)), [clocks, filter, now]);
  const counts = clockCounts(clocks, now);
  const eventsById = useMemo(() => new Map(view.events.map((e) => [e.id, e])), [view.events]);

  const columns: Column<Clock>[] = [
    {
      key: 'label',
      header: 'Clock',
      className: 'wrap',
      render: (c) => (
        <div>
          <div className="strong">{c.label}</div>
        </div>
      )
    },
    { key: 'basis', header: 'Basis', className: 'wrap', render: (c) => <BasisText basis={c.basis} /> },
    {
      key: 'start',
      header: 'Started',
      render: (c) => (
        <div>
          <DateText value={c.startsAt} time />
          {c.sourceEventId && <div className="xs muted">{eventsById.get(c.sourceEventId) ? eventLabel(eventsById.get(c.sourceEventId)!.type) : 'from event'}</div>}
        </div>
      )
    },
    {
      key: 'due',
      header: 'Due',
      render: (c) => (
        <div className="stack-sm" style={{ gap: 2 }}>
          <DateText value={c.dueAt} time />
          <ClockPill clock={c} now={now} />
        </div>
      )
    },
    {
      key: 'status',
      header: 'Status',
      render: (c) => (
        <div>
          <ClockStatusBadge status={c.status} />
          {c.metAt && (
            <div className="xs muted">
              met <DateText value={c.metAt} time />
            </div>
          )}
          {c.stoppedReason && <div className="xs muted">{c.stoppedReason}</div>}
        </div>
      )
    },
    { key: 'attr', header: 'On', render: (c) => (c.attributableTo ? CLOCK_ATTRIBUTABLE_LABEL[c.attributableTo] : <span className="muted">—</span>) }
  ];

  return (
    <div className="stack">
      <div className="grid-4">
        <div className="stat">
          <span className="stat-label">Open</span>
          <span className="stat-value">{counts.open}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Overdue</span>
          <span className={`stat-value ${counts.overdue ? 'red' : ''}`}>{counts.overdue}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Due today</span>
          <span className={`stat-value ${counts.dueToday ? 'amber' : ''}`}>{counts.dueToday}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Met</span>
          <span className="stat-value green">{counts.met}</span>
        </div>
      </div>
      <Card title="Clocks" flush actions={<span className="small muted">derived by the API from the chronology; never edited by hand</span>}>
        <div className="row" style={{ padding: '10px 20px', borderBottom: '1px solid var(--line)' }}>
          <Select label="Show" value={filter.status} onChange={(v) => setFilter((f) => ({ ...f, status: v || 'open' }))} options={CLOCK_STATUS_FILTERS} />
          <Select label="On" value={filter.attributableTo ?? ''} onChange={(v) => setFilter((f) => ({ ...f, attributableTo: v }))} options={(Object.keys(CLOCK_ATTRIBUTABLE_LABEL) as Array<keyof typeof CLOCK_ATTRIBUTABLE_LABEL>).map((k) => ({ value: k, label: CLOCK_ATTRIBUTABLE_LABEL[k] }))} placeholder="Anyone" />
          <TextInput label="Search" type="search" value={filter.q ?? ''} onChange={(v) => setFilter((f) => ({ ...f, q: v }))} placeholder="Label, basis or kind" />
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <Checkbox label="GTA benchmark clocks only" checked={Boolean(filter.gtaOnly)} onChange={(v) => setFilter((f) => ({ ...f, gtaOnly: v }))} />
          </div>
        </div>
        <ApiErrorNotice error={error} what="load the clocks" />
        {isLoading ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Clocks</caption>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} scope="col" className={c.className}>
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={columns.length} className="table-empty">
                      <EmptyState title={clocks.length ? 'No clocks match the filters' : 'No clocks yet'}>{clocks.length ? '' : 'Clocks start from events: services agreed starts the NCAF clock; the NCAF starts GTA 3.6, 4.2 and ICOBS 8.2.6.'}</EmptyState>
                    </td>
                  </tr>
                ) : (
                  rows.map((c, i) => {
                    const s = dueState(c, now);
                    const cls = s === 'overdue' ? 'row-overdue' : s === 'today' ? 'row-today' : '';
                    return (
                      <tr key={c.id} className={cls}>
                        {columns.map((col) => (
                          <td key={col.key} className={col.className}>
                            {col.render(c, i)}
                          </td>
                        ))}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
