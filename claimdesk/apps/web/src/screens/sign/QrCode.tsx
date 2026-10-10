// owned by ap-paperwork
/** A QR code as inline SVG (in-repo encoder, qr.ts), with the URL always printed in large type beside it (§E.3). */
import { useMemo } from 'react';
import { encodeQr, qrSvgPath } from './qr';

export function QrCode({ value, size = 220, label }: { value: string; size?: number; label?: string }) {
  const qr = useMemo(() => {
    try {
      return encodeQr(value);
    } catch {
      return null;
    }
  }, [value]);
  if (!qr) return <p className="muted">This link is too long for a QR code; type it instead.</p>;
  const dim = qr.size + 8;
  return (
    <figure className="kiosk-qr">
      <svg width={size} height={size} viewBox={`0 0 ${dim} ${dim}`} role="img" aria-label={label ?? `QR code for ${value}`} shapeRendering="crispEdges">
        <rect width={dim} height={dim} fill="#fff" />
        <path d={qrSvgPath(qr, 4)} fill="#000" />
      </svg>
      <figcaption className="kiosk-qr-url">{value}</figcaption>
    </figure>
  );
}
