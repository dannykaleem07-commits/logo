/**
 * Vehicle tab helpers (pure): MOT rows, odometer readings, the mileage-conflict response shape and lookups.
 * Mileage conflicts are computed by the API (@ccguk/domain vehicle.mileageConflicts); the web only displays them.
 */
import type { ISODate, LookupRecord, MotTest, OdometerReading, OdometerSource, Vehicle } from '@ccguk/domain';
import type { FormResult } from './chronology';
import { segmentLabel, type FeatureVocabulary } from '../../../api/vehiclesApi';
import { featureLabels } from '../../vehicles/vehiclePicker';

export const ODOMETER_SOURCE_LABEL: Record<OdometerSource, string> = {
  mot: 'MOT test',
  accident_report: 'Accident report',
  handover: 'Handover',
  collection: 'Collection',
  engineer: "Engineer's report",
  photo: 'Photo',
  v5c: 'V5C',
  client: 'Client stated',
  manual: 'Keyed manually'
};
export const ODOMETER_SOURCE_OPTIONS = (Object.keys(ODOMETER_SOURCE_LABEL) as OdometerSource[]).map((value) => ({ value, label: ODOMETER_SOURCE_LABEL[value] }));

export const LOOKUP_PROVIDER_LABEL: Record<LookupRecord['provider'], string> = {
  dvla_ves: 'DVLA Vehicle Enquiry Service',
  dvsa_mot: 'DVSA MOT history',
  companies_house: 'Companies House',
  gateway: 'Commercial gateway',
  manual: 'Manual entry',
  totalcarcheck_manual: 'Total Car Check (copied by hand)',
  catalogue: 'Vehicle catalogue (ClaimDesk)'
};

export function motRows(vehicle: Pick<Vehicle, 'motHistory'>): MotTest[] {
  return [...(vehicle.motHistory ?? [])].sort((a, b) => b.completedDate.localeCompare(a.completedDate));
}

export function motDefectCounts(test: MotTest): { dangerous: number; major: number; minor: number; advisory: number } {
  const out = { dangerous: 0, major: 0, minor: 0, advisory: 0 };
  for (const d of test.defects) {
    const t = d.type.toUpperCase();
    if (d.dangerous || t === 'DANGEROUS') out.dangerous += 1;
    else if (t === 'MAJOR' || t === 'FAIL') out.major += 1;
    else if (t === 'MINOR') out.minor += 1;
    else if (t === 'ADVISORY') out.advisory += 1;
  }
  return out;
}

export function sortReadings(readings: OdometerReading[]): OdometerReading[] {
  return [...readings].sort((a, b) => a.date.localeCompare(b.date) || a.miles - b.miles);
}

export interface MileageConflictView {
  code: string;
  message: string;
  a?: OdometerReading;
  b?: OdometerReading;
}

/** GET /vehicles/:id/mileage-conflicts returns `{ conflicts: [...] }` (API) or a bare array; both are accepted. */
export function conflictsFrom(res: unknown): MileageConflictView[] {
  const list = Array.isArray(res) ? res : res && typeof res === 'object' && Array.isArray((res as { conflicts?: unknown }).conflicts) ? (res as { conflicts: unknown[] }).conflicts : [];
  return list
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
    .map((c) => ({
      code: typeof c.code === 'string' ? c.code : 'CONFLICT',
      message: typeof c.message === 'string' ? c.message : 'Mileage readings disagree',
      a: c.a as OdometerReading | undefined,
      b: c.b as OdometerReading | undefined
    }));
}

export const CONFLICT_CODE_LABEL: Record<string, string> = {
  NON_MONOTONIC: 'Later reading is lower than an earlier one',
  VARIANCE: 'Readings close in time differ beyond tolerance',
  UNIT_SUSPECT: 'A reading may be in kilometres'
};

export function conflictLabel(code: string): string {
  return CONFLICT_CODE_LABEL[code] ?? code.replace(/_/g, ' ');
}

