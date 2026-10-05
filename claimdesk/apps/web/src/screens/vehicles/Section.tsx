import { useEffect, useState, type ReactNode } from 'react';

/**
 * A closed-by-default section (0.3 §E: every capability stays one click away). It opens itself when `forceOpen`
 * becomes true — a validation error inside must never hide behind a closed section.
 */
export function Section({ summary, children, forceOpen = false, defaultOpen = false, className = '' }: { summary: ReactNode; children: ReactNode; forceOpen?: boolean; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen || forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  return (
    <details className={`section ${className}`.trim()} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="section-summary">{summary}</summary>
      <div className="section-body">{children}</div>
    </details>
  );
}
