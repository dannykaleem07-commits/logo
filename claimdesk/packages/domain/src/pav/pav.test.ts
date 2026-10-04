import { describe, it, expect } from 'vitest';
import type { Comparable, PavSubject } from '../types.js';
import { median, quartiles } from './stats.js';
import { filterComparables, mileageWindow, specificationMismatches } from './filter.js';
import { fallbackPerMile, ols, regressPerMile } from './regression.js';
import { clampConditionPct, excludeOutliers, hardExclusionReason, normalisationBreakdown, normaliseComparables } from './normalise.js';
import { assessPav, pavReasoning, vatNoteFor } from './assess.js';

// ---------------------------------------------------------------------------
// Fixture: 2019 VW Golf, 48,000 miles, 7 adverts — one POA, one Cat N, one obvious outlier.
// ---------------------------------------------------------------------------

const subject: PavSubject = {
  vehicleId: 'veh-1',
  registration: 'AB19CDE',
  make: 'Volkswagen',
  model: 'Golf',
  trim: '1.5 TSI Match',
  year: 2019,
  fuelType: 'petrol',
  transmission: 'manual',
  odometerAtLoss: 48_000,
  odometerBasis: 'reading',
  conditionGrade: 'good',
  conditionAdjustmentPct: 0,
  serviceHistory: 'full',
  claimantPostcode: 'E1 6AN',
  vatRegisteredClaimant: false,
};

function comp(id: string, over: Partial<Comparable>): Comparable {
  return {
    id,
    capturedAt: '2026-10-01T10:00:00Z',
    source: 'Auto Trader',
    pricePence: 0,
    mileage: 48_000,
    year: 2019,
    make: 'Volkswagen',
    model: 'Golf',
    fuelType: 'petrol',
    transmission: 'manual',
    seller: 'dealer',
    distanceMiles: 20,
    ...over,
  };
}

const seven: Comparable[] = [
  comp('c1', { pricePence: 1_400_000, mileage: 50_000, distanceMiles: 12 }),
  comp('c2', { pricePence: 1_350_000, mileage: 56_000, year: 2018, distanceMiles: 30 }),
  comp('c3', { pricePence: 1_480_000, mileage: 42_000, year: 2020, seller: 'private', distanceMiles: 25 }),
  comp('c4', { pricePence: 1_420_000, mileage: 48_000, distanceMiles: 40 }),
  comp('c5', { pricePence: 0, priceOnApplication: true, mileage: 45_000, distanceMiles: 8 }),
  comp('c6', { pricePence: 1_100_000, mileage: 47_000, writeOffCategory: 'N', distanceMiles: 20 }),
  comp('c7', { pricePence: 2_200_000, mileage: 46_000, distanceMiles: 15 }),
];

describe('stats (Tukey quartiles)', () => {
  it('median of odd and even lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('quartiles use the median of each half, median left out when n is odd', () => {
    // 5 values: lower half [1410000, 1415000], upper half [1435000, 2185000]
    const q = quartiles([1_410_000, 1_415_000, 1_420_000, 1_435_000, 2_185_000]);
    expect(q.median).toBe(1_420_000);
    expect(q.q1).toBe(1_412_500);
    expect(q.q3).toBe(1_810_000);
    expect(q.iqr).toBe(397_500);
    // 4 values: halves of two
    const q4 = quartiles([1_410_000, 1_415_000, 1_420_000, 1_435_000]);
    expect(q4.median).toBe(1_417_500);
    expect(q4.q1).toBe(1_412_500);
    expect(q4.q3).toBe(1_427_500);
    expect(q4.iqr).toBe(15_000);
  });
  it('single value has zero IQR', () => {
    expect(quartiles([5]).iqr).toBe(0);
  });
});

