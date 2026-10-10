// owned by ap-clash
/**
 * Driver eligibility (docs/SUPREME-AUTOPILOT.md §F.1) — pure.
 *
 * A driver is assessed against the criteria of the fleet car's policy (or the Settings default, §F.2). Every check
 * adds a reason with its own outcome; the driver's outcome is the worst reason (ineligible > refer > unknown >
 * eligible). A required fact that is missing (date of birth, licence type, full-licence date, points) adds to
 * `missing` and makes the outcome at least `unknown`, which never lets an agent book alone: `qualify.driver` asks the
 * client for the licence (photo of both sides and a DVLA "share your licence" code). ClaimDesk cannot query DVLA; a
 * person records the check.
 *
 * The defaults are generic UK hire-insurer norms — the owner must check them against the real policy wording.
 */
import type { Party, ISODate } from '../types.js';
import { ELIGIBILITY_OUTCOME_RANK, type DriverCriteria, type DriverEligibility, type DriverProfile, type EligibilityOutcome } from './types.js';

type Reason = DriverEligibility['reasons'][number];

/** The worst of a list of outcomes (eligible when empty). */
export function worstOutcome(outcomes: readonly EligibilityOutcome[]): EligibilityOutcome {
  let worst: EligibilityOutcome = 'eligible';
  for (const o of outcomes) if (ELIGIBILITY_OUTCOME_RANK[o] > ELIGIBILITY_OUTCOME_RANK[worst]) worst = o;
  return worst;
}

const dateOnly = (iso: string): string => iso.slice(0, 10);

/** Whole years between two ISO dates (birthday arithmetic: a birthday on `at` counts). */
export function wholeYearsBetween(from: ISODate, at: ISODate): number {
  const [fy, fm, fd] = dateOnly(from).split('-').map(Number) as [number, number, number];
  const [ay, am, ad] = dateOnly(at).split('-').map(Number) as [number, number, number];
  let years = ay - fy;
  if (am < fm || (am === fm && ad < fd)) years -= 1;
  return years;
}

/** Fractional years between two ISO dates (365.25-day years), for licence length. */
export function fractionalYearsBetween(from: ISODate, at: ISODate): number {
  const ms = Date.parse(`${dateOnly(at)}T00:00:00Z`) - Date.parse(`${dateOnly(from)}T00:00:00Z`);
  return ms / (365.25 * 86_400_000);
}

/** `at` minus `years` whole years (same month and day), as an ISO date. */
export function yearsBefore(at: ISODate, years: number): ISODate {
  const [y, m, d] = dateOnly(at).split('-') as [string, string, string];
  return `${String(Number(y) - years).padStart(4, '0')}-${m}-${d}`;
}

const normCode = (c: string): string => c.toUpperCase().replace(/\s+/g, '');

/** The 5-character DVLA surname code: letters only, "MAC" → "MC", padded with 9s. */
export function licenceSurnameCode(surname: string): string {
  let s = surname.toUpperCase().replace(/[^A-Z]/g, '');
  if (s.startsWith('MAC')) s = `MC${s.slice(3)}`;
  return s.slice(0, 5).padEnd(5, '9');
}

/** Surname of a full name ("Mr John SMITH" / "SMITH, John" → SMITH). */
export function surnameOf(full: string): string | undefined {
  const s = full.replace(/\b(mr|mrs|ms|miss|mx|dr|prof|sir|dame|rev)\.?\s+/gi, '').trim();
  if (!s) return undefined;
  if (s.includes(',')) return s.split(',', 1)[0]!.trim() || undefined;
  const words = s.split(/\s+/);
  return words[words.length - 1];
}

/**
 * Cross-check a GB licence number against the holder's surname and date of birth (SD §G.2 encoding). Returns the
 * mismatches in plain English; [] when it matches or cannot be checked (not a 16-character GB number).
 */
export function licenceNumberMismatches(licenceNumber: string, holder: { name?: string; dateOfBirth?: ISODate }): string[] {
  const n = licenceNumber.toUpperCase().replace(/\s+/g, '');
  const m = /^([A-Z9]{5})(\d)(\d{2})(\d{2})(\d)([A-Z9]{2})(\d)([A-Z0-9]{2})$/.exec(n);
  if (!m) return [];
  const out: string[] = [];
  const surname = holder.name ? surnameOf(holder.name) : undefined;
  if (surname && licenceSurnameCode(surname) !== m[1]) out.push(`the surname part ${m[1]} does not match the surname ${surname}`);
  if (holder.dateOfBirth && /^\d{4}-\d{2}-\d{2}/.test(holder.dateOfBirth)) {
    const [y, mo, d] = dateOnly(holder.dateOfBirth).split('-') as [string, string, string];
    const monthRaw = Number(m[3]);
    const month = monthRaw > 50 ? monthRaw - 50 : monthRaw;
    if (`${y[2]}${y[3]}` !== `${m[2]}${m[5]}`) out.push('the year of birth does not match the date of birth');
    if (Number(mo) !== month) out.push('the month of birth does not match the date of birth');
    if (Number(d) !== Number(m[4])) out.push('the day of birth does not match the date of birth');
  }
  return out;
}

