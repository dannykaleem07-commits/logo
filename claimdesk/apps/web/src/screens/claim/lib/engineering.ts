/**
 * Engineering helpers (pure): estimate lines, PAV comparables, total-loss inputs and the engineer's report
 * checklist. Totals and assessments come from the API; this file only shapes forms into request bodies.
 */
import {
  engineerReportChecklist,
  type ChecklistResult,
  type Comparable,
  type EngineerReport,
  type Estimate,
  type EstimateLine,
  type EstimateLineKind,
  type FuelType,
  type ISODateTime,
  type PavAssessment,
  type PavSubject,
  type Pence,
  type SalvageCategory,
  type TotalLossPredictionInput,
  type Track,
  type Transmission,
  type Vehicle
} from '@ccguk/domain';
import type { FormResult } from './chronology';

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

export const LINE_KIND_LABEL: Record<EstimateLineKind, string> = {
  labour: 'Labour',
  part: 'Part',
  paint: 'Paint',
  materials: 'Materials',
  adas: 'ADAS',
  diagnostic: 'Diagnostic',
  sundry: 'Sundry',
  specialist: 'Specialist'
};
export const LINE_KIND_OPTIONS = (Object.keys(LINE_KIND_LABEL) as EstimateLineKind[]).map((value) => ({ value, label: LINE_KIND_LABEL[value] }));

export const OPERATIONS = ['Replace', 'Repair', 'Refinish', 'Blend', 'Strip/Refit', 'Calibrate', 'Diagnose', 'Check', 'Other'] as const;
export const OPERATION_OPTIONS = OPERATIONS.map((o) => ({ value: o, label: o }));

export const PART_SOURCE_LABEL: Record<NonNullable<EstimateLine['partSource']>, string> = { oem: 'OEM', aftermarket: 'Aftermarket', green: 'Green (recycled)', unknown: 'Unknown' };
export const PART_SOURCE_OPTIONS = (Object.keys(PART_SOURCE_LABEL) as Array<NonNullable<EstimateLine['partSource']>>).map((value) => ({ value, label: PART_SOURCE_LABEL[value] }));

export const LINE_SOURCE_LABEL: Record<EstimateLine['source'], string> = { manual: 'Manual', import: 'Imported', library: 'Labour library', vision_suggestion: 'Vision suggestion' };

export const PAINT_METHOD_LABEL: Record<Estimate['paintMaterialsMethod'], string> = { per_hour: 'Per paint hour', paint_system: 'Paint-maker system figure', fixed: 'Fixed sum' };
export const PAINT_METHOD_OPTIONS = (Object.keys(PAINT_METHOD_LABEL) as Estimate['paintMaterialsMethod'][]).map((value) => ({ value, label: PAINT_METHOD_LABEL[value] }));

let lineSeq = 0;
/** A fresh manual line; the id is client-side until the API saves it. */
export function newLine(kind: EstimateLineKind = 'labour'): EstimateLine {
  lineSeq += 1;
  return { id: `new-${Date.now().toString(36)}-${lineSeq}`, kind, operation: kind === 'part' ? 'Replace' : kind === 'paint' ? 'Refinish' : 'Repair', description: '', quantity: 1, source: 'manual', confirmedByEngineer: false, preExisting: false };
}

