/**
 * Engineer's report completeness (BLUEPRINT §4.6). Every content item in §4.6 is checked; when the
 * report is for court the CPR 35 / PD 35 items are added (substance of instructions, duty to the
 * court, statement of truth, expert's declaration) with the small-claims notes: CPR 27.2
 * disapplies most of Part 35, permission is needed under CPR 27.5, and PD 27A para 7.3(2) caps
 * recoverable expert fees at £750 per expert.
 *
 * Citations carry a Verification ('unverified' until a human records the source); the checklist
 * never asserts them as settled law.
 */
import type { EngineerReport, Pence, Track, Verification } from '../types.js';
import { formatGBP } from '../money.js';

export const SMALL_CLAIMS_EXPERT_FEE_CAP_PENCE: Pence = 75_000;

export const CPR35_VERIFICATION: Verification = {
  status: 'unverified',
  sourceNote: 'CPR Part 35 and PD 35 content items as summarised in BLUEPRINT §4.6; confirm paragraph references against justice.gov.uk before citing in a letter.',
};

export const PD27A_FEE_CAP_VERIFICATION: Verification = {
  status: 'unverified',
  sourceNote: 'PD 27A para 7.3(2): "for experts\' fees, a sum not exceeding £750 for each expert" (quoted in BLUEPRINT §4.6); confirm against justice.gov.uk.',
};

export interface CourtDeclarations {
  /** Substance of all material instructions, written and oral (CPR 35.10(3)). */
  substanceOfInstructions?: boolean;
  /** Statement that the expert understands and has complied with their duty to the court (CPR 35.3, 35.10(2)). */
  dutyToCourt?: boolean;
  /** Statement of truth in the PD 35 form. */
  statementOfTruth?: boolean;
  /** The declaration in the Guidance for the Instruction of Experts in Civil Claims (PD 35 para 3.2(9)). */
  expertDeclaration?: boolean;
}

export interface ChecklistOptions {
  track?: Track;
  /** Set when the vehicle is an EV or hybrid: EV notes become mandatory. */
  isEvOrHybrid?: boolean;
  courtDeclarations?: CourtDeclarations;
  /** Vehicle identification carried on the vehicle record rather than the report. */
  vehicle?: { registration?: string; vin?: string; motExpiryDate?: string; motStatus?: string };
}

export interface ChecklistResult {
  ok: boolean;
  /** Content items that are absent. Empty when the report is complete. */
  missing: string[];
  /** Advisory notes that do not block (desktop basis, fee cap, calibration of language). */
  notes: string[];
  /** The CPR 35 / PD 35 items checked (only when forCourt). */
  courtItemsChecked: string[];
}

const present = (s: string | undefined): boolean => typeof s === 'string' && s.trim().length > 0;

