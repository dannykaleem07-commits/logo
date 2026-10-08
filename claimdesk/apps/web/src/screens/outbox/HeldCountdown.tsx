// owned by mail
import { useEffect, useRef, useState } from 'react';
import { formatCountdown, holdSecondsLeft } from '../../api/mailApi';

/**
 * Seconds left before a held email leaves (docs/SUPREME-DESIGN.md §D.3). Uses the server's clock (`serverNow`) so a
 * PC clock that is a little off does not mislead; once it reaches zero it says "sending".
 */
export function HeldCountdown({ holdUntil, serverNow }: { holdUntil: string | null; serverNow: string }) {
  const received = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    received.current = Date.now();
  }, [serverNow]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = holdSecondsLeft(holdUntil, serverNow, received.current, now);
  return (
    <span className="ob-countdown" aria-live="polite" title={holdUntil ?? undefined}>
      {left > 0 ? `Sending in ${formatCountdown(left)}` : 'Sending now'}
    </span>
  );
}
