/**
 * Manager-mode override registry (docs/V03-MANAGER-MODE-HIRE-PRICING.md §A). Pure data shared by the API (which refusals
 * the central gate may turn into an audited override) and the web (labels). Class A: a business rule a manager may
 * override with an audited reason. Class B: a data-shape or required-answer check relaxed in manager mode. Every code
 * that is not listed here is class C and is never overridable.
 */
export type OverrideClass = 'A' | 'B';

export interface OverrideRule {
  code: string;
  class: OverrideClass;
  /** Plain-English name shown in the prompt and in the "Overridden: …" toast. */
  label: string;
  /** Extra caution shown in red in the prompt (legal, payment or fraud risk). */
  warning?: string;
}

export const MANAGER_ROLES = ['admin', 'approver'] as const;
export const MANAGER_MODE_DEFAULT_IDLE_MINUTES = 60;
export const MANAGER_MODE_MIN_IDLE_MINUTES = 1;
export const MANAGER_MODE_MAX_IDLE_MINUTES = 480;
export const DEFAULT_OVERRIDE_REASON = 'Manager override';
export const OVERRIDE_REASON_MAX = 500;
/** Request header: present (URI-encoded reason) = "override if manager mode is on". */
export const MANAGER_OVERRIDE_HEADER = 'x-manager-override';
/** Request header: URI-encoded comma list of web-only rule keys the user relaxed in manager mode (max 20). */
export const MANAGER_RELAXED_HEADER = 'x-manager-relaxed';
/** Response header: URI-encoded JSON `Array<{ code, label, reason }>` of the overrides applied by a 2xx response. */
export const MANAGER_OVERRIDES_RESPONSE_HEADER = 'x-manager-overrides';

/** Word-template guard codes that GUARD_BLOCKED may override (all other guard codes, e.g. BANK_DETAILS_PLACEHOLDER, are C). */
export const OVERRIDABLE_TEMPLATE_GUARDS = ['PRINTED_RATES_DIFFER', 'OPEN_RECORD_END', 'BANK_ACCOUNT_NAME_MISMATCH', 'REFERENCE_DOUBLED', 'WITNESS_RELATIONSHIP_REQUIRED', 'BANK_DETAILS_REQUIRED'] as const;

const r = (code: string, cls: OverrideClass, label: string, warning?: string): OverrideRule => (warning ? { code, class: cls, label, warning } : { code, class: cls, label });

