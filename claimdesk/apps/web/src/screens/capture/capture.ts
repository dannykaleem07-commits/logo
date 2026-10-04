/**
 * Guided capture model (pure; unit-tested). BLUEPRINT §2 "Guided Image Capture" and §3.8 chain of custody:
 * the 8–12 shot list comes from @ccguk/domain `guidedShotList`; every shot is hashed on the device with Web
 * Crypto BEFORE upload (never `sha256Hex`, which needs node:crypto) and the server's hash is compared back.
 * EXIF-equivalent facts (capture time, device, GPS when permitted) travel in the upload fields.
 */
import type { Evidence, GuidedShot, ISODateTime } from '@ccguk/domain';
import { guidedShotList, type GuidedShotInstruction } from '@ccguk/domain';
import type { EvidenceUploadFields } from '../../api/client';

export const SHOT_LABEL: Record<GuidedShot, string> = {
  front_left: 'Front-left corner',
  front_right: 'Front-right corner',
  rear_left: 'Rear-left corner',
  rear_right: 'Rear-right corner',
  damage_close_1: 'Damage close-up 1',
  damage_close_2: 'Damage close-up 2',
  damage_close_3: 'Damage close-up 3',
  odometer: 'Odometer',
  vin_plate: 'VIN plate',
  tyre_fl: 'Tyre front-left',
  tyre_fr: 'Tyre front-right',
  tyre_rl: 'Tyre rear-left',
  tyre_rr: 'Tyre rear-right',
  interior: 'Interior',
  number_plate: 'Number plate'
};

export type OutlineKind = 'car_front_left' | 'car_front_right' | 'car_rear_left' | 'car_rear_right' | 'plate' | 'vin' | 'odometer' | 'damage' | 'tyre' | 'interior';

export function outlineKind(shot: GuidedShot): OutlineKind {
  switch (shot) {
    case 'front_left':
      return 'car_front_left';
    case 'front_right':
      return 'car_front_right';
    case 'rear_left':
      return 'car_rear_left';
    case 'rear_right':
      return 'car_rear_right';
    case 'number_plate':
      return 'plate';
    case 'vin_plate':
      return 'vin';
    case 'odometer':
      return 'odometer';
    case 'interior':
      return 'interior';
    case 'tyre_fl':
    case 'tyre_fr':
    case 'tyre_rl':
    case 'tyre_rr':
      return 'tyre';
    default:
      return 'damage';
  }
}

export function shotList(): GuidedShotInstruction[] {
  return guidedShotList();
}

// ---------------------------------------------------------------------------
// Hashing (Web Crypto)
// ---------------------------------------------------------------------------

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** SHA-256 hex of a blob or byte buffer using `crypto.subtle` (browser and Node 22 alike). */
export async function sha256HexOf(data: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto is unavailable — hashing before upload is required for chain of custody');
  let buffer: ArrayBuffer;
  if (data instanceof Uint8Array) buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  else if (data instanceof ArrayBuffer) buffer = data;
  else buffer = await data.arrayBuffer();
  const digest = await subtle.digest('SHA-256', buffer);
  return bytesToHex(new Uint8Array(digest));
}

export function shortHash(hex: string | undefined, n = 12): string {
  return hex ? `${hex.slice(0, n)}…` : '—';
}

// ---------------------------------------------------------------------------
// Capture items
// ---------------------------------------------------------------------------

export interface CaptureGps {
  lat: number;
  lon: number;
  accuracyM?: number;
}

export interface CaptureMeta {
  capturedAt: ISODateTime;
  device: string;
  source: 'camera' | 'file';
  gps?: CaptureGps;
  widthPx?: number;
  heightPx?: number;
}

export type CaptureStatus = 'ready' | 'uploading' | 'uploaded' | 'error';

export interface CaptureItem {
  shot: GuidedShot;
  blob: Blob;
  filename: string;
  previewUrl: string;
  sha256: string;
  meta: CaptureMeta;
  status: CaptureStatus;
  evidence?: Evidence;
  error?: string;
}

/** Short device description from the user agent (the EXIF "make/model" stand-in a browser can offer). */
export function describeDevice(ua: string | undefined): string {
  if (!ua) return 'unknown device';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'device';
  const browser = /EdgA?\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  const model = ua.match(/Android [^;]+; ([^)]+?)(?: Build|\))/)?.[1];
  return [os, model, browser].filter(Boolean).join(' · ');
}

export function captureFileName(shot: GuidedShot, capturedAt: ISODateTime, ext = 'jpg'): string {
  return `${shot}-${capturedAt.replace(/[:.]/g, '-')}.${ext}`;
}

export function formatGps(gps: CaptureGps | undefined): string | undefined {
  if (!gps) return undefined;
  return `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}${gps.accuracyM !== undefined ? ` (±${Math.round(gps.accuracyM)} m)` : ''}`;
}

/** Fields for POST /claims/:id/evidence. kind is always 'photo'; the local hash goes with it for the server to verify. */
export function buildEvidenceFields(item: Pick<CaptureItem, 'shot' | 'sha256' | 'meta'>): EvidenceUploadFields {
  const parts = [`Guided capture: ${SHOT_LABEL[item.shot]}`, `device: ${item.meta.device}`, `source: ${item.meta.source}`];
  const gps = formatGps(item.meta.gps);
  if (gps) parts.push(`GPS: ${gps}`);
  if (item.meta.widthPx && item.meta.heightPx) parts.push(`${item.meta.widthPx}×${item.meta.heightPx}px`);
  return { kind: 'photo', captureShot: item.shot, capturedAt: item.meta.capturedAt, sha256: item.sha256, description: parts.join(' · ') };
}

export type CustodyState = 'match' | 'mismatch' | 'pending';

/** Local hash vs the hash the server computed on the bytes it stored. */
export function custodyState(local: string, server: string | undefined): CustodyState {
  if (!server) return 'pending';
  return server.toLowerCase() === local.toLowerCase() ? 'match' : 'mismatch';
}

export interface CaptureProgress {
  total: number;
  required: number;
  captured: number;
  uploaded: number;
  requiredDone: number;
  requiredMissing: GuidedShot[];
  pct: number;
}

export function captureProgress(shots: GuidedShotInstruction[], items: Partial<Record<GuidedShot, CaptureItem>>): CaptureProgress {
  const required = shots.filter((s) => s.required);
  const captured = shots.filter((s) => items[s.shot]).length;
  const uploaded = shots.filter((s) => items[s.shot]?.status === 'uploaded').length;
  const requiredDone = required.filter((s) => items[s.shot]?.status === 'uploaded').length;
  const requiredMissing = required.filter((s) => !items[s.shot]).map((s) => s.shot);
  return { total: shots.length, required: required.length, captured, uploaded, requiredDone, requiredMissing, pct: shots.length ? Math.round((uploaded / shots.length) * 100) : 0 };
}

/** The next shot without a capture after `current` (wrapping), or undefined when everything is captured. */
export function nextShot(shots: GuidedShotInstruction[], items: Partial<Record<GuidedShot, CaptureItem>>, current: GuidedShot): GuidedShot | undefined {
  const idx = shots.findIndex((s) => s.shot === current);
  for (let i = 1; i <= shots.length; i++) {
    const s = shots[(idx + i) % shots.length];
    if (s && !items[s.shot]) return s.shot;
  }
  return undefined;
}
