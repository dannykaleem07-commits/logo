/**
 * Risk signals at intake (docs/SMART-INTAKE.md §4.11, improvement 9) — for the owner's eyes only. Every message is
 * neutral and carries the innocent explanation; nothing is ever declined or reported because of a signal, and no
 * signal reaches an agent prompt, a document, the chronology or an email. Signals block only automatic registration.
 */
import type { DocType } from '../../agents/types.js';
import { BANNED_INTAKE_WORDS, type PdfMeta, type PhotoScene, type RiskSeverity, type RiskSignal, type RiskSignalCode } from './types.js';
import { daysBetween, displayPlate, isoMs, londonDayOf, normVrm, sha1Hex } from './text.js';
import { distanceKm, gpsOutliers } from './photo.js';
import { DOC_TYPE_PLAIN } from './ranking.js';

export interface SignalsInput {
  accidentAt: string | null;
  accidentDay: string | null;
  photos: Array<{
    fileId: string;
    takenAt: string | null;
    gps: { lat: number; lon: number } | null;
    software: string | null;
    plates: string[];
    scene: PhotoScene | null;
    onOtherClaims: Array<{ claimId: string; reference: string; how: 'same_file' | 'near_same_photo' }>;
  }>;
  documents: Array<{
    fileId: string;
    docType: DocType | null;
    documentDate: string | null;
    validFrom?: string;
    validTo?: string;
    keeperSince?: string;
    pdfMeta?: PdfMeta | null;
    extensionMatches: boolean;
    injection: boolean;
    /** For FILE_TYPE_MISMATCH: the name's extension and the real kind. */
    ext?: string | null;
    kind?: string | null;
  }>;
  clientVrm: string | null;
  tpVrm: string | null;
  otherClaims: {
    vehicle: Array<{ claimId: string; reference: string; how: 'registration' | 'vin'; open: boolean; status?: string }>;
    fleetUnit: boolean;
    contacts: Array<{ claimId: string; reference: string; field: 'phone' | 'email' | 'address' | 'bank'; open: boolean }>;
    claimant: Array<{ claimId: string; reference: string; how: 'licence' | 'name_dob'; open: boolean; daysApart: number | null; status?: string }>;
  };
  settings: { beforeAccidentToleranceHours: number; gpsOutlierKm: number };
  acks: Record<string, { by: string; note: string | null; at?: string }>;
  /** When the newest file arrived (ACCIDENT_IN_FUTURE). */
  newestUploadAt?: string | null;
  /** The client car's age at the accident, when known (MOT_EXPIRED applies over 3 years). */
  vehicleAgeYears?: number | null;
  /** The AI reading the bundle together flagged text aimed at an AI (no single file named). */
  bundleInjection?: boolean;
}

