// owned by ap-paperwork
/**
 * Signature pad (docs/SUPREME-AUTOPILOT.md §I.6): draw with a finger, pen or mouse on a canvas; Clear starts again.
 * Reports the drawing as a PNG data URL (null when empty). Written in-repo (no dependency).
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components';

export function SignaturePad({ onChange, disabled = false }: { onChange: (png: string | null) => void; disabled?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const rect = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round((rect.width || 600) * ratio));
    c.height = Math.max(1, Math.round((rect.height || 200) * ratio));
    let g: CanvasRenderingContext2D | null = null;
    try {
      g = c.getContext('2d');
    } catch {
      g = null; // no canvas support (test environments)
    }
    if (!g) return;
    g.scale(ratio, ratio);
    g.lineWidth = 2.5;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = '#111';
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const finish = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    const c = canvas.current;
    if (c && !empty) onChange(c.toDataURL('image/png'));
  };

  return (
    <div className="kiosk-signature">
      <canvas
        ref={canvas}
        className="kiosk-signature-canvas"
        aria-label="Signature box: draw your signature here"
        role="img"
        onPointerDown={(e) => {
          if (disabled) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drawing.current = true;
          last.current = point(e);
        }}
        onPointerMove={(e) => {
          if (!drawing.current || disabled) return;
          const g = canvas.current?.getContext('2d');
          const p = point(e);
          if (g && last.current) {
            g.beginPath();
            g.moveTo(last.current.x, last.current.y);
            g.lineTo(p.x, p.y);
            g.stroke();
            if (empty) setEmpty(false);
          }
          last.current = p;
        }}
        onPointerUp={finish}
        onPointerLeave={finish}
      />
      <div className="row">
        <span className="muted small">{empty ? 'Sign in the box above' : 'Signature drawn'}</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            const c = canvas.current;
            const g = c?.getContext('2d');
            if (c && g) g.clearRect(0, 0, c.width, c.height);
            setEmpty(true);
            onChange(null);
          }}
        >
          Clear and sign again
        </Button>
      </div>
    </div>
  );
}