/** Numbers from inputs: '' → undefined, otherwise a finite non-negative number (or undefined). */
export function numOrUndefined(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export interface EstimateBasisForm {
  labourRatePence: Pence | null;
  paintRatePence: Pence | null;
  paintMaterialsMethod: Estimate['paintMaterialsMethod'] | '';
  paintMaterialsPerHourPence: Pence | null;
  vatRatePct: string;
}

export function basisFormFrom(e: Estimate | null | undefined): EstimateBasisForm {
  return {
    labourRatePence: e?.labourRatePence ?? null,
    paintRatePence: e?.paintRatePence ?? null,
    paintMaterialsMethod: e?.paintMaterialsMethod ?? 'per_hour',
    paintMaterialsPerHourPence: e?.paintMaterialsPerHourPence ?? null,
    vatRatePct: e ? String(Math.round(e.vatRate * 10000) / 100) : '20'
  };
}

export function lineErrors(line: EstimateLine): string[] {
  const errs: string[] = [];
  if (!line.description.trim()) errs.push('description');
  if (!(line.quantity > 0)) errs.push('quantity');
  if ((line.kind === 'labour' || line.kind === 'paint') && !(line.hours && line.hours > 0)) errs.push('hours');
  if (line.kind === 'part' && (line.unitPence === undefined || line.unitPence < 0)) errs.push('unit price');
  return errs;
}

export function estimateBodyFrom(existing: Estimate | null | undefined, vehicleId: string, basis: EstimateBasisForm, lines: EstimateLine[]): FormResult<Partial<Estimate>> {
  const errors: Record<string, string> = {};
  if (basis.labourRatePence === null || basis.labourRatePence <= 0) errors.labourRatePence = 'Labour rate per hour';
  if (basis.paintRatePence === null || basis.paintRatePence <= 0) errors.paintRatePence = 'Paint rate per hour';
  if (!basis.paintMaterialsMethod) errors.paintMaterialsMethod = 'How are paint materials costed?';
  if (basis.paintMaterialsMethod === 'per_hour' && (basis.paintMaterialsPerHourPence === null || basis.paintMaterialsPerHourPence < 0)) errors.paintMaterialsPerHourPence = 'Materials per paint hour';
  const vat = Number(basis.vatRatePct);
  if (!Number.isFinite(vat) || vat < 0 || vat > 100) errors.vatRatePct = 'VAT % between 0 and 100';
  lines.forEach((l, i) => {
    const le = lineErrors(l);
    if (le.length) errors[`line.${i}`] = `Line ${i + 1}: ${le.join(', ')}`;
  });
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      ...(existing ? { id: existing.id } : {}),
      vehicleId,
      lines: lines.map((l) => ({ ...l, description: l.description.trim(), id: l.id.startsWith('new-') ? l.id : l.id })),
      labourRatePence: basis.labourRatePence as Pence,
      paintRatePence: basis.paintRatePence as Pence,
      paintMaterialsMethod: basis.paintMaterialsMethod as Estimate['paintMaterialsMethod'],
      paintMaterialsPerHourPence: basis.paintMaterialsPerHourPence ?? undefined,
      vatRate: Math.round(vat * 100) / 10000,
      importedFromEvidenceId: existing?.importedFromEvidenceId,
      importedTotalPence: existing?.importedTotalPence
    }
  };
}

/** Lines whose amounts need the engineer's tick before the estimate can be approved. */
export function unconfirmedLines(lines: EstimateLine[]): number {
  return lines.filter((l) => !l.confirmedByEngineer).length;
}

// ---------------------------------------------------------------------------
// PAV
// ---------------------------------------------------------------------------

export const FUEL_OPTIONS: Array<{ value: FuelType; label: string }> = [
  { value: 'petrol', label: 'Petrol' },
  { value: 'diesel', label: 'Diesel' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'plugin_hybrid', label: 'Plug-in hybrid' },
  { value: 'electric', label: 'Electric' },
  { value: 'lpg', label: 'LPG' },
  { value: 'other', label: 'Other' }
];
export const TRANSMISSION_OPTIONS: Array<{ value: Transmission; label: string }> = [
  { value: 'manual', label: 'Manual' },
  { value: 'automatic', label: 'Automatic' },
  { value: 'unknown', label: 'Unknown' }
];
export const SELLER_OPTIONS: Array<{ value: Comparable['seller']; label: string }> = [
  { value: 'dealer', label: 'Dealer' },
  { value: 'private', label: 'Private' },
  { value: 'unknown', label: 'Unknown' }
];
export const SALVAGE_OPTIONS: Array<{ value: SalvageCategory; label: string }> = [
  { value: 'A', label: 'Cat A — scrap' },
  { value: 'B', label: 'Cat B — break' },
  { value: 'S', label: 'Cat S — structural, repairable' },
  { value: 'N', label: 'Cat N — non-structural, repairable' }
];
export const CONDITION_OPTIONS: Array<{ value: PavSubject['conditionGrade']; label: string }> = [
  { value: 'excellent', label: 'Excellent' },
  { value: 'good', label: 'Good' },
  { value: 'average', label: 'Average' },
  { value: 'poor', label: 'Poor' }
];
export const SERVICE_HISTORY_OPTIONS: Array<{ value: NonNullable<PavSubject['serviceHistory']>; label: string }> = [
  { value: 'full', label: 'Full' },
  { value: 'partial', label: 'Partial' },
  { value: 'none', label: 'None' },
  { value: 'unknown', label: 'Unknown' }
];

