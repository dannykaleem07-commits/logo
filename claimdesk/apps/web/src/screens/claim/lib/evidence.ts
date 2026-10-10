/**
 * Evidence presentation helpers (pure). Evidence is write-once: the screen offers upload and nothing else.
 */
import type { Evidence, EvidenceKind, ExifSummary, GuidedShot, ISODateTime } from '@ccguk/domain';
import type { EvidenceUploadFields } from '../../../api/client';
import type { FormResult } from './chronology';

export const EVIDENCE_KIND_LABEL: Record<EvidenceKind, string> = {
  photo: 'Photo',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  pdf: 'PDF',
  screenshot: 'Screenshot',
  advert: 'Advert (comparable)',
  bank_statement: 'Bank statement',
  payslip: 'Payslip',
  licence: 'Driving licence',
  v5c: 'V5C',
  mot_certificate: 'MOT certificate',
  insurance_certificate: 'Insurance certificate',
  estimate: 'Estimate',
  invoice: 'Invoice',
  engineer_report: "Engineer's report",
  correspondence: 'Correspondence',
  call_recording: 'Call recording',
  cctv: 'CCTV',
  dashcam: 'Dashcam',
  witness_statement: 'Witness statement',
  signature_image: 'Signature (kiosk)',
  signed_document: 'Signed document',
  other: 'Other'
};

export const EVIDENCE_KIND_OPTIONS = (Object.keys(EVIDENCE_KIND_LABEL) as EvidenceKind[])
  .map((value) => ({ value, label: EVIDENCE_KIND_LABEL[value] }))
  .sort((a, b) => a.label.localeCompare(b.label));

export const GUIDED_SHOT_LABEL: Record<GuidedShot, string> = {
  front_left: 'Front left corner',
  front_right: 'Front right corner',
  rear_left: 'Rear left corner',
  rear_right: 'Rear right corner',
  damage_close_1: 'Damage close-up 1',
  damage_close_2: 'Damage close-up 2',
  damage_close_3: 'Damage close-up 3',
  odometer: 'Odometer',
  vin_plate: 'VIN plate',
  tyre_fl: 'Tyre front left',
  tyre_fr: 'Tyre front right',
  tyre_rl: 'Tyre rear left',
  tyre_rr: 'Tyre rear right',
  interior: 'Interior',
  number_plate: 'Number plate'
};
export const GUIDED_SHOT_OPTIONS = (Object.keys(GUIDED_SHOT_LABEL) as GuidedShot[]).map((value) => ({ value, label: GUIDED_SHOT_LABEL[value] }));

export function evidenceKindLabel(kind: EvidenceKind | string): string {
  return (EVIDENCE_KIND_LABEL as Record<string, string>)[kind] ?? kind.replace(/_/g, ' ');
}

/** First `n` hex characters of a hash for tables; the full value sits in the title attribute. */
export function shortHash(sha256: string | undefined, n = 10): string {
  if (!sha256) return '—';
  return sha256.length <= n ? sha256 : `${sha256.slice(0, n)}…`;
}

export function bytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One-line EXIF summary: device, original time, GPS, pixel size. Empty string when there is nothing. */
export function exifSummary(exif: ExifSummary | undefined): string {
  if (!exif) return '';
  const parts: string[] = [];
  const device = [exif.make, exif.model].filter(Boolean).join(' ');
  if (device) parts.push(device);
  if (exif.dateTimeOriginal) parts.push(`taken ${exif.dateTimeOriginal.replace('T', ' ').slice(0, 16)}`);
  if (exif.gps) parts.push(`GPS ${exif.gps.lat.toFixed(5)}, ${exif.gps.lon.toFixed(5)}`);
  if (exif.widthPx && exif.heightPx) parts.push(`${exif.widthPx}×${exif.heightPx}`);
  if (exif.software) parts.push(`software ${exif.software}`);
  return parts.join(' · ');
}

export function isImage(mime: string): boolean {
  return mime.startsWith('image/');
}

export interface EvidenceFilter {
  kind?: EvidenceKind | '';
  q?: string;
  guidedOnly?: boolean;
}

export function filterEvidence(items: Evidence[], f: EvidenceFilter): Evidence[] {
  const q = (f.q ?? '').trim().toLowerCase();
  return items.filter((e) => {
    if (f.kind && e.kind !== f.kind) return false;
    if (f.guidedOnly && !e.captureShot) return false;
    if (q && !`${e.filename} ${e.description ?? ''} ${e.sha256}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Newest upload first. */
export function sortEvidence(items: Evidence[]): Evidence[] {
  return [...items].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export interface UploadForm {
  kind: EvidenceKind | '';
  description: string;
  capturedAt: ISODateTime | '';
  captureShot: GuidedShot | '';
  sourceUrl: string;
}

export function emptyUploadForm(): UploadForm {
  return { kind: '', description: '', capturedAt: '', captureShot: '', sourceUrl: '' };
}

export function uploadFieldsFrom(form: UploadForm, file: File | null, sha256?: string): FormResult<EvidenceUploadFields> {
  const errors: Record<string, string> = {};
  if (!file) errors.file = 'Choose a file';
  if (!form.kind) errors.kind = 'What is it?';
  if (form.kind === 'advert' && !form.sourceUrl.trim()) errors.sourceUrl = 'A comparable needs its advert URL (manual capture, BLUEPRINT §4.2)';
  if (form.sourceUrl.trim() && !/^https?:\/\//i.test(form.sourceUrl.trim())) errors.sourceUrl = 'Enter a full URL starting with http:// or https://';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      kind: form.kind as EvidenceKind,
      description: form.description.trim() || undefined,
      capturedAt: form.capturedAt || undefined,
      captureShot: form.captureShot || undefined,
      sourceUrl: form.sourceUrl.trim() || undefined,
      sha256
    }
  };
}

/** Guess the evidence kind from the file so the picker is pre-filled (still editable). */
export function guessKind(file: Pick<File, 'type' | 'name'>): EvidenceKind {
  if (file.type.startsWith('image/')) return 'photo';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'call_recording';
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  return 'document';
}

/** SHA-256 of the bytes with Web Crypto (never the node helper in the browser), as lowercase hex. */
export async function sha256HexOf(data: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
