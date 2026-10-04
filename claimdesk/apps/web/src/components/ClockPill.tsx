import type { Clock } from '@ccguk/domain';
import { describeDue, formatDateTime } from '../lib/dates';
import { dueState } from '../lib/clocks';

export type ClockLike = Pick<Clock, 'dueAt' | 'status' | 'label' | 'basis'> & Partial<Pick<Clock, 'attributableTo' | 'stoppedReason' | 'metAt'>>;

/** "due in 2 days" / "overdue by 3 days" pill; the basis citation sits in the tooltip (GTA = benchmark only). */
export function ClockPill({ clock, now = new Date(), showLabel = false }: { clock: ClockLike; now?: Date; showLabel?: boolean }) {
  const state = dueState(clock, now);
  let text: string;
  switch (state) {
    case 'met':
      text = clock.metAt ? `met ${formatDateTime(clock.metAt)}` : 'met';
      break;
    case 'stopped':
      text = clock.stoppedReason ? `stopped: ${clock.stoppedReason}` : 'stopped';
      break;
    default:
      text = describeDue(clock.dueAt, now);
  }
  const title = [clock.label, `Due ${formatDateTime(clock.dueAt)}`, `Basis: ${clock.basis}`, clock.attributableTo ? `On: ${clock.attributableTo}` : '']
    .filter(Boolean)
    .join('\n');
  return (
    <span className={`clock clock-${state}`} title={title} aria-label={title}>
      {showLabel && <span>{clock.label} ·</span>}
      {text}
    </span>
  );
}
