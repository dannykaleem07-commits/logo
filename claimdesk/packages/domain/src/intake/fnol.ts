/**
 * FNOL validation and injury routing (BLUEPRINT §3.1).
 *
 * Mandatory fields: accident time, place, circumstances (≥ 40 characters, taken cold), third-party
 * registration (valid UK format — local regex copy, the vehicle module is not imported), the witnesses
 * question answered (an empty list is an answer; undefined is not), injuries answered, roadworthy
 * answered, client insurer and policy, and "has anyone offered you a vehicle?" answered with details
 * when yes. Injuries route to a referral task with no fee (LASPO 2012 ss.56–60).
 */
import type { ISODateTime } from '../types.js';

export interface FnolWitness {
  name: string;
  phone?: string;
  email?: string;
  /** How the client knows the witness: 'none' for an independent witness. Mandatory (lesson g). */
  relationship?: string;
}

export interface FnolOfferDetails {
  what?: string;
  byWhom?: string;
  when?: string;
}

export interface FnolInput {
  recordingDisclosureGiven?: boolean;
  claimant?: { name?: string; phone?: string; email?: string; dateOfBirth?: string };
  clientVehicle?: { registration?: string };
  accident: {
    occurredAt?: ISODateTime | string;
    location?: string;
    postcode?: string;
    circumstances?: string;
    /** The handler confirms the account was taken cold (open questions, verbatim). */
    takenCold?: boolean;
    injuries?: boolean;
    injuryDetails?: string;
    roadworthyAfter?: boolean;
    driveable?: boolean;
    policeAttended?: boolean;
    policeReference?: string;
    cctvAvailable?: boolean;
    dashcamAvailable?: boolean;
  };
  thirdParty: {
    registration?: string;
    /** True when the other driver failed to stop and the plate is genuinely unknown (MIB Untraced route). */
    registrationUnknown?: boolean;
    name?: string;
    insurer?: string;
  };
  /** undefined = the question was not asked; [] = asked, none. */
  witnesses?: FnolWitness[];
  clientInsurer?: string;
  clientPolicyNumber?: string;
  /** "Has anyone offered you a vehicle?" — must be answered. */
  offerDisclosed?: boolean;
  offerDetails?: FnolOfferDetails;
}

export interface FnolIssue {
  field: string;
  message: string;
}

export interface FnolValidation {
  ok: boolean;
  errors: FnolIssue[];
  warnings: FnolIssue[];
}

export const MIN_CIRCUMSTANCES_CHARS = 40;

// Local copy of the UK registration formats (vehicle module not imported, to keep intake decoupled).
const REG_CURRENT = /^[A-HJ-PR-Y]{2}\d{2}[A-HJ-PR-Z]{3}$/;
const REG_PREFIX = /^[A-HJ-NPR-TV-Y]\d{1,3}[A-Z]{3}$/;
const REG_SUFFIX = /^[A-Z]{3}\d{1,3}[A-HJ-NPR-TV-Y]$/;
const REG_NI = /^[A-Z](?:[IZ][A-Z]|[A-Z][IZ])\d{1,4}$/;
const REG_DATELESS_A = /^[A-Z]{1,3}\d{1,4}$/;
const REG_DATELESS_B = /^\d{1,4}[A-Z]{1,3}$/;