export interface OdometerForm {
  source: OdometerSource | '';
  date: ISODate | '';
  miles: string;
  evidenceId: string;
  note: string;
}

export function emptyOdometerForm(today: ISODate): OdometerForm {
  return { source: '', date: today, miles: '', evidenceId: '', note: '' };
}

export function odometerBodyFrom(form: OdometerForm, today: ISODate): FormResult<OdometerReading> {
  const errors: Record<string, string> = {};
  if (!form.source) errors.source = 'Where does the reading come from?';
  if (!form.date) errors.date = 'Date of the reading';
  else if (form.date > today) errors.date = 'Cannot be in the future';
  const miles = Number(form.miles);
  if (form.miles.trim() === '' || !Number.isInteger(miles) || miles < 0) errors.miles = 'Whole miles';
  if ((form.source === 'photo' || form.source === 'handover' || form.source === 'collection') && !form.evidenceId) errors.evidenceId = 'Attach the photo that shows the reading';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, body: { source: form.source as OdometerSource, date: form.date, miles, evidenceId: form.evidenceId || undefined, note: form.note.trim() || undefined } };
}

/** Lookups newest first; manual entries are unverified until a document backs them. */
export function sortLookups(lookups: LookupRecord[]): LookupRecord[] {
  return [...lookups].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

/**
 * Identification card rows. The specification (§D.10: doors, seats, power, segment, features, extras) is catalogue /
 * hand-entered reference data — unverified like any manual entry. `vocabulary` turns feature ids into labels.
 */
export function identificationRows(v: Vehicle, vocabulary?: FeatureVocabulary): Array<{ label: string; value: string | number | undefined }> {
  const spec = v.spec;
  const list = (ids: string[] | undefined) => (ids && ids.length ? featureLabels(vocabulary, ids).join(', ') : undefined);
  return [
    { label: 'Registration', value: v.registration },
    { label: 'VIN', value: v.vin },
    { label: 'Make / model', value: `${v.make} ${v.model}`.trim() },
    { label: 'Variant', value: v.variant },
    { label: 'Body', value: v.bodyType },
    { label: 'Doors', value: spec?.doors },
    { label: 'Seats', value: spec?.seats },
    { label: 'Power', value: spec?.powerPs ? `${spec.powerPs} PS` : undefined },
    { label: 'Segment', value: segmentLabel(spec?.segment) },
    { label: 'Year / first registered', value: [v.yearOfManufacture, v.monthOfFirstRegistration].filter(Boolean).join(' · ') || undefined },
    { label: 'Fuel / transmission', value: [v.fuelType, v.transmission].filter(Boolean).join(' · ') || undefined },
    { label: 'Colour', value: v.colour },
    { label: 'Engine', value: v.engineCapacityCc ? `${v.engineCapacityCc} cc` : undefined },
    { label: 'CO₂', value: v.co2Gkm !== undefined ? `${v.co2Gkm} g/km` : undefined },
    { label: 'Euro status', value: v.euroStatus },
    { label: 'Tax', value: [v.taxStatus, v.taxDueDate ? `due ${v.taxDueDate}` : ''].filter(Boolean).join(' · ') || undefined },
    { label: 'MOT', value: [v.motStatus, v.motExpiryDate ? `expires ${v.motExpiryDate}` : ''].filter(Boolean).join(' · ') || undefined },
    { label: 'Last V5C issued', value: v.dateOfLastV5CIssued },
    { label: 'GTA group', value: v.gtaGroup },
    { label: 'Previous write-off', value: v.previousWriteOffCategory ? `Cat ${v.previousWriteOffCategory}` : undefined },
    { label: 'Ownership', value: v.ownership },
    { label: 'Marked for export', value: v.markedForExport === undefined ? undefined : v.markedForExport ? 'Yes' : 'No' },
    { label: 'Features', value: list(spec?.features) },
    { label: 'Extras', value: list(spec?.extras) }
  ];
}
