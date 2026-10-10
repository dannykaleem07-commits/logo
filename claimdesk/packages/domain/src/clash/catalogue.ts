// owned by ap-clash
/**
 * The clash catalogue (docs/SUPREME-AUTOPILOT.md §C.2) — pure data, one definition per code in table order.
 *
 * Severity: block / warn / info. Override class: A (manager override with a reason, audited), B (relaxed in manager
 * mode), C (never). `overrideCode` is the OVERRIDE_RULES code the routes refuse with through the manager-mode gate
 * (§C.4); it is null for warn/info and for class C. `greenBlocking` warns stop the autopilot acting alone (→ confirm)
 * until a person acknowledges them.
 */
import { CLASH_CODES, type ClashCode, type ClashDef, type ClashSeverity, type ClashSubjectKind } from './types.js';

const P: ClashSubjectKind = 'proposed_booking';
const R: ClashSubjectKind = 'reservation';
const H: ClashSubjectKind = 'hire';
const Cl: ClashSubjectKind = 'claim';
const U: ClashSubjectKind = 'fleet_unit';

function def(code: ClashCode, severity: ClashSeverity, overrideClass: ClashDef['overrideClass'], overrideCode: string | null, label: string, basis: string, subjects: ClashSubjectKind[], greenBlocking = false): ClashDef {
  return { code, severity, overrideClass, overrideCode, label, basis, subjects, greenBlocking };
}

