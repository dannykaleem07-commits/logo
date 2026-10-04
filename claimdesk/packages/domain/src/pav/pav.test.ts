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
    // Each excluded advert is named in full so the paragraph can go into a letter unedited.
    expect(r).toContain('c5 — 2019 Volkswagen Golf, 45,000 miles, Auto Trader (price on application');
    expect(r).toContain('c6 — 2019 Volkswagen Golf, 47,000 miles, Auto Trader (previous write-off (Cat N)');
    expect(r).toContain('c7 — 2019 Volkswagen Golf, 46,000 miles, Auto Trader (normalised price £21,850.00');
    expect(r).not.toContain('Manually excluded');
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

// ---------------------------------------------------------------------------
// Adversarial verification: inputs that would print a wrong number in a letter, re-run idempotency,
// BST/GMT ordering, boundary conditions. Every expected figure below is computed by hand in a comment.
// ---------------------------------------------------------------------------

describe('adversarial: re-running the assessment on its own output', () => {
  it('is idempotent: computed exclusions are re-evaluated, never frozen as "manual", and the prose is identical', () => {
    const first = assessPav(subject, seven, { id: 'pav-1', claimId: 'claim-1', now: '2026-10-04T09:00:00Z' });
    // The API stores first.comparables (with excluded/exclusionReason/normalisedPricePence set) and re-runs.
    const second = assessPav(subject, first.comparables, { id: 'pav-1', claimId: 'claim-1', now: '2026-10-04T09:00:00Z' });
    expect(second.medianPence).toBe(1_417_500);
    expect(second.keptCount).toBe(4);
    expect(second.comparables.filter((c) => c.excluded).map((c) => c.id).sort()).toEqual(['c5', 'c6', 'c7']);
    expect(second.comparables.some((c) => c.exclusionReason?.includes('Manually excluded'))).toBe(false);
    expect(second.reasoning).toBe(first.reasoning);
    expect(second.auditTrail.filter((l) => l.startsWith('Cleared stale computed exclusion'))).toHaveLength(3);
  });

  it('a stale outlier exclusion is re-admitted when the new advert set no longer makes it an outlier', () => {
    // c7 (£22,000) was an outlier among five. Add five more adverts around £21,000–£22,500 at the subject
    // mileage and it is no longer one. Feeding c7 back in with its old reason must NOT keep it out.
    const first = assessPav(subject, seven, { now: '2026-10-04T09:00:00Z' });
    const staleC7 = first.comparables.find((c) => c.id === 'c7')!;
    expect(staleC7.excluded).toBe(true);
    const highEnd = [2_100_000, 2_150_000, 2_200_000, 2_250_000, 2_120_000].map((p, i) => comp(`h${i}`, { pricePence: p, mileage: 48_000 }));
    const second = assessPav(subject, [...seven.filter((c) => c.id !== 'c7'), staleC7, ...highEnd], { now: '2026-10-04T09:00:00Z' });
    const c7 = second.comparables.find((c) => c.id === 'c7')!;
    expect(c7.excluded).toBe(false);
    expect(c7.exclusionReason).toBeUndefined();
  });

  it('a genuine manual exclusion survives a re-run with exactly one prefix', () => {
    const manual = comp('man', { pricePence: 1_400_000, excluded: true, exclusionReason: 'advert withdrawn by dealer' });
    const first = assessPav(subject, [...seven, manual], { now: '2026-10-04T09:00:00Z' });
    const second = assessPav(subject, first.comparables, { now: '2026-10-04T09:00:00Z' });
    const m = second.comparables.find((c) => c.id === 'man')!;
    expect(m.excluded).toBe(true);
    expect(m.exclusionReason).toBe('Manually excluded: advert withdrawn by dealer');
    expect(second.medianPence).toBe(first.medianPence);
  });
});

