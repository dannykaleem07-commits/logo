/**
 * Typed adapters between the API and the @ccguk/domain engines.
 *
 * The domain modules (intake, acceptance, playbook, clocks, fleet) landed with signatures that differ in detail from
 * the API's route contract — e.g. `validateFnol(FnolInput)` reports `{ errors, warnings }` keyed by field, `routeInjury`
 * returns a referral *task*, `canAllocate(unit, use, policy, now)` takes the unit's single policy, `nextActions(bundle,
 * ctx)` wants the clocks and gates in a context object. Everything here is a thin, typed translation so the routes keep
 * one stable shape (and typecheck breaks loudly if a domain signature moves again, instead of failing at runtime).
 *
 * Signatures follow docs/ARCHITECTURE.md ("Key exports (names are the contract)").
 */
import {
  assessAcceptance as domainAssessAcceptance,
  canAllocate as domainCanAllocate,
  deriveClocks as domainDeriveClocks,
  nextActions as domainNextActions,
  routeInjury as domainRouteInjury,
  scoreLiability as domainScoreLiability,
  validateFnol as domainValidateFnol,
  type AcceptanceAssessment,
  type AccidentDetails,
  type Claim,
  type ClaimBundle,
  type Clock,
  type FleetUnit,
  type FleetUse,
  type FnolInput,
  type FnolIssue,
  type GateResult,
  type InsurancePolicy,
  type ISODateTime,
  type LiabilityExtras,
  type LiabilityFactor,
  type PlaybookAction,
  type PlaybookRule,
  type Vehicle,
} from '@ccguk/domain';

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

export type { FnolInput, FnolIssue };

export interface FnolValidation {
  /** False when a hard error is present (the API answers 400). */
  ok: boolean;
  /** Field paths of the hard errors (kept for the route contract: `details.missing`). */
  missing: string[];
  /** The hard errors with their messages. */
  errors: FnolIssue[];
  /**
   * Mandatory intake questions the domain says must be answered but the API contract lets the handler leave for later
   * (client insurer and policy, the witnesses question, injuries, roadworthiness, third-party registration, "has anyone
   * offered you a vehicle?"). The claim is opened and an INTAKE_INCOMPLETE flag lists them until the file is completed.
   */
  incomplete: FnolIssue[];
  /** Domain warnings, as plain messages. */
  warnings: string[];
}

/** Intake questions that become an INTAKE_INCOMPLETE flag rather than a 400 (see FnolValidation.incomplete). */
const SOFT_FIELDS = new Set(['witnesses', 'accident.injuries', 'accident.roadworthyAfter', 'clientInsurer', 'clientPolicyNumber', 'offerDisclosed']);

function isSoft(issue: FnolIssue): boolean {
  if (SOFT_FIELDS.has(issue.field)) return true;
  if (/^witnesses\[\d+\]\.relationship$/.test(issue.field)) return true;
  // A blank third-party registration is a question still open; a *supplied* registration in a bad format is a hard error.
  if (issue.field === 'thirdParty.registration' && /mandatory/i.test(issue.message)) return true;
  return false;
}

/** Run the domain FNOL validation and split its errors into hard stops and open intake questions. */
export function validateFnolInput(input: FnolInput): FnolValidation {
  const result = domainValidateFnol(input);
  const errors = result.errors.filter((e) => !isSoft(e));
  const incomplete = result.errors.filter(isSoft);
  return {
    ok: errors.length === 0,
    missing: errors.map((e) => e.field),
    errors,
    incomplete,
    warnings: result.warnings.map((w) => `${w.field}: ${w.message}`),
  };
}

// ---------------------------------------------------------------------------
// Liability
// ---------------------------------------------------------------------------

export interface LiabilityScore {
  /** 0..100 */
  score: number;
  /** Plain-English factors (for the FNOL event and the intake report). */
  reasons: string[];
  band: 'strong' | 'arguable' | 'weak';
  rawScore: number;
  factors: LiabilityFactor[];
}

export interface LiabilityContext {
  liability?: Claim['liability'];
  /** Other claims on the same registration (cross-file check). */
  priorClaimsOnRegistration?: number;
  /** CCTV / dashcam footage actually on the file (not merely "available"). */
  footageObtained?: boolean;
  thirdPartyAccountContradicts?: boolean;
}

/** `scoreLiability(accident, extras)` with the API's claim-level facts mapped onto the domain's `LiabilityExtras`. */
export function scoreLiabilityFor(accident: AccidentDetails, context: LiabilityContext = {}): LiabilityScore {
  const extras: LiabilityExtras = {};
  if (context.liability === 'admitted') extras.thirdPartyAdmitted = true;
  if (context.liability === 'denied' || context.liability === 'disputed') extras.thirdPartyAccountContradicts = true;
  if (context.thirdPartyAccountContradicts !== undefined) extras.thirdPartyAccountContradicts = context.thirdPartyAccountContradicts;
  if (accident.highwayCodeRules?.length) extras.highwayCodeRulesAgainstThirdParty = accident.highwayCodeRules;
  if (context.priorClaimsOnRegistration !== undefined) extras.priorClaimsOnRegistration = context.priorClaimsOnRegistration;
  if (context.footageObtained !== undefined) extras.footageObtained = context.footageObtained;
  const r = domainScoreLiability(accident, extras);
  return { score: r.score, reasons: r.factors.map((f) => f.note), band: r.band, rawScore: r.rawScore, factors: r.factors };
}

