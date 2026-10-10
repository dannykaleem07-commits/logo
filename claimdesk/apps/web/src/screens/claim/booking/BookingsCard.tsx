// owned by ap-booking
/**
 * Bookings card on the Hire tab (docs/SUPREME-AUTOPILOT.md §I.2, §I.5): the claim's fleet bookings (held, confirmed,
 * on hire, returned) with "Find a car" (the booking dialog) and the next action on each — confirm, deliver, hand over,
 * return. A hire record is created at handover from the confirmed booking; "Start hire" below stays for hires recorded
 * by hand.
 */
import { useState } from 'react';
import { Card } from '../../../components/Card';
import { Button } from '../../../components/Button';
import { Badge } from '../../../components/Badge';
import { DateText } from '../../../components/DateText';
import { ApiErrorNotice } from '../../../components/ApiErrorNotice';
import { STATUS_TEXT, useClaimBookings } from '../../../api/bookingsApi';
import { BookingDialog } from './BookingDialog';
import { BookingCard } from '../../fleet/BookingCard';
import '../../fleet/booking.css';

const TONE = { held: 'blue', confirmed: 'green', on_hire: 'navy', returned: 'grey', cancelled: 'grey', expired: 'amber' } as const;

export function BookingsCard({ claimId }: { claimId: string }) {
  const q = useClaimBookings(claimId);
  const [finding, setFinding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const all = q.data?.reservations ?? [];
  const shown = all.filter((r) => r.status !== 'cancelled' && r.status !== 'expired');
  const live = shown.find((r) => r.status === 'held' || r.status === 'confirmed' || r.status === 'on_hire');
  return (
    <Card
      title="Fleet bookings"
      actions={
        <Button size="sm" variant={live ? 'secondary' : 'primary'} onClick={() => setFinding(true)}>
          {live && live.status !== 'on_hire' ? 'Change car' : 'Find a car'}
        </Button>
      }
    >
      <ApiErrorNotice error={q.error} what="load the bookings" />
      {shown.length === 0 ? (
        <p className="muted small">No car is held or booked for this claim. "Find a car" searches the fleet for the whole expected hire.</p>
      ) : (
        <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {shown.map((r) => (
            <li key={r.id} className="row-between">
              <span className="row">
                <span className="bk-plate">{r.registration}</span>
                <span className="small">{r.label}</span>
                <Badge tone={TONE[r.status]}>{STATUS_TEXT[r.status]}</Badge>
                {r.agreementNumber && <span className="small muted">{r.agreementNumber}</span>}
              </span>
              <span className="row small">
                <DateText value={r.startAt} time /> → {r.expectedEndAt ? <DateText value={r.expectedEndAt} time /> : 'open'}
                <Button size="sm" variant="ghost" onClick={() => setOpen(r.id)}>
                  {r.status === 'held' ? 'Confirm / release' : r.status === 'confirmed' ? 'Handover…' : r.status === 'on_hire' ? 'Return…' : 'Details'}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <BookingDialog open={finding} claimId={claimId} onClose={() => setFinding(false)} />
      <BookingCard reservationId={open} onClose={() => setOpen(null)} />
    </Card>
  );
}
