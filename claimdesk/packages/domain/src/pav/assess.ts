/**
 * assessPav — the auditable pre-accident value (BLUEPRINT §4.3–4.4).
 *
 * The measure is the retail cost of buying an equivalent vehicle (Darbishire v Warran [1963]
 * 1 WLR 1067). Pipeline: filter → per-mile factor → normalise → exclusions and outliers → median
 * with IQR band → reasoning paragraph. Every step is written to `auditTrail`; every exclusion
 * carries a reason on the comparable itself. The engineer may override the median with a stated
 * reason; the median is still reported next to the override.
 *
 * Pure: no clock. `createdAt` is `opts.now` when given, otherwise the latest advert capture time
 * (deterministic from the data), otherwise an empty string that the caller must fill.
 */
import type { Comparable, ISODateTime, PavAssessment, PavSubject, Pence } from '../types.js';
import { formatGBP } from '../money.js';
import {
  DEFAULT_FILTER_OPTIONS,
  describeComparable,
  describeRadius,
  filterComparables,
  resolveFilterOptions,
  type FilterOptions,
  type FilterResult,
  type ResolvedFilterOptions,
} from './filter.js';
import { clampConditionPct, hardExclusionReason, describeBreakdown, excludeOutliers, normalisationBreakdown, normaliseComparables } from './normalise.js';
import { regressPerMile, type PerMileResult, type RegressionOptions } from './regression.js';
import { formatMiles, quartiles, roundPence, type QuartileStats } from './stats.js';

export interface AssessPavOptions extends FilterOptions {
  id?: string;
  claimId?: string;
  /** Timestamp for `createdAt`. Engines never read the clock; pass it in. */
  now?: ISODateTime;
  tradeGuidePence?: Pence;
  tradeGuideSource?: string;
  /** Engineer override of the median. The reason is mandatory and appears in the reasoning. */
  override?: { pavPence: Pence; reason: string };
  /** Multiplier of the IQR either side of the median for the outlier test. Default 1.5. */
  iqrMultiplier?: number;
  regression?: RegressionOptions;
}

export interface PavAssessmentResult extends PavAssessment {
  /** Radius at which the filter stopped (Infinity = no distance limit). */
  radiusUsed: number;
  /** Adverts supplied. */
  consideredCount: number;
  /** Adverts that survived every exclusion and set the median. */
  keptCount: number;
  regression: PerMileResult;
  /** Quartile statistics used for the outlier test (before outliers were removed). */
  outlierStats: QuartileStats | null;
  /** Quartile statistics of the surviving adverts (the reported median/IQR). */
  finalStats: QuartileStats | null;
  vatNote: string;
  warnings: string[];
  auditTrail: string[];
  conditionAdjustmentPct: number;
  /** The filter tolerances actually applied, so the reasoning paragraph states the real criteria. */
  filterOptions: ResolvedFilterOptions;
}

export const PAV_MEASURE_BASIS =
  'Pre-accident value is the retail cost of an equivalent replacement (make, model, age, mileage, condition, specification): Darbishire v Warran [1963] 1 WLR 1067.';

export function vatNoteFor(subject: Pick<PavSubject, 'vatRegisteredClaimant'>): string {
  if (subject.vatRegisteredClaimant) {
    return 'VAT note: the claimant is VAT registered. Retail advert prices include VAT. Whether any VAT element is recoverable depends on the vehicle\'s business use and the input-tax rules for cars; the engineer must confirm the position before any net adjustment is made. No deduction has been applied here.';
  }
  return 'VAT note: the claimant is not VAT registered, so the replacement cost is the VAT-inclusive retail price. No VAT deduction applies to the PAV.';
}

/**
 * Latest capture time by instant, not by string: '2026-10-02T09:00:00+01:00' (BST) is EARLIER than
 * '2026-10-02T08:30:00Z' although it sorts later as text. Unparseable strings fall back to text order.
 */
function latestCapture(comps: Comparable[]): ISODateTime | undefined {
  let latest: string | undefined;
  let latestMs: number | undefined;
  for (const c of comps) {
    if (!c.capturedAt) continue;
    const ms = Date.parse(c.capturedAt);
    if (latest === undefined) {
      latest = c.capturedAt;
      latestMs = Number.isNaN(ms) ? undefined : ms;
      continue;
    }
    const later =
      latestMs !== undefined && !Number.isNaN(ms) ? ms > latestMs : c.capturedAt > latest;
    if (later) {
      latest = c.capturedAt;
      latestMs = Number.isNaN(ms) ? undefined : ms;
    }
  }
  return latest;
}

