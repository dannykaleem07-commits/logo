/**
 * Per-mile factor (BLUEPRINT §4.4 step 3).
 *
 * Ordinary least squares of advertised price (pence) on mileage across the comparables themselves.
 * The regression is used only when it is credible: at least 4 adverts, a negative slope (price
 * falls as mileage rises) and R² of at least 0.2. Otherwise a fallback band by price is used and
 * flagged as an ASSUMPTION so the reasoning paragraph says so:
 *
 *   under £5,000          5p per mile
 *   £5,000 to £15,000     7.5p per mile
 *   over £15,000          10p per mile
 *
 * The band is chosen on the median advertised price of the usable comparables (£5,000 and £15,000
 * themselves fall in the middle band). The blueprint gives the £0.05–£0.10 range; the three-step
 * split is CCGUK's own convention, not an industry figure.
 */
import type { Comparable, Pence } from '../types.js';
import { formatGBP } from '../money.js';
import { median } from './stats.js';

export interface PerMileResult {
  /** Pence lost per additional mile (positive number). */
  perMilePence: number;
  /** Coefficient of determination of the OLS fit (0 when the fit could not be computed). */
  r2: number;
  /** Number of comparables that fed the regression. */
  n: number;
  source: 'regression' | 'fallback_band';
  /** Raw OLS slope in pence per mile (negative when price falls with mileage). */
  slopePencePerMile?: number;
  /** Raw OLS intercept in pence. */
  interceptPence?: Pence;
  /** Fallback band label, when used. */
  bandLabel?: string;
  /** True when the per-mile factor is an assumption (fallback band) rather than derived from the data. */
  assumption: boolean;
  note: string;
}

export interface RegressionOptions {
  /** Minimum comparables before the regression can be trusted. Default 4. */
  minN?: number;
  /** Minimum R² before the regression can be trusted. Default 0.2. */
  minR2?: number;
}

export interface FallbackBand {
  label: string;
  /** Inclusive lower bound of advertised price for this band (pence). */
  fromPence: Pence;
  /** Exclusive upper bound (pence); undefined = open-ended. */
  toPence?: Pence;
  perMilePence: number;
}

export const FALLBACK_PER_MILE_BANDS: readonly FallbackBand[] = [
  { label: 'under £5,000', fromPence: 0, toPence: 500_000, perMilePence: 5 },
  { label: '£5,000 to £15,000', fromPence: 500_000, toPence: 1_500_001, perMilePence: 7.5 },
  { label: 'over £15,000', fromPence: 1_500_001, perMilePence: 10 },
];

export const FALLBACK_BAND_NOTE =
  'Fallback per-mile band (5p / 7.5p / 10p per mile by price band) is a CCGUK assumption within the £0.05–£0.10 per mile range in the blueprint, not a published industry figure.';

/** Pick the fallback band for a reference (median) advertised price. */
export function fallbackPerMile(referencePricePence: Pence): FallbackBand {
  for (const band of FALLBACK_PER_MILE_BANDS) {
    if (referencePricePence >= band.fromPence && (band.toPence === undefined || referencePricePence < band.toPence)) return band;
  }
  return FALLBACK_PER_MILE_BANDS[1]!;
}

/** Comparables with a usable advertised price (not POA, positive, not already excluded). */
export function usableForRegression(comps: Comparable[]): Comparable[] {
  return comps.filter((c) => !c.excluded && !c.priceOnApplication && c.pricePence > 0 && Number.isFinite(c.mileage));
}

export interface OlsFit {
  n: number;
  slope: number;
  intercept: number;
  r2: number;
}

/** Plain OLS of y on x. Returns null when fewer than 2 points or x has no spread. */
export function ols(points: Array<{ x: number; y: number }>): OlsFit | null {
  const n = points.length;
  if (n < 2) return null;
  const meanX = points.reduce((a, p) => a + p.x, 0) / n;
  const meanY = points.reduce((a, p) => a + p.y, 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { n, slope, intercept, r2 };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function regressPerMile(comps: Comparable[], options: RegressionOptions = {}): PerMileResult {
  const minN = options.minN ?? 4;
  const minR2 = options.minR2 ?? 0.2;
  const usable = usableForRegression(comps);
  const fit = ols(usable.map((c) => ({ x: c.mileage, y: c.pricePence })));

  if (fit && fit.n >= minN && fit.slope < 0 && fit.r2 >= minR2) {
    const perMile = round2(-fit.slope);
    return {
      perMilePence: perMile,
      r2: round2(fit.r2 * 100) / 100,
      n: fit.n,
      source: 'regression',
      slopePencePerMile: round2(fit.slope),
      interceptPence: Math.round(fit.intercept),
      assumption: false,
      note: `Per-mile factor ${perMile}p per mile from the comparables' own price-to-mileage regression (n=${fit.n}, R²=${fit.r2.toFixed(2)}).`,
    };
  }

  const reference = usable.length > 0 ? median(usable.map((c) => c.pricePence)) : undefined;
  const band = reference === undefined ? FALLBACK_PER_MILE_BANDS[1]! : fallbackPerMile(reference);
  let why: string;
  if (!fit) why = `regression not possible (${usable.length} usable advert(s))`;
  else if (fit.n < minN) why = `only ${fit.n} usable advert(s), fewer than the ${minN} needed`;
  else if (fit.slope >= 0) why = `the fitted slope was not negative (${round2(fit.slope)}p per mile)`;
  else why = `R² ${fit.r2.toFixed(2)} is below the ${minR2} threshold`;
  const refText = reference === undefined ? 'no advertised prices' : `median advertised price ${formatGBP(Math.round(reference))}`;
  return {
    perMilePence: band.perMilePence,
    r2: fit ? round2(fit.r2 * 100) / 100 : 0,
    n: fit ? fit.n : usable.length,
    source: 'fallback_band',
    slopePencePerMile: fit ? round2(fit.slope) : undefined,
    interceptPence: fit ? Math.round(fit.intercept) : undefined,
    bandLabel: band.label,
    assumption: true,
    note: `Per-mile factor ${band.perMilePence}p per mile from the fallback band for vehicles ${band.label} (${refText}), used because ${why}. This is an assumption, not a figure derived from the adverts.`,
  };
}
