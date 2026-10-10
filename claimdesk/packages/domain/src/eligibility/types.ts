// owned by ap-foundation (contracts); behaviour in driver.ts / need.ts / means.ts / roadworthiness.ts by ap-clash
/**
 * Eligibility contracts (docs/SUPREME-AUTOPILOT.md §F): driver eligibility against per-policy criteria, client need,
 * means and roadworthiness, and the overall summary used by availability, the green test, the qualify.* steps, clash
 * codes 26–27 and the handover guard. Pure types and defaults only.
 *
 * DEFAULT_DRIVER_CRITERIA are generic UK hire-insurer norms — the owner must check them against the real fleet policy
 * wording (Settings > Fleet > Driver criteria).
 */
import type { FleetUse, ISODate, ISODateTime, Id, Pence } from '../types.js';

// ---------------------------------------------------------------------------
// F.1 Driver profile and eligibility
// ---------------------------------------------------------------------------

export type LicenceCountry = 'GB' | 'NI' | 'EU_EEA' | 'OTHER' | 'unknown';

export interface DriverProfile {
  partyId: Id;
  licenceNumber?: string;
  licenceCountry: LicenceCountry;
  licenceType: 'full' | 'provisional' | 'international' | 'unknown';
  fullLicenceSince?: ISODate;
  licenceExpiry?: ISODate;
  categories: string[];
  /** e.g. '78' automatic only. */
  restrictionCodes: string[];
  points: number | null;
  endorsements: Array<{ code: string; offenceDate: ISODate; points: number }>;
  disqualifiedUntil?: ISODate;
  disqualifications5y: number | null;
  faultAccidents3y: number | null;
  unspentConvictions: string[] | null;
  medicalConditionsDeclared: boolean | null;
  occupation?: string;
  /** ClaimDesk cannot query DVLA: a person records the check result. */
  dvlaCheck?: { checkedAt: ISODateTime; checkedBy: string; summary: string; evidenceId?: Id };
  source: 'declared' | 'dvla_check' | 'licence_scan' | 'mixed';
  updatedBy: string;
  updatedAt: ISODateTime;
}

export type EligibilityOutcome = 'eligible' | 'refer' | 'ineligible' | 'unknown';
export const ELIGIBILITY_OUTCOMES: readonly EligibilityOutcome[] = ['eligible', 'refer', 'ineligible', 'unknown'];

export interface DriverEligibility {
  partyId: Id;
  outcome: EligibilityOutcome;
  reasons: Array<{ code: string; outcome: EligibilityOutcome; message: string }>;
  missing: string[];
  criteriaSource: 'policy' | 'settings_default';
  policyId?: Id;
  ageAtStart?: number;
  yearsFullLicence?: number;
  automaticOnly: boolean;
  youngDriverExcessPence?: Pence;
}

// ---------------------------------------------------------------------------
// F.2 Criteria (per insurance policy; defaults in Settings)
// ---------------------------------------------------------------------------

/** Bands: below `minAge` / above `maxAge` → ineligible; below `referBelowAge` / above `referAboveAge` → refer (same for years). */
export interface DriverCriteria {
  minAge: number;
  referBelowAge: number;
  maxAge: number;
  referAboveAge: number;
  minYearsFullLicence: number;
  referBelowYearsFullLicence: number;
  maxPointsEligible: number;
  /** Above the refer band → ineligible. */
  maxPointsRefer: number;
  excludedEndorsementPrefixes: string[];
  excludedLookbackYears: number;
  referEndorsementPrefixes: string[];
  maxFaultAccidents3yEligible: number;
  maxFaultAccidents3yRefer: number;
  disqualificationLookbackYears: number;
  licenceCountriesEligible: LicenceCountry[];
  licenceCountriesRefer: LicenceCountry[];
  provisionalAllowed: false;
  requireDvlaCheckWithinDays: number;
  unspentConvictionsRefer: boolean;
  youngDriverExcessPence: Pence | null;
}

