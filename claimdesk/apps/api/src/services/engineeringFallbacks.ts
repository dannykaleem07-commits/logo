/**
 * Engineering engines the API needs that `@ccguk/domain` may not export yet (totalloss is being built by the domain
 * agents). Each is resolved from the domain module by name at call time and falls back to the conservative
 * implementation here. Also: the engineer-report checklist and the estimate text-extraction provider interface.
 */
import * as domain from '@ccguk/domain';
import type { ClaimBundle, EngineerReport, Estimate, EstimateLine, Pence, TotalLossAssessment, TotalLossPrediction, TotalLossPredictionInput } from '@ccguk/domain';

const registry = domain as unknown as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function optional<T extends (...args: any[]) => unknown>(name: string): T | undefined {
  const fn = registry[name];
  return typeof fn === 'function' ? (fn as T) : undefined;
}

// ---------------------------------------------------------------------------
// Total loss (BLUEPRINT §4.7–4.8)
// ---------------------------------------------------------------------------

export interface TotalLossInputs {
  repairNetPence: Pence;
  projectedRepairWorkingDays: number;
  hireDailyRatePence: Pence;
  storageDailyRatePence: Pence;
  storageOpen: boolean;
  pavPence: Pence;
  salvagePence: Pence;
  salvageSource: TotalLossAssessment['salvageSource'];
  salvageCategory?: TotalLossAssessment['salvageCategory'];
  /** Working days expected from the total-loss decision to the PAV payment (hire runs 5 WD after payment: GTA 4.14 benchmark). */
  daysToPavPayment: number;
}

const calendarFromWorking = (wd: number): number => Math.ceil(wd * 1.4);

export function assessTotalLossFallback(i: TotalLossInputs): TotalLossAssessment {
  const notes: string[] = [];
  const projectedHireDays = calendarFromWorking(i.projectedRepairWorkingDays) + 1;
  const projectedHirePence = projectedHireDays * i.hireDailyRatePence;
  const projectedStoragePence = i.storageOpen ? calendarFromWorking(i.projectedRepairWorkingDays) * i.storageDailyRatePence : 0;
  const repairRouteCostPence = i.repairNetPence + projectedHirePence + projectedStoragePence;
  const tlHireDays = calendarFromWorking(i.daysToPavPayment + 5);
  const tlHirePence = tlHireDays * i.hireDailyRatePence;
  const tlStoragePence = i.storageOpen ? 7 * i.storageDailyRatePence : 0;
  const totalLossRouteCostPence = Math.max(0, i.pavPence - i.salvagePence) + tlHirePence + tlStoragePence;
  const marginPence = totalLossRouteCostPence - repairRouteCostPence;
  let decision: TotalLossAssessment['decision'];
  if (repairRouteCostPence < totalLossRouteCostPence * 0.9) decision = 'repair';
  else if (repairRouteCostPence > totalLossRouteCostPence * 1.1) decision = 'total_loss';
  else decision = 'borderline';
  notes.push(`Repair route: repair ${fmt(i.repairNetPence)} + projected hire ${projectedHireDays} days × ${fmt(i.hireDailyRatePence)} = ${fmt(projectedHirePence)}${projectedStoragePence ? ` + storage ${fmt(projectedStoragePence)}` : ''} = ${fmt(repairRouteCostPence)}.`);
  notes.push(`Total-loss route: PAV ${fmt(i.pavPence)} − salvage ${fmt(i.salvagePence)} (${i.salvageSource}${i.salvageCategory ? `, Cat ${i.salvageCategory}` : ''}) + hire to payment + 5 working days (${tlHireDays} days) ${fmt(tlHirePence)}${tlStoragePence ? ` + storage ${fmt(tlStoragePence)}` : ''} = ${fmt(totalLossRouteCostPence)}.`);
  notes.push('Salvage is the actual bid/offer or an engineer estimate — never a fixed percentage. GTA timescales are an industry benchmark (CCGUK is not a subscriber). Within ±10% the decision is borderline and needs the engineer\'s judgement.');
  return {
    repairNetPence: i.repairNetPence,
    projectedRepairWorkingDays: i.projectedRepairWorkingDays,
    projectedHireDays,
    hireDailyRatePence: i.hireDailyRatePence,
    projectedHirePence,
    projectedStoragePence,
    pavPence: i.pavPence,
    salvagePence: i.salvagePence,
    salvageSource: i.salvageSource,
    salvageCategory: i.salvageCategory,
    repairRouteCostPence,
    totalLossRouteCostPence,
    decision,
    marginPence,
    notes,
  };
}