describe('adversarial: invalid numbers must never reach the letter', () => {
  it('an advert with no usable mileage is excluded with a reason and the median is computed from the rest', () => {
    // Four priced adverts at the subject mileage: 13,900 / 14,100 / 14,300 / 14,500. Tukey: median 14,200,
    // Q1 = median(13,900, 14,100) = 14,000, Q3 = median(14,300, 14,500) = 14,400.
    const comps = [
      comp('a', { pricePence: 1_390_000 }),
      comp('b', { pricePence: 1_410_000 }),
      comp('c', { pricePence: 1_430_000 }),
      comp('d', { pricePence: 1_450_000 }),
      comp('nan', { pricePence: 1_420_000, mileage: Number.NaN }),
    ];
    const a = assessPav(subject, comps, { now: '2026-10-04T09:00:00Z' });
    expect(a.keptCount).toBe(4);
    expect(a.medianPence).toBe(1_420_000);
    expect(a.iqrLowPence).toBe(1_400_000);
    expect(a.iqrHighPence).toBe(1_440_000);
    const nan = a.comparables.find((c) => c.id === 'nan')!;
    expect(nan.excluded).toBe(true);
    expect(nan.exclusionReason).toContain('mileage not recorded or invalid');
    expect(a.reasoning).not.toContain('NaN');
    expect(a.auditTrail.join('\n')).not.toContain('£NaN');
  });

  it('an advert with a non-numeric distance is kept with a warning, not excluded as "NaN miles beyond"', () => {
    const r = filterComparables(subject, [comp('nd', { pricePence: 1_400_000, distanceMiles: Number.NaN })]);
    expect(r.kept).toHaveLength(1);
    expect(r.excluded).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('nd has no recorded distance'))).toBe(true);
    expect(r.audit.join('\n')).not.toContain('NaN');
  });

  it('refuses a subject whose odometer or year is not a number', () => {
    expect(() => assessPav({ ...subject, odometerAtLoss: Number.NaN }, seven)).toThrow(RangeError);
    expect(() => assessPav({ ...subject, odometerAtLoss: -1 }, seven)).toThrow(RangeError);
    expect(() => assessPav({ ...subject, year: Number.NaN }, seven)).toThrow(RangeError);
  });

  it('a non-numeric condition adjustment is treated as 0% in the prose and audit, with a warning', () => {
    const a = assessPav({ ...subject, conditionAdjustmentPct: Number.NaN }, seven, { now: '2026-10-04T09:00:00Z' });
    expect(a.conditionAdjustmentPct).toBe(0);
    expect(a.medianPence).toBe(1_417_500); // unchanged from the 0% fixture
    expect(a.reasoning).toContain('condition adjustment of +0%');
    expect(a.reasoning).not.toContain('NaN');
    expect(a.auditTrail.join('\n')).not.toContain('NaN');
    expect(a.warnings.some((w) => w.includes('not a number'))).toBe(true);
  });
});

describe('adversarial: BST/GMT and boundaries', () => {
  it('createdAt falls back to the latest capture by INSTANT: 09:00+01:00 (BST) is earlier than 08:30Z', () => {
    const a = assessPav(subject, [
      comp('bst', { pricePence: 1_400_000, capturedAt: '2026-10-02T09:00:00+01:00' }), // 08:00Z
      comp('utc', { pricePence: 1_400_000, capturedAt: '2026-10-02T08:30:00Z' }), // later instant, sorts earlier as text
    ]);
    expect(a.createdAt).toBe('2026-10-02T08:30:00Z');
  });

  it('the outlier test is strict: a price exactly on median + 1.5×IQR is kept, one penny over is excluded', () => {
    // Sorted normalised prices 100, 110, 120, 130, X (in £): median 120; Q1 = 105; Q3 = (130 + X)/2.
    // Upper bound = 120 + 1.5 × ((130 + X)/2 − 105) equals X when X = 240 (IQR 80, bound 120 + 120).
    const mk = (id: string, pounds: number): Comparable => ({ ...comp(id, { pricePence: pounds * 100 }), normalisedPricePence: pounds * 100 });
    const onBound = excludeOutliers([mk('a', 100), mk('b', 110), mk('c', 120), mk('d', 130), mk('x', 240)]);
    expect(onBound.stats?.iqr).toBe(8_000);
    expect(onBound.upperBoundPence).toBe(24_000);
    expect(onBound.comps.find((c) => c.id === 'x')?.excluded).toBeFalsy();
    const overBound = excludeOutliers([mk('a', 100), mk('b', 110), mk('c', 120), mk('d', 130), mk('x', 240.01)]);
    // Q3 = (130 + 240.01)/2 = 185.005; IQR = 80.005; bound = 120 + 120.0075 = 240.0075 < 240.01
    expect(overBound.comps.find((c) => c.id === 'x')?.excluded).toBe(true);
  });

  it('the mileage window is inclusive at both ends (36,000 and 60,000 pass; 35,999 and 60,001 fail)', () => {
    const r = filterComparables(subject, [
      comp('lo', { pricePence: 1, mileage: 36_000 }),
      comp('hi', { pricePence: 1, mileage: 60_000 }),
      comp('lo1', { pricePence: 1, mileage: 35_999 }),
      comp('hi1', { pricePence: 1, mileage: 60_001 }),
    ]);
    expect(r.kept.map((c) => c.id)).toEqual(['lo', 'hi']);
  });
});
