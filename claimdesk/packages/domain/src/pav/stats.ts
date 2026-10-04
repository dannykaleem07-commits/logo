/**
 * Small, hand-checkable statistics used by the PAV engine.
 *
 * QUARTILE METHOD: Tukey's hinges. Sort ascending; the median splits the data into a lower and an
 * upper half (the median itself is left out when n is odd); Q1 is the median of the lower half and
 * Q3 the median of the upper half. This is the box-plot method and is easy to reproduce by hand in a
 * dispute, which is the point. With n = 1 the quartiles equal the single value; with n = 2 they are
 * the two values.
 */

export interface QuartileStats {
  n: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  iqr: number;
}

export function median(values: number[]): number {
  if (values.length === 0) throw new RangeError('median of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function quartiles(values: number[]): QuartileStats {
  if (values.length === 0) throw new RangeError('quartiles of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const med = median(sorted);
  if (n === 1) {
    const v = sorted[0]!;
    return { n, min: v, q1: v, median: v, q3: v, max: v, iqr: 0 };
  }
  const half = Math.floor(n / 2);
  const lower = sorted.slice(0, half);
  const upper = n % 2 === 1 ? sorted.slice(half + 1) : sorted.slice(half);
  const q1 = median(lower);
  const q3 = median(upper);
  return { n, min: sorted[0]!, q1, median: med, q3, max: sorted[n - 1]!, iqr: q3 - q1 };
}

/** Round half away from zero to an integer (pence). */
export const roundPence = (v: number): number => (v < 0 ? -Math.round(-v) : Math.round(v));

export const formatMiles = (miles: number): string => `${Math.round(miles).toLocaleString('en-GB')} miles`;