export const SIGNAL_TEXT: Readonly<Record<RiskSignalCode, { title: string; severity: RiskSeverity; template: string }>> = {
  PHOTO_BEFORE_ACCIDENT: { title: 'Photo dated before the accident', severity: 'warn', template: 'Photo taken on {date}, before the accident date. Camera clocks are often wrong — worth checking with the client.' },
  PHOTO_LONG_AFTER: { title: 'Photo taken long after the accident', severity: 'info', template: 'Taken {days} days after the accident; it may show the car’s later condition.' },
  PHOTO_GPS_OUTLIER: { title: 'Photo taken somewhere else', severity: 'info', template: 'Taken about {km} km from the other photos.' },
  PHOTO_EDITED_SOFTWARE: { title: 'Photo saved by an editing app', severity: 'info', template: 'Saved by {software}; editing apps also just resize photos.' },
  PHOTO_ON_OTHER_CLAIM: { title: 'Same photo on another claim', severity: 'warn', template: 'The same photo is on {ref}.' },
  PLATE_NOT_ON_CASE: { title: 'Plate not on this case', severity: 'warn', template: 'Plate {vrm} in this photo is not a registration on this case.' },
  DOC_DATED_BEFORE_ACCIDENT: { title: 'Document dated before the accident', severity: 'warn', template: '{doc} is dated {date}, before the accident on {accident}.' },
  KEEPER_AFTER_ACCIDENT: { title: 'Keeper from after the accident', severity: 'warn', template: 'The V5C shows the client as keeper from {date}.' },
  INSURANCE_NOT_IN_FORCE: { title: 'Insurance dates do not cover the accident', severity: 'warn', template: 'The certificate covers {from}–{to}.' },
  LICENCE_EXPIRED: { title: 'Licence photocard expired', severity: 'warn', template: 'The photocard expired on {date} (the entitlement may still be valid).' },
  MOT_EXPIRED: { title: 'MOT expired', severity: 'info', template: 'MOT expired on {date}.' },
  ACCIDENT_IN_FUTURE: { title: 'Accident date after the documents', severity: 'warn', template: 'The accident date is after the documents were received.' },
  VEHICLE_ON_OTHER_CLAIM: { title: 'Car on another claim', severity: 'warn', template: 'This car is also on {ref} ({status}).' },
  FLEET_VEHICLE_AS_CLIENT: { title: 'One of our own fleet cars', severity: 'warn', template: 'This registration is one of our own fleet cars.' },
  CONTACT_ON_OTHER_CLAIM: { title: 'Contact details on another claim', severity: 'warn', template: 'Same {field} as a party on {ref}.' },
  DUPLICATE_CLAIMANT: { title: 'Client has another claim', severity: 'warn', template: 'The client also has {ref} ({status}).' },
  PDF_EDITED_AFTER_CREATION: { title: 'PDF modified after it was made', severity: 'info', template: 'Modified {n} days after it was created — normal for many offices.' },
  PDF_EDITOR_PRODUCER: { title: 'PDF saved with an editing tool', severity: 'info', template: 'Last saved with {producer}.' },
  PDF_INCREMENTAL_UPDATES: { title: 'PDF saved several times', severity: 'info', template: 'Saved {n} times after it was first made.' },
  FILE_TYPE_MISMATCH: { title: 'File name does not match its type', severity: 'info', template: 'Named .{ext} but is a {kind}.' },
  INSTRUCTIONS_IN_DOCUMENT: { title: 'Text aimed at an AI', severity: 'warn', template: 'Contains text aimed at an AI; it was treated as data only.' },
};

const PHOTO_EDITORS = /photoshop|snapseed|lightroom|picsart|gimp/i;
const PDF_EDITORS = /acrobat(?!\s*distiller)|ilovepdf|sejda|pdfescape|smallpdf|pdf-?xchange/i;
const DATED_DOC_TYPES = new Set<DocType>(['insurer_letter', 'correspondence', 'bodyshop_estimate', 'audatex_estimate', 'engineer_report', 'police_report', 'invoice']);

