/**
 * Interest on a sum due (BLUEPRINT §5.2 "Interest"; money.md §3 "Interest — claim it, it is free money").
 *
 * Simple (not compound) daily interest: principal × annual rate × days / 365, rounded half-up to the penny.
 * Each basis carries a note that must travel with the figure into any letter, because none of these
 * rates is an entitlement that can be asserted without qualification:
 *  - cca_s69   County Courts Act 1984 s.69 — rate is in the court's discretion; 8% is the conventional
 *              claim, not a fixed statutory rate.
 *  - sca_s35a  Senior Courts Act 1981 s.35A — same discretion, High Court.
 *  - icobs_8_2 ICOBS 8.2.9R–8.2.11R — Bank of England base rate + 4% from the date the three-month
 *              ICOBS 8.2.6R period expired. Territorial scope (ICOBS 8.2.1R) is to be confirmed
 *              before this is asserted as of right in a purely domestic claim (BLUEPRINT §10).
 *  - lpcdia_1998 Late Payment of Commercial Debts (Interest) Act 1998 — base + 8%, business-to-business
 *              debts only (supplier invoices, fleet clients); never against an insurer on a consumer's claim.
 *
 * Pure: `from`/`to` are ISO dates passed in; nothing reads the clock.
 */
import type { ISODate, ISODateTime, Pence } from '../types.js';
import { calendarDaysBetween } from '../calendar/index.js';

export type InterestBasis = 'cca_s69' | 'sca_s35a' | 'icobs_8_2' | 'lpcdia_1998';

export interface InterestOptions {
  principalPence: Pence;
  from: ISODate | ISODateTime;
  to: ISODate | ISODateTime;
  basis: InterestBasis;
  /** Explicit annual rate (%). For cca_s69/sca_s35a this overrides the 8% convention. */
  annualRatePct?: number;
  /** Bank of England base rate (%), required for icobs_8_2 and lpcdia_1998 unless annualRatePct is given. */
  baseRatePct?: number;
}

export interface InterestResult {
  interestPence: Pence;
  days: number;
  annualRatePct: number;
  /** Interest accruing per day at this rate on this principal (for "continuing at £x per day" wording). */
  dailyPence: Pence;
  basis: InterestBasis;
  citation: string;
  note: string;
}

export const DEFAULT_COURT_RATE_PCT = 8;
export const ICOBS_UPLIFT_PCT = 4;
export const LPCDIA_UPLIFT_PCT = 8;

export const interestCitations: Record<InterestBasis, string> = {
  cca_s69: 'County Courts Act 1984 s.69',
  sca_s35a: 'Senior Courts Act 1981 s.35A',
  icobs_8_2: 'ICOBS 8.2.9R–8.2.11R (base rate + 4% from expiry of the ICOBS 8.2.6R three-month period)',
  lpcdia_1998: 'Late Payment of Commercial Debts (Interest) Act 1998 (base rate + 8%)',
};

function resolveRate(opts: InterestOptions): { rate: number; note: string } {
  switch (opts.basis) {
    case 'cca_s69':
    case 'sca_s35a': {
      const rate = opts.annualRatePct ?? DEFAULT_COURT_RATE_PCT;
      const which = opts.basis === 'cca_s69' ? 'County Courts Act 1984 s.69' : 'Senior Courts Act 1981 s.35A';
      return {
        rate,
        note:
          `Simple interest claimed at ${rate}% a year under ${which}. The rate and period are in the court's discretion; ` +
          `${rate === DEFAULT_COURT_RATE_PCT ? '8% is the conventional claim, not a fixed statutory rate' : 'a non-standard rate must be justified'}. ` +
          'Litigation documents are drafts for the claimant (litigant in person) or an instructed solicitor.',
      };
    }
    case 'icobs_8_2': {
      if (opts.annualRatePct === undefined && opts.baseRatePct === undefined) {
        throw new Error('interest: icobs_8_2 needs baseRatePct (Bank of England base rate) or an explicit annualRatePct');
      }
      const rate = opts.annualRatePct ?? opts.baseRatePct! + ICOBS_UPLIFT_PCT;
      return {
        rate,
        note:
          `Interest at Bank of England base rate${opts.baseRatePct !== undefined ? ` (${opts.baseRatePct}%)` : ''} + ${ICOBS_UPLIFT_PCT}% = ${rate}% a year ` +
          'under ICOBS 8.2.9R–8.2.11R, running from the date the three-month period in ICOBS 8.2.6R expired (pass that date as `from`). ' +
          'Territorial scope: ICOBS 8.2.1R is to be confirmed before this is asserted as of right in a purely domestic claim (BLUEPRINT §10). ' +
          'Confirm the base rate on the day of calculation.',
      };
    }
    case 'lpcdia_1998': {
      if (opts.annualRatePct === undefined && opts.baseRatePct === undefined) {
        throw new Error('interest: lpcdia_1998 needs baseRatePct (Bank of England base rate) or an explicit annualRatePct');
      }
      const rate = opts.annualRatePct ?? opts.baseRatePct! + LPCDIA_UPLIFT_PCT;
      return {
        rate,
        note:
          `Statutory interest at base rate${opts.baseRatePct !== undefined ? ` (${opts.baseRatePct}%)` : ''} + ${LPCDIA_UPLIFT_PCT}% = ${rate}% a year ` +
          'under the Late Payment of Commercial Debts (Interest) Act 1998. Business-to-business debts only (supplier invoices, fleet clients): ' +
          'not available against an at-fault insurer on a consumer claimant’s damages claim. Fixed-sum compensation (£40/£70/£100 per invoice) is additional.',
      };
    }
  }
}

/** Simple daily interest, rounded half-up to the penny. `to` before `from` gives 0 days and £0. */
export function interest(opts: InterestOptions): InterestResult {
  if (!Number.isInteger(opts.principalPence)) throw new Error('interest: principalPence must be integer pence');
  const { rate, note } = resolveRate(opts);
  if (rate < 0) throw new Error('interest: annual rate cannot be negative');
  const days = Math.max(0, calendarDaysBetween(opts.from, opts.to));
  const interestPence = Math.round((opts.principalPence * rate * days) / 100 / 365);
  const dailyPence = Math.round((opts.principalPence * rate) / 100 / 365);
  return { interestPence, days, annualRatePct: rate, dailyPence, basis: opts.basis, citation: interestCitations[opts.basis], note };
}
