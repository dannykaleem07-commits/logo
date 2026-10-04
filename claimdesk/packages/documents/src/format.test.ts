import { describe, expect, it } from 'vitest';
import {
  addressLines,
  daysInclusive,
  chargeableDays,
  escapeHtml,
  formatDateLong,
  formatDateShort,
  formatDateTime,
  formatDateWithDay,
  formatMoney,
  formatMoneyWhole,
  formatPercent,
  formatPeriod,
  formatRegistration,
  joinAnd,
  nl2p,
  numberedList,
  ordinal,
  plural,
  toISODate
} from './format.js';

describe('dates', () => {
  it('formats long, short and with weekday', () => {
    expect(formatDateLong('2026-10-04')).toBe('4 October 2026');
    expect(formatDateShort('2026-10-04')).toBe('04/10/2026');
    expect(formatDateWithDay('2026-10-04')).toBe('Sunday 4 October 2026');
    expect(formatDateLong('2026-01-01')).toBe('1 January 2026');
  });

  it('shows date-times in Europe/London', () => {
    expect(formatDateTime('2026-07-04T23:30:00Z')).toBe('5 July 2026, 00:30'); // BST
    expect(formatDateTime('2026-12-04T09:05:00Z')).toBe('4 December 2026, 09:05'); // GMT
    expect(formatDateLong('2026-07-04T23:30:00Z')).toBe('5 July 2026');
    expect(formatDateTime('2026-10-04')).toBe('4 October 2026');
    expect(toISODate('2026-07-04T23:30:00Z')).toBe('2026-07-05');
  });

  it('counts periods inclusively', () => {
    expect(daysInclusive('2026-08-10', '2026-09-02')).toBe(24);
    expect(daysInclusive('2026-08-10', '2026-08-10')).toBe(1);
    expect(formatPeriod('2026-08-10', '2026-09-02')).toBe('10 August 2026 to 2 September 2026 (24 days)');
    expect(formatPeriod('2026-08-10', '2026-08-10')).toBe('10 August 2026 to 10 August 2026 (1 day)');
  });

  it('rejects invalid dates instead of printing "Invalid Date"', () => {
    expect(() => formatDateLong('not a date')).toThrow(TypeError);
    expect(() => formatDateLong('2026-02-30')).toThrow(TypeError);
    expect(() => formatDateLong('')).toThrow(TypeError);
  });
});

describe('money and numbers', () => {
  it('uses formatGBP', () => {
    expect(formatMoney(128700)).toBe('£1,287.00');
    expect(formatMoney(111200)).toBe('£1,112.00');
    expect(formatMoney(-4232)).toBe('-£42.32');
    expect(formatMoneyWhole(128700)).toBe('£1,287');
    expect(formatPercent(0.2)).toBe('20%');
  });

  it('pluralises and ordinalises', () => {
    expect(plural(1, 'day')).toBe('1 day');
    expect(plural(24, 'day')).toBe('24 days');
    expect(plural(3, 'working day')).toBe('3 working days');
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(22)).toBe('22nd');
  });
});

describe('vehicles and addresses', () => {
  it('formats registrations', () => {
    expect(formatRegistration('AB12CDE')).toBe('AB12 CDE');
    expect(formatRegistration('ab12 cde')).toBe('AB12 CDE');
    expect(formatRegistration('A123BCD')).toBe('A123 BCD');
    expect(formatRegistration('ABC123D')).toBe('ABC 123D');
    expect(formatRegistration('XYZ1')).toBe('XYZ1');
    expect(formatRegistration('')).toBe('');
  });

  it('builds address lines', () => {
    expect(addressLines({ line1: '1 Example Street', town: 'Example Town', postcode: 'EX1 1AA' })).toEqual(['1 Example Street', 'Example Town', 'EX1 1AA']);
    expect(addressLines(undefined)).toEqual([]);
  });
});

describe('html helpers', () => {
  it('escapes', () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('turns text into paragraphs', () => {
    expect(nl2p('First.\n\nSecond line one\nline two')).toBe('<p>First.</p>\n<p>Second line one<br>line two</p>');
    expect(nl2p('')).toBe('');
  });

  it('numbers requests and joins lists', () => {
    expect(numberedList(['One <b>', 'Two'])).toBe('<ol class="numbered">\n  <li>One &lt;b&gt;</li>\n  <li>Two</li>\n</ol>');
    expect(numberedList(['A'], { start: 3 })).toContain('start="3"');
    expect(numberedList([])).toBe('');
    expect(joinAnd(['a', 'b', 'c'])).toBe('a, b and c');
    expect(joinAnd(['a'])).toBe('a');
  });
});

describe('chargeableDays follows the ledger convention', () => {
  it('counts 24-hour periods for timed periods and inclusive days for plain dates', () => {
    // 10:00 to 10:00, 23 days later: 23 chargeable days (the File 1 ledger figure), not 24 calendar dates.
    expect(chargeableDays('2026-08-10T10:00:00.000Z', '2026-09-02T10:00:00.000Z')).toBe(23);
    expect(formatPeriod('2026-08-10T10:00:00.000Z', '2026-09-02T10:00:00.000Z')).toContain('(23 days)');
    // one minute into the next period starts another day
    expect(chargeableDays('2026-08-10T10:00:00.000Z', '2026-09-02T10:01:00.000Z')).toBe(24);
    expect(chargeableDays('2026-08-10', '2026-09-02')).toBe(24);
    // an explicit ledger figure always wins
    expect(formatPeriod('2026-08-10', '2026-09-02', 23)).toBe('10 August 2026 to 2 September 2026 (23 days)');
  });
});
