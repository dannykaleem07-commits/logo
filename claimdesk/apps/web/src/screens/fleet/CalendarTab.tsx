// owned by ap-booking
/**
 * Fleet calendar (docs/SUPREME-AUTOPILOT.md §I.3): rows are cars (group, registration, location), columns are days
 * (2 / 4 / 8 weeks, today line). Bars: held (striped, with expiry), confirmed (solid), on hire (dark), returned (grey);
 * cancelled hidden; readiness blocks hatched; compliance markers (MOT ▲, tax ■, policy end │, service ●) amber when
 * inside a booking; movements (delivery ↓, collection ↑); a red outline where bookings clash. Filters: group, use and
 * "free between dates". A bar opens the booking card; an empty cell opens the booking dialog for that car and day
 * (after picking the claim). An accessible table view lists the same bookings for screen readers and printing.
 */
import { useMemo, useState } from 'react';
import type { FleetUse } from '@ccguk/domain';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { DateInput, Select, TextInput } from '../../components/Form';
import { Modal } from '../../components/Modal';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Loading } from '../../components/Spinner';
import { DateText } from '../../components/DateText';
import { useClaims } from '../../api/hooks';
import { barSpan, calendarDays, freeBetween, londonDayStart, MARKER_SYMBOL, READINESS_TEXT, STATUS_TEXT, useCalendar, type CalendarRow } from '../../api/bookingsApi';
import { BookingDialog } from '../claim/booking/BookingDialog';
import { BookingCard } from './BookingCard';
import './booking.css';

const RANGES = [
  { value: '14', label: '2 weeks' },
  { value: '28', label: '4 weeks' },
  { value: '56', label: '8 weeks' },
];
const USES: Array<{ value: FleetUse | ''; label: string }> = [
  { value: '', label: 'Any use' },
  { value: 'credit_hire', label: 'Credit hire' },
  { value: 'self_drive', label: 'Self-drive' },
  { value: 'pco', label: 'PCO' },
];
const MARKER_TEXT = { mot: 'MOT due', tax: 'Tax due', policy: 'Policy ends', service: 'Service due', phv_licence: 'PHV licence ends' } as const;

export function CalendarTab() {
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [days, setDays] = useState('28');
  const [group, setGroup] = useState('');
  const [use, setUse] = useState<FleetUse | ''>('');
  const [freeFrom, setFreeFrom] = useState('');
  const [freeTo, setFreeTo] = useState('');
  const [view, setView] = useState<'grid' | 'table'>('grid');
  const [card, setCard] = useState<string | null>(null);
  const [cell, setCell] = useState<{ unitId: string; startAt: string; registration: string } | null>(null);

  const grid = useMemo(() => calendarDays(`${from}T12:00:00Z`, Number(days)), [from, days]);
  const range = { from: grid[0]!.start, to: grid[grid.length - 1]!.end };
  const cal = useCalendar({ from: range.from, to: range.to, ...(group.trim() ? { group: group.trim() } : {}), use });
  const rows = (cal.data?.rows ?? []).filter((r) => !(freeFrom && freeTo) || freeBetween(r, londonDayStart(`${freeFrom}T12:00:00Z`), londonDayStart(`${freeTo}T12:00:00Z`)));
  const nowFrac = barSpan({ startAt: range.from, endAt: new Date().toISOString() }, range.from, range.to);

  return (
    <Card>
      <div className="cal-toolbar no-print">
        <DateInput label="From" value={from} onChange={(v) => v && setFrom(v)} />
        <Select label="Show" value={days} onChange={(v) => v && setDays(v)} options={RANGES} />
        <TextInput label="Group" value={group} onChange={setGroup} placeholder="e.g. S1" />
        <Select label="Use" value={use} onChange={(v) => setUse(v as FleetUse | '')} options={USES as Array<{ value: string; label: string }>} />
        <DateInput label="Free from" value={freeFrom} onChange={setFreeFrom} />
        <DateInput label="Free to" value={freeTo} onChange={setFreeTo} />
        <Button size="sm" onClick={() => setView(view === 'grid' ? 'table' : 'grid')}>
          {view === 'grid' ? 'Table view' : 'Calendar view'}
        </Button>
      </div>
      {cal.isLoading && <Loading />}
      {cal.isError && <ErrorAlert message={(cal.error as Error).message} />}
      {cal.data && rows.length === 0 && <p className="muted">No car matches these filters.</p>}
      {cal.data && rows.length > 0 && view === 'grid' && (
        <>
          <div className="cal-wrap">
            <div className="cal-grid" role="grid" aria-label="Fleet calendar">
              <div className="cal-head" role="row">
                <div className="cal-unit" role="columnheader">
                  Car
                </div>
                <div className="cal-days" style={{ gridTemplateColumns: `repeat(${grid.length}, minmax(0, 1fr))` }}>
                  {grid.map((d) => (
                    <div key={d.start} role="columnheader" className={`cal-day${d.isWeekend ? ' weekend' : ''}`}>
                      {d.weekday.slice(0, 2)}
                      <br />
                      {d.label}
                    </div>
                  ))}
                </div>
              </div>
              {rows.map((row) => (
                <CalendarLane key={row.fleetUnitId} row={row} grid={grid} range={range} nowFrac={nowFrac} onBar={setCard} onCell={(startAt) => setCell({ unitId: row.fleetUnitId, startAt, registration: row.registration })} />
              ))}
            </div>
          </div>
          <div className="cal-legend" aria-hidden="true">
            <span>
              <span className="cal-bar held" /> held
            </span>
            <span>
              <span className="cal-bar confirmed" /> confirmed
            </span>
            <span>
              <span className="cal-bar on_hire" /> on hire
            </span>
            <span>
              <span className="cal-bar returned" /> returned
            </span>
            <span>▲ MOT · ■ tax · │ policy end · ● service · ↓ delivery · ↑ collection</span>
          </div>
        </>
      )}
      {cal.data && rows.length > 0 && view === 'table' && <CalendarTable rows={rows} onOpen={setCard} />}
      <BookingCard reservationId={card} onClose={() => setCard(null)} />
      <ClaimPickerThenBook cell={cell} onClose={() => setCell(null)} />
    </Card>
  );
}