export function assessPav(subject: PavSubject, comps: Comparable[], opts: AssessPavOptions = {}): PavAssessmentResult {
  // The subject's odometer and year drive every comparison; NaN compares false against every bound,
  // so a bad subject would silently pass every advert and print "£NaN" in the letter. Refuse instead.
  if (!Number.isFinite(subject.odometerAtLoss) || subject.odometerAtLoss < 0) {
    throw new RangeError(`subject.odometerAtLoss must be a non-negative finite number of miles (got ${String(subject.odometerAtLoss)})`);
  }
  if (!Number.isFinite(subject.year)) throw new RangeError(`subject.year must be a finite year (got ${String(subject.year)})`);

  const audit: string[] = [];
  const warnings: string[] = [];
  const clampedPct = clampConditionPct(subject.conditionAdjustmentPct);

  audit.push(PAV_MEASURE_BASIS);
  audit.push(
    `Subject: ${subject.year} ${subject.make} ${subject.model}${subject.trim ? ` ${subject.trim}` : ''} (${subject.registration}), ${formatMiles(subject.odometerAtLoss)} at loss (${subject.odometerBasis === 'projected_from_mot' ? 'projected from MOT history' : 'odometer reading'}), condition ${subject.conditionGrade}, condition adjustment ${clampedPct >= 0 ? '+' : ''}${clampedPct}%${subject.serviceHistory ? `, service history ${subject.serviceHistory}` : ''}${subject.exFleet ? ', ex-fleet' : ''}${subject.previousWriteOffCategory ? `, previous write-off Cat ${subject.previousWriteOffCategory}` : ''}.`,
  );
  audit.push(`${comps.length} advert(s) supplied, each captured manually (URL, screenshot/PDF, timestamp, hash) — never scraped.`);

  // 1. Filter
  const filtered: FilterResult = filterComparables(subject, comps, opts);
  audit.push(...filtered.audit);
  warnings.push(...filtered.warnings);

  // 2. Per-mile factor from adverts that are not hard-excluded
  const forRegression = filtered.kept.filter((c) => hardExclusionReason(c, subject) === null);
  const regression = regressPerMile(forRegression, opts.regression);
  audit.push(regression.note);
  if (regression.assumption) warnings.push(regression.note);

  // 3. Normalise
  if (!Number.isFinite(subject.conditionAdjustmentPct)) {
    warnings.push(`Condition adjustment is not a number (${String(subject.conditionAdjustmentPct)}); treated as 0%. The engineer must record a figure between −10% and +10%.`);
  } else if (clampedPct !== subject.conditionAdjustmentPct) {
    warnings.push(`Condition adjustment ${subject.conditionAdjustmentPct}% is outside ±10% and was clamped to ${clampedPct}%.`);
  }
  const normalised = normaliseComparables(subject, filtered.kept, regression.perMilePence);
  for (const c of filtered.kept) {
    const b = normalisationBreakdown(subject, c, regression.perMilePence);
    audit.push(b ? `Normalised ${describeBreakdown(b)}` : `Not normalised ${c.id}: no advertised price (POA).`);
  }

  // 4. Exclusions and outliers
  const outliers = excludeOutliers(normalised, subject, { iqrMultiplier: opts.iqrMultiplier });
  audit.push(...outliers.audit);

  // 5. Median and IQR of survivors
  const survivors = outliers.comps.filter((c) => !c.excluded && c.normalisedPricePence !== undefined);
  const finalStats = survivors.length > 0 ? quartiles(survivors.map((c) => c.normalisedPricePence!)) : null;
  const medianPence = finalStats ? roundPence(finalStats.median) : 0;
  const iqrLowPence = finalStats ? roundPence(finalStats.q1) : 0;
  const iqrHighPence = finalStats ? roundPence(finalStats.q3) : 0;
  const minCount = opts.minCount ?? 6;
  if (survivors.length === 0) {
    warnings.push('No comparables survived the exclusions; no median can be stated. Capture further adverts.');
  } else if (survivors.length < minCount) {
    warnings.push(
      `Only ${survivors.length} comparable(s) survived the exclusions; ${minCount} are wanted. The figure is reported but should be supported by further adverts before it is relied on.`,
    );
  }
  if (finalStats) {
    audit.push(
      `Result from ${finalStats.n} surviving advert(s): median ${formatGBP(medianPence)}, interquartile range ${formatGBP(iqrLowPence)} to ${formatGBP(iqrHighPence)}.`,
    );
  }

  // 6. Asserted figure
  let pavPence = medianPence;
  let overrideReason: string | undefined;
  if (opts.override) {
    // The reason is mandatory: an unexplained figure above the data is how a head gets inflated
    // (perimeter.md). Refuse rather than silently assert it.
    if (typeof opts.override.reason !== 'string' || opts.override.reason.trim().length === 0) {
      throw new RangeError('PAV override requires a stated reason');
    }
    if (!Number.isFinite(opts.override.pavPence) || opts.override.pavPence < 0) {
      throw new RangeError(`PAV override must be a non-negative finite number of pence (got ${String(opts.override.pavPence)})`);
    }
    pavPence = Math.round(opts.override.pavPence);
    overrideReason = opts.override.reason.trim();
    audit.push(`Engineer override: PAV asserted at ${formatGBP(pavPence)} instead of the median ${formatGBP(medianPence)}. Reason: ${overrideReason}`);
    if (finalStats && (pavPence > iqrHighPence || pavPence < iqrLowPence)) {
      warnings.push(
        `Engineer override ${formatGBP(pavPence)} is ${pavPence > iqrHighPence ? 'above' : 'below'} the interquartile range ${formatGBP(iqrLowPence)} to ${formatGBP(iqrHighPence)} of the surviving adverts; the stated reason must be evidenced on the file (invoices, service history, specification) before the figure is asserted.`,
      );
    }
  }
  if (opts.tradeGuidePence !== undefined) {
    audit.push(`Trade guide value ${formatGBP(opts.tradeGuidePence)}${opts.tradeGuideSource ? ` (${opts.tradeGuideSource})` : ''} shown alongside for comparison.`);
  }
  const vatNote = vatNoteFor(subject);
  audit.push(vatNote);

  // Assemble comparables in input order with every flag set
  const byId = new Map<string, Comparable>();
  for (const c of filtered.excluded) byId.set(c.id, c);
  for (const c of outliers.comps) byId.set(c.id, c);
  const comparables = comps.map((c) => byId.get(c.id) ?? { ...c });

  const createdAt = opts.now ?? latestCapture(comps) ?? '';
  const result: PavAssessmentResult = {
    id: opts.id ?? `pav-${subject.registration}-${createdAt || 'draft'}`,
    claimId: opts.claimId ?? '',
    subject,
    comparables,
    perMilePence: regression.perMilePence,
    perMileSource: regression.source,
    medianPence,
    iqrLowPence,
    iqrHighPence,
    tradeGuidePence: opts.tradeGuidePence,
    tradeGuideSource: opts.tradeGuideSource,
    pavPence,
    overrideReason,
    reasoning: '',
    createdAt,
    radiusUsed: filtered.radiusUsed,
    consideredCount: comps.length,
    keptCount: survivors.length,
    regression,
    outlierStats: outliers.stats,
    finalStats,
    vatNote,
    warnings,
    auditTrail: audit,
    conditionAdjustmentPct: clampedPct,
    filterOptions: resolveFilterOptions(opts),
  };
  result.reasoning = pavReasoning(result);
  return result;
}

