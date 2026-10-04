/**
 * Tolerant line parser for text extracted from Audatex / bodyshop estimate PDFs (BLUEPRINT §4.5 (b)).
 *
 * Every line it returns is `source: 'import'`, `confirmedByEngineer: false`: the engineer confirms
 * each one. It recognises operations (Replace, Repair, Refinish, Blend, Strip & Refit, R&R, R&I,
 * Calibrate, Diagnose), part numbers (alphanumeric 6–20 characters), hours ('1.20', '0.5 hrs') and
 * prices ('£123.45'), and classifies the kind. An Audatex-style line that carries BOTH a part price
 * and labour hours (e.g. "Replace Front bumper 5Q0807221 1.20 £245.60") is split into a part line
 * and a labour line, because EstimateLine prices parts by quantity × unit and labour by hours × rate.
 *
 * Heuristics for bare numbers (no £, no 'hrs'): a decimal of at most 2 places and ≤ 60 is read as
 * hours on a labour-type line unless a part number is present and the value has 2 decimal places
 * and is ≥ 20, in which case it is a price. Anything else is a price. On a sundry or materials line
 * a bare figure is always money (nobody books sundries by the hour), and on a diagnostic or
 * specialist line a bare figure over 8 is money rather than hours; an explicit 'hrs' marker always
 * wins. A figure introduced by '@' (e.g. "12.5 hrs @ £48.00") is an hourly RATE, not a price.
 * Date-shaped tokens are never part numbers. Header and total lines (Sub-total, Total, VAT) are
 * skipped; "balance" only skips a balance due/brought forward line, not "wheel balance".
 */
import type { EstimateLine, EstimateLineKind } from '../types.js';
import { parseGBP } from '../money.js';

export interface ParseOptions {
  /** Prefix for generated line ids. Default 'import'. */
  idPrefix?: string;
}

export type CanonicalOperation = 'Replace' | 'Repair' | 'Refinish' | 'Blend' | 'Strip/Refit' | 'R&R' | 'R&I' | 'Calibrate' | 'Diagnose' | 'Check' | 'Align' | 'Other';

const OPERATION_PATTERNS: Array<{ re: RegExp; op: CanonicalOperation }> = [
  { re: /\b(strip\s*(?:&|and|\/)\s*(?:re)?fit|strip\/refit|s\s*&\s*r)\b/i, op: 'Strip/Refit' },
  { re: /\b(remove\s*(?:&|and|\/)\s*(?:re)?install|r\s*&\s*i|r\/i)\b/i, op: 'R&I' },
  { re: /\b(remove\s*(?:&|and|\/)\s*(?:re)?fit|remove\s*(?:&|and)\s*replace|r\s*&\s*r|r\/r)\b/i, op: 'R&R' },
  { re: /\b(calibrat(?:e|ion|ed))\b/i, op: 'Calibrate' },
  { re: /\b(diagnos(?:e|is|tic|tics)|scan)\b/i, op: 'Diagnose' },
  { re: /\b(refinish|respray|re-?paint|paint)\b/i, op: 'Refinish' },
  { re: /\b(blend)\b/i, op: 'Blend' },
  { re: /\b(replace|renew|fit\s+new|new)\b/i, op: 'Replace' },
  { re: /\b(repair|pdr|smart\s*repair|push\s*out|dress)\b/i, op: 'Repair' },
  { re: /\b(check|inspect)\b/i, op: 'Check' },
  { re: /\b(align|alignment|geometry|tracking)\b/i, op: 'Align' },
];

const SKIP_LINE = /\b(sub-?\s*totals?|totals?|vat|grand\s*total|carried\s*forward|brought\s*forward|balance\s*(?:due|outstanding|b\/?f|c\/?f|brought|carried)|amount\s*due|page\s*\d+|labour\s*rate|paint\s*rate)\b/i;
const RATE_RE = /@\s*(£\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|£\s?\d+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?:\s*(?:\/|per)\s*(?:hr|hour))?/i;
const DATE_TOKEN_RE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2}-\d{2,4})$/;
const HEADER_LINE = /^\s*(op(?:eration)?|description|desc|part\s*(?:no|number)|qty|hours|hrs|price|net|line)\b/i;

/**
 * Dates (04/10/2026, 04.10.26, 2026-10-04, 4-10-2026) and clock times (10:30) are removed before any
 * number is read: "Date: 04/10/2026" otherwise yields a £2,026.00 part with quantity 4.
 */
