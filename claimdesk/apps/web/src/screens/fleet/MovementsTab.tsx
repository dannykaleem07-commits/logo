// owned by ap-booking
/**
 * Movements board (docs/SUPREME-AUTOPILOT.md §I.4): today / tomorrow / this week — deliveries and collections with the
 * slot, address, car, client name and phone (owner view), status buttons (Confirmed, Done → Handover or Return dialog,
 * Failed → reason and re-slot) and "Print run sheet".
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Address } from '@ccguk/domain';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { Modal } from '../../components/Modal';
import { TextInput } from '../../components/Form';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Loading } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { isApiError } from '../../api/client';
import { bookingsApi, useBookingMutation, useMovementBoard, type MovementBoardRow } from '../../api/bookingsApi';
import { HandoverDialog, ReturnDialog } from '../claim/booking/HandoverDialog';
import './booking.css';

type Range = 'day' | 'tomorrow' | 'week';
const RANGE_TEXT: Record<Range, string> = { day: 'Today', tomorrow: 'Tomorrow', week: 'This week' };
const STATUS_TONE = { planned: 'blue', confirmed: 'green', done: 'grey', failed: 'red', cancelled: 'grey' } as const;

const addressText = (a: Address | null, postcode: string | null): string => (a ? [a.line1, a.line2, a.town, a.postcode].filter(Boolean).join(', ') : (postcode ?? 'Address to confirm'));

export function MovementsTab() {
  const toast = useToast();
  const [range, setRange] = useState<Range>('day');
  const board = useMovementBoard({ range });
  const [dialog, setDialog] = useState<{ kind: 'handover' | 'return'; reservationId: string } | null>(null);
  const [failing, setFailing] = useState<MovementBoardRow | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const patch = useBookingMutation((v: { id: string; status: 'confirmed' | 'failed'; reason?: string }) => bookingsApi.patchMovement(v.id, { status: v.status, ...(v.reason ? { reason: v.reason } : {}) }));

  const act = async (v: { id: string; status: 'confirmed' | 'failed'; reason?: string }, done: string) => {
    setError(null);
    try {
      await patch.mutateAsync(v);
      toast.success(done);
    } catch (e) {
      setError(isApiError(e) ? e.message : String(e));
    }
  };

  const items = board.data?.items ?? [];
  return (
    <Card
      title="Deliveries and collections"
      actions={
        <div className="row no-print">
          {(Object.keys(RANGE_TEXT) as Range[]).map((r) => (
            <Button key={r} size="sm" variant={r === range ? 'primary' : 'secondary'} onClick={() => setRange(r)} aria-pressed={r === range}>
              {RANGE_TEXT[r]}
            </Button>
          ))}
          <Button size="sm" onClick={() => window.print()}>
            Print run sheet
          </Button>
        </div>
      }
    >
      <ErrorAlert message={error} />
      {board.isLoading && <Loading />}
      {board.isError && <ErrorAlert message={(board.error as Error).message} />}
      {board.data && items.length === 0 && <p className="muted">Nothing booked for {RANGE_TEXT[range].toLowerCase()}.</p>}
      {items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Movements {RANGE_TEXT[range]}</caption>
            <thead>
              <tr>
                <th>Slot</th>
                <th>What</th>
                <th>Car</th>
                <th>Client</th>
                <th>Address</th>
                <th>Status</th>
                <th className="no-print">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id}>
                  <td className="nowrap">{m.slot}</td>
                  <td>{m.kind === 'delivery' ? '↓ Delivery' : m.kind === 'collection' ? '↑ Collection' : m.kind.replace('_', ' ')}</td>
                  <td>
                    <span className="bk-plate">{m.registration}</span>
                    <div className="xs muted">{m.label}</div>
                  </td>
                  <td>
                    {m.clientName ?? '—'}
                    {m.clientPhone && (
                      <div className="xs">
                        <a href={`tel:${m.clientPhone}`}>{m.clientPhone}</a>
                      </div>
                    )}
                    <div className="xs">
                      <Link to={`/claims/${m.claimId}`}>{m.claimReference}</Link>
                    </div>
                  </td>
                  <td className="small">{addressText(m.address, m.postcode)}</td>
                  <td>
                    <Badge tone={STATUS_TONE[m.status]}>{m.status}</Badge>
                  </td>
                  <td className="no-print">
                    <div className="mv-actions">
                      {m.status === 'planned' && (
                        <Button size="sm" onClick={() => void act({ id: m.id, status: 'confirmed' }, 'Marked confirmed')}>
                          Confirmed
                        </Button>
                      )}
                      {(m.status === 'planned' || m.status === 'confirmed') && m.kind === 'delivery' && (
                        <Button size="sm" variant="primary" disabled={m.reservationStatus !== 'confirmed'} title={m.reservationStatus !== 'confirmed' ? 'Confirm the booking first' : undefined} onClick={() => setDialog({ kind: 'handover', reservationId: m.reservationId })}>
                          Done → Handover
                        </Button>
                      )}
                      {(m.status === 'planned' || m.status === 'confirmed') && m.kind === 'collection' && (
                        <Button size="sm" variant="primary" disabled={m.reservationStatus !== 'on_hire'} onClick={() => setDialog({ kind: 'return', reservationId: m.reservationId })}>
                          Done → Return
                        </Button>
                      )}
                      {(m.status === 'planned' || m.status === 'confirmed') && (
                        <Button size="sm" variant="danger" onClick={() => setFailing(m)}>
                          Failed
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <HandoverDialog open={dialog?.kind === 'handover'} reservationId={dialog?.reservationId ?? ''} onClose={() => setDialog(null)} />
      <ReturnDialog open={dialog?.kind === 'return'} reservationId={dialog?.reservationId ?? ''} onClose={() => setDialog(null)} />
      <Modal
        open={failing !== null}
        title="The movement did not happen"
        onClose={() => setFailing(null)}
        footer={
          <>
            <Button onClick={() => setFailing(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={reason.trim().length < 3}
              onClick={() => {
                const m = failing!;
                setFailing(null);
                void act({ id: m.id, status: 'failed', reason: reason.trim() }, 'Marked failed — the autopilot proposes a new slot');
                setReason('');
              }}
            >
              Mark failed
            </Button>
          </>
        }
      >
        <TextInput label="What happened?" value={reason} onChange={setReason} autoFocus />
        <p className="small muted">The booking stays; plan a new slot from the booking (the autopilot proposes one when it is on).</p>
      </Modal>
    </Card>
  );
}