type ReasoningInput = PavAssessment &
  Partial<Pick<PavAssessmentResult, 'radiusUsed' | 'regression' | 'warnings' | 'vatNote' | 'keptCount' | 'consideredCount' | 'filterOptions'>>;

const describeExcluded = (c: Comparable): string => `${c.id} — ${describeComparable(c)} (${c.exclusionReason ?? 'no reason recorded'})`;

/** Plain-English reasoning paragraph generated from the assessment data (engineer approves it). */
export function pavReasoning(a: ReasoningInput): string {
  const s = a.subject;
  const kept = a.comparables.filter((c) => !c.excluded && c.normalisedPricePence !== undefined);
  const excluded = a.comparables.filter((c) => c.excluded);
  const total = a.consideredCount ?? a.comparables.length;
  const radius = a.radiusUsed ?? Math.max(0, ...kept.map((c) => c.distanceMiles ?? 0));
  const fo = a.filterOptions ?? DEFAULT_FILTER_OPTIONS;
  const radiusText = Number.isFinite(radius) ? `within ${describeRadius(radius)} of the claimant's postcode` : "with no distance limit from the claimant's postcode (the radius was widened to find comparables)";
  const dealers = kept.filter((c) => c.seller === 'dealer').length;
  const privates = kept.filter((c) => c.seller === 'private').length;
  const parts: string[] = [];

  parts.push(
    `Pre-accident value of the ${s.year} ${s.make} ${s.model}${s.trim ? ` ${s.trim}` : ''} (${s.registration}), ${formatMiles(s.odometerAtLoss)} at the date of loss (${s.odometerBasis === 'projected_from_mot' ? 'projected from the MOT history' : 'odometer reading'}).`,
  );
  parts.push(
    `The measure is the retail cost of an equivalent replacement (Darbishire v Warran [1963] 1 WLR 1067). ${total} retail advert${total === 1 ? '' : 's'} ${total === 1 ? 'was' : 'were'} captured manually and considered, matched on make, model, year ±${fo.yearTolerance}, mileage ±${fo.mileagePct}%, fuel and transmission, ${radiusText}.`,
  );
  if (a.regression) {
    parts.push(a.regression.note);
  } else {
    parts.push(
      a.perMileSource === 'regression'
        ? `The per-mile factor is ${a.perMilePence}p per mile from the comparables' own price-to-mileage regression.`
        : `The per-mile factor is ${a.perMilePence}p per mile from the fallback price band; this is an assumption, not a figure derived from the adverts.`,
    );
  }
  const pct = clampConditionPct(s.conditionAdjustmentPct); // NaN → 0, never "NaN%" in a letter
  parts.push(
    `Each advert was adjusted to the subject's mileage at that factor, option adjustments were applied where recorded, and a condition adjustment of ${pct >= 0 ? '+' : ''}${pct}% was applied for the subject's ${s.conditionGrade} condition${pct === 0 ? ' (no adjustment)' : ''}.`,
  );
  if (excluded.length > 0) {
    const reasons = excluded.map(describeExcluded).join('; ');
    parts.push(`${excluded.length} advert${excluded.length === 1 ? ' was' : 's were'} excluded: ${reasons}.`);
  } else {
    parts.push('No adverts were excluded.');
  }
  if (kept.length === 0) {
    parts.push('No adverts survived the exclusions, so no median can be stated; further adverts are needed before a figure is asserted.');
  } else {
    parts.push(
      `${kept.length} advert${kept.length === 1 ? '' : 's'} remain (${dealers} dealer, ${privates} private${kept.length - dealers - privates > 0 ? `, ${kept.length - dealers - privates} unknown seller` : ''}). The median normalised price is ${formatGBP(a.medianPence)}, with an interquartile range of ${formatGBP(a.iqrLowPence)} to ${formatGBP(a.iqrHighPence)}.`,
    );
  }
  if (a.pavPence !== a.medianPence) {
    // Never describe a figure that differs from the median as "the median", whatever the reason field holds.
    parts.push(
      `The PAV asserted is ${formatGBP(a.pavPence)}, an engineer's override of the median ${formatGBP(a.medianPence)} for this reason: ${a.overrideReason && a.overrideReason.trim() ? a.overrideReason.trim() : 'NO REASON RECORDED — the override must not be relied on until a reason is stated'}`,
    );
  } else {
    parts.push(`The PAV asserted is ${formatGBP(a.pavPence)} (the median).`);
  }
  if (a.tradeGuidePence !== undefined) {
    parts.push(`For comparison, the trade guide value is ${formatGBP(a.tradeGuidePence)}${a.tradeGuideSource ? ` (${a.tradeGuideSource})` : ''}; guide figures are a starting point, not a ceiling.`);
  }
  parts.push(a.vatNote ?? vatNoteFor(s));
  const warnings = a.warnings ?? [];
  const shortfall = warnings.find((w) => w.includes('survived the exclusions') || w.includes('pass the specification filter'));
  if (shortfall) parts.push(`Warning: ${shortfall}`);
  return parts.join(' ');
}