const DATE_OR_TIME_RE = /(?<![\w.])(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{1,2}:\d{2}(?::\d{2})?)(?![\w.])/g;
/** UK registration marks (AB19CDE) and 17-character VINs are identifiers, never part numbers. */
const UK_REG_RE = /^[A-Z]{2}\d{2}[A-Z]{3}$/i;
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
/**
 * Header / identity lines from an estimate PDF (vehicle, registration, claim and policy numbers,
 * dates, contact details). Skipped when the line carries no operation word and no repair-kind
 * keyword; "Replace engine mount" or "Repair vehicle underside" still parse.
 */
const IDENTITY_LINE_RE =
  /\b(reg(?:istration)?(?:\s*(?:no|number|mark))?|vin|chassis(?:\s*no)?|vehicle|make|model|claim(?:\s*(?:no|ref|number))?|policy(?:\s*(?:no|number))?|invoice(?:\s*(?:no|number))?|estimate(?:\s*(?:no|number|date))?|job(?:\s*(?:no|number|card))?|tel(?:ephone)?|phone|mobile|fax|e-?mail|date|postcode|insurer|customer|owner|address|assessor|engineer(?:'s)?(?:\s*fee)?|repairer|bodyshop|mileage|odometer|colour|first\s*reg)\b/i;
/** A discount, credit or "less ..." line reduces the estimate; its figure is carried negative. */
const DISCOUNT_RE = /\b(discount|credit(?:\s*note)?|less|rebate|allowance|deduct(?:ion)?)\b/i;

/** £ prices, with an optional minus before or after the £ sign, or wrapped in brackets ((£50.00) = −£50.00). */
const PRICE_RE = /\(\s*£\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\s*\)|\(\s*£\s?\d+(?:\.\d{1,2})?\s*\)|-?£\s?-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|-?£\s?-?\d+(?:\.\d{1,2})?/g;
const HOURS_RE = /\b(\d+(?:\.\d+)?)\s*(?:hrs?|hours?|h)\b/gi;
const QTY_RE = /\b(?:qty|quantity)\s*[:=]?\s*(\d+)\b|\b(\d+)\s*(?:x|×|off|pcs?|no\.?)\s/gi;
const PART_RE = /\b[A-Z0-9][A-Z0-9-]{4,18}[A-Z0-9]\b/gi;
const BARE_NUMBER_RE = /(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g;

const ADAS_RE = /\b(adas|calibrat\w*|camera|radar|lidar|lane\s*assist|blind\s*spot|parking\s*sensor|sensor)\b/i;
const DIAG_RE = /\b(diagnos\w*|scan|fault\s*codes?|dtc)\b/i;
const MATERIALS_RE = /\b(paint\s*materials?|materials?|consumables?)\b/i;
const SUNDRY_RE = /\b(sundr\w*|environmental|waste\s*disposal|disposal|miscellaneous|misc)\b/i;
const SPECIALIST_RE = /\b(specialist|geometry|wheel\s*alignment|alignment|tracking|windscreen|glass|air\s*con\w*|a\/c|recharge|jig|pull)\b/i;
const PAINT_RE = /\b(refinish|respray|re-?paint|paint|blend|prime|primer|lacquer|colour\s*match)\b/i;

export function canonicalOperation(text: string): CanonicalOperation | undefined {
  for (const { re, op } of OPERATION_PATTERNS) if (re.test(text)) return op;
  return undefined;
}

function isPartNumberToken(token: string): boolean {
  if (token.length < 6 || token.length > 20) return false;
  if (DATE_TOKEN_RE.test(token)) return false;
  if (UK_REG_RE.test(token) || VIN_RE.test(token)) return false;
  const hasDigit = /\d/.test(token);
  const hasLetter = /[A-Za-z]/.test(token);
  if (hasDigit && hasLetter) return true;
  if (hasDigit && !hasLetter) return token.replace(/-/g, '').length >= 7;
  return false;
}

export interface ParsedTokens {
  operation?: CanonicalOperation;
  partNumber?: string;
  pricesPence: number[];
  hours?: number;
  /** True when the hours came from an explicit marker ('1.5 hrs'), false when read from a bare number. */
  hoursExplicit: boolean;
  /** Hourly rate in pence when the line states one with '@' (e.g. "@ £48.00"). */
  ratePence?: number;
  quantity: number;
  remainder: string;
}

/** Pull the recognisable tokens out of one line of text. Exported for tests and for the import UI's preview. */
export function tokeniseLine(raw: string): ParsedTokens {
  let work = raw.replace(/\s+/g, ' ').trim().replace(DATE_OR_TIME_RE, ' ');
  let ratePence: number | undefined;
  work = work.replace(RATE_RE, (_m, r: string) => {
    const p = parseGBP(r.replace(/\s/g, ''));
    if (ratePence === undefined && p !== null && p > 0) {
      ratePence = p;
      return ' ';
    }
    return _m;
  });
  const pricesPence: number[] = [];
  work = work.replace(PRICE_RE, (m) => {
    const compact = m.replace(/\s/g, '');
    const bracketed = compact.startsWith('(') && compact.endsWith(')');
    const body = bracketed ? compact.slice(1, -1) : compact;
    // parseGBP accepts "-£50.00"; normalise "£-50.00" to the same shape.
    const negative = bracketed || body.startsWith('-') || body.startsWith('£-');
    const p = parseGBP(body.replace(/^-?£-?/, '£'));
    if (p !== null) pricesPence.push(negative ? -p : p);
    return ' ';
  });
  let hours: number | undefined;
  let hoursExplicit = false;
  work = work.replace(HOURS_RE, (_m, h: string) => {
    if (hours === undefined) {
      hours = Number(h);
      hoursExplicit = true;
    }
    return ' ';
  });
  let quantity = 1;
  let qtySeen = false;
  work = work.replace(QTY_RE, (_m, a?: string, b?: string) => {
    const q = Number(a ?? b);
    if (!qtySeen && Number.isFinite(q) && q > 0) {
      quantity = q;
      qtySeen = true;
    }
    return ' ';
  });
  const operation = canonicalOperation(work);
  let partNumber: string | undefined;
  work = work.replace(PART_RE, (m) => {
    if (!partNumber && isPartNumberToken(m) && canonicalOperation(m) === undefined) {
      partNumber = m.toUpperCase();
      return ' ';
    }
    return m;
  });
  const bare = work.match(BARE_NUMBER_RE) ?? [];
  for (const tok of bare) {
    const value = Number(tok);
    if (!Number.isFinite(value)) continue;
    const decimals = tok.includes('.') ? tok.split('.')[1]!.length : 0;
    const looksLikeHours = decimals >= 1 && decimals <= 2 && value <= 60;
    // Next to a part number, a 2-dp figure of £20 or more reads as a price (e.g. "8E0857535 45.00").
    const partPrice = partNumber !== undefined && decimals === 2 && value >= 20;
    if (hours === undefined && looksLikeHours && !partPrice) {
      hours = value;
    } else if (decimals === 2 || value >= 20) {
      pricesPence.push(Math.round(value * 100));
    } else if (!qtySeen && Number.isInteger(value) && value > 0 && value <= 50) {
      quantity = value;
      qtySeen = true;
    }
    work = work.replace(new RegExp(`(?<![\\w.])${tok.replace('.', '\\.')}(?![\\w.])`), ' ');
  }
  const remainder = work.replace(/\s+/g, ' ').replace(/^[\s\-–:|@]+|[\s\-–:|@]+$/g, '').trim();
  return { operation, partNumber, pricesPence, hours, hoursExplicit, ratePence, quantity, remainder };
}

/**
 * On a sundry/materials line a bare figure read as "hours" is money; on a diagnostic/specialist
 * line it is money when over 8. An explicit 'hrs' marker is always respected.
 */
function reinterpretBareHoursAsPrice(kind: EstimateLineKind, t: ParsedTokens): ParsedTokens {
  if (t.hours === undefined || t.hoursExplicit || t.pricesPence.length > 0) return t;
  const alwaysMoney = kind === 'sundry' || kind === 'materials';
  const tooManyHours = (kind === 'diagnostic' || kind === 'specialist') && t.hours > 8;
  if (!alwaysMoney && !tooManyHours) return t;
  return { ...t, hours: undefined, pricesPence: [Math.round(t.hours * 100)] };
}

/** True when the line names a repair kind even without an operation word (sundries, materials, ADAS…). */
function hasKindKeyword(text: string): boolean {
  return ADAS_RE.test(text) || DIAG_RE.test(text) || MATERIALS_RE.test(text) || SUNDRY_RE.test(text) || SPECIALIST_RE.test(text) || PAINT_RE.test(text);
}

function classify(text: string, t: ParsedTokens): EstimateLineKind {
  if (t.operation === undefined && DISCOUNT_RE.test(text) && t.pricesPence.length > 0) return 'sundry';
  if (t.operation === 'Calibrate' || ADAS_RE.test(text)) return 'adas';
  if (t.operation === 'Diagnose' || DIAG_RE.test(text)) return 'diagnostic';
  if (MATERIALS_RE.test(text) && !PAINT_RE.test(text.replace(MATERIALS_RE, ''))) return 'materials';
  if (SUNDRY_RE.test(text)) return 'sundry';
  if (t.operation === 'Refinish' || t.operation === 'Blend' || PAINT_RE.test(text)) return 'paint';
  if (SPECIALIST_RE.test(text) || t.operation === 'Align') return 'specialist';
  if (t.hours !== undefined && t.partNumber === undefined && t.pricesPence.length === 0) return 'labour';
  if (t.partNumber !== undefined || t.pricesPence.length > 0) return 'part';
  return 'labour';
}

function partSource(text: string): EstimateLine['partSource'] {
  if (/\b(oem|genuine|oe)\b/i.test(text)) return 'oem';
  if (/\b(aftermarket|non-?oem|pattern|copy)\b/i.test(text)) return 'aftermarket';
  if (/\b(green|recycled|used|reclaimed|second-?hand)\b/i.test(text)) return 'green';
  return 'unknown';
}

function stripOperationWord(remainder: string): string {
  let s = remainder;
  for (const { re } of OPERATION_PATTERNS) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').replace(/^[\s\-–:|,.]+|[\s\-–:|,.]+$/g, '').trim();
}

/** Parse one line of text into zero, one or two estimate lines. */
export function parseEstimateLine(raw: string, lineNo: number, idPrefix = 'import'): EstimateLine[] {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const hasOperation = canonicalOperation(text) !== undefined;
  if (SKIP_LINE.test(text) && !hasOperation) return [];
  if (HEADER_LINE.test(text) && !/\d/.test(text)) return [];
  const kindKeyword = hasKindKeyword(text);
  // Header and identity lines ("Reg AB19CDE", "Date: 04/10/2026", "Vehicle: Golf 2019 1.5 TSI", "Tel …")
  // are not repair lines, however many numbers they carry.
  if (!hasOperation && !kindKeyword && IDENTITY_LINE_RE.test(text)) return [];
  const t0 = tokeniseLine(text);
  if (t0.operation === undefined && t0.partNumber === undefined && t0.pricesPence.length === 0 && t0.hours === undefined && t0.ratePence === undefined) return [];
  if (!hasOperation && !kindKeyword) {
    // Without an operation word or a repair-kind keyword, a line must carry something unambiguous:
    // a £ price, an explicit hours marker, a rate, or a part number next to a figure. A bare
    // "2019 1.5" (a vehicle description) or a lone identifier is not an estimate line.
    const explicitMoney = /£/.test(text) || t0.ratePence !== undefined;
    const partWithFigure = t0.partNumber !== undefined && (t0.pricesPence.length > 0 || t0.hours !== undefined);
    if (!explicitMoney && !t0.hoursExplicit && !partWithFigure) return [];
  }
  const kind = classify(text, t0);
  let t = reinterpretBareHoursAsPrice(kind, t0);
  if (kind === 'sundry' && DISCOUNT_RE.test(text) && t.operation === undefined) {
    // "Less discount £50.00" reduces the estimate even when the sign was not printed.
    t = { ...t, pricesPence: t.pricesPence.map((p) => (p > 0 ? -p : p)) };
  }
  const panel = stripOperationWord(t.remainder) || undefined;
  const base = {
    operation: t.operation ?? 'Other',
    panel,
    description: text,
    source: 'import' as const,
    confirmedByEngineer: false,
  };
  const id = `${idPrefix}-${lineNo}`;
  const price = t.pricesPence[0];

  switch (kind) {
    case 'paint':
      return [{ id, kind, ...base, quantity: 1, hours: t.hours, materialsPence: price }];
    case 'materials':
      return [{ id, kind, ...base, quantity: t.quantity, materialsPence: price }];
    case 'adas':
    case 'diagnostic':
    case 'sundry':
    case 'specialist':
      return [{ id, kind, ...base, quantity: t.quantity, hours: t.hours, unitPence: price }];
    case 'labour':
      return [{ id, kind, ...base, quantity: 1, hours: t.hours, ratePence: t.ratePence, unitPence: t.hours === undefined ? price : undefined }];
    case 'part': {
      const partLine: EstimateLine = {
        id,
        kind: 'part',
        ...base,
        partNumber: t.partNumber,
        partSource: partSource(text),
        quantity: t.quantity,
        unitPence: price,
      };
      if (t.hours !== undefined) {
        const labourLine: EstimateLine = {
          id: `${id}b`,
          kind: 'labour',
          ...base,
          description: `${text} (labour)`,
          quantity: 1,
          hours: t.hours,
          ratePence: t.ratePence,
        };
        return [partLine, labourLine];
      }
      return [partLine];
    }
  }
}

export function parseEstimateText(text: string, options: ParseOptions = {}): EstimateLine[] {
  const prefix = options.idPrefix ?? 'import';
  const out: EstimateLine[] = [];
  const rows = text.split(/\r?\n/);
  rows.forEach((row, i) => {
    out.push(...parseEstimateLine(row, i + 1, prefix));
  });
  return out;
}
