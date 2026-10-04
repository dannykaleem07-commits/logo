/**
 * Mileage conflict engine (live-file lesson e) and MOT-based odometer projection (BLUEPRINT §3.2, §4.4).
 * Pure functions: no clock, no I/O.
 */
import type { ISODate, MotTest, OdometerReading } from '../types.js';

export const KM_PER_MILE = 1.609344;

export type MileageConflictCode = 'NON_MONOTONIC' | 'VARIANCE' | 'UNIT_SUSPECT';

export interface MileageConflict {
  code: MileageConflictCode;
  a: OdometerReading;
  b: OdometerReading;
  message: string;
}

export interface MileageConflictOptions {
  /** Absolute tolerance in miles for two readings close in time (default 250). */
  toleranceMiles?: number;
  /** Percentage tolerance of the lower reading (default 2). The larger of the two tolerances applies. */
  tolerancePct?: number;
  /** Readings this many days apart or fewer are compared for VARIANCE (default 14). */
  varianceWindowDays?: number;
}

const MS_PER_DAY = 86_400_000;

function dayNumber(iso: ISODate): number {
  // Date-only ISO strings parse as UTC midnight; full timestamps are truncated to their date part.
  const d = iso.length > 10 ? iso.slice(0, 10) : iso;
  return Math.floor(Date.parse(`${d}T00:00:00Z`) / MS_PER_DAY);
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return dayNumber(b) - dayNumber(a);
}

const SOURCE_LABEL: Record<OdometerReading['source'], string> = {
  mot: 'MOT',
  accident_report: 'accident report',
  handover: 'handover',
  collection: 'collection',
  engineer: 'engineer',
  photo: 'photo',
  v5c: 'V5C',
  client: 'client',
  manual: 'manual'
};