export interface ComparableForm {
  url: string;
  capturedAt: ISODateTime | '';
  source: string;
  pricePence: Pence | null;
  priceOnApplication: boolean;
  mileage: string;
  year: string;
  make: string;
  model: string;
  trim: string;
  fuelType: FuelType | '';
  transmission: Transmission | '';
  seller: Comparable['seller'] | '';
  distanceMiles: string;
  writeOffCategory: SalvageCategory | '';
  exFleet: boolean;
  optionsAdjustmentPence: Pence | null;
  evidenceId: string;
}

export function emptyComparableForm(subject: Pick<PavSubject, 'make' | 'model' | 'fuelType' | 'transmission'> | undefined, nowIso: ISODateTime): ComparableForm {
  return {
    url: '',
    capturedAt: nowIso,
    source: '',
    pricePence: null,
    priceOnApplication: false,
    mileage: '',
    year: '',
    make: subject?.make ?? '',
    model: subject?.model ?? '',
    trim: '',
    fuelType: subject?.fuelType ?? '',
    transmission: subject?.transmission ?? '',
    seller: 'dealer',
    distanceMiles: '',
    writeOffCategory: '',
    exFleet: false,
    optionsAdjustmentPence: null,
    evidenceId: ''
  };
}

export function comparableBodyFrom(form: ComparableForm): FormResult<Omit<Comparable, 'id'>> {
  const errors: Record<string, string> = {};
  if (!form.url.trim() || !/^https?:\/\//i.test(form.url.trim())) errors.url = 'The advert URL (captured by hand — adverts are never scraped)';
  if (!form.capturedAt) errors.capturedAt = 'When was the advert captured?';
  if (!form.source.trim()) errors.source = 'Where was it advertised? (Auto Trader, dealer site…)';
  if (!form.priceOnApplication && (form.pricePence === null || form.pricePence <= 0)) errors.pricePence = 'Advertised price in pounds, or tick price on application';
  const mileage = Number(form.mileage);
  if (form.mileage.trim() === '' || !Number.isFinite(mileage) || mileage < 0) errors.mileage = 'Advertised mileage';
  const year = Number(form.year);
  if (!Number.isInteger(year) || year < 1980 || year > 2100) errors.year = 'Year of the advertised vehicle';
  if (!form.make.trim()) errors.make = 'Make';
  if (!form.model.trim()) errors.model = 'Model';
  if (!form.seller) errors.seller = 'Dealer or private?';
  const distance = form.distanceMiles.trim() === '' ? undefined : Number(form.distanceMiles);
  if (distance !== undefined && (!Number.isFinite(distance) || distance < 0)) errors.distanceMiles = 'Miles from the claimant';
  if (!form.evidenceId) errors.evidenceId = 'Attach the saved advert (PDF or screenshot) as evidence first';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      evidenceId: form.evidenceId,
      url: form.url.trim(),
      capturedAt: form.capturedAt,
      source: form.source.trim(),
      pricePence: form.priceOnApplication ? 0 : (form.pricePence as Pence),
      priceOnApplication: form.priceOnApplication || undefined,
      mileage,
      year,
      make: form.make.trim(),
      model: form.model.trim(),
      trim: form.trim.trim() || undefined,
      fuelType: form.fuelType || undefined,
      transmission: form.transmission || undefined,
      seller: form.seller as Comparable['seller'],
      distanceMiles: distance,
      writeOffCategory: form.writeOffCategory || undefined,
      exFleet: form.exFleet || undefined,
      optionsAdjustmentPence: form.optionsAdjustmentPence ?? undefined
    }
  };
}

