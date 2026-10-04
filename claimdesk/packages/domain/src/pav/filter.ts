/**
 * Comparable filter (BLUEPRINT §4.4 step 2).
 *
 * Same make and model; year within ±1; mileage within ±25% of the subject's odometer at loss;
 * same fuel and transmission where both sides are known; within 50 miles of the claimant's
 * postcode, widened in stages (50 → 100 → 200 → no limit) until at least six adverts remain.
 *
 * Every exclusion carries a plain-English reason so the audit trail can be read out in a dispute.
 * Comparables are never mutated: the result holds copies.
 */
import type { Comparable, PavSubject } from '../types.js';
import { formatMiles } from './stats.js';

export interface FilterOptions {
  /** Years either side of the subject's year. Default 1. */
  yearTolerance?: number;
  /** Mileage tolerance either side of the subject's odometer, as a percentage. Default 25. */
  mileagePct?: number;
  /** Starting radius in miles from the claimant's postcode. Default 50. */
  radiusMiles?: number;
  /** Widening ladder in miles; `Infinity` means no distance limit. Default [50, 100, 200, Infinity]. */
  radiusSteps?: number[];
  /** Minimum comparables wanted before the radius stops widening. Default 6. */
  minCount?: number;
}

export interface ResolvedFilterOptions {
  yearTolerance: number;
  mileagePct: number;
  radiusMiles: number;
  radiusSteps: number[];
  minCount: number;
}

export interface FilterResult {
  kept: Comparable[];
  excluded: Comparable[];
  /** Radius at which the filter stopped (Infinity when no distance limit was applied). */
  radiusUsed: number;
  /** True when the radius had to widen beyond the starting radius. */
  radiusWidened: boolean;
  /** Mileage window applied, in miles. */
  mileageWindow: { low: number; high: number };
  warnings: string[];
  audit: string[];
}

export const DEFAULT_FILTER_OPTIONS: ResolvedFilterOptions = {
  yearTolerance: 1,
  mileagePct: 25,
  radiusMiles: 50,
  radiusSteps: [50, 100, 200, Infinity],
  minCount: 6,
};

export function resolveFilterOptions(opts: FilterOptions = {}): ResolvedFilterOptions {
  return {
    yearTolerance: opts.yearTolerance ?? DEFAULT_FILTER_OPTIONS.yearTolerance,
    mileagePct: opts.mileagePct ?? DEFAULT_FILTER_OPTIONS.mileagePct,
    radiusMiles: opts.radiusMiles ?? DEFAULT_FILTER_OPTIONS.radiusMiles,
    radiusSteps: opts.radiusSteps ?? DEFAULT_FILTER_OPTIONS.radiusSteps,
    minCount: opts.minCount ?? DEFAULT_FILTER_OPTIONS.minCount,
  };
}

const normText = (s: string | undefined): string => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export const describeRadius = (miles: number): string =>
  Number.isFinite(miles) ? `${miles} miles` : 'no distance limit';

export const describeComparable = (c: Comparable): string =>
  `${c.year} ${c.make} ${c.model}${c.trim ? ` ${c.trim}` : ''}, ${Number.isFinite(c.mileage) ? formatMiles(c.mileage) : 'mileage not recorded'}, ${c.source}`;

export const MANUAL_EXCLUSION_PREFIX = 'Manually excluded: ';

/**
 * Exclusion reasons this engine writes itself (filter, hard exclusions, outlier test). When a
 * comparable arrives already excluded with one of these, it is a COMPUTED exclusion left over from an
 * earlier run (the API stores the assessed comparables and re-runs when adverts are added), not a
 * handler's decision: it is cleared and re-evaluated, because an outlier in a five-advert set may not
 * be one in a ten-advert set, and a letter must never call an algorithmic exclusion "manual".
 */
