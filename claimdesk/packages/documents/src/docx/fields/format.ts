/**
 * formatForSlot(value, slot, def, format?, when?) → the SlotValue the engine writes (design doc §B.4).
 *
 * Printed spacing is kept: date boxes keep the spaces round the slashes and `at`, a month-precision date keeps the
 * printed day group, money after a printed `£` is digits only, a printed `CCG-`/`CCG-HIRE-` reference is replaced whole
 * by the value, sort codes split into the printed groups, choice options match by option-slug prefix.
 */
import { londonParts } from '@ccguk/domain';
import { slugify } from '../text.js';
import type { DocxSlot, SlotValue } from '../types.js';
import { thousands } from './derive.js';
import type { FieldDef, FieldValue, FormatName } from './types.js';

const pad2 = (n: number): string => String(n).padStart(2, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface DateTimeParts {
  d?: string;
  m: string;
  y: string;
  hh?: string;
  mm?: string;
  dayNum?: number;
  monthNum: number;
}

/** Calendar parts of a date / datetime / month / time value (datetimes in Europe/London). */
export function partsOf(value: FieldValue): DateTimeParts | undefined {
  if (value.t === 'date') {
    const mm = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(value.v);
    if (!mm) return undefined;
    const monthOnly = value.precision === 'month' || !mm[3];
    return { y: mm[1]!, m: mm[2]!, monthNum: Number(mm[2]), ...(monthOnly ? {} : { d: mm[3]!, dayNum: Number(mm[3]) }) };
  }
  if (value.t === 'datetime') {
    if (!/T/.test(value.v)) return partsOf({ t: 'date', v: value.v });
    const p = londonParts(value.v);
    return { y: String(p.year), m: pad2(p.month), d: pad2(p.day), hh: pad2(p.hour), mm: pad2(p.minute), dayNum: p.day, monthNum: p.month };
  }
  if (value.t === 'time') {
    const mm = /^(\d{1,2}):(\d{2})/.exec(value.v);
    return mm ? { y: '', m: '', monthNum: 0, hh: pad2(Number(mm[1])), mm: mm[2]! } : undefined;
  }
  return undefined;
}

/** `04/10/2026` (month precision: `03/2019`). */
export function compactDate(p: DateTimeParts): string {
  return p.d ? `${p.d}/${p.m}/${p.y}` : `${p.m}/${p.y}`;
}

/** `4 October 2026` (month precision: `March 2019`). */
export function longDateText(p: DateTimeParts): string {
  const month = MONTHS[p.monthNum - 1] ?? '';
  return p.dayNum ? `${p.dayNum} ${month} ${p.y}` : `${month} ${p.y}`;
}

/** `1,234.56` */
export function moneyDigits(pence: number): string {
  const neg = pence < 0;
  const abs = Math.abs(Math.round(pence));
  return `${neg ? '-' : ''}${Math.floor(abs / 100).toLocaleString('en-GB')}.${pad2(abs % 100)}`;
}

/** `£1,234.56` */
export function moneyText(pence: number): string {
  const d = moneyDigits(pence);
  return d.startsWith('-') ? `-£${d.slice(1)}` : `£${d}`;
}

/** Replace the underscore runs of a printed blank, in order, with `groups` (undefined keeps the run as printed). */
function fillUnderscoreRuns(printed: string, groups: Array<string | undefined>): string {
  let i = 0;
  return printed.replace(/_+/g, (run) => {
    const g = groups[i++];
    return g === undefined ? run : g;
  });
}

/** Space box (`        /         /              `): each group centred in its printed width. */
function fillSpaceBox(printed: string, groups: Array<string | undefined>): string {
  return printed
    .split('/')
    .map((seg, i) => {
      const g = groups[i];
      if (g === undefined) return seg;
      const width = Math.max(seg.length, g.length + 2);
      const left = Math.floor((width - g.length) / 2);
      return `${' '.repeat(left)}${g}${' '.repeat(width - g.length - left)}`;
    })
    .join('/');
}

function boxes(printed: string, groups: Array<string | undefined>): string {
  return printed.includes('_') ? fillUnderscoreRuns(printed, groups) : fillSpaceBox(printed, groups);
}

/** Date / date-time / time value into a printed date-ish blank. */
/** Below this cell width (about 4.6 cm) a date-and-time blank is filled compactly. */
export const NARROW_DATETIME_TWIPS = 2600;

function dateIntoBlank(slot: DocxSlot, value: FieldValue, format?: FormatName): string | undefined {
  const b = slot.blank!;
  const p = partsOf(value);
  if (!p) return undefined;
  if (format === 'date-long') return p.y ? longDateText(p) : undefined;
  if (format === 'date-compact') return p.y ? compactDate(p) : undefined;
  if (format === 'datetime-compact') return p.y ? (p.hh ? `${compactDate(p)} ${p.hh}:${p.mm}` : compactDate(p)) : undefined;
  switch (b.pattern) {
    case 'date':
      return p.y ? boxes(b.text, [p.d, p.m, p.y]) : undefined;
    case 'datetime':
      // a narrow cell cannot hold the printed "dd / mm / yyyy  at  hh : mm" spacing on one line: single spaces
      if (p.y && p.hh && slot.widthTwips !== undefined && slot.widthTwips < NARROW_DATETIME_TWIPS) return `${compactDate(p)} at ${p.hh}:${p.mm}`;
      return p.y ? boxes(b.text, [p.d, p.m, p.y, p.hh, p.mm]) : undefined;
    case 'month-year':
      return p.y ? boxes(b.text, [p.m, p.y]) : undefined;
    case 'time':
      return p.hh ? boxes(b.text, [p.hh, p.mm]) : undefined;
    default: {
      if (!p.y) return p.hh ? `${p.hh}:${p.mm}` : undefined;
      if (p.hh && value.t === 'datetime') return `${compactDate(p)} ${p.hh}:${p.mm}`;
      return compactDate(p);
    }
  }
}

/** Split a value's digits over the printed underscore groups (sort code `____  —  ____  —  ____` → `04  —  06  —  05`). */
function groupedDigits(printed: string, value: string): string | undefined {
  const runs = printed.match(/_+/g) ?? [];
  const digits = value.replace(/\D/g, '');
  if (runs.length < 2 || digits.length === 0 || digits.length % runs.length !== 0) return undefined;
  const size = digits.length / runs.length;
  return fillUnderscoreRuns(
    printed,
    runs.map((_, i) => digits.slice(i * size, (i + 1) * size))
  );
}

function applyTextFormat(s: string, format?: FormatName): string {
  switch (format) {
    case 'upper':
      return s.toUpperCase();
    case 'title':
      return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    case 'reg': {
      const r = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const m = /^([A-Z]{2}\d{2})([A-Z]{3})$/.exec(r);
      return m ? `${m[1]} ${m[2]}` : r;
    }
    default:
      return s;
  }
}

/** Human text of any value (cells, inline, lines, brackets, tokens). */
export function valueText(value: FieldValue, slot: DocxSlot | undefined, def: FieldDef | undefined, format?: FormatName): string | undefined {
  const narrow = slot?.widthTwips !== undefined && slot.widthTwips < 1300;
  switch (value.t) {
    case 'text':
      return applyTextFormat(value.v, format);
    case 'time': {
      const p = partsOf(value);
      return p?.hh ? `${p.hh}:${p.mm}` : undefined;
    }
    case 'date':
    case 'datetime': {
      const p = partsOf(value);
      if (!p) return undefined;
      const withTime = value.t === 'datetime' && !!p.hh;
      const long = !narrow && (format === 'date-long' || (format === undefined && slot?.kind === 'bracket'));
      if (long) return withTime ? `${longDateText(p)}, ${p.hh}:${p.mm}` : longDateText(p);
      return withTime && format !== 'date-compact' ? `${compactDate(p)} ${p.hh}:${p.mm}` : compactDate(p);
    }
    case 'money':
      return format === 'money-digits' ? moneyDigits(value.v) : moneyText(value.v);
    case 'int': {
      const n = thousands(value.v);
      if (format === 'int') return n;
      const unit = format === 'miles' ? 'miles' : value.unit;
      return unit ? `${n} ${unit}` : n;
    }
    case 'bool':
      return value.v ? 'Yes' : 'No';
    case 'choice':
      return value.v.map((c) => def?.choices?.[c]?.label ?? c).join(', ') || undefined;
    case 'list': {
      if (value.v.length === 0) return undefined;
      const sep = format === 'lines' || (format === undefined && slot?.multiline) ? '\n' : ', ';
      return value.v.join(sep);
    }
    case 'rows':
      return undefined;
  }
}

/** Does an option slug match a matcher (`prefix`, or `exact$`)? */
export function optionMatches(slug: string, matcher: string): boolean {
  if (matcher.endsWith('$')) return slug === matcher.slice(0, -1);
  return slug === matcher || slug.startsWith(matcher);
}

/** Codes a value stands for (choice codes, yes/no for booleans, the text itself). */
function codesOf(value: FieldValue): string[] {
  switch (value.t) {
    case 'choice':
      return value.v;
    case 'bool':
      return [value.v ? 'yes' : 'no'];
    case 'text':
      return [value.v];
    case 'int':
      return [String(value.v)];
    default:
      return [];
  }
}

/** Option slugs of a choice slot selected by the value (FieldDef.choices[code].matches, slug prefixes). */
export function selectOptions(value: FieldValue, slot: DocxSlot, def: FieldDef | undefined): string[] {
  const options = slot.options ?? [];
  const out: string[] = [];
  for (const code of codesOf(value)) {
    const matchers = def?.choices?.[code]?.matches ?? [slugify(code.replace(/_/g, '-'))];
    for (const o of options) if (matchers.some((m) => optionMatches(o.slug, m)) && !out.includes(o.slug)) out.push(o.slug);
  }
  return out;
}

/** Is a checkbox's `when` code satisfied by the value? */
export function whenMatches(value: FieldValue, when: string): boolean {
  const w = when.toLowerCase();
  switch (value.t) {
    case 'bool':
      return (value.v && (w === 'yes' || w === 'true')) || (!value.v && (w === 'no' || w === 'false'));
    case 'choice':
      return value.v.map((c) => c.toLowerCase()).includes(w);
    case 'text':
      return value.v.trim().toLowerCase() === w;
    case 'int':
      return String(value.v) === when;
    default:
      return false;
  }
}

function columnFor(columnSlug: string, rowKey: string, def: FieldDef | undefined): boolean {
  const k = slugify(rowKey.replace(/([a-z])([A-Z])/g, '$1-$2'));
  if (columnSlug === k || columnSlug.startsWith(k)) return true;
  return (def?.columns?.[rowKey] ?? []).some((p) => columnSlug.startsWith(p));
}

export function formatForSlot(value: FieldValue, slot: DocxSlot, def: FieldDef | undefined, format?: FormatName, when?: string): SlotValue | undefined {
  switch (slot.kind) {
    case 'checkbox': {
      if (when !== undefined) return whenMatches(value, when) ? { type: 'check', checked: true } : undefined;
      if (value.t === 'bool') return value.v ? { type: 'check', checked: true } : undefined;
      if (value.t === 'int') return value.v > 0 ? { type: 'check', checked: true } : undefined;
      return undefined;
    }
    case 'choice': {
      const selected = selectOptions(value, slot, def);
      return selected.length ? { type: 'choice', selected } : undefined;
    }
    case 'table': {
      if (value.t !== 'rows' || value.v.length === 0) return undefined;
      const cols = slot.columns ?? [];
      const mapped = value.v.map((row) => {
        const out: Record<string, string> = {};
        for (const c of cols) {
          const k = Object.keys(row).find((key) => columnFor(c.slug, key, def));
          const cell = k === undefined ? undefined : row[k];
          if (cell !== undefined && cell !== '') out[c.slug] = cell;
        }
        return out;
      });
      return mapped.some((r) => Object.keys(r).length) ? { type: 'rows', rows: mapped } : undefined;
    }
    case 'paragraphs': {
      const items = value.t === 'list' ? value.v : value.t === 'text' ? value.v.split(/\n\s*\n/) : [];
      const clean = items.map((x) => x.trim()).filter((x) => x !== '');
      return clean.length ? { type: 'paragraphs', items: clean } : undefined;
    }
    case 'blank': {
      const b = slot.blank;
      if (!b) break;
      let text: string | undefined;
      if (value.t === 'date' || value.t === 'datetime' || value.t === 'time') text = dateIntoBlank(slot, value, format);
      else if (value.t === 'money') text = b.pattern === 'money' || b.hasCurrency || format === 'money-digits' ? moneyDigits(value.v) : moneyText(value.v);
      else if (value.t === 'int' && b.pattern !== 'reference') text = b.pattern === 'text' && value.unit && format !== 'int' ? `${thousands(value.v)} ${value.unit}` : thousands(value.v);
      else if (value.t === 'text' && b.pattern === 'text' && /_+[  ]*[—–-][  ]*_+/.test(b.text)) text = groupedDigits(b.text, value.v) ?? value.v;
      else text = valueText(value, slot, def, format);
      return text !== undefined && text.trim() !== '' ? { type: 'text', text } : undefined;
    }
    default:
      break;
  }
  const text = valueText(value, slot, def, format);
  return text !== undefined && text.trim() !== '' ? { type: 'text', text } : undefined;
}

/** What a SlotValue prints, for the values form (`display`). */
export function slotValueDisplay(v: SlotValue | undefined, slot: DocxSlot): string {
  if (!v) return '';
  switch (v.type) {
    case 'text':
      return v.text;
    case 'check':
      return v.checked ? '☒' : '';
    case 'choice': {
      const labels = v.selected.map((s) => `☒ ${slot.options?.find((o) => o.slug === s)?.label ?? s}`);
      const blanks = Object.entries(v.blanks ?? {}).map(([k, t]) => `${slot.options?.find((o) => o.slug === k)?.label ?? k}: ${t}`);
      return [...labels, ...blanks].join('; ');
    }
    case 'rows':
      return v.rows.map((r) => Object.values(r).join(' · ')).join('\n');
    case 'paragraphs':
      return v.items.map((t, i) => `${i + 1}. ${t}`).join('\n');
    case 'remove':
      return '';
  }
}
