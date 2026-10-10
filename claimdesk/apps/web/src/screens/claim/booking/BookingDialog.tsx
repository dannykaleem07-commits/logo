// owned by ap-booking
/**
 * Booking dialog (§I.2): period, use, needs, ranked cars, the not-available list and the clash panel.
 * Stub created by ap-foundation (docs/SUPREME-AUTOPILOT.md §K); built by ap-booking.
 */
import { ComingWithAutopilot } from '../../placeholders/ComingWithAutopilot';

export function BookingDialog({ open, onClose }: { open: boolean; claimId: string; onClose: () => void }) {
  if (!open) return null;
  return (
    <div role="dialog" aria-label="Find a car">
      <ComingWithAutopilot title="Find a car" bare>
        {null}
      </ComingWithAutopilot>
      <button type="button" className="btn btn-secondary" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