export function engineerReportChecklist(report: EngineerReport, opts: ChecklistOptions = {}): ChecklistResult {
  const missing: string[] = [];
  const notes: string[] = [];
  const courtItemsChecked: string[] = [];

  // Instructions and engineer identity
  if (!present(report.instructedBy)) missing.push('Instructing party (instructedBy)');
  if (!present(report.instructedAt)) missing.push('Date of instruction (instructedAt)');
  if (!present(report.engineerPartyId)) missing.push("Engineer's identity (engineerPartyId)");
  if (!present(report.engineerQualifications)) missing.push("Engineer's qualifications (IAEA/IMI)");

  // Inspection
  if (!present(report.inspectionAt)) missing.push('Date of inspection (inspectionAt)');
  if (report.inspectionBasis === 'physical') {
    if (!present(report.inspectionPlace)) missing.push('Place of inspection (inspectionPlace)');
  } else {
    notes.push('Desktop inspection: weaker evidence on damage assessment. State why a physical inspection was not carried out and what the opinion rests on (photographs, estimate, scan).');
  }
  if (!present(report.inspectionConditions)) missing.push('Conditions of inspection (inspectionConditions)');

  // Vehicle identification
  if (!present(report.vehicleId)) missing.push('Vehicle identification (vehicleId)');
  if (report.odometerMiles === undefined || !(report.odometerMiles >= 0)) missing.push('Odometer reading at inspection (odometerMiles)');
  if (opts.vehicle) {
    if (!present(opts.vehicle.registration)) missing.push('Vehicle registration');
    if (!present(opts.vehicle.vin)) missing.push('VIN');
    if (!present(opts.vehicle.motExpiryDate) && !present(opts.vehicle.motStatus)) missing.push('MOT status / expiry');
  } else {
    notes.push('Registration, VIN and MOT status come from the vehicle record; pass `vehicle` to check them here.');
  }

  // Condition, damage, photos
  if (!present(report.preAccidentCondition)) missing.push('Pre-accident condition');
  if (!present(report.damageDescription)) missing.push('Damage description');
  if (report.photoEvidenceIds.length === 0) missing.push('Photographs of the damage (photoEvidenceIds)');

  // Repair method / estimate, roadworthiness, duration
  if (!present(report.repairMethod) && !present(report.estimateId)) missing.push('Repair method and estimate (repairMethod or estimateId)');
  if (!present(report.roadworthyReason)) missing.push(`Why the vehicle is ${report.roadworthy ? 'roadworthy' : 'unroadworthy'} (roadworthyReason)`);
  if (report.repairDurationWorkingDays === undefined && !report.totalLoss) missing.push('Repair duration in working days (repairDurationWorkingDays)');

  // Total loss, PAV, salvage
  const tlContext = report.totalLoss !== undefined || report.salvageCategory !== undefined || report.salvageValuePence !== undefined;
  if (tlContext) {
    if (!report.totalLoss) missing.push('Total-loss assessment (repair + hire + storage vs PAV − salvage)');
    if (!present(report.pavAssessmentId)) missing.push('PAV assessment with comparables (pavAssessmentId)');
    if (!report.salvageCategory) missing.push('Salvage category (ABI Code, by an Appropriately Qualified Person)');
    if (report.salvageValuePence === undefined) missing.push('Salvage value (actual bid or offer, never a fixed percentage)');
    if (report.totalLoss && report.totalLoss.decision !== 'repair' && report.repairDurationWorkingDays === undefined) {
      notes.push('Repair duration is carried by the total-loss assessment (projected repair working days).');
    }
  } else {
    notes.push('No total-loss assessment recorded. Confirm the repair is economic against PAV (repair + projected hire vs PAV − salvage) and record it if the estimate approaches the vehicle value.');
  }

  // ADAS and EV
  if (!present(report.adasNotes)) missing.push('ADAS notes (state "none fitted" where that is the position)');
  if (opts.isEvOrHybrid) {
    if (!present(report.evNotes)) missing.push('EV/hybrid notes (high-voltage battery and cabling inspection)');
  } else if (!present(report.evNotes)) {
    notes.push('No EV notes: fine for a conventional vehicle; record "not applicable" so the omission is deliberate.');
  }

  // Consistency with circumstances
  if (!report.consistentWithCircumstances && !present(report.consistencyNote)) {
    missing.push('Explanation of why the damage is not consistent with the stated circumstances (consistencyNote)');
  }
  if (report.consistentWithCircumstances && !present(report.consistencyNote)) {
    notes.push('State in words that the damage is consistent with the accident circumstances and why (direction, height, severity).');
  }

  // Fee
  if (!(report.feePence > 0)) missing.push('Engineer fee (feePence)');
  else notes.push(`Engineer fee ${formatGBP(report.feePence)}: issue a fee note showing the instruction date and the work done, to answer any "fee not recoverable" refusal.`);

  // Court
  if (report.forCourt) {
    const d = opts.courtDeclarations ?? {};
    const items: Array<[keyof CourtDeclarations, string]> = [
      ['substanceOfInstructions', 'CPR 35.10(3): substance of all material instructions, written and oral'],
      ['dutyToCourt', 'CPR 35.3 / 35.10(2): statement that the expert understands and has complied with the duty to the court'],
      ['statementOfTruth', 'PD 35: statement of truth in the prescribed form'],
      ['expertDeclaration', 'PD 35 para 3.2(9): declaration per the Guidance for the Instruction of Experts in Civil Claims'],
    ];
    for (const [key, label] of items) {
      courtItemsChecked.push(label);
      if (!d[key]) missing.push(label);
    }
    notes.push(`CPR 35 / PD 35 references: ${CPR35_VERIFICATION.sourceNote}`);
    // The small-claims notes belong on a small-claims file (or where the track is not yet known);
    // on a fast/intermediate/multi-track report they would be a wrong statement of the rules.
    if (opts.track === undefined || opts.track === 'small_claims') {
      notes.push(
        `${opts.track === undefined ? 'If allocated to the small claims track' : 'Small claims track'}: CPR 27.2 disapplies most of Part 35; no expert evidence without the court's permission (CPR 27.5); recoverable expert fees are capped at ${formatGBP(SMALL_CLAIMS_EXPERT_FEE_CAP_PENCE)} per expert (PD 27A para 7.3(2)). ${PD27A_FEE_CAP_VERIFICATION.sourceNote}`,
      );
    }
    if (opts.track === 'small_claims') {
      if (report.feePence > SMALL_CLAIMS_EXPERT_FEE_CAP_PENCE) {
        notes.push(`Engineer fee ${formatGBP(report.feePence)} exceeds the ${formatGBP(SMALL_CLAIMS_EXPERT_FEE_CAP_PENCE)} small-claims cap on recoverable expert fees; the excess is at the claimant's risk.`);
      } else {
        notes.push(`Engineer fee ${formatGBP(report.feePence)} is within the ${formatGBP(SMALL_CLAIMS_EXPERT_FEE_CAP_PENCE)} small-claims cap.`);
      }
    }
  }

  return { ok: missing.length === 0, missing, notes, courtItemsChecked };
}
