// owned by intake-web
/** Small shared pieces of the case-bundle screens: confidence bar, source chip, readiness badge, side drawer. */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import type { BundleSummary, FieldSource } from '../../../api/bundlesApi';
import { confidenceTone, pct, provenanceLabel, READINESS_TONE, readinessText, ENGINE_LABEL } from './bundleModel';

export function ConfidenceBar({ value }: { value: number }) {
  const tone = confidenceTone(value);
  return (
    <span className="bdl-conf" title={`Confidence ${pct(value)}`}>
      <span className="bdl-conf-track">
        <span className={`bdl-conf-bar bdl-conf-${tone}`} style={{ width: pct(value) }} />
      </span>
      <span className="bdl-conf-text">{pct(value)}</span>
    </span>
  );
}

/** "V5C · p1" — opens the provenance drawer. */
export function SourceChip({ source, onOpen }: { source: FieldSource; onOpen?: (s: FieldSource) => void }) {
  const label = provenanceLabel(source);
  const title = `${source.filename}${source.page ? `, page ${source.page}` : ''} · ${ENGINE_LABEL[source.engine]} · ${pct(source.confidence)}`;
  if (!onOpen) return <span className="bdl-chip" title={title}>{label}</span>;
  return (
    <button type="button" className="bdl-chip bdl-chip-button" title={title} onClick={() => onOpen(source)} aria-label={`Source: ${label}`}>
      {label}
      {source.quoteVerified === false && <span className="bdl-chip-flag"> · quote not found</span>}
    </button>
  );
}

export function ReadinessBadge({ bundle }: { bundle: Pick<BundleSummary, 'readiness' | 'fileCounts' | 'claim'> }) {
  return <Badge tone={READINESS_TONE[bundle.readiness]}>{readinessText(bundle)}</Badge>;
}

/** A file-progress bar (read / total). */
export function ProgressBar({ value, total, label }: { value: number; total: number; label?: string }) {
  const p = total > 0 ? Math.round((Math.min(value, total) / total) * 100) : 0;
  return (
    <span className="bdl-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p} aria-label={label ?? 'Progress'}>
      <span className="bdl-progress-bar" style={{ width: `${p}%` }} />
    </span>
  );
}

/**
 * Side drawer (full screen on phones). Same focus rules as Modal: `onClose` read through a ref, effects keyed on
 * `[open]` only, initial focus once per opening, Escape closes, focus returns to the opener.
 */
export function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.modal')) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="bdl-drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCloseRef.current()}>
      <div className="bdl-drawer" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <div className="bdl-drawer-header">
          <h3>{title}</h3>
          <Button variant="ghost" size="sm" onClick={() => onCloseRef.current()} aria-label="Close">
            ✕
          </Button>
        </div>
        <div className="bdl-drawer-body">{children}</div>
      </div>
    </div>
  );
}
