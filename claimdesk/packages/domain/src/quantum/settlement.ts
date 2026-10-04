/**
 * money.md §4 settlement arithmetic and §1 take-the-case expected value.
 *
 *   Accept now = offer − costs incurred
 *   Fight on   = P(better) × expected better figure
 *                − additional cost of fighting
 *                − time value of delayed payment
 *                − P(worse) × downside
 *
 * Both sides of the comparison are net of costs already incurred (they are sunk either way), so the
 * two numbers can be compared directly. The walk-away number — the offer at which accepting equals
 * fighting — is computed before the negotiation opens, as the discipline requires.
 */
import type { Pence } from '../types.js';
import { formatGBP } from '../money.js';

export interface SettlementInput {
  /** The insurer's offer on the table. */
  offerPence: Pence;
  /** Costs already incurred on the file (sunk). */
  costsIncurredPence: Pence;
  /** Probability (0..1) of a better outcome if we fight on. */
  pBetter: number;
  /** The figure expected if the better outcome arrives. */
  expectedBetterPence: Pence;
  /** Additional cost of fighting (hours × loaded rate, disbursements, fees). */
  extraCostPence: Pence;
  /** Months until the fought-for money would clear. */
  delayMonths: number;
  /** Monthly discount rate applied to the delayed figure (default 1%). */
  monthlyDiscountRate?: number;
  /** Probability (0..1) of a worse outcome than the offer. */
  pWorse: number;
  /** The downside if the worse outcome arrives: the amount lost against the offer (shortfall plus any costs order). */
  worsePence: Pence;
  /**
   * Gap below which the recommendation is 'counter' rather than 'fight': fightOn must exceed acceptNow by
   * more than this fraction of the offer to recommend fighting outright (default 0.10).
   */
  counterThreshold?: number;
}

export interface SettlementResult {
  acceptNowPence: Pence;
  fightOnPence: Pence;
  /** Expected gross figure from fighting before costs and discount: P(better) × expected better. */
  fightGrossPence: Pence;
  /** Time value lost to delay: fightGross × (1 − (1 + r)^−months). */
  timeValuePence: Pence;
  /** P(worse) × downside. */
  downsidePence: Pence;
  /** The offer at which accepting now equals fighting on. Decide it before the call. */
  walkAwayPence: Pence;
  recommendation: 'accept' | 'fight' | 'counter';
  note: string;
}

function checkProbability(p: number, name: string): void {
  if (!(p >= 0 && p <= 1)) throw new Error(`${name} must be a probability between 0 and 1, got ${p}`);
}

/** Discount factor lost to delay: 1 − (1 + r)^−months. */
export function settlementDelayDiscount(delayMonths: number, monthlyDiscountRate: number): number {
  if (delayMonths <= 0) return 0;
  return 1 - Math.pow(1 + monthlyDiscountRate, -delayMonths);
}

export function settlementArithmetic(input: SettlementInput): SettlementResult {
  checkProbability(input.pBetter, 'pBetter');
  checkProbability(input.pWorse, 'pWorse');
  if (input.pBetter + input.pWorse > 1 + 1e-9) throw new Error('pBetter + pWorse cannot exceed 1');
  const r = input.monthlyDiscountRate ?? 0.01;
  const threshold = input.counterThreshold ?? 0.1;

  const acceptNowPence = input.offerPence - input.costsIncurredPence;
  const fightGrossPence = Math.round(input.pBetter * input.expectedBetterPence);
  const timeValuePence = Math.round(fightGrossPence * settlementDelayDiscount(input.delayMonths, r));
  const downsidePence = Math.round(input.pWorse * input.worsePence);
  const fightOnPence = fightGrossPence - input.extraCostPence - timeValuePence - downsidePence - input.costsIncurredPence;
  const walkAwayPence = fightOnPence + input.costsIncurredPence;

  const gap = fightOnPence - acceptNowPence;
  let recommendation: SettlementResult['recommendation'];
  if (gap <= 0) recommendation = 'accept';
  else if (gap <= Math.round(Math.abs(input.offerPence) * threshold)) recommendation = 'counter';
  else recommendation = 'fight';

  const note =
    `Accept now ${formatGBP(acceptNowPence)} (offer ${formatGBP(input.offerPence)} less ${formatGBP(input.costsIncurredPence)} costs incurred). ` +
    `Fight on ${formatGBP(fightOnPence)}: ${Math.round(input.pBetter * 100)}% × ${formatGBP(input.expectedBetterPence)} = ${formatGBP(fightGrossPence)}, ` +
    `less ${formatGBP(input.extraCostPence)} extra cost, ${formatGBP(timeValuePence)} time value (${input.delayMonths} months at ${(r * 100).toFixed(1)}%/month), ` +
    `${formatGBP(downsidePence)} downside (${Math.round(input.pWorse * 100)}% × ${formatGBP(input.worsePence)}) and the same ${formatGBP(input.costsIncurredPence)} sunk costs. ` +
    `Walk-away number ${formatGBP(walkAwayPence)}: accept any offer at or above it. ` +
    (recommendation === 'accept'
      ? 'Recommendation: accept — fighting does not beat the money on the table.'
      : recommendation === 'counter'
        ? `Recommendation: counter — the gap (${formatGBP(gap)}) is within ${Math.round(threshold * 100)}% of the offer; offer to accept the walk-away figure for cleared funds within 14 days. Never concede a head entirely to buy speed.`
        : `Recommendation: fight — fighting is worth ${formatGBP(gap)} more than accepting. Keep every head in the schedule.`);

  return { acceptNowPence, fightOnPence, fightGrossPence, timeValuePence, downsidePence, walkAwayPence, recommendation, note };
}