export interface SubjectForm {
  odometerAtLoss: string;
  odometerBasis: PavSubject['odometerBasis'];
  conditionGrade: PavSubject['conditionGrade'] | '';
  conditionAdjustmentPct: string;
  serviceHistory: NonNullable<PavSubject['serviceHistory']> | '';
  exFleet: boolean;
  previousWriteOffCategory: SalvageCategory | '';
  claimantPostcode: string;
  vatRegisteredClaimant: boolean;
  trim: string;
}

/** Subject defaults from the vehicle: latest odometer reading, else MOT projection flagged as such. */
export function subjectFormFrom(pav: PavAssessment | null | undefined, vehicle: Vehicle, claimantPostcode?: string): SubjectForm {
  if (pav) {
    const s = pav.subject;
    return {
      odometerAtLoss: String(s.odometerAtLoss),
      odometerBasis: s.odometerBasis,
      conditionGrade: s.conditionGrade,
      conditionAdjustmentPct: String(s.conditionAdjustmentPct),
      serviceHistory: s.serviceHistory ?? '',
      exFleet: s.exFleet ?? false,
      previousWriteOffCategory: s.previousWriteOffCategory ?? '',
      claimantPostcode: s.claimantPostcode ?? claimantPostcode ?? '',
      vatRegisteredClaimant: s.vatRegisteredClaimant ?? false,
      trim: s.trim ?? ''
    };
  }
  const latest = [...vehicle.odometer].sort((a, b) => b.date.localeCompare(a.date))[0];
  const lastMot = (vehicle.motHistory ?? []).filter((t) => t.odometerMiles !== undefined).sort((a, b) => b.completedDate.localeCompare(a.completedDate))[0];
  return {
    odometerAtLoss: latest ? String(latest.miles) : lastMot?.odometerMiles !== undefined ? String(lastMot.odometerMiles) : '',
    odometerBasis: latest ? 'reading' : 'projected_from_mot',
    conditionGrade: '',
    conditionAdjustmentPct: '0',
    serviceHistory: '',
    exFleet: false,
    previousWriteOffCategory: vehicle.previousWriteOffCategory ?? '',
    claimantPostcode: claimantPostcode ?? '',
    vatRegisteredClaimant: false,
    trim: vehicle.variant ?? ''
  };
}

export function subjectFrom(form: SubjectForm, vehicle: Vehicle): FormResult<PavSubject> {
  const errors: Record<string, string> = {};
  const odo = Number(form.odometerAtLoss);
  if (form.odometerAtLoss.trim() === '' || !Number.isFinite(odo) || odo < 0) errors.odometerAtLoss = 'Odometer at loss (miles)';
  if (!form.conditionGrade) errors.conditionGrade = "Engineer's condition grade";
  const adj = Number(form.conditionAdjustmentPct);
  if (!Number.isFinite(adj) || adj < -10 || adj > 10) errors.conditionAdjustmentPct = 'Condition adjustment between −10 and +10 %';
  if (!vehicle.yearOfManufacture) errors.year = 'The vehicle record has no year of manufacture — run a lookup first';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      vehicleId: vehicle.id,
      registration: vehicle.registration,
      make: vehicle.make,
      model: vehicle.model,
      trim: form.trim.trim() || undefined,
      year: vehicle.yearOfManufacture as number,
      fuelType: vehicle.fuelType,
      transmission: vehicle.transmission,
      odometerAtLoss: odo,
      odometerBasis: form.odometerBasis,
      conditionGrade: form.conditionGrade as PavSubject['conditionGrade'],
      conditionAdjustmentPct: adj,
      serviceHistory: form.serviceHistory || undefined,
      exFleet: form.exFleet || undefined,
      previousWriteOffCategory: form.previousWriteOffCategory || undefined,
      claimantPostcode: form.claimantPostcode.trim().toUpperCase() || undefined,
      vatRegisteredClaimant: form.vatRegisteredClaimant || undefined
    }
  };
}

export function comparableStats(pav: Pick<PavAssessment, 'comparables'>): { total: number; used: number; excluded: number } {
  const total = pav.comparables.length;
  const excluded = pav.comparables.filter((c) => c.excluded).length;
  return { total, used: total - excluded, excluded };
}

