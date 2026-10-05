import { describe, expect, it } from 'vitest';
import type { BlankPattern, DocxSlot, SlotKind } from '../types.js';
import { getFieldDef } from './dictionary.js';
import { formatForSlot } from './format.js';
import type { FieldValue } from './types.js';

function slot(kind: SlotKind, extra: Partial<DocxSlot> = {}): DocxSlot {
  return { id: 'x/y', kind, part: 'word/document.xml', sectionPath: ['x'], sectionTitles: ['X'], label: 'Y', labelSlug: 'y', ordinal: 1, preview: '', signature: false, hint: false, multiline: false, ...extra };
}
function blank(pattern: BlankPattern, text: string, extra: Partial<NonNullable<DocxSlot['blank']>> = {}, s: Partial<DocxSlot> = {}): DocxSlot {
  return slot('blank', { blank: { pattern, text, hasCurrency: pattern === 'money', ...extra }, preview: text, ...s });
}
const text = (sv: ReturnType<typeof formatForSlot>): string | undefined => (sv?.type === 'text' ? sv.text : undefined);
const date: FieldValue = { t: 'date', v: '2026-10-04' };
const dt: FieldValue = { t: 'datetime', v: '2026-10-04T08:30:00Z' }; // 09:30 BST

describe('formatForSlot (§B.4)', () => {
  it('date into an underscore date box keeps the printed spacing round the slashes', () => {
    expect(text(formatForSlot(date, blank('date', '____ / ____ / ______'), undefined))).toBe('04 / 10 / 2026');
    expect(text(formatForSlot(date, blank('date', '___/___/______'), undefined))).toBe('04/10/2026');
  });

  it('date into a space box keeps the box width', () => {
    const printed = '        /         /              ';
    const out = text(formatForSlot(date, blank('date', printed), undefined))!;
    expect(out.length).toBe(printed.length);
    expect(out.replace(/\s+/g, '')).toBe('04/10/2026');
  });

  it('month precision keeps the printed day group', () => {
    expect(text(formatForSlot({ t: 'date', v: '2019-03', precision: 'month' }, blank('date', '___ / ___ / ______'), undefined))).toBe('___ / 03 / 2019');
  });

  it('datetime: two spaces either side of "at", as printed, in Europe/London', () => {
    expect(text(formatForSlot(dt, blank('datetime', '____ / ____ / ______  at  ____ : ____'), undefined))).toBe('04 / 10 / 2026  at  09 : 30');
  });

  it('time', () => {
    expect(text(formatForSlot({ t: 'time', v: '09:30' }, blank('time', '____ : ____'), undefined))).toBe('09 : 30');
    expect(text(formatForSlot(dt, blank('time', '____ : ____'), undefined))).toBe('09 : 30');
  });

  it('money: digits only after a printed pound sign (blank and £-only cell)', () => {
    expect(text(formatForSlot({ t: 'money', v: 123456 }, blank('money', '£______________'), undefined))).toBe('1,234.56');
    expect(text(formatForSlot({ t: 'money', v: 123456 }, blank('money', '£', { hasCurrency: true }), undefined))).toBe('1,234.56');
  });

  it('reference: the whole printed match is replaced by the value (never CCG-CCG-)', () => {
    for (const printed of ['CCG-____________-________', 'CCG-HIRE-____________', 'CCG-', 'CCG-                    -            ']) {
      const out = text(formatForSlot({ t: 'text', v: 'CCG-2026-00012' }, blank('reference', printed, { prefix: printed.startsWith('CCG-HIRE-') ? 'CCG-HIRE-' : 'CCG-' }), undefined));
      expect(out).toBe('CCG-2026-00012');
    }
    expect(text(formatForSlot({ t: 'text', v: 'CCG-H-000123' }, blank('reference', 'CCG-HIRE-____________', { prefix: 'CCG-HIRE-' }), undefined))).toBe('CCG-H-000123');
  });

  it('number + unit: digits with thousands separators, unit kept as printed', () => {
    expect(text(formatForSlot({ t: 'int', v: 45210, unit: 'miles' }, blank('number', '__________ miles', { unit: 'miles' }), undefined))).toBe('45,210');
  });

  it('sort code splits into the printed groups', () => {
    expect(text(formatForSlot({ t: 'text', v: '040605' }, blank('text', '____  —  ____  —  ____'), getFieldDef('company.bank.sortCode')))).toBe('04  —  06  —  05');
    expect(text(formatForSlot({ t: 'text', v: '04-06-05' }, blank('text', '____ — ____ — ____'), undefined))).toBe('04 — 06 — 05');
  });

  it('cell / inline / line dates are compact unless the mapping says date-long', () => {
    for (const k of ['cell', 'inline', 'line'] as const) expect(text(formatForSlot(date, slot(k, { widthTwips: 2500 }), undefined))).toBe('04/10/2026');
    expect(text(formatForSlot(date, slot('cell', { widthTwips: 2500 }), undefined, 'date-long'))).toBe('4 October 2026');
    expect(text(formatForSlot(dt, slot('cell', { widthTwips: 2500 }), undefined))).toBe('04/10/2026 09:30');
  });

  it('narrow cells (< 1300 twips) always get compact dates', () => {
    expect(text(formatForSlot(date, slot('cell', { widthTwips: 1200 }), undefined, 'date-long'))).toBe('04/10/2026');
    expect(text(formatForSlot(date, slot('bracket', { widthTwips: 1000 }), undefined))).toBe('04/10/2026');
  });

  it('cell money is £-formatted', () => {
    expect(text(formatForSlot({ t: 'money', v: 123456 }, slot('cell'), undefined))).toBe('£1,234.56');
    expect(text(formatForSlot({ t: 'money', v: 123456 }, slot('cell'), undefined, 'money-digits'))).toBe('1,234.56');
  });

  it('[dd Month yyyy] brackets get the long date', () => {
    expect(text(formatForSlot(date, slot('bracket', { label: 'dd Month yyyy', labelSlug: 'dd-month-yyyy' }), undefined))).toBe('4 October 2026');
  });

  it('registration and address arrive formatted from the resolvers; reg format re-formats raw input', () => {
    expect(text(formatForSlot({ t: 'text', v: 'ab12cde' }, slot('cell'), undefined, 'reg'))).toBe('AB12 CDE');
    expect(text(formatForSlot({ t: 'text', v: '12 High Street, Hounslow TW3 1AB' }, slot('cell'), undefined))).toBe('12 High Street, Hounslow TW3 1AB');
  });

  it('checkbox: bool or the `when` code ticks; false and undefined leave the box as printed', () => {
    expect(formatForSlot({ t: 'bool', v: true }, slot('checkbox'), undefined)).toEqual({ type: 'check', checked: true });
    expect(formatForSlot({ t: 'bool', v: false }, slot('checkbox'), undefined)).toBeUndefined();
    expect(formatForSlot({ t: 'choice', v: ['standard'] }, slot('checkbox'), undefined, undefined, 'standard')).toEqual({ type: 'check', checked: true });
    expect(formatForSlot({ t: 'choice', v: ['standard'] }, slot('checkbox'), undefined, undefined, 'full')).toBeUndefined();
    expect(formatForSlot({ t: 'text', v: 'premises' }, slot('checkbox'), undefined, undefined, 'premises')).toEqual({ type: 'check', checked: true });
    expect(formatForSlot({ t: 'bool', v: false }, slot('checkbox'), undefined, undefined, 'no')).toEqual({ type: 'check', checked: true });
  });

  it('choice: option slugs matched by prefix; none matched → undefined', () => {
    const fuel = slot('choice', { options: ['petrol', 'diesel', 'hybrid', 'ev'].map((s) => ({ slug: s, label: s, checked: false })) });
    expect(formatForSlot({ t: 'choice', v: ['electric'] }, fuel, getFieldDef('vehicle.fuelType'))).toEqual({ type: 'choice', selected: ['ev'] });
    expect(formatForSlot({ t: 'choice', v: ['plugin_hybrid'] }, fuel, getFieldDef('vehicle.fuelType'))).toEqual({ type: 'choice', selected: ['hybrid'] });
    expect(formatForSlot({ t: 'choice', v: ['lpg'] }, fuel, getFieldDef('vehicle.fuelType'))).toBeUndefined();
    const salvage = slot('choice', { options: ['n', 's', 'b', 'a', 'n-a'].map((s) => ({ slug: s, label: s, checked: false })) });
    expect(formatForSlot({ t: 'choice', v: ['N'] }, salvage, getFieldDef('engineer.salvageCategory'))).toEqual({ type: 'choice', selected: ['n'] });
    expect(formatForSlot({ t: 'choice', v: ['na'] }, salvage, getFieldDef('engineer.salvageCategory'))).toEqual({ type: 'choice', selected: ['n-a'] });
    const yn = slot('choice', { options: [{ slug: 'yes', label: 'YES', checked: false }, { slug: 'no', label: 'NO', checked: false }] });
    expect(formatForSlot({ t: 'bool', v: false }, yn, undefined)).toEqual({ type: 'choice', selected: ['no'] });
    const cond = slot('choice', { options: ['driveable', 'not-driveable', 'unknown'].map((s) => ({ slug: s, label: s, checked: false })) });
    expect(formatForSlot({ t: 'bool', v: true }, cond, getFieldDef('accident.driveable'))).toEqual({ type: 'choice', selected: ['driveable'] });
    expect(formatForSlot({ t: 'bool', v: false }, cond, getFieldDef('accident.driveable'))).toEqual({ type: 'choice', selected: ['not-driveable'] });
  });

  it('table rows are keyed by column slug; paragraphs from a list', () => {
    const table = slot('table', { columns: [{ slug: 'name', label: 'Name' }, { slug: 'contact', label: 'Contact' }, { slug: 'where-they-were', label: 'Where' }] });
    expect(formatForSlot({ t: 'rows', v: [{ name: 'Sarah Lee', contact: '07700 900789' }] }, table, undefined)).toEqual({ type: 'rows', rows: [{ name: 'Sarah Lee', contact: '07700 900789' }] });
    const log = slot('table', { columns: [{ slug: 'from', label: 'From' }, { slug: 'why-the-vehicle-remained-in-storage', label: 'Why' }] });
    expect(formatForSlot({ t: 'rows', v: [{ from: '10/08/2026', reason: 'Awaiting engineer' }] }, log, getFieldDef('storage.log'))).toEqual({ type: 'rows', rows: [{ from: '10/08/2026', 'why-the-vehicle-remained-in-storage': 'Awaiting engineer' }] });
    expect(formatForSlot({ t: 'list', v: ['One.', ' ', 'Two.'] }, slot('paragraphs'), undefined)).toEqual({ type: 'paragraphs', items: ['One.', 'Two.'] });
  });

  it('empty values print nothing', () => {
    expect(formatForSlot({ t: 'text', v: '  ' }, slot('cell'), undefined)).toBeUndefined();
    expect(formatForSlot({ t: 'list', v: [] }, slot('cell'), undefined)).toBeUndefined();
    expect(formatForSlot({ t: 'rows', v: [] }, slot('table', { columns: [] }), undefined)).toBeUndefined();
  });
});