// ---------------------------------------------------------------------------------------------
// money.md §1 — the take-the-case decision
//
//   EV = (P(win) × recovery to client × our rate)
//      + (fixed fees charged regardless)
//      − (hours × loaded hourly cost)
//      − (disbursements at risk)
//      − (P(complaint or refund) × (refund + remedial hours × loaded hourly cost))
// ---------------------------------------------------------------------------------------------

export interface ExpectedValueInput {
  pWin: number;
  recoveryPence: Pence;
  /** Our share of the recovery (0..1), e.g. 0.25. For credit hire the "recovery" is the hire charge and ourRate is 1. */
  ourRate: number;
  fixedFeesPence: Pence;
  hours: number;
  loadedHourlyPence: Pence;
  disbursementsPence: Pence;
  pComplaint: number;
  refundPence: Pence;
  /** Remedial hours if a complaint lands (default 0). */
  remedialHours?: number;
  /** Margin (fraction of cost) below which the file is 'reprice' rather than 'take' (default 0.25). */
  thinMarginFraction?: number;
}

export interface ExpectedValueResult {
  evPence: Pence;
  components: {
    successFeePence: Pence;
    fixedFeesPence: Pence;
    labourCostPence: Pence;
    disbursementsPence: Pence;
    complaintCostPence: Pence;
  };
  recommendation: 'take' | 'reprice' | 'decline';
  note: string;
}

export function expectedValue(input: ExpectedValueInput): ExpectedValueResult {
  checkProbability(input.pWin, 'pWin');
  checkProbability(input.pComplaint, 'pComplaint');
  if (!(input.ourRate >= 0 && input.ourRate <= 1)) throw new Error('ourRate must be between 0 and 1');
  if (input.hours < 0 || input.loadedHourlyPence < 0) throw new Error('hours and loadedHourlyPence must be non-negative');
  const successFeePence = Math.round(input.pWin * input.recoveryPence * input.ourRate);
  const labourCostPence = Math.round(input.hours * input.loadedHourlyPence);
  const remedialPence = Math.round((input.remedialHours ?? 0) * input.loadedHourlyPence);
  const complaintCostPence = Math.round(input.pComplaint * (input.refundPence + remedialPence));
  const evPence = successFeePence + input.fixedFeesPence - labourCostPence - input.disbursementsPence - complaintCostPence;
  const thin = input.thinMarginFraction ?? 0.25;
  const costBase = labourCostPence + input.disbursementsPence;
  let recommendation: ExpectedValueResult['recommendation'];
  if (evPence <= 0) recommendation = 'decline';
  else if (evPence < Math.round(costBase * thin)) recommendation = 'reprice';
  else recommendation = 'take';
  const note =
    `EV ${formatGBP(evPence)} = ${Math.round(input.pWin * 100)}% × ${formatGBP(input.recoveryPence)} × ${input.ourRate} (${formatGBP(successFeePence)}) ` +
    `+ fixed fees ${formatGBP(input.fixedFeesPence)} − ${input.hours}h × ${formatGBP(input.loadedHourlyPence)} (${formatGBP(labourCostPence)}) ` +
    `− disbursements ${formatGBP(input.disbursementsPence)} − ${Math.round(input.pComplaint * 100)}% × (${formatGBP(input.refundPence)} refund + ${formatGBP(remedialPence)} remedial) (${formatGBP(complaintCostPence)}). ` +
    (recommendation === 'decline'
      ? 'Decline or refer out: the file costs more than it earns.'
      : recommendation === 'reprice'
        ? `Reprice: the margin is under ${Math.round(thin * 100)}% of cost — fixed fee up front or a staged fee before any work starts.`
        : 'Take: payment terms in writing before work begins; money up front on a new client.');
  return {
    evPence,
    components: { successFeePence, fixedFeesPence: input.fixedFeesPence, labourCostPence, disbursementsPence: input.disbursementsPence, complaintCostPence },
    recommendation,
    note,
  };
}