export const PAV_MIN_COMPARABLES = 6;

// ---------------------------------------------------------------------------
// Total loss
// ---------------------------------------------------------------------------

export const DAMAGE_ZONES: Array<{ value: TotalLossPredictionInput['damageZones'][number]; label: string }> = [
  { value: 'front', label: 'Front' },
  { value: 'rear', label: 'Rear' },
  { value: 'nearside', label: 'Nearside' },
  { value: 'offside', label: 'Offside' },
  { value: 'roof', label: 'Roof' },
  { value: 'underside', label: 'Underside' },
  { value: 'multiple', label: 'Multiple zones' }
];
export const STRUCTURAL_INDICATORS: Array<{ value: TotalLossPredictionInput['structuralIndicators'][number]; label: string }> = [
  { value: 'wheel_displaced', label: 'Wheel displaced' },
  { value: 'suspension', label: 'Suspension damage' },
  { value: 'pillar', label: 'Pillar damage' },
  { value: 'chassis_leg', label: 'Chassis leg' },
  { value: 'floor', label: 'Floor' },
  { value: 'roof_rail', label: 'Roof rail' },
  { value: 'none', label: 'None seen' }
];

export interface PredictorForm {
  vehicleAgeYears: string;
  pavBandPence: Pence | null;
  roughRepairPence: Pence | null;
  damageZones: TotalLossPredictionInput['damageZones'];
  airbagsDeployed: boolean | undefined;
  structuralIndicators: TotalLossPredictionInput['structuralIndicators'];
  driveable: boolean | undefined;
  fluidLeaks: boolean | undefined;
  isEvOrHybrid: boolean;
}

export function emptyPredictorForm(vehicle: Vehicle, accident: { airbagsDeployed?: boolean; driveable?: boolean }, year: number): PredictorForm {
  return {
    vehicleAgeYears: vehicle.yearOfManufacture ? String(Math.max(0, year - vehicle.yearOfManufacture)) : '',
    pavBandPence: null,
    roughRepairPence: null,
    damageZones: [],
    airbagsDeployed: accident.airbagsDeployed,
    structuralIndicators: [],
    driveable: accident.driveable,
    fluidLeaks: undefined,
    isEvOrHybrid: vehicle.fuelType === 'electric' || vehicle.fuelType === 'hybrid' || vehicle.fuelType === 'plugin_hybrid'
  };
}

export function predictorBodyFrom(form: PredictorForm): FormResult<TotalLossPredictionInput> {
  const errors: Record<string, string> = {};
  const age = Number(form.vehicleAgeYears);
  if (form.vehicleAgeYears.trim() === '' || !Number.isFinite(age) || age < 0) errors.vehicleAgeYears = 'Vehicle age in years';
  if (form.pavBandPence === null || form.pavBandPence <= 0) errors.pavBandPence = 'Rough pre-accident value in pounds';
  if (form.damageZones.length === 0) errors.damageZones = 'Tick the damaged zones';
  if (form.airbagsDeployed === undefined) errors.airbagsDeployed = 'Did the airbags deploy?';
  if (form.driveable === undefined) errors.driveable = 'Is it driveable?';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      vehicleAgeYears: age,
      pavBandPence: form.pavBandPence as Pence,
      roughRepairPence: form.roughRepairPence ?? undefined,
      damageZones: form.damageZones,
      airbagsDeployed: form.airbagsDeployed as boolean,
      structuralIndicators: form.structuralIndicators.length ? form.structuralIndicators : ['none'],
      driveable: form.driveable as boolean,
      fluidLeaks: form.fluidLeaks,
      isEvOrHybrid: form.isEvOrHybrid
    }
  };
}

export interface TotalLossAssessForm {
  salvagePence: Pence | null;
  salvageSource: 'bid' | 'offer' | 'estimate' | '';
  salvageCategory: SalvageCategory | '';
  repairWorkingDays: string;
}

