import { useEffect, useRef } from 'react';

/**
 * A server refusal shown inside a dialog or form. It is scrolled into view when it appears or changes, so pressing
 * Save at the bottom of a long, scrolled modal never "does nothing" with the reason out of sight at the top.
 */
export function ErrorAlert({ message, className = '' }: { message: string | null | undefined; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [message]);
  if (!message) return null;
  return (
    <div ref={ref} className={`notice notice-danger ${className}`.trim()} role="alert">
      {message}
    </div>
  );
}