// ---------------------------------------------------------------------------
// Injury routing (referral out, no fee — LASPO 2012 ss.56–60)
// ---------------------------------------------------------------------------

export interface InjuryRouting {
  refer: true;
  referredTo: string;
  message: string;
  feeTaken: false;
  task: NonNullable<ReturnType<typeof domainRouteInjury>['task']>;
}

export const DEFAULT_INJURY_REFERRAL = 'External personal-injury solicitor — to be instructed by the client (CCGUK takes no referral fee)';

/** Undefined when no injury was reported; otherwise the referral the claim records. */
export function routeInjuryFor(accident: AccidentDetails, referredTo?: string): InjuryRouting | undefined {
  const r = domainRouteInjury({ accident });
  if (!r.refer || !r.task) return undefined;
  return {
    refer: true,
    referredTo: referredTo?.trim() || DEFAULT_INJURY_REFERRAL,
    message: `${r.task.title}. ${r.task.note}`,
    feeTaken: false,
    task: r.task,
  };
}

// ---------------------------------------------------------------------------
// Fleet allocation (class-of-use guard)
// ---------------------------------------------------------------------------

export interface AllocationCheck {
  ok: boolean;
  reasons: string[];
  warnings: string[];
  /** The policy the unit is linked to, when any. */
  policyId?: string;
}

/** `canAllocate(unit, use, policy, now, vehicle)` — the unit's linked policy is picked out of `policies`. */
export function canAllocateFor(unit: FleetUnit, use: FleetUse, policies: InsurancePolicy[], now: ISODateTime, vehicle?: Vehicle): AllocationCheck {
  const policy = unit.policyId ? policies.find((p) => p.id === unit.policyId) : undefined;
  const r = domainCanAllocate(unit, use, policy, now, vehicle);
  return { ok: r.ok, reasons: [...r.reasons], warnings: [...r.warnings], policyId: policy?.id };
}

// ---------------------------------------------------------------------------
// Clocks, playbook, acceptance
// ---------------------------------------------------------------------------

export function deriveClocksFor(bundle: ClaimBundle, now: ISODateTime): Clock[] {
  return domainDeriveClocks(bundle, now);
}

export interface PlaybookInputs {
  now: ISODateTime;
  gates: GateResult[];
  /** Defaults to `bundle.clocks`. */
  clocks?: Clock[];
  rules?: PlaybookRule[];
  baseRatePct?: number;
  /** Whether this insurer has paid CCGUK before (vendor-verification trigger). Undefined = unknown. */
  insurerPaidBefore?: boolean;
}

export function nextActionsFor(bundle: ClaimBundle, inputs: PlaybookInputs): PlaybookAction[] {
  return domainNextActions(bundle, {
    now: inputs.now,
    clocks: inputs.clocks ?? bundle.clocks,
    gates: inputs.gates,
    ...(inputs.rules?.length ? { rules: inputs.rules } : {}),
    ...(inputs.baseRatePct !== undefined ? { baseRatePct: inputs.baseRatePct } : {}),
    ...(inputs.insurerPaidBefore !== undefined ? { insurerPaidBefore: inputs.insurerPaidBefore } : {}),
  });
}

export function assessAcceptanceFor(bundle: ClaimBundle, gates: GateResult[], now: ISODateTime): AcceptanceAssessment {
  return domainAssessAcceptance(bundle, { gates, now });
}

// ---------------------------------------------------------------------------
// Registry (for /api/health)
// ---------------------------------------------------------------------------

export interface DomainEngines {
  deriveClocks: typeof deriveClocksFor;
  nextActions: typeof nextActionsFor;
  assessAcceptance: typeof assessAcceptanceFor;
  scoreLiability: typeof scoreLiabilityFor;
  validateFnol: typeof validateFnolInput;
  routeInjury: typeof routeInjuryFor;
  canAllocate: typeof canAllocateFor;
}

/** The engines the API is wired to (all @ccguk/domain, through the adapters above). */
export function resolveEngines(): DomainEngines {
  return {
    deriveClocks: deriveClocksFor,
    nextActions: nextActionsFor,
    assessAcceptance: assessAcceptanceFor,
    scoreLiability: scoreLiabilityFor,
    validateFnol: validateFnolInput,
    routeInjury: routeInjuryFor,
    canAllocate: canAllocateFor,
  };
}

/** Which domain export each engine is wired to — printed by /api/health. */
export function engineStatus(): Record<keyof DomainEngines, string> {
  return {
    deriveClocks: '@ccguk/domain deriveClocks(bundle, now) + API supplement',
    nextActions: '@ccguk/domain nextActions(bundle, { now, clocks, gates, rules, insurerPaidBefore })',
    assessAcceptance: '@ccguk/domain assessAcceptance(bundle, { gates, now })',
    scoreLiability: '@ccguk/domain scoreLiability(accident, extras)',
    validateFnol: '@ccguk/domain validateFnol(FnolInput) — hard errors 400, open questions → INTAKE_INCOMPLETE',
    routeInjury: '@ccguk/domain routeInjury({ accident })',
    canAllocate: '@ccguk/domain canAllocate(unit, use, policy, now, vehicle)',
  };
}