export function formatLongDate(iso: ISODate): string {
  const d = iso.slice(0, 10);
  const [y, m, day] = d.split('-').map(Number);
  if (!y || !m || !day) return iso;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${day} ${months[m - 1] ?? ''} ${y}`.replace(/\s+/g, ' ').trim();
}

function describe(r: OdometerReading): string {
  return `${SOURCE_LABEL[r.source]} reading ${r.miles.toLocaleString('en-GB')} miles on ${formatLongDate(r.date)}`;
}

/**
 * Compare every pair of readings:
 *  - NON_MONOTONIC: a later-dated reading is lower than an earlier one.
 *  - VARIANCE: two readings within the window differ by more than the tolerance.
 *  - UNIT_SUSPECT: one reading ≈ 1.609 × the other (±2%) and the implied rate is implausible (> 60 miles/day),
 *    which is the signature of a kilometre figure recorded as miles.
 */
export function mileageConflicts(readings: OdometerReading[], opts: MileageConflictOptions = {}): MileageConflict[] {
  const toleranceMiles = opts.toleranceMiles ?? 250;
  const tolerancePct = opts.tolerancePct ?? 2;
  const windowDays = opts.varianceWindowDays ?? 14;

  const sorted = [...readings].sort((x, y) => dayNumber(x.date) - dayNumber(y.date) || x.miles - y.miles);
  const out: MileageConflict[] = [];

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      const gapDays = daysBetween(a.date, b.date);
      const diff = b.miles - a.miles;

      if (gapDays > 0 && diff < 0) {
        out.push({
          code: 'NON_MONOTONIC',
          a,
          b,
          message: `${describe(b)} is lower than ${describe(a)} (${Math.abs(diff).toLocaleString('en-GB')} miles lower). Odometers do not go backwards: one figure is wrong or in the wrong unit.`
        });
      }

      if (gapDays <= windowDays && diff !== 0) {
        const lower = Math.min(a.miles, b.miles);
        const tolerance = Math.max(toleranceMiles, Math.round((lower * tolerancePct) / 100));
        if (Math.abs(diff) > tolerance) {
          out.push({
            code: 'VARIANCE',
            a,
            b,
            message: `${describe(a)} and ${describe(b)} are ${gapDays} day${gapDays === 1 ? '' : 's'} apart but differ by ${Math.abs(diff).toLocaleString('en-GB')} miles (tolerance ${tolerance.toLocaleString('en-GB')}).`
          });
        }
      }

      const lo = Math.min(a.miles, b.miles);
      const hi = Math.max(a.miles, b.miles);
      if (lo > 0) {
        const ratio = hi / lo;
        const impliedPerDay = gapDays > 0 ? Math.abs(diff) / gapDays : Number.POSITIVE_INFINITY;
        if (ratio >= KM_PER_MILE * 0.98 && ratio <= KM_PER_MILE * 1.02 && impliedPerDay > 60) {
          const kmAsMiles = Math.round(lo * KM_PER_MILE);
          out.push({
            code: 'UNIT_SUSPECT',
            a,
            b,
            message: `${describe(hi === a.miles ? a : b)} is approximately 1.609 × ${describe(lo === a.miles ? a : b)} (${lo.toLocaleString('en-GB')} miles ≈ ${kmAsMiles.toLocaleString('en-GB')} km). One reading is probably kilometres recorded as miles.`
          });
        }
      }
    }
  }
  return out;
}

export interface OdometerProjection {
  miles: number;
  /** Vehicle's own annual mileage derived from its MOT history (0 when not derivable). */
  annualMiles: number;
  basis: 'projected_from_mot' | 'reading';
  fromTest?: MotTest;
  /** How annualMiles was derived. */
  method: 'regression' | 'last_two' | 'none';
  note?: string;
}

function testMiles(t: MotTest): number | undefined {
  if (t.odometerMiles === undefined || t.odometerMiles === null) return undefined;
  if (!Number.isFinite(t.odometerMiles)) return undefined;
  return t.odometerMiles;
}

/**
 * Project the odometer at `atDate` from the MOT history using the vehicle's own annual mileage:
 * ordinary least squares over all tests with readings (days → miles); falls back to the last two
 * readings when fewer than three exist or the regression slope is not positive.
 * The projection is anchored on the latest actual reading on or before `atDate`.
 */
export function projectOdometer(motHistory: MotTest[], atDate: ISODate): OdometerProjection {
  const tests = motHistory
    .filter((t) => testMiles(t) !== undefined && !!t.completedDate)
    .sort((a, b) => dayNumber(a.completedDate) - dayNumber(b.completedDate));

  if (tests.length === 0) {
    return { miles: 0, annualMiles: 0, basis: 'reading', method: 'none', note: 'No MOT odometer readings available.' };
  }

  const exact = tests.find((t) => t.completedDate.slice(0, 10) === atDate.slice(0, 10));
  if (exact) {
    const { annualMiles, method } = annualMileage(tests);
    return { miles: testMiles(exact)!, annualMiles, basis: 'reading', fromTest: exact, method };
  }

  const { slopePerDay, annualMiles, method } = annualMileage(tests);

  // Anchor: latest test on or before atDate, else the first test (backwards extrapolation).
  const before = tests.filter((t) => dayNumber(t.completedDate) <= dayNumber(atDate));
  const anchor = before.length > 0 ? before[before.length - 1]! : tests[0]!;
  const anchorMiles = testMiles(anchor)!;

  if (method === 'none') {
    return {
      miles: anchorMiles,
      annualMiles: 0,
      basis: 'reading',
      fromTest: anchor,
      method,
      note: 'Only one MOT reading: annual mileage cannot be derived, so the last reading is used unprojected.'
    };
  }

  const days = daysBetween(anchor.completedDate, atDate);
  const projected = Math.max(0, Math.round(anchorMiles + slopePerDay * days));
  return { miles: projected, annualMiles, basis: 'projected_from_mot', fromTest: anchor, method };
}

function annualMileage(sortedTests: MotTest[]): { slopePerDay: number; annualMiles: number; method: OdometerProjection['method'] } {
  const pts = sortedTests.map((t) => ({ x: dayNumber(t.completedDate), y: testMiles(t)! }));
  const distinctX = new Set(pts.map((p) => p.x)).size;
  if (pts.length < 2 || distinctX < 2) return { slopePerDay: 0, annualMiles: 0, method: 'none' };

  const lastTwo = (): { slopePerDay: number; annualMiles: number; method: OdometerProjection['method'] } => {
    // Walk back to find the last two readings on distinct dates with a positive slope.
    for (let i = pts.length - 1; i > 0; i--) {
      const p2 = pts[i]!;
      for (let k = i - 1; k >= 0; k--) {
        const p1 = pts[k]!;
        if (p2.x === p1.x) continue;
        const slope = (p2.y - p1.y) / (p2.x - p1.x);
        if (slope > 0) return { slopePerDay: slope, annualMiles: Math.round(slope * 365.25), method: 'last_two' };
        break;
      }
    }
    return { slopePerDay: 0, annualMiles: 0, method: 'none' };
  };

  if (pts.length < 3) return lastTwo();

  const n = pts.length;
  const meanX = pts.reduce((s, p) => s + p.x, 0) / n;
  const meanY = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of pts) {
    sxy += (p.x - meanX) * (p.y - meanY);
    sxx += (p.x - meanX) * (p.x - meanX);
  }
  if (sxx === 0) return lastTwo();
  const slope = sxy / sxx;
  if (!(slope > 0)) return lastTwo();
  return { slopePerDay: slope, annualMiles: Math.round(slope * 365.25), method: 'regression' };
}
