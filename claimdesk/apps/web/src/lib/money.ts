/**
 * Money input helpers. The ledger holds integer pence; people type pounds.
 * Conversion happens at the edge (MoneyInput) and nowhere else. Display uses formatGBP from @ccguk/domain.
 */
import type { Pence } from '@ccguk/domain';

/**
 * Parse a pounds string typed by a person ("1,287.50", "£1287", "1287.5", "-12") into integer pence.
 * Returns null when the text is empty or not a money amount. Half-up rounding at the third decimal.
 */
export function poundsTextToPence(text: string): Pence | null {
  const cleaned = text.replace(/[£,\s]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) return null;
  const negative = cleaned.startsWith('-');
  const body = negative ? cleaned.slice(1) : cleaned;
  const [whole = '0', frac = ''] = body.split('.');
  const pounds = Number(whole || '0');
  // keep three decimals for rounding, pad to two
  const fracDigits = (frac + '000').slice(0, 3);
  const penceRaw = Number(fracDigits.slice(0, 2));
  const third = Number(fracDigits[2]);
  const pence = penceRaw + (third >= 5 ? 1 : 0);
  const total = pounds * 100 + pence;
  return negative ? -total : total;
}

/** Pence → the text shown inside a pounds input ("1287.50"). Empty string for null/undefined. */
export function penceToPoundsText(pence: Pence | null | undefined): string {
  if (pence === null || pence === undefined || Number.isNaN(pence)) return '';
  const negative = pence < 0;
  const abs = Math.abs(Math.round(pence));
  const pounds = Math.floor(abs / 100);
  const pp = abs % 100;
  return `${negative ? '-' : ''}${pounds}.${pp.toString().padStart(2, '0')}`;
}

/** True when the text would parse to a valid pence amount (or is empty). */
export function isMoneyText(text: string): boolean {
  return text.trim() === '' || poundsTextToPence(text) !== null;
}