/**
 * Assess one driver against `criteria` at the hire start date `at` (§F.1). `profile` absent → the licence facts are
 * missing (outcome at least `unknown`); age checks still run from the party's date of birth.
 */
export function assessDriver(
  profile: DriverProfile | undefined,
  party: Pick<Party, 'dateOfBirth' | 'drivingLicenceNumber' | 'name'>,
  criteria: DriverCriteria,
  at: ISODate,
): DriverEligibility {
  const day = dateOnly(at);
  const reasons: Reason[] = [];
  const missing: string[] = [];
  const add = (code: string, outcome: EligibilityOutcome, message: string): void => {
    reasons.push({ code, outcome, message });
  };
  const out: DriverEligibility = {
    partyId: profile?.partyId ?? '',
    outcome: 'unknown',
    reasons,
    missing,
    criteriaSource: 'settings_default',
    automaticOnly: false,
  };

  // Age at the start.
  if (party.dateOfBirth && /^\d{4}-\d{2}-\d{2}/.test(party.dateOfBirth)) {
    const age = wholeYearsBetween(party.dateOfBirth, day);
    out.ageAtStart = age;
    if (age < criteria.minAge) add('AGE_UNDER_MIN', 'ineligible', `Age ${age} at the start is under the minimum of ${criteria.minAge}.`);
    else if (age > criteria.maxAge) add('AGE_OVER_MAX', 'ineligible', `Age ${age} at the start is over the maximum of ${criteria.maxAge}.`);
    else if (age < criteria.referBelowAge) add('AGE_YOUNG_REFER', 'refer', `Age ${age} at the start is under ${criteria.referBelowAge}: refer to the insurer.`);
    else if (age > criteria.referAboveAge) add('AGE_OLD_REFER', 'refer', `Age ${age} at the start is over ${criteria.referAboveAge}: refer to the insurer.`);
    else add('AGE_OK', 'eligible', `Age ${age} at the start.`);
    if (criteria.youngDriverExcessPence !== null && age < criteria.referBelowAge) out.youngDriverExcessPence = criteria.youngDriverExcessPence;
  } else {
    missing.push('date of birth');
  }

  if (!profile) {
    missing.push('licence type', 'full licence date', 'penalty points');
  } else {
    // Licence type and country.
    if (profile.licenceType === 'provisional') add('PROVISIONAL_LICENCE', 'ineligible', 'A provisional licence is never accepted.');
    else if (profile.licenceType === 'unknown') missing.push('licence type');
    else add('LICENCE_TYPE_OK', 'eligible', profile.licenceType === 'full' ? 'Full licence.' : 'International licence.');

    if (profile.licenceCountry === 'unknown') missing.push('licence country');
    else if (criteria.licenceCountriesEligible.includes(profile.licenceCountry)) add('LICENCE_COUNTRY_OK', 'eligible', `Licence issued in ${countryLabel(profile.licenceCountry)}.`);
    else if (criteria.licenceCountriesRefer.includes(profile.licenceCountry)) add('LICENCE_COUNTRY_REFER', 'refer', `Licence issued in ${countryLabel(profile.licenceCountry)}: refer to the insurer.`);
    else add('LICENCE_COUNTRY_EXCLUDED', 'ineligible', `Licences issued in ${countryLabel(profile.licenceCountry)} are not accepted.`);

    if (profile.licenceExpiry && dateOnly(profile.licenceExpiry) < day) add('LICENCE_EXPIRED', 'ineligible', `The licence expired on ${dateOnly(profile.licenceExpiry)}.`);

    // Years with a full licence.
    if (profile.fullLicenceSince && /^\d{4}-\d{2}-\d{2}/.test(profile.fullLicenceSince)) {
      const years = fractionalYearsBetween(profile.fullLicenceSince, day);
      out.yearsFullLicence = Math.floor(years * 10) / 10;
      const shown = years >= 1 ? `${Math.floor(years)} year${Math.floor(years) === 1 ? '' : 's'}` : `${Math.max(0, Math.round(years * 12))} months`;
      if (years < criteria.minYearsFullLicence) add('LICENCE_TOO_NEW', 'ineligible', `Full licence held for ${shown}; at least ${criteria.minYearsFullLicence} needed.`);
      else if (years < criteria.referBelowYearsFullLicence) add('LICENCE_NEW_REFER', 'refer', `Full licence held for ${shown} (under ${criteria.referBelowYearsFullLicence} years): refer to the insurer.`);
      else add('LICENCE_YEARS_OK', 'eligible', `Full licence held for ${shown}.`);
    } else if (profile.licenceType !== 'provisional') {
      missing.push('full licence date');
    }

    // Points.
    if (profile.points === null || profile.points === undefined) missing.push('penalty points');
    else if (profile.points > criteria.maxPointsRefer) add('POINTS_EXCLUDED', 'ineligible', `${profile.points} penalty points (more than ${criteria.maxPointsRefer}).`);
    else if (profile.points > criteria.maxPointsEligible) add('POINTS_REFER', 'refer', `${profile.points} penalty points (more than ${criteria.maxPointsEligible}): refer to the insurer.`);
    else add('POINTS_OK', 'eligible', `${profile.points} penalty point${profile.points === 1 ? '' : 's'}.`);

    // Endorsements within the lookback.
    const since = yearsBefore(day, criteria.excludedLookbackYears);
    for (const e of profile.endorsements ?? []) {
      const code = normCode(e.code);
      if (!code) continue;
      const recent = !e.offenceDate || dateOnly(e.offenceDate) > since;
      if (!recent) continue;
      const excluded = criteria.excludedEndorsementPrefixes.find((p) => code.startsWith(normCode(p)));
      if (excluded) {
        add('ENDORSEMENT_EXCLUDED', 'ineligible', `Endorsement ${code}${e.offenceDate ? ` (${dateOnly(e.offenceDate)})` : ''} within ${criteria.excludedLookbackYears} years is excluded.`);
        continue;
      }
      const refer = criteria.referEndorsementPrefixes.find((p) => code.startsWith(normCode(p)));
      if (refer) add('ENDORSEMENT_REFER', 'refer', `Endorsement ${code}${e.offenceDate ? ` (${dateOnly(e.offenceDate)})` : ''}: refer to the insurer.`);
    }

    // Disqualification.
    const dqSince = yearsBefore(day, criteria.disqualificationLookbackYears);
    if (profile.disqualifiedUntil && dateOnly(profile.disqualifiedUntil) >= day) add('DISQUALIFIED', 'ineligible', `Disqualified until ${dateOnly(profile.disqualifiedUntil)}.`);
    else if (profile.disqualifiedUntil && dateOnly(profile.disqualifiedUntil) > dqSince) add('DISQUALIFIED_RECENTLY', 'ineligible', `Disqualification ended ${dateOnly(profile.disqualifiedUntil)}, within ${criteria.disqualificationLookbackYears} years.`);
    else if (profile.disqualifications5y !== null && profile.disqualifications5y !== undefined && profile.disqualifications5y > 0 && criteria.disqualificationLookbackYears >= 5)
      add('DISQUALIFIED_RECENTLY', 'ineligible', `${profile.disqualifications5y} disqualification${profile.disqualifications5y === 1 ? '' : 's'} in the last 5 years.`);

    // Fault accidents.
    if (profile.faultAccidents3y !== null && profile.faultAccidents3y !== undefined) {
      const n = profile.faultAccidents3y;
      if (n > criteria.maxFaultAccidents3yRefer) add('FAULT_ACCIDENTS_EXCLUDED', 'ineligible', `${n} fault accidents in 3 years.`);
      else if (n > criteria.maxFaultAccidents3yEligible) add('FAULT_ACCIDENTS_REFER', 'refer', `${n} fault accidents in 3 years: refer to the insurer.`);
    }

    // Unspent convictions.
    if (criteria.unspentConvictionsRefer && profile.unspentConvictions && profile.unspentConvictions.length > 0)
      add('UNSPENT_CONVICTION_REFER', 'refer', `Unspent conviction${profile.unspentConvictions.length === 1 ? '' : 's'} declared: refer to the insurer.`);

    // Restrictions.
    if ((profile.restrictionCodes ?? []).some((c) => normCode(c) === '78')) {
      out.automaticOnly = true;
      add('AUTOMATIC_ONLY', 'eligible', 'Licence restriction 78: automatic cars only.');
    }
  }

  // Licence number vs surname / date of birth, and vs the party record.
  const licence = profile?.licenceNumber ?? party.drivingLicenceNumber;
  if (licence && (!profile || profile.licenceCountry === 'GB' || profile.licenceCountry === 'unknown')) {
    const mism = licenceNumberMismatches(licence, { ...(party.name ? { name: party.name } : {}), ...(party.dateOfBirth ? { dateOfBirth: party.dateOfBirth } : {}) });
    if (mism.length) add('LICENCE_NUMBER_MISMATCH', 'refer', `Licence number check: ${mism.join('; ')}.`);
  }
  if (profile?.licenceNumber && party.drivingLicenceNumber && normCode(profile.licenceNumber) !== normCode(party.drivingLicenceNumber))
    add('LICENCE_NUMBER_MISMATCH', 'refer', 'The licence number on the driver profile differs from the one on the party record.');

  let outcome = worstOutcome(reasons.map((r) => r.outcome));
  if (missing.length && ELIGIBILITY_OUTCOME_RANK[outcome] < ELIGIBILITY_OUTCOME_RANK.unknown) outcome = 'unknown';
  out.outcome = outcome;
  return out;
}

function countryLabel(c: DriverProfile['licenceCountry']): string {
  switch (c) {
    case 'GB':
      return 'Great Britain';
    case 'NI':
      return 'Northern Ireland';
    case 'EU_EEA':
      return 'the EU/EEA';
    case 'OTHER':
      return 'another country';
    default:
      return 'an unknown country';
  }
}