function CalendarLane({ row, grid, range, nowFrac, onBar, onCell }: { row: CalendarRow; grid: ReturnType<typeof calendarDays>; range: { from: string; to: string }; nowFrac: { left: number; width: number } | null; onBar: (id: string) => void; onCell: (startAt: string) => void }) {
  const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
  const pos = (iso: string) => barSpan({ startAt: range.from, endAt: iso }, range.from, range.to)?.width ?? null;
  return (
    <div className="cal-row" role="row">
      <div className="cal-unit" role="rowheader">
        <span className="bk-plate">{row.registration}</span> <span className="small strong">{row.group}</span>
        <div className="xs muted">
          {row.label}
          {row.location ? ` · ${row.location}` : ''}
        </div>
      </div>
      <div className="cal-lane">
        {grid.map((d, i) => (
          <button
            key={d.start}
            type="button"
            className="cal-cell"
            style={{ left: pct(i / grid.length), width: pct(1 / grid.length) }}
            aria-label={`Book ${row.registration} from ${d.weekday} ${d.label}`}
            onClick={() => onCell(new Date(Date.parse(d.start) + 9 * 3_600_000).toISOString())}
          />
        ))}
        {row.readiness.map((t) => {
          const span = barSpan({ startAt: t.from, endAt: t.to }, range.from, range.to);
          if (!span) return null;
          return <span key={t.id} className={`cal-ready${t.blocksHire ? ' blocks' : ''}`} style={{ left: pct(span.left), width: pct(Math.max(span.width, 0.004)) }} title={`${READINESS_TEXT[t.kind]}${t.blocksHire ? ' (blocks hire)' : ''}`} />;
        })}
        {row.bookings.map((b) => {
          const span = barSpan(b, range.from, range.to);
          if (!span) return null;
          const tip = `${STATUS_TEXT[b.status]}${b.claimReference ? ` · ${b.claimReference}` : ''}${b.clientName ? ` · ${b.clientName}` : ''}${b.holdExpiresAt ? ` · hold expires ${new Date(b.holdExpiresAt).toLocaleString('en-GB', { timeZone: 'Europe/London' })}` : ''}`;
          return (
            <button key={b.id} type="button" className={`cal-bar ${b.status}${b.clash ? ' clash' : ''}`} style={{ left: pct(span.left), width: pct(Math.max(span.width, 0.01)) }} title={tip} aria-label={`${row.registration}: ${tip}`} onClick={() => onBar(b.id)}>
              {b.claimReference ?? b.label}
            </button>
          );
        })}
        {row.markers.map((m) => {
          const left = pos(`${m.date}T12:00:00Z`);
          if (left === null) return null;
          return (
            <span key={`${m.kind}-${m.date}`} className={`cal-marker${m.insideBooking ? ' inside' : ''}`} style={{ left: pct(left) }} title={`${MARKER_TEXT[m.kind]} ${m.date}${m.insideBooking ? ' — inside a booking' : ''}`}>
              {MARKER_SYMBOL[m.kind]}
            </span>
          );
        })}
        {row.movements.map((m) => {
          const left = pos(m.windowStart);
          if (left === null) return null;
          return (
            <span key={m.id} className="cal-move" style={{ left: pct(left) }} title={`${m.kind} ${new Date(m.windowStart).toLocaleString('en-GB', { timeZone: 'Europe/London' })} (${m.status})`}>
              {m.kind === 'collection' ? '↑' : '↓'}
            </span>
          );
        })}
        {nowFrac && nowFrac.width > 0 && nowFrac.width < 1 && <span className="cal-today" style={{ left: pct(nowFrac.width) }} aria-hidden="true" />}
      </div>
    </div>
  );
}

