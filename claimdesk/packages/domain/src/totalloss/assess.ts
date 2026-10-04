/**
 * Total-loss economics (BLUEPRINT §4.7).
 *
 * Insurers compare repair cost plus hire with PAV less salvage. The System models the repair route
 * (repair + projected hire + storage during repair) against the total-loss route (PAV − salvage +
 * hire until the total-loss payment). The DECISION uses the classic insurer test — repair route cost
 * against PAV − salvage — with 'borderline' when the two are within 10% of PAV − salvage. Both
 * routes are explained in plain English in `notes` so the figure can go straight into a letter.
 *
 * Projected hire days: repair working days are converted to calendar days (× 7/5, rounded up) and
 * two handover days are added (delivery and collection). Salvage is always an actual bid, offer or
 * stated estimate — never a fixed percentage of PAV.
 */
import type { Pence, SalvageCategory, TotalLossAssessment } from '../types.js';
import { formatGBP } from '../money.js';

export const DEFAULT_DAYS_TO_TL_PAYMENT = 21;
export const DEFAULT_HANDOVER_DAYS = 2;
export const DEFAULT_BORDERLINE_PCT = 10;
export const WORKING_TO_CALENDAR_FACTOR = 7 / 5;

export interface TotalLossInput {
  repairNetPence: Pence;
  repairWorkingDays: number;
  hireDailyRatePence: Pence;
  /** Storage rate per day while the vehicle is held through the repair period. Default 0. */
  storageDailyRatePence?: Pence;
  /** Days from now until the total-loss payment is expected to land. Default 21. */
  daysToTlPaymentEstimate?: number;
  pavPence: Pence;
  salvage: { pence: Pence; source: 'bid' | 'offer' | 'estimate'; category?: SalvageCategory };
  /** Delivery and collection days added to the hire projection. Default 2. */
  handoverDays?: number;
  /** Borderline band either side of PAV − salvage, percent. Default 10. */
  borderlinePct?: number;
}

export interface TotalLossAssessmentResult extends TotalLossAssessment {
  /** PAV − salvage: the figure the repair route is tested against. */
  netPavPence: Pence;
  repairCalendarDays: number;
  handoverDays: number;
  daysToTlPayment: number;
  /** Hire until the total-loss payment, included in the total-loss route cost. */
  hireToPaymentPence: Pence;
  borderlinePct: number;
  /** Margin as a percentage of PAV − salvage (positive favours repair). */
  marginPct: number | null;
}

