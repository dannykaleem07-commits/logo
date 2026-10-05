import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Button } from './Button';

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
}

/** The top-most open modal is the last `.modal` in document order (portals and nested dialogs render after their parent). */
function isTopmost(el: HTMLElement | null): boolean {
  if (!el) return false;
  const all = document.querySelectorAll('.modal');
  return all.length > 0 && all[all.length - 1] === el;
}

/**
 * Dialog. Focus rules (docs/V03-MANAGER-MODE-HIRE-PRICING.md §D — the "clicks off per character" bug):
 * `onClose` is read through a ref, so a parent that passes a new closure on every render (most do) never re-runs the
 * effects; the effects are keyed on `[open]` only; initial focus happens once per opening and never when focus is
 * already inside (an `autoFocus` field keeps it); Escape closes only the top-most modal; focus returns to the opener.
 */
export function Modal({ open, title, onClose, children, footer, size = 'md' }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  // Escape + scroll lock: [open] only; Escape closes only the top-most open modal (nested Add policy).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTopmost(ref.current)) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);
  // Initial focus once per opening, never while focus is already inside; restore focus to the opener on close.
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    if (el && !el.contains(document.activeElement)) el.focus();
    // A nested dialog (Add policy) hands focus back to its opener inside the parent dialog too; an opener that went
    // away with its own dialog (isConnected false) is skipped.
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCloseRef.current()}>
      <div className={size === 'lg' ? 'modal modal-lg' : 'modal'} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} ref={ref} tabIndex={-1}>
        <div className="modal-header">
          <h3>{title}</h3>
          <Button variant="ghost" size="sm" onClick={() => onCloseRef.current()} aria-label="Close">
            ✕
          </Button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