const DEFS: ClashDef[] = [
  def('UNIT_DOUBLE_BOOKED', 'block', 'A', 'HIRE_OVERLAP', 'Car already booked for part of this period', "The car's occupied periods overlap another booking or hire (including late returns and the time until the car is collected).", [P, R, H, U]),
  def('TURNAROUND_SHORT', 'warn', 'C', null, 'Not enough time between hires', 'Less than the turnaround time between a return and the next start: no time to valet and inspect the car.', [P, R, U]),
  def('UNIT_NOT_READY', 'block', 'A', 'UNIT_NOT_READY', 'Car not ready at the start', 'An open task that blocks hire, or unrepaired major or unroadworthy damage, at the start.', [P, R, U]),
  def('UNIT_OFF_ROAD', 'block', 'A', 'ALLOCATION_REFUSED', 'Car marked off the road', 'The car is marked off the road (out of service).', [P, R, U]),
  def('UNIT_DISPOSED', 'block', 'C', null, 'Car disposed of', 'The car has been disposed of.', [P, R, U]),
  def('USE_NOT_DECLARED', 'block', 'A', 'ALLOCATION_REFUSED', 'Use not declared on the car', 'The use is not declared on the car (Collingwood: one class of use per policy).', [P, R]),
  def('POLICY_NOT_IN_FORCE', 'block', 'A', 'ALLOCATION_REFUSED', 'No insurance in force for this use', 'No policy, the policy is not in force at the start, or it does not cover this use.', [P, R, H, U]),
  def('POLICY_ENDS_IN_PERIOD', 'block', 'A', 'POLICY_ENDS_IN_PERIOD', 'Insurance ends during the hire', 'Cover ends before the expected end and no renewal policy is recorded.', [P, R, H, U]),
  def('MOT_INVALID_AT_START', 'block', 'A', 'ALLOCATION_REFUSED', 'MOT not valid at the start', 'The MOT has expired or is not valid at the start.', [P, R, U]),
  def('MOT_LAPSES_IN_PERIOD', 'warn', 'C', null, 'MOT runs out during the hire', 'The MOT expires during the period: book the test before it does.', [P, R, H, U], true),
  def('TAX_INVALID_AT_START', 'block', 'A', 'ALLOCATION_REFUSED', 'Car not taxed at the start', 'Untaxed, SORN or tax expired at the start.', [P, R, U]),
  def('TAX_LAPSES_IN_PERIOD', 'warn', 'C', null, 'Tax runs out during the hire', 'Vehicle tax is due during the period.', [P, R, H, U]),
  def('SERVICE_DUE_IN_PERIOD', 'warn', 'C', null, 'Service due during the hire', 'The service date or mileage falls due during the period.', [P, R, U]),
  def('PHV_LICENCE', 'block', 'C', null, 'PHV licence missing or ending', 'PCO use needs a PHV-licensed car with a TfL vehicle licence in force for the whole period.', [P, R]),
  def('KEEPER_ADDRESS_STALE', 'warn', 'C', null, 'V5C keeper address not current', 'The V5C keeper address is not current: penalty notices for this hire will go astray.', [P, R, U]),
  def('OPEN_PENALTY_ON_UNIT', 'info', 'C', null, 'Open penalty notice on the car', 'An open PCN or NIP on the car has a deadline during the period.', [P, R, U]),
  def('UNIT_IS_CLAIM_VEHICLE', 'block', 'C', null, "Car is this claim's own vehicle", "The car being booked is this claim's client or third-party vehicle.", [P, R]),
  def('FLEET_REG_AS_CLAIM_VEHICLE', 'block', 'A', 'HARD_STOP', 'Fleet car recorded as a claim vehicle', 'A fleet registration is recorded as a client or third-party vehicle on a claim: use "Record an incident on hire" instead.', [Cl, U]),
  def('SAME_REG_ON_HIRE', 'block', 'A', 'SAME_REG_ON_HIRE', "Client's car already has a hire on another claim", "The client's damaged car (registration or VIN) is the client vehicle on another claim with an open or overlapping hire or booking: possible double hire for one accident.", [P, R, Cl]),
  def('DUPLICATE_CLAIM_OPEN', 'block', 'A', 'DUPLICATE_CLAIM_OPEN', 'Same car on another open claim', 'The same client registration or VIN is on another open claim with an accident within the duplicate window: double recovery risk.', [P, Cl]),
  def('DUPLICATE_REGISTRATION', 'warn', 'C', null, 'Registration on another claim', 'The same registration is on another claim (closed, or with an accident far apart): a linked but separate file.', [Cl]),
  def('VIN_REG_MISMATCH', 'warn', 'C', null, 'Same VIN under another registration', 'The same VIN is on another claim under a different registration (cherished plate?).', [Cl]),
  def('CLAIM_SECOND_HIRE', 'block', 'A', 'CLAIM_SECOND_HIRE', 'Claim already has a car for this period', 'This claim already has another held, confirmed or on-hire booking overlapping the period (a swap uses touching periods).', [P, R]),
  def('HIRER_ON_OTHER_HIRE', 'block', 'A', 'HIRER_ON_OTHER_HIRE', 'Hirer already has a car on another claim', 'The hirer (the same person by licence number, or name and date of birth) has an overlapping booking or hire on another claim.', [P, R, H]),
  def('DRIVER_ON_OTHER_HIRE', 'warn', 'C', null, 'Driver named on another hire', 'An additional driver is also named on another overlapping hire.', [P, R, H], true),
  def('DRIVER_INELIGIBLE', 'block', 'C', null, 'Driver not eligible', "A driver is not eligible under the car's policy criteria (age, licence, points, excluded endorsement, disqualification…).", [P, R]),
  def('DRIVER_REFERRAL', 'block', 'A', 'DRIVER_REFERRAL', 'Driver needs referral to the insurer', "A driver needs the fleet insurer's acceptance: override only with the insurer's written acceptance on file.", [P, R]),
  def('LICENCE_CHECK_STALE', 'block', 'A', 'LICENCE_CHECK_STALE', 'Licence check missing or out of date', 'At handover: no licence check recorded, or the DVLA check is older than allowed.', [R]),
  def('HIRE_BEFORE_ACCIDENT', 'block', 'B', 'HIRE_BEFORE_ACCIDENT', 'Hire starts before the accident', 'The hire start is before the accident (a block for a new booking, a warning on a backdated hire).', [P, R, H]),
  def('HIRE_BEFORE_SERVICES', 'warn', 'C', null, 'Hire starts before services were agreed', 'The hire start is before the first notification or the services agreement.', [P, R, H]),
  def('HIRE_PAST_OFFHIRE', 'warn', 'C', null, 'Hire runs past the off-hire deadline', 'The expected end or end is after the off-hire deadline for the recorded trigger: the days beyond are unlikely to be recovered.', [R, H], true),
  def('RETURN_OVERDUE', 'warn', 'C', null, 'Car overdue back', 'On hire past its expected end and not returned.', [R, H, U]),
  def('CLAIM_STATUS_NO_HIRE', 'block', 'C', null, 'Claim status does not allow hire', 'The claim is declined, settled or closed.', [P, R]),
  def('ACCEPTANCE_CONDITIONS_UNMET', 'block', 'A', 'ACCEPTANCE_CONDITIONS_UNMET', 'Claim declined or acceptance condition not met', 'The acceptance decision is decline, or a condition that gates hire is not met (e.g. no hire until liability evidence obtained).', [P, R]),
  def('HARD_STOP_FLAG', 'block', 'A', 'HARD_STOP', 'Uncleared hard stop on the claim', 'An uncleared block flag is on the claim.', [P, R]),
  def('SIGNATURES_MISSING', 'block', 'A', 'SIGNATURES_MISSING', 'Hire paperwork not signed', 'At handover: the hire agreement, the Sch 3 cancellation form or the express request to start is not signed or provided (W v Veolia).', [R]),
  def('GROUP_ABOVE_LFL', 'warn', 'C', null, 'Car group above like for like', "The car's group is above the client's like-for-like group (by benchmark rate) and no substitution reason is recorded.", [P, R], true),
  def('NEED_WEAK', 'warn', 'C', null, 'Need for a car is weak', 'Need is weak or none (another household car, own insurer courtesy car): hire may be challenged.', [P, Cl], true),
  def('INTERVENTION_UNANSWERED', 'warn', 'C', null, 'Insurer intervention offer not answered', 'An insurer intervention offer has no written reply.', [P, Cl], true),
  def('CLIENT_CAR_NOT_LEGAL', 'warn', 'C', null, "Client's car had no MOT or tax", "The client's car had no MOT or no tax on the accident date (insurance cannot be checked and is not flagged).", [Cl], true),
  def('INJURY_NOT_REFERRED', 'info', 'C', null, 'Injury not referred', 'Personal injury is on file with no referral (never blocks hire).', [Cl]),
  def('DELIVERY_BEFORE_READY', 'block', 'A', 'UNIT_NOT_READY', 'Delivery before the car is ready', 'The delivery window starts before the car is ready.', [R]),
  def('DELIVERY_CAPACITY', 'warn', 'C', null, 'Too many movements in one window', 'More deliveries and collections in one window than the maximum per window.', [R]),
  def('HOLD_EXPIRED', 'block', 'C', null, 'Hold expired', 'Confirming or offering a hold that has expired: hold the car again instead.', [R]),
];

export const CLASH_CATALOGUE: Readonly<Record<ClashCode, ClashDef>> = Object.freeze(Object.fromEntries(DEFS.map((d) => [d.code, Object.freeze(d)])) as Record<ClashCode, ClashDef>);

/** The definitions in §C.2 table order. */
export const CLASH_DEFS: readonly ClashDef[] = Object.freeze(CLASH_CODES.map((c) => CLASH_CATALOGUE[c]));

export function clashDef(code: ClashCode): ClashDef {
  return CLASH_CATALOGUE[code];
}

/** Warn codes that stop the autopilot acting alone until a person acknowledges them. */
export const GREEN_BLOCKING_CLASH_CODES: readonly ClashCode[] = Object.freeze(DEFS.filter((d) => d.greenBlocking).map((d) => d.code));
