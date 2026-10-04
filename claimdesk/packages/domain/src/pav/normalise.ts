/**
 * Normalisation and exclusions (BLUEPRINT §4.4 steps 3–4).
 *
 * normalised price = advertised price
 *                  + (advert mileage − subject mileage) × per-mile factor
 *                  + options adjustment
 * then × (1 + condition adjustment %), where the condition adjustment is the engineer's call on the
 * SUBJECT (−10% to +10%): a subject in better-than-average condition is worth more than the
 * adverts, so the normalised prices move up.
 *
 * Exclusions after normalisation: price on application; previous write-off category (unless the
 * subject itself has one); ex-fleet unless the subject is ex-fleet; and anything more than
 * 1.5 × IQR away from the median of the normalised prices (Tukey quartiles, see stats.ts).
 */
import type { Comparable, Pence, PavSubject } from '../types.js';
import { formatGBP } from '../money.js';
import { describeComparable } from './filter.js';
import { formatMiles, quartiles, roundPence, type QuartileStats } from './stats.js';

export const CONDITION_ADJUSTMENT_LIMIT_PCT = 10;

export interface NormalisationBreakdown {
  id: string;
  pricePence: Pence;
  mileageDifference: number;
  perMilePence: number;
  mileageAdjustmentPence: Pence;
  optionsAdjustmentPence: Pence;
  conditionAdjustmentPct: number;
  conditionAdjustmentPence: Pence;
  normalisedPricePence: Pence;
}

export function clampConditionPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(-CONDITION_ADJUSTMENT_LIMIT_PCT, Math.min(CONDITION_ADJUSTMENT_LIMIT_PCT, pct));
}

/** The arithmetic for one advert, every step shown. Null when the advert has no usable price. */
export function normalisationBreakdown(subject: PavSubject, comp: Comparable, perMilePence: number): NormalisationBreakdown | null {
  if (comp.priceOnApplication || !(comp.pricePence > 0)) return null;
  const mileageDifference = comp.mileage - subject.odometerAtLoss;
  const mileageAdjustmentPence = roundPence(mileageDifference * perMilePence);
  const optionsAdjustmentPence = comp.optionsAdjustmentPence ?? 0;
  const base = comp.pricePence + mileageAdjustmentPence + optionsAdjustmentPence;
  const conditionAdjustmentPct = clampConditionPct(subject.conditionAdjustmentPct);
  const conditionAdjustmentPence = roundPence((base * conditionAdjustmentPct) / 100);
  return {
    id: comp.id,
    pricePence: comp.pricePence,
    mileageDifference,
    perMilePence,
    mileageAdjustmentPence,
    optionsAdjustmentPence,
    conditionAdjustmentPct,
    conditionAdjustmentPence,
    normalisedPricePence: base + conditionAdjustmentPence,
  };
}

export function describeBreakdown(b: NormalisationBreakdown): string {
  const sign = (v: number): string => (v < 0 ? '−' : '+');
  return (
    `${b.id}: ${formatGBP(b.pricePence)} ${sign(b.mileageAdjustmentPence)} ${formatGBP(Math.abs(b.mileageAdjustmentPence))} ` +
    `(${b.mileageDifference >= 0 ? '+' : '−'}${formatMiles(Math.abs(b.mileageDifference))} × ${b.perMilePence}p) ` +
    `${sign(b.optionsAdjustmentPence)} ${formatGBP(Math.abs(b.optionsAdjustmentPence))} options ` +
    `${sign(b.conditionAdjustmentPence)} ${formatGBP(Math.abs(b.conditionAdjustmentPence))} condition (${b.conditionAdjustmentPct >= 0 ? '+' : ''}${b.conditionAdjustmentPct}%) ` +
    `= ${formatGBP(b.normalisedPricePence)}`
  );
}

/** Copies of the comparables with `normalisedPricePence` set (left undefined for POA / unpriced adverts). */
export function normaliseComparables(subject: PavSubject, comps: Comparable[], perMilePence: number): Comparable[] {
  return comps.map((comp) => {
    const b = normalisationBreakdown(subject, comp, perMilePence);
    const copy: Comparable = { ...comp };
    if (b) copy.normalisedPricePence = b.normalisedPricePence;
    else delete copy.normalisedPricePence;
    return copy;
  });
}

export type HardExclusionSubject = Pick<PavSubject, 'exFleet' | 'previousWriteOffCategory'>;

