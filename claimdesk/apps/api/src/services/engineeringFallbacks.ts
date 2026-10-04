/**
 * Engineering engines for the API — typed adapters over `@ccguk/domain` (totalloss, estimate) plus the estimate
 * text-extraction provider interface. The file keeps its historical name so the route imports are stable.
 *
 *   assessTotalLoss(TotalLossInputs)        → domain assessTotalLoss(TotalLossInput)   (BLUEPRINT §4.7–4.8)
 *   predictTotalLoss(input)                 → domain predictTotalLoss                   (rules-first, calibrated:false)
 *   engineerReportChecklist(report, bundle) → domain engineerReportChecklist(report, opts) + the API's item list for the UI
 */
import {
  assessTotalLoss as domainAssessTotalLoss,
  engineerReportChecklist as domainEngineerReportChecklist,
  parseEstimateText,
  predictTotalLoss as domainPredictTotalLoss,
  type ClaimBundle,
  type EngineerReport,
  type Estimate,
  type EstimateLine,
  type Pence,
  type TotalLossAssessment,
  type TotalLossAssessmentResult,
  type TotalLossPredictionInput,
  type TotalLossPredictionResult,
} from '@ccguk/domain';

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
  /** Days expected from the total-loss decision to the PAV payment (hire runs 5 WD after payment: GTA 4.14 benchmark). */
  daysToPavPayment: number;
  handoverDays?: number;
  borderlinePct?: number;
}

/** Repair route (repair + projected hire + storage) against the total-loss route (PAV − salvage + hire to payment). */
export function assessTotalLoss(i: TotalLossInputs): TotalLossAssessmentResult {
  return domainAssessTotalLoss({
    repairNetPence: i.repairNetPence,
    repairWorkingDays: i.projectedRepairWorkingDays,
    hireDailyRatePence: i.hireDailyRatePence,
    storageDailyRatePence: i.storageOpen ? i.storageDailyRatePence : 0,
    daysToTlPaymentEstimate: i.daysToPavPayment,
    pavPence: i.pavPence,
    salvage: { pence: i.salvagePence, source: i.salvageSource, ...(i.salvageCategory ? { category: i.salvageCategory } : {}) },
    ...(i.handoverDays !== undefined ? { handoverDays: i.handoverDays } : {}),
    ...(i.borderlinePct !== undefined ? { borderlinePct: i.borderlinePct } : {}),
  });
}

export function predictTotalLoss(input: TotalLossPredictionInput): TotalLossPredictionResult {
  return domainPredictTotalLoss(input);
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
  /** The domain checklist's verdict. */
  complete: boolean;
  missing: string[];
  /** Advisory notes (desktop basis, fee cap, calibration of language). */
  notes: string[];
  courtItemsChecked: string[];
  /** Display items for the UI (the API's own view of the same report). */
  items: ChecklistItem[];
}

export function engineerReportChecklist(report: EngineerReport, bundle: ClaimBundle, estimate?: Estimate): ReportChecklist {
  const fuel = bundle.vehicle.fuelType;
  const ev = fuel === 'electric' || fuel === 'hybrid' || fuel === 'plugin_hybrid';
  const v = bundle.vehicle;
  const domainResult = domainEngineerReportChecklist(report, {
    ...(bundle.claim.track ? { track: bundle.claim.track } : {}),
    isEvOrHybrid: ev,
    vehicle: { registration: v.registration, ...(v.vin ? { vin: v.vin } : {}), ...(v.motExpiryDate ? { motExpiryDate: v.motExpiryDate } : {}), ...(v.motStatus ? { motStatus: v.motStatus } : {}) },
  });
  const isTl = report.totalLoss?.decision === 'total_loss' || report.salvageCategory !== undefined || bundle.events.some((e) => e.type === 'total_loss_confirmed');
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
    { code: 'cpr35', label: 'CPR 35 / PD 35 declarations (for court)', ok: true, required: false, note: report.forCourt ? `forCourt: ${domainResult.courtItemsChecked.length} CPR 35 / PD 35 items checked` : 'Not prepared for court' },
  ];
  return { complete: domainResult.ok, missing: [...domainResult.missing], notes: [...domainResult.notes], courtItemsChecked: [...domainResult.courtItemsChecked], items };
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
    const lines = parseEstimateText(input.text, { idPrefix: 'import' });
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