export function normaliseRegistrationLocal(input: string): string {
  return (input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidRegistrationLocal(input: string): boolean {
  const reg = normaliseRegistrationLocal(input);
  if (reg.length < 2 || reg.length > 7) return false;
  return REG_CURRENT.test(reg) || REG_PREFIX.test(reg) || REG_SUFFIX.test(reg) || REG_NI.test(reg) || REG_DATELESS_A.test(reg) || REG_DATELESS_B.test(reg);
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?\s*(Z|z|[+-]\d{2}(:?\d{2})?)?$/;

function blank(s: string | undefined): boolean {
  return !s || s.trim().length === 0;
}

export function validateFnol(input: FnolInput): FnolValidation {
  const errors: FnolIssue[] = [];
  const warnings: FnolIssue[] = [];
  const acc = input.accident ?? {};
  const tp = input.thirdParty ?? {};

  // Recording disclosure
  if (input.recordingDisclosureGiven === false) errors.push({ field: 'recordingDisclosureGiven', message: 'The call-recording disclosure must be read before the account is taken.' });
  else if (input.recordingDisclosureGiven === undefined) warnings.push({ field: 'recordingDisclosureGiven', message: 'Confirm the call-recording disclosure was read at the start of the call.' });

  // Accident time
  if (blank(acc.occurredAt)) errors.push({ field: 'accident.occurredAt', message: 'Accident date and time are mandatory.' });
  else if (!ISO_DATETIME.test(acc.occurredAt!.trim())) errors.push({ field: 'accident.occurredAt', message: 'Accident time must be an ISO 8601 date-time (e.g. 2026-09-21T09:00:00+01:00).' });

  // Place
  if (blank(acc.location)) errors.push({ field: 'accident.location', message: 'Accident location is mandatory (road, junction or landmark).' });
  if (blank(acc.postcode)) warnings.push({ field: 'accident.postcode', message: 'No postcode: add one for the CCTV request and the locality of BHR evidence.' });

  // Circumstances, taken cold
  const circumstances = (acc.circumstances ?? '').trim();
  if (circumstances.length === 0) errors.push({ field: 'accident.circumstances', message: 'The client’s account of the circumstances is mandatory.' });
  else if (circumstances.length < MIN_CIRCUMSTANCES_CHARS) errors.push({ field: 'accident.circumstances', message: `The account must be at least ${MIN_CIRCUMSTANCES_CHARS} characters, in the client’s own words (${circumstances.length} given).` });
  if (acc.takenCold === false) errors.push({ field: 'accident.takenCold', message: 'The account must be taken cold: open questions, no suggestions, recorded verbatim and attributed to the client (perimeter.md Part 1).' });
  else if (acc.takenCold === undefined) warnings.push({ field: 'accident.takenCold', message: 'Confirm the account was taken cold (open questions, verbatim).' });

  // Third-party registration
  if (tp.registrationUnknown === true) {
    warnings.push({ field: 'thirdParty.registration', message: 'Third-party registration unknown: untraced driver — MIB Untraced Drivers Agreement 2017 route; report to the police within 14 days and record the circumstances of the failure to stop.' });
  } else if (blank(tp.registration)) {
    errors.push({ field: 'thirdParty.registration', message: 'Third-party registration is mandatory (or mark it unknown with the circumstances).' });
  } else if (!isValidRegistrationLocal(tp.registration!)) {
    errors.push({ field: 'thirdParty.registration', message: `"${tp.registration}" is not a valid UK registration format.` });
  }

  // Witnesses
  if (input.witnesses === undefined) errors.push({ field: 'witnesses', message: 'The witnesses question must be asked and answered (an empty list is a valid answer).' });
  else {
    input.witnesses.forEach((w, i) => {
      if (blank(w.name)) errors.push({ field: `witnesses[${i}].name`, message: 'Each witness needs a name.' });
      if (blank(w.relationship)) errors.push({ field: `witnesses[${i}].relationship`, message: 'Record how the client knows each witness ("none" if independent) — connected witnesses are flagged (lesson g).' });
      else if (!/^(none|no|independent|stranger|n\/a)$/i.test(w.relationship!.trim())) warnings.push({ field: `witnesses[${i}].relationship`, message: `Witness "${w.name}" is connected to the client (${w.relationship}): corroborate with CCTV or the third party’s account.` });
    });
  }

  // Injuries
  if (typeof acc.injuries !== 'boolean') errors.push({ field: 'accident.injuries', message: 'The injuries question must be answered yes or no.' });
  else if (acc.injuries) warnings.push({ field: 'accident.injuries', message: 'Injury reported: refer the personal injury element out with no referral fee (LASPO 2012 ss.56–60); CCGUK continues the damage-only claim.' });

  // Roadworthy
  if (typeof acc.roadworthyAfter !== 'boolean') errors.push({ field: 'accident.roadworthyAfter', message: 'Roadworthiness after the accident must be answered yes or no.' });

  // Client insurer and policy
  if (blank(input.clientInsurer)) errors.push({ field: 'clientInsurer', message: 'The client’s own insurer is mandatory.' });
  if (blank(input.clientPolicyNumber)) errors.push({ field: 'clientPolicyNumber', message: 'The client’s policy number is mandatory.' });

  // Intervention guard question
  if (typeof input.offerDisclosed !== 'boolean') errors.push({ field: 'offerDisclosed', message: '"Has anyone offered you a vehicle?" must be asked and answered.' });
  else if (input.offerDisclosed) {
    const d = input.offerDetails ?? {};
    for (const [k, label] of [
      ['what', 'what exactly was offered'],
      ['byWhom', 'who made the offer'],
      ['when', 'when it was made'],
    ] as const) {
      if (blank(d[k])) errors.push({ field: `offerDetails.${k}`, message: `An offer was disclosed: record ${label}.` });
    }
    warnings.push({ field: 'offerDisclosed', message: 'Log the offer in the intervention register and send the written reply within 1 working day; the client decides on the offer with the facts in front of them.' });
  }

  // Optional prompts
  if (acc.policeAttended === true && blank(acc.policeReference)) warnings.push({ field: 'accident.policeReference', message: 'Police attended: obtain the reference (CAD / collision report number).' });
  if (acc.cctvAvailable === undefined && acc.dashcamAvailable === undefined) warnings.push({ field: 'accident.cctvAvailable', message: 'Ask about dashcam and nearby cameras: the preservation request must go within 7 days.' });

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------------------------

export const INJURY_REFERRAL_TITLE = 'Refer personal injury element to PI solicitor (no referral fee — LASPO 2012 ss.56–60)';

export interface InjuryRouting {
  refer: boolean;
  task?: {
    title: typeof INJURY_REFERRAL_TITLE;
    feeTaken: false;
    basis: string[];
    note: string;
  };
  continueDamageOnly: true;
}

/** Route the injury element: a referral task with no fee, and the damage-only claim continues. */
export function routeInjury(input: Pick<FnolInput, 'accident'> | { injuries?: boolean; injuryDetails?: string }): InjuryRouting {
  const injuries = 'accident' in input ? input.accident?.injuries === true : input.injuries === true;
  if (!injuries) return { refer: false, continueDamageOnly: true };
  return {
    refer: true,
    task: {
      title: INJURY_REFERRAL_TITLE,
      feeTaken: false,
      basis: ['LASPO 2012 ss.56–60 (referral-fee ban)', 'FCA claims-management perimeter (RAO art 89G onwards; PERG 2.7)', 'Limitation Act 1980 s.11 (3 years — the instructed solicitor owns this date)', 'BLUEPRINT §3.1 (lesson j)'],
      note: 'Log the referral on the claim (referredTo, referredAt, feeTaken: false). Give the client no view on the injury claim. CCGUK continues the vehicle-damage and hire claim only.',
    },
    continueDamageOnly: true,
  };
}
