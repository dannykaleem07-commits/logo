import { describe, it, expect } from 'vitest';
import { formatGBP, parseGBP, vatOn, grossFromNet, netFromGross } from './money.js';

describe('money', () => {
  it('formats pence as GBP', () => {
    expect(formatGBP(128700)).toBe('£1,287.00');
    expect(formatGBP(111200)).toBe('£1,112.00');
    expect(formatGBP(4232)).toBe('£42.32');
    expect(formatGBP(-550)).toBe('-£5.50');
    expect(formatGBP(4500, { showPence: false })).toBe('£45');
  });
  it('parses GBP strings', () => {
    expect(parseGBP('£1,287')).toBe(128700);
    expect(parseGBP('1112.5')).toBe(111250);
    expect(parseGBP('£42.32')).toBe(4232);
    expect(parseGBP('abc')).toBeNull();
  });
  it('VAT helpers round to the penny', () => {
    expect(vatOn(4980)).toBe(996);
    expect(grossFromNet(4980)).toBe(5976);
    expect(netFromGross(5976)).toBe(4980);
  });
});
