// owned by ap-clash
/**
 * Driver criteria form model (docs/SUPREME-AUTOPILOT.md §F.2, §I.8, §L). Pure: the form keeps text fields; these turn
 * them into a DriverCriteria and say what is wrong in plain English.
 */
import { DEFAULT_DRIVER_CRITERIA, type DriverCriteria, type LicenceCountry } from '@ccguk/domain';

export const CRITERIA_NOTICE =
  'These are generic UK hire-insurer norms, not your policy. Check them against your fleet insurance policy wording and change them to match.';

export type CriteriaForm = Record<
  | 'minAge'
  | 'referBelowAge'
  | 'referAboveAge'
  | 'maxAge'
  | 'minYearsFullLicence'
  | 'referBelowYearsFullLicence'
  | 'maxPointsEligible'
  | 'maxPointsRefer'
  | 'excludedEndorsementPrefixes'
  | 'excludedLookbackYears'
  | 'referEndorsementPrefixes'
  | 'maxFaultAccidents3yEligible'
  | 'maxFaultAccidents3yRefer'
  | 'disqualificationLookbackYears'
  | 'requireDvlaCheckWithinDays'
  | 'youngDriverExcessPounds',
  string
> & { licenceCountriesEligible: LicenceCountry[]; licenceCountriesRefer: LicenceCountry[]; unspentConvictionsRefer: boolean };

export const COUNTRY_LABEL: Record<Exclude<LicenceCountry, 'unknown'>, string> = { GB: 'Great Britain', NI: 'Northern Ireland', EU_EEA: 'EU / EEA', OTHER: 'Other countries' };

export function toForm(c: DriverCriteria): CriteriaForm {
  return {
    minAge: String(c.minAge),
    referBelowAge: String(c.referBelowAge),
    referAboveAge: String(c.referAboveAge),
    maxAge: String(c.maxAge),
    minYearsFullLicence: String(c.minYearsFullLicence),
    referBelowYearsFullLicence: String(c.referBelowYearsFullLicence),
    maxPointsEligible: String(c.maxPointsEligible),
    maxPointsRefer: String(c.maxPointsRefer),
    excludedEndorsementPrefixes: c.excludedEndorsementPrefixes.join(', '),
    excludedLookbackYears: String(c.excludedLookbackYears),
    referEndorsementPrefixes: c.referEndorsementPrefixes.join(', '),
    maxFaultAccidents3yEligible: String(c.maxFaultAccidents3yEligible),
    maxFaultAccidents3yRefer: String(c.maxFaultAccidents3yRefer),
    disqualificationLookbackYears: String(c.disqualificationLookbackYears),
    requireDvlaCheckWithinDays: String(c.requireDvlaCheckWithinDays),
    youngDriverExcessPounds: c.youngDriverExcessPence === null ? '' : (c.youngDriverExcessPence / 100).toFixed(2),
    licenceCountriesEligible: [...c.licenceCountriesEligible],
    licenceCountriesRefer: [...c.licenceCountriesRefer],
    unspentConvictionsRefer: c.unspentConvictionsRefer,
  };
}

const codes = (s: string): string[] =>
  Array.from(
    new Set(
      s
        .split(/[\s,;]+/)
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean),
    ),
  );

/** The criteria, or the problems with the form (plain English). */
export function fromForm(f: CriteriaForm): { criteria?: DriverCriteria; problems: string[] } {
  const problems: string[] = [];
  const num = (key: keyof CriteriaForm, label: string, int = true): number => {
    const raw = String(f[key]).trim();
    const v = Number(raw);
    if (!raw || !Number.isFinite(v) || v < 0 || (int && !Number.isInteger(v))) {
      problems.push(`${label} must be a ${int ? 'whole ' : ''}number`);
      return 0;
    }
    return v;
  };
  const c: DriverCriteria = {
    minAge: num('minAge', 'Minimum age'),
    referBelowAge: num('referBelowAge', 'Refer below age'),
    referAboveAge: num('referAboveAge', 'Refer above age'),
    maxAge: num('maxAge', 'Maximum age'),
    minYearsFullLicence: num('minYearsFullLicence', 'Minimum years with a full licence', false),
    referBelowYearsFullLicence: num('referBelowYearsFullLicence', 'Refer below years with a full licence', false),
    maxPointsEligible: num('maxPointsEligible', 'Points (eligible up to)'),
    maxPointsRefer: num('maxPointsRefer', 'Points (refer up to)'),
    excludedEndorsementPrefixes: codes(f.excludedEndorsementPrefixes),
    excludedLookbackYears: num('excludedLookbackYears', 'Endorsement look-back years'),
    referEndorsementPrefixes: codes(f.referEndorsementPrefixes),
    maxFaultAccidents3yEligible: num('maxFaultAccidents3yEligible', 'Fault accidents (eligible up to)'),
    maxFaultAccidents3yRefer: num('maxFaultAccidents3yRefer', 'Fault accidents (refer up to)'),
    disqualificationLookbackYears: num('disqualificationLookbackYears', 'Disqualification look-back years'),
    licenceCountriesEligible: f.licenceCountriesEligible,
    licenceCountriesRefer: f.licenceCountriesRefer.filter((x) => !f.licenceCountriesEligible.includes(x)),
    provisionalAllowed: false,
    requireDvlaCheckWithinDays: num('requireDvlaCheckWithinDays', 'DVLA check within (days)'),
    unspentConvictionsRefer: f.unspentConvictionsRefer,
    youngDriverExcessPence: f.youngDriverExcessPounds.trim() === '' ? null : Math.round(Number(f.youngDriverExcessPounds) * 100),
  };
  if (c.youngDriverExcessPence !== null && !(Number.isFinite(c.youngDriverExcessPence) && c.youngDriverExcessPence >= 0)) problems.push('Young-driver excess must be an amount in pounds');
  if (!problems.length) {
    if (!(c.minAge <= c.referBelowAge && c.referBelowAge <= c.referAboveAge && c.referAboveAge <= c.maxAge)) problems.push('Ages must go: minimum ≤ refer below ≤ refer above ≤ maximum');
    if (c.minYearsFullLicence > c.referBelowYearsFullLicence) problems.push('Minimum licence years cannot be above the refer-below years');
    if (c.maxPointsEligible > c.maxPointsRefer) problems.push('Eligible points cannot be above the refer limit');
    if (c.maxFaultAccidents3yEligible > c.maxFaultAccidents3yRefer) problems.push('Eligible fault accidents cannot be above the refer limit');
    if (c.requireDvlaCheckWithinDays < 1) problems.push('The DVLA check must be within at least 1 day');
    if (c.licenceCountriesEligible.length === 0) problems.push('Choose at least one licence country that is eligible');
  }
  return problems.length ? { problems } : { criteria: c, problems };
}

/** One-line summary of criteria (shown per policy). */
export function summarise(c: DriverCriteria): string {
  return `Ages ${c.referBelowAge}–${c.referAboveAge} (refer ${c.minAge}–${c.referBelowAge - 1} and ${c.referAboveAge + 1}–${c.maxAge}); full licence ${c.referBelowYearsFullLicence}+ years; up to ${c.maxPointsEligible} points (refer to ${c.maxPointsRefer}); DVLA check within ${c.requireDvlaCheckWithinDays} days`;
}

export const BUILT_IN = DEFAULT_DRIVER_CRITERIA;