/**
 * Reason an advert must go regardless of price: POA, previous write-off (unless the subject has
 * one), ex-fleet (unless the subject is ex-fleet). Null when none applies.
 */
export function hardExclusionReason(comp: Comparable, subject: HardExclusionSubject = {}): string | null {
  if (comp.priceOnApplication || !(comp.pricePence > 0)) return 'price on application — no advertised price to compare';
  if (comp.writeOffCategory && !subject.previousWriteOffCategory) {
    return `previous write-off (Cat ${comp.writeOffCategory}) — the subject has no write-off history`;
  }
  if (comp.exFleet && !subject.exFleet) return 'ex-fleet vehicle — the subject is not ex-fleet';
  return null;
}

export interface OutlierOptions {
  /** Multiplier of the IQR either side of the median. Default 1.5. */
  iqrMultiplier?: number;
}

export interface OutlierResult {
  comps: Comparable[];
  /** Quartile statistics of the normalised prices the outlier test was run on (null when none). */
  stats: QuartileStats | null;
  lowerBoundPence?: Pence;
  upperBoundPence?: Pence;
  audit: string[];
}

export function excludeOutliers(comps: Comparable[], subject: HardExclusionSubject = {}, options: OutlierOptions = {}): OutlierResult {
  const k = options.iqrMultiplier ?? 1.5;
  const audit: string[] = [];
  const out: Comparable[] = comps.map((c) => ({ ...c }));

  for (const comp of out) {
    if (comp.excluded && comp.exclusionReason) continue; // already out upstream
    const reason = hardExclusionReason(comp, subject);
    if (reason) {
      comp.excluded = true;
      comp.exclusionReason = reason;
      audit.push(`Excluded ${comp.id} (${describeComparable(comp)}): ${reason}.`);
    } else if (comp.writeOffCategory && subject.previousWriteOffCategory) {
      audit.push(`Kept ${comp.id} despite Cat ${comp.writeOffCategory}: the subject is itself Cat ${subject.previousWriteOffCategory}.`);
    } else if (comp.exFleet && subject.exFleet) {
      audit.push(`Kept ${comp.id} although ex-fleet: the subject is ex-fleet.`);
    }
  }

  const candidates = out.filter((c) => !c.excluded);
  for (const comp of candidates) {
    if (comp.normalisedPricePence === undefined) {
      comp.excluded = true;
      comp.exclusionReason = 'not normalised — no normalised price available';
      audit.push(`Excluded ${comp.id}: no normalised price.`);
    }
  }
  const priced = out.filter((c) => !c.excluded && c.normalisedPricePence !== undefined);
  if (priced.length === 0) {
    audit.push('Outlier test skipped: no priced comparables.');
    return { comps: out, stats: null, audit };
  }

  const stats = quartiles(priced.map((c) => c.normalisedPricePence!));
  if (stats.iqr === 0) {
    audit.push(
      `Outlier test skipped: interquartile range is zero (median ${formatGBP(roundPence(stats.median))}, n=${stats.n}); nothing excluded.`,
    );
    return { comps: out, stats, audit };
  }
  const lower = stats.median - k * stats.iqr;
  const upper = stats.median + k * stats.iqr;
  audit.push(
    `Outlier test on ${stats.n} normalised prices: median ${formatGBP(roundPence(stats.median))}, Q1 ${formatGBP(roundPence(stats.q1))}, Q3 ${formatGBP(roundPence(stats.q3))}, IQR ${formatGBP(roundPence(stats.iqr))}; keep ${formatGBP(roundPence(lower))} to ${formatGBP(roundPence(upper))} (median ±${k}×IQR).`,
  );
  for (const comp of priced) {
    const v = comp.normalisedPricePence!;
    if (v < lower || v > upper) {
      const reason = `normalised price ${formatGBP(v)} is more than ${k}×IQR from the median ${formatGBP(roundPence(stats.median))} (outside ${formatGBP(roundPence(lower))} to ${formatGBP(roundPence(upper))})`;
      comp.excluded = true;
      comp.exclusionReason = reason;
      audit.push(`Excluded ${comp.id} (${describeComparable(comp)}): ${reason}.`);
    }
  }
  return { comps: out, stats, lowerBoundPence: roundPence(lower), upperBoundPence: roundPence(upper), audit };
}
