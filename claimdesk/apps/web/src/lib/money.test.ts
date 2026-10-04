import { describe, expect, it } from 'vitest';
import { formatGBP } from '@ccguk/domain';
import { isMoneyText, penceToPoundsText, poundsTextToPence } from './money';

describe('poundsTextToPence (MoneyInput)', () => {
  it('parses plain, formatted and partial pounds', () => {
    expect(poundsTextToPence('1287')).toBe(128700);
    expect(poundsTextToPence('1,287.50')).toBe(128750);
    expect(poundsTextToPence('£1,112')).toBe(111200);
    expect(poundsTextToPence('42.32')).toBe(4232);
    expect(poundsTextToPence('.5')).toBe(50);
    expect(poundsTextToPence('12.')).toBe(1200);
    expect(poundsTextToPence(' 45 ')).toBe(4500);
  });
  it('rounds half-up at the third decimal and never produces floats', () => {
    expect(poundsTextToPence('0.105')).toBe(11);
    expect(poundsTextToPence('0.104')).toBe(10);
    expect(poundsTextToPence('19.99')).toBe(1999);
    expect(Number.isInteger(poundsTextToPence('0.1')!)).toBe(true);
  });
  it('handles negatives', () => {
    expect(poundsTextToPence('-12.34')).toBe(-1234);
  });
  it('returns null for empty or non-money text', () => {
    expect(poundsTextToPence('')).toBeNull();
    expect(poundsTextToPence('-')).toBeNull();
    expect(poundsTextToPence('abc')).toBeNull();
    expect(poundsTextToPence('1.2.3')).toBeNull();
    expect(poundsTextToPence('£')).toBeNull();
  });
});

describe('penceToPoundsText', () => {
  it('renders two decimals without separators (input value)', () => {
    expect(penceToPoundsText(128700)).toBe('1287.00');
    expect(penceToPoundsText(4232)).toBe('42.32');
    expect(penceToPoundsText(5)).toBe('0.05');
    expect(penceToPoundsText(-1234)).toBe('-12.34');
    expect(penceToPoundsText(null)).toBe('');
    expect(penceToPoundsText(undefined)).toBe('');
  });
  it('round-trips with the parser', () => {
    for (const p of [0, 1, 99, 100, 4232, 128700, 111200, 2037, 2330]) {
      expect(poundsTextToPence(penceToPoundsText(p))).toBe(p);
    }
  });
});

describe('isMoneyText', () => {
  it('accepts empty and valid, rejects junk', () => {
    expect(isMoneyText('')).toBe(true);
    expect(isMoneyText('12.5')).toBe(true);
    expect(isMoneyText('12x')).toBe(false);
  });
});

describe('formatGBP (domain) as used by <Money>', () => {
  it("renders the brief's figures", () => {
    expect(formatGBP(128700)).toBe('£1,287.00');
    expect(formatGBP(111200)).toBe('£1,112.00');
    expect(formatGBP(4232)).toBe('£42.32');
    expect(formatGBP(128700, { showPence: false })).toBe('£1,287');
    expect(formatGBP(-500)).toBe('-£5.00');
  });
});