export const OVERRIDE_RULES: Readonly<Record<string, OverrideRule>> = Object.freeze({
  // ---- class A: business rules
  HARD_STOP: r('HARD_STOP', 'A', 'Uncleared hard-stop flag on the claim', 'The flag stays on the file until someone clears it with a reason.'),
  ALLOCATION_REFUSED: r('ALLOCATION_REFUSED', 'A', 'Fleet car not cleared for this hire (status, use, policy, MOT or tax)', 'Check the car is insured for this use before it goes out.'),
  HIRE_OVERLAP: r('HIRE_OVERLAP', 'A', 'Fleet car is on another hire for part of this period'),
  REGISTRATION_ON_CLAIM: r('REGISTRATION_ON_CLAIM', 'A', 'Registration is a client vehicle on a claim'),
  UNIT_ON_HIRE: r('UNIT_ON_HIRE', 'A', 'Fleet car is still on hire', 'The open hire is left running and flagged: end it with its real date.'),
  TRANSITION_REFUSED: r('TRANSITION_REFUSED', 'A', 'Penalty notice stage change out of order'),
  CHECKLIST_INCOMPLETE: r('CHECKLIST_INCOMPLETE', 'A', "Engineer's report checklist incomplete"),
  LINES_UNCONFIRMED: r('LINES_UNCONFIRMED', 'A', 'Estimate lines not confirmed by the engineer'),
  TOO_FEW_COMPARABLES: r('TOO_FEW_COMPARABLES', 'A', 'Fewer than three comparables for the pre-accident value'),
  DOCUMENT_BLOCKED: r('DOCUMENT_BLOCKED', 'A', 'Document has uncleared consistency flags', 'Each flag is cleared with your reason. Read any flag about regulated status or old company details before approving.'),
  TEMPLATE_WARNINGS_UNACKNOWLEDGED: r('TEMPLATE_WARNINGS_UNACKNOWLEDGED', 'A', 'Template wording not yet reviewed'),
  GUARD_BLOCKED: r('GUARD_BLOCKED', 'A', 'Word template check failed (rates, open hire end, payee name, reference, witness)', 'A bank account name that is not "Courtesy Cars Group UK Ltd" fails Confirmation of Payee and risks money going to the wrong account.'),
  HIRE_OPEN: r('HIRE_OPEN', 'A', 'Hire still running (interim invoice to today)'),
  STORAGE_OPEN: r('STORAGE_OPEN', 'A', 'Storage still running (interim invoice to today)'),
  NO_PAYMENT_PACK: r('NO_PAYMENT_PACK', 'A', 'No payment pack sent yet'),
  EXTRA_OVERRIDES_LEDGER: r('EXTRA_OVERRIDES_LEDGER', 'A', 'Typed figure replaces the ledger figure'),
  LEGACY_DETAIL: r('LEGACY_DETAIL', 'A', 'Old company details', 'Old company details on letters and forms are a misrepresentation and fraud risk.'),
  COMPANY_NAME_NOT_REGISTERED: r('COMPANY_NAME_NOT_REGISTERED', 'A', 'Company name is not the registered name', 'Letters must show the registered name Courtesy Cars Group UK Ltd.'),
  // ---- class A: Autopilot clash codes (docs/SUPREME-AUTOPILOT.md §C.2)
  UNIT_NOT_READY: r('UNIT_NOT_READY', 'A', 'Fleet car not ready at the start (open blocking task or unrepaired damage)', 'Check the car is safe and roadworthy before it goes out.'),
  POLICY_ENDS_IN_PERIOD: r('POLICY_ENDS_IN_PERIOD', 'A', 'Fleet insurance ends before the expected end of the hire', 'The car would be uninsured after the policy end date unless a renewal is recorded.'),
  SAME_REG_ON_HIRE: r('SAME_REG_ON_HIRE', 'A', "The client's car is already on another claim with a hire or booking", 'Possible double hire for one accident — fraud risk.'),
  DUPLICATE_CLAIM_OPEN: r('DUPLICATE_CLAIM_OPEN', 'A', 'Same client car on another open claim with a close accident date', 'Possible double recovery for one accident.'),
  CLAIM_SECOND_HIRE: r('CLAIM_SECOND_HIRE', 'A', 'This claim already has another booking or hire for part of this period'),
  HIRER_ON_OTHER_HIRE: r('HIRER_ON_OTHER_HIRE', 'A', 'The hirer already has a booking or hire on another claim for part of this period'),
  DRIVER_REFERRAL: r('DRIVER_REFERRAL', 'A', 'Driver needs referral to the fleet insurer', "Only with the insurer's written acceptance on file."),
  LICENCE_CHECK_STALE: r('LICENCE_CHECK_STALE', 'A', 'No licence evidence, or the DVLA check is older than allowed'),
  ACCEPTANCE_CONDITIONS_UNMET: r('ACCEPTANCE_CONDITIONS_UNMET', 'A', 'Claim declined or its acceptance conditions are not met'),
  SIGNATURES_MISSING: r('SIGNATURES_MISSING', 'A', 'Hire paperwork not signed or not provided', 'An unsigned hire is unenforceable (W v Veolia).'),
  // ---- class B: data shape / required answers
  FNOL_INCOMPLETE: r('FNOL_INCOMPLETE', 'B', 'New claim is missing intake answers', 'The claim opens with an "intake incomplete" flag listing what is missing. Call-recording disclosure is a legal duty: record it as soon as it is given.'),
  REGISTRATION_FORMAT: r('REGISTRATION_FORMAT', 'B', 'Registration is not a UK format'),
  GTA_SUGGESTION_UNAVAILABLE: r('GTA_SUGGESTION_UNAVAILABLE', 'B', 'No GTA group found for the fleet car (saved as UNGROUPED)'),
  VALUES_REQUIRED: r('VALUES_REQUIRED', 'B', 'Word template has blank required values (left blank to complete by hand)'),
  HIRE_END_BEFORE_START: r('HIRE_END_BEFORE_START', 'B', 'Hire ends before it starts', 'Charged as 0 days and flagged on the claim until the dates are corrected.'),
  WEB_VALIDATION: r('WEB_VALIDATION', 'B', 'On-screen checks relaxed'),
  HIRE_BEFORE_ACCIDENT: r('HIRE_BEFORE_ACCIDENT', 'B', 'Hire starts before the accident'),
});

export function overrideRule(code: string): OverrideRule | undefined {
  return Object.prototype.hasOwnProperty.call(OVERRIDE_RULES, code) ? OVERRIDE_RULES[code] : undefined;
}
export function isOverridable(code: string): boolean {
  return overrideRule(code) !== undefined;
}
export function isManagerRole(role: string | undefined | null): boolean {
  return role === 'admin' || role === 'approver';
}