function requireNonNegative(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative finite number (got ${value})`);
}

/**
 * Working days → calendar days at 7/5, rounded up. Multiply before dividing so integer inputs stay
 * exact (`wd * 1.4` is a binary approximation; `(wd * 7) / 5` is exact for every integer wd).
 */
export function workingDaysToCalendarDays(workingDays: number): number {
  return Math.ceil((workingDays * 7) / 5);
}

export function projectedHireDays(repairWorkingDays: number, handoverDays = DEFAULT_HANDOVER_DAYS): number {
  return workingDaysToCalendarDays(repairWorkingDays) + handoverDays;
}

const salvageSourceText: Record<TotalLossInput['salvage']['source'], string> = {
  bid: 'an actual salvage bid',
  offer: 'an actual salvage offer',
  estimate: 'a stated salvage estimate',
};

export function assessTotalLoss(input: TotalLossInput): TotalLossAssessmentResult {
  requireNonNegative('repairNetPence', input.repairNetPence);
  requireNonNegative('repairWorkingDays', input.repairWorkingDays);
  requireNonNegative('hireDailyRatePence', input.hireDailyRatePence);
  requireNonNegative('storageDailyRatePence', input.storageDailyRatePence);
  requireNonNegative('daysToTlPaymentEstimate', input.daysToTlPaymentEstimate);
  requireNonNegative('pavPence', input.pavPence);
  requireNonNegative('salvage.pence', input.salvage.pence);
  requireNonNegative('handoverDays', input.handoverDays);
  requireNonNegative('borderlinePct', input.borderlinePct);

  const handoverDays = input.handoverDays ?? DEFAULT_HANDOVER_DAYS;
  const borderlinePct = input.borderlinePct ?? DEFAULT_BORDERLINE_PCT;
  const storageRate = input.storageDailyRatePence ?? 0;
  const daysToTlPayment = input.daysToTlPaymentEstimate ?? DEFAULT_DAYS_TO_TL_PAYMENT;

  const repairCalendarDays = workingDaysToCalendarDays(input.repairWorkingDays);
  const hireDays = repairCalendarDays + handoverDays;
  const projectedHirePence = hireDays * input.hireDailyRatePence;
  const projectedStoragePence = repairCalendarDays * storageRate;
  const repairRouteCostPence = input.repairNetPence + projectedHirePence + projectedStoragePence;

  const netPavPence = input.pavPence - input.salvage.pence;
  const hireToPaymentPence = daysToTlPayment * input.hireDailyRatePence;
  const totalLossRouteCostPence = netPavPence + hireToPaymentPence;

  const marginPence = netPavPence - repairRouteCostPence;
  const marginPct = netPavPence > 0 ? Math.round((marginPence / netPavPence) * 10000) / 100 : null;

  // Cat A (scrap) and Cat B (break) vehicles can never return to the road under the ABI Code, so an
  // Appropriately Qualified Person's A/B categorisation settles the decision whatever the arithmetic
  // says; the arithmetic is still reported so the letter can show both routes.
  const unrepairableCategory = input.salvage.category === 'A' || input.salvage.category === 'B';

  let arithmeticDecision: TotalLossAssessment['decision'];
  if (netPavPence <= 0) arithmeticDecision = 'total_loss';
  else if (Math.abs(marginPence) <= (netPavPence * borderlinePct) / 100) arithmeticDecision = 'borderline';
  else arithmeticDecision = marginPence < 0 ? 'total_loss' : 'repair';
  const decision: TotalLossAssessment['decision'] = unrepairableCategory ? 'total_loss' : arithmeticDecision;

  const notes: string[] = [];
  notes.push(
    `Repair route: repair ${formatGBP(input.repairNetPence)} net, plus projected hire of ${hireDays} days (${input.repairWorkingDays} working days of repair = ${repairCalendarDays} calendar days, plus ${handoverDays} handover days) at ${formatGBP(input.hireDailyRatePence)} per day = ${formatGBP(projectedHirePence)}` +
      (storageRate > 0 ? `, plus storage of ${repairCalendarDays} days at ${formatGBP(storageRate)} per day = ${formatGBP(projectedStoragePence)}` : ', with no storage charged') +
      `. Repair route total ${formatGBP(repairRouteCostPence)}.`,
  );
  notes.push(
    `Total-loss route: PAV ${formatGBP(input.pavPence)} less salvage ${formatGBP(input.salvage.pence)} (${salvageSourceText[input.salvage.source]}${input.salvage.category ? `, Cat ${input.salvage.category}` : ''}) = ${formatGBP(netPavPence)}, plus hire until the total-loss payment, estimated at ${daysToTlPayment} days at ${formatGBP(input.hireDailyRatePence)} per day = ${formatGBP(hireToPaymentPence)}. Total-loss route total ${formatGBP(totalLossRouteCostPence)}.`,
  );
  const decisionText: Record<TotalLossAssessment['decision'], string> = { repair: 'repair', total_loss: 'total loss', borderline: 'borderline' };
  const arithmeticLine =
    netPavPence <= 0
      ? `Classic insurer test: PAV less salvage is ${formatGBP(netPavPence)}, so any repair spend exceeds it.`
      : `Classic insurer test: repair plus hire plus storage ${formatGBP(repairRouteCostPence)} against PAV less salvage ${formatGBP(netPavPence)}. ` +
        (marginPence >= 0
          ? `The repair route is ${formatGBP(marginPence)} (${marginPct}%) cheaper.`
          : `The repair route is ${formatGBP(-marginPence)} (${Math.abs(marginPct ?? 0)}%) dearer.`) +
        (arithmeticDecision === 'borderline'
          ? ` This is within ${borderlinePct}% of PAV less salvage, so the ${unrepairableCategory ? 'arithmetic alone' : 'decision'} is borderline: a change in the hire period, the salvage figure or the parts price could flip it.`
          : '');
  const decisionLine = unrepairableCategory
    ? ` Decision: total loss — the salvage is categorised Cat ${input.salvage.category} (${input.salvage.category === 'A' ? 'scrap' : 'break for parts'}) under the ABI Code and cannot return to the road, so the categorisation decides it, not the arithmetic (which on its own reads ${decisionText[arithmeticDecision]}).`
    : ` Decision: ${decisionText[decision]}.`;
  notes.push(arithmeticLine + decisionLine);
  notes.push(
    `Comparing the two full routes, ${
      repairRouteCostPence <= totalLossRouteCostPence
        ? `repair (${formatGBP(repairRouteCostPence)}) costs less than total loss including hire to payment (${formatGBP(totalLossRouteCostPence)}) by ${formatGBP(totalLossRouteCostPence - repairRouteCostPence)}.`
        : `total loss including hire to payment (${formatGBP(totalLossRouteCostPence)}) costs less than repair (${formatGBP(repairRouteCostPence)}) by ${formatGBP(repairRouteCostPence - totalLossRouteCostPence)}.`
    }`,
  );
  // Do not attribute the "values vary" observation to the ABI Code: the Code governs categorisation,
  // not salvage values. The rule to use actual bids is CCGUK's own (BLUEPRINT §4.7).
  notes.push(`The salvage figure is ${salvageSourceText[input.salvage.source]}; no fixed salvage percentage has been applied, because salvage values vary by category and age and only an actual bid or offer evidences the figure.`);
  if (input.salvage.source === 'estimate') {
    notes.push('Salvage is an estimate only. Obtain actual bids (e.g. Copart, SYNETIQ, e2e) or a written offer before the figure is asserted to the insurer.');
  }
  if (unrepairableCategory) {
    notes.push(`Cat ${input.salvage.category} salvage cannot return to the road; the vehicle is a total loss regardless of the arithmetic.`);
  }

  return {
    repairNetPence: input.repairNetPence,
    projectedRepairWorkingDays: input.repairWorkingDays,
    projectedHireDays: hireDays,
    hireDailyRatePence: input.hireDailyRatePence,
    projectedHirePence,
    projectedStoragePence,
    pavPence: input.pavPence,
    salvagePence: input.salvage.pence,
    salvageSource: input.salvage.source,
    salvageCategory: input.salvage.category,
    repairRouteCostPence,
    totalLossRouteCostPence,
    decision,
    marginPence,
    notes,
    netPavPence,
    repairCalendarDays,
    handoverDays,
    daysToTlPayment,
    hireToPaymentPence,
    borderlinePct,
    marginPct,
  };
}
