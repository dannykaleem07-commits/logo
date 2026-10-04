/**
 * Part 36 helper (BLUEPRINT §7.6 "Part 36 offer at issue"; CPR 36.5(1)(c): a Part 36 offer must specify a
 * relevant period of not less than 21 days). The offer is made when served (CPR 36.7(2)); the relevant
 * period is counted in calendar days from service and expires at the end of the last day.
 *
 * Perimeter: the offer is a litigation document — a draft for the claimant (litigant in person) or an
 * instructed solicitor to sign and serve. CCGUK does not conduct the litigation (LSA 2007 s.12).
 */
import type { ISODateTime, Pence } from '../types.js';
import { addCalendarDays, endOfDay } from '../calendar/index.js';
import { formatGBP } from '../money.js';

export const PART36_MINIMUM_RELEVANT_PERIOD_DAYS = 21;

export interface Part36Options {
  offerPence: Pence;
  /** When the offer is (or will be) served. */
  madeAt: ISODateTime;
  /** Relevant period in days; anything under 21 is lifted to 21 (CPR 36.5(1)(c)). */
  relevantPeriodDays?: number;
  /** Who makes the offer: the claimant (our side, default) or the defendant. Changes the consequences text. */
  by?: 'claimant' | 'defendant';
}

export interface Part36Result {
  offerPence: Pence;
  madeAt: ISODateTime;
  relevantPeriodDays: number;
  /** End of the last day of the relevant period, London time. */
  expiresAt: ISODateTime;
  basis: string[];
  note: string;
}

export function part36(opts: Part36Options): Part36Result {
  const requested = opts.relevantPeriodDays ?? PART36_MINIMUM_RELEVANT_PERIOD_DAYS;
  if (!Number.isInteger(requested)) throw new Error('part36: relevantPeriodDays must be an integer');
  const relevantPeriodDays = Math.max(PART36_MINIMUM_RELEVANT_PERIOD_DAYS, requested);
  const expiresAt = endOfDay(addCalendarDays(opts.madeAt, relevantPeriodDays));
  const by = opts.by ?? 'claimant';
  const consequences =
    by === 'claimant'
      ? 'If the claimant obtains a judgment at least as advantageous as this offer, CPR 36.17(4) applies: interest on the sum at up to 10% above base rate, costs on the indemnity basis from expiry, interest on those costs and an additional amount of 10% of the first £500,000 awarded and 5% of any amount above that, capped at £75,000 (CPR 36.17(4)(d)).'
      : 'If the claimant fails to beat this offer at trial, CPR 36.17(3) applies: the claimant pays the defendant’s costs from expiry of the relevant period with interest. Decide on the walk-away number before responding (money.md §4).';
  const lifted = requested < PART36_MINIMUM_RELEVANT_PERIOD_DAYS ? ` The requested ${requested}-day period was lifted to the 21-day minimum (CPR 36.5(1)(c)).` : '';
  const note =
    `Part 36 offer of ${formatGBP(opts.offerPence)} made by the ${by} on service at ${opts.madeAt}; relevant period ${relevantPeriodDays} days expiring ${expiresAt}.${lifted} ` +
    'The offer is made when served (CPR 36.7(2)) and may be accepted after the relevant period unless withdrawn (CPR 36.11), but the costs consequences run from expiry. ' +
    `${consequences} ` +
    'Draft for the claimant as litigant in person or an instructed solicitor to sign and serve; CCGUK does not conduct the litigation (Legal Services Act 2007 s.12).';
  return {
    offerPence: opts.offerPence,
    madeAt: opts.madeAt,
    relevantPeriodDays,
    expiresAt,
    basis: ['CPR 36.5(1)(c)', 'CPR 36.7(2)', 'CPR 36.11', by === 'claimant' ? 'CPR 36.17(4)' : 'CPR 36.17(3)', 'Legal Services Act 2007 s.12'],
    note,
  };
}