/**
 * §F.2 defaults: ages 25–75 eligible, 21–24 and 76–79 refer, under 21 or 80+ ineligible; full licence ≥ 2 years
 * eligible, 1–2 refer, < 1 ineligible; points 0–6 eligible, 7–9 refer, ≥ 10 ineligible; DR/IN/UT/CD4–CD9/DD/BA/AC/TT99
 * within 5 years ineligible; CD1–CD3 and MS refer; disqualification within 5 years ineligible; fault accidents in 3
 * years 0–1 eligible, 2 refer, ≥ 3 ineligible; GB/NI/EU-EEA eligible, other countries refer; provisional never; DVLA
 * check within 14 days of handover; unspent convictions refer; young-driver excess not set (owner enters).
 */
export const DEFAULT_DRIVER_CRITERIA: DriverCriteria = {
  minAge: 21,
  referBelowAge: 25,
  maxAge: 79,
  referAboveAge: 75,
  minYearsFullLicence: 1,
  referBelowYearsFullLicence: 2,
  maxPointsEligible: 6,
  maxPointsRefer: 9,
  excludedEndorsementPrefixes: ['DR', 'IN', 'UT', 'CD4', 'CD5', 'CD6', 'CD7', 'CD8', 'CD9', 'DD', 'BA', 'AC', 'TT99'],
  excludedLookbackYears: 5,
  referEndorsementPrefixes: ['CD1', 'CD2', 'CD3', 'MS'],
  maxFaultAccidents3yEligible: 1,
  maxFaultAccidents3yRefer: 2,
  disqualificationLookbackYears: 5,
  licenceCountriesEligible: ['GB', 'NI', 'EU_EEA'],
  licenceCountriesRefer: ['OTHER'],
  provisionalAllowed: false,
  requireDvlaCheckWithinDays: 14,
  unspentConvictionsRefer: true,
  youngDriverExcessPence: null,
};

// ---------------------------------------------------------------------------
// F.3 – F.5 Need, means, roadworthiness (HireNeeds lives in booking/types.ts, §B.5)
// ---------------------------------------------------------------------------

export interface NeedAssessment {
  level: 'strong' | 'moderate' | 'weak' | 'none' | 'unknown';
  reasons: string[];
  missing: string[];
  mitigationRisks: string[];
  automaticOnly: boolean;
  use: FleetUse;
}

export interface MeansAssessment {
  basis: 'impecunious' | 'not_impecunious' | 'unknown';
  readiness: 'ready' | 'partial' | 'none';
  missing: string[];
  warning: string | null;
}

export interface RoadworthinessAssessment {
  driveable: boolean | null;
  hireFrom: 'now' | 'repair_start' | 'unknown';
  repairStartAt: ISODateTime | null;
  clientCarOnAccidentDate: { mot: 'valid' | 'expired' | 'unknown'; tax: 'valid' | 'untaxed' | 'unknown' };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// F.7 Overall
// ---------------------------------------------------------------------------

export interface EligibilitySummary {
  overall: EligibilityOutcome;
  driver: DriverEligibility;
  additionalDrivers: DriverEligibility[];
  need: NeedAssessment;
  means: MeansAssessment;
  roadworthiness: RoadworthinessAssessment;
  injury: { referralNeeded: boolean; referred: boolean };
  green: boolean;
  reasons: string[];
}

/** `eligibility_assessments.kind` (append-only table, migration 0013_autopilot). */
export type EligibilityAssessmentKind = 'driver' | 'need' | 'means' | 'roadworthiness' | 'injury' | 'acceptance' | 'overall';
export const ELIGIBILITY_ASSESSMENT_KINDS: readonly EligibilityAssessmentKind[] = ['driver', 'need', 'means', 'roadworthiness', 'injury', 'acceptance', 'overall'];

/** A stored assessment row. */
export interface EligibilityAssessmentRecord {
  id: Id;
  claimId: Id;
  partyId?: Id;
  policyId?: Id;
  kind: EligibilityAssessmentKind;
  outcome: string;
  reasons: unknown;
  inputsSha256: string;
  createdBy: string;
  createdAt: ISODateTime;
}

/** Order of severity: the outcome of a set of reasons is the worst one. */
export const ELIGIBILITY_OUTCOME_RANK: Readonly<Record<EligibilityOutcome, number>> = { eligible: 0, unknown: 1, refer: 2, ineligible: 3 };
