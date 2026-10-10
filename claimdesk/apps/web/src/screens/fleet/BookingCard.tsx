// owned by ap-booking
/**
 * Booking card (docs/SUPREME-AUTOPILOT.md §I.3): opened from a calendar bar or a booking row. Shows the booking and its
 * history, and the next action a person takes: confirm or release a hold, hand the car over, record the return.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { DateText } from '../../components/DateText';
import { ErrorAlert } from '../../components/ErrorAlert';
import { TextInput } from '../../components/Form';
import { Loading } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { isApiError } from '../../api/client';
import { bookingsApi, STATUS_TEXT, useBooking, useBookingMutation } from '../../api/bookingsApi';
import { HandoverDialog, ReturnDialog } from '../claim/booking/HandoverDialog';
import './booking.css';

const TONE = { held: 'blue', confirmed: 'green', on_hire: 'navy', returned: 'grey', cancelled: 'grey', expired: 'amber' } as const;

export function BookingCard({ reservationId, onClose }: { reservationId: string | null; onClose: () => void }) {
  if (!reservationId) return null;
  return <BookingCardBody reservationId={reservationId} onClose={onClose} />;
}

function BookingCardBody({ reservationId, onClose }: { reservationId: string; onClose: () => void }) {
  const toast = useToast();
  const b = useBooking(reservationId);
  const [releasing, setReleasing] = useState(false);
  const [reason, setReason] = useState('');
  const [dialog, setDialog] = useState<'handover' | 'return' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useBookingMutation(() => bookingsApi.confirm(reservationId));
  const release = useBookingMutation(() => bookingsApi.release(reservationId, reason.trim()));
  const r = b.data;

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    try {
      await fn();
      toast.success(done);
      void b.refetch();
    } catch (e) {
      if (isApiError(e) && e.override) return;
      setError(isApiError(e) ? e.message : String(e));
    }
  };

  return (
    <>
      <Modal
        open={dialog === null}
        title={r ? `${r.registration} — ${STATUS_TEXT[r.status]}` : 'Booking'}
        onClose={onClose}
        footer={
          r && (
            <>
              {r.status === 'held' && (
                <Button variant="primary" loading={confirm.isPending} onClick={() => void run(() => confirm.mutateAsync(undefined), 'Booking confirmed')}>
                  Confirm (client accepted)
                </Button>
              )}
              {r.status === 'confirmed' && (
                <Button variant="primary" onClick={() => setDialog('handover')}>
                  Handover…
                </Button>
              )}
              {r.status === 'on_hire' && (
                <Button variant="primary" onClick={() => setDialog('return')}>
                  Return…
                </Button>
              )}
              {(r.status === 'held' || r.status === 'confirmed') && !releasing && (
                <Button variant="danger" onClick={() => setReleasing(true)}>
                  Release
                </Button>
              )}
              <Button onClick={onClose}>Close</Button>
            </>
          )
        }
      >
        {b.isLoading || !r ? (
          <Loading />
        ) : (
          <div className="stack-sm">
            <div className="row">
              <span className="bk-plate">{r.registration}</span>
              <span>{r.label}</span>
              <Badge tone={TONE[r.status]}>{STATUS_TEXT[r.status]}</Badge>
              {r.agreementNumber && <Badge tone="grey">{r.agreementNumber}</Badge>}
            </div>
            <p className="small">
              <DateText value={r.startAt} time /> → {r.expectedEndAt ? <DateText value={r.expectedEndAt} time /> : 'open'}
              {r.status === 'held' && r.holdExpiresAt && (
                <>
                  {' '}
                  · hold expires <DateText value={r.holdExpiresAt} time />
                </>
              )}
            </p>
            <p className="small">
              <Link to={`/claims/${r.claimId}`}>Open the claim</Link>
              {!r.signedPack.signed && r.status === 'confirmed' && <span className="muted"> · paperwork not signed yet ({r.signedPack.missing.join(', ')})</span>}
            </p>
            {r.substitutionReason && <p className="small">Substitution reason: {r.substitutionReason}</p>}
            {(r.clashReport ?? []).length > 0 && (
              <ul className="booking-warnings small">
                {(r.clashReport ?? []).map((w) => (
                  <li key={w.dedupeKey}>⚠ {w.message}</li>
                ))}
              </ul>
            )}
            {r.movements.length > 0 && (
              <ul className="small">
                {r.movements.map((m) => (
                  <li key={m.id}>
                    {m.kind === 'delivery' ? '↓ Delivery' : m.kind === 'collection' ? '↑ Collection' : m.kind} <DateText value={m.windowStart} time />–<DateText value={m.windowEnd} time /> · {m.status}
                  </li>
                ))}
              </ul>
            )}
            <details>
              <summary className="small">History ({r.events.length})</summary>
              <ul className="small">
                {r.events.map((e) => (
                  <li key={e.id}>
                    <DateText value={e.at} time /> — {e.fromStatus ? `${STATUS_TEXT[e.fromStatus]} → ` : ''}
                    {STATUS_TEXT[e.toStatus]}
                    {e.reason ? `: ${e.reason}` : ''} ({e.actor})
                  </li>
                ))}
              </ul>
            </details>
            {releasing && (
              <div className="row">
                <TextInput label="Why release it?" value={reason} onChange={setReason} />
                <Button variant="danger" disabled={reason.trim().length < 3} loading={release.isPending} onClick={() => void run(() => release.mutateAsync(undefined), 'Booking released')}>
                  Release the car
                </Button>
              </div>
            )}
            <ErrorAlert message={error} />
          </div>
        )}
      </Modal>
      <HandoverDialog
        open={dialog === 'handover'}
        reservationId={reservationId}
        onClose={() => {
          setDialog(null);
          void b.refetch();
        }}
      />
      <ReturnDialog
        open={dialog === 'return'}
        reservationId={reservationId}
        onClose={() => {
          setDialog(null);
          void b.refetch();
        }}
      />
    </>
  );
}