export function totalLossAssessBodyFrom(form: TotalLossAssessForm): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (form.salvagePence !== null) body.salvagePence = form.salvagePence;
  if (form.salvageSource) body.salvageSource = form.salvageSource;
  if (form.salvageCategory) body.salvageCategory = form.salvageCategory;
  const days = Number(form.repairWorkingDays);
  if (form.repairWorkingDays.trim() !== '' && Number.isFinite(days) && days >= 0) body.projectedRepairWorkingDays = days;
  return body;
}

// ---------------------------------------------------------------------------
// Engineer's report
// ---------------------------------------------------------------------------

export interface ReportForm {
  engineerPartyId: string;
  engineerQualifications: string;
  instructedBy: string;
  instructedAt: ISODateTime | '';
  inspectionAt: ISODateTime | '';
  inspectionPlace: string;
  inspectionBasis: EngineerReport['inspectionBasis'];
  inspectionConditions: string;
  odometerMiles: string;
  preAccidentCondition: string;
  damageDescription: string;
  consistentWithCircumstances: boolean | undefined;
  consistencyNote: string;
  repairMethod: string;
  roadworthy: boolean | undefined;
  roadworthyReason: string;
  repairDurationWorkingDays: string;
  salvageCategory: SalvageCategory | '';
  salvageValuePence: Pence | null;
  adasNotes: string;
  evNotes: string;
  diagnosticFaultCodes: string;
  photoEvidenceIds: string[];
  forCourt: boolean;
  feePence: Pence | null;
}

export const DEFAULT_ENGINEER_FEE_PENCE: Pence = 28_500;

export function reportFormFrom(r: EngineerReport | null | undefined): ReportForm {
  return {
    engineerPartyId: r?.engineerPartyId ?? '',
    engineerQualifications: r?.engineerQualifications ?? '',
    instructedBy: r?.instructedBy ?? 'Courtesy Cars Group UK Ltd',
    instructedAt: r?.instructedAt ?? '',
    inspectionAt: r?.inspectionAt ?? '',
    inspectionPlace: r?.inspectionPlace ?? '',
    inspectionBasis: r?.inspectionBasis ?? 'physical',
    inspectionConditions: r?.inspectionConditions ?? '',
    odometerMiles: r?.odometerMiles !== undefined ? String(r.odometerMiles) : '',
    preAccidentCondition: r?.preAccidentCondition ?? '',
    damageDescription: r?.damageDescription ?? '',
    consistentWithCircumstances: r?.consistentWithCircumstances,
    consistencyNote: r?.consistencyNote ?? '',
    repairMethod: r?.repairMethod ?? '',
    roadworthy: r?.roadworthy,
    roadworthyReason: r?.roadworthyReason ?? '',
    repairDurationWorkingDays: r?.repairDurationWorkingDays !== undefined ? String(r.repairDurationWorkingDays) : '',
    salvageCategory: r?.salvageCategory ?? '',
    salvageValuePence: r?.salvageValuePence ?? null,
    adasNotes: r?.adasNotes ?? '',
    evNotes: r?.evNotes ?? '',
    diagnosticFaultCodes: (r?.diagnosticFaultCodes ?? []).join(', '),
    photoEvidenceIds: r?.photoEvidenceIds ?? [],
    forCourt: r?.forCourt ?? false,
    feePence: r?.feePence ?? DEFAULT_ENGINEER_FEE_PENCE
  };
}

