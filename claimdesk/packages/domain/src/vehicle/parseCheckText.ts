/**
 * Paste parser for vehicle details copied by hand from a free vehicle check (Total Car Check, GOV.UK pages, a V5C
 * transcription …) — TEMPLATES-VEHICLES-DESKTOP §E.3, label synonyms in Appendix 4.
 *
 * Pure: no I/O. ClaimDesk never fetches the page; the user copies the text and pastes it. Everything this returns
 * is unverified — the caller saves it with an `unverified` LookupRecord.
 *
 * Layouts recognised (mixed freely in one paste):
 *  - `Label: Value`
 *  - `Label<TAB>Value` (several pairs per line are fine: a copied 4-column table)
 *  - `Label` on one line and `Value` on the next (a copied web table)
 *  - `Label Value` when the label is a known phrase at the start of the line
 * A label only counts when its value parses (a cookie banner that starts "Make sure…" is not a make).
 */
import type { FuelType, ISODate, Transmission } from '../types.js';
import { mapVesFuelType } from './mappers.js';
import { isValidUkRegistration, normaliseRegistration } from './registration.js';

export interface ParsedVehicleCheck {
  fields: Partial<{
    registration: string;
    make: string;
    model: string;
    colour: string;
    bodyType: string;
    doors: number;
    seats: number;
    yearOfManufacture: number;
    monthOfFirstRegistration: string;
    firstRegisteredDate: ISODate;
    engineCapacityCc: number;
    fuelType: FuelType;
    transmission: Transmission;
    powerBhp: number;
    co2Gkm: number;
    euroStatus: string;
    vin: string;
    motStatus: string;
    motExpiryDate: ISODate;
    taxStatus: string;
    taxDueDate: ISODate;
    lastMotMileage: number;
    lastMotDate: ISODate;
  }>;
  matches: Array<{ field: string; label: string; raw: string; line: number }>;
  unmatchedLines: string[];
  warnings: string[];
}

type Fields = ParsedVehicleCheck['fields'];
type FieldName = keyof Fields;

export const PASTE_MAX_CHARS = 20_000;
/** 1 PS = 0.98632 bhp. */
export const PS_TO_BHP = 0.986;
const KW_TO_BHP = 1.341;
const KM_TO_MILES = 1 / 1.609344;

/** Label groups (Appendix 4). Each group has one value parser that may set several fields. */
type Group =
  | 'registration' | 'make' | 'model' | 'colour' | 'bodyType' | 'doors' | 'seats' | 'year' | 'firstRegistered' | 'engine' | 'fuel'
  | 'transmission' | 'power' | 'co2' | 'euro' | 'vin' | 'mot' | 'tax' | 'mileage' | 'lastMot';

const LABELS: Record<Group, string[]> = {
  registration: ['Registration', 'Reg', 'Registration Number', 'Reg Number', 'Vehicle Registration', 'Number Plate', 'VRM', 'Registration Mark', 'Reg No', 'Reg. No.'],
  make: ['Make', 'Manufacturer', 'Vehicle Make', 'Marque'],
  model: ['Model', 'Vehicle Model', 'Model/Variant', 'Model Variant', 'Description', 'Model Description'],
  colour: ['Colour', 'Color', 'Vehicle Colour', 'Body Colour', 'Primary Colour'],
  bodyType: ['Body Style', 'Body Type', 'Body'],
  doors: ['Doors', 'Number of Doors', 'No. of Doors', 'No of Doors'],
  seats: ['Seats', 'Seating Capacity', 'Number of Seats', 'No. of Seats', 'No of Seats'],
  year: ['Year of Manufacture', 'Year Manufactured', 'Manufactured', 'Year', 'Build Year', 'Model Year'],
  firstRegistered: ['Date of First Registration', 'Date First Registered', 'First Registered', 'Registered', 'Registration Date', 'First Registration', 'Registered Date', 'Date Registered', 'First Registration Date'],
  engine: ['Engine Size', 'Engine Capacity', 'Cylinder Capacity', 'Engine CC', 'Capacity', 'Engine'],
  fuel: ['Fuel Type', 'Fuel'],
  transmission: ['Transmission', 'Gearbox', 'Gear Box', 'Transmission Type'],
  power: ['Power', 'BHP', 'Engine Power', 'Max Power', 'Power Output'],
  co2: ['CO2 Emissions', 'CO2', 'Co2 Output', 'Emissions', 'CO2 Emission'],
  euro: ['Euro Status', 'Euro Emissions', 'Emission Standard', 'Euro Standard'],
  vin: ['VIN', 'VIN Number', 'Chassis Number', 'Vehicle Identification Number', 'VIN/Chassis Number'],
  mot: ['MOT', 'MOT Status', 'MOT Expiry', 'MOT Expiry Date', 'MOT Due', 'MOT Valid Until', 'MOT Expires', 'MOT Due Date'],
  tax: ['Tax', 'Tax Status', 'Road Tax', 'Tax Due', 'Tax Due Date', 'Tax Expiry', 'VED', 'Road Tax Status', 'Tax Expiry Date'],
  mileage: ['Mileage', 'Last MOT Mileage', 'Recorded Mileage', 'Odometer', 'Last Recorded Mileage', 'Mileage Last Recorded', 'Odometer Reading'],
  lastMot: ['Last MOT Date', 'Last MOT', 'Date of Last MOT', 'Last MOT Test'],
};

function normLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/₂/g, '2')
    .replace(/^co2(?=[a-z])/, 'co2 ') // GOV.UK "CO₂Emissions" (no space)
    .replace(/\([^)]*\)\s*$/g, '')
    .replace(/[\s:*?.\-–—]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface LabelEntry {
  key: string; // normalised phrase
  label: string; // as listed
  group: Group;
}

const LABEL_ENTRIES: LabelEntry[] = (Object.entries(LABELS) as Array<[Group, string[]]>)
  .flatMap(([group, labels]) => labels.map((label) => ({ key: normLabel(label), label, group })))
  .sort((a, b) => b.key.length - a.key.length);
const LABEL_BY_KEY = new Map(LABEL_ENTRIES.map((e) => [e.key, e] as const));

/** Groups whose values are free text (extra care in the weak `Label Value` layout). */
const FREE_TEXT: ReadonlySet<Group> = new Set(['make', 'model', 'colour', 'bodyType', 'euro']);
/** Words a results page prints where a make or model would be (never a vehicle). */
const NOT_A_VEHICLE = /^(information|info|details?|unknown|not (?:known|available|found)|n\/?a|none|vehicle|check|search|more|see (?:below|above)|-+|—)$/i;

// ---------------------------------------------------------------------------
// Value parsers
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function realDate(y: number, m: number, d: number): ISODate | undefined {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function monthOf(name: string): number {
  return MONTHS[name.slice(0, 3).toLowerCase()] ?? 0;
}

export interface ParsedDate {
  /** Full date when the day is known. */
  date?: ISODate;
  /** Always set: YYYY-MM. */
  month: string;
  /** Index of the match in the input (for "first date in the text"). */
  index: number;
}

/** Find the first date in a string: `12 March 2027`, `12th Mar 2027`, `12/03/2027`, `2027-03-12`, `March 2019`, `03/2019`. */
export function parseLooseDate(text: string): ParsedDate | undefined {
  const candidates: ParsedDate[] = [];
  const push = (index: number, y: number, m: number, d?: number) => {
    if (d !== undefined) {
      const date = realDate(y, m, d);
      if (date) candidates.push({ date, month: date.slice(0, 7), index });
      return;
    }
    if (y >= 1900 && y <= 2200 && m >= 1 && m <= 12) candidates.push({ month: `${y}-${pad2(m)}`, index });
  };
  let m: RegExpExecArray | null;
  const dmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, 'i');
  if ((m = dmy.exec(text))) push(m.index, Number(m[3]), monthOf(m[2]!), Number(m[1]));
  const mdy = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i');
  if ((m = mdy.exec(text))) push(m.index, Number(m[3]), monthOf(m[1]!), Number(m[2]));
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) push(iso.index, Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const num = /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\b/.exec(text);
  if (num) push(num.index, Number(num[3]), Number(num[2]), Number(num[1]));
  if (!candidates.length) {
    const my = new RegExp(`\\b${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, 'i').exec(text);
    if (my) push(my.index, Number(my[2]), monthOf(my[1]!));
    const mmyyyy = /(?:^|[^\d/.\-])(\d{1,2})[/.\-](\d{4})\b/.exec(text);
    if (mmyyyy) push(mmyyyy.index, Number(mmyyyy[2]), Number(mmyyyy[1]));
  }
  if (!candidates.length) return undefined;
  return candidates.sort((a, b) => a.index - b.index)[0];
}

function cleanFree(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/^[\s:\-–—]+|[\s,;]+$/g, '').trim();
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
}

function firstInt(value: string): number | undefined {
  const m = /\d[\d,]*/.exec(value);
  if (!m) return undefined;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

export function parseFuel(value: string): FuelType | undefined {
  const v = value.trim().toUpperCase();
  if (!v) return undefined;
  if (/\bPHEV\b|PLUG[\s-]?IN/.test(v)) return 'plugin_hybrid';
  if (/\b(B?EV|ELECTRICITY|FULL(Y)? ELECTRIC|BATTERY ELECTRIC)\b/.test(v) && !/PETROL|DIESEL/.test(v)) return 'electric';
  if (/MILD[\s-]?HYBRID|\bMHEV\b|\bHEV\b|HYBRID/.test(v)) return 'hybrid';
  if (/(PETROL|DIESEL)\s*\/\s*ELECTRIC|ELECTRIC\s*\/\s*(PETROL|DIESEL)/.test(v)) return 'hybrid';
  const mapped = mapVesFuelType(v);
  if (mapped && mapped !== 'other') return mapped;
  if (/HYDROGEN|BI-?FUEL|\bOTHER\b/.test(v)) return 'other';
  return undefined;
}

export function parseTransmission(value: string): Transmission | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (/semi[\s-]?auto|automatic|\bauto\b|\bcvt\b|\bdsg\b|tiptronic|s[\s-]?tronic|\bpdk\b|\bedc\b|\bdct\b|steptronic|powershift|e-?cvt/.test(v)) return 'automatic';
  if (/manual/.test(v)) return 'manual';
  return undefined;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface Ctx {
  out: ParsedVehicleCheck;
  todayYear: number;
  /** field → first raw value (for conflict warnings). */
  firstRaw: Map<FieldName, string>;
}

function setField<K extends FieldName>(c: Ctx, field: K, value: NonNullable<Fields[K]>, label: string, raw: string, line: number): void {
  const existing = c.out.fields[field];
  if (existing !== undefined) {
    if (existing !== value) {
      c.out.warnings.push(`Two different values for ${field}: "${c.firstRaw.get(field) ?? String(existing)}" and "${raw}" — kept the first`);
    }
    return;
  }
  c.out.fields[field] = value;
  c.firstRaw.set(field, raw);
  c.out.matches.push({ field, label, raw, line });
}

type Setter = <K extends FieldName>(field: K, value: NonNullable<Fields[K]>) => void;

/**
 * Parse `raw` as the value of `group`. Calls `set` for every field it recognises and returns true when at least one
 * field was recognised (or a deliberate rejection was warned about, so the line is not "unmatched").
 */
function parseValue(group: Group, raw: string, set: Setter, c: Ctx, weak: boolean): boolean {
  const value = cleanFree(raw);
  if (!value) return false;
  // Weak layout ("MOT tests passed 8"): status groups must start with a status word or a date.
  if (weak && (group === 'mot' || group === 'tax') && !/^(valid|expired|expires|not |invalid|no\b|taxed|untaxed|sorn|due|until|in date|overdue|\d)/i.test(value)) return false;
  if (FREE_TEXT.has(group)) {
    if (value.length > 60 || !/[a-z0-9]/i.test(value)) return false;
    if (LABEL_BY_KEY.has(normLabel(value))) return false;
    if (weak && (!/^[A-Z0-9]/.test(value) || value.split(' ').length > 5)) return false;
    if (group === 'make' || group === 'model') {
      // page text, not a vehicle: "Information", "N/A", "Description of the vehicle is below"
      if (NOT_A_VEHICLE.test(value)) return false;
      if (value.split(/\s+/).filter((w) => /^[a-z]/.test(w)).length >= 3) return false;
    }
  }
  switch (group) {
    case 'registration': {
      const tokens = value.split(/\s+/);
      for (const k of [2, 1]) {
        if (tokens.length < k) continue;
        const reg = normaliseRegistration(tokens.slice(0, k).join(''));
        if (reg && reg.length <= 7 && /\d/.test(reg) && /[A-Z]/.test(reg) && isValidUkRegistration(reg)) {
          set('registration', reg);
          return true;
        }
      }
      return false;
    }
    case 'make':
      set('make', value);
      return true;
    case 'model':
      set('model', value);
      return true;
    case 'colour':
      set('colour', titleCase(value));
      return true;
    case 'bodyType':
      set('bodyType', value);
      return true;
    case 'doors': {
      const n = firstInt(value);
      if (n === undefined || n < 1 || n > 9) return false;
      set('doors', n);
      return true;
    }
    case 'seats': {
      const n = firstInt(value);
      if (n === undefined || n < 1 || n > 17) return false;
      set('seats', n);
      return true;
    }
    case 'year': {
      const m = /\b(19|20)\d{2}\b/.exec(value);
      if (!m) return false;
      const y = Number(m[0]);
      if (y < 1950 || y > c.todayYear + 1) return false;
      set('yearOfManufacture', y);
      return true;
    }
    case 'firstRegistered': {
      const d = parseLooseDate(value);
      if (!d) return false;
      set('monthOfFirstRegistration', d.month);
      if (d.date) set('firstRegisteredDate', d.date);
      return true;
    }
    case 'engine': {
      const cc = /(\d{1,2},\d{3}|\d{2,5})\s*(?:cc|cm3|cm³|c\.c\.)?(?![\d.])/i.exec(value);
      const litres = /\b(\d{1,2}\.\d{1,2})\s*(?:l\b|litres?|liters?|ltr)?/i.exec(value);
      if (cc && !(litres && litres.index <= cc.index)) {
        const n = Number(cc[1]!.replace(/,/g, ''));
        if (n >= 40 && n <= 10_000) {
          set('engineCapacityCc', n);
          return true;
        }
      }
      if (litres) {
        const l = Number(litres[1]);
        if (l > 0 && l < 10) {
          set('engineCapacityCc', Math.round(l * 1000));
          c.out.warnings.push('Engine size given in litres — approximate');
          return true;
        }
      }
      return false;
    }
    case 'fuel': {
      const f = parseFuel(value);
      if (!f) return false;
      set('fuelType', f);
      return true;
    }
    case 'transmission': {
      const t = parseTransmission(value);
      if (!t) return false;
      set('transmission', t);
      return true;
    }
    case 'power': {
      const ps = /(\d{2,4}(?:\.\d+)?)\s*(?:ps|cv|hp\s*\(?metric\)?)\b/i.exec(value);
      const bhp = /(\d{2,4}(?:\.\d+)?)\s*(?:bhp|hp)\b/i.exec(value);
      const kw = /(\d{2,4}(?:\.\d+)?)\s*kw\b/i.exec(value);
      let n: number | undefined;
      if (bhp && (!ps || bhp.index <= ps.index)) n = Math.round(Number(bhp[1]));
      else if (ps) n = Math.round(Number(ps[1]) * PS_TO_BHP);
      else if (kw) n = Math.round(Number(kw[1]) * KW_TO_BHP);
      else if (/^\d{2,4}$/.test(value)) n = Number(value);
      if (n === undefined || n < 10 || n > 2000) return false;
      set('powerBhp', n);
      return true;
    }
    case 'co2': {
      const m = /(\d{1,3})\s*(?:g\s*\/\s*km|g\/km|gkm)?/i.exec(value);
      if (!m) return false;
      const n = Number(m[1]);
      if (n < 0 || n > 999) return false;
      set('co2Gkm', n);
      return true;
    }
    case 'euro': {
      if (!/euro|\b[1-6][a-z]{0,3}\b/i.test(value)) return false;
      set('euroStatus', value);
      return true;
    }
    case 'vin': {
      const compact = value.replace(/[\s-]/g, '').toUpperCase();
      if (/^[A-HJ-NPR-Z0-9]{17}$/.test(compact)) {
        set('vin', compact);
        return true;
      }
      if (/[*•xX#?]{2,}|\.{3}|…/.test(value) || compact.length < 17) {
        c.out.warnings.push('A partial or masked VIN was ignored — copy the full 17-character VIN from the V5C');
        return true;
      }
      c.out.warnings.push(`"${value}" is not a valid 17-character VIN and was ignored`);
      return true;
    }
    case 'mot': {
      let any = false;
      const d = parseLooseDate(value);
      if (d?.date) {
        set('motExpiryDate', d.date);
        any = true;
      }
      let status: string | undefined;
      if (/no mot (?:required|needed)|not (?:yet )?(?:due|required)|exempt|under 3 years|less than 3 years/i.test(value)) status = 'Exempt / not yet due';
      else if (/no (?:details|results|mot)|not (?:held|found)|no record/i.test(value)) status = 'No details held';
      else if (/not valid|invalid|expired|overdue|fail/i.test(value)) status = 'Expired';
      else if (/\bvalid\b|\bpass(?:ed)?\b|\byes\b|in date/i.test(value)) status = 'Valid';
      if (status) {
        set('motStatus', status);
        any = true;
      }
      return any;
    }
    case 'tax': {
      let any = false;
      const d = parseLooseDate(value);
      if (d?.date) {
        set('taxDueDate', d.date);
        any = true;
      }
      let status: string | undefined;
      if (/\bsorn\b|not taxed for on road use|off road/i.test(value)) status = 'SORN';
      else if (/untaxed|not taxed|expired|\bno\b/i.test(value)) status = 'Untaxed';
      else if (/\btaxed\b|\bvalid\b|\byes\b/i.test(value)) status = 'Taxed';
      if (status) {
        set('taxStatus', status);
        any = true;
      }
      return any;
    }
    case 'mileage':
    case 'lastMot': {
      let any = false;
      // "45,390 (at last MOT)": a note in brackets after the figure
      const value = cleanFree(raw).replace(/\s*\((?![^)]*\d)[^)]*\)\s*$/, '');
      if (group === 'lastMot') {
        const d = parseLooseDate(value);
        if (d?.date) {
          set('lastMotDate', d.date);
          any = true;
        }
      }
      const withUnit = /(\d{1,3}(?:,\d{3})+|\d{1,7})\s*(miles|mi\b|km|kilomet)/i.exec(value);
      let miles: number | undefined;
      if (withUnit) {
        const n = Number(withUnit[1]!.replace(/,/g, ''));
        if (/^k/i.test(withUnit[2]!)) {
          miles = Math.round(n * KM_TO_MILES);
          c.out.warnings.push('Mileage given in kilometres — converted to miles');
        } else miles = n;
      } else if (group === 'mileage' && /^\d{1,3}(?:,\d{3})+$|^\d{1,7}$/.test(value)) {
        miles = Number(value.replace(/,/g, ''));
      }
      if (miles !== undefined && miles >= 0 && miles <= 2_000_000) {
        set('lastMotMileage', miles);
        any = true;
      }
      return any;
    }
    default:
      return false;
  }
}

/** Longest label that the cell starts with, followed by a separator. `strong` = the separator was ':' / a dash. */
function splitLabel(cell: string): { entry: LabelEntry; value: string; strong: boolean } | undefined {
  const lower = cell.toLowerCase().replace(/₂/g, '2');
  for (const entry of LABEL_ENTRIES) {
    if (!lower.startsWith(entry.key)) continue;
    let rest = cell.slice(entry.key.length);
    // A parenthesised unit right after the label: "Engine Size (cc): 1598".
    const unit = /^\s*\([^)]{0,20}\)/.exec(rest);
    if (unit) rest = rest.slice(unit[0].length);
    if (rest !== '' && !/^[\s:\-–—]/.test(rest)) continue;
    const strong = /^\s*[:\-–—]/.test(rest);
    const value = rest.replace(/^\s*[:\-–—]?\s*/, '');
    if (!value) continue;
    return { entry, value, strong };
  }
  return undefined;
}

function isLabelOnly(cell: string): LabelEntry | undefined {
  return LABEL_BY_KEY.get(normLabel(cell));
}

export function parseVehicleCheckText(text: string, opts: { expectedRegistration?: string; today?: ISODate } = {}): ParsedVehicleCheck {
  const out: ParsedVehicleCheck = { fields: {}, matches: [], unmatchedLines: [], warnings: [] };
  const todayYear = Number((opts.today ?? new Date().toISOString()).slice(0, 4));
  const c: Ctx = { out, todayYear, firstRaw: new Map() };
  let input = typeof text === 'string' ? text : '';
  if (input.length > PASTE_MAX_CHARS) {
    input = input.slice(0, PASTE_MAX_CHARS);
    out.warnings.push(`The pasted text was longer than ${PASTE_MAX_CHARS.toLocaleString('en-GB')} characters; only the first ${PASTE_MAX_CHARS.toLocaleString('en-GB')} were read`);
  }
  input = input
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u00A0\u2007\u202F]/g, ' ');

  const lines = input.split('\n');
  let pending: { entry: LabelEntry; line: number; dash: boolean } | undefined;

  const tryValue = (entry: LabelEntry, raw: string, lineNo: number, weak: boolean): boolean => {
    const set: Setter = (field, value) => setField(c, field, value, entry.label, raw.trim(), lineNo);
    return parseValue(entry.group, raw, set, c, weak);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const rawLine = lines[i]!;
    const line = rawLine.replace(/[ \f\v]+/g, ' ').trim();
    if (!line.replace(/\t/g, '').trim()) continue;
    const cells = line
      .split(/\t+|\s{3,}|\s\|\s/)
      .map((s) => s.trim())
      .filter(Boolean);
    let matchedAny = false;

    // Label on the previous line, value on this one (the first cell when the line holds a copied table row).
    let start = 0;
    if (pending) {
      const p = pending;
      pending = undefined;
      const first = cells[0]!;
      const firstIsLabelish = Boolean(isLabelOnly(first) || splitLabel(first)?.strong);
      const candidate = cells.length === 1 ? line.replace(/\t/g, ' ') : first;
      // "Model —" then a sentence on the next line is page text, not the model
      const sentence = p.dash && FREE_TEXT.has(p.entry.group) && candidate.trim().split(/\s+/).length > 5;
      if (!firstIsLabelish && !sentence && tryValue(p.entry, candidate, lineNo, false)) {
        if (cells.length === 1) continue;
        matchedAny = true;
        start = 1;
      }
    }

    for (let j = start; j < cells.length; j += 1) {
      const cell = cells[j]!;
      const only = isLabelOnly(cell);
      if (only) {
        const next = cells[j + 1];
        if (next !== undefined) {
          if (!isLabelOnly(next) && tryValue(only, next, lineNo, false)) {
            matchedAny = true;
            j += 1;
          }
          continue;
        }
        if (cells.length === 1) {
          pending = { entry: only, line: lineNo, dash: /[-–—]\s*$/.test(cell) };
          matchedAny = true;
        }
        continue;
      }
      const split = splitLabel(cell);
      if (split && tryValue(split.entry, split.value, lineNo, !split.strong)) {
        matchedAny = true;
        continue;
      }
    }
    if (!matchedAny) out.unmatchedLines.push(line.replace(/\t/g, ' '));
  }

  const pasted = out.fields.registration;
  const expected = opts.expectedRegistration ? normaliseRegistration(opts.expectedRegistration) : '';
  if (pasted && expected && pasted !== expected) out.warnings.push(`The pasted registration ${pasted} differs from ${expected}`);
  return out;
}