describe('filterComparables', () => {
  it('mileage window is ±25% of the odometer', () => {
    expect(mileageWindow(48_000, 25)).toEqual({ low: 36_000, high: 60_000 });
  });
  it('keeps all seven fixture adverts at the 50-mile radius', () => {
    const r = filterComparables(subject, seven);
    expect(r.kept.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
    expect(r.excluded).toHaveLength(0);
    expect(r.radiusUsed).toBe(50);
    expect(r.radiusWidened).toBe(false);
  });
  it('excludes on model, year, mileage, fuel and transmission with reasons', () => {
    const bad: Comparable[] = [
      comp('x-model', { pricePence: 1_000_000, model: 'Polo' }),
      comp('x-year', { pricePence: 1_000_000, year: 2017 }),
      comp('x-miles', { pricePence: 1_000_000, mileage: 61_000 }),
      comp('x-fuel', { pricePence: 1_000_000, fuelType: 'diesel' }),
      comp('x-tx', { pricePence: 1_000_000, transmission: 'automatic' }),
      comp('ok-unknown-tx', { pricePence: 1_000_000, transmission: 'unknown' }),
      comp('ok-no-fuel', { pricePence: 1_000_000, fuelType: undefined }),
    ];
    const r = filterComparables(subject, bad);
    const reason = (id: string): string => r.excluded.find((c) => c.id === id)?.exclusionReason ?? '';
    expect(reason('x-model')).toContain('different model (Polo vs Golf)');
    expect(reason('x-year')).toContain('year 2017 outside 2019 ±1');
    expect(reason('x-miles')).toContain('mileage 61,000 miles outside ±25% of 48,000 miles (36,000 miles to 60,000 miles)');
    expect(reason('x-fuel')).toContain('fuel diesel differs from subject petrol');
    expect(reason('x-tx')).toContain('transmission automatic differs from subject manual');
    expect(r.kept.map((c) => c.id)).toEqual(['ok-unknown-tx', 'ok-no-fuel']);
    expect(r.excluded.every((c) => c.excluded === true)).toBe(true);
  });
  it('year tolerance is inclusive: 2018 and 2020 pass, 2017 and 2021 fail', () => {
    const r = filterComparables(subject, [
      comp('y18', { pricePence: 1, year: 2018 }),
      comp('y20', { pricePence: 1, year: 2020 }),
      comp('y21', { pricePence: 1, year: 2021 }),
    ]);
    expect(r.kept.map((c) => c.id)).toEqual(['y18', 'y20']);
  });
  it('widens the radius stepwise until six are found', () => {
    const comps = [
      ...[1, 2, 3, 4, 5].map((i) => comp(`near${i}`, { pricePence: 1_400_000, distanceMiles: 10 * i })),
      comp('mid', { pricePence: 1_400_000, distanceMiles: 80 }),
      comp('far', { pricePence: 1_400_000, distanceMiles: 180 }),
    ];
    const r = filterComparables(subject, comps);
    expect(r.radiusUsed).toBe(100);
    expect(r.radiusWidened).toBe(true);
    expect(r.kept.map((c) => c.id)).toEqual(['near1', 'near2', 'near3', 'near4', 'near5', 'mid']);
    expect(r.excluded.find((c) => c.id === 'far')?.exclusionReason).toBe('distance 180 miles beyond the 100 miles radius');
    expect(r.audit.some((a) => a.includes('Radius widened from 50 miles to 100 miles'))).toBe(true);
  });
  it('goes to no distance limit and warns when six cannot be found', () => {
    const comps = [comp('a', { pricePence: 1, distanceMiles: 10 }), comp('b', { pricePence: 1, distanceMiles: 400 })];
    const r = filterComparables(subject, comps);
    expect(r.radiusUsed).toBe(Infinity);
    expect(r.kept).toHaveLength(2);
    expect(r.warnings.some((w) => w.includes('Only 2 comparable(s) pass the specification filter'))).toBe(true);
  });
  it('keeps an advert with no recorded distance but warns', () => {
    const r = filterComparables(subject, [comp('nodist', { pricePence: 1, distanceMiles: undefined })]);
    expect(r.kept).toHaveLength(1);
    expect(r.warnings.some((w) => w.includes('nodist has no recorded distance'))).toBe(true);
  });
  it('respects a manual exclusion already on the advert', () => {
    const r = filterComparables(subject, [comp('man', { pricePence: 1, excluded: true, exclusionReason: 'advert withdrawn' })]);
    expect(r.excluded[0]?.exclusionReason).toBe('Manually excluded: advert withdrawn');
  });
  it('specificationMismatches is empty for an exact match', () => {
    expect(specificationMismatches(subject, seven[0]!, { yearTolerance: 1, mileagePct: 25, radiusMiles: 50, radiusSteps: [50], minCount: 6 })).toEqual([]);
  });
});

describe('regressPerMile', () => {
  it('uses the regression when n≥4, slope negative and R²≥0.2', () => {
    // Exactly £10 per 100 miles → 10p per mile, perfect fit.
    const comps = [
      comp('r1', { pricePence: 1_600_000, mileage: 20_000 }),
      comp('r2', { pricePence: 1_400_000, mileage: 40_000 }),
      comp('r3', { pricePence: 1_200_000, mileage: 60_000 }),
      comp('r4', { pricePence: 1_000_000, mileage: 80_000 }),
    ];
    const r = regressPerMile(comps);
    expect(r.source).toBe('regression');
    expect(r.perMilePence).toBe(10);
    expect(r.r2).toBe(1);
    expect(r.n).toBe(4);
    expect(r.slopePencePerMile).toBe(-10);
    expect(r.interceptPence).toBe(1_800_000);
    expect(r.assumption).toBe(false);
  });
  it('falls back when fewer than 4 usable adverts', () => {
    const comps = [
      comp('r1', { pricePence: 1_600_000, mileage: 20_000 }),
      comp('r2', { pricePence: 1_400_000, mileage: 40_000 }),
      comp('r3', { pricePence: 1_200_000, mileage: 60_000 }),
    ];
    const r = regressPerMile(comps);
    expect(r.source).toBe('fallback_band');
    expect(r.perMilePence).toBe(7.5); // median £14,000 → £5k–£15k band
    expect(r.assumption).toBe(true);
    expect(r.note).toContain('only 3 usable advert(s)');
  });
  it('falls back when the slope is not negative', () => {
    const comps = [
      comp('r1', { pricePence: 1_000_000, mileage: 20_000 }),
      comp('r2', { pricePence: 1_200_000, mileage: 40_000 }),
      comp('r3', { pricePence: 1_400_000, mileage: 60_000 }),
      comp('r4', { pricePence: 1_600_000, mileage: 80_000 }),
    ];
    const r = regressPerMile(comps);
    expect(r.source).toBe('fallback_band');
    expect(r.note).toContain('slope was not negative');
  });
  it('falls back when R² is below 0.2 (the seven-advert fixture)', () => {
    const usable = seven.filter((c) => c.id !== 'c5' && c.id !== 'c6');
    const fit = ols(usable.map((c) => ({ x: c.mileage, y: c.pricePence })))!;
    // Hand: Sxy = −28,200 (k miles × £), Sxx = 107.2, Syy = 50,480,000 → R² = 0.147
    expect(fit.r2).toBeCloseTo(0.147, 3);
    const r = regressPerMile(usable);
    expect(r.source).toBe('fallback_band');
    expect(r.perMilePence).toBe(7.5);
    expect(r.n).toBe(5);
    expect(r.note).toContain('R² 0.15 is below the 0.2 threshold');
  });
  it('ignores POA and excluded adverts', () => {
    const comps = [comp('poa', { pricePence: 0, priceOnApplication: true }), comp('ex', { pricePence: 1_000_000, excluded: true, exclusionReason: 'x' })];
    const r = regressPerMile(comps);
    expect(r.n).toBe(0);
    expect(r.source).toBe('fallback_band');
    expect(r.perMilePence).toBe(7.5); // middle band when there is nothing to reference
  });
  it('fallback bands by price: <£5k 5p, £5k–£15k 7.5p, >£15k 10p', () => {
    expect(fallbackPerMile(499_999).perMilePence).toBe(5);
    expect(fallbackPerMile(500_000).perMilePence).toBe(7.5);
    expect(fallbackPerMile(1_500_000).perMilePence).toBe(7.5);
    expect(fallbackPerMile(1_500_001).perMilePence).toBe(10);
    const low = regressPerMile([comp('a', { pricePence: 300_000 }), comp('b', { pricePence: 400_000 })]);
    expect(low.perMilePence).toBe(5);
    const high = regressPerMile([comp('a', { pricePence: 2_000_000 }), comp('b', { pricePence: 2_400_000 })]);
    expect(high.perMilePence).toBe(10);
  });
});

describe('normaliseComparables', () => {
  it('adds (advert mileage − subject mileage) × per-mile and options, then condition %', () => {
    const n = normaliseComparables(subject, seven, 7.5);
    const by = (id: string): number | undefined => n.find((c) => c.id === id)?.normalisedPricePence;
    expect(by('c1')).toBe(1_415_000); // 14,000 + 2,000 × 7.5p = +£150
    expect(by('c2')).toBe(1_410_000); // 13,500 + 8,000 × 7.5p = +£600
    expect(by('c3')).toBe(1_435_000); // 14,800 − 6,000 × 7.5p = −£450
    expect(by('c4')).toBe(1_420_000); // same mileage
    expect(by('c7')).toBe(2_185_000); // 22,000 − 2,000 × 7.5p = −£150
    expect(by('c5')).toBeUndefined(); // POA cannot be normalised
    expect(seven[0]!.normalisedPricePence).toBeUndefined(); // input not mutated
  });
  it('applies option and condition adjustments', () => {
    const better: PavSubject = { ...subject, conditionAdjustmentPct: 5 };
    const b = normalisationBreakdown(better, comp('c1', { pricePence: 1_400_000, mileage: 50_000, optionsAdjustmentPence: 50_000 }), 7.5)!;
    expect(b.mileageAdjustmentPence).toBe(15_000);
    expect(b.optionsAdjustmentPence).toBe(50_000);
    // base 1,465,000 × 5% = 73,250
    expect(b.conditionAdjustmentPence).toBe(73_250);
    expect(b.normalisedPricePence).toBe(1_538_250);
  });
  it('negative condition adjustment lowers the price', () => {
    const worse: PavSubject = { ...subject, conditionAdjustmentPct: -10 };
    const b = normalisationBreakdown(worse, comp('c4', { pricePence: 1_420_000 }), 7.5)!;
    expect(b.conditionAdjustmentPence).toBe(-142_000);
    expect(b.normalisedPricePence).toBe(1_278_000);
  });
  it('clamps the condition adjustment to ±10%', () => {
    expect(clampConditionPct(15)).toBe(10);
    expect(clampConditionPct(-12)).toBe(-10);
    expect(clampConditionPct(3)).toBe(3);
  });
});

describe('excludeOutliers', () => {
  it('hard exclusions: POA, Cat S/N, ex-fleet', () => {
    expect(hardExclusionReason(comp('p', { pricePence: 0, priceOnApplication: true }))).toContain('price on application');
    expect(hardExclusionReason(comp('n', { pricePence: 1, writeOffCategory: 'N' }))).toContain('previous write-off (Cat N)');
    expect(hardExclusionReason(comp('n', { pricePence: 1, writeOffCategory: 'S' }), { previousWriteOffCategory: 'N' })).toBeNull();
    expect(hardExclusionReason(comp('f', { pricePence: 1, exFleet: true }))).toContain('ex-fleet');
    expect(hardExclusionReason(comp('f', { pricePence: 1, exFleet: true }), { exFleet: true })).toBeNull();
  });
  it('excludes beyond 1.5×IQR from the median on the fixture', () => {
    const n = normaliseComparables(subject, seven, 7.5);
    const r = excludeOutliers(n, subject);
    expect(r.stats?.n).toBe(5);
    expect(r.stats?.median).toBe(1_420_000);
    expect(r.stats?.iqr).toBe(397_500);
    expect(r.lowerBoundPence).toBe(823_750);
    expect(r.upperBoundPence).toBe(2_016_250);
    const excluded = r.comps.filter((c) => c.excluded).map((c) => c.id).sort();
    expect(excluded).toEqual(['c5', 'c6', 'c7']);
    expect(r.comps.find((c) => c.id === 'c7')?.exclusionReason).toContain('normalised price £21,850.00 is more than 1.5×IQR from the median £14,200.00');
  });
  it('skips the outlier test when the IQR is zero', () => {
    const same = [1, 2, 3, 4].map((i) => ({ ...comp(`s${i}`, { pricePence: 1_000_000 }), normalisedPricePence: 1_000_000 }));
    const r = excludeOutliers(same);
    expect(r.comps.every((c) => !c.excluded)).toBe(true);
    expect(r.audit.some((a) => a.includes('interquartile range is zero'))).toBe(true);
  });
});

describe('assessPav', () => {
  it('seven adverts → four kept, median £14,175, IQR £14,125–£14,275, fallback 7.5p per mile', () => {
    const a = assessPav(subject, seven, { id: 'pav-1', claimId: 'claim-1', now: '2026-10-04T09:00:00Z' });
    expect(a.consideredCount).toBe(7);
    expect(a.keptCount).toBe(4);
    expect(a.perMileSource).toBe('fallback_band');
    expect(a.perMilePence).toBe(7.5);
    expect(a.medianPence).toBe(1_417_500);
    expect(a.iqrLowPence).toBe(1_412_500);
    expect(a.iqrHighPence).toBe(1_427_500);
    expect(a.pavPence).toBe(1_417_500);
    expect(a.radiusUsed).toBe(50);
    expect(a.createdAt).toBe('2026-10-04T09:00:00Z');
    expect(a.id).toBe('pav-1');
    expect(a.claimId).toBe('claim-1');

    const kept = a.comparables.filter((c) => !c.excluded).map((c) => c.id);
    expect(kept).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(a.comparables.map((c) => c.id)).toEqual(seven.map((c) => c.id)); // input order preserved
    expect(a.comparables.find((c) => c.id === 'c5')?.exclusionReason).toContain('price on application');
    expect(a.comparables.find((c) => c.id === 'c6')?.exclusionReason).toContain('Cat N');
    expect(a.comparables.find((c) => c.id === 'c7')?.exclusionReason).toContain('1.5×IQR');

    expect(a.warnings.some((w) => w.includes('Only 4 comparable(s) survived'))).toBe(true);
    expect(a.warnings.some((w) => w.includes('assumption'))).toBe(true);
    expect(a.auditTrail.length).toBeGreaterThan(10);
    expect(a.auditTrail.some((l) => l.includes('Normalised c1: £14,000.00 + £150.00'))).toBe(true);
  });

  it('reasoning paragraph states n, radius, factor and source, exclusions, condition, median, IQR and VAT note', () => {
    const a = assessPav(subject, seven, { now: '2026-10-04T09:00:00Z' });
    const r = a.reasoning;
    expect(r).toContain('7 retail adverts were captured manually');
    expect(r).toContain('within 50 miles of the claimant');
    expect(r).toContain('7.5p per mile from the fallback band');
    expect(r).toContain('assumption');
    expect(r).toContain('3 adverts were excluded');
    expect(r).toContain('c5 (price on application');
    expect(r).toContain('c6 (previous write-off (Cat N)');
    expect(r).toContain('c7 (normalised price £21,850.00');
    expect(r).toContain('condition adjustment of +0%');
    expect(r).toContain('4 adverts remain (3 dealer, 1 private)');
    expect(r).toContain('median normalised price is £14,175.00');
    expect(r).toContain('interquartile range of £14,125.00 to £14,275.00');
    expect(r).toContain('The PAV asserted is £14,175.00 (the median).');
    expect(r).toContain('VAT note: the claimant is not VAT registered');
    expect(r).toContain('Warning: Only 4 comparable(s) survived');
    expect(r).toContain('Darbishire v Warran');
    expect(pavReasoning(a)).toBe(r); // regenerable from the assessment
  });

  it('uses the regression when the adverts support it and says so', () => {
    const comps = [
      comp('r1', { pricePence: 1_600_000, mileage: 38_000 }),
      comp('r2', { pricePence: 1_500_000, mileage: 44_000 }),
      comp('r3', { pricePence: 1_400_000, mileage: 50_000 }),
      comp('r4', { pricePence: 1_300_000, mileage: 56_000 }),
    ];
    const a = assessPav(subject, comps, { now: '2026-10-04T09:00:00Z' });
    expect(a.perMileSource).toBe('regression');
    expect(a.perMilePence).toBeCloseTo(16.67, 2); // £100 per 6,000 miles
    expect(a.reasoning).toContain("from the comparables' own price-to-mileage regression (n=4, R²=1.00)");
    expect(a.warnings.some((w) => w.includes('assumption'))).toBe(false);
  });

  it('engineer override replaces the asserted figure but keeps the median', () => {
    const a = assessPav(subject, seven, { now: '2026-10-04T09:00:00Z', override: { pavPence: 1_450_000, reason: 'full VW service history and new tyres evidenced by invoices' } });
    expect(a.pavPence).toBe(1_450_000);
    expect(a.medianPence).toBe(1_417_500);
    expect(a.overrideReason).toContain('service history');
    expect(a.reasoning).toContain("an engineer's override of the median £14,175.00");
  });

  it('shows a trade guide alongside and the VAT-registered note', () => {
    const a = assessPav({ ...subject, vatRegisteredClaimant: true }, seven, { now: '2026-10-04T09:00:00Z', tradeGuidePence: 1_350_000, tradeGuideSource: 'cap hpi retail' });
    expect(a.reasoning).toContain('trade guide value is £13,500.00 (cap hpi retail)');
    expect(a.reasoning).toContain('the claimant is VAT registered');
    expect(a.vatNote).toBe(vatNoteFor({ vatRegisteredClaimant: true }));
    expect(a.vatNote).toContain('No deduction has been applied');
  });

  it('returns a zero median with a warning when nothing survives', () => {
    const a = assessPav(subject, [comp('poa', { pricePence: 0, priceOnApplication: true })], { now: '2026-10-04T09:00:00Z' });
    expect(a.keptCount).toBe(0);
    expect(a.medianPence).toBe(0);
    expect(a.warnings.some((w) => w.includes('No comparables survived'))).toBe(true);
    expect(a.reasoning).toContain('No adverts survived the exclusions');
  });

  it('falls back to the latest capture time for createdAt when now is not supplied', () => {
    const a = assessPav(subject, [comp('a', { pricePence: 1_400_000, capturedAt: '2026-09-30T08:00:00Z' }), comp('b', { pricePence: 1_400_000, capturedAt: '2026-10-02T08:00:00Z' })]);
    expect(a.createdAt).toBe('2026-10-02T08:00:00Z');
  });
});