export function reportBodyFrom(form: ReportForm, ctx: { vehicleId: string; estimateId?: string; pavAssessmentId?: string }): FormResult<Partial<EngineerReport>> {
  const errors: Record<string, string> = {};
  if (!form.engineerPartyId) errors.engineerPartyId = 'Which engineer? (a party with the engineer role)';
  if (!form.engineerQualifications.trim()) errors.engineerQualifications = 'Qualifications (IAEA / IMI)';
  if (!form.instructedBy.trim()) errors.instructedBy = 'Instructing party';
  if (!form.instructedAt) errors.instructedAt = 'Date of instruction';
  if (form.inspectionBasis === 'physical' && form.inspectionAt && !form.inspectionPlace.trim()) errors.inspectionPlace = 'Where was the vehicle inspected?';
  if (!form.preAccidentCondition.trim()) errors.preAccidentCondition = 'Pre-accident condition';
  if (!form.damageDescription.trim()) errors.damageDescription = 'Damage description';
  if (form.consistentWithCircumstances === undefined) errors.consistentWithCircumstances = 'Is the damage consistent with the circumstances?';
  if (form.consistentWithCircumstances === false && !form.consistencyNote.trim()) errors.consistencyNote = 'Explain the inconsistency';
  if (form.roadworthy === undefined) errors.roadworthy = 'Roadworthy or not?';
  if (!form.roadworthyReason.trim()) errors.roadworthyReason = 'Why (this is what the period argument rests on)';
  const odo = form.odometerMiles.trim() === '' ? undefined : Number(form.odometerMiles);
  if (odo !== undefined && (!Number.isInteger(odo) || odo < 0)) errors.odometerMiles = 'Whole miles';
  const days = form.repairDurationWorkingDays.trim() === '' ? undefined : Number(form.repairDurationWorkingDays);
  if (days !== undefined && (!Number.isFinite(days) || days < 0)) errors.repairDurationWorkingDays = 'Working days';
  if (form.feePence === null || form.feePence < 0) errors.feePence = 'Fee in pounds (fee note answers "fee not recoverable")';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      vehicleId: ctx.vehicleId,
      engineerPartyId: form.engineerPartyId,
      engineerQualifications: form.engineerQualifications.trim(),
      instructedBy: form.instructedBy.trim(),
      instructedAt: form.instructedAt,
      inspectionAt: form.inspectionAt || undefined,
      inspectionPlace: form.inspectionPlace.trim() || undefined,
      inspectionBasis: form.inspectionBasis,
      inspectionConditions: form.inspectionConditions.trim() || undefined,
      odometerMiles: odo,
      preAccidentCondition: form.preAccidentCondition.trim(),
      damageDescription: form.damageDescription.trim(),
      consistentWithCircumstances: form.consistentWithCircumstances as boolean,
      consistencyNote: form.consistencyNote.trim() || undefined,
      repairMethod: form.repairMethod.trim() || undefined,
      estimateId: ctx.estimateId,
      roadworthy: form.roadworthy as boolean,
      roadworthyReason: form.roadworthyReason.trim(),
      repairDurationWorkingDays: days,
      pavAssessmentId: ctx.pavAssessmentId,
      salvageCategory: form.salvageCategory || undefined,
      salvageValuePence: form.salvageValuePence ?? undefined,
      adasNotes: form.adasNotes.trim() || undefined,
      evNotes: form.evNotes.trim() || undefined,
      diagnosticFaultCodes: form.diagnosticFaultCodes
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      photoEvidenceIds: form.photoEvidenceIds,
      forCourt: form.forCourt,
      feePence: form.feePence as Pence
    }
  };
}

/** API-supplied checklist when the route returns one; else the domain's pure checklist over the saved report. */
export function reportChecklist(report: EngineerReport | null | undefined, apiChecklist: unknown, opts: { track?: Track; isEvOrHybrid?: boolean; vehicle?: Vehicle }): ChecklistResult | undefined {
  if (apiChecklist && typeof apiChecklist === 'object' && Array.isArray((apiChecklist as ChecklistResult).missing)) return apiChecklist as ChecklistResult;
  if (!report) return undefined;
  try {
    return engineerReportChecklist(report, {
      track: opts.track,
      isEvOrHybrid: opts.isEvOrHybrid,
      vehicle: opts.vehicle ? { registration: opts.vehicle.registration, vin: opts.vehicle.vin, motExpiryDate: opts.vehicle.motExpiryDate, motStatus: opts.vehicle.motStatus } : undefined
    });
  } catch {
    return undefined;
  }
}

/** GET /claims/:id/engineer-report may return the report bare or wrapped `{ report, checklist }`. */
export function unwrapReport(res: unknown): { report: EngineerReport | null; checklist?: unknown } {
  if (!res || typeof res !== 'object') return { report: null };
  const r = res as Record<string, unknown>;
  if ('report' in r) return { report: (r.report as EngineerReport | null) ?? null, checklist: r.checklist };
  if ('id' in r && 'engineerPartyId' in r) return { report: res as EngineerReport };
  return { report: null };
}