const COMPUTED_REASON_PATTERNS: readonly RegExp[] = [
  /^different make \(/,
  /^different model \(/,
  /^year .* outside /,
  /^mileage .* outside /,
  /^mileage not recorded or invalid/,
  /^year not recorded or invalid/,
  /^fuel .* differs from subject /,
  /^transmission .* differs from subject /,
  /^distance .* beyond the .* radius$/,
  /^price on application — /,
  /^previous write-off \(Cat [ABSN]\) — /,
  /^ex-fleet vehicle — /,
  /^not normalised — /,
  /^normalised price .* from the median /,
];

export function isComputedExclusionReason(reason: string | undefined): boolean {
  if (!reason) return false;
  const r = reason.trim();
  return COMPUTED_REASON_PATTERNS.some((re) => re.test(r)) || r.split('; ').every((part) => COMPUTED_REASON_PATTERNS.some((re) => re.test(part.trim())));
}

/** Strip any number of stacked "Manually excluded: " prefixes so a re-run never doubles them. */
export function stripManualPrefix(reason: string): string {
  let r = reason.trim();
  while (r.startsWith(MANUAL_EXCLUSION_PREFIX)) r = r.slice(MANUAL_EXCLUSION_PREFIX.length).trim();
  return r;
}

/** Reasons (if any) why a comparable fails the non-distance criteria. Empty array = passes. */
export function specificationMismatches(subject: PavSubject, comp: Comparable, opts: ResolvedFilterOptions): string[] {
  const reasons: string[] = [];
  if (normText(comp.make) !== normText(subject.make)) reasons.push(`different make (${comp.make} vs ${subject.make})`);
  if (normText(comp.model) !== normText(subject.model)) reasons.push(`different model (${comp.model} vs ${subject.model})`);
  if (!Number.isFinite(comp.year)) {
    reasons.push('year not recorded or invalid — cannot be compared');
  } else if (Math.abs(comp.year - subject.year) > opts.yearTolerance) {
    reasons.push(`year ${comp.year} outside ${subject.year} ±${opts.yearTolerance}`);
  }
  const { low, high } = mileageWindow(subject.odometerAtLoss, opts.mileagePct);
  if (!Number.isFinite(comp.mileage) || comp.mileage < 0) {
    // NaN compares false against every bound, so without this guard an unrecorded mileage would
    // pass the filter and then poison the median with NaN.
    // Never echo the raw value: "NaN" must not appear in a letter.
    reasons.push('mileage not recorded or invalid — cannot be compared or normalised');
  } else if (comp.mileage < low || comp.mileage > high) {
    reasons.push(
      `mileage ${formatMiles(comp.mileage)} outside ±${opts.mileagePct}% of ${formatMiles(subject.odometerAtLoss)} (${formatMiles(low)} to ${formatMiles(high)})`,
    );
  }
  if (subject.fuelType && comp.fuelType && subject.fuelType !== comp.fuelType) {
    reasons.push(`fuel ${comp.fuelType} differs from subject ${subject.fuelType}`);
  }
  const subjTx = subject.transmission && subject.transmission !== 'unknown' ? subject.transmission : undefined;
  const compTx = comp.transmission && comp.transmission !== 'unknown' ? comp.transmission : undefined;
  if (subjTx && compTx && subjTx !== compTx) reasons.push(`transmission ${compTx} differs from subject ${subjTx}`);
  return reasons;
}

export function mileageWindow(odometer: number, pct: number): { low: number; high: number } {
  const span = (odometer * pct) / 100;
  return { low: Math.floor(odometer - span), high: Math.ceil(odometer + span) };
}

export function filterComparables(subject: PavSubject, comps: Comparable[], options: FilterOptions = {}): FilterResult {
  const opts = resolveFilterOptions(options);
  const audit: string[] = [];
  const warnings: string[] = [];
  const window = mileageWindow(subject.odometerAtLoss, opts.mileagePct);

  audit.push(
    `Filter: make/model ${subject.make} ${subject.model}; year ${subject.year} ±${opts.yearTolerance}; mileage ${formatMiles(window.low)} to ${formatMiles(window.high)} (±${opts.mileagePct}% of ${formatMiles(subject.odometerAtLoss)}); fuel ${subject.fuelType ?? 'unknown'}; transmission ${subject.transmission ?? 'unknown'}; starting radius ${describeRadius(opts.radiusMiles)}; minimum ${opts.minCount} comparables.`,
  );

  const excluded: Comparable[] = [];
  const candidates: Comparable[] = [];
  for (const comp of comps) {
    if (comp.excluded) {
      const core = comp.exclusionReason ? stripManualPrefix(comp.exclusionReason) : '';
      if (core && isComputedExclusionReason(core)) {
        // Left over from an earlier run of this engine: re-evaluate rather than freeze it as "manual".
        audit.push(`Cleared stale computed exclusion on ${comp.id} from a previous run ("${core}"); re-evaluated below.`);
      } else {
        // A handler's exclusion flag is respected even without a reason: silently re-including an
        // advert someone took out would change the figure without an audit entry.
        const why = core || 'no reason recorded';
        excluded.push({ ...comp, excluded: true, exclusionReason: `${MANUAL_EXCLUSION_PREFIX}${why}` });
        audit.push(`Excluded ${comp.id} (${describeComparable(comp)}): manually excluded — ${why}.`);
        if (why === 'no reason recorded') warnings.push(`Comparable ${comp.id} is flagged excluded with no reason recorded; record the reason.`);
        continue;
      }
    }
    const reasons = specificationMismatches(subject, comp, opts);
    if (reasons.length > 0) {
      const reason = reasons.join('; ');
      excluded.push({ ...comp, excluded: true, exclusionReason: reason });
      audit.push(`Excluded ${comp.id} (${describeComparable(comp)}): ${reason}.`);
    } else {
      candidates.push(comp);
    }
  }

  // Radius ladder: start at radiusMiles, then each wider step.
  const ladder = Array.from(new Set([opts.radiusMiles, ...opts.radiusSteps.filter((s) => s >= opts.radiusMiles)])).sort(
    (a, b) => a - b,
  );
  // An unrecorded (or non-numeric) distance cannot be used to exclude: kept at every radius with a warning.
  const distanceKnown = (c: Comparable): boolean => c.distanceMiles !== undefined && Number.isFinite(c.distanceMiles);
  const withinRadius = (c: Comparable, r: number): boolean => !distanceKnown(c) || (c.distanceMiles as number) <= r;

  let radiusUsed = ladder[ladder.length - 1] ?? opts.radiusMiles;
  let keptAtRadius: Comparable[] = candidates.filter((c) => withinRadius(c, radiusUsed));
  for (const r of ladder) {
    const inside = candidates.filter((c) => withinRadius(c, r));
    audit.push(`Radius ${describeRadius(r)}: ${inside.length} comparable(s) inside.`);
    if (inside.length >= opts.minCount) {
      radiusUsed = r;
      keptAtRadius = inside;
      break;
    }
  }
  const radiusWidened = radiusUsed !== opts.radiusMiles;
  if (radiusWidened) {
    audit.push(`Radius widened from ${describeRadius(opts.radiusMiles)} to ${describeRadius(radiusUsed)} to reach ${opts.minCount} comparables.`);
  }
  if (keptAtRadius.length < opts.minCount) {
    warnings.push(
      `Only ${keptAtRadius.length} comparable(s) pass the specification filter even at ${describeRadius(radiusUsed)}; ${opts.minCount} are wanted. Capture more adverts before relying on the figure.`,
    );
  }

  const kept: Comparable[] = [];
  for (const comp of candidates) {
    if (withinRadius(comp, radiusUsed)) {
      if (!distanceKnown(comp)) {
        warnings.push(`Comparable ${comp.id} has no recorded distance from the claimant's postcode; it was kept — record the distance.`);
      }
      kept.push({ ...comp, excluded: false, exclusionReason: undefined });
    } else {
      const reason = `distance ${comp.distanceMiles} miles beyond the ${describeRadius(radiusUsed)} radius`;
      excluded.push({ ...comp, excluded: true, exclusionReason: reason });
      audit.push(`Excluded ${comp.id} (${describeComparable(comp)}): ${reason}.`);
    }
  }
  audit.push(`Filter result: ${kept.length} kept, ${excluded.length} excluded, radius ${describeRadius(radiusUsed)}.`);

  return { kept, excluded, radiusUsed, radiusWidened, mileageWindow: window, warnings, audit };
}