function CalendarTable({ rows, onOpen }: { rows: CalendarRow[]; onOpen: (id: string) => void }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Fleet bookings</caption>
        <thead>
          <tr>
            <th>Car</th>
            <th>Booking</th>
            <th>From</th>
            <th>To</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((r) =>
            (r.bookings.length ? r.bookings : [null]).map((b, i) => (
              <tr key={`${r.fleetUnitId}-${b?.id ?? 'free'}-${i}`}>
                <td>
                  {r.registration} ({r.group})
                </td>
                <td>{b ? <Button size="sm" variant="ghost" onClick={() => onOpen(b.id)}>{`${STATUS_TEXT[b.status]}${b.claimReference ? ` · ${b.claimReference}` : ''}`}</Button> : <span className="muted">Free</span>}</td>
                <td>{b ? <DateText value={b.startAt} time /> : ''}</td>
                <td>{b ? b.endAt ? <DateText value={b.endAt} time /> : 'open' : ''}</td>
                <td className="small">
                  {[b?.clash ? 'Clash' : '', ...r.markers.filter((m) => m.insideBooking).map((m) => `${MARKER_TEXT[m.kind]} ${m.date} inside a booking`), ...r.readiness.map((t) => READINESS_TEXT[t.kind])].filter(Boolean).join(' · ')}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

/** An empty calendar cell: choose the claim, then the booking dialog opens on that car and day. */
function ClaimPickerThenBook({ cell, onClose }: { cell: { unitId: string; startAt: string; registration: string } | null; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [claimId, setClaimId] = useState<string | null>(null);
  const claims = useClaims({ q: q.trim() || undefined, limit: 20 }, { enabled: Boolean(cell) && !claimId });
  if (!cell) return null;
  if (claimId) {
    return (
      <BookingDialog
        open
        claimId={claimId}
        initialUnitId={cell.unitId}
        initialStartAt={cell.startAt}
        onClose={() => {
          setClaimId(null);
          setQ('');
          onClose();
        }}
      />
    );
  }
  const open = (claims.data ?? []).filter((c) => !['declined', 'settled', 'closed'].includes(c.status));
  return (
    <Modal open title={`Book ${cell.registration} — which claim?`} onClose={onClose}>
      <div className="stack-sm">
        <TextInput label="Find the claim (reference, registration or name)" value={q} onChange={setQ} autoFocus />
        {claims.isLoading && <Loading />}
        <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {open.map((c) => (
            <li key={c.id}>
              <Button variant="ghost" onClick={() => setClaimId(c.id)}>
                {c.reference} — {c.status.replace(/_/g, ' ')}
              </Button>
            </li>
          ))}
        </ul>
        {!claims.isLoading && open.length === 0 && <p className="muted">No open claim found.</p>}
      </div>
    </Modal>
  );
}