function fmt(p: Pence): string {
  return domain.formatGBP(p);
}

export function assessTotalLoss(i: TotalLossInputs): TotalLossAssessment {
  const engine = optional<(input: TotalLossInputs) => TotalLossAssessment>('assessTotalLoss');
  if (engine) {
    try {
      const out = engine(i);
      if (out && typeof out === 'object' && 'decision' in out) return out;
    } catch {
      /* fall back */
    }
  }
  return assessTotalLossFallback(i);
}

export function predictTotalLossFallback(input: TotalLossPredictionInput): TotalLossPrediction {
  const factors: TotalLossPrediction['factors'] = [];
  let score = -1.6;
  const add = (factor: string, weight: number, note: string) => {
    score += weight;
    factors.push({ factor, weight, note });
  };
  add('vehicle_age', Math.min(1.6, input.vehicleAgeYears * 0.09), `${input.vehicleAgeYears} years old: older vehicles have a lower PAV relative to repair cost`);
  if (input.airbagsDeployed) add('airbags_deployed', 1.1, 'Airbag deployment adds restraint-system parts and often structural work');
  if (!input.driveable) add('not_driveable', 0.8, 'Not driveable suggests running-gear or structural damage');
  const structural = input.structuralIndicators.filter((s) => s !== 'none');
  if (structural.length) add('structural_indicators', 0.6 * structural.length, `Structural indicators: ${structural.join(', ')}`);
  if (input.damageZones.includes('multiple') || input.damageZones.length > 2) add('multiple_zones', 0.5, 'Damage across several zones');
  if (input.damageZones.includes('roof') || input.damageZones.includes('underside')) add('roof_or_underside', 0.5, 'Roof/underside damage is rarely economic');
  if (input.fluidLeaks) add('fluid_leaks', 0.4, 'Fluid leaks indicate cooling pack / drivetrain damage');
  if (input.isEvOrHybrid) add('ev_or_hybrid', 0.35, 'High-voltage battery inspection and isolation add cost and lead time');
  if (input.roughRepairPence !== undefined && input.pavBandPence > 0) {
    const ratio = input.roughRepairPence / input.pavBandPence;
    add('repair_to_pav_ratio', Math.max(-1.5, Math.min(3, (ratio - 0.55) * 4)), `Rough repair ${fmt(input.roughRepairPence)} is ${(ratio * 100).toFixed(0)}% of the PAV band ${fmt(input.pavBandPence)}`);
  } else if (input.pavBandPence < 300_000) {
    add('low_pav_band', 0.7, `Low PAV band (${fmt(input.pavBandPence)}) leaves little headroom for repair`);
  }
  const probability = 1 / (1 + Math.exp(-score));
  const band: TotalLossPrediction['band'] = probability < 0.35 ? 'low' : probability < 0.65 ? 'medium' : 'high';
  return { probability: Math.round(probability * 1000) / 1000, band, factors, calibrated: false };
}

export function predictTotalLoss(input: TotalLossPredictionInput): TotalLossPrediction {
  const engine = optional<(i: TotalLossPredictionInput) => TotalLossPrediction>('predictTotalLoss');
  if (engine) {
    try {
      const out = engine(input);
      if (out && typeof out.probability === 'number') return out;
    } catch {
      /* fall back */
    }
  }
  return predictTotalLossFallback(input);
}

// ---------------------------------------------------------------------------
// Engineer's report checklist (BLUEPRINT §4.6)
// ---------------------------------------------------------------------------

export interface ChecklistItem {
  code: string;
  label: string;
  ok: boolean;
  required: boolean;
  note?: string;
}

export interface ReportChecklist {
  complete: boolean;
  missing: string[];
  items: ChecklistItem[];
}