const fill = (t: string, vars: Record<string, string | number>): string => t.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ''));
const ukDate = (iso: string): string => {
  const d = londonDayOf(iso) ?? iso.slice(0, 10);
  const [y, m, day] = d.split('-');
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${Number(day)} ${months[Number(m) - 1] ?? ''} ${y}`;
};

export function signalId(code: RiskSignalCode, fileIds: string[], subject: string): string {
  return `s:${sha1Hex(`${code}|${[...fileIds].sort().join(',')}|${subject}`, 12)}`;
}

export function riskSignals(input: SignalsInput): RiskSignal[] {
  const out: RiskSignal[] = [];
  const add = (code: RiskSignalCode, vars: Record<string, string | number>, opts: { fileIds?: string[]; claims?: Array<{ id: string; reference: string }>; severity?: RiskSeverity; subject?: string; basis?: RiskSignal['basis'] } = {}) => {
    const t = SIGNAL_TEXT[code];
    const fileIds = opts.fileIds ?? [];
    const id = signalId(code, fileIds, opts.subject ?? '');
    if (out.some((s) => s.id === id)) return;
    const ack = input.acks[id];
    out.push({
      id,
      code,
      severity: opts.severity ?? t.severity,
      title: t.title,
      message: fill(t.template, vars),
      fileIds,
      claims: opts.claims ?? [],
      basis: opts.basis ?? fileIds.map((f) => ({ fileId: f, page: null, quote: null })),
      acknowledged: ack ? { by: ack.by, at: ack.at ?? '', note: ack.note } : null,
    });
  };
  const accMs = isoMs(input.accidentAt);
  const accDay = input.accidentDay ?? (input.accidentAt ? londonDayOf(input.accidentAt) : null);

  // ----- photos
  const tolMs = input.settings.beforeAccidentToleranceHours * 3_600_000;
  for (const p of input.photos) {
    const taken = isoMs(p.takenAt);
    if (taken !== null && accMs !== null && p.scene !== 'document') {
      if (taken < accMs - tolMs) add('PHOTO_BEFORE_ACCIDENT', { date: ukDate(p.takenAt!) }, { fileIds: [p.fileId] });
      const days = (taken - accMs) / 86_400_000;
      if (days > 30) add('PHOTO_LONG_AFTER', { days: Math.round(days) }, { fileIds: [p.fileId] });
    }
    if (p.software && PHOTO_EDITORS.test(p.software)) add('PHOTO_EDITED_SOFTWARE', { software: p.software }, { fileIds: [p.fileId] });
    for (const o of p.onOtherClaims) add('PHOTO_ON_OTHER_CLAIM', { ref: o.reference }, { fileIds: [p.fileId], claims: [{ id: o.claimId, reference: o.reference }], subject: o.claimId });
    if (p.scene === 'damage' && (input.clientVrm || input.tpVrm)) {
      const known = [input.clientVrm, input.tpVrm].filter((v): v is string => Boolean(v)).map(normVrm);
      for (const plate of p.plates) {
        const n = normVrm(plate);
        if (n && !known.includes(n)) add('PLATE_NOT_ON_CASE', { vrm: displayPlate(n) }, { fileIds: [p.fileId], subject: n });
      }
    }
  }
  const withGps = input.photos.filter((p) => p.gps).map((p) => ({ fileId: p.fileId, lat: p.gps!.lat, lon: p.gps!.lon }));
  if (withGps.length >= 3) {
    const outliers = gpsOutliers(withGps, input.settings.gpsOutlierKm);
    for (const id of outliers) {
      const me = withGps.find((x) => x.fileId === id)!;
      const others = withGps.filter((x) => x.fileId !== id);
      const lat = median(others.map((o) => o.lat));
      const lon = median(others.map((o) => o.lon));
      add('PHOTO_GPS_OUTLIER', { km: Math.round(distanceKm(me, { lat, lon }) * 10) / 10 }, { fileIds: [id] });
    }
  }

  // ----- documents
  let newestDoc: string | null = null;
  for (const d of input.documents) {
    const label = d.docType ? DOC_TYPE_PLAIN[d.docType] : 'A document';
    const docName = label.charAt(0).toUpperCase() + label.slice(1);
    if (d.documentDate && (!newestDoc || d.documentDate > newestDoc)) newestDoc = d.documentDate;
    if (accDay && d.documentDate && d.docType && DATED_DOC_TYPES.has(d.docType)) {
      const gap = daysBetween(accDay, d.documentDate);
      if (gap !== null && gap < -1) add('DOC_DATED_BEFORE_ACCIDENT', { doc: d.docType === 'insurer_letter' ? 'The insurer’s letter' : `The ${label}`, date: ukDate(d.documentDate), accident: ukDate(accDay) }, { fileIds: [d.fileId] });
    }
    if (accDay && d.docType === 'v5c' && d.keeperSince && d.keeperSince.slice(0, 10) > accDay) add('KEEPER_AFTER_ACCIDENT', { date: ukDate(d.keeperSince) }, { fileIds: [d.fileId] });
    if (accDay && d.docType === 'insurance_certificate' && (d.validFrom || d.validTo)) {
      const before = d.validFrom && d.validFrom.slice(0, 10) > accDay;
      const after = d.validTo && d.validTo.slice(0, 10) < accDay;
      if (before || after) add('INSURANCE_NOT_IN_FORCE', { from: d.validFrom ? ukDate(d.validFrom) : 'unknown', to: d.validTo ? ukDate(d.validTo) : 'unknown' }, { fileIds: [d.fileId] });
    }
    if (accDay && d.docType === 'driving_licence' && d.validTo && d.validTo.slice(0, 10) < accDay) add('LICENCE_EXPIRED', { date: ukDate(d.validTo) }, { fileIds: [d.fileId] });
    if (accDay && d.docType === 'mot_certificate' && d.validTo && d.validTo.slice(0, 10) < accDay && (input.vehicleAgeYears === undefined || input.vehicleAgeYears === null || input.vehicleAgeYears > 3)) add('MOT_EXPIRED', { date: ukDate(d.validTo) }, { fileIds: [d.fileId] });
    const meta = d.pdfMeta;
    if (meta) {
      const c = isoMs(meta.createdAt);
      const m = isoMs(meta.modifiedAt);
      if (c !== null && m !== null && m - c > 86_400_000) add('PDF_EDITED_AFTER_CREATION', { n: Math.round((m - c) / 86_400_000) }, { fileIds: [d.fileId] });
      const producer = [meta.producer, meta.creator].find((x) => x && PDF_EDITORS.test(x));
      if (producer) add('PDF_EDITOR_PRODUCER', { producer }, { fileIds: [d.fileId] });
      if (meta.incrementalUpdates > 0) add('PDF_INCREMENTAL_UPDATES', { n: meta.incrementalUpdates }, { fileIds: [d.fileId] });
    }
    if (d.extensionMatches === false) add('FILE_TYPE_MISMATCH', { ext: d.ext ?? '?', kind: d.kind ?? 'different type of file' }, { fileIds: [d.fileId] });
    if (d.injection) add('INSTRUCTIONS_IN_DOCUMENT', {}, { fileIds: [d.fileId] });
  }
  if (input.bundleInjection && !out.some((x) => x.code === 'INSTRUCTIONS_IN_DOCUMENT')) add('INSTRUCTIONS_IN_DOCUMENT', {}, { subject: 'bundle' });
  const newest = input.newestUploadAt ?? null;
  if (accMs !== null && newest && accMs > (isoMs(newest) ?? Infinity)) add('ACCIDENT_IN_FUTURE', {}, {});

  // ----- other claims (clash / identity services)
  for (const v of input.otherClaims.vehicle) {
    add('VEHICLE_ON_OTHER_CLAIM', { ref: v.reference, status: v.status ?? (v.open ? 'open' : 'closed') }, { claims: [{ id: v.claimId, reference: v.reference }], severity: v.open ? 'warn' : 'info', subject: `${v.claimId}|${v.how}` });
  }
  if (input.otherClaims.fleetUnit) add('FLEET_VEHICLE_AS_CLIENT', {}, { subject: input.clientVrm ?? '' });
  for (const c of input.otherClaims.contacts) {
    add('CONTACT_ON_OTHER_CLAIM', { field: c.field === 'bank' ? 'bank details' : c.field === 'phone' ? 'phone number' : c.field === 'email' ? 'email address' : 'address', ref: c.reference }, { claims: [{ id: c.claimId, reference: c.reference }], severity: c.open ? 'warn' : 'info', subject: `${c.claimId}|${c.field}` });
  }
  for (const c of input.otherClaims.claimant) {
    const recent = c.open && c.daysApart !== null && Math.abs(c.daysApart) <= 30;
    add('DUPLICATE_CLAIMANT', { ref: c.reference, status: c.status ?? (c.open ? 'open' : 'closed') }, { claims: [{ id: c.claimId, reference: c.reference }], severity: recent ? 'warn' : 'info', subject: `${c.claimId}|${c.how}` });
  }

  for (const s of out) if (BANNED_INTAKE_WORDS.test(`${s.title} ${s.message}`)) throw new Error(`signal ${s.code} failed the wording check`);
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
