import type { Pence } from './types.js';

/** Integer pence arithmetic helpers. All rounding is half-up to the nearest penny. */
export const poundsToPence = (pounds: number): Pence => Math.round(pounds * 100);
export const penceToPounds = (pence: Pence): number => pence / 100;

export function formatGBP(pence: Pence, opts: { showPence?: boolean } = {}): string {
  const showPence = opts.showPence ?? true;
  const negative = pence < 0;
  const abs = Math.abs(pence);
  const pounds = Math.floor(abs / 100);
  const pp = abs % 100;
  const poundsStr = pounds.toLocaleString('en-GB');
  const body = showPence ? `${poundsStr}.${pp.toString().padStart(2, '0')}` : poundsStr;
  return `${negative ? '-' : ''}£${body}`;
}

export function vatOn(netPence: Pence, rate = 0.2): Pence {
  return Math.round(netPence * rate);
}

export function grossFromNet(netPence: Pence, rate = 0.2): Pence {
  return netPence + vatOn(netPence, rate);
}

export function netFromGross(grossPence: Pence, rate = 0.2): Pence {
  return Math.round(grossPence / (1 + rate));
}

/** Parse a money string such as "£1,287.50", "1287", "£1,112" into pence. Returns null if not parseable. */
export function parseGBP(text: string): Pence | null {
  const m = text.replace(/\s/g, '').match(/^-?£?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const pounds = Number(m[1]!.replace(/,/g, ''));
  const pence = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  const sign = text.trim().startsWith('-') ? -1 : 1;
  return sign * (pounds * 100 + pence);
}

export function sumPence(values: Array<Pence | undefined | null>): Pence {
  return values.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}