export function engineerReportChecklist(report: EngineerReport, bundle: ClaimBundle, estimate?: Estimate): ReportChecklist {
  const isTl = report.totalLoss?.decision === 'total_loss' || report.salvageCategory !== undefined || bundle.events.some((e) => e.type === 'total_loss_confirmed');
  const ev = bundle.vehicle.fuelType === 'electric' || bundle.vehicle.fuelType === 'hybrid' || bundle.vehicle.fuelType === 'plugin_hybrid';
  const photos = bundle.evidence.filter((e) => report.photoEvidenceIds.includes(e.id) && e.kind === 'photo');
  const items: ChecklistItem[] = [
    { code: 'engineer', label: 'Engineer and qualifications stated', ok: Boolean(report.engineerPartyId && report.engineerQualifications.trim()), required: true },
    { code: 'instruction', label: 'Instruction (by whom, when) recorded', ok: Boolean(report.instructedBy.trim() && report.instructedAt), required: true },
    { code: 'inspection', label: report.inspectionBasis === 'desktop' ? 'Desktop basis stated with the material relied on' : 'Physical inspection date and place recorded', ok: report.inspectionBasis === 'desktop' ? Boolean(report.inspectionConditions?.trim()) : Boolean(report.inspectionAt && report.inspectionPlace?.trim()), required: true },
    { code: 'odometer', label: 'Odometer reading recorded', ok: typeof report.odometerMiles === 'number', required: true },
    { code: 'pre_accident_condition', label: 'Pre-accident condition described', ok: report.preAccidentCondition.trim().length > 10, required: true },
    { code: 'damage', label: 'Damage described', ok: report.damageDescription.trim().length > 10, required: true },
    { code: 'consistency', label: 'Consistency with the stated circumstances addressed', ok: report.consistentWithCircumstances || Boolean(report.consistencyNote?.trim()), required: true, note: report.consistentWithCircumstances ? undefined : 'Inconsistent damage must be explained in consistencyNote' },
    { code: 'roadworthy', label: 'Roadworthiness stated with reason', ok: report.roadworthyReason.trim().length > 3, required: true },
    { code: 'repair_or_tl', label: isTl ? 'Total-loss assessment attached' : 'Repair method or linked estimate', ok: isTl ? Boolean(report.totalLoss) : Boolean(report.repairMethod?.trim() || report.estimateId || estimate), required: true },
    { code: 'duration', label: 'Repair duration (working days)', ok: isTl || typeof report.repairDurationWorkingDays === 'number', required: !isTl },
    { code: 'pav', label: 'PAV assessment linked', ok: !isTl || Boolean(report.pavAssessmentId || bundle.pav), required: isTl },
    { code: 'salvage', label: 'Salvage category (ABI code) and value', ok: !isTl || (Boolean(report.salvageCategory) && typeof report.salvageValuePence === 'number'), required: isTl },
    { code: 'photos', label: 'At least four photographs referenced', ok: photos.length >= 4, required: true, note: `${photos.length} photo(s) referenced` },
    { code: 'ev_notes', label: 'EV / hybrid high-voltage notes', ok: !ev || Boolean(report.evNotes?.trim()), required: ev },
    { code: 'fee', label: 'Fee recorded', ok: report.feePence > 0, required: true },
    { code: 'cpr35', label: 'CPR 35 / PD 35 declarations (for court)', ok: true, required: false, note: report.forCourt ? 'forCourt: the template adds the expert declaration and statement of truth' : 'Not prepared for court' },
  ];
  const missing = items.filter((i) => i.required && !i.ok).map((i) => i.code);
  return { complete: missing.length === 0, missing, items };
}

// ---------------------------------------------------------------------------
// Estimate text extraction provider
// ---------------------------------------------------------------------------

export interface ExtractLinesInput {
  text?: string;
  /** PDF bytes. Text extraction from PDF runs in the browser (pdf.js) or through an optional LLM/vision provider. */
  pdf?: Buffer;
  mime?: string;
}

export interface ExtractLinesResult {
  text: string;
  lines: EstimateLine[];
  provider: string;
  note?: string;
}

export interface ExtractLinesProvider {
  readonly name: string;
  extract(input: ExtractLinesInput): Promise<ExtractLinesResult>;
}

/** Default provider: text in → parseEstimateText. PDF bytes are refused with an explanation (no pdf-to-text dependency here). */
export const textOnlyProvider: ExtractLinesProvider = {
  name: 'text-only',
  async extract(input) {
    if (!input.text?.trim()) {
      return { text: '', lines: [], provider: 'text-only', note: 'No text supplied. Convert the PDF to text in the browser (pdf.js) or configure an extraction provider, then import the text.' };
    }
    const lines = domain.parseEstimateText(input.text, { idPrefix: 'import' });
    return { text: input.text, lines, provider: 'text-only' };
  },
};

let activeProvider: ExtractLinesProvider = textOnlyProvider;
export function setExtractLinesProvider(p: ExtractLinesProvider): void {
  activeProvider = p;
}
export function extractLinesProvider(): ExtractLinesProvider {
  return activeProvider;
}
